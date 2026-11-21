/**
 * @file sf-base-branch.test.mjs
 * @description Tests for sf-base-branch.mjs against a real bare origin: the precedence (runstate →
 *   --task-base → SF_BASE_BRANCH → .sf-developer target= → auto-detect), every auto-detect rung,
 *   the hard stop when an override is not on origin, --head skipping, --integration, --settings,
 *   the .sf-developer grammar rejections, and byte parity of the three plugin copies.
 *   Run: node --test plugins/shipflow/scripts/__tests__/sf-base-branch.test.mjs
 * @domain workflow-base-branch
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeveloperFile, resolveBaseBranch } from '../sf-base-branch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS = resolve(HERE, '..', '..', '..');
const RESOLVER = resolve(HERE, '..', 'sf-base-branch.mjs');
const G_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
delete G_ENV.SF_BASE_BRANCH;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: G_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/**
 * A bare origin carrying `branches` (the first is the bare's HEAD), cloned to `wt` on a local
 * `work` branch. `noOriginHead` deletes refs/remotes/origin/HEAD in the clone.
 */
function fixture({ branches = ['development', 'feature/x'], noOriginHead = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sf-base-'));
  roots.push(root);
  const seed = join(root, 'seed');
  execFileSync('git', ['init', '-q', '-b', branches[0], seed], { env: G_ENV });
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'base');
  for (const b of branches.slice(1)) git(seed, 'branch', b);
  const bare = join(root, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, bare], { env: G_ENV });
  const wt = join(root, 'wt');
  execFileSync('git', ['clone', '-q', bare, wt], { env: G_ENV });
  git(wt, 'checkout', '-q', '-b', 'work');
  if (noOriginHead) git(wt, 'remote', 'set-head', 'origin', '-d');
  return { root, wt };
}

const devFile = (fx, text) => writeFileSync(join(fx.wt, '.sf-developer'), text);

