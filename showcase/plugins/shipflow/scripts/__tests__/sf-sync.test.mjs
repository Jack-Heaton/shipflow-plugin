/**
 * @file sf-sync.test.mjs
 * @description Tests for sf-sync.mjs against a real bare remote: merge when behind (event logged,
 *   review_baseline recomputed), nothing to do when current, probe-only at phase points (tree
 *   untouched, probe=1 on the event), a conflicting merge left in progress with exit 3, --export
 *   shell form, usage errors, and migration-number collisions from the base's `.shipflow.json`
 *   (a config error is `migrations=error`, never 0). Run: node --test plugins/shipflow/scripts/__tests__/*.test.mjs
 * @domain workflow-integration-sync
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SF_SYNC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sf-sync.mjs');
const G_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: G_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const put = (dir, file, content) => { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), content); };

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** bare origin with `development` (plus `seedFiles`), a feature clone one commit ahead, and a helper to move the base. */
function fixture(seedFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sf-sync-'));
  roots.push(root);
  const seed = join(root, 'seed');
  execFileSync('git', ['init', '-q', '-b', 'development', seed], { env: G_ENV });
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  writeFileSync(join(seed, 'b.txt'), 'b\n');
  for (const [f, c] of Object.entries(seedFiles)) put(seed, f, c);
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'base');
  const bare = join(root, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, bare], { env: G_ENV });
  const wt = join(root, 'wt');
  execFileSync('git', ['clone', '-q', '-b', 'development', bare, wt], { env: G_ENV });
  git(wt, 'checkout', '-q', '-b', 'feat/x');
  writeFileSync(join(wt, 'feat.txt'), 'feat\n');
  git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'feat');
  const moveBase = (file, content) => {
    const w = join(root, `base-${Math.random().toString(16).slice(2, 8)}`);
    execFileSync('git', ['clone', '-q', '-b', 'development', bare, w], { env: G_ENV });
    put(w, file, content);
    git(w, 'add', '.'); git(w, 'commit', '-q', '-m', `base: ${file}`); git(w, 'push', '-q', 'origin', 'development');
    return git(w, 'rev-parse', 'HEAD');
  };
  const log = join(root, 'run.jsonl');
  writeFileSync(log, `${JSON.stringify({ stage: 'run-meta', ts: new Date().toISOString() })}\n`);
  return { root, wt, moveBase, log };
}

function sync(fx, args, env = {}) {
  const res = spawnSync(process.execPath, [SF_SYNC, '--cwd', fx.wt, '--base', 'development', ...args], { encoding: 'utf8', env: { ...G_ENV, RUN_LOG: fx.log, SF_RUN_TASK: 'unit', ...env } });
  let json = null;
  try { json = JSON.parse(res.stdout.trim().split('\n').pop()); } catch { /* --export or error */ }
  return { ...res, json };
}
const events = (fx) => readFileSync(fx.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.stage === 'integration-sync');

test('current tree: behind 0, no merge, event logged, review_baseline = merge-base', () => {
  const fx = fixture();
  const r = sync(fx, ['--at', '3d']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.behind, 0); assert.equal(r.json.merged, false); assert.equal(r.json.conflicts, 0);
  assert.equal(r.json.review_baseline, git(fx.wt, 'merge-base', 'HEAD', 'origin/development'));
  const ev = events(fx);
  assert.equal(ev.length, 1); assert.equal(ev[0].at, '3d'); assert.equal(ev[0].behind, 0); assert.equal(ev[0].probe, undefined);
});

test('behind: merges the base, logs merge_commit, and moves review_baseline to the new merge-base', () => {
  const fx = fixture();
  const oldBaseline = git(fx.wt, 'merge-base', 'HEAD', 'origin/development');
  const baseTip = fx.moveBase('c.txt', 'c\n');
  const before = git(fx.wt, 'rev-parse', 'HEAD');
  const r = sync(fx, ['--at', '3e']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.behind, 1); assert.equal(r.json.merged, true); assert.equal(r.json.conflicts, 0);
  assert.equal(r.json.sync_before, before);
  assert.notEqual(r.json.head, before, 'a merge commit landed');
  assert.equal(r.json.review_baseline, baseTip, 'merge-base is now the base tip, not the stale fork point');
  assert.notEqual(r.json.review_baseline, oldBaseline);
  const ev = events(fx).pop();
  assert.equal(ev.behind, 1); assert.equal(ev.merge_commit, r.json.head);
});

