/**
 * @file spec-operator-questions.test.mjs
 * @description Spec-contract test for the ship-task operator-question policy: non-blocking
 *   questions route to follow-ups and the PR-time list, blocking ones queue while unblocked work
 *   continues and are asked together, every wait is marked with operator-wait, and the direction
 *   review carries the not-found versus transient-error check. Pins key terms, never sentences.
 * @domain workflow-spec
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSpec, section } from './spec-text.mjs';

const SKILL = readSpec('skills/ship-task/SKILL.md');
const policy = section(SKILL, /\*\*Interview policy\*\*/, /\*\*Notifications\.\*\*/);
const checkpoint = section(SKILL, /\*\*Checkpoint convention\.\*\*/, /^## PR link-back/m);
const bucket2 = section(SKILL, /\*\*2 needs a human\*\*/, /\*\*3 out of/);

const has = (text, term, where) => assert.ok(text.includes(term), `${where} must name "${term}"`);

test('P1-1: LOW and policy questions route to follow-ups plus the PR-time list', () => {
  for (const [text, where] of [[policy, '§Interview policy'], [bucket2, '3e bucket 2']]) {
    for (const term of ['pr-questions.md', 'LOW', 'policy']) has(text, term, where);
  }
  assert.match(policy, /follow-up/i, '§Interview policy must route to follow-ups');
  has(policy, 'mid-run', '§Interview policy');
});

test('P1-2: blocking questions queue while unblocked work continues, and are asked together', () => {
  has(policy, 'operator-questions.md', '§Interview policy');
  for (const noun of ['other batches', 'epic phases', 'panels', 'closures', 'gates', 'follow-up filing', 'PR-body drafting']) {
    has(policy, noun, '§Interview policy (continuing work)');
  }
  has(policy, 'together', '§Interview policy');
});

test('P1-3 (spec half): operator-wait is required by the interview policy and the checkpoint convention', () => {
  has(policy, 'operator-wait', '§Interview policy');
  has(policy, 'operator-answered', '§Interview policy');
  has(checkpoint, 'operator-wait', 'Checkpoint convention');
});

test('P1-4: the direction review carries the not-found versus transient-error check', () => {
  const direction = section(readSpec('skills/shared/reviewer-prompts.md'), /^## Direction review/m, /^## Fixer prompt/m);
  has(direction, 'not-found', '§Direction review');
  has(direction, 'transient', '§Direction review');
  const targets = section(readSpec('agents/sf-direction-reviewer.md'), /^## Targets/m, /^## Evidence bar/m);
  has(targets, 'T5', 'sf-direction-reviewer §Targets');
});

test('P1-1: 3f.5 routes a missing dev server to the PR-time list, not a mid-run ask', () => {
  const ac = section(SKILL, /^#### 3f\.5/m, /\n#{3,4} /);
  has(ac, 'pr-questions.md', '3f.5');
  has(ac, 'Interview policy', '3f.5');
});
