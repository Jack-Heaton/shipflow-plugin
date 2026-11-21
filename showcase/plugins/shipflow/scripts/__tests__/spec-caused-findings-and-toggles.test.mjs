/**
 * @file spec-caused-findings-and-toggles.test.mjs
 * @description Spec-contract test for two triage/plan rules: a finding the change caused or
 *   made more likely is bucket 1, never filed (scope-policy Rule 5a, ship-task 3e, the
 *   goal-post carve-out); and a new feature toggle needs an operator answer with the three
 *   options none / remote config parameter / admin page switch (ship-task §Interview policy, the plan
 *   gate, the plan drafter and reviewer prompts). Pins key terms, never sentences.
 * @domain workflow-spec
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSpec, section } from './spec-text.mjs';

const SKILL = readSpec('skills/ship-task/SKILL.md');
const scopePolicy = readSpec('skills/shared/scope-policy.md');
const planPrompts = readSpec('skills/shared/plan-prompts.md');
const policy = section(SKILL, /\*\*Interview policy\*\*/, /\*\*Notifications\.\*\*/);
const triage = section(SKILL, /^#### 3e /m, /\*\*Scope expansion is not a finding\.\*\*/);
const rule5a = section(scopePolicy, /\*\*Rule 5a /, /\*\*Rule 6 /);
const rule5 = section(scopePolicy, /\*\*Rule 5 /, /\*\*Rule 5a /);

const has = (text, term, where) => assert.ok(text.includes(term), `${where} must name "${term}"`);

test('Rule 5a: caused or worsened by the change is bucket 1', () => {
  for (const term of ['bucket 1', 'Regression against the base', 'made more likely', 'never filed']) has(rule5a, term, 'scope-policy Rule 5a');
  has(rule5, 'Rule 5a', 'scope-policy Rule 5 (goal-post carve-out)');
  for (const term of ['Rule 5a', 'regression', 'never bucket 3']) has(triage, term, 'ship-task 3e triage');
});

test('feature toggles need an operator answer with three options', () => {
  for (const term of ['New feature toggles', 'CANONICAL', 'AskUserQuestion', 'None', 'Remote config parameter', 'Admin page switch', '## Decisions']) {
    has(policy, term, 'ship-task §Interview policy');
  }
  has(SKILL, 'a new feature toggle (§Interview policy', 'ship-task plan gate');
  for (const term of ['Feature toggles', '## Open Questions', 'remote config parameter', 'admin page switch']) has(planPrompts, term, 'plan drafter prompt');
  has(planPrompts, 'feature toggle', 'plan reviewer prompt');
});