test('phase point is probe-only: tree untouched, probe=1 on the event; --probe forces the same anywhere', () => {
  const fx = fixture();
  fx.moveBase('c.txt', 'c\n');
  const before = git(fx.wt, 'rev-parse', 'HEAD');
  const r = sync(fx, ['--at', 'phase']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.behind, 1); assert.equal(r.json.probe, 'clean'); assert.equal(r.json.merged, false);
  assert.equal(git(fx.wt, 'rev-parse', 'HEAD'), before, 'no merge commit on a phase branch');
  assert.equal(events(fx).pop().probe, 1);
  const r2 = sync(fx, ['--at', '3g', '--probe']);
  assert.equal(r2.json.probe, 'clean'); assert.equal(git(fx.wt, 'rev-parse', 'HEAD'), before);
});

test('conflict: merge left in progress, conflicts = unmerged files, exit 3; probe reports the conflict without touching the tree', () => {
  const fx = fixture();
  writeFileSync(join(fx.wt, 'a.txt'), 'feature side\n');
  git(fx.wt, 'commit', '-q', '-am', 'feat edits a');
  fx.moveBase('a.txt', 'base side\n');
  const before = git(fx.wt, 'rev-parse', 'HEAD');
  const probe = sync(fx, ['--at', 'phase']);
  assert.equal(probe.status, 3);
  assert.equal(probe.json.probe, 'conflict'); assert.ok(probe.json.conflicts >= 1);
  assert.equal(git(fx.wt, 'rev-parse', 'HEAD'), before);
  assert.equal(git(fx.wt, 'status', '--porcelain'), '', 'probe leaves a clean tree');
  const merge = sync(fx, ['--at', '3f']);
  assert.equal(merge.status, 3);
  assert.equal(merge.json.merge_in_progress, true); assert.equal(merge.json.conflicts, 1);
  assert.match(git(fx.wt, 'status', '--porcelain'), /^UU a\.txt/m, 'the conflict is left for the caller\'s conflict rule');
  assert.equal(events(fx).pop().conflicts, 1);
});

test('--export prints eval-able assignments; layer= required at layer; unknown at refused; no RUN_LOG warns', () => {
  const fx = fixture();
  const r = sync(fx, ['--at', 'layer', '--layer', '2', '--export']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^SYNC_BEFORE='[0-9a-f]{40}'$/m);
  assert.match(r.stdout, /^BEHIND='0'$/m); assert.match(r.stdout, /^REVIEW_BASELINE='[0-9a-f]{40}'$/m); assert.match(r.stdout, /^PROBE='none'$/m);
  assert.equal(events(fx).pop().layer, 2);
  const noLayer = sync(fx, ['--at', 'layer']);
  assert.equal(noLayer.status, 2); assert.match(noLayer.stderr, /--layer <k> is required/);
  const bad = sync(fx, ['--at', '9z']);
  assert.equal(bad.status, 2); assert.match(bad.stderr, /--at must be one of/);
  const res = spawnSync(process.execPath, [SF_SYNC, '--cwd', fx.wt, '--base', 'development', '--at', '3d'], { encoding: 'utf8', env: { ...G_ENV, RUN_LOG: '' } });
  assert.equal(res.status, 0); assert.match(res.stderr, /RUN_LOG is not set/);
  assert.equal(events(fx).length, 1, 'nothing logged without RUN_LOG');
});

const MIGRATIONS = JSON.stringify({ migrations: [{ dir: 'db/migrations', pattern: '^db/migrations/(\\d{4})_[^/]*\\.sql$', renumber: 'rename to the next free number' }] });

