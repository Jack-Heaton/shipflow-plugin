/**
 * @file spec-push-gates.test.mjs
 * @description Spec-contract test for push gates and migration collisions: the 2.7 integrated-layer
 *   gate and the 3f gate run the repo-declared manifest-drift check against the base, run-preflight's
 *   push-gate baseline asks one question whose answer is pinned in the runstate, every push the
 *   run executes goes through push-env, pre-existing is decided per check (no blanket exemption),
 *   and integration-sync fixes migration collisions at the layer sync before the next layer
 *   starts. Pins key terms, never sentences.
 * @domain workflow-spec
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSpec, section } from './spec-text.mjs';

const SKILL = readSpec('skills/ship-task/SKILL.md');
const layerGate = section(SKILL, /\*\*One integration branch, one PR/, /sf-log stage epic-layer layer=/);
const gate3f = section(SKILL, /^#### 3f — Build gate/m, /^#### 3f\.5/m);
const worktree = section(SKILL, /^#### Worktree \(both modes\)/m, /^### Stage 1\.9/m);
const runState = section(SKILL, /^## Run state & resume/m, /^## CHECKPOINT_REQUIRED/m);
const helpers = section(SKILL, /^- \*\*`sf-sync`\*\*/m, /^- \*\*`sf-route`\*\*/m);
const preflight = section(readSpec('skills/shared/run-preflight.md'), /^## Push-gate baseline/m, /^## Review backend probe/m);
const collisions = section(readSpec('skills/shared/integration-sync.md'), /^## Migration collisions/m, /^## Probe/m);
const repoConfig = readSpec('skills/shared/repo-config.md');

const has = (text, term, where) => assert.ok(text.includes(term), `${where} must name "${term}"`);

test('P4-2: the 2.7 integrated-layer gate and the 3f gate run the manifest-drift check from the base', () => {
  for (const [text, where] of [[layerGate, '2.7 layer gate'], [gate3f, '3f']]) {
    for (const term of ['manifest-drift', 'sf-gates.mjs', '--base', 'run-preflight.md', 'error']) has(text, term, where);
  }
  has(gate3f, 'push_gate_skips', '3f');
  has(gate3f, '--only', '3f');
});

test('A2: no blanket pre-existing exemption; pre-existing is a per-check predicate against the base', () => {
  assert.ok(!/approved as pre-existing|approved pre-existing/i.test(SKILL), 'SKILL carries no suite-name exemption');
  for (const term of ['--only', 'failing test identifier', 'base log', 'finding', 'epic-layer-build-failed', 'deliberate']) {
    has(preflight, term, 'run-preflight §Push-gate baseline');
  }
});

test('A3: every git push and gh stack submit in ship-task goes through push-env', () => {
  const pushes = [...SKILL.matchAll(/git push|gh stack submit/g)];
  assert.ok(pushes.length > 0);
  for (const m of pushes) {
    const before = SKILL.slice(Math.max(0, m.index - 80), m.index);
    assert.ok(before.includes('push-env --runstate'), `push at offset ${m.index} is not prefixed with push-env: …${SKILL.slice(m.index - 40, m.index + 20)}…`);
  }
  const stack3g = section(SKILL, /^#### 3g — Push \+ PR/m, /^#### Live smoke/m).split('\n').find((l) => l.includes('gh stack submit'));
  assert.ok(stack3g && stack3g.includes('push-env --runstate'), '3g keeps the stack submit, under push-env');
  const stage27 = section(SKILL, /^### Stage 2\.7/m, /^### Stage 3 /m);
  has(stage27, '`epic.md` 3E', 'SKILL 2.7 mapping');
  has(stage27, 'push-env', 'SKILL 2.7 mapping');
  has(preflight, 'checkpoint', 'run-preflight §Push-gate baseline');
});

test('A3: the split-phase pushes go through push-env and implement-task asks the queued skip question', () => {
  const implPush = section(readSpec('skills/implement-task/SKILL.md'), /^### 3\. Commit \+ push/m, /^### 4\. Report/m);
  for (const term of ['push-env --runstate', 'run-preflight.md', 'Push-gate baseline', 'question']) has(implPush, term, 'implement-task §3');
  has(readSpec('skills/review-task-code/SKILL.md'), 'push-env --runstate', 'review-task-code cursor push');
});

test('P4-1: run-preflight runs the repo-declared push suites against the base, with one pinned approval', () => {
  for (const term of ['sf-gates.mjs', 'baseline', 'preexisting_failures', 'push_gate_skips', 'push_gate_base_sha', 'push_gate_out',
    'skip_env', 'push-env', 'Interview policy', 'AskUserQuestion', 'operator-wait', '.shipflow.json', 'undeclared', 'unavailable', 'mktemp', 'linked_deps']) {
    has(preflight, term, 'run-preflight §Push-gate baseline');
  }
  assert.match(preflight, /\*\*one\*\* queued blocking question/i, 'the skip is one question');
  has(worktree, 'push-gate-kick', 'SKILL §Worktree');
  const kick = section(worktree, /^\*\*Push-gate baseline kick\*\*/m, /^\*\*Pickup ends current/m);
  has(kick, 'init --resume', 'SKILL §Worktree kick (adopt order)');
  has(preflight, 'init --resume', 'run-preflight kick (adopt order)');
  has(worktree, 'push_gate_skips', 'SKILL §Worktree');
  assert.ok(!SKILL.includes('sf-gates.mjs" baseline'), 'the kick command lives only in run-preflight');
  for (const key of ['push_gate_skips', 'push_gate_base_sha', 'push_gate_out']) has(runState, key, 'SKILL §Run state');
  for (const term of ['push_gates', 'suites', 'skip_env', 'manifest_drift', 'migrations', 'renumber']) has(repoConfig, term, 'repo-config.md');
});

test('P4-1: the plugin never hardcodes monorepo push commands in its scripts', () => {
  for (const file of ['scripts/sf-gates.mjs', 'scripts/sf-config.mjs', 'scripts/sf-sync.mjs']) {
    const src = readSpec(file);
    for (const term of ['test:gates', 'deploy-plan', 'packages/db/drizzle']) {
      assert.ok(!src.includes(term), `${file} must not hardcode "${term}"`);
    }
  }
});

test('P4-3: integration-sync ties migration collisions to the layer sync, before the next layer', () => {
  for (const term of ['$MIGRATION_COLLISIONS', '$MIGRATION_COLLISIONS_JSON', '$MIGRATIONS', 'renumber', 'layer', '$LAYER_BASELINE', 'phase', 'integration-conflict', 'base_duplicates', 'later phase', 'gh stack sync']) {
    has(collisions, term, 'integration-sync §Migration collisions');
  }
  has(helpers, '$MIGRATION_COLLISIONS', 'Helpers sf-sync bullet');
});
