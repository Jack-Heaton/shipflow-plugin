/**
 * @file sf-push.test.mjs
 * @description Tests for sf-push.mjs against real git with a bare origin, a stub pre-push hook
 *   (`core.hooksPath`), a fake `gh` on PATH and a fake `tracker` script — nothing reaches GitHub or
 *   tracker. Covers: a failing hook (`step: push`); a declared command that exits 0 without
 *   pushing (`step: verify`); a declared command that pushes, under the runstate's approved
 *   skips; a body update that exits 0 and leaves the body unchanged (`step: body-verify`); the
 *   create and update paths; `UNKNOWN` then `MERGEABLE`; `CONFLICTING` leaves the status
 *   unwritten; `--push no` runs no push; a tracker failure that leaves exit 0; usage and config
 *   errors. Hook inputs (the stub hook records its environment): `layer --arms skip`;
 *   `checkpoint --arms skip`; `checkpoint` with no `--arms`; `final` (range base set, and
 *   `test_arms` from the transcript); `final` with the remote already at `HEAD`
 *   (`no-ref-pushed`); `final` with no merge-base. Argument checks: an option-like or
 *   refspec-like `--branch`/`--base`/`--remote` and a path-like `--task` exit 2 before git
 *   runs. A runstate skip naming a hook input is ignored. `test_arms` survives a `verify`
 *   error; a final whose arms are not confirmed leaves the comment and status unwritten; an
 *   empty checkpoint transcript is `unconfirmed`, and so is a skipping push whose SF_PUSH_LOG is
 *   empty; hook-input names compare in any letter case; the log directory is removed on a clean exit.
 *   Run: node --test plugins/shipflow/scripts/__tests__/sf-push.test.mjs
 * @domain workflow-push
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SF_PUSH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sf-push.mjs');
const G_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: G_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PR_URL = 'https://github.test/acme/repo/pull/7';
const RANGE_PRINT = '==> pre-push: range base aaaaaaaaaaaa — judging 1 commit(s) up to bbbbbbbbbbbb, not only those after the remote tip';

// State lives in $FAKE_GH_DIR: pr.json is the open PR ({number, url, body}); calls.log records
// every argv; mergeable holds one value per line, consumed a line per read (the last repeats).
// $FAKE_GH_PATCH=noop makes the body update exit 0 without applying it; $FAKE_GH_FAIL=<verb>
// fails that call.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\\n');
const prFile = path.join(dir, 'pr.json');
const pr = fs.existsSync(prFile) ? JSON.parse(fs.readFileSync(prFile, 'utf8')) : null;
const verb = args[0] === 'api' ? (args.includes('PATCH') ? 'patch' : 'get') : args.slice(0, 2).join('-');
if (process.env.FAKE_GH_FAIL === verb) { process.stderr.write('fake gh: ' + verb + ' failed\\n'); process.exit(1); }
const flag = (name) => args[args.indexOf(name) + 1];
if (verb === 'pr-list') {
  process.stdout.write(JSON.stringify(pr ? [{ number: pr.number, url: pr.url }] : []) + '\\n');
} else if (verb === 'pr-create') {
  fs.writeFileSync(prFile, JSON.stringify({ number: 7, url: '${PR_URL}', body: fs.readFileSync(flag('--body-file'), 'utf8'), base: flag('--base'), title: flag('--title'), draft: args.includes('--draft') }));
  process.stdout.write('Creating draft pull request\\n${PR_URL}\\n');
} else if (verb === 'patch') {
  const body = args.find((a) => a.startsWith('body=@'));
  if (process.env.FAKE_GH_PATCH !== 'noop') fs.writeFileSync(prFile, JSON.stringify({ ...pr, body: fs.readFileSync(body.slice(6), 'utf8') }));
} else if (verb === 'get') {
  process.stdout.write(pr.body.replace(/\\n/g, '\\r\\n') + '\\n');
} else if (verb === 'pr-view') {
  const file = path.join(dir, 'mergeable');
  const lines = fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean);
  if (lines.length > 1) fs.writeFileSync(file, lines.slice(1).join('\\n'));
  process.stdout.write(lines[0] + '\\n');
} else {
  process.stderr.write('fake gh: unexpected ' + args.join(' ') + '\\n');
  process.exit(2);
}
`;

// Records its argv (and a comment's body) in $FAKE_TRACKER_LOG; $FAKE_CU_FAIL is a comma list of
// verbs, or of "status:<name>" entries, that exit 1.
const FAKE_TRACKER = `const fs = require('fs');
const args = process.argv.slice(2);
const entry = { args };
const i = args.indexOf('--body-file');
if (i > 0) entry.body = fs.readFileSync(args[i + 1], 'utf8');
fs.appendFileSync(process.env.FAKE_TRACKER_LOG, JSON.stringify(entry) + '\\n');
const fails = (process.env.FAKE_CU_FAIL || '').split(',');
if (fails.includes(args[1]) || fails.includes('status:' + args[3])) { process.stderr.write('tracker: nope\\n'); process.exit(1); }
process.stdout.write('{}\\n');
`;

// Records the ref lines git hands it and its environment, prints $HOOKS/print, exits $HOOKS/exit.
// The fixture's default print is the hook's range-base line, so a final push reads `ran`.
const HOOK = `#!/bin/sh
d="$(dirname "$0")"
cat >> "$d/stdin.log"
env > "$d/env.log"
[ -f "$d/print" ] && cat "$d/print"
[ -f "$d/exit" ] && exit "$(cat "$d/exit")"
exit 0
`;

/** Seed on `development` (carrying `config`), a bare origin, and a clone on `feat/x` one commit ahead. */
function fixture(config) {
  const root = mkdtempSync(join(tmpdir(), 'sf-'));
  const seed = join(root, 'seed');
  execFileSync('git', ['init', '-q', '-b', 'development', seed], { env: G_ENV });
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  if (config) writeFileSync(join(seed, '.shipflow.json'), JSON.stringify(config));
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'base');
  const bare = join(root, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, bare], { env: G_ENV });
  const wt = join(root, 'wt');
  execFileSync('git', ['clone', '-q', '-b', 'development', bare, wt], { env: G_ENV });
  git(wt, 'checkout', '-q', '-b', 'feat/x');
  const hooks = join(root, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-push'), HOOK);
  chmodSync(join(hooks, 'pre-push'), 0o755);
  git(wt, 'config', 'core.hooksPath', hooks);
  writeFileSync(join(hooks, 'print'), `${RANGE_PRINT}\n`);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  const ghDir = join(root, 'gh');
  mkdirSync(ghDir);
  writeFileSync(join(ghDir, 'mergeable'), 'MERGEABLE\n');
  writeFileSync(join(root, 'tracker.cjs'), FAKE_TRACKER);
  writeFileSync(join(root, 'runstate.json'), JSON.stringify({ push_gate_skips: [] }));
  writeFileSync(join(root, 'body.md'), '## Summary\n\nOne line.   \n\nTracks: https://github.test/acme/repo/issues/abc\n');
  const fx = { root, wt, bare, hooks, ghDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  commit(fx, 'b.txt');
  return fx;
}

function commit(fx, file) {
  writeFileSync(join(fx.wt, file), `${file}\n`);
  git(fx.wt, 'add', '.'); git(fx.wt, 'commit', '-q', '-m', file);
  return git(fx.wt, 'rev-parse', 'HEAD');
}

const FINAL = (fx) => ['--title', 'Ship it', '--body-file', join(fx.root, 'body.md'), '--task', 'abc', '--task-status', 'development complete'];

function run(fx, kind, extra = [], env = {}) {
  const res = spawnSync(process.execPath, [SF_PUSH, '--kind', kind, '--cwd', fx.wt, '--branch', 'feat/x', '--base', 'development',
    '--runstate', join(fx.root, 'runstate.json'), ...extra], {
    encoding: 'utf8',
    env: {
      ...G_ENV, PATH: `${join(fx.root, 'bin')}${delimiter}${process.env.PATH}`, FAKE_GH_DIR: fx.ghDir, FAKE_TRACKER_LOG: join(fx.root, 'tracker.log'),
      SF_PUSH_TRACKER: join(fx.root, 'tracker.cjs'), SF_PUSH_MERGEABLE_WAIT_MS: '10',
      // Set here, never inherited: sf-push reads the SF_PUSH_TRACKER seam only under the runner's variable, which
      // plain `node <file>` and `--test-isolation=none` do not set. No runner mode may reach the real tracker.
      NODE_TEST_CONTEXT: 'child-v8', GH_TOKEN: '', SF_TRACKER_REPO: '',
      // sf-push keeps its transcripts under the temp directory; point that at the fixture so cleanup removes them.
      TMPDIR: fx.root, TEMP: fx.root, TMP: fx.root, ...env,
    },
  });
  const lines = res.stdout.split('\n').filter(Boolean);
  return { ...res, lines, json: lines.length ? JSON.parse(lines[lines.length - 1]) : null };
}

const remoteTip = (fx) => git(fx.wt, 'ls-remote', 'origin', 'refs/heads/feat/x').split(/\s+/)[0] || null;
const jsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const ghCalls = (fx) => jsonl(join(fx.ghDir, 'calls.log')).map((a) => a.join(' '));
const trackerCalls = (fx) => jsonl(join(fx.root, 'tracker.log'));
const hookEnv = (fx) => readFileSync(join(fx.hooks, 'env.log'), 'utf8');

test('checkpoint: a built-in push is verified against the remote tip; one JSON line, no PR or tracker call', () => {
  const fx = fixture();
  try {
    const head = git(fx.wt, 'rev-parse', 'HEAD');
    const r = run(fx, 'checkpoint');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.lines.length, 1);
    assert.equal(r.json.verified, true);
    assert.equal(r.json.pushed_sha, head);
    assert.equal(r.json.remote_sha, head);
    assert.equal(remoteTip(fx), head);
    assert.equal(r.json.push.via, 'builtin');
    assert.equal(r.json.push.exit, 0);
    assert.equal(r.json.remote, 'origin');
    assert.ok(readFileSync(r.json.push.log, 'utf8').includes(RANGE_PRINT), 'a clean exit keeps the hook transcript');
    assert.ok(!r.json.push.log.startsWith(fx.wt), 'the transcript sits outside the repository');
    assert.deepEqual(readdirSync(dirname(r.json.push.log)), ['push.log'], 'only the transcript is kept');
    for (const k of ['pr_number', 'pr_url', 'pr_created', 'body_verified', 'mergeable', 'tracker']) assert.equal(r.json[k], null, k);
    assert.deepEqual(ghCalls(fx), []);
    assert.deepEqual(trackerCalls(fx), []);
    assert.equal(run(fx, 'layer').json.verified, true, 'a push with nothing new still verifies');
  } finally { fx.cleanup(); }
});

