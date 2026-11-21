/**
 * @file sf-codex.test.mjs
 * @description Unit tests for sf-codex.mjs against a fake `codex` binary on PATH: prompt assembly
 *   per template, JSON-schema validation + retry, verdict enforcement, closure rendering with
 *   missing ids, plan verdict rules, exit codes (2 failed / 3 not-continuable), and panel roster
 *   partitioning with pins. Run: node --test plugins/shipflow/scripts/__tests__/
 * @domain workflow-review-backend
 */

import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SF_CODEX = resolve(HERE, '..', 'sf-codex.mjs');

/** A git repo with one commit range to diff, plus a fake `codex` that replays a scripted reply. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sf-codex-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.'); git('commit', '-qm', 'one');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
  git('add', '.'); git('commit', '-qm', 'two');
  mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'plans', 'task-x.plan.md'), '# Plan\n');
  writeFileSync(join(repo, 'docs', 'plans', 'task-x.requirements.md'), '# Req\n');

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'codex');
  // The fake reads $FAKE_CODEX_REPLY (a file with one JSON reply per line; each call consumes
  // the next), writes it to -o, emits thread.started/turn.completed events, and honours
  // $FAKE_CODEX_EXIT / $FAKE_CODEX_ERROR for failure cases. Records its argv for assertions.
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CODEX_ARGV, JSON.stringify(args) + '\\n');
if (args[0] === 'sandbox') {
  // bwrap fails unless the landlock flag is present (or FAKE_SANDBOX_OK forces success)
  const landlock = args.includes('use_legacy_landlock');
  if (process.env.FAKE_SANDBOX_OK || (landlock && !process.env.FAKE_SANDBOX_ALL_FAIL)) process.exit(0);
  process.stdout.write('bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.\\n');
  process.exit(0);
}
if (args[0] === 'app-server') {
  // Hand the stdio JSON-RPC session to the fake app-server (spawn, not require: keeps the CJS fake
  // independent of require-of-ESM support and gives it the inherited stdin/stdout pipes).
  const r = require('child_process').spawnSync(process.execPath, [process.env.FAKE_APP_SERVER], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}
const cIdx = args.indexOf('-C');
const workDir = cIdx !== -1 ? args[cIdx + 1] : process.cwd();
if (process.env.FAKE_CODEX_CWD) fs.appendFileSync(process.env.FAKE_CODEX_CWD, workDir + '\\n');
if (process.env.FAKE_CODEX_TOUCH) fs.writeFileSync(require('path').join(workDir, process.env.FAKE_CODEX_TOUCH), 'x');
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(process.env.FAKE_CODEX_PROMPTS, '=====\\n' + stdin + '\\n');
const exitCode = Number(process.env.FAKE_CODEX_EXIT || 0);
const tid = args[1] === 'resume' ? args[2] : 'thread-' + Math.random().toString(16).slice(2, 8);
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: tid }) + '\\n');
if (process.env.FAKE_CODEX_ERROR) {
  process.stdout.write(JSON.stringify({ type: 'error', message: process.env.FAKE_CODEX_ERROR }) + '\\n');
  process.exit(exitCode || 1);
}
const replies = fs.readFileSync(process.env.FAKE_CODEX_REPLY, 'utf8').split('\\n').filter(Boolean);
const idx = Number(fs.existsSync(process.env.FAKE_CODEX_REPLY + '.idx') ? fs.readFileSync(process.env.FAKE_CODEX_REPLY + '.idx', 'utf8') : 0);
fs.writeFileSync(process.env.FAKE_CODEX_REPLY + '.idx', String(idx + 1));
const reply = replies[Math.min(idx, replies.length - 1)];
if (!process.env.FAKE_CODEX_NO_CMD) {
  const code = Number(process.env.FAKE_CODEX_CMD_EXIT || 0);
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: '/bin/bash -lc "git diff"', exit_code: code, status: code ? 'failed' : 'completed', aggregated_output: code ? 'bwrap: No permissions to create a new namespace' : 'diff --git a/a.ts' } }) + '\\n');
}
const o = args.indexOf('-o');
if (o !== -1) fs.writeFileSync(args[o + 1], reply);
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 5 } }) + '\\n');
process.exit(exitCode);
`);
  chmodSync(fake, 0o755);
  const art = join(root, 'art');
  mkdirSync(art);
  const seats = join(root, 'seats');
  mkdirSync(seats);
  writeFileSync(join(seats, 'frontend-reviewer.md'), '---\nname: frontend-reviewer\nmodel: opus\n---\nYou are the Next.js reviewer. ROLE-BODY-MARKER\n');
  return { root, repo, bin, art, seats };
}

const FAKE_APP_SERVER = resolve(HERE, 'fake-app-server.cjs');

function run(fx, args, { reply = [], env = {}, exit, error } = {}) {
  const replyFile = join(fx.root, `reply-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(replyFile, reply.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
  const argvFile = join(fx.root, 'argv.log');
  const promptsFile = join(fx.root, 'prompts.log');
  const rpcFile = join(fx.root, `rpc-${Math.random().toString(16).slice(2)}.log`);
  writeFileSync(argvFile, ''); writeFileSync(promptsFile, ''); writeFileSync(rpcFile, '');
  const res = spawnSync(process.execPath, [SF_CODEX, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fx.bin}:${process.env.PATH}`,
      SF_SEAT_DIRS: fx.seats,
      SF_CODEX_HOME: join(fx.root, 'home'),
      SF_CODEX_RATE_LIMIT_WAIT_SEC: '0',
      FAKE_CODEX_REPLY: replyFile,
      FAKE_CODEX_ARGV: argvFile,
      FAKE_CODEX_PROMPTS: promptsFile,
      FAKE_APP_SERVER,
      FAKE_AS_LOG: rpcFile,
      // Hermetic ledger: the caller's shell may export a live RUN_LOG (a ship-* orchestrator
      // running this suite as a gate); only tests that opt in below log, and to their own file.
      RUN_LOG: '',
      SF_RUN_TASK: '',
      ...(exit !== undefined ? { FAKE_CODEX_EXIT: String(exit) } : {}),
      ...(error ? { FAKE_CODEX_ERROR: error } : {}),
      ...env,
    },
  });
  const lines = res.stdout.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } });
  const argv = readFileSync(argvFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rpc = readFileSync(rpcFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, lines, last: lines[lines.length - 1], argv, rpc, prompts: readFileSync(promptsFile, 'utf8') };
}

const finding = (over = {}) => ({
  id: 'NX-1', severity: 'HIGH', title: 'stale prop', file: 'a.ts', line_start: 1, line_end: 1,
  what: 'exports a', wrong: 'value changed', impact: 'callers break', recommendation: 'revert',
  recommendation_cite: { file: 'a.ts', line: 1 }, live_code_verified: true, confidence: 0.9, ...over,
});
const reviewReply = (over = {}) => ({ verdict: 'PASS', findings: [], clean_areas: ['data access'], deferred_to_domain: [], probes_suggested: [], ...over });

test('dry-run assembles seat body + shared template + JSON contract, with no unfilled placeholders', () => {
  const fx = fixture();
  const r = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'nx-r1'), '--round', '1', '--change-ref', 'task X', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.last.status, 'dry-run');
  const prompt = readFileSync(join(fx.art, 'nx-r1.prompt.md'), 'utf8');
  assert.match(prompt, /ROLE-BODY-MARKER/);
  assert.doesNotMatch(prompt, /^---\nname:/m, 'frontmatter stripped');
  assert.match(prompt, /=== TASK ===/);
  assert.match(prompt, /Review the code changes for task X/);
  assert.match(prompt, /git diff HEAD~1\.\.HEAD/);
  assert.match(prompt, /Files changed: a\.ts/);
  assert.match(prompt, /OUTPUT CONTRACT \(Codex seat/);
  assert.doesNotMatch(prompt, /\{[a-z_]+\}/, 'no unfilled placeholders');
  assert.doesNotMatch(prompt, /Write your FULL report/, 'Claude output contract replaced');
});

test('baseline seats (architecture/performance) use the baseline template with no seat body', () => {
  const fx = fixture();
  const r = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'perf-r1'), '--round', '1', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.last.seat, null);
  const prompt = readFileSync(join(fx.art, 'perf-r1.prompt.md'), 'utf8');
  assert.match(prompt, /EXCLUSIVELY on performance/);
  assert.doesNotMatch(prompt, /=== TASK ===/);
});

test('failure-over-time baseline: bare template, no seat file, default tier frontier', () => {
  const fx = fixture();
  const r = run(fx, ['review', '--role', 'reviewer:failure-over-time', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'fot-r1'), '--round', '1', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.last.seat, null);
  const prompt = readFileSync(join(fx.art, 'fot-r1.prompt.md'), 'utf8');
  assert.match(prompt, /FAILURE OVER TIME/);
  assert.match(prompt, /interleaving/);
  assert.doesNotMatch(prompt, /=== TASK ===/);
  assert.doesNotMatch(prompt, /\{[a-z_]+\}/, 'no unfilled placeholders');
  const tiers = JSON.parse(readFileSync(resolve(HERE, '..', 'review-tiers.json'), 'utf8'));
  assert.equal(tiers.seats['failure-over-time'], 'frontier');
});

test('round1 live path: codex invoked read-only in the worktree with the schema; artifacts + result line', () => {
  const fx = fixture();
  const r = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'nx-r1'), '--round', '1'], { reply: [reviewReply({ verdict: 'FAIL', findings: [finding(), finding({ id: 'NX-2', severity: 'LOW', title: 'nit', recommendation_cite: null, live_code_verified: false })] })] });
  assert.equal(r.status, 0, r.stderr);
  const argv = r.argv[0];
  assert.equal(argv[0], 'exec');
  assert.ok(argv.includes('--json') && argv.includes('--output-schema') && argv.includes('-o'));
  assert.deepEqual(argv.slice(argv.indexOf('-s'), argv.indexOf('-s') + 2), ['-s', 'read-only']);
  assert.deepEqual(argv.slice(argv.indexOf('-C'), argv.indexOf('-C') + 2), ['-C', fx.repo]);
  assert.equal(argv[argv.length - 1], '-', 'prompt on stdin');
  assert.equal(r.last.status, 'ok');
  assert.equal(r.last.verdict, 'FAIL');
  assert.equal(r.last.high, 1); assert.equal(r.last.low, 1);
  assert.equal(r.last.tokens, 110); assert.equal(r.last.tokens_cached, 40);
  assert.match(r.last.thread_id, /^thread-/);
  assert.equal(r.last.path, 'cold');
  const md = readFileSync(join(fx.art, 'nx-r1.md'), 'utf8');
  assert.match(md, /## HIGH[\s\S]*NX-1 — stale prop \(a\.ts:1\)/);
  assert.match(md, /## LOW[\s\S]*\| NX-2 \|/);
  assert.match(md, /no live-code cite — fix not prescribed/);
  assert.match(md, /\*\*Verdict: FAIL\*\*\s*$/);
  assert.ok(existsSync(join(fx.art, 'nx-r1.json')));
  assert.ok(!existsSync(join(fx.art, 'nx-r1.prompt.md')), 'prompt not kept by default');
});

test('verdict is enforced from findings, and the correction is flagged', () => {
  const fx = fixture();
  const r = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'regression', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'nx-reg'), '--round', '1'], { reply: [reviewReply({ verdict: 'PASS', findings: [finding({ severity: 'CRITICAL' })] })] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.last.verdict, 'FAIL');
  assert.equal(r.last.verdict_corrected, true);
  assert.match(readFileSync(join(fx.art, 'nx-reg.md'), 'utf8'), /Verdict corrected by sf-codex/);
});

test('invalid JSON is retried once on the same thread; second failure exits 2', () => {
  const fx = fixture();
  const good = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'p1'), '--round', '1'], { reply: ['not json at all', reviewReply()] });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.argv.length, 2);
  assert.equal(good.argv[1][1], 'resume', 'retry resumes the thread');
  assert.equal(good.last.tokens, 220, 'retry usage is summed');
  const bad = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'p2'), '--round', '1'], { reply: ['{"verdict":"MAYBE"}', '{"verdict":"MAYBE"}'] });
  assert.equal(bad.status, 2);
  assert.equal(bad.last.status, 'failed');
  assert.match(bad.last.detail, /invalid after retry/);
});

test('codex failure surfaces the error event and exits 2; resume failure exits 3', () => {
  const fx = fixture();
  const f = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'f'), '--round', '1'], { exit: 1, error: '{"error":{"message":"Invalid schema for response_format"}}' });
  assert.equal(f.status, 2);
  assert.match(f.last.detail, /Invalid schema/);
  const nc = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'c'), '--round', '1', '--resume', 'thread-gone', '--findings-table', tableFile(fx)], { exit: 1, error: 'thread/resume failed: failed to list thread history' });
  assert.equal(nc.status, 3);
  assert.equal(nc.last.status, 'not-continuable');
});

function tableFile(fx) {
  const p = join(fx.root, 'ft.json');
  writeFileSync(p, JSON.stringify([
    { id: 'NX-1', summary: 'stale prop', status: 'fixed', commits: 'abc' },
    { id: 'NX-2', summary: 'nit', status: 'declined', evidence: 'dead code per a.ts:9' },
  ]));
  return p;
}

test('closure: resume without seat body, declined rows carried, missing ids render REOPENED', () => {
  const fx = fixture();
  const r = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'nx-r1-closure'), '--round', '1', '--resume', 'thread-abc', '--findings-table', tableFile(fx)], { reply: [{ closures: [{ id: 'NX-1', verdict: 'CLOSED', file: 'a.ts', line: 1, reason: 'gone' }], new_fix_introduced: [], answer: '' }] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.argv[0].slice(0, 3), ['exec', 'resume', 'thread-abc']);
  assert.ok(!r.argv[0].includes('-C'), 'resume takes no -C');
  assert.doesNotMatch(r.prompts, /ROLE-BODY-MARKER/, 'seat body not re-sent on resume');
  assert.doesNotMatch(r.prompts, /NOT-CONTINUABLE/, 'NOT-CONTINUABLE sentence stripped');
  assert.match(r.prompts, /NX-2 — nit — DECLINED: dead code per a\.ts:9/);
  assert.equal(r.last.path, 'warm');
  assert.equal(r.last.closed, 1); assert.equal(r.last.reopened, 1);
  assert.deepEqual(r.last.missing_ids, ['NX-2']);
  const md = readFileSync(join(fx.art, 'nx-r1-closure.md'), 'utf8');
  assert.match(md, /\| NX-2 \| REOPENED \| — \| not verdicted/);
  assert.match(md, /Closure: 1 CLOSED \/ 1 REOPENED \/ 0 DECLINE-ACCEPTED \/ 0 NOT-MINE/);
});

test('0.31.0: --decisions splices the adjudication ## Accepted lines into the closure prompt as facts', () => {
  const fx = fixture();
  const decisions = join(fx.root, 'adjudication-r1.md');
  writeFileSync(decisions, [
    '# Adjudication round 1', '',
    '## Accepted', '- restriction is page-scoped per the direction invariant',
    '- the pool is rebuilt per request (matches $&, a literal to prove no regex splice)', '',
    '## Redirected', '- U9 must be transaction-scoped, not per-row', '',
  ].join('\n'));

  const withDec = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'c-dec'), '--round', '1', '--resume', 'thread-abc', '--findings-table', tableFile(fx), '--decisions', decisions, '--dry-run']);
  assert.equal(withDec.status, 0, withDec.stderr);
  const prompt = readFileSync(join(fx.art, 'c-dec.prompt.md'), 'utf8');
  assert.match(prompt, /Accepted design decisions \(facts for this verification\):/);
  assert.match(prompt, /restriction is page-scoped per the direction invariant/);
  assert.match(prompt, /matches \$&, a literal to prove no regex splice/, 'fill is a literal splice — $& is inert');
  assert.doesNotMatch(prompt, /U9 must be transaction-scoped/, 'only the ## Accepted section is spliced');
  assert.match(prompt, /DECLINE-ACCEPTED/, 'closure dispositions after the insertion survive');
  assert.match(prompt, /NEW \(fix-introduced\)/, 'the bounded new-defect exception survives the splice');

  const noDec = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'c-nodec'), '--round', '1', '--resume', 'thread-abc', '--findings-table', tableFile(fx), '--dry-run']);
  assert.equal(noDec.status, 0, noDec.stderr);
  const noPrompt = readFileSync(join(fx.art, 'c-nodec.prompt.md'), 'utf8');
  assert.match(noPrompt, /\(none — the fixer reported no semantic decisions this round\)/);

  const t = spawnSync(process.execPath, [SF_CODEX, 'templates'], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stdout + t.stderr);
});

test('0.31.0: --decisions distinguishes an all-redirected file from a non-adjudication file', () => {
  const fx = fixture();
  // Present-but-empty ## Accepted (every decision was redirected) → the "(none accepted …)" literal.
  const allRedirected = join(fx.root, 'adjudication-r2.md');
  writeFileSync(allRedirected, ['# Adjudication round 2', '', '## Accepted', '', '## Redirected', '- U9 must be transaction-scoped', ''].join('\n'));
  const r1 = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'c-allred'), '--round', '2', '--resume', 'thread-abc', '--findings-table', tableFile(fx), '--decisions', allRedirected, '--dry-run']);
  assert.equal(r1.status, 0, r1.stderr);
  const p1 = readFileSync(join(fx.art, 'c-allred.prompt.md'), 'utf8');
  assert.match(p1, /none accepted — every decision this round was redirected and fixed by the addendum/);
  assert.doesNotMatch(p1, /no semantic decisions this round/, 'an all-redirected round is not "no decisions"');

  // A file with neither section is not an adjudication file → die, not a false none literal.
  const notAdj = join(fx.root, 'notes.md');
  writeFileSync(notAdj, ['# Some notes', '', '- nothing structured here', ''].join('\n'));
  const r2 = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'c-notadj'), '--round', '2', '--resume', 'thread-abc', '--findings-table', tableFile(fx), '--decisions', notAdj, '--dry-run']);
  assert.equal(r2.status, 1, 'neither heading → die (sf-codex die exits 1)');
  assert.match(r2.stderr, /neither a "## Accepted" nor a "## Redirected" section/);

  // A missing --decisions path dies with a legible message, not a raw ENOENT stack trace.
  const r3 = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'c-missing'), '--round', '2', '--resume', 'thread-abc', '--findings-table', tableFile(fx), '--decisions', join(fx.root, 'no-such-file.md'), '--dry-run']);
  assert.equal(r3.status, 1, 'missing --decisions file → die');
  assert.match(r3.stderr, /--decisions: file not found/);
  assert.doesNotMatch(r3.stderr, /ENOENT/, 'no raw Node stack trace');

  const t = spawnSync(process.execPath, [SF_CODEX, 'templates'], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stdout + t.stderr);
});

test('closure and clarify refuse to run cold', () => {
  const fx = fixture();
  const r = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'clarify', '--cwd', fx.repo, '--artifact', join(fx.art, 'cl'), '--round', '1', '--finding', 'P-1', '--question', 'why?']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /requires --resume/);
});

test('plan review: criteria by path, Step-4 layout, verdict rules enforced', () => {
  const fx = fixture();
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const req = join(fx.repo, 'docs', 'plans', 'task-x.requirements.md');
  const pf = { id: 'P-1', severity: 'HIGH', dimension: '3.2', title: 'wrong module', plan_says: 'put it in X', problem: 'X is a leaf', impact: 'cycle', evidence: 'src/x.ts:1', recommendation: 'use Y', unverified: true };
  const r = run(fx, ['review', '--role', 'plan-reviewer', '--template', 'plan-r1', '--cwd', fx.repo, '--plan', plan, '--requirements', req, '--artifact', join(fx.art, 'plan-review-r1'), '--round', '1'], { reply: [{ overall_risk: 'LOW', verdict: 'Proceed as-is', findings: [pf], clean_dimensions: ['3.4 — Security Implications'], open_questions: [] }] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.prompts, /review-plan\/SKILL\.md/);
  assert.match(r.prompts, /scoring-rubric\.md/);
  assert.match(r.prompts, new RegExp(`Plan file: ${plan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(r.last.verdict, 'Proceed with modifications');
  assert.equal(r.last.overall_risk, 'HIGH');
  assert.equal(r.last.verdict_corrected, true);
  const md = readFileSync(join(fx.art, 'plan-review-r1.md'), 'utf8');
  assert.match(md, /### Overall Risk: \*\*HIGH\*\*/);
  assert.match(md, /\| HIGH \| 3\.2 \| P-1 — wrong module \|/);
  assert.match(md, /\*\*Recommendation:\*\* UNVERIFIED — use Y/);
  assert.match(md, /- 3\.4 — Security Implications: No issues identified\./);
  assert.match(md, /None — the plan addresses all foreseeable concerns\./);
  assert.match(md, /### Verdict\n\n\*\*Proceed with modifications\.\*\*/);
  // targeted re-review resumes the round-1 thread
  const r2 = run(fx, ['review', '--role', 'plan-reviewer', '--template', 'plan-rereview', '--cwd', fx.repo, '--plan', plan, '--artifact', join(fx.art, 'plan-review-r2'), '--round', '2', '--resume', r.last.thread_id], { reply: [{ overall_risk: 'NONE', verdict: 'Proceed as-is', findings: [], clean_dimensions: [], open_questions: [] }] });
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.prompts, /TARGETED re-review \(round 2\)/);
  assert.match(r2.prompts, /plan-review-r1\.md/);
  assert.equal(r2.last.verdict, 'Proceed as-is');
});