function run(fx, args = [], env = {}) {
  const res = spawnSync(process.execPath, [RESOLVER, '--cwd', fx.wt, ...args], { encoding: 'utf8', env: { ...G_ENV, ...env } });
  return { status: res.status, out: res.stdout, err: res.stderr };
}
function ok(fx, args, env) {
  const r = run(fx, args, env);
  assert.equal(r.status, 0, r.err);
  return r.out.trim();
}
function fails(fx, args, env, ...needles) {
  const r = run(fx, args, env);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.out}${r.err}`);
  assert.equal(r.out, '', 'nothing on stdout on error');
  for (const n of needles) assert.ok(r.err.includes(n), `stderr should name ${n}: ${r.err}`);
  return r.err;
}
function runstate(fx, obj) {
  const p = join(fx.root, 'task-1.runstate.json');
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}

test('target= only in .sf-developer, no SF_BASE_BRANCH → the target (source file)', () => {
  const fx = fixture();
  devFile(fx, 'ana\ntarget=feature/x\n');
  assert.equal(ok(fx), 'feature/x');
  assert.deepEqual(resolveBaseBranch({ cwd: fx.wt, env: {} }), { branch: 'feature/x', source: 'file' });
});

test('target-only file (line 1 is key=value) resolves the target', () => {
  const fx = fixture();
  devFile(fx, 'target=feature/x\n');
  assert.equal(ok(fx), 'feature/x');
});

test('SF_BASE_BRANCH beats the file target', () => {
  const fx = fixture({ branches: ['development', 'feature/x', 'feature/y'] });
  devFile(fx, 'ana\ntarget=feature/x\n');
  assert.equal(ok(fx, [], { SF_BASE_BRANCH: 'feature/y' }), 'feature/y');
});

test('an empty SF_BASE_BRANCH counts as unset', () => {
  const fx = fixture();
  assert.equal(ok(fx, [], { SF_BASE_BRANCH: '' }), 'development');
});

test('auto-detect rungs: development, then develop, then origin/HEAD, then main/master/trunk', () => {
  assert.equal(ok(fixture({ branches: ['main', 'development', 'develop'] })), 'development');
  assert.equal(ok(fixture({ branches: ['main', 'develop'] })), 'develop');
  assert.equal(ok(fixture({ branches: ['release', 'main'] })), 'release', 'origin/HEAD beats main');
  assert.equal(ok(fixture({ branches: ['other', 'master'], noOriginHead: true })), 'master');
  assert.equal(ok(fixture({ branches: ['other', 'trunk'], noOriginHead: true })), 'trunk');
});

test('a name-only .sf-developer leaves auto-detect unchanged', () => {
  const fx = fixture();
  devFile(fx, 'ana\n');
  assert.equal(ok(fx), 'development');
});

test('an override missing on origin exits 1 naming the branch and its source (env, file, task-base)', () => {
  const fx = fixture();
  fails(fx, [], { SF_BASE_BRANCH: 'feat/gone' }, 'feat/gone', 'SF_BASE_BRANCH', 'git fetch origin');
  devFile(fx, 'ana\ntarget=feat/lost\n');
  fails(fx, [], {}, 'feat/lost', join(fx.wt, '.sf-developer'));
  fails(fx, ['--task-base', 'feat/nowhere'], {}, 'feat/nowhere', '## Base branch');
});

test('a runstate base_branch missing on origin exits 1 naming the runstate path', () => {
  const fx = fixture();
  const p = runstate(fx, { base_branch: 'feat/old' });
  fails(fx, ['--runstate', p], {}, 'feat/old', p);
});

test('resume: runstate base_branch=A wins over a later .sf-developer target=B (AC-5)', () => {
  const fx = fixture({ branches: ['development', 'feat/a', 'feat/b'] });
  devFile(fx, 'ana\ntarget=feat/b\n');
  const p = runstate(fx, { task_id: '1', base_branch: 'feat/a' });
  assert.equal(ok(fx, ['--runstate', p]), 'feat/a');
  assert.equal(resolveBaseBranch({ cwd: fx.wt, env: {}, runstate: p }).source, 'runstate');
});

test('runstate beats --task-base, which beats SF_BASE_BRANCH', () => {
  const fx = fixture({ branches: ['development', 'feat/a', 'feat/b', 'feat/c'] });
  const p = runstate(fx, { base_branch: 'feat/a' });
  assert.equal(ok(fx, ['--runstate', p, '--task-base', 'feat/b'], { SF_BASE_BRANCH: 'feat/c' }), 'feat/a');
  assert.equal(ok(fx, ['--task-base', 'feat/b'], { SF_BASE_BRANCH: 'feat/c' }), 'feat/b');
  const noBase = runstate(fx, { task_id: '1' });
  assert.equal(ok(fx, ['--runstate', noBase, '--task-base', 'feat/b']), 'feat/b', 'runstate without base_branch falls through');
  assert.equal(ok(fx, ['--runstate', join(fx.root, 'absent.json')]), 'development', 'a missing runstate file is not an error');
  assert.equal(ok(fx, ['--task-base', '']), 'development', 'an empty --task-base counts as absent');
});

test('a non-string runstate base_branch, or a runstate that is not a JSON object, exits 1', () => {
  const fx = fixture();
  fails(fx, ['--runstate', runstate(fx, { base_branch: 123 })], {}, 'base_branch is not a string');
  fails(fx, ['--runstate', runstate(fx, { base_branch: null })], {}, 'base_branch is not a string');
  fails(fx, ['--runstate', runstate(fx, '[1,2]')], {}, 'not a JSON object');
  fails(fx, ['--runstate', runstate(fx, '{oops')], {}, 'not valid JSON');
});

test('--head equal to an override skips it and falls to the next level', () => {
  const fx = fixture({ branches: ['development', 'feature/x'] });
  devFile(fx, 'ana\ntarget=feature/x\n');
  assert.equal(ok(fx, ['--head', 'feature/x']), 'development');
  assert.equal(ok(fx, ['--head', 'feature/x'], { SF_BASE_BRANCH: 'feature/x' }), 'development');
  // A skipped override is not origin-checked: a pushed-for-the-first-time head is fine.
  devFile(fx, 'ana\ntarget=feat/new\n');
  assert.equal(ok(fx, ['--head', 'feat/new']), 'development');
});

test('nothing found → exit 1 without --allow-current; the current branch with it', () => {
  const fx = fixture({ branches: ['other'], noOriginHead: true });
  fails(fx, [], {}, 'no base branch found');
  assert.equal(ok(fx, ['--allow-current']), 'work');
});

test('--integration ignores every override', () => {
  const fx = fixture({ branches: ['development', 'feat/a'] });
  devFile(fx, 'ana\ntarget=feat/missing\n');
  const p = runstate(fx, { base_branch: 'feat/a' });
  assert.equal(ok(fx, ['--integration', '--runstate', p, '--task-base', 'feat/a'], { SF_BASE_BRANCH: 'feat/gone' }), 'development');
});

test('grammar rejections exit 1 naming the file, the line and the key, never the contents', () => {
  const cases = [
    ['ana\ntargt=feature/x\n', 'line 2', 'unknown key'],
    ['ana\ntarget=feature/x\ntarget=feature/y\n', 'line 3', 'duplicate'],
    ['ana\nsecret-bare-line\n', 'line 2', 'key=value'],
    ['ana\ntarget=\n', 'line 2', 'target'],
    ['ana\ntarget=fe"x\n', 'line 2', 'target'],
    ['ana\ntarget=feat x\n', 'line 2', 'target'],
    ['ana\ntarget=-feat\n', 'line 2', 'target'],
    ['ana\ntarget=feat$(id)\n', 'line 2', 'target'],
  ];
  for (const [text, ...needles] of cases) {
    const fx = fixture();
    devFile(fx, text);
    const err = fails(fx, [], {}, join(fx.wt, '.sf-developer'), ...needles);
    assert.ok(!err.includes('secret-bare-line') && !err.includes('targt'), 'file contents and unknown keys are never printed');
    assert.throws(() => parseDeveloperFile(text));
  }
});

test('invalid override values exit 1 (env, task-base)', () => {
  const fx = fixture();
  fails(fx, [], { SF_BASE_BRANCH: 'a b' }, 'SF_BASE_BRANCH', 'invalid');
  fails(fx, ['--task-base', 'x\\y'], {}, 'invalid');
});

test('values that are not shell-safe words exit 1 at every level: leading -, $, backtick, ;, |', () => {
  const fx = fixture();
  for (const bad of ['-feature', 'x$(id)', 'x`id`', 'x;id', 'x|sh']) {
    fails(fx, ['--task-base', bad], {}, 'invalid');
    fails(fx, [], { SF_BASE_BRANCH: bad }, 'SF_BASE_BRANCH', 'invalid');
    const p = runstate(fx, { base_branch: bad });
    fails(fx, ['--runstate', p], {}, p, 'invalid');
    assert.throws(() => parseDeveloperFile(`target=${bad}\n`));
  }
  assert.equal(ok(fx, ['--task-base', 'feature/x']), 'feature/x');
});

test('parseDeveloperFile: name-only, name+target, target-only, empty, CRLF, blank lines', () => {
  assert.deepEqual(parseDeveloperFile('  ana  \n'), { developer: 'ana', target: undefined });
  assert.deepEqual(parseDeveloperFile('ana\ntarget = feature/x \n'), { developer: 'ana', target: 'feature/x' });
  assert.deepEqual(parseDeveloperFile('target=feature/x'), { developer: undefined, target: 'feature/x' });
  assert.deepEqual(parseDeveloperFile(''), { developer: undefined, target: undefined });
  assert.deepEqual(parseDeveloperFile('ana\r\n\r\ntarget=feature/x\r\n'), { developer: 'ana', target: 'feature/x' });
  assert.deepEqual(parseDeveloperFile('\ntarget=feature/x\n'), { developer: undefined, target: 'feature/x' });
});

test('--settings prints developer/target JSON with null for absent keys', () => {
  const fx = fixture();
  assert.deepEqual(JSON.parse(ok(fx, ['--settings'])), { developer: null, target: null });
  devFile(fx, 'ana\ntarget=feature/x\n');
  assert.deepEqual(JSON.parse(ok(fx, ['--settings'])), { developer: 'ana', target: 'feature/x' });
  devFile(fx, 'target=feature/x\n');
  assert.deepEqual(JSON.parse(ok(fx, ['--settings'])), { developer: null, target: 'feature/x' });
  devFile(fx, 'ana\nbogus=1\n');
  assert.ok(!fails(fx, ['--settings'], {}, 'line 2', 'unknown key').includes('bogus'), 'the unknown key is never printed');
});

test('.sf-developer is read from the toplevel of --cwd, even from a subdirectory', () => {
  const fx = fixture();
  devFile(fx, 'target=feature/x\n');
  mkdirSync(join(fx.wt, 'sub', 'dir'), { recursive: true });
  const r = spawnSync(process.execPath, [RESOLVER, '--cwd', join(fx.wt, 'sub', 'dir')], { encoding: 'utf8', env: G_ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'feature/x');
});

test('usage errors exit 2', () => {
  const fx = fixture();
  assert.equal(run(fx, ['--bogus']).status, 2);
  assert.equal(run(fx, ['positional']).status, 2);
  assert.equal(run(fx, ['--head']).status, 2);
  assert.equal(run(fx, ['--settings', '--integration']).status, 2);
});

test('the three plugin copies are byte-identical', () => {
  const canonical = readFileSync(join(PLUGINS, 'shipflow', 'scripts', 'sf-base-branch.mjs'));
  for (const plugin of ['shipflow', 'shipflow']) {
    const copy = readFileSync(join(PLUGINS, plugin, 'scripts', 'sf-base-branch.mjs'));
    assert.ok(canonical.equals(copy), `plugins/${plugin}/scripts/sf-base-branch.mjs differs from shipflow's — copy it byte-for-byte`);
  }
});