test('a failing hook: step push, exit 1, nothing on the remote, no later step', () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.hooks, 'exit'), '1');
    const r = run(fx, 'final', FINAL(fx));
    assert.equal(r.status, 1);
    assert.equal(r.json.error.step, 'push');
    assert.equal(r.json.verified, false);
    assert.equal(r.json.push.exit, 1);
    assert.ok(readFileSync(r.json.push.log, 'utf8').length > 0, 'the transcript of a failed push is kept');
    assert.ok(!r.json.push.log.startsWith(fx.wt), 'the transcript sits outside the repository');
    assert.equal(r.json.test_arms, null);
    assert.equal(remoteTip(fx), null);
    assert.deepEqual(ghCalls(fx), []);
    assert.deepEqual(trackerCalls(fx), []);
  } finally { fx.cleanup(); }
});

test('a declared command that exits 0 without pushing: the remote tip differs, step verify', () => {
  const fx = fixture({ push: { verified: [process.execPath, '-e', 'process.exit(0)'] } });
  try {
    const r = run(fx, 'final', FINAL(fx));
    assert.equal(r.status, 1);
    assert.equal(r.json.push.via, 'declared');
    assert.equal(r.json.push.exit, 0);
    assert.equal(r.json.error.step, 'verify');
    assert.equal(r.json.verified, false);
    assert.equal(r.json.remote_sha, null);
    assert.deepEqual(ghCalls(fx), []);
  } finally { fx.cleanup(); }
});