test('migration collision: base and branch add the same number under different names → 1, on the probe and on the merge', () => {
  const fx = fixture({ '.shipflow.json': MIGRATIONS, 'db/migrations/0004_init.sql': '-- 4\n' });
  put(fx.wt, 'db/migrations/0005_branch.sql', '-- branch\n');
  git(fx.wt, 'add', '.'); git(fx.wt, 'commit', '-q', '-m', 'branch migration');
  fx.moveBase('db/migrations/0005_base.sql', '-- base\n');
  const probe = sync(fx, ['--at', 'phase']);
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(probe.json.migration_collisions, [{ number: '0005', dir: 'db/migrations', base: ['db/migrations/0005_base.sql'], branch: ['db/migrations/0005_branch.sql'] }]);
  assert.equal(events(fx).pop().migration_collisions, 1);
  const merge = sync(fx, ['--at', 'layer', '--layer', '1', '--export']);
  assert.equal(merge.status, 0, merge.stderr);
  assert.match(merge.stdout, /^MIGRATION_COLLISIONS='1'$/m);
  assert.match(merge.stdout, /^MIGRATIONS='declared'$/m);
  assert.match(merge.stdout, /^MIGRATION_COLLISIONS_JSON='\[\{"number":"0005".*"branch":\["db\/migrations\/0005_branch\.sql"\]\}\]'$/m);
  assert.match(merge.stdout, /^SYNC_MERGED='1'$/m);
  assert.equal(events(fx).pop().migration_collisions, 1);
});

test('base-only duplicate numbers are reported, never counted as collisions', () => {
  const fx = fixture({ '.shipflow.json': MIGRATIONS, 'db/migrations/0002_a.sql': '-- a\n', 'db/migrations/0002_b.sql': '-- b\n' });
  put(fx.wt, 'db/migrations/0003_x.sql', '-- x\n');
  git(fx.wt, 'add', '.'); git(fx.wt, 'commit', '-q', '-m', 'branch migration');
  const r = sync(fx, ['--at', '3d']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.migration_collisions.length, 0);
  assert.equal(r.json.base_duplicates.length, 1);
  assert.equal(r.json.base_duplicates[0].number, '0002');
  assert.equal(events(fx).pop().migration_collisions, 0);
});

test('undeclared migrations → no collision fields; an invalid base config is migrations=error, and the sync still runs', () => {
  const plain = fixture();
  const r = sync(plain, ['--at', '3d']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal('migration_collisions' in r.json, false);
  assert.equal('base_duplicates' in r.json, false);
  assert.equal('migration_collisions' in events(plain).pop(), false);
  const ex = sync(plain, ['--at', '3d', '--export']);
  assert.match(ex.stdout, /^MIGRATION_COLLISIONS='0'$/m);

  const bad = fixture({ '.shipflow.json': JSON.stringify({ migrations: 'db/migrations' }) });
  bad.moveBase('c.txt', 'c\n');
  const b = sync(bad, ['--at', '3e']);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.json.merged, true);
  assert.match(b.stderr, /warning: .*migrations must be an array/);
  assert.equal('migration_collisions' in b.json, false);
  assert.equal(b.json.migrations, 'error');
  assert.equal(events(bad).pop().migrations, 'error');
  assert.match(sync(bad, ['--at', '3e', '--export']).stdout, /^MIGRATIONS='error'$/m);
});

test('the base config decides: a branch that deletes its migrations declaration is still checked, from a subdirectory too', () => {
  const fx = fixture({ '.shipflow.json': MIGRATIONS, 'db/migrations/0004_init.sql': '-- 4\n' });
  put(fx.wt, 'db/migrations/0004_dup.sql', '-- dup\n');
  writeFileSync(join(fx.wt, '.shipflow.json'), '{}');
  git(fx.wt, 'add', '.'); git(fx.wt, 'commit', '-q', '-m', 'dup + drop the declaration');
  const res = spawnSync(process.execPath, [SF_SYNC, '--cwd', join(fx.wt, 'db'), '--base', 'development', '--at', '3d'], { encoding: 'utf8', env: { ...G_ENV, RUN_LOG: fx.log, SF_RUN_TASK: 'unit' } });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /differs from origin\/development/);
  const json = JSON.parse(res.stdout.trim());
  assert.equal(json.migrations, 'declared');
  assert.deepEqual(json.migration_collisions.map((c) => c.branch), [['db/migrations/0004_dup.sql']]);
});

test('a same-named migration added on both sides is a merge conflict (exit 3), not a collision', () => {
  const fx = fixture({ '.shipflow.json': MIGRATIONS });
  put(fx.wt, 'db/migrations/0005_same.sql', '-- branch\n');
  git(fx.wt, 'add', '.'); git(fx.wt, 'commit', '-q', '-m', 'branch migration');
  fx.moveBase('db/migrations/0005_same.sql', '-- base\n');
  const r = sync(fx, ['--at', '3f']);
  assert.equal(r.status, 3);
  assert.equal(r.json.merge_in_progress, true);
  assert.deepEqual(r.json.migration_collisions, []);
});
