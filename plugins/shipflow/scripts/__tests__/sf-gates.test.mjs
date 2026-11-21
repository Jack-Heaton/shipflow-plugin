/**
 * @file sf-gates.test.mjs
 * @description Tests for sf-gates.mjs against a real bare origin: `baseline` runs the base's
 *   declared push suites in a scratch worktree (setup sees SF_PARENT_WT, a failing and a timed-out
 *   suite are pre-existing failures, skip_env is pinned in the result, the scratch worktree is
 *   removed, no suite process outlives the baseline, SIGTERM cleans up, a dead owner's scratch is
 *   swept); `run` reads its checks from the base, runs one on the branch and the base, strips skip
 *   variables, reports undeclared and error cases, and a branch suite orphaned by a SIGKILL is
 *   killed by the next run; `push-env` prints only the runstate's pinned skips; `gate` runs a
 *   job set against a stub `npx` on PATH and a fixture lint ratchet and prints one JSON verdict
 *   (all pass, a genuine build failure, an out-of-memory retry, a killed job, a drift failure that
 *   is and is not pre-existing, a drift run cut short, an undeclared or unnamed skip, the orphan
 *   sweep after a SIGKILL, the retry order against held jobs, a lint false green, error and layer
 *   cases).
 *   Run: node --test plugins/shipflow/scripts/__tests__/sf-gates.test.mjs
 * @domain workflow-gates
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SF_GATES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sf-gates.mjs');
const G_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: G_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const node = (code) => [process.execPath, '-e', code];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Seed repo on `development` carrying `config` (+ files), a bare origin, and a feature clone. */
function fixture(config, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sf-'));
  const seed = join(root, 'seed');
  execFileSync('git', ['init', '-q', '-b', 'development', seed], { env: G_ENV });
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  for (const [f, c] of Object.entries(files)) writeFileSync(join(seed, f), c);
  if (config) writeFileSync(join(seed, '.shipflow.json'), typeof config === 'string' ? config : JSON.stringify(config));
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'base');
  const bare = join(root, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, bare], { env: G_ENV });
  const wt = join(root, 'wt');
  execFileSync('git', ['clone', '-q', '-b', 'development', bare, wt], { env: G_ENV });
  git(wt, 'checkout', '-q', '-b', 'feat/x');
  return { root, wt, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const run = (args, env = {}) => spawnSync(process.execPath, [SF_GATES, ...args], { encoding: 'utf8', env: { ...G_ENV, ...env } });
const worktrees = (wt) => git(wt, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function gone(pid) {
  for (let i = 0; i < 40 && alive(pid); i += 1) await sleep(50);
  return !alive(pid);
}

// Starts a grandchild in the suite's process group and records its pid in the run worktree.
const withGrandchild = (tag, tail) => node(
  `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); c.unref();`
  + `require('fs').writeFileSync(require('path').join(process.env.SF_PARENT_WT, '${tag}'), String(c.pid));`
  + `require('fs').writeFileSync(require('path').join(process.env.SF_PARENT_WT, '${tag}-cwd'), process.cwd());${tail}`,
);

test('baseline: failures, timeout, pinned skip_env, index-prefixed logs; no suite process outlives it; scratch removed', async () => {
  const fx = fixture({
    push_gates: {
      setup: node("require('fs').writeFileSync(require('path').join(process.env.SF_PARENT_WT, 'setup-ran'), process.cwd())"),
      suites: [
        { name: 'pass', run: withGrandchild('gc-pass', 'process.exit(0)') },
        { name: 'fail', run: node("console.log('boom', process.env.SF_SKIP_FAIL ?? 'unset'); process.exit(3)"), skip_env: 'SF_SKIP_FAIL' },
        { name: 'slow', run: withGrandchild('gc-slow', 'setTimeout(() => {}, 20000)'), timeout_ms: 1500 },
        { name: 'a b', run: node('process.exit(0)') },
        { name: 'a_b', run: node('process.exit(0)') },
      ],
    },
  });
  try {
    const out = join(fx.root, 'out', 'push-gates.json');
    const r = run(['baseline', '--cwd', fx.wt, '--base', 'development', '--out', out], { SF_SKIP_FAIL: '1' });
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(res.declared, true);
    assert.equal(res.linked_deps, true);
    assert.equal(res.base_sha, git(fx.wt, 'rev-parse', 'origin/development'));
    assert.deepEqual(res.preexisting_failures, ['fail', 'slow']);
    const byName = Object.fromEntries(res.suites.map((s) => [s.name, s]));
    assert.equal(byName.pass.pass, true);
    assert.equal(byName.fail.exit, 3);
    assert.equal(byName.fail.skip_env, 'SF_SKIP_FAIL');
    assert.equal(byName.pass.skip_env, null);
    assert.match(readFileSync(byName.fail.log, 'utf8'), /boom unset/, 'a declared skip_env never reaches a suite');
    assert.equal(byName.slow.timed_out, true);
    assert.notEqual(byName['a b'].log, byName.a_b.log, 'log names cannot collide');
    for (const tag of ['gc-pass', 'gc-slow']) {
      assert.ok(await gone(Number(readFileSync(join(fx.wt, tag), 'utf8'))), `${tag} grandchild is dead`);
    }
    assert.equal(existsSync(readFileSync(join(fx.wt, 'setup-ran'), 'utf8')), false, 'scratch worktree directory is gone');
    assert.equal(worktrees(fx.wt), 1);
  } finally { fx.cleanup(); }
});

test('baseline: undeclared → declared:false without a checkout; unresolvable base → exit 2', () => {
  const fx = fixture(null);
  try {
    const out = join(fx.root, 'pg.json');
    const r = run(['baseline', '--cwd', fx.wt, '--base', 'development', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(res.declared, false);
    assert.deepEqual(res.preexisting_failures, []);
    assert.equal(existsSync(join(fx.root, 'push-gate-logs')), false, 'no suite ran');
    const bad = run(['baseline', '--cwd', fx.wt, '--base', 'nope', '--out', out]);
    assert.equal(bad.status, 2); assert.match(bad.stderr, /does not resolve/);
  } finally { fx.cleanup(); }
});

test('baseline: a failing setup → exit 1, setup recorded, no suite run', () => {
  const fx = fixture({ push_gates: { setup: node('process.exit(5)'), suites: [{ name: 's', run: node('process.exit(0)') }] } });
  try {
    const out = join(fx.root, 'pg.json');
    const r = run(['baseline', '--cwd', fx.wt, '--base', 'development', '--out', out]);
    assert.equal(r.status, 1, r.stderr);
    const res = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(res.setup.exit, 5);
    assert.deepEqual(res.suites, []);
    assert.equal(worktrees(fx.wt), 1);
  } finally { fx.cleanup(); }
});

test('baseline: an invalid base config → exit 2, no JSON, no worktree left', () => {
  const fx = fixture({ push_gates: { suites: [{ name: 's', run: 'npm test' }] } });
  try {
    const out = join(fx.root, 'pg.json');
    const r = run(['baseline', '--cwd', fx.wt, '--base', 'development', '--out', out]);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /argv/);
    assert.equal(existsSync(out), false);
    assert.equal(worktrees(fx.wt), 1);
  } finally { fx.cleanup(); }
});

test('baseline: SIGTERM kills the suite group and removes the scratch worktree', async () => {
  const fx = fixture({ push_gates: { suites: [{ name: 'hang', run: withGrandchild('gc-hang', 'setTimeout(() => {}, 30000)') }] } });
  try {
    const child = spawn(process.execPath, [SF_GATES, 'baseline', '--cwd', fx.wt, '--base', 'development', '--out', join(fx.root, 'pg.json')], { env: G_ENV, stdio: 'ignore' });
    const exited = new Promise((r) => child.on('close', (code) => r(code)));
    for (let i = 0; i < 200 && !existsSync(join(fx.wt, 'gc-hang-cwd')); i += 1) await sleep(50);
    child.kill('SIGTERM');
    assert.equal(await exited, 143);
    assert.ok(await gone(Number(readFileSync(join(fx.wt, 'gc-hang'), 'utf8'))), 'grandchild is dead');
    assert.equal(existsSync(readFileSync(join(fx.wt, 'gc-hang-cwd'), 'utf8')), false);
    assert.equal(worktrees(fx.wt), 1);
  } finally { fx.cleanup(); }
});

test('baseline: the scratch of a dead owner is swept (its suite group killed, its worktree removed)', async () => {
  const fx = fixture({ push_gates: { suites: [{ name: 's', run: node('process.exit(0)') }] } });
  const stale = mkdtempSync(join(tmpdir(), 'sf-'));
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
  try {
    git(fx.wt, 'worktree', 'add', '--detach', '-q', join(stale, 'base'), 'origin/development');
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    writeFileSync(join(stale, 'sf-gates-owner.json'), JSON.stringify({ pid: Number(dead.stdout), pgids: [orphan.pid] }));
    const r = run(['baseline', '--cwd', fx.wt, '--base', 'development', '--out', join(fx.root, 'pg.json')]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(stale), false, 'stale scratch removed');
    assert.ok(await gone(orphan.pid), 'orphaned suite group killed');
    assert.equal(worktrees(fx.wt), 1);
  } finally {
    try { process.kill(-orphan.pid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(stale, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('run --only: after a SIGKILL mid-branch, the next run kills the branch suite group', async () => {
  // The branch check runs in the run worktree itself (no SF_PARENT_WT), so it records there.
  const hang = node(
    "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); c.unref();"
    + "require('fs').writeFileSync('gc-branch', String(c.pid)); setTimeout(() => {}, 30000)",
  );
  const fx = fixture({ push_gates: { suites: [{ name: 'hang', run: hang }] }, manifest_drift: { name: 'drift', run: node('process.exit(0)') } });
  let gc = null;
  try {
    const child = spawn(process.execPath, [SF_GATES, 'run', '--set', 'suites', '--only', 'hang', '--cwd', fx.wt, '--base', 'development'], { env: G_ENV, stdio: 'ignore' });
    const exited = new Promise((r) => child.on('close', () => r()));
    for (let i = 0; i < 200 && !existsSync(join(fx.wt, 'gc-branch')); i += 1) await sleep(50);
    gc = Number(readFileSync(join(fx.wt, 'gc-branch'), 'utf8'));
    child.kill('SIGKILL');
    await exited;
    await sleep(200);
    assert.ok(alive(gc), 'SIGKILL of sf-gates alone leaves the branch suite running');
    const next = run(['run', '--set', 'manifest-drift', '--cwd', fx.wt, '--base', 'development']);
    assert.equal(next.status, 0, next.stderr);
    assert.ok(await gone(gc), 'the sweep killed the orphaned branch suite group');
    rmSync(dirname(JSON.parse(next.stdout).log), { recursive: true, force: true });
  } finally {
    if (gc) try { process.kill(gc, 'SIGKILL'); } catch { /* already gone */ }
    fx.cleanup();
  }
});

const STATE_SUITE = node("const fs = require('fs'); console.log('skip', process.env.SF_SKIP_S ?? 'unset'); process.exit(Number(fs.readFileSync('state.txt', 'utf8')))");

test('run --only: the base config decides, the check runs on branch and base, skip variables stripped', () => {
  const cfg = { push_gates: { suites: [{ name: 's', run: STATE_SUITE, skip_env: 'SF_SKIP_S' }] }, manifest_drift: { name: 'drift', run: STATE_SUITE } };
  const fx = fixture(cfg, { 'state.txt': '1' });
  try {
    writeFileSync(join(fx.wt, 'state.txt'), '0');
    // The branch rewrites its own checks; the gate must ignore that.
    writeFileSync(join(fx.wt, '.shipflow.json'), JSON.stringify({ push_gates: { suites: [{ name: 's', run: node('process.exit(0)') }] } }));
    git(fx.wt, 'commit', '-qam', 'branch');
    const r = run(['run', '--set', 'suites', '--only', 's', '--cwd', fx.wt, '--base', 'development'], { SF_SKIP_S: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /differs from origin\/development/);
    const res = JSON.parse(r.stdout);
    assert.equal(res.branch.pass, true);
    assert.equal(res.base.pass, false);
    assert.equal(res.base.exit, 1);
    assert.match(readFileSync(res.branch.log, 'utf8'), /skip unset/, 'the branch ran the base-declared argv without the skip variable');
    assert.equal(worktrees(fx.wt), 1);
    const md = run(['run', '--set', 'manifest-drift', '--only', 'drift', '--cwd', fx.wt, '--base', 'development']);
    assert.equal(md.status, 0, md.stderr);
    assert.equal(JSON.parse(md.stdout).base.pass, false);
    const unknown = run(['run', '--set', 'suites', '--only', 'nope', '--cwd', fx.wt, '--base', 'development']);
    assert.equal(unknown.status, 0);
    assert.equal(JSON.parse(unknown.stdout).declared, false);
    rmSync(dirname(res.branch.log), { recursive: true, force: true });
    rmSync(dirname(JSON.parse(md.stdout).branch.log), { recursive: true, force: true });
  } finally { fx.cleanup(); }
});

// The pre-push hook's pass receipt (.githooks/README.md, "Pass receipts"); the hook harness pairs both writers.
const RECEIPT_CFG = { push_gates: { suites: [{ name: 'pg-writer-gate', run: ['bash', 'gate.sh'] }] } };
// touch-me: rewrite a.txt with its own bytes, an edit reverted within the run (the snapshot's
// settle makes it visible). swap-hook: reinstall the hook mid-run, the way the installer does.
const RECEIPT_GATE = [
  'echo "selection ${SF_PG_GATE_SUITES:-unset}"',
  '[ ! -f touch-me ] || { c="$(cat a.txt)"; printf \'%s\\n\' "$c" > a.txt; }',
  '[ ! -f swap-hook ] || mv -f swap-hook .git/hooks/pre-push',
  'exit "$(cat state.txt)"',
].join('\n') + '\n';
const RECEIPT_HOOK = '#!/usr/bin/env bash\n# hook-version: 7\nrun_gate_arm --arm=pg-writer-gate -- true\nexit 0\n';
const runGate = (wt, env = {}) => run(['run', '--set', 'suites', '--only', 'pg-writer-gate', '--cwd', wt, '--base', 'development'], env);
const receiptsIn = (wt) => {
  const dir = join(wt, '.git', 'sf-pass-receipts');
  return existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.')).sort() : [];
};
const dropLogs = (r) => rmSync(dirname(JSON.parse(r.stdout).branch.log), { recursive: true, force: true });

test('run --set suites: a passing branch run writes the hook pass receipt; a failure, an edit during the run, a hook swap, a hidden entry, or no hook arm of that name writes none', () => {
  const fx = fixture(RECEIPT_CFG, { 'gate.sh': RECEIPT_GATE, 'state.txt': '0\n' });
  try {
    const none = runGate(fx.wt);
    assert.equal(none.status, 0, none.stderr);
    assert.deepEqual(receiptsIn(fx.wt), [], 'no installed hook, no receipt');
    dropLogs(none);

    const hook = join(fx.wt, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, RECEIPT_HOOK.replace('pg-writer-gate', 'other-arm'), { mode: 0o755 });
    const noArm = runGate(fx.wt);
    assert.equal(noArm.status, 0, noArm.stderr);
    assert.deepEqual(receiptsIn(fx.wt), [], 'a suite no hook arm reads writes no receipt');
    dropLogs(noArm);

    writeFileSync(hook, RECEIPT_HOOK);
    const ok = runGate(fx.wt);
    assert.equal(ok.status, 0, ok.stderr);
    const record = [
      'sf-pass-receipt v1',
      'arm pg-writer-gate',
      `tree ${git(fx.wt, 'rev-parse', 'HEAD^{tree}')}`,
      'hook 7',
      `hookblob ${git(fx.wt, 'hash-object', '--no-filters', hook)}`,
      `selection bash gate.sh@${git(fx.wt, 'hash-object', '--no-filters', join(fx.wt, 'gate.sh'))}`,
    ].join('\n') + '\n';
    const name = execFileSync('git', ['-C', fx.wt, 'hash-object', '--stdin'], { input: record, encoding: 'utf8' }).trim();
    assert.deepEqual(receiptsIn(fx.wt), [name], 'one record, named by the hash of its text');
    assert.equal(readFileSync(join(fx.wt, '.git', 'sf-pass-receipts', name), 'utf8'), record);
    dropLogs(ok);

    writeFileSync(join(fx.wt, 'state.txt'), '3\n');
    git(fx.wt, 'commit', '-qam', 'fail');
    const bad = runGate(fx.wt);
    assert.equal(bad.status, 3, bad.stderr);
    assert.deepEqual(receiptsIn(fx.wt), [name], 'a failing run writes none');
    dropLogs(bad);

    // A tree no receipt names yet, so a record written here would show.
    writeFileSync(join(fx.wt, 'state.txt'), '0\n');
    writeFileSync(join(fx.wt, 'a.txt'), 'edited\n');
    git(fx.wt, 'commit', '-qam', 'pass again');
    writeFileSync(join(fx.wt, 'touch-me'), '');
    const touched = runGate(fx.wt);
    assert.equal(touched.status, 0, touched.stderr);
    assert.deepEqual(receiptsIn(fx.wt), [name], 'a tracked file rewritten with its own bytes during the run writes none');
    dropLogs(touched);
    rmSync(join(fx.wt, 'touch-me'));

    writeFileSync(join(fx.wt, 'a.txt'), 'swap\n');
    git(fx.wt, 'commit', '-qam', 'hook swap');
    writeFileSync(join(fx.wt, 'swap-hook'), `${RECEIPT_HOOK}# reinstalled mid-run, same version\n`, { mode: 0o755 });
    const swapped = runGate(fx.wt);
    assert.equal(swapped.status, 0, swapped.stderr);
    assert.ok(!existsSync(join(fx.wt, 'swap-hook')), 'the gate swapped the hook');
    assert.match(swapped.stderr, /installed hook changed during the run/);
    assert.deepEqual(receiptsIn(fx.wt), [name], 'a hook reinstalled during the run writes none');
    dropLogs(swapped);
    writeFileSync(hook, RECEIPT_HOOK);

    git(fx.wt, 'update-index', '--assume-unchanged', 'a.txt');
    const hidden = runGate(fx.wt);
    assert.equal(hidden.status, 0, hidden.stderr);
    assert.match(hidden.stderr, /assume-unchanged or skip-worktree/);
    assert.deepEqual(receiptsIn(fx.wt), [name], 'an assume-unchanged entry writes none');
    dropLogs(hidden);
  } finally { fx.cleanup(); }
});

test('run --set suites: SF_PG_GATE_SUITES never reaches a suite, inherited or passed by the caller', async () => {
  const fx = fixture(RECEIPT_CFG, { 'gate.sh': RECEIPT_GATE, 'state.txt': '0\n' });
  try {
    const inherited = runGate(fx.wt, { SF_PG_GATE_SUITES: 'pgChunk' });
    assert.equal(inherited.status, 0, inherited.stderr);
    const res = JSON.parse(inherited.stdout);
    for (const log of [res.branch.log, res.base.log]) assert.match(readFileSync(log, 'utf8'), /selection unset/);
    dropLogs(inherited);
    const { runSet } = await import(pathToFileURL(SF_GATES).href);
    const passed = (await runSet({ set: 'suites', cwd: fx.wt, base: 'development', only: 'pg-writer-gate', env: { SF_PG_GATE_SUITES: 'pgChunk' } })).result;
    for (const log of [passed.branch.log, passed.base.log]) assert.match(readFileSync(log, 'utf8'), /selection unset/);
    rmSync(dirname(passed.branch.log), { recursive: true, force: true });
  } finally { fx.cleanup(); }
});

test('run --set manifest-drift: pass, fail with the check exit, undeclared, and errors print no JSON', () => {
  const pass = fixture({ manifest_drift: { name: 'gates', run: node('process.exit(0)') } });
  const drift = fixture({ manifest_drift: { name: 'gates', run: node('process.exit(4)') } });
  const none = fixture(null);
  const invalid = fixture({ manifest_drift: { name: 'gates', run: 'npm run test:gates' } });
  try {
    const ok = run(['run', '--set', 'manifest-drift', '--cwd', pass.wt, '--base', 'development']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).pass, true);
    const bad = run(['run', '--set', 'manifest-drift', '--cwd', drift.wt, '--base', 'development']);
    assert.equal(bad.status, 4);
    assert.equal(JSON.parse(bad.stdout).pass, false);
    const und = run(['run', '--set', 'manifest-drift', '--cwd', none.wt, '--base', 'development']);
    assert.equal(und.status, 0, und.stderr);
    assert.equal(JSON.parse(und.stdout).declared, false);
    for (const args of [
      ['--set', 'manifest-drift', '--cwd', invalid.wt, '--base', 'development'],
      ['--set', 'manifest-drift', '--cwd', pass.wt, '--base', 'nope'],
      ['--set', 'manifest-drift', '--cwd', pass.wt],
      ['--set', 'other', '--cwd', pass.wt, '--base', 'development'],
    ]) {
      const e = run(['run', ...args]);
      assert.equal(e.status, 2, args.join(' '));
      assert.equal(e.stdout, '', 'an error never prints a result');
    }
    for (const r of [ok, bad]) rmSync(dirname(JSON.parse(r.stdout).log), { recursive: true, force: true });
  } finally { for (const f of [pass, drift, none, invalid]) f.cleanup(); }
});

test('push-env: prints only the runstate-pinned skips; a missing or corrupt runstate prints nothing and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-'));
  try {
    const rs = join(dir, 'rs.json');
    writeFileSync(rs, JSON.stringify({ push_gate_skips: [{ name: 'a', skip_env: 'SF_SKIP_A' }, { name: 'b', skip_env: null }, { name: 'c', skip_env: 'X; rm' }] }));
    const r = run(['push-env', '--runstate', rs]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'SF_SKIP_A=1\n');
    writeFileSync(rs, JSON.stringify({ push_gate_skips: [] }));
    assert.equal(run(['push-env', '--runstate', rs]).stdout, '');
    writeFileSync(rs, '{not json');
    const corrupt = run(['push-env', '--runstate', rs]);
    assert.equal(corrupt.status, 0); assert.equal(corrupt.stdout, ''); assert.match(corrupt.stderr, /warning/);
    const missing = run(['push-env', '--runstate', join(dir, 'nope.json')]);
    assert.equal(missing.status, 0); assert.equal(missing.stdout, ''); assert.match(missing.stderr, /warning/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- gate -----------------------------------------------------------------------------------

// Stands in for `npx`: answers the turbo probe, then plays the per-command steps in plan.json
// ({"turbo build": [{exit, out, signal, delay_ms, hang}, …]}; the last step repeats) and records
// each call with its argv as given. A `hang` step writes its pid to hang.pid and never exits.
const NPX_STUB = `#!/usr/bin/env node
const fs = require('fs');
const raw = process.argv.slice(2);
if (raw.includes('--version')) process.exit(Number(process.env.FAKE_NPX_PROBE || 0));
const args = raw[0] === '--no-install' ? raw.slice(1) : raw;
const key = args[0] === 'turbo' ? 'turbo ' + args[2] : args[0];
const dir = process.env.FAKE_NPX_DIR;
fs.appendFileSync(dir + '/calls.log', JSON.stringify({ key, args: raw, node_options: process.env.NODE_OPTIONS || null }) + '\\n');
const plan = JSON.parse(fs.readFileSync(dir + '/plan.json', 'utf8'))[key] || [];
const counter = dir + '/' + key.replace(/\\W/g, '_') + '.n';
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(n + 1));
const step = plan[Math.min(n, plan.length - 1)] || { exit: 0 };
if (step.out) console.log(step.out);
if (step.hang) { fs.writeFileSync(dir + '/hang.pid', String(process.pid)); setTimeout(() => {}, 30000); }
else if (step.signal) process.kill(process.pid, step.signal);
else setTimeout(() => process.exit(step.exit || 0), step.delay_ms || 0);
`;

// Fails with one `not ok` line per name in fails.txt, so branch and base can fail differently.
const FAILS_SUITE = node("const f = require('fs').readFileSync('fails.txt', 'utf8').split('\\n').filter(Boolean); f.forEach((n, i) => console.log('not ok ' + (i + 1) + ' - ' + n + ' 12ms')); process.exit(f.length ? 1 : 0)");

/** A fixture plus a stub npx, a changed-files list, and (with `lintChecked`) a lint ratchet that reports that count. */
function gateFixture({ config = null, files = {}, plan = {}, changed = ['a.txt'], lintChecked } = {}) {
  const fx = fixture(config, files);
  const bin = join(fx.root, 'bin');
  const fake = join(fx.root, 'fake');
  for (const d of [bin, fake]) mkdirSync(d);
  writeFileSync(join(bin, 'npx'), NPX_STUB);
  chmodSync(join(bin, 'npx'), 0o755);
  writeFileSync(join(fake, 'plan.json'), JSON.stringify(plan));
  const changedFiles = join(fx.root, 'changed-files.txt');
  writeFileSync(changedFiles, `${changed.join('\n')}\n`);
  if (lintChecked !== undefined) {
    mkdirSync(join(fx.wt, 'scripts'));
    writeFileSync(join(fx.wt, 'scripts', 'lint-ratchet.mjs'), `console.log('==> lint-ratchet: ok (${lintChecked} file(s) checked, no new ESLint errors)');\n`);
  }
  const out = join(fx.root, 'out');
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_NPX_DIR: fake };
  const gate = (mode, extra = [], moreEnv = {}) => {
    const full = mode === 'full' ? ['--ship-mode', 'inline', '--changed-files', changedFiles] : [];
    const r = run(['gate', '--mode', mode, '--cwd', fx.wt, '--base', 'development', '--baseline', 'origin/development', '--out-dir', out, ...full, ...extra], { ...env, ...moreEnv });
    return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
  };
  const calls = () => readFileSync(join(fake, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const setPlan = (next) => { rmSync(fake, { recursive: true, force: true }); mkdirSync(fake); writeFileSync(join(fake, 'plan.json'), JSON.stringify(next)); };
  return { ...fx, out, gate, calls, setPlan, changedFiles, env, fake };
}

const job = (res, name) => res.jobs.find((j) => j.name === name);
function touch(wt, ...paths) {
  for (const p of paths) { mkdirSync(dirname(join(wt, p)), { recursive: true }); writeFileSync(join(wt, p), '\n'); }
}
function skipsRunstate(fx, names) {
  const rs = join(fx.root, 'rs.json');
  writeFileSync(rs, JSON.stringify({ push_gate_skips: names.map((name) => ({ name, skip_env: 'SF_SKIP_S' })) }));
  return rs;
}

test('gate: all pass — one JSON line, also result.json; build-output jobs are held for the build', () => {
  const fx = gateFixture({
    config: { manifest_drift: { name: 'gates', run: node('process.exit(0)') }, push_gates: { suites: [{ name: 's', run: FAILS_SUITE, skip_env: 'SF_SKIP_S' }] } },
    files: { 'fails.txt': '' },
    changed: ['a.txt', 'apps/web/a.ts', 'apps/web/b.tsx'],
    lintChecked: 2,
  });
  try {
    touch(fx.wt, 'apps/web/a.ts', 'apps/web/b.tsx');
    const ac = join(fx.root, 'ac.json');
    writeFileSync(ac, JSON.stringify([{ id: 1, sh: 'test -d .git || test -f .git' }, { id: 'x 2', sh: 'echo hi | grep -q hi', reads_build: false }]));
    const r = fx.gate('full', ['--runstate', skipsRunstate(fx, ['s']), '--ac', ac]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split('\n').length, 1, 'one stdout line');
    assert.deepEqual(JSON.parse(readFileSync(join(fx.out, 'result.json'), 'utf8')), r.json);
    const res = r.json;
    assert.equal(res.mode, 'full');
    assert.equal(res.pass, true);
    assert.equal(res.next, 'pass');
    assert.deepEqual(res.bucket1, []);
    assert.equal(res.tip, git(fx.wt, 'rev-parse', 'HEAD'));
    assert.equal(res.baseline, git(fx.wt, 'rev-parse', 'origin/development'));
    assert.deepEqual(res.jobs.map((j) => [j.name, j.verdict, j.held_for_build]), [
      ['build', 'pass', false], ['drift', 'pass', true], ['lint', 'pass', false], ['ac-1', 'pass', true], ['ac-x_2', 'pass', false],
    ]);
    for (const j of res.jobs) {
      assert.equal(j.attempts, 1); assert.equal(j.resilience, null); assert.equal(j.exit, 0); assert.equal(j.signal, null);
      assert.ok(existsSync(j.log) && j.log.startsWith(fx.out), `${j.name} log sits in the output directory`);
      assert.equal(typeof j.wall_ms, 'number');
    }
    assert.deepEqual(job(res, 'drift').checks.map((c) => [c.set, c.name, c.verdict]), [['manifest-drift', 'gates', 'pass'], ['suites', 's', 'pass']]);
    assert.deepEqual(job(res, 'lint').lint, { checked: 2, expected: 2, false_green: false });
    const build = fx.calls().find((c) => c.key === 'turbo build');
    assert.ok(build.args.includes('--force') && build.args.includes(`--filter=...[${res.baseline}]`), 'the build is forced and scoped to the baseline');
    assert.ok(!build.args.includes('--filter=!@acme/web'), 'a frontend diff builds the front end');
    assert.equal(worktrees(fx.wt), 1);
  } finally { fx.cleanup(); }
});

test('gate: a genuine build failure → build-failed, no retry, held jobs not-run', () => {
  const fx = gateFixture({ plan: { 'turbo build': [{ exit: 1, out: 'src/a.ts(3,1): error TS2322: Type string is not assignable to type number.' }] } });
  try {
    const ac = join(fx.root, 'ac.json');
    writeFileSync(ac, JSON.stringify([{ id: 1, sh: 'true' }]));
    const r = fx.gate('full', ['--ac', ac]);
    assert.equal(r.status, 1, r.stderr);
    const res = r.json;
    assert.equal(res.pass, false);
    assert.equal(res.next, 'build-failed');
    const build = job(res, 'build');
    assert.deepEqual([build.verdict, build.exit, build.attempts, build.resilience], ['fail', 1, 1, null]);
    assert.match(readFileSync(build.log, 'utf8'), /TS2322/);
    assert.deepEqual([job(res, 'ac-1').verdict, job(res, 'ac-1').attempts], ['not-run', 0]);
    assert.equal(job(res, 'drift').verdict, 'pass', 'a job that does not read build output still ran');
    assert.equal(job(res, 'drift').checks[0].verdict, 'undeclared');
    assert.equal(job(res, 'lint'), undefined, 'no lint job without the ratchet script');
    assert.equal(fx.calls().filter((c) => c.key === 'turbo build').length, 1);
    assert.ok(fx.calls()[0].args.includes('--filter=!@acme/web'), 'no frontend or package change → the front end is left out');
  } finally { fx.cleanup(); }
});

test('gate: an out-of-memory retry that then passes — re-run once with the larger heap and --concurrency=1', () => {
  const fx = gateFixture({ plan: { 'turbo build': [{ exit: 134, out: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' }, { exit: 0 }] } });
  try {
    const r = fx.gate('full');
    assert.equal(r.status, 0, r.stderr);
    const build = job(r.json, 'build');
    assert.deepEqual([build.verdict, build.attempts, build.resilience], ['pass', 2, 'oom']);
    assert.match(build.log, /build\.retry-1\.log$/);
    const [first, second] = fx.calls().filter((c) => c.key === 'turbo build');
    assert.notEqual(first.node_options, '--max-old-space-size=8192');
    assert.ok(!first.args.includes('--concurrency=1'));
    assert.equal(second.node_options, '--max-old-space-size=8192');
    assert.ok(second.args.includes('--concurrency=1') && second.args.includes('--force'));
    // The class is spent: a second out-of-memory failure is the verdict.
    fx.setPlan({ 'turbo build': [{ exit: 137 }] });
    const again = fx.gate('full');
    assert.equal(again.status, 1);
    assert.deepEqual([job(again.json, 'build').verdict, job(again.json, 'build').attempts, job(again.json, 'build').resilience], ['fail', 2, 'oom']);
    assert.equal(again.json.next, 'build-failed');
  } finally { fx.cleanup(); }
});

test('gate: a job killed with no exit record is re-run alone once; killed twice is an error, never a pass', () => {
  const fx = gateFixture({ plan: { 'turbo type-check': [{ signal: 'SIGKILL' }, { exit: 0 }] } });
  try {
    const r = fx.gate('smoke');
    assert.equal(r.status, 0, r.stderr);
    const smoke = job(r.json, 'smoke');
    assert.deepEqual([smoke.verdict, smoke.attempts, smoke.resilience, smoke.exit], ['pass', 2, 'killed', 0]);
    assert.equal(r.json.next, 'pass');
    const calls = fx.calls();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args, ['turbo', 'run', 'type-check', '--force', `--filter=...[${r.json.baseline}]`], 'the smoke is the scoped type-check and nothing else');
    fx.setPlan({ 'turbo type-check': [{ signal: 'SIGKILL' }] });
    const again = fx.gate('smoke');
    assert.equal(again.status, 1);
    const dead = job(again.json, 'smoke');
    assert.deepEqual([dead.verdict, dead.exit, dead.signal, dead.attempts, dead.resilience], ['error', null, 'SIGKILL', 2, 'killed']);
    assert.equal(again.json.next, 'smoke-finding');
  } finally { fx.cleanup(); }
});

const SKIPPED_SUITE_CONFIG = { push_gates: { suites: [{ name: 's', run: FAILS_SUITE, skip_env: 'SF_SKIP_S' }] } };

test('gate: a drift failure that is pre-existing under the run-preflight.md predicate passes as preexisting', () => {
  const fx = gateFixture({ config: SKIPPED_SUITE_CONFIG, files: { 'fails.txt': 'alpha\nbeta\n' } });
  try {
    writeFileSync(join(fx.wt, 'fails.txt'), 'beta\n');
    const r = fx.gate('full', ['--runstate', skipsRunstate(fx, ['s'])], { SF_SKIP_S: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.pass, true);
    assert.equal(r.json.next, 'pass');
    const drift = job(r.json, 'drift');
    assert.equal(drift.verdict, 'preexisting');
    assert.equal(drift.held_for_build, true, 'a skipped suite may read build output');
    const check = drift.checks.find((c) => c.name === 's');
    assert.deepEqual([check.set, check.verdict, check.branch_only_failures], ['suites', 'preexisting', []]);
    assert.match(readFileSync(check.branch_log, 'utf8'), /not ok 1 - beta/);
    assert.match(readFileSync(check.base_log, 'utf8'), /not ok 2 - beta/);
    assert.equal(worktrees(fx.wt), 1);
  } finally { fx.cleanup(); }
});

// Prints the failures in fails.txt, then: with `hang` in the tree never exits; with `kill-once`
// removes it and dies on SIGKILL; otherwise exits like FAILS_SUITE.
const CUT_SHORT_SUITE = node(
  "const fs = require('fs'); const f = fs.readFileSync('fails.txt', 'utf8').split('\\n').filter(Boolean);"
  + "f.forEach((n, i) => console.log('not ok ' + (i + 1) + ' - ' + n + ' 12ms'));"
  + "if (fs.existsSync('hang')) setTimeout(() => {}, 30000);"
  + "else if (fs.existsSync('kill-once')) { fs.rmSync('kill-once'); process.kill(process.pid, 'SIGKILL'); setTimeout(() => {}, 30000); }"
  + "else process.exit(f.length ? 1 : 0)",
);
const CUT_SHORT_CONFIG = { push_gates: { suites: [{ name: 's', run: CUT_SHORT_SUITE, skip_env: 'SF_SKIP_S', timeout_ms: 1500 }] } };

test('gate: a branch run cut short by its timeout is an error, never pre-existing, and is not re-run', () => {
  const fx = gateFixture({ config: CUT_SHORT_CONFIG, files: { 'fails.txt': 'alpha\n' } });
  try {
    writeFileSync(join(fx.wt, 'hang'), '');
    const r = fx.gate('full', ['--runstate', skipsRunstate(fx, ['s'])]);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.json.pass, false);
    assert.equal(r.json.next, 'fix-pass');
    assert.deepEqual(r.json.bucket1, ['drift']);
    const drift = job(r.json, 'drift');
    assert.deepEqual([drift.verdict, drift.attempts, drift.resilience], ['error', 1, null], 'a timeout is not retried');
    const check = drift.checks.find((c) => c.name === 's');
    assert.equal(check.verdict, 'error');
    assert.match(readFileSync(check.branch_log, 'utf8'), /not ok 1 - alpha/, 'the partial log matched the base failure');
    assert.equal(worktrees(fx.wt), 1);
  } finally { fx.cleanup(); }
});

test('gate: a branch drift run killed by a signal is re-run once; a base run cut short is a failure', () => {
  const fx = gateFixture({ config: CUT_SHORT_CONFIG, files: { 'fails.txt': 'alpha\n' } });
  try {
    writeFileSync(join(fx.wt, 'kill-once'), '');
    const r = fx.gate('full', ['--runstate', skipsRunstate(fx, ['s'])]);
    assert.equal(r.status, 0, r.stderr);
    const drift = job(r.json, 'drift');
    assert.deepEqual([drift.verdict, drift.attempts, drift.resilience], ['preexisting', 2, 'killed']);
  } finally { fx.cleanup(); }
  // The base hangs (the file is committed there); the branch fails by its own exit.
  const base = gateFixture({ config: CUT_SHORT_CONFIG, files: { 'fails.txt': 'alpha\n', hang: '' } });
  try {
    git(base.wt, 'rm', '-q', 'hang');
    const r = base.gate('full', ['--runstate', skipsRunstate(base, ['s'])]);
    assert.equal(r.status, 1, r.stderr);
    const check = job(r.json, 'drift').checks.find((c) => c.name === 's');
    assert.equal(check.verdict, 'fail', 'a base that did not finish proves nothing about the branch');
  } finally { base.cleanup(); }
});

test('gate: a drift failure that is not pre-existing (one that is not) → fix-pass with bucket1; --relaunch yes → build-failed', () => {
  const fx = gateFixture({ config: SKIPPED_SUITE_CONFIG, files: { 'fails.txt': 'alpha\n' } });
  try {
    writeFileSync(join(fx.wt, 'fails.txt'), 'alpha\nbeta\n');
    const rs = skipsRunstate(fx, ['s']);
    const r = fx.gate('full', ['--runstate', rs]);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.json.next, 'fix-pass');
    assert.deepEqual(r.json.bucket1, ['drift']);
    const check = job(r.json, 'drift').checks.find((c) => c.name === 's');
    assert.deepEqual([check.verdict, check.branch_only_failures], ['fail', ['beta']]);
    assert.equal(job(r.json, 'drift').verdict, 'fail');
    assert.equal(job(r.json, 'build').verdict, 'pass');
    const relaunch = fx.gate('full', ['--runstate', rs, '--relaunch', 'yes']);
    assert.equal(relaunch.status, 1);
    assert.equal(relaunch.json.next, 'build-failed');
    // A base that passes, and a branch log with no identifier, are findings too.
    writeFileSync(join(fx.wt, 'fails.txt'), 'alpha\n');
    const same = fx.gate('full', ['--runstate', rs]);
    assert.equal(job(same.json, 'drift').verdict, 'preexisting');
  } finally { fx.cleanup(); }
  const opaque = gateFixture({ config: { manifest_drift: { name: 'gates', run: node("console.log('drift'); process.exit(1)") } } });
  try {
    const r = opaque.gate('full');
    assert.equal(r.status, 1, r.stderr);
    const check = job(r.json, 'drift').checks[0];
    assert.deepEqual([check.set, check.verdict], ['manifest-drift', 'fail'], 'failures that cannot be compared are not pre-existing');
  } finally { opaque.cleanup(); }
});

test('gate: a skip the base does not declare is an error; a skip entry with no name is a usage error that clears the old verdict', () => {
  const fx = gateFixture({ config: SKIPPED_SUITE_CONFIG, files: { 'fails.txt': '' } });
  try {
    const r = fx.gate('full', ['--runstate', skipsRunstate(fx, ['s', 'gone'])]);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.json.pass, false);
    const drift = job(r.json, 'drift');
    assert.equal(drift.verdict, 'error');
    assert.deepEqual(drift.checks.map((c) => [c.set, c.name, c.verdict]), [['manifest-drift', 'manifest-drift', 'undeclared'], ['suites', 's', 'pass'], ['suites', 'gone', 'error']]);
    assert.deepEqual(r.json.bucket1, ['drift']);
    assert.equal(existsSync(join(fx.out, 'result.json')), true);
    const rs = join(fx.root, 'rs.json');
    for (const entry of [{ skip_env: 'SF_SKIP_S' }, { name: 7, skip_env: 'SF_SKIP_S' }, null]) {
      writeFileSync(rs, JSON.stringify({ push_gate_skips: [{ name: 's', skip_env: 'SF_SKIP_S' }, entry] }));
      const e = fx.gate('full', ['--runstate', rs]);
      assert.equal(e.status, 2, JSON.stringify(entry));
      assert.equal(e.stdout, '', 'an error never prints a result');
      assert.match(e.stderr, /has no name/);
      assert.equal(existsSync(join(fx.out, 'result.json')), false, 'the earlier verdict in this directory is gone');
    }
  } finally { fx.cleanup(); }
});

test('gate: a timed-out branch run whose partial log reads like an OOM is still not re-run', () => {
  const fx = gateFixture({ config: CUT_SHORT_CONFIG, files: { 'fails.txt': 'Killed\n' } });
  try {
    writeFileSync(join(fx.wt, 'hang'), '');
    const drift = job(fx.gate('full', ['--runstate', skipsRunstate(fx, ['s'])]).json, 'drift');
    assert.deepEqual([drift.verdict, drift.attempts, drift.resilience], ['error', 1, null]);
  } finally { fx.cleanup(); }
});

const ownerDirs = (pid) => readdirSync(tmpdir()).filter((n) => n.startsWith('sf-')).map((n) => join(tmpdir(), n)).filter((d) => {
  try { return JSON.parse(readFileSync(join(d, 'sf-gates-owner.json'), 'utf8')).pid === pid; } catch { return false; }
});

test('gate: after a SIGKILL mid-build, the next gate in that repo kills the orphaned job; a finished gate leaves no owner directory', async () => {
  const fx = gateFixture({ config: { manifest_drift: { name: 'gates', run: node('process.exit(0)') } }, plan: { 'turbo build': [{ hang: true }] } });
  let orphan = null;
  try {
    const args = ['gate', '--mode', 'full', '--cwd', fx.wt, '--base', 'development', '--baseline', 'origin/development', '--out-dir', fx.out, '--ship-mode', 'inline', '--changed-files', fx.changedFiles];
    const child = spawn(process.execPath, [SF_GATES, ...args], { env: { ...G_ENV, ...fx.env }, stdio: 'ignore' });
    const exited = new Promise((r) => child.on('close', () => r()));
    // The drift job has ended (its log is written last) and the build is still running.
    for (let i = 0; i < 400 && !(existsSync(join(fx.fake, 'hang.pid')) && existsSync(join(fx.out, 'drift.log'))); i += 1) await sleep(50);
    orphan = Number(readFileSync(join(fx.fake, 'hang.pid'), 'utf8'));
    const [owner] = ownerDirs(child.pid);
    assert.ok(owner, 'the running gate owns a marker directory in the temp directory');
    assert.notEqual(owner, fx.out);
    child.kill('SIGKILL');
    await exited;
    await sleep(200);
    assert.ok(alive(orphan), 'SIGKILL of sf-gates alone leaves the build running');
    fx.setPlan({});
    const next = spawn(process.execPath, [SF_GATES, ...args], { env: { ...G_ENV, ...fx.env }, stdio: 'ignore' });
    const code = await new Promise((r) => next.on('close', (c) => r(c)));
    assert.equal(code, 0);
    assert.ok(await gone(orphan), 'the sweep killed the orphaned build group');
    assert.equal(existsSync(owner), false, 'the dead gate\'s owner directory is removed');
    assert.deepEqual(ownerDirs(next.pid), [], 'a finished gate removes its own');
    assert.equal(existsSync(join(fx.out, 'result.json')), true, 'the output directory is never swept');
  } finally {
    if (orphan) try { process.kill(orphan, 'SIGKILL'); } catch { /* already gone */ }
    fx.cleanup();
  }
});

test('gate: a free job\'s retry waits for the first attempts of the jobs held for the build', () => {
  const fx = gateFixture({ plan: { 'turbo build': [{ exit: 0, delay_ms: 700 }] }, lintChecked: 0 });
  try {
    // Killed on its first run (while the build is still running); the re-run records when it started.
    writeFileSync(join(fx.wt, 'scripts', 'lint-ratchet.mjs'), [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "if (existsSync('lint-killed')) { writeFileSync('lint-retry-start', String(Date.now())); console.log('==> lint-ratchet: ok (0 file(s) checked)'); }",
      "else { writeFileSync('lint-killed', ''); process.kill(process.pid, 'SIGKILL'); setTimeout(() => {}, 30000); }",
      '',
    ].join('\n'));
    const stamp = (f) => `"${process.execPath}" -e "require('fs').writeFileSync('${f}', String(Date.now()))"`;
    const ac = join(fx.root, 'ac.json');
    writeFileSync(ac, JSON.stringify([{ id: 1, sh: `${stamp('ac-start')}; sleep 1; ${stamp('ac-end')}` }]));
    const r = fx.gate('full', ['--ac', ac]);
    assert.equal(r.status, 0, r.stderr);
    const lint = job(r.json, 'lint');
    assert.deepEqual([lint.verdict, lint.attempts, lint.resilience], ['pass', 2, 'killed']);
    assert.equal(job(r.json, 'ac-1').held_for_build, true);
    const at = (f) => Number(readFileSync(join(fx.wt, f), 'utf8'));
    assert.ok(at('lint-retry-start') >= at('ac-end'), `the lint re-run (${at('lint-retry-start')}) started after the held job ended (${at('ac-end')})`);
  } finally { fx.cleanup(); }
});

test('gate: a lint run whose checked-file count is far below the diff is a false green and fails', () => {
  const fe = ['apps/web/a.ts', 'apps/web/b.tsx', 'apps/web/c.ts', 'apps/web/d.mjs'];
  const fx = gateFixture({ changed: ['a.txt', ...fe, 'apps/web/deleted.ts', 'apps/web/readme.md'], lintChecked: 1 });
  try {
    touch(fx.wt, ...fe, 'apps/web/readme.md');
    const r = fx.gate('full');
    assert.equal(r.status, 1, r.stderr);
    const lint = job(r.json, 'lint');
    assert.deepEqual([lint.verdict, lint.exit], ['fail', 0]);
    assert.deepEqual(lint.lint, { checked: 1, expected: 4, false_green: true });
    assert.equal(r.json.next, 'fix-pass');
    assert.deepEqual(r.json.bucket1, ['lint']);
    // Exactly half is not "far below".
    writeFileSync(fx.changedFiles, `${fe.slice(0, 2).join('\n')}\n`);
    const half = fx.gate('full');
    assert.equal(half.status, 0, half.stderr);
    assert.deepEqual(job(half.json, 'lint').lint, { checked: 1, expected: 2, false_green: false });
  } finally { fx.cleanup(); }
});

test('gate: errors print no JSON; an unresolvable turbo is error, not fail; layer mode runs smoke, tests and manifest drift', () => {
  const fx = gateFixture({ config: { manifest_drift: { name: 'gates', run: FAILS_SUITE } }, files: { 'fails.txt': 'alpha\n' } });
  try {
    for (const args of [
      ['gate', '--mode', 'smoke', '--cwd', fx.wt, '--base', 'development', '--out-dir', fx.out],
      ['gate', '--mode', 'smoke', '--cwd', fx.wt, '--base', 'development', '--baseline', 'nope', '--out-dir', fx.out],
      ['gate', '--mode', 'other', '--cwd', fx.wt, '--base', 'development', '--baseline', 'HEAD', '--out-dir', fx.out],
      ['gate', '--mode', 'full', '--cwd', fx.wt, '--base', 'development', '--baseline', 'HEAD', '--out-dir', fx.out, '--ship-mode', 'inline'],
      ['gate', '--mode', 'full', '--cwd', fx.wt, '--base', 'development', '--baseline', 'HEAD', '--out-dir', fx.out, '--changed-files', fx.changedFiles],
      ['gate', '--mode', 'layer', '--cwd', fx.wt, '--base', 'nope', '--baseline', 'HEAD', '--out-dir', fx.out],
      ['gate', '--mode', 'full', '--cwd', fx.wt, '--base', 'development', '--baseline', 'HEAD', '--out-dir', fx.out, '--ship-mode', 'inline', '--changed-files', fx.changedFiles, '--runstate', join(fx.root, 'missing.json')],
    ]) {
      const e = run(args);
      assert.equal(e.status, 2, args.join(' '));
      assert.equal(e.stdout, '', 'an error never prints a result');
    }
    assert.equal(existsSync(join(fx.out, 'result.json')), false);
    // An --ac id that would take another job's retry log name is refused; a look-alike is not.
    const ac = join(fx.root, 'ac.json');
    writeFileSync(ac, JSON.stringify([{ id: 1, sh: 'true' }, { id: '1.retry-1', sh: 'true' }]));
    const refused = fx.gate('full', ['--ac', ac]);
    assert.equal(refused.status, 2);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /\.retry-/);
    writeFileSync(ac, JSON.stringify([{ id: 'x.installer', sh: 'true' }, { id: 'a.retry-notes', sh: 'true' }]));
    const admitted = fx.gate('full', ['--ac', ac]);
    assert.notEqual(admitted.status, 2, admitted.stderr);
    assert.deepEqual(['ac-x.installer', 'ac-a.retry-notes'].map((n) => job(admitted.json, n).verdict), ['pass', 'pass']);

    // A usage error in a reused directory removes the earlier verdict before it is reported.
    assert.equal(existsSync(join(fx.out, 'result.json')), true);
    const stale = run(['gate', '--mode', 'full', '--cwd', fx.wt, '--base', '', '--baseline', 'HEAD', '--out-dir', fx.out]);
    assert.equal(stale.status, 2);
    assert.equal(existsSync(join(fx.out, 'result.json')), false, 'the earlier verdict in this directory is gone');

    const noTurbo = fx.gate('smoke', [], { FAKE_NPX_PROBE: '1' });
    assert.equal(noTurbo.status, 1);
    assert.deepEqual([job(noTurbo.json, 'smoke').verdict, job(noTurbo.json, 'smoke').attempts], ['error', 0]);
    assert.match(readFileSync(job(noTurbo.json, 'smoke').log, 'utf8'), /cannot be resolved/);

    const layer = fx.gate('layer');
    assert.equal(layer.status, 0, layer.stderr);
    assert.deepEqual(layer.json.jobs.map((j) => [j.name, j.verdict]), [['smoke', 'pass'], ['tests', 'pass'], ['drift', 'preexisting']]);
    assert.equal(layer.json.next, 'pass');
    assert.deepEqual(fx.calls().find((c) => c.key === 'vitest').args, ['--no-install', 'vitest', 'run', '--changed', layer.json.baseline], 'the tests job never installs a runner');

    fx.setPlan({ vitest: [{ exit: 1, out: ' FAIL  a.test.ts > x' }] });
    const red = fx.gate('layer');
    assert.equal(red.status, 1);
    assert.equal(red.json.next, 'epic-layer-build-failed');
    assert.equal(existsSync(join(fx.out, 'result.json')), true);
  } finally { fx.cleanup(); }
});