test('a declared command gets <remote> <branch>, SF_PUSH_LOG and the approved skips; the branch copy of the config is ignored', () => {
  const declared = ['bash', '-c', 'echo "declared ran"; git push -u "$0" "$1" >"$SF_PUSH_LOG" 2>&1'];
  const fx = fixture({ push: { verified: declared } });
  try {
    writeFileSync(join(fx.wt, '.shipflow.json'), JSON.stringify({ push: { verified: [process.execPath, '-e', 'process.exit(0)'] } }));
    const head = commit(fx, 'c.txt');
    writeFileSync(join(fx.root, 'runstate.json'), JSON.stringify({ push_gate_skips: [{ name: 'pg', skip_env: 'SF_SKIP_PG' }] }));
    const r = run(fx, 'checkpoint');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.lines.length, 1, 'the command output never reaches stdout');
    assert.equal(r.json.push.via, 'declared');
    assert.equal(r.json.verified, true);
    assert.equal(remoteTip(fx), head);
    assert.match(hookEnv(fx), /^SF_SKIP_PG=1$/m);
    assert.match(hookEnv(fx), /^SF_PUSH_LOG=/m);
  } finally { fx.cleanup(); }
});

test('a declared push reports its hook transcript path, on success and on failure; command output is removed on success', () => {
  const declared = ['bash', '-c', 'echo "declared ran"; git push -u "$0" "$1" >"$SF_PUSH_LOG" 2>&1'];
  const fx = fixture({ push: { verified: declared } });
  try {
    const ok = run(fx, 'checkpoint');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.json.push.via, 'declared');
    assert.equal(basename(ok.json.push.log), 'push.log');
    assert.ok(readFileSync(ok.json.push.log, 'utf8').includes(RANGE_PRINT), 'the kept file is the hook transcript');
    assert.deepEqual(readdirSync(dirname(ok.json.push.log)), ['push.log'], 'command.log is removed after a pass');

    commit(fx, 'c.txt');
    writeFileSync(join(fx.hooks, 'exit'), '1');
    const failed = run(fx, 'checkpoint');
    assert.equal(failed.status, 1);
    assert.equal(failed.json.error.step, 'push');
    assert.equal(basename(failed.json.push.log), 'push.log');
    assert.ok(readFileSync(failed.json.push.log, 'utf8').includes(RANGE_PRINT), 'a failed push reports the hook transcript');
  } finally { fx.cleanup(); }
});