test('panel: partitions the sf-route roster by pins, runs the rest, reports failures per seat', () => {
  const fx = fixture();
  const roster = join(fx.root, 'route.json');
  writeFileSync(roster, JSON.stringify({ reviewers: { routed: ['frontend-reviewer', 'ux-consistency-lead'], baselines: ['security-reviewer', 'performance'] } }));
  const r = run(fx, ['panel', '--roster', roster, '--pin', 'security-reviewer,ux-consistency-lead', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact-dir', fx.art, '--round', '1', '--max-parallel', '2', '--no-log'], { reply: [reviewReply()] });
  assert.equal(r.status, 0, r.stderr);
  const summary = r.last;
  assert.equal(summary.panel, true);
  assert.deepEqual(summary.seats, ['frontend-reviewer', 'performance']);
  assert.deepEqual(summary.pinned, ['ux-consistency-lead', 'security-reviewer']);
  assert.equal(summary.delivered, 2);
  const seatLines = r.lines.filter((l) => l.role);
  assert.deepEqual(seatLines.map((l) => l.role).sort(), ['reviewer:frontend-reviewer', 'reviewer:performance']);
  assert.ok(existsSync(join(fx.art, 'review-frontend-reviewer-r1.md')));
  assert.ok(existsSync(join(fx.art, 'review-performance-r1.md')));
});

test('panel: a cold-roster file is accepted and a failed seat is named', () => {
  const fx = fixture();
  const roster = join(fx.root, 'cold.json');
  writeFileSync(roster, JSON.stringify({ mode: 'warm', roster: ['performance', 'security-reviewer'], skippable: false }));
  const r = run(fx, ['panel', '--roster', roster, '--pin', 'security-reviewer', '--template', 'regression', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact-dir', fx.art, '--round', '1', '--no-log'], { exit: 1, error: 'usage limit reached (429)' });
  assert.equal(r.status, 2, 'every seat failed');
  assert.deepEqual(r.last.failed, ['reviewer:performance']);
});

test('home init creates an isolated CODEX_HOME with auth + config; gc removes old ones', () => {
  const fx = fixture();
  const fakeCodexHome = join(fx.root, 'user-codex');
  mkdirSync(fakeCodexHome);
  writeFileSync(join(fakeCodexHome, 'auth.json'), '{"t":1}');
  writeFileSync(join(fakeCodexHome, 'config.toml'), 'model = "gpt-test"\nmodel_reasoning_effort = "medium"\n');
  const env = { ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, CODEX_HOME: fakeCodexHome, HOME: fx.root, FAKE_CODEX_ARGV: join(fx.root, 'argv.log'), FAKE_CODEX_PROMPTS: join(fx.root, 'p.log'), FAKE_CODEX_REPLY: join(fx.root, 'r.jsonl') };
  writeFileSync(join(fx.root, 'r.jsonl'), '');
  const res = spawnSync(process.execPath, [SF_CODEX, 'home', 'init', '--run', 'unit-test-run'], { encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  const home = res.stdout.trim();
  assert.equal(home, join(fx.root, '.cache', 'sf-codex', 'unit-test-run'));
  assert.ok(existsSync(join(home, 'auth.json')));
  const cfg = readFileSync(join(home, 'config.toml'), 'utf8');
  assert.match(cfg, /model = "gpt-test"\nmodel_reasoning_effort = "medium"\nsandbox_mode = "read-only"/);
  // bwrap failed in the fake → landlock enabled in the run home, reported on stderr
  assert.match(cfg, /\[features\]\nuse_legacy_landlock = true/);
  assert.match(res.stderr, /sandbox backend = landlock/);
  const again = spawnSync(process.execPath, [SF_CODEX, 'home', 'init', '--run', 'unit-test-run'], { encoding: 'utf8', env });
  assert.equal(again.status, 0);
  assert.equal((readFileSync(join(home, 'config.toml'), 'utf8').match(/use_legacy_landlock/g) || []).length, 1, 'idempotent');
  const okHome = spawnSync(process.execPath, [SF_CODEX, 'home', 'init', '--run', 'unit-test-bwrap'], { encoding: 'utf8', env: { ...env, FAKE_SANDBOX_OK: '1' } });
  assert.equal(okHome.status, 0, okHome.stderr);
  assert.doesNotMatch(readFileSync(join(okHome.stdout.trim(), 'config.toml'), 'utf8'), /use_legacy_landlock/);
  // Neither backend → reader seats switch to snapshots (marker in the run home), not exit 1
  const none = spawnSync(process.execPath, [SF_CODEX, 'home', 'init', '--run', 'unit-test-none'], { encoding: 'utf8', env: { ...env, FAKE_SANDBOX_ALL_FAIL: '1' } });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stderr, /sandbox backend = snapshot/);
  const marker = join(none.stdout.trim(), 'sf-sandbox.json');
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).reader, 'snapshot');
  assert.doesNotMatch(readFileSync(join(none.stdout.trim(), 'config.toml'), 'utf8'), /use_legacy_landlock/);
  // …and a later probe that finds a working backend clears the marker
  const healed = spawnSync(process.execPath, [SF_CODEX, 'home', 'init', '--run', 'unit-test-none'], { encoding: 'utf8', env: { ...env, FAKE_SANDBOX_OK: '1' } });
  assert.equal(healed.status, 0, healed.stderr);
  assert.equal(existsSync(marker), false);
  // SF_CODEX_SNAPSHOT_FALLBACK=0 keeps the hard stop
  const strict = spawnSync(process.execPath, [SF_CODEX, 'home', 'init', '--run', 'unit-test-strict'], { encoding: 'utf8', env: { ...env, FAKE_SANDBOX_ALL_FAIL: '1', SF_CODEX_SNAPSHOT_FALLBACK: '0' } });
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /no working codex sandbox/);
  const gc = spawnSync(process.execPath, [SF_CODEX, 'home', 'gc', '--older-than', '0'], { encoding: 'utf8', env: { ...process.env, HOME: fx.root } });
  assert.equal(gc.status, 0, gc.stderr);
  assert.match(gc.stdout, /removed 4 run home/);
});

test('ledger: review emits a backend=codex spawn event and closure a closure-exchange when RUN_LOG is set', () => {
  const fx = fixture();
  const log = join(fx.root, 'run.jsonl');
  const env = { RUN_LOG: log, SF_RUN_TASK: 'unit-task' };
  const r1 = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'p'), '--round', '1'], { reply: [reviewReply()], env });
  assert.equal(r1.status, 0, r1.stderr);
  const r2 = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'p-closure'), '--round', '1', '--resume', r1.last.thread_id, '--findings-table', tableFile(fx)], { reply: [{ closures: [{ id: 'NX-1', verdict: 'CLOSED', file: 'a.ts', line: 1, reason: 'gone' }, { id: 'NX-2', verdict: 'DECLINE-ACCEPTED', file: 'a.ts', line: 9, reason: 'dead' }], new_fix_introduced: [], answer: '' }], env });
  assert.equal(r2.status, 0, r2.stderr);
  const events = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const spawn = events.find((e) => e.stage === 'spawn');
  assert.ok(spawn, 'spawn event written');
  assert.equal(spawn.role, 'reviewer:performance');
  assert.equal(spawn.agent_type, 'codex-exec');
  assert.equal(spawn.backend, 'codex');
  assert.equal(spawn.phase, 'review');
  assert.equal(spawn.tokens, 110);
  assert.equal(spawn.tokens_cached, 40);
  assert.equal(spawn.agent_id, r1.last.thread_id);
  assert.equal(spawn.task, 'unit-task');
  assert.ok(Number.isInteger(spawn.wall_ms));
  const closure = events.find((e) => e.stage === 'closure-exchange');
  assert.ok(closure, 'closure-exchange event written');
  assert.equal(closure.role, 'reviewer:performance:closure');
  assert.equal(closure.path, 'warm');
  assert.equal(closure.backend, 'codex');
  assert.equal(closure.findings_closed, 1);
  assert.equal(closure.findings_decline_accepted, 1);
  // 0.31.0: reopened_ids on the closure row map each reopened seat id to its DEDUPE item id
  // (item ?? id); a REOPENED verdict and an unverdicted (missing → REOPENED) id both count.
  const itemTable = join(fx.root, 'ft-items.json');
  writeFileSync(itemTable, JSON.stringify([
    { id: 'NX-1', item: 'U1', summary: 'stale prop', status: 'fixed', commits: 'abc' },
    { id: 'NX-2', summary: 'nit', status: 'declined', evidence: 'dead code per a.ts:9' },
  ]));
  const rReopen = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'p-closure-2'), '--round', '2', '--resume', r1.last.thread_id, '--findings-table', itemTable], { reply: [{ closures: [{ id: 'NX-1', verdict: 'REOPENED', file: 'a.ts', line: 1, reason: 'still there' }], new_fix_introduced: [], answer: '' }], env });
  assert.equal(rReopen.status, 0, rReopen.stderr);
  const reopenRow = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.stage === 'closure-exchange' && e.round === 2);
  assert.ok(reopenRow, 'round-2 closure-exchange event written');
  assert.deepEqual(reopenRow.reopened_ids, ['U1', 'NX-2']);
  // 0.31.0: two seat ids merged into one item, both REOPENED, list the item once (distinct ids).
  const mergedTable = join(fx.root, 'ft-merged.json');
  writeFileSync(mergedTable, JSON.stringify([
    { id: 'PERF-3', item: 'U1', summary: 'stale prop A', status: 'fixed', commits: 'abc' },
    { id: 'SEC-2', item: 'U1', summary: 'stale prop B', status: 'fixed', commits: 'def' },
  ]));
  const rMerged = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'p-closure-3'), '--round', '3', '--resume', r1.last.thread_id, '--findings-table', mergedTable], { reply: [{ closures: [{ id: 'PERF-3', verdict: 'REOPENED', file: 'a.ts', line: 1, reason: 'still there' }, { id: 'SEC-2', verdict: 'REOPENED', file: 'b.ts', line: 2, reason: 'still there' }], new_fix_introduced: [], answer: '' }], env });
  assert.equal(rMerged.status, 0, rMerged.stderr);
  const mergedRow = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.stage === 'closure-exchange' && e.round === 3);
  assert.ok(mergedRow, 'round-3 closure-exchange event written');
  assert.deepEqual(mergedRow.reopened_ids, ['U1'], 'two seats merged to one item → one entry');
  // --no-log suppresses it
  const before = readFileSync(log, 'utf8').trim().split('\n').length;
  const r3 = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'q'), '--round', '1', '--no-log'], { reply: [reviewReply()], env });
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, before, '--no-log appends nothing');
});

