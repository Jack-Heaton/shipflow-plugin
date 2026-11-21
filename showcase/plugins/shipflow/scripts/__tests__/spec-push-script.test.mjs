/**
 * @file spec-push-script.test.mjs
 * @description Spec-contract test for the scripted push and PR mechanics: ship-task 3g, the 2.7
 *   layer push and the checkpoint push call `sf-push`, the stack submit is followed by
 *   `--push no`, `gh pr edit` is gone, safety rule 1 is unchanged, and repo-config.md documents
 *   the `push.verified` key; `--arms skip` is stated once with its conditions, 3g maps
 *   `test_arms` and the runstate's `arms_owed` to what is owed, the link-back is written
 *   once per PR, and the two hook input names appear in no file of any plugin but sf-push,
 *   its tests and its docs. Pins key terms, never sentences — safety rule 1 excepted, whose text
 *   is the contract.
 * @domain workflow-spec
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSpec, section } from './spec-text.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SKILL = readSpec('skills/ship-task/SKILL.md');
const push3g = section(SKILL, /^#### 3g — Push \+ PR/m, /^#### Live smoke/m);
const layerPush = section(SKILL, /\*\*One integration branch, one PR/, /sf-log stage epic-layer layer=/);
const runState = section(SKILL, /^## Run state & resume/m, /^## CHECKPOINT_REQUIRED/m);
const checkpoint = section(SKILL, /^## CHECKPOINT_REQUIRED/m, /^## Safety rules/m);
const safety = section(SKILL, /^## Safety rules/m, /^## Cost note/m);
const linkBack = section(SKILL, /^## PR link-back/m, /^## Follow-up tasks/m);
const helpers = section(SKILL, /^## Helpers/m, /^\*\*Spawn accounting\.\*\*/m);
const preflight = section(readSpec('skills/shared/run-preflight.md'), /^## Push-gate baseline/m, /^## Review backend probe/m);
const repoConfig = readSpec('skills/shared/repo-config.md');

const has = (text, term, where) => assert.ok(text.includes(term), `${where} must name "${term}"`);

test('B-6: 3g, the 2.7 layer push and the checkpoint push call sf-push', () => {
  for (const term of ['sf-push.mjs" --kind final', 'run_in_background', '--body-file', '--task-status', 'verified', 'body_verified', 'mergeable', 'CONFLICTING', 'gh pr ready']) {
    has(push3g, term, '3g');
  }
  has(layerPush, 'sf-push.mjs" --kind layer', '2.7 layer push');
  has(checkpoint, 'sf-push.mjs" --kind checkpoint', '§CHECKPOINT_REQUIRED');
  has(runState, 'sf-push.mjs" --kind checkpoint', '§Run state & resume');
  has(runState, 'CHECKPOINT_PERSIST_FAILED', '§Run state & resume');
  has(runState, 'verified', '§Run state & resume');
  has(helpers, '**`sf-push`**', '§Helpers');
});

test('B-6: the stack submit stays in 3g and is followed by --push no', () => {
  const lines = push3g.split('\n');
  const stack = lines.findIndex((l) => l.includes('gh stack submit'));
  assert.ok(stack >= 0, '3g keeps the stack submit line');
  has(lines.slice(stack, stack + 3).join('\n'), '--push no', '3g, beside the stack line');
});

test('B-3: the body is never updated with gh pr edit', () => {
  assert.ok(!SKILL.includes('gh pr edit'), 'SKILL.md must not name gh pr edit');
  has(push3g, 'gh api', '3g');
  has(readSpec('scripts/sf-push.mjs'), "'-X', 'PATCH'", 'sf-push.mjs');
});

test('B-6: safety rule 1 is unchanged', () => {
  has(safety, '1. **Never merge; never let an unclean run produce a mergeable PR.** Drafts until clean.', '§Safety rules');
});

test('the link-back is sf-push\'s tracker result; push-env still covers every other push', () => {
  for (const term of ['sf-push', 'tracker', '--task-status', '--note', 'ready for testing', 'fail-soft']) has(linkBack, term, '§PR link-back');
  for (const term of ['sf-push.mjs', '--kind layer|final|checkpoint', 'verified', 'gh stack submit', 'push-env --runstate']) has(preflight, term, 'run-preflight §Push-gate baseline');
});

test('B-5: repo-config.md documents the push.verified key', () => {
  for (const term of ['`push`', 'verified', 'SF_PUSH_LOG', 'sf-push']) has(repoConfig, term, 'repo-config.md');
});

test('C-5: --arms skip is stated once, with its conditions; the layer push and the report text refer to it', () => {
  for (const term of ['--arms skip', 'stack', 'implement-task', 'review-task-code', '--arms run', 'test arms: not run on <from>..<to>', 'skipped-checkpoint']) {
    has(checkpoint, term, '§CHECKPOINT_REQUIRED');
  }
  has(layerPush, '--kind layer --arms skip', '2.7 layer push');
  has(layerPush, 'CHECKPOINT_REQUIRED', '2.7 layer push');
  assert.ok(!push3g.includes('--arms'), 'the final push takes no --arms');
});

test('C-5: 3g maps test_arms to what is owed', () => {
  for (const term of ['test_arms', 'no-ref-pushed', 'pushed_sha', 'skipped-checkpoint', 'unconfirmed', 'stage=3g', 'draft', 'remediating']) has(push3g, term, '3g');
  for (const term of ['--arms skip', 'test_arms', 'merge-base']) has(preflight, term, 'run-preflight §Push-gate baseline');
  has(repoConfig, 'pass its environment', 'repo-config.md push.verified row');
});

test('W1: arms_owed is committed with every skipping push and decides what 3g owes', () => {
  for (const term of ['arms_owed=true', 'arms_owed=false', 'commit']) has(layerPush, term, '2.7 layer push');
  for (const term of ['arms_owed=true', 'arms_owed=false', 'records a `pr_topology.kind`', 'commit being pushed']) has(checkpoint, term, '§CHECKPOINT_REQUIRED');
  for (const term of ['arms_owed', '§CHECKPOINT_REQUIRED']) has(runState, term, '§Run state & resume');
  for (const term of ['arms_owed=false', '`arms_owed` is `true`', 'present and not a boolean', 'an absent key is `false`', 'tracker task comment "$TASK_ID"', '`skipped-checkpoint` or `null`: no call ends it', '`error` included', 'skipped-arms-unconfirmed', '--push no', '<range_base>..<pushed_sha>', 'tracker task status "$TASK_ID" remediating', 'push_gate_skips']) {
    has(push3g, term, '3g');
  }
  const pkPush = readSpec('scripts/sf-push.mjs');
  has(pkPush, 'skipped-arms-unconfirmed', 'sf-push.mjs');
  assert.ok(!pkPush.includes('arms_owed'), 'sf-push never reads or writes arms_owed');
});

test('X3: the link-back is written once, signed with the entering skill', () => {
  has(push3g, '--skill "<entering skill>"', '3g');
  for (const term of ['--skill', 'review-task-code', 'no PR comment']) has(linkBack, term, '§PR link-back');
  const reviewTaskCode = readSpec('skills/review-task-code/SKILL.md');
  const advance = section(reviewTaskCode, /^### 3\. Advance the cursor/m, /^## Safety rules/m);
  has(reviewTaskCode, '--skill review-task-code', 'review-task-code step 2');
  has(advance, '· reviewed]**', 'review-task-code step 3');
  for (const term of ['· pr]**', 'tracker task pr', 'tracker task branch', 'tracker task status']) {
    assert.ok(!advance.includes(term), `review-task-code step 3 must not write "${term}" itself`);
  }
});

test('C-5: the two hook input names appear only in sf-push, its tests and its docs', () => {
  const allowed = [
    'scripts/sf-push.mjs', 'scripts/__tests__/sf-push.test.mjs', 'scripts/__tests__/spec-push-script.test.mjs',
    'skills/ship-task/SKILL.md', 'skills/ship-task/rationale.md', 'skills/shared/run-preflight.md', 'skills/shared/repo-config.md',
  ];
  const names = ['SF_HOOK_RUN_' + 'CHECKPOINT', 'SF_HOOK_RANGE_' + 'BASE'];
  const hits = [];
  // Every plugin, every directory: an agent, hook or schema file could set the inputs too.
  const pluginsRoot = resolve(PLUGIN_ROOT, '..');
  for (const entry of readdirSync(pluginsRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    const rel = relative(pluginsRoot, full).split(sep).join('/');
    if (rel.split('/').includes('node_modules')) continue;
    const text = readFileSync(full, 'utf8');
    if (names.some((n) => text.includes(n))) hits.push(rel);
  }
  assert.ok(hits.includes('shipflow/scripts/sf-push.mjs'), 'the scan reaches the plugin tree');
  assert.deepEqual(hits.filter((f) => !allowed.map((a) => `shipflow/${a}`).includes(f)), [], 'no other file may name the hook inputs');
  const pkPush = readSpec('scripts/sf-push.mjs');
  for (const n of names) has(pkPush, n, 'sf-push.mjs');
  has(pkPush, '==> pre-push: run checkpoint — SKIPPING the unit, frontend unit and jsdom arms', 'sf-push.mjs (the hook banner\'s first clause)');
});
