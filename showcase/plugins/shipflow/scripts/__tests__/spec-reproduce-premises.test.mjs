/**
 * @file spec-reproduce-premises.test.mjs
 * @description Spec-contract test for ship-task's reproduce-first gate (Stage 1.8) and plan-time
 *   premises: the gate's trigger, real-environment rule, expected-failure commit and stop at
 *   diagnosis; the drafter's `## Premises`; the premises joining the plan-time operator
 *   exchange; and the plan reviewer's struck-premise check. Pins key terms, never sentences.
 * @domain workflow-spec
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSpec, section } from './spec-text.mjs';

const SKILL = readSpec('skills/ship-task/SKILL.md');
const stage18 = section(SKILL, /^### Stage 1\.8\b/m, /^### Stage 1\.9\b/m);
const stage1A = section(SKILL, /^### Stage 1A\b/m, /^### Stage 1B\b/m);
const stage1BTable = section(SKILL, /^5\. \*\*Entry stage from status/m, /^6\. \*\*Establish the working tree/m);
const runstate = section(SKILL, /^## Run state & resume/m, /^## CHECKPOINT_REQUIRED/m);
const fixTaskStage4 = section(readSpec('skills/fix-task/SKILL.md'), /^### Stage 4\b/m, /^- \*\*Minimum scope/m);
const planTaskPickup = section(readSpec('skills/plan-task/SKILL.md'), /^### 1\. Preflight/m, /^### 2\. /m);
const reviewTaskPlan = readSpec('skills/review-task-plan/SKILL.md');
const stage2Req = section(SKILL, /^### Stage 2 —/m, /^```$/m);
const afterLoop = section(SKILL, /\*\*After the loop\*\*/, /\*\*Clean pass\*\*/);
const checkpoints = section(SKILL, /^## CHECKPOINT_REQUIRED/m, /^## Safety rules/m);
const drafter = section(readSpec('skills/shared/plan-prompts.md'), /The plan MUST include:/, /^## Decisions table/m);
const review31 = section(readSpec('skills/review-plan/SKILL.md'), /^#### 3\.1\b/m, /^#### 3\.2\b/m);
const rubricHigh = section(readSpec('skills/review-plan/scoring-rubric.md'), /^## HIGH/m, /^## MEDIUM/m);

const has = (text, term, where) => assert.ok(text.includes(term), `${where} must name "${term}"`);

test('P5-1: Stage 1.8 reproduces in the real environment or stops at diagnosis', () => {
  for (const term of ['real environment', 'mock', 'expected-failure', 'not-reproduced', 'diagnosis', '[repro]']) {
    has(stage18, term, 'Stage 1.8');
  }
  // Trigger: the bug tag or a title-only match; epic parents are exempt and log kind=n/a.
  for (const term of ['`bug` tag', 'title', 'Epic parents', 'kind=n/a', 'reproduce-first']) {
    has(stage18, term, 'Stage 1.8 trigger');
  }
  // Stage 1.8 is an entry of its own, reached by every non-exempt path into planning.
  has(stage1A, 'Continue at Stage 1.8', 'Stage 1A');
  has(stage1BTable, 'Stage 1.8 (then 1.9)', 'Stage 1B entry table');
  has(runstate, '1.8|', 'runstate stage enum');
  has(fixTaskStage4, 'Stage 1.8', 'fix-task Stage 4');
  has(planTaskPickup, 'Stage 1.8', 'plan-task pickup');
  // Local-only environment; accept check before re-verify; the reset keeps the working tree.
  for (const term of ['shared or deployed', 'sf-route', 'prod=0', 'reset --keep', 'reason=<no-trigger|epic-parent|bundle-parent|resumed|waived>', 'origin/$BASE_BRANCH..HEAD']) {
    has(stage18, term, 'Stage 1.8');
  }
  assert.ok(!stage18.includes('reset --hard'), 'Stage 1.8 must not drop a repro with reset --hard');
  // Resume decides from runstate records only (acceptance or persisted waiver); a [repro] commit
  // with no record checkpoints; acceptance and the post-drop check share one allowlist.
  for (const term of ['repro.sha', 'repro.waived=', 'with neither record', 'status --porcelain', 'worktree-dirty', 'after the latest', '`**[ship-task · checkpoint]**`', 'outside the **allowlist**', 'nothing outside the allowlist']) {
    has(stage18, term, 'Stage 1.8');
  }
  assert.ok(!stage18.includes('without the record'), 'resume must not re-verify a [repro] commit that has no record');
  // The seat guard compares the runstate's `repro` and `push_gate_skips` keys; the orchestrator
  // writes other keys while the seat runs.
  has(stage18, "jq -cS '{repro, push_gate_skips}'", 'Stage 1.8 seat guard');
  has(stage18, 'right after that write', 'Stage 1.8 guard re-snapshot');
  assert.ok(!stage18.includes('hash-object'), 'Stage 1.8 must not hash the whole runstate');
  const step6 = section(stage18, /^6\. \*\*Not reproduced/m, /^7\. /m);
  assert.ok(!step6.includes('reproduce-first: waived'), 'step 6 resume line must not carry the waiver match string');
  has(runstate, 'repro:{sha,test,waived}', 'runstate schema');
  has(stage2Req, 'R-1', 'Stage 2 requirements paragraph');
  has(checkpoints, '`not-reproduced`', '§CHECKPOINT_REQUIRED table');
});

test('P5-2: the drafter lists premises and the plan-time exchange confirms them with Open Questions', () => {
  has(drafter, '## Premises', 'plan-prompts drafter list');
  for (const term of ['unconfirmed', 'confirmed', 'struck', '(P<n>)']) has(drafter, term, 'plan-prompts drafter list');
  for (const term of ['Premises', 'Open Questions', 'Interview policy', 'confirmed or', 'struck', 'max_rounds', 'plan-review-exhausted', 'scoped re-review', 'open-questions', 'after that repeat']) {
    has(afterLoop, term, 'Stage 2 "After the loop"');
  }
});

test('P5-2b: /review-task-plan blocks on unconfirmed premises', () => {
  has(reviewTaskPlan, 'unconfirmed `## Premises`', 'review-task-plan');
});

test('P5-3: the plan reviewer treats reliance on a struck premise as a finding', () => {
  for (const term of ['struck', 'premise', 'confirmed premise']) has(review31, term, 'review-plan §3.1');
  has(rubricHigh, 'struck', 'scoring-rubric §HIGH');
});