test('validator: anyOf shapes are enforced (recommendation_cite), retry fires', () => {
  const fx = fixture();
  const r = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'v'), '--round', '1'], { reply: [reviewReply({ verdict: 'FAIL', findings: [finding({ recommendation_cite: 'a.ts:1' })] }), reviewReply({ verdict: 'FAIL', findings: [finding()] })] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.argv.length, 2, 'retry fired on invalid anyOf shape');
  const bad = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'v2'), '--round', '1'], { reply: [reviewReply({ findings: [finding({ recommendation_cite: { file: '', line: 0 } })] }), reviewReply({ findings: [finding({ recommendation_cite: 5 })] })] });
  assert.equal(bad.status, 2);
});

test('usage errors exit 1 with no result line; criteria missing exits 4', () => {
  const fx = fixture();
  const r = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--artifact', join(fx.art, 'u'), '--round', '1']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--range/);
  assert.equal(r.stdout.trim(), '');
  const r2 = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'round2', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'u2'), '--round', '2']);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /--prior-artifact/);
  const r3 = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'u3'), '--round', '1', '--timeout-min', 'abc']);
  assert.equal(r3.status, 1);
  assert.match(r3.stderr, /--timeout-min/);
  const missingSeat = run(fx, ['review', '--role', 'reviewer:no-such-agent', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'u4'), '--round', '1']);
  assert.equal(missingSeat.status, 1);
  const help = spawnSync(process.execPath, [SF_CODEX, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /sf-codex review/);
});

test('429 → one retry → delivered; --ephemeral skips the JSON retry', () => {
  const fx = fixture();
  // fake: first call errors with a 429 text, second succeeds — emulate with a reply-indexed exit
  writeFileSync(join(fx.bin, 'codex'), readFileSync(join(fx.bin, 'codex'), 'utf8').replace(
    "const exitCode = Number(process.env.FAKE_CODEX_EXIT || 0);",
    "const idx0 = Number(fs.existsSync(process.env.FAKE_CODEX_REPLY + '.idx') ? fs.readFileSync(process.env.FAKE_CODEX_REPLY + '.idx', 'utf8') : 0);\nif (process.env.FAKE_429_FIRST && idx0 === 0) { fs.writeFileSync(process.env.FAKE_CODEX_REPLY + '.idx', '1'); process.stdout.write(JSON.stringify({ type: 'error', message: 'usage limit reached (429)' }) + '\\n'); process.exit(1); }\nconst exitCode = Number(process.env.FAKE_CODEX_EXIT || 0);"));
  const r = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'rl'), '--round', '1'], { reply: [reviewReply(), reviewReply()], env: { FAKE_429_FIRST: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.argv.length, 2);
  assert.equal(r.last.status, 'ok');
  const eph = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'regression', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'eph'), '--round', '1', '--ephemeral'], { reply: ['not json', reviewReply()] });
  assert.equal(eph.status, 2);
  assert.equal(eph.argv.length, 1, 'no retry on --ephemeral');
  assert.ok(eph.argv[0].includes('--ephemeral'));
});

test('timeout kills the process group and reports failed within the budget', () => {
  const fx = fixture();
  writeFileSync(join(fx.bin, 'codex'), `#!/usr/bin/env node
const { spawn } = require('child_process');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't-slow' }) + '\\n');
const c = spawn('sleep', ['20'], { stdio: 'inherit' });
c.on('exit', () => process.exit(0));
`);
  const t0 = Date.now();
  const r = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'to'), '--round', '1', '--timeout-min', '0.02']);
  const wall = Date.now() - t0;
  assert.equal(r.status, 2);
  assert.equal(r.last.status, 'failed');
  assert.match(r.last.detail, /timed out/);
  assert.equal(r.last.thread_id, 't-slow', 'thread id kept on failure');
  assert.ok(wall < 8000, `reported in ${wall}ms, not after the orphaned sleep`);
});

test('0.29.0: a failed seat recovers its usage from the rollout file and ledgers it on the codex-seat-failed note', () => {
  const fx = fixture();
  writeFileSync(join(fx.bin, 'codex'), `#!/usr/bin/env node
const { spawn } = require('child_process');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't-rollout' }) + '\\n');
const c = spawn('sleep', ['20'], { stdio: 'inherit' });
c.on('exit', () => process.exit(0));
`);
  // codex writes sessions/<y>/<m>/<d>/rollout-<stamp>-<thread>.jsonl with a running token_count per turn.
  const sess = join(fx.root, 'home', 'sessions', '2026', '09', '08');
  mkdirSync(sess, { recursive: true });
  const tc = (input, cached, output, reasoning) => JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning } } } });
  writeFileSync(join(sess, 'rollout-2026-09-08T00-00-00-t-rollout.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 't-rollout' } }),
    tc(1000, 900, 10, 5),
    tc(34796312, 34167296, 110258, 64805),
    '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1', // torn last line
  ].join('\n'));
  const log = join(fx.root, 'run.jsonl');
  writeFileSync(log, '');
  const r = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'ro'), '--round', '1', '--timeout-min', '0.02'], { env: { RUN_LOG: log, SF_RUN_TASK: 't' } });
  assert.equal(r.last.status, 'failed');
  assert.equal(r.last.tokens_in, 34796312); assert.equal(r.last.tokens_cached, 34167296);
  assert.equal(r.last.tokens_out, 110258); assert.equal(r.last.usage_source, 'rollout');
  const note = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.event === 'codex-seat-failed');
  assert.equal(note.tokens, 34796312 + 110258); assert.equal(note.tokens_cached, 34167296);
  assert.equal(note.usage_source, 'rollout'); assert.ok(Number.isInteger(note.wall_ms));
});

test('closure ignores unknown / duplicate ids; plan verdict downgrade and upgrade rules', () => {
  const fx = fixture();
  const r = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'cl2'), '--round', '1', '--resume', 'thread-x', '--findings-table', tableFile(fx)], { reply: [{ closures: [{ id: 'NX-1', verdict: 'CLOSED', file: 'a.ts', line: 1, reason: 'gone' }, { id: 'NX-1', verdict: 'REOPENED', file: 'a.ts', line: 1, reason: 'dup' }, { id: 'GHOST-9', verdict: 'CLOSED', file: 'a.ts', line: 1, reason: 'never existed' }, { id: 'NX-2', verdict: 'DECLINE-ACCEPTED', file: 'a.ts', line: 9, reason: 'dead' }], new_fix_introduced: [], answer: '' }] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.last.closed, 1); assert.equal(r.last.reopened, 0); assert.equal(r.last.decline_accepted, 1);
  assert.match(r.stderr, /unknown finding GHOST-9/);
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const req = join(fx.repo, 'docs', 'plans', 'task-x.requirements.md');
  const pf = (sev) => ({ id: 'P-1', severity: sev, dimension: '3.1', title: 't', plan_says: 'x', problem: 'y', impact: 'z', evidence: 'e', recommendation: 'r', unverified: false });
  const down = run(fx, ['review', '--role', 'plan-reviewer', '--template', 'plan-r1', '--cwd', fx.repo, '--plan', plan, '--requirements', req, '--artifact', join(fx.art, 'pd'), '--round', '1'], { reply: [{ overall_risk: 'MEDIUM', verdict: 'Stop and redesign', findings: [pf('MEDIUM')], clean_dimensions: [], open_questions: [] }] });
  assert.equal(down.last.verdict, 'Proceed with modifications');
  const up = run(fx, ['review', '--role', 'plan-reviewer', '--template', 'plan-r1', '--cwd', fx.repo, '--plan', plan, '--requirements', req, '--artifact', join(fx.art, 'pu'), '--round', '1'], { reply: [{ overall_risk: 'LOW', verdict: 'Proceed as-is', findings: [pf('CRITICAL')], clean_dimensions: [], open_questions: [] }] });
  assert.equal(up.last.verdict, 'Stop and redesign');
  assert.equal(up.last.overall_risk, 'CRITICAL');
});

test('panel: --routed-only drops baselines, per-seat flags rejected, summary file written', () => {
  const fx = fixture();
  const roster = join(fx.root, 'route.json');
  writeFileSync(roster, JSON.stringify({ reviewers: { routed: ['frontend-reviewer'], baselines: ['security-reviewer', 'performance'] } }));
  const r = run(fx, ['panel', '--roster', roster, '--routed-only', '--pin', 'security-reviewer', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact-dir', fx.art, '--round', '1', '--no-log'], { reply: [reviewReply()] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.last.seats, ['frontend-reviewer']);
  const summary = JSON.parse(readFileSync(join(fx.art, 'panel-round1-r1.json'), 'utf8'));
  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].role, 'reviewer:frontend-reviewer');
  assert.match(summary.results[0].thread_id, /^thread-/);
  const bad = run(fx, ['panel', '--roster', roster, '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact-dir', fx.art, '--round', '1', '--artifact', 'x']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /per-seat/);
});

test('panel: --routed-only keeps the failure-over-time baseline and seats it with no seat file', () => {
  const fx = fixture();
  const roster = join(fx.root, 'route.json');
  writeFileSync(roster, JSON.stringify({ reviewers: { routed: ['frontend-reviewer'], baselines: ['security-reviewer', 'architecture', 'failure-over-time'] } }));
  const art = join(fx.art, 'ro');
  mkdirSync(art);
  const r = run(fx, ['panel', '--roster', roster, '--routed-only', '--pin', 'security-reviewer', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact-dir', art, '--round', '1', '--no-log'], { reply: [reviewReply()] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.last.seats, ['frontend-reviewer', 'failure-over-time']);
  const summary = JSON.parse(readFileSync(join(art, 'panel-round1-r1.json'), 'utf8'));
  assert.ok(summary.results.some((x) => x.role === 'reviewer:failure-over-time' && x.status !== 'usage-error'), JSON.stringify(summary.results));
});

test('templates verb resolves every template; home init rejects path-like run ids; prompts keep the post-NOT-CONTINUABLE rule', () => {
  const fx = fixture();
  const t = spawnSync(process.execPath, [SF_CODEX, 'templates'], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stdout + t.stderr);
  // one line per template plus one per round1 baseline heading (security, architecture, performance, failure-over-time)
  assert.equal((t.stdout.match(/\[ok\]/g) || []).length, 14, t.stdout);
  assert.match(t.stdout, /round1:failure-over-time .*Baseline reviewer 4 — failure over time\s+\[ok\]/);
  assert.match(t.stdout, /plan-fot-r1 .*Round 1 — plan failure-over-time seat\s+\[ok\]/);
  const bad = spawnSync(process.execPath, [SF_CODEX, 'home', 'init', '--run', '../escape'], { encoding: 'utf8', env: { ...process.env, HOME: fx.root } });
  assert.equal(bad.status, 1);
  const r = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'nc'), '--round', '1', '--resume', 'thread-abc', '--findings-table', tableFile(fx), '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  const prompt = readFileSync(join(fx.art, 'nc.prompt.md'), 'utf8');
  assert.doesNotMatch(prompt, /NOT-CONTINUABLE/);
  assert.match(prompt, /do not attempt verification from the fix diff alone/);
});

test('blind seat: every command failed (bwrap) or no command ran → exit 2 status blind, never a verdict', () => {
  const fx = fixture();
  const blind = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'b1'), '--round', '1'], { reply: [reviewReply()], env: { FAKE_CODEX_CMD_EXIT: '1' } });
  assert.equal(blind.status, 2);
  assert.equal(blind.last.status, 'blind');
  assert.match(blind.last.detail, /all 1 shell commands failed: bwrap/);
  assert.equal(blind.last.commands_ok, 0);
  assert.ok(!existsSync(join(fx.art, 'b1.md')), 'no artifact for a blind seat');
  const none = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'b2'), '--round', '1'], { reply: [reviewReply()], env: { FAKE_CODEX_NO_CMD: '1' } });
  assert.equal(none.status, 2);
  assert.match(none.last.detail, /ran no shell command/);
  // clarify answers from held context — no command needed
  const cl = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'clarify', '--cwd', fx.repo, '--artifact', join(fx.art, 'b3'), '--round', '1', '--resume', 't', '--finding', 'P-1', '--question', 'why?'], { reply: [{ closures: [], new_fix_introduced: [], answer: 'because' }], env: { FAKE_CODEX_NO_CMD: '1' } });
  assert.equal(cl.status, 0, cl.stderr);
  // healthy seat reports its command counts on the result line and in the ledger
  const log = join(fx.root, 'run.jsonl');
  const ok = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'b4'), '--round', '1'], { reply: [reviewReply()], env: { RUN_LOG: log, SF_RUN_TASK: 't' } });
  assert.equal(ok.last.commands_run, 1); assert.equal(ok.last.commands_ok, 1);
  const ev = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop());
  assert.equal(ev.commands_ok, 1);
});