test('a passing declared push keeps push-verified\'s first-attempt transcript, which the flakes log names', () => {
  const declared = ['bash', '-c', 'echo "attempt 1 failed" >"$SF_PUSH_LOG.attempt1"; git push -u "$0" "$1" >"$SF_PUSH_LOG" 2>&1'];
  const fx = fixture({ push: { verified: declared } });
  try {
    const r = run(fx, 'checkpoint');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.verified, true);
    assert.equal(readFileSync(`${r.json.push.log}.attempt1`, 'utf8'), 'attempt 1 failed\n');
    assert.deepEqual(readdirSync(dirname(r.json.push.log)).sort(), ['push.log', 'push.log.attempt1']);
  } finally { fx.cleanup(); }
});

test('final, create path: draft PR against the base, body read back, link-back comment, fields and status', () => {
  const fx = fixture();
  try {
    const r = run(fx, 'final', [...FINAL(fx), '--note', 'Targets release/x.']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.verified, true);
    assert.equal(r.json.pr_created, true);
    assert.equal(r.json.pr_number, 7);
    assert.equal(r.json.pr_url, PR_URL);
    assert.equal(r.json.body_verified, true, 'CRLF and trailing whitespace are not a difference');
    assert.equal(r.json.mergeable, 'MERGEABLE');
    assert.deepEqual(r.json.tracker, { comment: 'ok', pr_field: 'ok', branch_field: 'ok', status: 'development complete' });
    const pr = JSON.parse(readFileSync(join(fx.ghDir, 'pr.json'), 'utf8'));
    assert.equal(pr.draft, true);
    assert.equal(pr.base, 'development');
    assert.equal(pr.title, 'Ship it');
    assert.ok(!ghCalls(fx).some((c) => c.startsWith('pr edit')), 'gh pr edit is never used');
    const calls = trackerCalls(fx);
    assert.deepEqual(calls.map((c) => c.args.slice(0, 3).join(' ')), ['task comment abc', 'task pr abc', 'task branch abc', 'task status abc']);
    assert.ok(calls[0].body.startsWith(`**[ship-task · pr]** ${PR_URL}`));
    assert.ok(calls[0].body.includes('Targets release/x.'));
    assert.equal(calls[1].args[4], PR_URL);
    assert.equal(calls[2].args[4], 'https://github.test/acme/repo/tree/feat/x');
    assert.equal(calls[3].args[3], 'development complete');
  } finally { fx.cleanup(); }
});

test('final, update path: an open PR is found, its body patched through gh api and read back; --skill signs the comment', () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.ghDir, 'pr.json'), JSON.stringify({ number: 7, url: PR_URL, body: 'old' }));
    const r = run(fx, 'final', [...FINAL(fx), '--skill', 'review-task-code']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.pr_created, false);
    assert.equal(r.json.pr_number, 7);
    assert.equal(r.json.body_verified, true);
    const calls = ghCalls(fx);
    assert.ok(calls.some((c) => c.startsWith('api -X PATCH repos/{owner}/{repo}/pulls/7 -F body=@')));
    assert.ok(!calls.some((c) => c.startsWith('pr create') || c.startsWith('pr edit')));
    assert.equal(JSON.parse(readFileSync(join(fx.ghDir, 'pr.json'), 'utf8')).body, readFileSync(join(fx.root, 'body.md'), 'utf8'));
    assert.ok(trackerCalls(fx)[0].body.startsWith('**[review-task-code · pr]**'));
  } finally { fx.cleanup(); }
});

