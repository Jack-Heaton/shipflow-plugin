/**
 * @file tracker.test.mjs
 * @description Tests for tracker.mjs, the GitHub Issues backend of the tracker contract. A fake
 *   `gh` (first on PATH) records every argv + stdin to a JSONL log and answers from a JSON state
 *   file, so nothing reaches GitHub. Covers: the status label swap and the close on a terminal
 *   status, view parsing (status from `status:*` labels, tags exclude them, parent, sub-issues),
 *   comment mapping, the sticky Links comment (create, then PATCH in place), task create with
 *   --parent linking a sub-issue, and id parsing (`12`, `#12`, an issue URL).
 *   Run: node --test plugins/shipflow/scripts/__tests__/*.test.mjs
 * @domain workflow-tracker
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slug, statusFromLabels, statusLabel } from '../tracker.mjs';

const TRACKER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tracker.mjs');

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin }) + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const save = () => fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
const say = (x) => process.stdout.write(typeof x === 'string' ? x + '\\n' : JSON.stringify(x));
const [a, b] = args;
if (a === 'issue' && b === 'view') { const i = state.issues[args[2]]; if (!i) { process.stderr.write('not found'); process.exit(1); } say(i); }
else if (a === 'issue' && b === 'create') { const n = state.next++; save(); say('https://github.com/acme/repo/issues/' + n); }
else if (a === 'issue' && b === 'comment') { say('https://github.com/acme/repo/issues/' + args[2] + '#issuecomment-1'); }
else if (a === 'issue' || a === 'label' && b === 'create') { /* edit / close / reopen / label create */ }
else if (a === 'label' && b === 'list') { say(state.labels.map((name) => ({ name }))); }
else if (a === 'api') {
  const path = args.find((x) => x.startsWith('repos/') || x === 'user');
  if (path === 'user') say('octo');
  else if (/\\/parent$/.test(path)) { const p = state.parents[path.split('/')[4]]; if (!p) { process.stderr.write('HTTP 404'); process.exit(1); } say({ number: p }); }
  else if (/\\/sub_issues$/.test(path) && !args.includes('-X')) say(state.subs[path.split('/')[4]] || []);
  else if (/\\/comments\\?/.test(path)) say(state.comments[path.split('/')[4]] || []);
  else if (/\\/issues\\/\\d+$/.test(path)) { const n = Number(path.split('/')[4]); say({ id: 9000 + n, number: n }); }
  else say({});
}
`;

function fixture(state) {
  const root = mkdtempSync(join(tmpdir(), 'sf-tracker-'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'gh'), FAKE_GH);
  chmodSync(join(root, 'bin', 'gh'), 0o755);
  writeFileSync(join(root, 'state.json'), JSON.stringify({ next: 50, labels: [], issues: {}, parents: {}, subs: {}, comments: {}, ...state }));
  const env = {
    ...process.env,
    PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`,
    FAKE_GH_LOG: join(root, 'gh.log'),
    FAKE_GH_STATE: join(root, 'state.json'),
    SF_TRACKER_REPO: 'acme/repo',
  };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [TRACKER, ...args], { env, encoding: 'utf8', cwd: root });
    return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };
  const calls = () => {
    try {
      return readFileSync(join(root, 'gh.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { root, run, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const issue = (number, labels, extra = {}) => ({
  number, title: `Issue ${number}`, url: `https://github.com/acme/repo/issues/${number}`, state: 'OPEN', body: '## Branch\n`feat/x`\n',
  labels: labels.map((name) => ({ name })), ...extra,
});

test('status vocabulary: slugged labels round-trip to the lifecycle names', () => {
  assert.equal(slug('In Development'), 'in-development');
  assert.equal(statusLabel('development complete'), 'status:development-complete');
  assert.equal(statusFromLabels(['bug', 'status:ready-for-development']), 'ready for development');
  assert.equal(statusFromLabels(['bug']), null);
});

test('task status: swaps the status label, removes the stale one, and closes on shipped', () => {
  const fx = fixture({ issues: { 12: issue(12, ['bug', 'status:in-development']) }, labels: ['status:in-development'] });
  try {
    const r = fx.run('task', 'status', '12', 'development complete');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json, { id: '12', status: 'development complete' });
    const edit = fx.calls().find((c) => c.args[0] === 'issue' && c.args[1] === 'edit');
    assert.ok(edit.args.includes('status:development-complete'), edit.args);
    assert.deepEqual(edit.args.slice(edit.args.indexOf('--remove-label'), edit.args.indexOf('--remove-label') + 2), ['--remove-label', 'status:in-development']);
    assert.ok(fx.calls().some((c) => c.args[0] === 'label' && c.args[1] === 'create' && c.args[2] === 'status:development-complete'), 'a missing status label is created');
    assert.ok(!fx.calls().some((c) => c.args[1] === 'close'), 'a non-terminal status never closes');

    const shipped = fx.run('task', 'status', '#12', 'shipped');
    assert.equal(shipped.status, 0, shipped.stderr);
    const close = fx.calls().find((c) => c.args[1] === 'close');
    assert.deepEqual(close.args.slice(close.args.indexOf('--reason')), ['--reason', 'completed']);
  } finally { fx.cleanup(); }
});

test('task status: an unknown status is refused before any write; a closed issue reopens on a live status', () => {
  const fx = fixture({ issues: { 7: issue(7, ['status:shipped'], { state: 'CLOSED' }) } });
  try {
    const bad = fx.run('task', 'status', '7', 'done-ish');
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /unknown status/);
    assert.deepEqual(fx.calls(), []);
    assert.equal(fx.run('task', 'status', '7', 'blocked').status, 0);
    assert.ok(fx.calls().some((c) => c.args[1] === 'reopen'));
  } finally { fx.cleanup(); }
});