test('seat tiers: baselines/TCG run at their tier, routed seats inherit, regression overrides, flags win, resume never re-tiers', () => {
  const fx = fixture();
  writeFileSync(join(fx.seats, 'test-coverage-guardian.md'), '---\nname: test-coverage-guardian\nmodel: opus\n---\nYou assess coverage. TCG-BODY\n');
  const rev = (role, template, extra = [], opts = {}) => run(fx, ['review', '--role', role, '--template', template, '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, `${role.replace(/[:/]/g, '_')}-${template}-${extra.length}`), '--round', '1', ...extra], { reply: [reviewReply()], ...opts });
  const modelOf = (argv) => (argv.includes('-m') ? argv[argv.indexOf('-m') + 1] : null);
  const effortOf = (argv) => { const c = argv.findIndex((a, i) => a === '-c' && /model_reasoning_effort/.test(argv[i + 1])); return c === -1 ? null : argv[c + 1]; };
  const serviceOf = (argv) => { const c = argv.findIndex((a, i) => a === '-c' && /^service_tier=/.test(argv[i + 1])); return c === -1 ? null : argv[c + 1]; };

  const arch = rev('reviewer:architecture', 'round1');
  assert.equal(arch.status, 0, arch.stderr);
  assert.equal(modelOf(arch.argv[0]), 'gpt-6.1-sol');
  assert.equal(effortOf(arch.argv[0]), 'model_reasoning_effort="high"');
  assert.equal(arch.last.tier, 'standard'); assert.equal(arch.last.model, 'gpt-6.1-sol'); assert.equal(arch.last.effort, 'high');
  assert.equal(serviceOf(arch.argv[0]), 'service_tier="default"', 'every checked-in tier pins the default service tier'); assert.equal(arch.last.service_tier, 'default');

  const tcg = rev('reviewer:test-coverage-guardian', 'round1', ['--seat', 'test-coverage-guardian']);
  assert.equal(tcg.status, 0, tcg.stderr);
  assert.equal(modelOf(tcg.argv[0]), 'gpt-6.1-sol');
  assert.equal(effortOf(tcg.argv[0]), 'model_reasoning_effort="medium"');
  assert.equal(tcg.last.tier, 'standard-light');

  const nx = rev('reviewer:frontend-reviewer', 'round1');
  assert.equal(nx.status, 0, nx.stderr);
  assert.equal(modelOf(nx.argv[0]), 'gpt-6.1-sol', 'frontier pins the gate model');
  assert.equal(effortOf(nx.argv[0]), 'model_reasoning_effort="medium"');
  assert.equal(nx.last.tier, 'frontier');

  const reg = rev('reviewer:frontend-reviewer', 'regression');
  assert.equal(reg.status, 0, reg.stderr);
  assert.equal(modelOf(reg.argv[0]), 'gpt-6.1-sol');
  assert.equal(effortOf(reg.argv[0]), 'model_reasoning_effort="medium"');
  assert.equal(reg.last.tier, 'standard-light', 'template tier beats the seat tier');

  const forced = rev('reviewer:architecture', 'round1', ['--tier', 'frontier']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(modelOf(forced.argv[0]), 'gpt-6.1-sol'); assert.equal(forced.last.tier, 'frontier');

  const explicit = rev('reviewer:architecture', 'round1', ['--model', 'gpt-x', '--effort', 'xhigh']);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(modelOf(explicit.argv[0]), 'gpt-x'); assert.equal(effortOf(explicit.argv[0]), 'model_reasoning_effort="xhigh"');
  assert.equal(explicit.last.tier, 'explicit');

  // --service-tier overrides the seat's tier for an experiment; a bad value is a usage error
  const svc = rev('reviewer:architecture', 'round1', ['--service-tier', 'flex']);
  assert.equal(svc.status, 0, svc.stderr);
  assert.equal(serviceOf(svc.argv[0]), 'service_tier="flex"'); assert.equal(svc.last.service_tier, 'flex'); assert.equal(svc.last.tier, 'explicit');
  assert.equal(rev('reviewer:architecture', 'round1', ['--service-tier', 'zoom']).status, 1, 'an unknown service_tier is caught locally, never sent to codex');

  const plan = run(fx, ['review', '--role', 'plan-reviewer', '--template', 'plan-r1', '--cwd', fx.repo, '--plan', 'docs/plans/task-x.plan.md', '--requirements', 'docs/plans/task-x.requirements.md', '--artifact', join(fx.art, 'plan-tier'), '--round', '1'], { reply: [{ overall_risk: 'NONE', verdict: 'Proceed as-is', findings: [], clean_dimensions: ['3.1 — Scope'], open_questions: [] }] });
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.last.tier, 'frontier'); assert.equal(modelOf(plan.argv[0]), 'gpt-6.1-sol');

  // the plan-stage failure-over-time seat: its own seat tier, the plan-r1 rendering, <repo root> filled
  const fot = run(fx, ['review', '--role', 'plan-reviewer:failure-over-time', '--template', 'plan-fot-r1', '--cwd', fx.repo, '--plan', 'docs/plans/task-x.plan.md', '--requirements', 'docs/plans/task-x.requirements.md', '--artifact', join(fx.art, 'plan-review-fot-r1'), '--round', '1'], { reply: [{ overall_risk: 'NONE', verdict: 'Proceed as-is', findings: [], clean_dimensions: ['3.5 — Resources, State and Scale'], open_questions: [] }] });
  assert.equal(fot.status, 0, fot.stderr);
  assert.equal(fot.last.tier, 'frontier'); assert.equal(modelOf(fot.argv[0]), 'gpt-6.1-sol');
  assert.match(fot.prompts, /FAILURE OVER TIME/);
  assert.match(fot.prompts, /Requirements file: \S*task-x\.requirements\.md/);
  assert.doesNotMatch(fot.prompts, /<repo root>|<absolute path>|plan-review-fot-r1\.md>/, 'placeholders filled, delivery lines cut');
  assert.ok(existsSync(join(fx.art, 'plan-review-fot-r1.md')));
  const tierTable = JSON.parse(readFileSync(resolve(HERE, '..', 'review-tiers.json'), 'utf8'));
  assert.equal(tierTable.seats['plan-failure-over-time'], tierTable.seats['failure-over-time'], 'tiered like the code-stage seat');

  const closure = run(fx, ['review', '--role', 'reviewer:architecture', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'arch-closure'), '--round', '1', '--resume', arch.last.thread_id, '--findings-table', tableFile(fx)], { reply: [{ closures: [{ id: 'NX-1', verdict: 'CLOSED', file: 'a.ts', line: 1, reason: 'gone' }, { id: 'NX-2', verdict: 'CLOSED', file: 'a.ts', line: 9, reason: 'gone' }], new_fix_introduced: [], answer: '' }] });
  assert.equal(closure.status, 0, closure.stderr);
  assert.equal(modelOf(closure.argv[0]), 'gpt-6.1-sol', 'a resumed thread re-applies the model it was opened with (sidecar), never the table');
  assert.equal(closure.last.tier, 'thread'); assert.equal(closure.last.model, 'gpt-6.1-sol');

  const custom = join(fx.root, 'tiers.json');
  writeFileSync(custom, JSON.stringify({ tiers: { cheap: { model: 'm-cheap', effort: 'low' } }, seats: { '*': 'cheap' } }));
  const swapped = rev('reviewer:architecture', 'round1', [], { env: { SF_CODEX_TIERS: custom } });
  assert.equal(swapped.status, 0, swapped.stderr);
  assert.equal(modelOf(swapped.argv[0]), 'm-cheap'); assert.equal(swapped.last.tier, 'cheap');

  const bad = rev('reviewer:architecture', 'round1', ['--tier', 'nope']);
  assert.equal(bad.status, 1, 'unknown tier is a usage error, never a fallback');
  assert.match(bad.stderr, /unknown seat tier "nope"/);

  const log = join(fx.root, 'run.jsonl');
  const logged = rev('reviewer:performance', 'round1', ['--artifact', join(fx.art, 'perf-ledger')], { env: { RUN_LOG: log, SF_RUN_TASK: 'unit-task' } });
  assert.equal(logged.status, 0, logged.stderr);
  const spawn = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.stage === 'spawn');
  assert.equal(spawn.model, 'gpt-6.1-sol'); assert.equal(spawn.tier, 'standard'); assert.equal(spawn.effort, 'high');
  // 0.28.0: the row names the exact range the seat judged and how many codex launches it took.
  assert.equal(spawn.range, 'HEAD~1..HEAD'); assert.equal(spawn.attempts, 1);
});