test('a body update that exits 0 and leaves the body unchanged: step body-verify, no tracker write', () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.ghDir, 'pr.json'), JSON.stringify({ number: 7, url: PR_URL, body: 'old' }));
    const r = run(fx, 'final', FINAL(fx), { FAKE_GH_PATCH: 'noop' });
    assert.equal(r.status, 1);
    assert.equal(r.json.error.step, 'body-verify');
    assert.equal(r.json.body_verified, false);
    assert.equal(r.json.verified, true, 'the push itself was verified');
    assert.equal(r.json.mergeable, null);
    assert.deepEqual(trackerCalls(fx), []);
  } finally { fx.cleanup(); }
});

test('each gh failure names its step', () => {
  for (const [fail, step, open] of [['pr-list', 'pr-find', false], ['pr-create', 'pr-create', false], ['patch', 'body-update', true], ['get', 'body-verify', true], ['pr-view', 'mergeable', true]]) {
    const fx = fixture();
    try {
      if (open) writeFileSync(join(fx.ghDir, 'pr.json'), JSON.stringify({ number: 7, url: PR_URL, body: 'old' }));
      const r = run(fx, 'final', FINAL(fx), { FAKE_GH_FAIL: fail });
      assert.equal(r.status, 1, fail);
      assert.equal(r.json.error.step, step);
      assert.deepEqual(trackerCalls(fx), []);
    } finally { fx.cleanup(); }
  }
});

test('mergeable UNKNOWN is read once more: UNKNOWN then MERGEABLE', () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.ghDir, 'mergeable'), 'UNKNOWN\nMERGEABLE\n');
    const r = run(fx, 'final', FINAL(fx));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.mergeable, 'MERGEABLE');
    assert.equal(ghCalls(fx).filter((c) => c.startsWith('pr view')).length, 2);
    writeFileSync(join(fx.ghDir, 'mergeable'), 'UNKNOWN\n');
    const again = run(fx, 'final', FINAL(fx));
    assert.equal(again.json.mergeable, 'UNKNOWN', 'one re-read, then the value is reported as it is');
    assert.equal(again.json.pr_created, false, 're-running finds the PR');
  } finally { fx.cleanup(); }
});

test('CONFLICTING leaves the status unwritten', () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.ghDir, 'mergeable'), 'CONFLICTING\n');
    const r = run(fx, 'final', FINAL(fx));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.mergeable, 'CONFLICTING');
    assert.equal(r.json.tracker.status, 'skipped-conflicting');
    assert.equal(r.json.tracker.comment, 'skipped-conflicting');
    assert.ok(!trackerCalls(fx).some((c) => c.args[1] === 'status' || c.args[1] === 'comment'));
  } finally { fx.cleanup(); }
});

test('--push no runs no push and compares the remote tip with the branch ref, not HEAD', () => {
  const fx = fixture();
  try {
    const none = run(fx, 'final', [...FINAL(fx), '--push', 'no']);
    assert.equal(none.status, 1);
    assert.equal(none.json.error.step, 'verify');
    assert.equal(none.json.push, null);
    assert.equal(remoteTip(fx), null, 'nothing was pushed');

    const tip = git(fx.wt, 'rev-parse', 'HEAD');
    git(fx.wt, 'push', '-q', '--no-verify', 'origin', 'feat/x');
    git(fx.wt, 'checkout', '-q', '-b', 'feat/other');
    commit(fx, 'other.txt');
    const r = run(fx, 'final', [...FINAL(fx), '--push', 'no']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.push, null);
    assert.equal(r.json.pushed_sha, tip);
    assert.equal(r.json.verified, true);
    assert.equal(r.json.pr_created, true);
    assert.ok(!existsSync(join(fx.hooks, 'env.log')), 'the hook never ran');
  } finally { fx.cleanup(); }
});

