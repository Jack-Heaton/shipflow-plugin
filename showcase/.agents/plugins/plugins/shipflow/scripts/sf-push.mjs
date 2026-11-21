#!/usr/bin/env node
/**
 * @file sf-push.mjs
 * @description The push and pull-request mechanics of a shipflow run as one command (ship-task
 *   3g, the 2.7 layer push, checkpoint pushes). Pushes through the repo's declared verified push
 *   command (`.shipflow.json` `push.verified`, skills/shared/repo-config.md) or `git push -u`,
 *   and reports a push as verified only after the remote branch tip equals the local commit.
 *   `--kind final` then finds or creates the draft PR, updates its body and reads it back,
 *   reads `mergeable`, and writes the tracker link-back through `tracker.mjs`. Prints one JSON line.
 *   The orchestrator still writes the body and decides `gh pr ready`. Never writes to the
 *   ledger — the caller logs. Zero dependencies.
 * @domain workflow-push
 *
 * Usage:
 *   sf-push --kind checkpoint|layer --cwd <dir> --branch <b> --base <b> --runstate <json>
 *     [--remote origin] [--arms run|skip]
 *   sf-push --kind final --cwd <dir> --branch <b> --base <b> --runstate <json> --title <t>
 *     --body-file <f> --task <id> --task-status "<status>" [--remote origin] [--push no]
 *     [--skill ship-task] [--note <text>]
 *
 * Push: the environment is the caller's plus the runstate's approved skips (`pushEnv`). The
 *   command is the `push.verified` argv committed at <remote>/<base> — never the branch's copy —
 *   with `<remote> <branch>` appended and SF_PUSH_LOG naming the transcript file; undeclared →
 *   `git push -u -- <remote> refs/heads/<branch>:refs/heads/<branch>`. Never `--force`, never
 *   `--no-verify`, no deadline of its own. `--branch`, `--base` and `--remote` are checked as
 *   plain names before any git call (exit 2): a value git could read as an option, a `+`
 *   refspec or a `src:dst` pair never reaches it. Logs sit in a directory under the temp
 *   directory, never in the repository. On exit 0 the hook transcript files (`push.log*`,
 *   including push-verified's `push.log.attempt1`, which its flakes log names) are kept and
 *   the rest is removed; a failure, or a checkpoint whose hook skipped the arms (the caller
 *   reads the skipped range from that transcript), keeps everything.
 * Hook inputs: the reference pre-push hook reads two run inputs, and this script is their only
 *   caller. `--kind checkpoint|layer --arms skip` sets SF_HOOK_RUN_CHECKPOINT=1 (the hook skips
 *   its unit, frontend unit and jsdom arms and prints a banner); the default `--arms run` sets
 *   nothing. `--kind final` sets SF_HOOK_RANGE_BASE=$(git merge-base HEAD <remote>/<base>), so
 *   the hook judges the run's whole range once — the merge-base never sits after the remote
 *   tip; no merge-base → `error.step: push`, nothing pushed. `--push no` sets neither, and a
 *   value inherited from the caller is dropped, and so is a runstate skip that names either
 *   input (with a warning); both compare the name upper-cased. The declared command must pass its environment to `git push`.
 * test_arms: read from the push transcript, never assumed from the input sent — an installed
 *   hook that predates the inputs runs every arm. `skipped-checkpoint`: the transcript carries
 *   the hook's checkpoint banner. `no-ref-pushed`: the remote tip already equalled `HEAD`, so
 *   git handed the hook no ref line and no arm ran. `--kind final` otherwise needs the hook's
 *   range-base line (or its new-branch note) to report `ran`; without one it is `unconfirmed`.
 *   Other kinds report `ran` by the banner's absence, and `unconfirmed` when the transcript is
 *   empty (nothing was read, so nothing is known) — after `--arms skip`, when the SF_PUSH_LOG
 *   file is empty, whatever the declared command printed itself. Set as soon as the push command exits 0, so
 *   a result that fails at `verify` or later still carries it. null under `--push no` and after
 *   a failed push. `range_base` is the sha sent, else null.
 * Verify: `git ls-remote <remote> refs/heads/<branch>` must equal the `HEAD` recorded before
 *   the push, whatever the command's exit status said. `--push no` (stack mode, after
 *   `gh stack submit`) runs no push and compares the remote tip with the local branch ref.
 * Result: {kind, branch, base, remote, pushed_sha, remote_sha, verified, push:{via, exit, log,
 *   duration_ms}, test_arms, range_base, pr_number, pr_url, pr_created, body_verified,
 *   mergeable, tracker:{comment, pr_field, branch_field, status}, error?}. `via` is `declared`
 *   or `builtin`; `push.log` is the hook transcript path whenever one was written (after a
 *   failed declared push with none, the command's own log); `push` is null under `--push no`;
 *   the PR and tracker fields are null for
 *   `checkpoint` and `layer`.
 * Errors: a failed step prints the JSON with `error: {step, message}` and exits 1, and no later
 *   step runs. `step` is push (the command exited non-zero) | verify (the remote tip is not the
 *   recorded commit) | pr-find | pr-create | body-update | body-verify | mergeable. A usage or
 *   config error prints no JSON and exits 2. Re-running is safe: a push with nothing new still
 *   verifies, and find-or-create finds.
 * PR body: `gh api -X PATCH repos/{owner}/{repo}/pulls/<n> -F body=@<file>`, then the body is
 *   read back and compared (line endings and trailing whitespace normalized). `gh pr edit` is
 *   not used: it can exit without applying the edit.
 * mergeable: read once more about 10 s after `UNKNOWN` (GitHub computes it lazily).
 * Tracker: fail-soft, exit stays 0. Each of comment | pr_field | branch_field is `ok` or
 *   `failed`; `status` is the status written, `ready for testing` when the requested one could
 *   not be set, or `failed`. `CONFLICTING` writes neither the comment nor the status
 *   (`skipped-conflicting`): the caller merges the base and calls again. A `test_arms` that is
 *   neither `ran` nor null writes neither as well (`skipped-arms-unconfirmed`): the caller
 *   decides whether the arms are owed before the task is marked; `skipped-conflicting` wins
 *   when both hold.
 * Test seams: SF_PUSH_TRACKER (path of the tracker script; read only under the node test runner),
 *   SF_PUSH_MERGEABLE_WAIT_MS.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepoConfigAt } from './sf-config.mjs';
import { pushEnv } from './sf-gates.mjs';

const KINDS = ['final', 'layer', 'checkpoint'];
const FLAGS = ['kind', 'cwd', 'branch', 'base', 'runstate', 'remote', 'push', 'arms', 'title', 'body-file', 'task', 'task-status', 'skill', 'note'];
const FALLBACK_STATUS = 'ready for testing';

// The pre-push hook's run inputs and the lines it prints when it honours them. The hook's own
// repository pins these strings against this file.
const CHECKPOINT_INPUT = 'SF_HOOK_RUN_CHECKPOINT';
const RANGE_INPUT = 'SF_HOOK_RANGE_BASE';
const HOOK_INPUTS = [CHECKPOINT_INPUT, RANGE_INPUT];
const CHECKPOINT_BANNER = '==> pre-push: run checkpoint — SKIPPING the unit, frontend unit and jsdom arms';
const RANGE_LINE = /^==> pre-push: range base /m;
const RANGE_NEW_BRANCH = `${RANGE_INPUT} ignored for a new branch`;

// Stricter than git's own rules on purpose: `git check-ref-format --branch` accepts `+name`,
// which `git push` reads as a forced refspec.
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASK_ID = /^[A-Za-z0-9_-]+$/;

const HELP = `sf-push — a run's push and pull-request mechanics (ship-task 3g, layer and checkpoint pushes)

  sf-push --kind checkpoint|layer --cwd <dir> --branch <b> --base <b> --runstate <json> [--remote origin]
      [--arms run|skip]
      Push <branch> through the base's push.verified command (else git push -u) under the
      runstate's approved skips, then require the remote tip to equal the recorded HEAD.
      --arms skip marks the push a run checkpoint for the pre-push hook (${CHECKPOINT_INPUT}=1);
      only for a run whose last push is --kind final with a push.
  sf-push --kind final --cwd <dir> --branch <b> --base <b> --runstate <json> --title <t>
      --body-file <f> --task <id> --task-status "<status>" [--remote origin] [--push no]
      [--skill ship-task] [--note <text>]
      Push and verify, find or create the draft PR, update its body and read it back, read
      mergeable (once more after UNKNOWN), then the tracker comment, fields and status.
      The push carries ${RANGE_INPUT}=<merge-base of HEAD and <remote>/<base>>.
      --push no (stack mode) runs no push and still requires the remote tip to equal the branch.
  One stdout line: {kind, branch, base, remote, pushed_sha, remote_sha, verified, push:{via, exit,
  log, duration_ms}, test_arms, range_base, pr_number, pr_url, pr_created, body_verified, mergeable,
  tracker:{comment, pr_field, branch_field, status}, error?:{step, message}}.
  test_arms: ran | skipped-checkpoint | no-ref-pushed | unconfirmed | null, read from the transcript.
  tracker.comment and tracker.status: skipped-conflicting on CONFLICTING, else
  skipped-arms-unconfirmed when test_arms is neither ran nor null.
  Exit 0 done; 1 a step failed (JSON printed, error.step names it); 2 usage or config error (no JSON).
`;

class UsageError extends Error {}

/** A failed step: its name lands in the result's `error.step`. */
class StepError extends Error {
  constructor(step, message) { super(message); this.step = step; }
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help') { flags.help = true; continue; }
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (!FLAGS.includes(key)) throw new UsageError(`unknown flag --${key}`);
    if (argv[i + 1] === undefined) throw new UsageError(`--${key} needs a value`);
    flags[key] = argv[i + 1];
    i += 1;
  }
  return flags;
}