test('home init carries the user\'s service_tier into the run home, and omits it when unset', () => {
  const fx = fixture();
  const userHome = join(fx.root, 'user-codex-2');
  mkdirSync(userHome);
  writeFileSync(join(userHome, 'auth.json'), '{"t":1}');
  writeFileSync(join(userHome, 'config.toml'), 'model = "gpt-test"\nmodel_reasoning_effort = "medium"\nservice_tier = "flex"\n');
  const env = { ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, CODEX_HOME: userHome, HOME: fx.root, FAKE_CODEX_ARGV: join(fx.root, 'argv.log'), FAKE_CODEX_PROMPTS: join(fx.root, 'p.log'), FAKE_CODEX_REPLY: join(fx.root, 'r.jsonl'), FAKE_SANDBOX_OK: '1' };
  writeFileSync(join(fx.root, 'r.jsonl'), '');
  const res = spawnSync(process.execPath, [SF_CODEX, 'home', 'init', '--run', 'unit-tier'], { encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  assert.match(readFileSync(join(res.stdout.trim(), 'config.toml'), 'utf8'), /model = "gpt-test"\nmodel_reasoning_effort = "medium"\nsandbox_mode = "read-only"\nservice_tier = "flex"\n/);
  writeFileSync(join(userHome, 'config.toml'), 'model = "gpt-test"\n');
  const res2 = spawnSync(process.execPath, [SF_CODEX, 'home', 'init', '--run', 'unit-tier-2'], { encoding: 'utf8', env });
  assert.equal(res2.status, 0, res2.stderr);
  assert.doesNotMatch(readFileSync(join(res2.stdout.trim(), 'config.toml'), 'utf8'), /service_tier/);
});

test('tier hardening: sidecar pins a resumed thread, usage errors never become fallbacks, TOML shapes, dry-run tier', () => {
  const fx = fixture();
  const rev = (role, template, extra = [], opts = {}) => run(fx, ['review', '--role', role, '--template', template, '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, `${role.replace(/[:/]/g, '_')}-${template}-${Math.random().toString(16).slice(2, 6)}`), '--round', '1', ...extra], { reply: [reviewReply()], ...opts });
  const modelOf = (argv) => (argv.includes('-m') ? argv[argv.indexOf('-m') + 1] : null);

  // cold standard seat writes a sidecar; the closure re-applies its model and reports it
  const arch = rev('reviewer:architecture', 'round1');
  assert.equal(arch.status, 0, arch.stderr);
  const side = JSON.parse(readFileSync(join(fx.root, 'home', 'sf-threads', `${arch.last.thread_id}.json`), 'utf8'));
  assert.equal(side.model, 'gpt-6.1-sol'); assert.equal(side.tier, 'standard');
  const closure = run(fx, ['review', '--role', 'reviewer:architecture', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'arch-c2'), '--round', '2', '--resume', arch.last.thread_id, '--findings-table', tableFile(fx)], { reply: [{ closures: [{ id: 'NX-1', verdict: 'CLOSED', file: 'a.ts', line: 1, reason: 'gone' }, { id: 'NX-2', verdict: 'CLOSED', file: 'a.ts', line: 9, reason: 'gone' }], new_fix_introduced: [], answer: '' }], env: { SF_CODEX_TIERS: '/nonexistent/tiers.json' } });
  assert.equal(closure.status, 0, closure.stderr);
  assert.equal(closure.argv[0][1], 'resume');
  assert.equal(modelOf(closure.argv[0]), 'gpt-6.1-sol', 'resume re-applies the sidecar model, and never reads the table');
  assert.equal(closure.last.model, 'gpt-6.1-sol'); assert.equal(closure.last.effort, 'high'); assert.equal(closure.last.tier, 'thread');
  // a thread with no sidecar reports what it is: unknown
  const orphan = run(fx, ['review', '--role', 'reviewer:architecture', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'orphan-c'), '--round', '2', '--resume', 'thread-orphan', '--findings-table', tableFile(fx)], { reply: [{ closures: [{ id: 'NX-1', verdict: 'CLOSED', file: 'a.ts', line: 1, reason: 'gone' }, { id: 'NX-2', verdict: 'CLOSED', file: 'a.ts', line: 9, reason: 'gone' }], new_fix_introduced: [], answer: '' }] });
  assert.equal(orphan.status, 0, orphan.stderr);
  assert.equal(modelOf(orphan.argv[0]), null); assert.equal(orphan.last.model, 'thread');

  // unreadable table: cold seat is a usage error with the path; a failed seat still carries its tier
  const missing = rev('reviewer:architecture', 'round1', [], { env: { SF_CODEX_TIERS: '/nonexistent/tiers.json' } });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /\/nonexistent\/tiers\.json/);
  const failed = rev('reviewer:architecture', 'round1', [], { exit: 1, error: 'boom' });
  assert.equal(failed.status, 2); assert.equal(failed.last.status, 'failed'); assert.equal(failed.last.tier, 'standard'); assert.equal(failed.last.model, 'gpt-6.1-sol');
  assert.equal(rev('reviewer:architecture', 'round1', ['--effort', 'turbo']).status, 1, 'effort outside the codex enum is a usage error');

  // panel: a bad --tier is rejected before fan-out; a good one applies to every seat; a seat with a
  // malformed call is usage-error (panel exit 1), never "failed"
  const roster = join(fx.root, 'route.json');
  writeFileSync(roster, JSON.stringify({ reviewers: { routed: ['frontend-reviewer'], baselines: ['architecture'] } }));
  const bad = run(fx, ['panel', '--roster', roster, '--tier', 'zzz', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact-dir', fx.art, '--round', '1', '--no-log'], { reply: [reviewReply()] });
  assert.equal(bad.status, 1); assert.equal(bad.argv.length, 0, 'no seat ran'); assert.match(bad.stderr, /unknown seat tier "zzz"/);
  const light = run(fx, ['panel', '--roster', roster, '--tier', 'standard-light', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact-dir', fx.art, '--round', '1', '--no-log'], { reply: [reviewReply()] });
  assert.equal(light.status, 0, light.stderr);
  assert.equal(light.argv.length, 2);
  for (const a of light.argv) { assert.equal(modelOf(a), 'gpt-6.1-sol'); assert.ok(a.includes('model_reasoning_effort="medium"')); }
  const bogus = run(fx, ['panel', '--seats', 'no-such-seat,architecture', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact-dir', fx.art, '--round', '1', '--no-log'], { reply: [reviewReply()] });
  assert.equal(bogus.status, 1, 'usage error in one seat → exit 1, not 2');
  assert.deepEqual(bogus.last.usage_errors, ['reviewer:no-such-seat']); assert.deepEqual(bogus.last.failed, []); assert.equal(bogus.last.delivered, 1);

  // dry-run reports the tier it would run
  const dry = rev('reviewer:test-coverage-guardian', 'round1', ['--dry-run']);
  assert.equal(dry.status, 0, dry.stderr); assert.equal(dry.last.tier, 'standard-light'); assert.equal(dry.last.model, 'gpt-6.1-sol');

  // TOML: single quotes read; table-scoped keys never promoted
  const userHome = join(fx.root, 'user-codex-3');
  mkdirSync(userHome);
  writeFileSync(join(userHome, 'auth.json'), '{"t":1}');
  writeFileSync(join(userHome, 'config.toml'), "model = 'gpt-q'\nmodel_reasoning_effort = 'low'\n[profiles.x]\nservice_tier = \"flex\"\n");
  const env = { ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, CODEX_HOME: userHome, HOME: fx.root, FAKE_CODEX_ARGV: join(fx.root, 'argv.log'), FAKE_CODEX_PROMPTS: join(fx.root, 'p.log'), FAKE_CODEX_REPLY: join(fx.root, 'r.jsonl'), FAKE_SANDBOX_OK: '1' };
  writeFileSync(join(fx.root, 'r.jsonl'), '');
  const res = spawnSync(process.execPath, [SF_CODEX, 'home', 'init', '--run', 'unit-toml'], { encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  const cfg = readFileSync(join(res.stdout.trim(), 'config.toml'), 'utf8');
  assert.match(cfg, /model = "gpt-q"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n/);
  assert.doesNotMatch(cfg, /service_tier/, 'a [profiles.x] value is not the top-level one');
});

test('hybrid seats: no Codex explore seat; implement/fix write under yolo, verify commits, and ledger plan gaps', () => {
  const fx = fixture();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repo, encoding: 'utf8' }).trim();
  const base = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: fx.repo, encoding: 'utf8' }).trim();
  const modelOf = (argv) => (argv.includes('-m') ? argv[argv.indexOf('-m') + 1] : null);
  // Explore has no Codex seat: the verb is gone and the template name is not a review template
  const ex = run(fx, ['explore', '--area', 'auth', '--brief', 'find the exports', '--cwd', fx.repo, '--artifact', join(fx.art, 'explore-auth')], { reply: [] });
  assert.equal(ex.status, 1); assert.match(ex.stderr, /unknown command "explore"/); assert.equal(ex.argv.length, 0, 'no seat ran');
  const exr = run(fx, ['review', '--role', 'explore', '--template', 'explore', '--cwd', fx.repo, '--artifact', join(fx.art, 'explore-r'), '--round', '1'], { reply: [] });
  assert.equal(exr.status, 1); assert.equal(exr.argv.length, 0, 'no seat ran');
  // --explore attaches the host's Claude Explore reports to the implementer prompt
  writeFileSync(join(fx.art, 'explore-auth.md'), '# Explore — auth\n');

  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1: bump a [task t1]\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const implReply = { commits: [{ sha: head.slice(0, 9), subject: 'two', task_id: 't1' }], acceptance: [{ id: 'AC1', status: 'PASS', how: 'npx vitest run a.test.ts → 1 passed' }], plan_gaps: [{ kind: 'semantic', what: 'return type unspecified', decision: 'kept number' }, { kind: 'cosmetic', what: 'line wrap', decision: 'prettier' }], declined: [], scope_violations: [], blockers: [], verify_first: [] };
  const log = join(fx.root, 'run.jsonl');
  const im = run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', base, '--batch', 'b1', '--cwd', fx.repo, '--artifact', join(fx.art, 'implement-b1'), '--explore', join(fx.art, 'explore-auth.md')], { reply: [implReply], env: { RUN_LOG: log, SF_RUN_TASK: 'unit-task' } });
  assert.equal(im.status, 0, im.stderr);
  assert.ok(im.argv[0].includes('--dangerously-bypass-approvals-and-sandbox'), 'yolo by default');
  assert.ok(!im.argv[0].includes('read-only'));
  assert.equal(im.last.write_sandbox, 'yolo'); assert.equal(im.last.role, 'implementer'); assert.equal(im.last.tier, 'writer');
  assert.equal(modelOf(im.argv[0]), 'gpt-6.1-sol');
  assert.ok(im.argv[0].includes('model_reasoning_effort="low"'), 'implementer runs Sol at low');
  assert.ok(im.argv[0].includes('service_tier="default"'), 'implementer runs the default service tier'); assert.equal(im.last.service_tier, 'default');
  assert.equal(im.last.commits, 1); assert.equal(im.last.plan_gaps_semantic, 1); assert.equal(im.last.plan_gaps_cosmetic, 1); assert.equal(im.last.files_changed, 1);
  assert.equal(im.last.seat, 'sf-implementer');
  const imMd = readFileSync(join(fx.art, 'implement-b1.md'), 'utf8');
  assert.match(imMd, /## Commits \(1 in the worktree, 1 reported\)/); assert.match(imMd, /\| AC1 \| \*\*PASS\*\*/); assert.match(imMd, /\*\*semantic\*\* — return type unspecified/);
  assert.match(im.prompts, /=== TASKS ===\nStep 1: bump a \[task t1\]\n=== END TASKS ===/); assert.match(im.prompts, /SOLE writer/); assert.match(im.prompts, /explore-auth\.md/);
  const spawn = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.stage === 'spawn');
  assert.equal(spawn.role, 'implementer'); assert.equal(spawn.phase, 'implement'); assert.equal(spawn.model, 'gpt-6.1-sol'); assert.equal(spawn.tier, 'writer'); assert.equal(spawn.effort, 'low'); assert.equal(spawn.service_tier, 'default');
  assert.equal(spawn.plan_gaps_semantic, 1); assert.equal(spawn.commits, 1);

  // a reported sha that is not in baseline..HEAD is a failed seat (report ≠ evidence)
  const bogus = run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'implement-bogus')], { reply: [{ ...implReply, commits: [{ sha: 'deadbeef1', subject: 'nope', task_id: null }] }] });
  assert.equal(bogus.status, 2); assert.equal(bogus.last.status, 'failed'); assert.match(bogus.last.detail, /not found in .*deadbeef1/);
  assert.ok(!existsSync(join(fx.art, 'implement-bogus.md')));
  // a sha outside the range (the baseline itself) also fails
  const outside = run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', head, '--cwd', fx.repo, '--artifact', join(fx.art, 'implement-out')], { reply: [implReply] });
  assert.equal(outside.status, 2);

  // workspace-write opt-in; bad mode is a usage error; missing --baseline is a usage error
  const ww = run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'implement-ww')], { reply: [implReply], env: { SF_CODEX_WRITE_SANDBOX: 'workspace-write' } });
  assert.equal(ww.status, 0, ww.stderr); assert.deepEqual(ww.argv[0].slice(ww.argv[0].indexOf('-s'), ww.argv[0].indexOf('-s') + 2), ['-s', 'workspace-write']); assert.equal(ww.last.write_sandbox, 'workspace-write');
  assert.equal(run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'x'), '--write-sandbox', 'danger'], { reply: [implReply] }).status, 1);
  assert.equal(run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--cwd', fx.repo, '--artifact', join(fx.art, 'x2')], { reply: [implReply] }).status, 1);

  // fix seat: reviewer-prompts §Fixer prompt with the findings substituted, role fixer, phase fix
  const findings = join(fx.root, 'findings.md'); writeFileSync(findings, '### a.ts\n- NX-1 (HIGH) a.ts:1 — revert the value\n');
  const fixReply = { ...implReply, plan_gaps: [], declined: [{ id: 'NX-2', evidence: 'dead code at a.ts:9' }] };
  const fxr = run(fx, ['fix', '--transport', 'exec', '--findings', findings, '--baseline', base, '--round', '2', '--cwd', fx.repo, '--artifact', join(fx.art, 'fix-r2')], { reply: [fixReply], env: { RUN_LOG: log, SF_RUN_TASK: 'unit-task' } });
  assert.equal(fxr.status, 0, fxr.stderr);
  assert.equal(fxr.last.role, 'fixer'); assert.equal(fxr.last.seat, 'sf-fixer'); assert.equal(fxr.last.declined, 1);
  assert.match(fxr.prompts, /NX-1 \(HIGH\) a\.ts:1/); assert.doesNotMatch(fxr.prompts, /<bucket-1 findings/); assert.doesNotMatch(fxr.prompts, /branch authorizations>/);
  assert.match(readFileSync(join(fx.art, 'fix-r2.md'), 'utf8'), /# Fix round 2[\s\S]*Declined findings[\s\S]*NX-2/);
  const events = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.stage === 'spawn' && e.role === 'fixer' && e.phase === 'fix').length, 1);
  assert.equal(fxr.last.tier, 'writer'); assert.equal(fxr.last.model, 'gpt-6.1-sol'); assert.equal(fxr.last.effort, 'low'); assert.equal(fxr.last.service_tier, 'default');
  assert.ok(fxr.argv[0].includes('service_tier="default"'), 'the fixer runs Sol at low on the default service tier');
  const mop = run(fx, ['fix', '--transport', 'exec', '--role', 'mopup-fixer', '--findings', findings, '--baseline', base, '--round', '3', '--cwd', fx.repo, '--artifact', join(fx.art, 'mopup')], { reply: [fixReply] });
  assert.equal(mop.status, 0, mop.stderr); assert.equal(mop.last.role, 'mopup-fixer'); assert.equal(mop.last.tier, 'writer'); assert.equal(mop.last.model, 'gpt-6.1-sol'); assert.equal(mop.last.effort, 'low'); assert.equal(mop.last.service_tier, 'default');
});

test('writer hardening: code-like content survives, baseline is validated and frozen, panel/verbs/resume guards, fail line carries git evidence', () => {
  const fx = fixture();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repo, encoding: 'utf8' }).trim();
  const base = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: fx.repo, encoding: 'utf8' }).trim();
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const implReply = { commits: [{ sha: head.slice(0, 9), subject: 'two', task_id: null }], acceptance: [], plan_gaps: [], declined: [], scope_violations: [], blockers: [], verify_first: [] };
  // `${id}` in a tasks file is code, not a placeholder; `$'` in a bucket lands literally
  const tasks = join(fx.root, 'tasks-code.txt'); writeFileSync(tasks, 'Step 1: render `${id}` and {unknown} literally\n');
  const im = run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'im-code')], { reply: [implReply] });
  assert.equal(im.status, 0, im.stderr); assert.match(im.prompts, /render `\$\{id\}` and \{unknown\} literally/);
  const findings = join(fx.root, 'findings-dollar.md'); writeFileSync(findings, "- NX-1 a.ts:1 — use `$'` and `$&` and $1 here\n");
  const fxr = run(fx, ['fix', '--transport', 'exec', '--findings', findings, '--baseline', base, '--round', '3', '--cwd', fx.repo, '--artifact', join(fx.art, 'fx-dollar')], { reply: [implReply] });
  assert.equal(fxr.status, 0, fxr.stderr);
  assert.match(fxr.prompts, /use `\$'` and `\$&` and \$1 here/); assert.match(fxr.prompts, /\[fix round 3 /); assert.doesNotMatch(fxr.prompts, /<N>/);
  // baseline: not a commit → usage error before any codex call; symbolic → frozen to the sha
  const bad = run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', 'not-a-sha', '--cwd', fx.repo, '--artifact', join(fx.art, 'im-bad')], { reply: [implReply] });
  assert.equal(bad.status, 1); assert.equal(bad.argv.length, 0); assert.match(bad.stderr, /not a commit/);
  const sym = run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', 'HEAD~1', '--cwd', fx.repo, '--artifact', join(fx.art, 'im-sym')], { reply: [implReply] });
  assert.equal(sym.status, 0, sym.stderr); assert.equal(sym.last.commits, 1); assert.match(readFileSync(join(fx.art, 'im-sym.md'), 'utf8'), new RegExp(`verified against \\\`${base}\\.\\.HEAD\\\``));
  // guards
  const roster = join(fx.root, 'r.json'); writeFileSync(roster, JSON.stringify({ roster: ['architecture', 'performance'] }));
  const pan = run(fx, ['panel', '--roster', roster, '--template', 'fix', '--cwd', fx.repo, '--artifact-dir', fx.art, '--round', '1', '--no-log'], { reply: [implReply] });
  assert.equal(pan.status, 1); assert.equal(pan.argv.length, 0); assert.match(pan.stderr, /review templates only/);
  const clash = run(fx, ['fix', '--transport', 'exec', '--template', 'round1', '--findings', findings, '--baseline', base, '--round', '1', '--cwd', fx.repo, '--artifact', join(fx.art, 'clash')], { reply: [implReply] });
  assert.equal(clash.status, 1); assert.match(clash.stderr, /conflicts with the verb/);
  const res = run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', base, '--resume', 'thread-x', '--cwd', fx.repo, '--artifact', join(fx.art, 'im-res')], { reply: [implReply] });
  assert.equal(res.status, 1); assert.match(res.stderr, /never resumes/);
  // fail line for a writer carries what it left behind (the fixture already has untracked docs/)
  const dirty0 = execFileSync('git', ['status', '--porcelain'], { cwd: fx.repo, encoding: 'utf8' }).split('\n').filter(Boolean).length;
  writeFileSync(join(fx.repo, 'stray.txt'), 'x');
  const mism = run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'im-mism')], { reply: [{ ...implReply, commits: [{ sha: 'deadbeef1', subject: 'nope', task_id: null }] }] });
  assert.equal(mism.status, 2); assert.equal(mism.last.commits_in_range, 1); assert.equal(mism.last.dirty, dirty0 + 1);
  const okDirty = run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'im-dirty')], { reply: [implReply] });
  assert.equal(okDirty.status, 0, okDirty.stderr); assert.equal(okDirty.last.dirty, dirty0 + 1);
  // dry-run shows the write sandbox
  const dry = run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'im-dry'), '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr); assert.equal(dry.last.write_sandbox, 'yolo');
});