test('task view: status from labels, tags exclude status:*, parent and sub-issues mapped', () => {
  const fx = fixture({
    issues: { 30: issue(30, ['feature', 'status:planning', 'followup']) },
    parents: { 30: 29 },
    subs: { 30: [{ number: 31, title: 'Phase 1', html_url: 'https://github.com/acme/repo/issues/31', state: 'open', labels: [{ name: 'status:to-do' }] }] },
  });
  try {
    const r = fx.run('task', 'view', 'https://github.com/acme/repo/issues/30', '--subtasks');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.id, '30');
    assert.equal(r.json.status, 'planning');
    assert.deepEqual(r.json.tags, ['feature', 'followup']);
    assert.equal(r.json.parent, '29');
    assert.deepEqual(r.json.list, { id: 'acme/repo', name: 'acme/repo' });
    assert.ok(r.json.markdown.includes('## Branch'));
    assert.deepEqual(r.json.subtasks, [{ id: '31', name: 'Phase 1', status: 'to do', url: 'https://github.com/acme/repo/issues/31' }]);
    const noSubs = fx.run('task', 'view', '30');
    assert.equal(noSubs.json.subtasks, undefined);
    assert.equal(fx.run('task', 'view', 'not-an-id').status, 1);
  } finally { fx.cleanup(); }
});

test('task comments: mapped to {id, body, author, created_at}; --all paginates', () => {
  const fx = fixture({
    issues: { 5: issue(5, []) },
    comments: { 5: [{ id: 101, body: '**[ship-task · checkpoint]** resume: …', user: { login: 'octo' }, created_at: '2026-01-02T00:00:00Z' }] },
  });
  try {
    const r = fx.run('task', 'comments', '5', '--all');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json, { id: '5', comments: [{ id: '101', body: '**[ship-task · checkpoint]** resume: …', author: 'octo', created_at: '2026-01-02T00:00:00Z' }] });
    assert.ok(fx.calls()[0].args.includes('--paginate'));
  } finally { fx.cleanup(); }
});