test('a tracker failure leaves exit 0; a refused status falls back to ready for testing', () => {
  const fx = fixture();
  try {
    const r = run(fx, 'final', FINAL(fx), { FAKE_CU_FAIL: 'comment,pr,branch,status' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.error, undefined);
    assert.deepEqual(r.json.tracker, { comment: 'failed', pr_field: 'failed', branch_field: 'failed', status: 'failed' });
    commit(fx, 'c.txt');
    const fallback = run(fx, 'final', FINAL(fx), { FAKE_CU_FAIL: 'status:development complete' });
    assert.equal(fallback.status, 0);
    assert.deepEqual(fallback.json.tracker, { comment: 'ok', pr_field: 'ok', branch_field: 'ok', status: 'ready for testing' });
  } finally { fx.cleanup(); }
});

test('usage and config errors print no JSON and exit 2', () => {
  const fx = fixture();
  try {
    for (const args of [['final'], ['nope'], ['checkpoint', ['--push', 'no']], ['checkpoint', ['--force', 'yes']], ['final', [...FINAL(fx), '--body-file', join(fx.root, 'absent.md')]]]) {
      const r = run(fx, args[0], args[1] || []);
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.equal(r.stdout, '');
    }
    const badBase = spawnSync(process.execPath, [SF_PUSH, '--kind', 'checkpoint', '--cwd', fx.wt, '--branch', 'feat/x', '--base', 'nope', '--runstate', join(fx.root, 'runstate.json')], { encoding: 'utf8', env: { ...G_ENV, TMPDIR: fx.root } });
    assert.equal(badBase.status, 2);
    assert.equal(badBase.stdout, '');
    assert.equal(remoteTip(fx), null, 'nothing was pushed');
  } finally { fx.cleanup(); }
});

const BANNER = '==> pre-push: run checkpoint — SKIPPING the unit, frontend unit and jsdom arms';
const printFromHook = (fx, text) => writeFileSync(join(fx.hooks, 'print'), `${text}\n`);

test('layer --arms skip and checkpoint --arms skip set the checkpoint input; test_arms is read from the banner', () => {
  for (const kind of ['layer', 'checkpoint']) {
    const fx = fixture();
    try {
      rmSync(join(fx.hooks, 'print'));
      const inert = run(fx, kind, ['--arms', 'skip'], { SF_HOOK_RANGE_BASE: 'inherited' });
      assert.equal(inert.status, 0, inert.stderr);
      assert.match(hookEnv(fx), /^SF_HOOK_RUN_CHECKPOINT=1$/m);
      assert.doesNotMatch(hookEnv(fx), /SF_HOOK_RANGE_BASE/, 'an inherited range base never reaches the hook');
      assert.equal(inert.json.test_arms, 'ran', 'a hook that prints no banner ran every arm');
      assert.equal(inert.json.range_base, null);

      commit(fx, `${kind}.txt`);
      printFromHook(fx, `${BANNER} on aaaaaaaaaaaa..bbbbbbbbbbbb.`);
      const skipped = run(fx, kind, ['--arms', 'skip']);
      assert.equal(skipped.json.verified, true);
      assert.equal(skipped.json.test_arms, 'skipped-checkpoint');
      assert.ok(readFileSync(skipped.json.push.log, 'utf8').includes(BANNER), 'the transcript path is reported for every kind');
    } finally { fx.cleanup(); }
  }
});

test('checkpoint with no --arms sets no hook input, even when the caller\'s environment carries one', () => {
  const fx = fixture();
  try {
    const r = run(fx, 'checkpoint', [], { SF_HOOK_RUN_CHECKPOINT: '1', SF_HOOK_RANGE_BASE: 'inherited' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(hookEnv(fx), /SF_HOOK_RUN_CHECKPOINT|SF_HOOK_RANGE_BASE/);
    assert.equal(r.json.test_arms, 'ran');
    commit(fx, 'd.txt');
    run(fx, 'layer', ['--arms', 'run']);
    assert.doesNotMatch(hookEnv(fx), /SF_HOOK_RUN_CHECKPOINT/);
  } finally { fx.cleanup(); }
});

test('final sets the range base to the merge-base with the base; test_arms is ran only on the hook\'s own line', () => {
  const fx = fixture();
  try {
    const base = git(fx.wt, 'merge-base', 'HEAD', 'origin/development');
    rmSync(join(fx.hooks, 'print'));
    const first = run(fx, 'final', FINAL(fx), { SF_HOOK_RUN_CHECKPOINT: '1' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(hookEnv(fx), new RegExp(`^SF_HOOK_RANGE_BASE=${base}$`, 'm'));
    assert.doesNotMatch(hookEnv(fx), /SF_HOOK_RUN_CHECKPOINT/);
    assert.equal(first.json.range_base, base);
    assert.equal(first.json.test_arms, 'unconfirmed', 'a hook that never names the range base proves nothing');
    assert.equal(first.json.pr_url, PR_URL, 'the PR is still opened');
    assert.deepEqual(first.json.tracker, { comment: 'skipped-arms-unconfirmed', pr_field: 'ok', branch_field: 'ok', status: 'skipped-arms-unconfirmed' });
    assert.deepEqual(trackerCalls(fx).map((c) => c.args[1]), ['pr', 'branch'], 'neither the comment nor the status is written');

    commit(fx, 'e.txt');
    printFromHook(fx, `==> pre-push: range base ${base.slice(0, 12)} — judging 3 commit(s) up to cccccccccccc, not only those after the remote tip`);
    assert.equal(run(fx, 'final', FINAL(fx)).json.test_arms, 'ran');

    commit(fx, 'f.txt');
    printFromHook(fx, '==> pre-push: SF_HOOK_RANGE_BASE ignored for a new branch — the merge-base range already covers it');
    assert.equal(run(fx, 'final', FINAL(fx)).json.test_arms, 'ran');
  } finally { fx.cleanup(); }
});

test('final with the remote already at HEAD: no-ref-pushed', () => {
  const fx = fixture();
  try {
    run(fx, 'checkpoint');
    const refs = readFileSync(join(fx.hooks, 'stdin.log'), 'utf8');
    const r = run(fx, 'final', FINAL(fx));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.verified, true);
    assert.equal(r.json.test_arms, 'no-ref-pushed');
    assert.equal(r.json.tracker.status, 'skipped-arms-unconfirmed');
    assert.equal(r.json.tracker.comment, 'skipped-arms-unconfirmed');
    assert.equal(readFileSync(join(fx.hooks, 'stdin.log'), 'utf8'), refs, 'git handed the hook no ref line');
    const linked = run(fx, 'final', [...FINAL(fx), '--push', 'no', '--skill', 'review-task-code']);
    assert.equal(linked.json.test_arms, null);
    assert.equal(linked.json.tracker.status, 'development complete', '--push no writes the link-back the first call left out');
    assert.ok(trackerCalls(fx).some((c) => c.args[1] === 'comment' && c.body.startsWith('**[review-task-code · pr]**')));
  } finally { fx.cleanup(); }
});

test('final without a merge-base: step push, exit 1, nothing pushed', () => {
  const fx = fixture();
  try {
    git(fx.wt, 'checkout', '-q', '--orphan', 'feat/x-orphan');
    git(fx.wt, 'commit', '-q', '-m', 'orphan');
    git(fx.wt, 'branch', '-q', '-f', 'feat/x');
    git(fx.wt, 'checkout', '-q', 'feat/x');
    const r = run(fx, 'final', FINAL(fx));
    assert.equal(r.status, 1);
    assert.equal(r.json.error.step, 'push');
    assert.equal(r.json.push, null);
    assert.equal(remoteTip(fx), null);
    assert.ok(!existsSync(join(fx.hooks, 'env.log')), 'the push never started');
  } finally { fx.cleanup(); }
});

test('--arms is refused on final and for an unknown value', () => {
  const fx = fixture();
  try {
    assert.equal(run(fx, 'final', [...FINAL(fx), '--arms', 'skip']).status, 2);
    assert.equal(run(fx, 'layer', ['--arms', 'maybe']).status, 2);
    assert.equal(remoteTip(fx), null);
  } finally { fx.cleanup(); }
});

test('an option-like or refspec-like --branch is refused before git runs: exit 2, no JSON, the remote unchanged', () => {
  const fx = fixture();
  try {
    git(fx.wt, 'push', '-q', '--no-verify', 'origin', 'feat/x');
    const pushed = remoteTip(fx);
    const baseTip = git(fx.wt, 'ls-remote', 'origin', 'refs/heads/development').split(/\s+/)[0];
    git(fx.wt, 'commit', '-q', '--amend', '-m', 'rewritten');
    // A passing hook for the values that would move a ref; a refusing one for the value that would skip it.
    for (const [branch, hookExit] of [['+feat/x', '0'], ['--force', '0'], ['feat/x:development', '0'], ['--no-verify', '1']]) {
      writeFileSync(join(fx.hooks, 'exit'), hookExit);
      const r = run(fx, 'checkpoint', ['--branch', branch]);
      assert.equal(remoteTip(fx), pushed, `${branch}: the remote branch is unchanged`);
      assert.equal(git(fx.wt, 'ls-remote', 'origin', 'refs/heads/development').split(/\s+/)[0], baseTip, `${branch}: the base is unchanged`);
      assert.equal(r.status, 2, branch);
      assert.equal(r.stdout, '', branch);
    }
    assert.equal(run(fx, 'checkpoint', ['--base', '--force']).status, 2);
  } finally { fx.cleanup(); }
});

test('an option-like --remote under --push no executes nothing: exit 2, no JSON', () => {
  const fx = fixture();
  try {
    const marker = join(fx.root, 'marker');
    const r = run(fx, 'final', [...FINAL(fx), '--push', 'no', '--remote', `--upload-pack=touch ${marker};`]);
    assert.ok(!existsSync(marker), 'the remote value never reached git');
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.deepEqual(ghCalls(fx), []);
    assert.equal(run(fx, 'final', [...FINAL(fx), '--task', 'abc/../x?y']).status, 2, '--task is an id, never a path');
    assert.equal(remoteTip(fx), null);
  } finally { fx.cleanup(); }
});

test('a runstate skip naming a hook input is ignored with a warning; the script\'s own inputs are applied last', () => {
  const fx = fixture();
  try {
    const skips = [{ name: 'a', skip_env: 'SF_HOOK_RUN_CHECKPOINT' }, { name: 'b', skip_env: 'SF_HOOK_RANGE_BASE' }, { name: 'pg', skip_env: 'SF_SKIP_PG' },
      { name: 'c', skip_env: 'sf_hook_run_checkpoint' }];
    writeFileSync(join(fx.root, 'runstate.json'), JSON.stringify({ push_gate_skips: skips }));
    const base = git(fx.wt, 'merge-base', 'HEAD', 'origin/development');
    const final = run(fx, 'final', FINAL(fx), { Sf_Hook_Range_Base: 'inherited' });
    assert.equal(final.status, 0, final.stderr);
    assert.doesNotMatch(hookEnv(fx), /SF_HOOK_RUN_CHECKPOINT/i, 'a final push is never a checkpoint, in any letter case');
    assert.doesNotMatch(hookEnv(fx), /^Sf_Hook_Range_Base=/m, 'an inherited input is dropped in any letter case');
    assert.match(final.stderr, /sf_hook_run_checkpoint as a skip/);
    assert.match(hookEnv(fx), new RegExp(`^SF_HOOK_RANGE_BASE=${base}$`, 'm'));
    assert.match(hookEnv(fx), /^SF_SKIP_PG=1$/m, 'every other approved skip still applies');
    assert.match(final.stderr, /SF_HOOK_RUN_CHECKPOINT as a skip/);
    assert.match(final.stderr, /SF_HOOK_RANGE_BASE as a skip/);

    commit(fx, 'g.txt');
    const plain = run(fx, 'checkpoint');
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(hookEnv(fx), /SF_HOOK_RUN_CHECKPOINT|SF_HOOK_RANGE_BASE/);
  } finally { fx.cleanup(); }
});

test('test_arms is set once the push command exits 0: a verify error still carries it', () => {
  // Prints the hook's range-base line into the transcript and pushes nothing.
  const declared = [process.execPath, '-e', `require('fs').writeFileSync(process.env.SF_PUSH_LOG, ${JSON.stringify(`${RANGE_PRINT}\n`)})`];
  const fx = fixture({ push: { verified: declared } });
  try {
    const r = run(fx, 'final', FINAL(fx));
    assert.equal(r.status, 1);
    assert.equal(r.json.error.step, 'verify');
    assert.equal(r.json.verified, false);
    assert.equal(r.json.test_arms, 'ran');
    assert.ok(existsSync(r.json.push.log), 'the transcript of a failed call is kept');
    assert.deepEqual(trackerCalls(fx), []);
  } finally { fx.cleanup(); }
});

test('CONFLICTING with unconfirmed arms reports skipped-conflicting', () => {
  const fx = fixture();
  try {
    rmSync(join(fx.hooks, 'print'));
    writeFileSync(join(fx.ghDir, 'mergeable'), 'CONFLICTING\n');
    const r = run(fx, 'final', FINAL(fx));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.test_arms, 'unconfirmed');
    assert.deepEqual(r.json.tracker, { comment: 'skipped-conflicting', pr_field: 'ok', branch_field: 'ok', status: 'skipped-conflicting' });
  } finally { fx.cleanup(); }
});

test('a checkpoint or layer push whose transcript is empty is unconfirmed, not ran', () => {
  // The second command prints its own line, so `command.log` is not empty while SF_PUSH_LOG is.
  for (const script of ['git push -q -u "$0" "$1" >/dev/null 2>&1', 'echo "declared ran"; git push -q -u "$0" "$1" >/dev/null 2>&1']) {
    const fx = fixture({ push: { verified: ['bash', '-c', script] } });
    try {
      printFromHook(fx, `${BANNER} on aaaaaaaaaaaa..bbbbbbbbbbbb.`);
      const r = run(fx, 'layer', ['--arms', 'skip']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.verified, true);
      assert.equal(r.json.test_arms, 'unconfirmed', 'the hook skipped the arms and its transcript was not read');
    } finally { fx.cleanup(); }
  }
});

test('SF_PUSH_TRACKER is read only under the test runner', () => {
  const fx = fixture();
  try {
    // No token and no .env in the fixture: the real tracker script fails before any write.
    const r = run(fx, 'final', FINAL(fx), { NODE_TEST_CONTEXT: undefined, GH_TOKEN: '', SF_TRACKER_REPO: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(trackerCalls(fx), [], 'the caller-named script never ran');
    assert.equal(r.json.tracker.comment, 'failed');
  } finally { fx.cleanup(); }
});