test('schemas satisfy OpenAI strict structured outputs (every declared property is required); run home derives from RUN_LOG', () => {
  const { readdirSync } = require('node:fs');
  const dir = resolve(HERE, '..', '..', 'schemas');
  const violations = [];
  const walk = (n, p) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'object' && n.properties) {
      const req = new Set(n.required || []);
      for (const k of Object.keys(n.properties)) if (!req.has(k)) violations.push(`${p}.${k}`);
      if (n.additionalProperties !== false) violations.push(`${p}: additionalProperties must be false`);
    }
    for (const [k, v] of Object.entries(n)) if (v && typeof v === 'object') walk(v, `${p}.${k}`);
  };
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) walk(JSON.parse(readFileSync(join(dir, f), 'utf8')), f);
  assert.deepEqual(violations, [], 'the API rejects a schema whose object lists an optional property');

  // run home: RUN_LOG names the run; a seat without SF_CODEX_HOME must still find it
  const fx = fixture();
  mkdirSync(join(fx.root, '.cache', 'sf-codex', 'run-derived'), { recursive: true });
  writeFileSync(join(fx.root, '.cache', 'sf-codex', 'run-derived', 'config.toml'), 'model = "gpt-derived"\n');
  const log = join(fx.root, 'run-derived.jsonl'); writeFileSync(log, '');
  // --effort with no --model resolves to a null-model seat, so the reported model comes from the
  // run home codex derives from RUN_LOG (every table tier now pins a model of its own).
  const r = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'round1', '--effort', 'medium', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'derived'), '--round', '1', '--no-log'], { reply: [reviewReply()], env: { SF_CODEX_HOME: '', HOME: fx.root, RUN_LOG: log } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.last.model, 'gpt-derived', 'a null-model seat reports the derived run home\'s model');
  assert.ok(existsSync(join(fx.root, '.cache', 'sf-codex', 'run-derived', 'sf-threads', `${r.last.thread_id}.json`)), 'sidecar lands in the derived home');
});

test('a resumed closure re-asserts read-only via -c (resume takes no -s; the config default would be workspace-write)', () => {
  const fx = fixture();
  const r1 = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'p1'), '--round', '1'], { reply: [reviewReply()] });
  assert.equal(r1.status, 0, r1.stderr);
  const r2 = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'p1-closure'), '--round', '2', '--resume', r1.last.thread_id, '--findings-table', tableFile(fx)], { reply: [{ closures: [{ id: 'NX-1', verdict: 'CLOSED', file: 'a.ts', line: 1, reason: 'gone' }, { id: 'NX-2', verdict: 'CLOSED', file: 'a.ts', line: 9, reason: 'gone' }], new_fix_introduced: [], answer: '' }] });
  assert.equal(r2.status, 0, r2.stderr);
  const argv = r2.argv[0];
  assert.equal(argv[1], 'resume');
  assert.ok(!argv.includes('-s'), 'resume cannot take -s');
  assert.ok(argv.includes('sandbox_mode="read-only"'), 'read-only re-asserted through -c');
  assert.ok(!argv.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('fix direction: --direction substitutes the binding block, absence keeps the hypotheses default, ledger records it', () => {
  const fx = fixture();
  const base = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: fx.repo, encoding: 'utf8' }).trim();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repo, encoding: 'utf8' }).trim();
  const reply = { commits: [{ sha: head.slice(0, 9), subject: 'two', task_id: null }], acceptance: [], plan_gaps: [], declined: [], scope_violations: [], blockers: [], verify_first: [] };
  const findings = join(fx.root, 'f.md'); writeFileSync(findings, '- NX-1 a.ts:1 — fix it\n');
  const direction = join(fx.root, 'dir.md'); writeFileSync(direction, 'NX-1: approach=patch in place. verify_first: enumerate stored shapes incl. `$null` rows.');
  const log = join(fx.root, 'run.jsonl');
  const withDir = run(fx, ['fix', '--transport', 'exec', '--findings', findings, '--direction', direction, '--merged-items', '2', '--epic-phase', 'P2', '--baseline', base, '--round', '2', '--cwd', fx.repo, '--artifact', join(fx.art, 'fx-dir')], { reply: [reply], env: { RUN_LOG: log, SF_RUN_TASK: 'unit-task' } });
  assert.equal(withDir.status, 0, withDir.stderr);
  assert.match(withDir.prompts, /=== FIX DIRECTION \(binding\) ===\nNX-1: approach=patch in place\. verify_first: enumerate stored shapes incl\. `\$null` rows\.\n=== END FIX DIRECTION ===/);
  assert.match(withDir.prompts, /Never change repo-wide configuration/);
  const withoutDir = run(fx, ['fix', '--transport', 'exec', '--findings', findings, '--baseline', base, '--round', '3', '--cwd', fx.repo, '--artifact', join(fx.art, 'fx-nodir')], { reply: [reply] });
  assert.equal(withoutDir.status, 0, withoutDir.stderr);
  assert.match(withoutDir.prompts, /\(none provided — no binding direction this round/);
  assert.doesNotMatch(withoutDir.prompts, /<fix direction>/);
  // A fixer run with no --merged-items / --epic-phase carries neither key on its spawn row.
  const noMerge = run(fx, ['fix', '--transport', 'exec', '--findings', findings, '--direction', direction, '--baseline', base, '--round', '4', '--cwd', fx.repo, '--artifact', join(fx.art, 'fx-nomerge')], { reply: [reply], env: { RUN_LOG: log, SF_RUN_TASK: 'unit-task' } });
  assert.equal(noMerge.status, 0, noMerge.stderr);
  const events = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const withDirEv = events.find((e) => e.stage === 'spawn' && e.role === 'fixer' && String(e.artifact).includes('fx-dir'));
  assert.equal(withDirEv.direction, true);
  assert.equal(withDirEv.merged_items, 2);
  assert.equal(withDirEv.epic_phase, 'P2');
  const noMergeEv = events.find((e) => e.stage === 'spawn' && e.role === 'fixer' && String(e.artifact).includes('fx-nomerge'));
  assert.equal(noMergeEv.direction, true);
  assert.equal(noMergeEv.merged_items, undefined);
  assert.equal(noMergeEv.epic_phase, undefined);

  // A malformed --merged-items is refused before a seat runs: no codex invocation, no ledger row.
  const badMerge = run(fx, ['fix', '--transport', 'exec', '--findings', findings, '--direction', direction, '--merged-items', 'abc', '--baseline', base, '--round', '5', '--cwd', fx.repo, '--artifact', join(fx.art, 'fx-bad')], { reply: [reply], env: { RUN_LOG: log, SF_RUN_TASK: 'unit-task' } });
  assert.notEqual(badMerge.status, 0, 'malformed --merged-items exits non-zero');
  assert.equal(badMerge.argv.length, 0, 'no codex seat spawned');
  assert.match(badMerge.stderr, /merged-items must be a non-negative integer/);

  // A leading-zero count (007) is refused before a seat runs too: sf-log parses merged_items as
  // a JSON number where a leading zero is invalid, so it would arrive as a string and its ledger
  // row be silently refused after the seat already ran.
  const zeroMerge = run(fx, ['fix', '--transport', 'exec', '--findings', findings, '--direction', direction, '--merged-items', '007', '--baseline', base, '--round', '6', '--cwd', fx.repo, '--artifact', join(fx.art, 'fx-zero')], { reply: [reply], env: { RUN_LOG: log, SF_RUN_TASK: 'unit-task' } });
  assert.notEqual(zeroMerge.status, 0, 'leading-zero --merged-items exits non-zero');
  assert.equal(zeroMerge.argv.length, 0, 'no codex seat spawned');
  assert.match(zeroMerge.stderr, /merged-items must be a non-negative integer/);

  // --finding-ids rides the fix seat's spawn row as findings= (sf-log's oscillation guard reads it);
  // a scalar is refused before any seat runs.
  const withIds = run(fx, ['fix', '--transport', 'exec', '--findings', findings, '--direction', direction, '--finding-ids', '["U1","U4"]', '--baseline', base, '--round', '7', '--cwd', fx.repo, '--artifact', join(fx.art, 'fx-ids')], { reply: [reply], env: { RUN_LOG: log, SF_RUN_TASK: 'unit-task' } });
  assert.equal(withIds.status, 0, withIds.stderr);
  const withIdsEv = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.stage === 'spawn' && e.role === 'fixer' && String(e.artifact).includes('fx-ids'));
  assert.deepEqual(withIdsEv.findings, ['U1', 'U4']);
  const badIds = run(fx, ['fix', '--transport', 'exec', '--findings', findings, '--direction', direction, '--finding-ids', 'U1', '--baseline', base, '--round', '8', '--cwd', fx.repo, '--artifact', join(fx.art, 'fx-badids')], { reply: [reply], env: { RUN_LOG: log, SF_RUN_TASK: 'unit-task' } });
  assert.notEqual(badIds.status, 0, 'scalar --finding-ids exits non-zero');
  assert.equal(badIds.argv.length, 0, 'no codex seat spawned');
  assert.match(badIds.stderr, /finding-ids must be a JSON array of non-empty strings/);
});

test('0.26.0: placeholder scan ignores JSX braces inside the findings bucket; a wrapped findings table is accepted', () => {
  const fx = fixture();
  const base = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: fx.repo, encoding: 'utf8' }).trim();
  // Reviewer excerpts carry `{false}` / `{n}` / `{domain}` — the placeholder scan must not trip on them.
  const findings = join(fx.root, 'findings-jsx.md');
  writeFileSync(findings, '### a.tsx\n- UX-1 (HIGH) a.tsx:1 — renders `{false}` then `{n}` items for `{domain}`\n');
  const dry = run(fx, ['fix', '--transport', 'exec', '--findings', findings, '--baseline', base, '--round', '1', '--cwd', fx.repo, '--artifact', join(fx.art, 'fix-jsx'), '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr); assert.equal(dry.last.status, 'dry-run');
  const prompt = readFileSync(join(fx.art, 'fix-jsx.prompt.md'), 'utf8');
  assert.match(prompt, /renders `\{false\}` then `\{n\}` items for `\{domain\}`/, 'the bucket text lands verbatim');
  assert.doesNotMatch(prompt, /\{change_ref\}|<worktree contract>/, 'real template placeholders are still filled');
  // closure: `{"findings":[...]}` (the shape four seats died on) resolves to the array
  const wrapped = join(fx.root, 'ft-wrapped.json');
  writeFileSync(wrapped, JSON.stringify({ findings: [{ id: 'NX-1', summary: 'stale prop', status: 'fixed', commits: 'abc' }] }));
  const cl = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'ncw'), '--round', '1', '--resume', 'thread-abc', '--findings-table', wrapped, '--dry-run']);
  assert.equal(cl.status, 0, cl.stderr);
  assert.match(readFileSync(join(fx.art, 'ncw.prompt.md'), 'utf8'), /NX-1 — stale prop — claimed fixed by abc/);
  const empty = join(fx.root, 'ft-empty.json'); writeFileSync(empty, JSON.stringify({ other: [] }));
  assert.equal(run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'nce'), '--round', '1', '--resume', 'thread-abc', '--findings-table', empty, '--dry-run']).status, 1, 'a wrapper without an array is still a usage error');
});

test('0.26.0: verify_first probes render, and a direction that asked for probes the report lacks is flagged', () => {
  const fx = fixture();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repo, encoding: 'utf8' }).trim();
  const base = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: fx.repo, encoding: 'utf8' }).trim();
  const findings = join(fx.root, 'findings.md'); writeFileSync(findings, '### a.ts\n- SEC-4 (HIGH) a.ts:1 — mark unsignable keys terminal\n- UX-2 (MEDIUM) a.ts:1 — refresh cadence\n');
  const direction = join(fx.root, 'dir.md');
  writeFileSync(direction, '# Fix direction\n\n## SEC-4 — terminal classification\n- approach: classify by key shape\n- verify_first: enumerate every production write path of the proxy signal\n\n## UX-2 — cadence\n- approach: widen the skew\n- verify_first: state the interlock inequality\n');
  const base_reply = { commits: [{ sha: head.slice(0, 9), subject: 'two', task_id: null }], acceptance: [], plan_gaps: [], declined: [], scope_violations: [], blockers: [] };
  // probes present for one of the two asked → the other is flagged, on the result line and in the .md
  const partial = { ...base_reply, verify_first: [{ id: 'SEC-4', probe: 'rg "INSERT INTO order_holds" apps/web/src', outcome: '0 production writers', contradicts_approach: true }] };
  const r = run(fx, ['fix', '--transport', 'exec', '--findings', findings, '--direction', direction, '--baseline', base, '--round', '1', '--cwd', fx.repo, '--artifact', join(fx.art, 'fix-vf')], { reply: [partial] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.last.verify_first_probes, 1); assert.equal(r.last.verify_first_missing, 1);
  const md = readFileSync(join(fx.art, 'fix-vf.md'), 'utf8');
  assert.match(md, /## verify_first probes[\s\S]*\| SEC-4 \|[\s\S]*\*\*yes\*\*/);
  assert.match(md, /verify_first probes missing[\s\S]*UX-2/);
  const json = JSON.parse(readFileSync(join(fx.art, 'fix-vf.json'), 'utf8'));
  assert.deepEqual(json.verify_first_missing, ['UX-2']);
  assert.equal(json._seat.role, 'fixer'); assert.equal(json._seat.status, 'ok'); assert.equal(typeof json._seat.wall_ms, 'number'); assert.equal(json._seat.tokens_in, 100);
  // no direction → nothing asked → nothing missing; a reply without the key at all is a schema miss (retry path), so replies carry []
  const r2 = run(fx, ['fix', '--transport', 'exec', '--findings', findings, '--baseline', base, '--round', '2', '--cwd', fx.repo, '--artifact', join(fx.art, 'fix-nd')], { reply: [{ ...base_reply, verify_first: [] }] });
  assert.equal(r2.status, 0, r2.stderr); assert.equal(r2.last.verify_first_missing, 0); assert.equal(r2.last.verify_first_probes, 0);
});