test('task pr / branch: one sticky Links comment, created once then PATCHed in place', () => {
  const fx = fixture({ issues: { 9: issue(9, []) } });
  try {
    const pr = fx.run('task', 'pr', '9', '--url', 'https://github.com/acme/repo/pull/77');
    assert.equal(pr.status, 0, pr.stderr);
    assert.deepEqual(pr.json, { id: '9', field: 'GitHub PR', value: 'https://github.com/acme/repo/pull/77' });
    const created = fx.calls().find((c) => c.args[0] === 'issue' && c.args[1] === 'comment');
    assert.ok(created.stdin.startsWith('<!-- shipflow:links -->'), created.stdin);
    assert.match(created.stdin, /^- \*\*GitHub PR:\*\* https:\/\/github\.com\/acme\/repo\/pull\/77$/m);

    // The sticky comment now exists: the branch link edits it, keeping the PR line.
    const state = JSON.parse(readFileSync(join(fx.root, 'state.json'), 'utf8'));
    state.comments[9] = [{ id: 555, body: created.stdin, user: { login: 'octo' }, created_at: 'x' }];
    writeFileSync(join(fx.root, 'state.json'), JSON.stringify(state));
    const br = fx.run('task', 'branch', '9', '--url', 'https://github.com/acme/repo/tree/feat/x');
    assert.equal(br.status, 0, br.stderr);
    const patch = fx.calls().find((c) => c.args.includes('PATCH'));
    assert.ok(patch, 'the existing comment is edited, not duplicated');
    assert.ok(patch.args.includes('repos/acme/repo/issues/comments/555'));
    const body = patch.args.find((x) => x.startsWith('body='));
    assert.match(body, /GitHub PR:\*\* https:\/\/github\.com\/acme\/repo\/pull\/77/);
    assert.match(body, /GitHub Branch:\*\* https:\/\/github\.com\/acme\/repo\/tree\/feat\/x/);
    assert.equal(fx.calls().filter((c) => c.args[0] === 'issue' && c.args[1] === 'comment').length, 1);
  } finally { fx.cleanup(); }
});

test('task create: body via stdin, labels ensured, status set, --parent links a sub-issue by database id', () => {
  const fx = fixture({ issues: { 50: issue(50, []) } });
  try {
    writeFileSync(join(fx.root, 'body.md'), '## Requirements\nDo it.\n');
    const r = fx.run('task', 'create', '--title', 'Phase 2', '--body-file', join(fx.root, 'body.md'), '--status', 'to do', '--parent', '#40', '--tag', 'followup', '--list', 'ignored');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json, { id: '50', url: 'https://github.com/acme/repo/issues/50', name: 'Phase 2', status: 'to do' });
    const create = fx.calls().find((c) => c.args[1] === 'create' && c.args[0] === 'issue');
    assert.equal(create.stdin, '## Requirements\nDo it.\n');
    assert.ok(create.args.includes('followup'));
    const link = fx.calls().find((c) => c.args.includes('POST'));
    assert.ok(link.args.includes('repos/acme/repo/issues/40/sub_issues'), link.args);
    assert.ok(link.args.includes('sub_issue_id=9050'), 'the child is linked by its database id, not its number');
  } finally { fx.cleanup(); }
});

test('task edit: refuses an empty edit; status-only edits go through the label swap', () => {
  const fx = fixture({ issues: { 3: issue(3, ['status:to-do']) } });
  try {
    const none = fx.run('task', 'edit', '3');
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /nothing to change/);
    const s = fx.run('task', 'edit', '3', '--status', 'blocked');
    assert.equal(s.status, 0, s.stderr);
    assert.deepEqual(s.json, { id: '3', status: 'blocked' });
    assert.ok(!fx.calls().some((c) => c.args[1] === 'edit' && c.args.includes('--body-file')));
  } finally { fx.cleanup(); }
});
