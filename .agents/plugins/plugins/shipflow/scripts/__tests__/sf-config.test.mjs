/**
 * @file sf-config.test.mjs
 * @description Tests for sf-config.mjs loadRepoConfig: a valid `.shipflow.json`, an unknown key
 *   (warning, not a throw), a wrong type (throws), an absent file, and a cwd outside any git repo;
 *   tryLoadRepoConfig returns the error; loadRepoConfigAt reads the committed copy at a ref;
 *   the `live_check`, `review.cap_exempt` and `push.verified` shapes.
 *   Run: node --test plugins/shipflow/scripts/__tests__/sf-config.test.mjs
 * @domain workflow-repo-config
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRepoConfig, loadRepoConfigAt, tryLoadRepoConfig } from '../sf-config.mjs';

function withRepo(config, fn) {
  const root = mkdtempSync(join(tmpdir(), 'sf-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    if (config !== undefined) writeFileSync(join(root, '.shipflow.json'), typeof config === 'string' ? config : JSON.stringify(config));
    mkdirSync(join(root, 'sub'));
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const VALID = {
  push_gates: {
    setup: ['bash', 'scripts/link.sh'],
    suites: [
      { name: 'pg', run: ['npm', 'run', 'test:pg'], timeout_ms: 600000, skip_env: 'SF_SKIP_PG' },
      { name: 'gates', run: ['npm', 'run', 'test:gates'] },
    ],
  },
  manifest_drift: { name: 'test:gates', run: ['npm', 'run', 'test:gates'] },
  migrations: [{ dir: 'db/migrations', pattern: '^db/migrations/(\\d{4})_[^/]*\\.sql$', renumber: 'rename the file and its journal entry' }],
};

test('valid file: loaded from the git toplevel, even from a subdirectory, with no warnings', () => {
  withRepo(VALID, (root) => {
    const r = loadRepoConfig(join(root, 'sub'));
    assert.match(r.path, /\.shipflow\.json$/);
    assert.deepEqual(r.config, VALID);
    assert.deepEqual(r.warnings, []);
  });
});

test('unknown keys become warnings, not a throw', () => {
  withRepo({ ...VALID, future_key: 1, manifest_drift: { ...VALID.manifest_drift, extra: true } }, (root) => {
    const r = loadRepoConfig(root);
    assert.equal(r.warnings.length, 2);
    assert.ok(r.warnings.some((w) => w.includes('future_key')));
    assert.ok(r.warnings.some((w) => w.includes('manifest_drift') && w.includes('extra')));
  });
});

test('a wrong type or invalid JSON throws', () => {
  withRepo({ push_gates: { suites: [{ name: 'x', run: 'npm test' }] } }, (root) => {
    assert.throws(() => loadRepoConfig(root), /suites\[0\]\.run.*argv/);
  });
  withRepo({ migrations: 'db' }, (root) => assert.throws(() => loadRepoConfig(root), /migrations must be an array/));
  withRepo({ migrations: [{ dir: 'd', pattern: '^\\d+\\.sql$', renumber: 'r' }] }, (root) => {
    assert.throws(() => loadRepoConfig(root), /capture group/);
  });
  withRepo('{not json', (root) => assert.throws(() => loadRepoConfig(root), /invalid JSON/));
});

test('absent file → path null, empty config', () => {
  withRepo(undefined, (root) => {
    assert.deepEqual(loadRepoConfig(root), { path: null, config: {}, warnings: [] });
  });
});

test('not a git repo → path null, empty config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-'));
  try {
    writeFileSync(join(dir, '.shipflow.json'), JSON.stringify(VALID));
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() };
    const out = execFileSync(process.execPath, ['-e', `import('${new URL('../sf-config.mjs', import.meta.url).href}').then((m) => process.stdout.write(JSON.stringify(m.loadRepoConfig(${JSON.stringify(dir)}))))`], { encoding: 'utf8', env });
    assert.deepEqual(JSON.parse(out), { path: null, config: {}, warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tryLoadRepoConfig returns the error instead of throwing', () => {
  withRepo('{not json', (root) => {
    const r = tryLoadRepoConfig(root);
    assert.match(r.error, /invalid JSON/);
    assert.deepEqual(r.config, {});
  });
  withRepo(VALID, (root) => assert.equal(tryLoadRepoConfig(root).error, null));
});

test('loadRepoConfigAt: the committed copy at a ref, from a subdirectory; absent → undeclared; bad ref → throws', () => {
  const G = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  withRepo(VALID, (root) => {
    writeFileSync(join(root, 'sub', 'keep'), '');
    execFileSync('git', ['-C', root, 'add', '.'], { env: G });
    execFileSync('git', ['-C', root, 'commit', '-qm', 'c'], { env: G });
    writeFileSync(join(root, '.shipflow.json'), JSON.stringify({ migrations: [] }));
    const r = loadRepoConfigAt(join(root, 'sub'), 'HEAD');
    assert.deepEqual(r.config, VALID, 'the committed copy, not the working tree');
    assert.match(r.sha, /^[0-9a-f]{40}$/);
    execFileSync('git', ['-C', root, 'rm', '-q', '--cached', '.shipflow.json'], { env: G });
    execFileSync('git', ['-C', root, 'commit', '-qm', 'rm'], { env: G });
    assert.equal(loadRepoConfigAt(root, 'HEAD').path, null);
    assert.throws(() => loadRepoConfigAt(root, 'nope/branch'), /does not resolve/);
  });
});

test('live_check: { paths: [regex source], instructions } loads; a bad shape throws; an extra key warns', () => {
  const lc = { live_check: { paths: ['^services/worker/'], instructions: 'Deploy to dev and run one job end to end.' } };
  withRepo(lc, (root) => {
    const r = loadRepoConfig(root);
    assert.deepEqual(r.config.live_check, lc.live_check);
    assert.deepEqual(r.warnings, []);
  });
  withRepo({ live_check: { ...lc.live_check, owner: 'x' } }, (root) => {
    assert.ok(loadRepoConfig(root).warnings.some((w) => w.includes('live_check') && w.includes('owner')));
  });
  withRepo({ live_check: { paths: 'src/', instructions: 'x' } }, (root) => assert.throws(() => loadRepoConfig(root), /live_check\.paths/));
  withRepo({ live_check: { paths: [], instructions: 'x' } }, (root) => assert.throws(() => loadRepoConfig(root), /live_check\.paths/));
  withRepo({ live_check: { paths: ['('], instructions: 'x' } }, (root) => assert.throws(() => loadRepoConfig(root), /paths\[0\].*regex/));
  withRepo({ live_check: { paths: ['^src/'] } }, (root) => assert.throws(() => loadRepoConfig(root), /live_check\.instructions/));
  withRepo({ live_check: { ...lc.live_check, dev_probe: ['curl', '-fsS', 'https://dev.example.com/healthz'] } }, (root) => {
    const r = loadRepoConfig(root);
    assert.deepEqual(r.config.live_check.dev_probe, ['curl', '-fsS', 'https://dev.example.com/healthz']);
    assert.deepEqual(r.warnings, []);
  });
  withRepo({ live_check: { ...lc.live_check, dev_probe: 'curl -fsS https://dev.example.com/healthz' } }, (root) => assert.throws(() => loadRepoConfig(root), /live_check\.dev_probe/));
  withRepo({ live_check: ['^src/'] }, (root) => assert.throws(() => loadRepoConfig(root), /live_check must be an object/));
});

test('review.cap_exempt: an array of reviewer names loads; a bad shape throws', () => {
  withRepo({ review: { cap_exempt: ['ux-consistency-lead'] } }, (root) => {
    assert.deepEqual(loadRepoConfig(root).config.review.cap_exempt, ['ux-consistency-lead']);
  });
  withRepo({ review: { cap_exempt: 'ux-consistency-lead' } }, (root) => assert.throws(() => loadRepoConfig(root), /review\.cap_exempt/));
  withRepo({ review: { cap_exempt: [''] } }, (root) => assert.throws(() => loadRepoConfig(root), /cap_exempt\[0\]/));
});

test('push.verified: an argv loads; a wrong type throws; an unknown sub-key warns', () => {
  const push = { verified: ['bash', 'scripts/push-verified.sh'] };
  withRepo({ push }, (root) => {
    const r = loadRepoConfig(root);
    assert.deepEqual(r.config.push, push);
    assert.deepEqual(r.warnings, []);
  });
  withRepo({ push: {} }, (root) => assert.deepEqual(loadRepoConfig(root).warnings, []));
  withRepo({ push: { verified: 'bash scripts/push-verified.sh' } }, (root) => assert.throws(() => loadRepoConfig(root), /push\.verified.*argv/));
  withRepo({ push: { verified: [] } }, (root) => assert.throws(() => loadRepoConfig(root), /push\.verified.*argv/));
  withRepo({ push: ['bash'] }, (root) => assert.throws(() => loadRepoConfig(root), /push must be an object/));
  withRepo({ push: { ...push, retries: 2 } }, (root) => {
    assert.ok(loadRepoConfig(root).warnings.some((w) => w.includes('push') && w.includes('retries')));
  });
});
