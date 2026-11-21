/**
 * @file spec-audit-log.test.mjs
 * @description Spec-contract test for the ship-* audit-log rules: every runstate commit stages the
 *   ledger with a guarded `git add -f --`, only from the worktree that holds it; dirty probes exclude
 *   the run's own bookkeeping; a resumed run appends to the runstate's recorded log through
 *   `sf-log init --resume`. Pins key terms, never sentences.
 * @domain workflow-spec
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSpec, section } from './spec-text.mjs';

const SKILL = readSpec('skills/ship-task/SKILL.md');
const runState = section(SKILL, /^## Run state & resume/m, /^## CHECKPOINT_REQUIRED/m);
const EPIC = readSpec('skills/ship-task/epic.md');
const PHASE = readSpec('skills/shared/phase-contract.md');
const ACCOUNTING = readSpec('skills/shared/spawn-accounting.md');

const has = (text, term, where) => assert.ok(text.includes(term), `${where} must name "${term}"`);

const STAGE_LEDGER = 'git add -f -- "$RUN_LOG"';
const LEDGER_GUARD = 'case "$RUN_LOG" in "$WT_PATH"/docs/plans/*.jsonl)';
const LEDGER_GUARD_MISS = '*) echo "WARN: ledger $RUN_LOG not staged" >&2;; esac';
// Anchored to the top level: a cwd-relative `.` narrows the probe to the launch subdirectory.
const DIRTY_EXCLUDES = "-- ':/' ':(top,exclude)docs/plans/*.jsonl' ':(top,exclude)docs/plans/*.runstate.json'";

test('P2-1: the runstate commit rule stages the audit log, forced, from the ledger\'s own worktree only', () => {
  for (const term of [STAGE_LEDGER, LEDGER_GUARD, LEDGER_GUARD_MISS, 'log_path', 'sf-log cursor', '$WT_PATH', '$PHASE_WT']) has(runState, term, 'ship-task §Run state & resume');
  has(PHASE, STAGE_LEDGER, 'phase-contract.md commit list');
});

test('P2-1: the run\'s own bookkeeping never makes a tree dirty', () => {
  has(runState, DIRTY_EXCLUDES, 'ship-task §Run state & resume');
  const stage0 = section(SKILL, /\*\*Clean launch tree\.\*\*/, /\*\*Run preflight\*\*/);
  has(stage0, DIRTY_EXCLUDES, 'ship-task Stage 0 clean-tree probe');
  const reuse = section(SKILL, /^#### Worktree \(both modes\)/m, /^ARTIFACT_DIR=/m);
  has(reuse, DIRTY_EXCLUDES, 'ship-task 1B reuse probe');
  has(PHASE, DIRTY_EXCLUDES, 'phase-contract.md');
  for (const [name, text] of [['ship-task', SKILL], ['epic.md', EPIC], ['phase-contract.md', PHASE]]) {
    assert.ok(!/':\(exclude\)docs\/plans/.test(text), `${name} must not carry a cwd-relative dirty-probe exclude`);
  }
  assert.doesNotMatch(EPIC, /status --short\)"/, 'epic.md has no unexcluded dirty probe');
});

test('P2-2: a resumed run appends to the recorded log via sf-log init --resume', () => {
  has(runState, 'init --resume', 'ship-task §Run state & resume');
  has(SKILL, 'init --resume "$RUNSTATE"', 'ship-task adopt step');
  assert.doesNotMatch(runState, /new log's first event/, 'the resumed run no longer starts a new log');
});

test('P2-3..P2-5: spawn-accounting documents enforced roles, de-cumulated continuations and missing usage', () => {
  for (const term of ['Enforced at write', 'phase=fix', 'usage_missing', 'usage_basis', 'tokens_cumulative']) has(ACCOUNTING, term, 'spawn-accounting.md');
  const cont = section(ACCOUNTING, /^## Continuations/m, /^## Run metadata/m);
  has(cont, 'agent_id', 'spawn-accounting.md §Continuations');
});
