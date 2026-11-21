/**
 * @file spec-plan-realism.test.mjs
 * @description Spec-contract test for plan realism: the drafter's `## Minimal design` (with a
 *   size estimate) and `## Resources and state` inventory, the plan reviewer's realism checks in
 *   §3.3 and rewritten §3.5, and the scoring rubric's severity for each realism pattern. Pins
 *   key terms inside the section that must carry them, never sentences.
 * @domain workflow-spec
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSpec, section } from './spec-text.mjs';

const drafter = section(readSpec('skills/shared/plan-prompts.md'), /The plan MUST include:/, /^## Decisions table/m);
const REVIEW = readSpec('skills/review-plan/SKILL.md');
const review31 = section(REVIEW, /^#### 3\.1\b/m, /^#### 3\.2\b/m);
const review33 = section(REVIEW, /^#### 3\.3\b/m, /^#### 3\.4\b/m);
const review35 = section(REVIEW, /^#### 3\.5\b/m, /^#### 3\.6\b/m);
const RUBRIC = readSpec('skills/review-plan/scoring-rubric.md');
const rubricHigh = section(RUBRIC, /^## HIGH/m, /^## MEDIUM/m);
const rubricMedium = section(RUBRIC, /^## MEDIUM/m, /^## LOW/m);

const has = (text, term, where) => assert.ok(text.includes(term), `${where} must name "${term}"`);

test('P6-1: the drafter asks for a minimal design with a size estimate and a resources-and-state inventory', () => {
  for (const term of ['## Resources and state', 'Minimal design', 'lines of code', 'round-trips', 'durable state', '(P<n>)', 'repository rule']) {
    has(drafter, term, 'plan-prompts drafter list');
  }
});

test('P6-2: review-plan checks realism in §3.3 and resources and state in §3.5', () => {
  for (const term of ['Minimal design', 'size estimate', 'repository rule', '§3.1']) has(review33, term, 'review-plan §3.3');
  for (const term of ['confirmed', 'rules out']) has(review31, term, 'review-plan §3.1');
  for (const term of ['Resources and state', 'fan-out', 'FIFO', 'durable state', 'IDs']) {
    has(review35.toLowerCase(), term.toLowerCase(), 'review-plan §3.5');
  }
  assert.ok(!review35.includes('invent scale'), 'review-plan §3.5 must not tell the reviewer to ignore scale');
  // Dimension numbering stays 3.1–3.11: the plan-review schema and sf-codex render by number.
  for (let n = 1; n <= 11; n++) assert.match(REVIEW, new RegExp(`^#### 3\\.${n} — `, 'm'), `dimension 3.${n}`);
});

test('P6-3: the rubric sets a severity for each realism pattern', () => {
  for (const term of ['fan-out', 'durable state', 'rules out']) has(rubricHigh, term, 'scoring-rubric §HIGH');
  for (const term of ['FIFO', 'durable state', 'cites no premise', 'repository rule']) has(rubricMedium, term, 'scoring-rubric §MEDIUM');
  assert.ok(!rubricHigh.includes('FIFO'), 'FIFO without a stated reason is MEDIUM, not HIGH');
  assert.ok(!rubricHigh.includes('cites no premise'), 'a missing premise citation alone is MEDIUM, not HIGH');
});