test('0.26.0: seat-guard Stop hook blocks while a sf-codex seat is alive, allows otherwise, honours stop_hook_active', async () => {
  const hook = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'seat-guard.py');
  const runHook = (stdin, env = {}) => spawnSync('python3', [hook], { input: stdin, encoding: 'utf8', env: { ...process.env, ...env } });
  const quiet = runHook('{}');
  assert.equal(quiet.status, 0); assert.equal(quiet.stdout.trim(), '', 'no seat → silent allow');
  if (!existsSync('/proc/self/environ')) return; // env inspection is /proc-based on Linux; the ps path is not unit-tested
  const home = mkdtempSync(join(tmpdir(), 'sf-codex-guard-'));
  const runHome = join(home, '.cache', 'sf-codex', 'ship-task-unit'); mkdirSync(runHome, { recursive: true });
  const asRunHome = join(home, '.cache', 'sf-codex', 'ship-task-as'); mkdirSync(asRunHome, { recursive: true });
  // a process whose argv[0] is "codex exec" (reviewer) or "codex app-server" (writer) and whose
  // CODEX_HOME is a run home — what a live seat looks like to pgrep + /proc
  const { spawn } = await import('node:child_process');
  const seat = spawn('bash', ['-c', 'exec -a "codex exec" sleep 20'], { env: { ...process.env, CODEX_HOME: runHome }, stdio: 'ignore' });
  const asSeat = spawn('bash', ['-c', 'exec -a "codex app-server" sleep 20'], { env: { ...process.env, CODEX_HOME: asRunHome }, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const blocked = runHook('{"stop_hook_active": false}');
    assert.equal(blocked.status, 0, blocked.stderr);
    const out = JSON.parse(blocked.stdout);
    assert.equal(out.decision, 'block'); assert.match(out.reason, /ship-task-unit/); assert.match(out.reason, /run_in_background/);
    // the writer transport (codex app-server) is matched by the same pgrep alternation as codex exec
    assert.match(out.reason, /ship-task-as/);
    const again = runHook('{"stop_hook_active": true}');
    assert.equal(again.stdout.trim(), '', 'a second Stop in the same turn is never blocked (no loops)');
    const off = runHook('{}', { SF_SEAT_GUARD: 'off' });
    assert.equal(off.stdout.trim(), '', 'SF_SEAT_GUARD=off disables');
    // with the exec seat gone, the app-server writer seat alone still blocks — proving the block
    // keys on the alternation, not on the literal "codex exec"
    seat.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    const asOnly = runHook('{"stop_hook_active": false}');
    assert.equal(asOnly.status, 0, asOnly.stderr);
    const asOut = JSON.parse(asOnly.stdout);
    assert.equal(asOut.decision, 'block'); assert.match(asOut.reason, /ship-task-as/);
  } finally { seat.kill('SIGKILL'); asSeat.kill('SIGKILL'); }
});

// =============================================================================
// 0.30.0 — writer seats over the codex app-server transport (fake-app-server.cjs)
// Timers scale via fractional minutes with margins that survive host contention:
// idle ≥ 500 ms (--idle-min 0.01 = 600 ms), steer ≥ 1 s, wall ≥ 2.5 s
// (--timeout-min 0.05 = 3 s, --wrapup-min 0.03 → steer at 1.2 s). Assertions use slack.
// =============================================================================
const heads = (fx) => ({
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repo, encoding: 'utf8' }).trim(),
  base: execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: fx.repo, encoding: 'utf8' }).trim(),
});
const implReportFor = (sha) => ({ commits: [{ sha: sha.slice(0, 9), subject: 'two', task_id: null }], acceptance: [], plan_gaps: [], declined: [], scope_violations: [], blockers: [], verify_first: [] });
const asReqs = (rpc, method) => rpc.filter((e) => e.method === method);

test('app-server happy: implement + fix deliver over app-server, usage replaced not summed, spawn event tagged', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1: bump a [task t1]\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const log = join(fx.root, 'run.jsonl');
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-impl'), '--timeout-min', '1', '--idle-min', '1', '--wrapup-min', '0.5'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'happy', RUN_LOG: log, SF_RUN_TASK: 'unit-task' } });
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  assert.equal(im.last.transport, 'app-server');
  assert.equal(im.last.status, 'ok');
  assert.equal(im.last.outcome, 'ok');
  assert.equal(im.last.compactions, 0);
  assert.equal(im.last.oversized, false);
  assert.equal(im.last.tokens, 220, 'last cumulative total, not the sum of both tokenUsage events');
  assert.ok(Number.isInteger(im.last.idle_max_ms));
  assert.equal(im.last.commits, 1);
  assert.ok(existsSync(join(fx.art, 'as-impl.md')), 'artifact rendered');
  // wire shape: thread/start + the work turn/start params
  const ts = asReqs(im.rpc, 'thread/start')[0];
  assert.equal(ts.params.sandbox, 'danger-full-access');
  assert.equal(ts.params.approvalPolicy, 'never');
  const turn = asReqs(im.rpc, 'turn/start')[0];
  assert.equal(turn.params.cwd, fx.repo);
  assert.equal(turn.params.model, 'gpt-6.1-sol');
  assert.equal(turn.params.effort, 'low');
  assert.equal(turn.params.serviceTier, 'default');
  assert.equal(turn.params.sandboxPolicy.type, 'dangerFullAccess');
  assert.ok(turn.params.outputSchema && typeof turn.params.outputSchema === 'object');
  // spawn event
  const spawn = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.stage === 'spawn');
  assert.equal(spawn.transport, 'app-server');
  assert.equal(spawn.agent_type, 'codex-app-server');
  assert.equal(spawn.compactions, 0);
  assert.equal(spawn.outcome, 'ok');

  // fix seat also rides app-server
  const findings = join(fx.root, 'findings.md'); writeFileSync(findings, '### a.ts\n- NX-1 (HIGH) a.ts:1 — revert\n');
  const fxr = run(fx, ['fix', '--findings', findings, '--baseline', base, '--round', '2', '--cwd', fx.repo, '--artifact', join(fx.art, 'as-fix')], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'happy' } });
  assert.equal(fxr.status, 0, fxr.stderr);
  assert.equal(fxr.last.transport, 'app-server');
  assert.equal(fxr.last.status, 'ok');

  // workspace-write: thread sandbox + policy carry the worktree as the writable root
  const ww = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-ww'), '--timeout-min', '1'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'happy', SF_CODEX_WRITE_SANDBOX: 'workspace-write' } });
  assert.equal(ww.status, 0, ww.stderr);
  assert.equal(asReqs(ww.rpc, 'thread/start')[0].params.sandbox, 'workspace-write');
  const wturn = asReqs(ww.rpc, 'turn/start')[0];
  assert.equal(wturn.params.sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(wturn.params.sandboxPolicy.writableRoots, [fx.repo]);
});

test('app-server compaction counter: thread/compacted increments; >1 is oversized on the line and the spawn event', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const log = join(fx.root, 'run.jsonl');
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-cmp'), '--timeout-min', '1'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'happy', FAKE_AS_COMPACTIONS: '2', RUN_LOG: log, SF_RUN_TASK: 't' } });
  assert.equal(im.status, 0, im.stderr);
  assert.equal(im.last.compactions, 2);
  assert.equal(im.last.oversized, true);
  const spawn = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.stage === 'spawn');
  assert.equal(spawn.compactions, 2);
  assert.equal(spawn.oversized, true);
});

test('app-server idle timeout: a hung turn is interrupted and a report turn on the same thread delivers', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-idle'), '--timeout-min', '1', '--idle-min', '0.01', '--report-min', '1'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'hang' } });
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  assert.equal(im.last.status, 'interrupted-reported');
  assert.equal(im.last.interrupt_sent, true);
  assert.equal(asReqs(im.rpc, 'turn/interrupt').length, 1, 'exactly one interrupt');
  const starts = asReqs(im.rpc, 'turn/start');
  assert.equal(starts.length, 2, 'work turn + report turn');
  assert.equal(starts[0].params.threadId, starts[1].params.threadId, 'report turn reuses the thread');
  // SEC-M1: the work turn keeps the writer sandbox; the report turn drops to read-only.
  assert.equal(starts[0].params.sandboxPolicy.type, 'dangerFullAccess', 'work turn keeps the writer sandbox');
  assert.equal(starts[1].params.sandboxPolicy.type, 'readOnly', 'report turn runs read-only');
  assert.match(im.prompts, /interrupted by the orchestrator \(idle/);
  assert.ok(im.last.commands_ok >= 1, 'stray + report-turn commands counted');
  assert.ok(existsSync(join(fx.art, 'as-idle.md')));

  // variant: one successful command before the hang → same status
  const im2 = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-idle2'), '--timeout-min', '1', '--idle-min', '0.01', '--report-min', '1'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'hang', FAKE_AS_HANG_AFTER_CMD: '1' } });
  assert.equal(im2.last.status, 'interrupted-reported');
});

test('app-server wrap-up steer: a seat still working at wall − wrapup is steered and finishes as wrapped-up', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const t0 = Date.now();
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-steer'), '--timeout-min', '0.05', '--wrapup-min', '0.03', '--idle-min', '0.5'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'slow-then-steer' } });
  const wall = Date.now() - t0;
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  assert.equal(im.last.status, 'wrapped-up');
  assert.equal(im.last.steer_sent, true);
  const steers = asReqs(im.rpc, 'turn/steer');
  assert.equal(steers.length, 1, 'exactly one steer');
  assert.equal(steers[0].params.expectedTurnId, 'turn-1');
  assert.equal(asReqs(im.rpc, 'turn/interrupt').length, 0, 'no interrupt — the seat wrapped up on its own');
  assert.ok(im.last.wall_ms < 3000 - 500, `wrapped up before the wall budget (${im.last.wall_ms}ms)`);
  assert.ok(wall < 3000, `process returned before the wall (${wall}ms)`);
});

test('app-server stale steer is a benign race, not a crash', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-stale-steer'), '--timeout-min', '0.05', '--wrapup-min', '0.03', '--idle-min', '0.5'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'steer-then-stale' } });
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  assert.equal(im.last.status, 'wrapped-up');
  assert.equal(asReqs(im.rpc, 'turn/steer').length, 1);
  assert.equal(asReqs(im.rpc, 'turn/interrupt').length, 0);
  assert.ok(!im.last.crashed, 'a -32600 steer race is not a crash');
  assert.ok(existsSync(join(fx.art, 'as-stale-steer.md')));
});

test('app-server stale interrupt is a benign race; the naturally-completed turn delivers with no report turn', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-stale-int'), '--timeout-min', '0.05', '--wrapup-min', '0.03', '--idle-min', '0.5'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'interrupt-then-stale' } });
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  assert.equal(im.last.status, 'wrapped-up');
  assert.equal(asReqs(im.rpc, 'turn/steer').length, 1);
  assert.equal(asReqs(im.rpc, 'turn/interrupt').length, 1);
  assert.equal(asReqs(im.rpc, 'turn/start').length, 1, 'no report turn — the turn completed');
});

test('app-server budget interrupt then report; git stays authoritative over the report', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-budget'), '--timeout-min', '0.05', '--wrapup-min', '0.03', '--idle-min', '0.5', '--report-min', '1'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'busy-forever' } });
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  assert.equal(im.last.status, 'interrupted-reported');
  assert.ok(asReqs(im.rpc, 'turn/steer').length >= 1);
  assert.equal(asReqs(im.rpc, 'turn/interrupt').length, 1);
  const starts = asReqs(im.rpc, 'turn/start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].params.threadId, starts[1].params.threadId);
  assert.equal(im.last.commits, 1);
  // a report naming a bogus sha fails the seat regardless of the delivered outcome
  const bogus = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-budget-bogus'), '--timeout-min', '0.05', '--wrapup-min', '0.03', '--idle-min', '0.5', '--report-min', '1'], { reply: [{ ...implReportFor(head), commits: [{ sha: 'deadbeef1', subject: 'nope', task_id: null }] }], env: { FAKE_AS_SCENARIO: 'busy-forever' } });
  assert.equal(bogus.status, 2);
  assert.match(bogus.last.detail, /not found in .*deadbeef1/);
});

test('app-server crash: process exit mid-turn → failed/crashed, detected at once, usage recovered from rollout', () => {
  const fx = fixture();
  const { base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  // app-server writes the same rollout name shape as exec (protocol-notes.md §Probe 3); seed one for t-as-1.
  const sess = join(fx.root, 'home', 'sessions', '2026', '09', '09');
  mkdirSync(sess, { recursive: true });
  const tc = (i, c, o, r) => JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: i, cached_input_tokens: c, output_tokens: o, reasoning_output_tokens: r } } } });
  writeFileSync(join(sess, 'rollout-2026-09-09T00-00-00-t-as-1.jsonl'), [JSON.stringify({ type: 'session_meta', payload: { id: 't-as-1' } }), tc(5000, 4000, 200, 100)].join('\n'));
  const log = join(fx.root, 'run.jsonl'); writeFileSync(log, '');
  const t0 = Date.now();
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-crash'), '--timeout-min', '5'], { reply: [], env: { FAKE_AS_SCENARIO: 'crash', RUN_LOG: log, SF_RUN_TASK: 't' } });
  const wall = Date.now() - t0;
  assert.equal(im.status, 2);
  assert.equal(im.last.status, 'failed');
  assert.equal(im.last.crashed, true);
  assert.ok(wall < 5000, `the exit is detected at once (${wall}ms), not at the wall`);
  assert.equal(im.last.transport, 'app-server');
  assert.equal(typeof im.last.commits_in_range, 'number');
  assert.equal(typeof im.last.dirty, 'number');
  assert.equal(im.last.usage_source, 'rollout');
  assert.equal(im.last.tokens_in, 5000);
});

test('app-server rate limit: a 429 on the first thread retries on a fresh thread; usage sums both', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const log = join(fx.root, 'run.jsonl'); writeFileSync(log, '');
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-429'), '--timeout-min', '1'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'happy', FAKE_AS_RATE_LIMIT: '1', RUN_LOG: log, SF_RUN_TASK: 't' } });
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  assert.equal(im.last.status, 'ok');
  assert.equal(im.last.tokens, 330, 'sum of both sessions\' last cumulative totals (in+out: 300+30)');
  assert.equal(asReqs(im.rpc, 'thread/start').length, 2, 'two threads — a fresh one after the retry');
  const spawn = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.stage === 'spawn');
  assert.equal(spawn.attempts, 2, 'work turn + retry turn');
});

test('app-server rate limit that still completes is NOT retried — a delivered seat is kept (ARCH-M1)', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  // A 429 error notification arrives, then the turn completes with commits. The old gate keyed
  // on the rateLimited flag alone and relaunched, discarding the delivered seat; the fixed gate
  // requires outcome==='failed', so a delivered seat is kept.
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-429ok'), '--timeout-min', '1', '--idle-min', '1'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'rate-limit-then-complete' } });
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  assert.equal(im.last.status, 'ok');
  assert.equal(asReqs(im.rpc, 'thread/start').length, 1, 'exactly one thread — the delivered seat is not discarded');
  assert.equal(im.last.commits, 1);
});

test('app-server interrupted-reported seat that ran no command is not blind — git is the evidence (ARCH-L2)', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  // Work turn hangs with no completed command → idle interrupt; the report turn answers from
  // context with no git command, so derived stats.ok === 0. git already verified the commit, so
  // the seat delivers as interrupted-reported rather than being reclassified blind.
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-quiet'), '--timeout-min', '1', '--idle-min', '0.01', '--report-min', '1'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'hang-quiet-report' } });
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  assert.equal(im.last.status, 'interrupted-reported');
  assert.equal(im.last.commands_ok, 0, 'no successful command');
  assert.equal(im.last.commits, 1, 'git is the evidence');
  assert.match(im.stderr, /git is the evidence.*not blind/);
  assert.ok(existsSync(join(fx.art, 'as-quiet.md')));
});