const warn = (msg) => process.stderr.write(`sf-push: warning: ${msg}\n`);
const errText = (e) => ((e.stderr || '').toString().trim() || e.message).split('\n').slice(-5).join('\n');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function remoteTip(cwd, remote, branch) {
  return git(cwd, ['ls-remote', '--', remote, `refs/heads/${branch}`]).split(/\s+/)[0] || null;
}

// A push outlives a foreground tool call, so the child is awaited, never run synchronously:
// a signal to this process must still reach it.
function runToLog(argv, { cwd, env, logPath }) {
  return new Promise((done) => {
    const fd = openSync(logPath, 'a');
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', fd, fd] });
    const forward = (sig) => { try { child.kill(sig); } catch { /* already gone */ } };
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
    const handlers = signals.map((s) => { const h = () => forward(s); process.on(s, h); return h; });
    const finish = (exit, signal) => {
      signals.forEach((s, i) => process.off(s, handlers[i]));
      closeSync(fd);
      done({ exit, signal });
    };
    child.on('error', (e) => { try { writeFileSync(fd, `sf-push: cannot run ${argv[0]}: ${e.message}\n`); } catch { /* log gone */ } finish(127, null); });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

async function push(ctx) {
  const { top, remote, branch, logDir } = ctx;
  const declared = ctx.config.push?.verified;
  const log = join(logDir, 'push.log');
  const env = { ...process.env, SF_PUSH_LOG: log };
  for (const line of pushEnv({ runstate: ctx.runstate })) {
    const name = line.slice(0, line.indexOf('='));
    if (HOOK_INPUTS.includes(name.toUpperCase())) warn(`the runstate names ${name} as a skip; a hook input is set only by this command, so it is ignored`);
    else env[name] = '1';
  }
  // Applied last: the runstate is a file committed on the branch and never decides the hook inputs.
  // Upper-cased: Windows reads environment names case-insensitively.
  for (const name of Object.keys(env)) if (HOOK_INPUTS.includes(name.toUpperCase())) delete env[name];
  if (ctx.skipArms) env[CHECKPOINT_INPUT] = '1';
  if (ctx.rangeBase) env[RANGE_INPUT] = ctx.rangeBase;
  const started = Date.now();
  // A declared command writes the hook transcript to SF_PUSH_LOG itself; its own output goes
  // beside it, so neither can reach this script's one-line stdout.
  const r = declared
    ? await runToLog([...declared, remote, branch], { cwd: top, env, logPath: join(logDir, 'command.log') })
    : await runToLog(['git', 'push', '-u', '--', remote, `refs/heads/${branch}:refs/heads/${branch}`], { cwd: top, env, logPath: log });
  return {
    via: declared ? 'declared' : 'builtin',
    exit: r.exit,
    log: existsSync(log) ? log : join(logDir, 'command.log'),
    duration_ms: Date.now() - started,
    signal: r.signal,
  };
}

function testArms(ctx, remoteBefore, pushedSha) {
  const read = (f) => (existsSync(join(ctx.logDir, f)) ? readFileSync(join(ctx.logDir, f), 'utf8') : '');
  const hookLog = read('push.log');
  const transcript = [hookLog, read('command.log')].join('\n');
  if (transcript.includes(CHECKPOINT_BANNER)) return 'skipped-checkpoint';
  if (remoteBefore === pushedSha) return 'no-ref-pushed';
  // An empty transcript was not read from the hook, so the banner's absence proves nothing; a
  // push that asked to skip needs the hook's own log, not a line the declared command printed.
  if (!ctx.final) return (ctx.skipArms ? hookLog : transcript).trim() ? 'ran' : 'unconfirmed';
  return RANGE_LINE.test(transcript) || transcript.includes(RANGE_NEW_BRANCH) ? 'ran' : 'unconfirmed';
}

function gh(ctx, args) {
  return execFileSync('gh', args, { cwd: ctx.top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const normalizeBody = (s) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trimEnd();

async function pullRequest(ctx, result) {
  const { branch, base, flags } = ctx;
  const bodyFile = resolve(flags['body-file']);
  let found;
  try {
    found = JSON.parse(gh(ctx, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url']) || '[]')[0];
  } catch (e) { throw new StepError('pr-find', errText(e)); }

  if (found) {
    result.pr_number = found.number; result.pr_url = found.url; result.pr_created = false;
    try { gh(ctx, ['api', '-X', 'PATCH', `repos/{owner}/{repo}/pulls/${found.number}`, '-F', `body=@${bodyFile}`, '--silent']); } catch (e) {
      throw new StepError('body-update', errText(e));
    }
  } else {
    let url;
    try {
      url = gh(ctx, ['pr', 'create', '--draft', '--base', base, '--head', branch, '--title', flags.title, '--body-file', bodyFile]).split('\n').pop().trim();
    } catch (e) { throw new StepError('pr-create', errText(e)); }
    const number = Number(url.slice(url.lastIndexOf('/') + 1));
    if (!Number.isInteger(number) || number <= 0) throw new StepError('pr-create', `gh pr create printed no PR URL: ${url}`);
    result.pr_number = number; result.pr_url = url; result.pr_created = true;
  }

  let body;
  try { body = gh(ctx, ['api', `repos/{owner}/{repo}/pulls/${result.pr_number}`, '--jq', '.body']); } catch (e) {
    throw new StepError('body-verify', errText(e));
  }
  result.body_verified = normalizeBody(body) === normalizeBody(readFileSync(bodyFile, 'utf8'));
  if (!result.body_verified) throw new StepError('body-verify', `the body of PR ${result.pr_number} read back differs from ${bodyFile}`);

  const waitMs = Number(process.env.SF_PUSH_MERGEABLE_WAIT_MS ?? 10_000);
  try {
    const read = () => gh(ctx, ['pr', 'view', String(result.pr_number), '--json', 'mergeable', '--jq', '.mergeable']);
    result.mergeable = read();
    if (result.mergeable === 'UNKNOWN') { await sleep(waitMs); result.mergeable = read(); }
  } catch (e) { throw new StepError('mergeable', errText(e)); }
}

function trackerCall(ctx, args) {
  // The seam runs a caller-named file with the tracker token in scope, so only the test runner may set it.
  const script = (process.env.NODE_TEST_CONTEXT && process.env.SF_PUSH_TRACKER) || join(dirname(fileURLToPath(import.meta.url)), 'tracker.mjs');
  const r = spawnSync(process.execPath, [script, ...args], { cwd: ctx.top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status === 0) return true;
  warn(`tracker ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').pop()}`);
  return false;
}

// A tracker gap never halts a finished run: every failure here is recorded, none is thrown.
function linkBack(ctx, result) {
  const { flags, branch, logDir } = ctx;
  const task = flags.task;
  // The status would mark the task before the caller knows whether the hook's test arms are owed.
  const armsUnconfirmed = result.test_arms !== null && result.test_arms !== 'ran';
  const skipped = result.mergeable === 'CONFLICTING' ? 'skipped-conflicting' : armsUnconfirmed ? 'skipped-arms-unconfirmed' : null;
  const tracker = { comment: skipped, pr_field: null, branch_field: null, status: skipped };
  result.tracker = tracker;
  if (!skipped) {
    const commentFile = join(logDir, 'link-back.md');
    writeFileSync(commentFile, `**[${flags.skill || 'ship-task'} · pr]** ${result.pr_url}${flags.note ? `\n\n${flags.note}` : ''}\n`);
    tracker.comment = trackerCall(ctx, ['task', 'comment', task, '--body-file', commentFile]) ? 'ok' : 'failed';
  }
  const repoUrl = result.pr_url.replace(/\/pull\/\d+$/, '');
  tracker.pr_field = trackerCall(ctx, ['task', 'pr', task, '--url', result.pr_url]) ? 'ok' : 'failed';
  tracker.branch_field = trackerCall(ctx, ['task', 'branch', task, '--url', `${repoUrl}/tree/${branch}`]) ? 'ok' : 'failed';
  if (skipped) return;
  const wanted = flags['task-status'];
  if (trackerCall(ctx, ['task', 'status', task, wanted])) tracker.status = wanted;
  else if (wanted !== FALLBACK_STATUS && trackerCall(ctx, ['task', 'status', task, FALLBACK_STATUS])) tracker.status = FALLBACK_STATUS;
  else tracker.status = 'failed';
}

function context(flags) {
  if (!KINDS.includes(flags.kind)) throw new UsageError(`--kind must be one of ${KINDS.join(' | ')}`);
  for (const k of ['cwd', 'branch', 'base', 'runstate']) if (!flags[k]) throw new UsageError(`--${k} is required`);
  if (flags.push !== undefined && flags.push !== 'no') throw new UsageError('--push takes only "no"');
  const final = flags.kind === 'final';
  if (flags.push === 'no' && !final) throw new UsageError('--push no applies to --kind final only');
  if (flags.arms !== undefined && !['run', 'skip'].includes(flags.arms)) throw new UsageError('--arms must be run or skip');
  if (flags.arms !== undefined && final) throw new UsageError('--arms applies to --kind checkpoint|layer only');
  if (final) {
    for (const k of ['title', 'body-file', 'task', 'task-status']) if (!flags[k]) throw new UsageError(`--kind final requires --${k}`);
    if (!existsSync(flags['body-file'])) throw new UsageError(`--body-file ${flags['body-file']} does not exist`);
    if (!TASK_ID.test(flags.task)) throw new UsageError('--task must be a task id (letters, digits, "_" and "-")');
  }
  // Every check below runs before the first git call that receives the value.
  const remote = flags.remote || 'origin';
  if (!REMOTE_NAME.test(remote)) throw new UsageError('--remote must be a plain remote name (letters, digits, ".", "_", "-"; starting with a letter or digit)');
  for (const k of ['branch', 'base']) {
    if (!REF_NAME.test(flags[k])) throw new UsageError(`--${k} must be a plain branch name (no leading "-" or "+", no ":")`);
    try { execFileSync('git', ['check-ref-format', '--branch', flags[k]], { stdio: 'ignore' }); } catch { throw new UsageError(`--${k} ${flags[k]} is not a valid branch name`); }
  }
  const top = git(resolve(flags.cwd), ['rev-parse', '--show-toplevel']);
  const doPush = flags.push !== 'no';
  // Only the push reads the config, and under --push no <base> may be a stack layer's branch.
  const config = doPush ? loadRepoConfigAt(top, `${remote}/${flags.base}`).config : {};
  return { flags, top, remote, branch: flags.branch, base: flags.base, runstate: flags.runstate, config, final, doPush, skipArms: flags.arms === 'skip' };
}

export async function pkPush(flags) {
  const ctx = context(flags);
  const { top, remote, branch, base, final, doPush } = ctx;
  ctx.logDir = mkdtempSync(join(tmpdir(), 'sf-push-'));
  const result = {
    kind: flags.kind, branch, base, remote, pushed_sha: null, remote_sha: null, verified: false, push: null,
    test_arms: null, range_base: null, pr_number: null, pr_url: null, pr_created: null,
    body_verified: null, mergeable: null, tracker: null,
  };
  try {
    // Under --push no the named branch need not be checked out (a stack layer), so its own ref
    // is the commit the remote must carry.
    try { result.pushed_sha = git(top, ['rev-parse', '--verify', doPush ? 'HEAD' : `refs/heads/${branch}`]); } catch (e) {
      throw new StepError(doPush ? 'push' : 'verify', errText(e));
    }
    let remoteBefore = null;
    if (doPush) {
      try { remoteBefore = remoteTip(top, remote, branch); } catch (e) { throw new StepError('push', errText(e)); }
      if (final) {
        try { ctx.rangeBase = git(top, ['merge-base', 'HEAD', `${remote}/${base}`]); } catch { ctx.rangeBase = ''; }
        if (!ctx.rangeBase) throw new StepError('push', `HEAD and ${remote}/${base} have no merge-base; nothing was pushed`);
        result.range_base = ctx.rangeBase;
      }
      const { signal, ...pushed } = await push(ctx);
      result.push = pushed;
      if (pushed.exit !== 0) throw new StepError('push', `the push command ${signal ? `was ended by ${signal}` : `exited ${pushed.exit}`}; transcript: ${pushed.log}`);
      // Before the verify: a result that errors from here on still says what the hook did.
      result.test_arms = testArms(ctx, remoteBefore, result.pushed_sha);
    }
    try { result.remote_sha = remoteTip(top, remote, branch); } catch (e) { throw new StepError('verify', errText(e)); }
    result.verified = result.remote_sha === result.pushed_sha;
    if (!result.verified) throw new StepError('verify', `${remote}/${branch} is ${result.remote_sha ?? 'absent'}, not ${result.pushed_sha}`);
    if (final) {
      await pullRequest(ctx, result);
      linkBack(ctx, result);
    }
  } catch (e) {
    if (!(e instanceof StepError)) throw e;
    result.error = { step: e.step, message: e.message };
  }
  // The checkpoint report names the range the hook's banner prints, so that transcript stays.
  const keepLogs = result.error || (flags.kind === 'checkpoint' && result.test_arms === 'skipped-checkpoint');
  if (!keepLogs) {
    // The hook transcript outlives a passing push: it is the only per-arm record of a slow one.
    let kept = false;
    for (const name of readdirSync(ctx.logDir)) {
      if (name.startsWith('push.log')) kept = true;
      else rmSync(join(ctx.logDir, name), { recursive: true, force: true });
    }
    if (!kept) rmSync(ctx.logDir, { recursive: true, force: true });
    if (result.push) result.push.log = existsSync(join(ctx.logDir, 'push.log')) ? join(ctx.logDir, 'push.log') : null;
  }
  return { result, code: result.error ? 1 : 0 };
}

async function main(argv) {
  try {
    const flags = parseArgs(argv);
    if (flags.help || argv.length === 0) { process.stdout.write(HELP); return 0; }
    const r = await pkPush(flags);
    process.stdout.write(`${JSON.stringify(r.result)}\n`);
    return r.code;
  } catch (e) {
    process.stderr.write(`sf-push: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