test('app-server server-request auto-reject: an approval request is rejected so the turn cannot hang', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-srv'), '--timeout-min', '1', '--idle-min', '1'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'server-request' } });
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  assert.equal(im.last.status, 'ok');
  assert.match(im.stderr, /requested item\/commandExecution\/requestApproval; rejecting/);
});

test('app-server schema re-ask runs one more turn on the same thread; usage not doubled', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const log = join(fx.root, 'run.jsonl'); writeFileSync(log, '');
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-reask'), '--timeout-min', '1', '--idle-min', '1'], { reply: ['not json', JSON.stringify(implReportFor(head))], env: { FAKE_AS_SCENARIO: 'happy', RUN_LOG: log, SF_RUN_TASK: 't' } });
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  const starts = asReqs(im.rpc, 'turn/start');
  assert.equal(starts.length, 2, 'work turn + one schema re-ask');
  assert.equal(starts[0].params.threadId, starts[1].params.threadId);
  const spawn = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.stage === 'spawn');
  assert.equal(spawn.attempts, 2);
  assert.equal(im.last.tokens, 220, 'last cumulative total, not 2×');
  assert.equal(im.last.commands_run, 2, 'command items across both turns');
});

test('app-server transport guards: reviewer cannot opt in, writer --transport exec keeps the exec path, reviewer line is exec, wrapup≥wall still delivers', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  // a reviewer may not run app-server
  const rev = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'g1'), '--round', '1', '--transport', 'app-server'], { reply: [reviewReply()] });
  assert.equal(rev.status, 1);
  assert.match(rev.stderr, /app-server is for writer seats only/);
  // reviewer result line carries transport:"exec"
  const ok = run(fx, ['review', '--role', 'reviewer:performance', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'g2'), '--round', '1'], { reply: [reviewReply()] });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.last.transport, 'exec');
  // writer --transport exec uses the exec argv (the classic yolo path)
  const ex = run(fx, ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'g3')], { reply: [implReportFor(head)] });
  assert.equal(ex.status, 0, ex.stderr);
  assert.equal(ex.last.transport, 'exec');
  assert.equal(ex.argv[0][0], 'exec');
  assert.ok(ex.argv[0].includes('--dangerously-bypass-approvals-and-sandbox'));
  // --wrapup-min ≥ --timeout-min: no steer fires, a warn on stderr, the seat still delivers
  const noSteer = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'g4'), '--timeout-min', '0.5', '--wrapup-min', '5'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'happy' } });
  assert.equal(noSteer.status, 0, noSteer.stderr);
  assert.equal(noSteer.last.status, 'ok');
  assert.equal(asReqs(noSteer.rpc, 'turn/steer').length, 0);
  assert.match(noSteer.stderr, /no wrap-up steer will fire/);
});

// 0.30.0 mop-up — round-1 hardening branches that shipped without dedicated coverage
// (review-security-cold-r1.md LOW L1): SEC-L1 thread-id validation, SEC-L2 stdout buffer drop +
// output cap, ARCH-L1 report-turn crash flag.
test('app-server rejects an unsafe thread id as a filename — no sidecar escapes sf-threads (SEC-L1)', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  // thread/start returns a traversal id. safeThreadId must reject it so sidecarPath writes nothing
  // (the escape target never appears) and sf-codex warns; the seat still delivers.
  const home = join(fx.root, 'home');
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-evilid'), '--timeout-min', '1', '--idle-min', '1'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'happy', FAKE_AS_THREAD_ID: '../evil' } });
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  assert.equal(im.last.status, 'ok', 'the seat still delivers');
  assert.match(im.stderr, /refusing thread id as a filename/);
  assert.ok(!existsSync(join(home, 'evil.json')), 'no sidecar escaped sf-threads/');
  assert.ok(!existsSync(join(home, 'sf-threads')), 'the refused id created no sf-threads entry');
});

test('app-server report turn crash: crashed flag set and the detail names the report turn (ARCH-L1)', () => {
  const fx = fixture();
  const { base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  // Work turn hangs → idle interrupt → the report turn runs, then the app-server exits mid-report.
  // The else-branch must record crashed:true with a report-turn detail, not the default false.
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-repcrash'), '--timeout-min', '1', '--idle-min', '0.01', '--report-min', '1'], { reply: [], env: { FAKE_AS_SCENARIO: 'hang-then-crash-report' } });
  assert.equal(im.status, 2);
  assert.equal(im.last.status, 'failed');
  assert.equal(im.last.crashed, true, 'a crash during the report turn is crashed, not the default false');
  assert.match(im.last.detail, /report turn/);
  assert.equal(im.last.transport, 'app-server');
});

test('app-server stdout buffer: a >8 MiB no-newline line is dropped and the seat resyncs (SEC-L2)', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  // The fake prepends 9 MiB of newline-free junk to the work turn's frames; the buffer ceiling must
  // drop it and resync on the terminating newline so the real frames still parse.
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-bigline'), '--timeout-min', '1', '--idle-min', '1'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'happy', FAKE_AS_GIANT_NOLINE: String(9 * 1024 * 1024) } });
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  assert.equal(im.last.status, 'ok', 'the seat resynced and delivered after the drop');
  assert.match(im.stderr, /exceeded the buffer ceiling; dropping \d+ bytes and resyncing/);
  assert.equal(im.last.commits, 1);
});

test('app-server caps a huge command output and still delivers — capAggregatedOutput (SEC-L2)', () => {
  const fx = fixture();
  const { head, base } = heads(fx);
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  // The work turn's command emits 64 KiB of aggregatedOutput; capAggregatedOutput keeps only a
  // 4096-char head on ingest. The cap is internal — its sole consumer (commandStats.first_failure)
  // is not emitted on the app-server path — so the observable contract is: the seat still delivers.
  const im = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'as-bigcmd'), '--timeout-min', '1', '--idle-min', '1'], { reply: [implReportFor(head)], env: { FAKE_AS_SCENARIO: 'happy', FAKE_AS_GIANT_CMD_OUT: String(64 * 1024) } });
  assert.equal(im.status, 0, im.stderr + '\n' + im.stdout);
  assert.equal(im.last.status, 'ok');
  assert.equal(im.last.commands_run, 1);
  assert.equal(im.last.commands_ok, 1);
});

test('workspace-write is refused up front when the run home enables the landlock backend; a blind workspace-write writer names the flag', () => {
  const fx = fixture();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repo, encoding: 'utf8' }).trim();
  const base = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: fx.repo, encoding: 'utf8' }).trim();
  const tasks = join(fx.root, 'tasks.txt'); writeFileSync(tasks, 'Step 1: bump a [task t1]\n');
  const plan = join(fx.repo, 'docs', 'plans', 'task-x.plan.md');
  const implReply = { commits: [{ sha: head.slice(0, 9), subject: 'two', task_id: 't1' }], acceptance: [], plan_gaps: [], declined: [], scope_violations: [], blockers: [], verify_first: [] };
  const args = ['implement', '--transport', 'exec', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'll-ww')];

  // landlock home + workspace-write → usage error (exit 1), codex never spawned, on both transports and on dry-run
  const home = join(fx.root, 'home'); mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-test"\n\n[features]\nuse_legacy_landlock = true\n');
  for (const extra of [[], ['--dry-run']]) {
    const refused = run(fx, [...args, ...extra, '--write-sandbox', 'workspace-write'], { reply: [implReply] });
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /workspace-write cannot run in this run home.*landlock/);
    assert.equal(refused.argv.length, 0, 'no codex spawn');
    assert.equal(refused.lines.length, 0, 'no result line');
  }
  const viaEnv = run(fx, ['implement', '--tasks', tasks, '--plan', plan, '--baseline', base, '--cwd', fx.repo, '--artifact', join(fx.art, 'll-ww-as')], { reply: [implReply], env: { SF_CODEX_WRITE_SANDBOX: 'workspace-write', FAKE_AS_SCENARIO: 'happy' } });
  assert.equal(viaEnv.status, 1, viaEnv.stderr); assert.match(viaEnv.stderr, /landlock/); assert.equal(viaEnv.rpc.length, 0, 'no app-server session');
  // the default (yolo) is unaffected by the landlock home
  const yolo = run(fx, args, { reply: [implReply] });
  assert.equal(yolo.status, 0, yolo.stderr); assert.equal(yolo.last.write_sandbox, 'yolo');

  // a home without the flag still allows workspace-write; a blind seat there names the flag as the first suspect
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-test"\n');
  const blind = run(fx, [...args, '--artifact', join(fx.art, 'll-blind'), '--write-sandbox', 'workspace-write'], { reply: [implReply], env: { FAKE_CODEX_NO_CMD: '1' } });
  assert.equal(blind.status, 2); assert.equal(blind.last.status, 'blind');
  assert.match(blind.last.detail, /ran no shell command; the seat ran under --write-sandbox workspace-write.*relaunch without the flag/);
  const blindYolo = run(fx, [...args, '--artifact', join(fx.art, 'll-blind-y')], { reply: [implReply], env: { FAKE_CODEX_NO_CMD: '1' } });
  assert.equal(blindYolo.last.status, 'blind'); assert.doesNotMatch(blindYolo.last.detail, /workspace-write/);
});

test('a --role sf-log would refuse fails before any seat runs (exit 1, usage error)', () => {
  const fx = fixture();
  for (const [verb, role, re] of [
    ['review', 'security-reviewer', /must start with one of/],
    ['review', 'reviewer:', /names no agent/],
    ['fix', 'implementer', /role=fixer/],
  ]) {
    const args = verb === 'review'
      ? ['review', '--role', role, '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, `bad-${verb}`), '--round', '1']
      : ['fix', '--role', role, '--cwd', fx.repo, '--artifact', join(fx.art, `bad-${verb}`), '--round', '1'];
    const res = run(fx, args, { reply: [reviewReply()] });
    assert.equal(res.status, 1, `${verb} ${role}: ${res.stderr}`);
    assert.match(res.stderr, re);
    assert.equal(res.argv.length, 0, 'no seat ran');
  }
});

test('snapshot reader seats: unsandboxed in a disposable worktree at the range end, removed after; resume gets a fresh one', () => {
  const fx = fixture();
  const git = (...a) => execFileSync('git', a, { cwd: fx.repo, encoding: 'utf8' }).trim();
  const prev = git('rev-parse', 'HEAD~1');
  const cwdLog = join(fx.root, 'cwd.log');
  const env = { SF_CODEX_READ_SANDBOX: 'snapshot', FAKE_CODEX_CWD: cwdLog };
  const r = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'round1', '--cwd', fx.repo, '--range', `${prev}..HEAD~1`, '--artifact', join(fx.art, 'nx-r1'), '--round', '1', '--no-log'], { reply: [reviewReply()], env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.last.status, 'ok');
  assert.equal(r.last.read_sandbox, 'snapshot');
  assert.equal(r.last.snapshot_sha, prev, 'pinned at the range end, not HEAD');
  const args = r.argv[0];
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('read-only'));
  const snapDir = args[args.indexOf('-C') + 1];
  assert.notEqual(snapDir, fx.repo);
  assert.ok(snapDir.startsWith(join(fx.root, 'home', 'snapshots')), snapDir);
  assert.match(r.prompts, new RegExp(`Working tree: ${snapDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. It is a disposable snapshot of .* at commit ${prev}`));
  assert.equal(existsSync(snapDir), false, 'snapshot removed after the seat');
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'no leftover worktree registration');
  assert.equal(JSON.parse(readFileSync(join(fx.art, 'nx-r1.json'), 'utf8'))._seat.read_sandbox, 'snapshot');

  // warm closure: resume carries the bypass flag (never -c sandbox_mode) and runs in a new snapshot
  const table = join(fx.root, 'table.json');
  writeFileSync(table, JSON.stringify([{ id: 'NX-1', summary: 'stale prop', commits: 'abc' }]));
  writeFileSync(cwdLog, '');
  const c = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'closure', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'nx-c2'), '--round', '2', '--resume', 'thread-abc', '--findings-table', table, '--no-log'],
    { reply: [{ closures: [{ id: 'NX-1', verdict: 'CLOSED', file: 'a.ts', line: 1, reason: 'gone' }], new_fix_introduced: [], answer: '' }], env });
  assert.equal(c.status, 0, c.stderr);
  const cargs = c.argv[0];
  assert.equal(cargs[1], 'resume');
  assert.ok(cargs.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!cargs.some((a) => /sandbox_mode/.test(a)));
  const resumedIn = readFileSync(cwdLog, 'utf8').trim();
  assert.ok(resumedIn.startsWith(join(fx.root, 'home', 'snapshots')) && resumedIn !== snapDir, resumedIn);
  assert.match(c.prompts, /Your working tree for this turn is .*fresh read-only snapshot/);
  assert.equal(existsSync(resumedIn), false);
});

test('a snapshot seat that writes into its snapshot is discarded as tampered (exit 2), and native homes keep -s read-only', () => {
  const fx = fixture();
  const t = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'nx-t'), '--round', '1', '--no-log'],
    { reply: [reviewReply()], env: { SF_CODEX_READ_SANDBOX: 'snapshot', FAKE_CODEX_TOUCH: 'evil.txt' } });
  assert.equal(t.status, 2, t.stderr);
  assert.equal(t.last.status, 'tampered');
  assert.match(t.last.detail, /evil\.txt/);
  assert.equal(existsSync(join(fx.art, 'nx-t.md')), false, 'no verdict artifact');
  assert.equal(existsSync(join(fx.repo, 'evil.txt')), false, 'the reviewed worktree was never the cwd');
  const snaps = join(fx.root, 'home', 'snapshots');
  assert.deepEqual(existsSync(snaps) ? require('node:fs').readdirSync(snaps) : [], [], 'tampered snapshot removed too');
  // the marker file selects snapshot mode without the env override
  mkdirSync(join(fx.root, 'home'), { recursive: true });
  writeFileSync(join(fx.root, 'home', 'sf-sandbox.json'), '{"reader":"snapshot"}');
  const m = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'nx-m'), '--round', '1', '--no-log'], { reply: [reviewReply()] });
  assert.equal(m.last.read_sandbox, 'snapshot', m.stderr);
  // an explicit native override wins over the marker
  const n = run(fx, ['review', '--role', 'reviewer:frontend-reviewer', '--template', 'round1', '--cwd', fx.repo, '--range', 'HEAD~1..HEAD', '--artifact', join(fx.art, 'nx-n'), '--round', '1', '--no-log'], { reply: [reviewReply()], env: { SF_CODEX_READ_SANDBOX: 'native' } });
  assert.equal(n.status, 0, n.stderr);
  assert.equal(n.last.read_sandbox, undefined);
  const nargs = n.argv[0];
  assert.deepEqual(nargs.slice(nargs.indexOf('-s'), nargs.indexOf('-s') + 2), ['-s', 'read-only']);
  assert.equal(nargs[nargs.indexOf('-C') + 1], fx.repo);
});
