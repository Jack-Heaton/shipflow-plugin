/**
 * @file spec-batch-parallelism.test.mjs
 * @description Spec-contract test for the 3b batch parallelism check: the plan drafter asks for
 *   per-step `scope:` and `depends-on:`, the plan reviewer checks both, and
 *   the ship-task 3b section names the fields sf-log's task-decomposition validator requires.
 *   Also the gate contract: the conditions the 3b section lists are exactly the reasons
 *   sf-log accepts (sf-parallel-gate.mjs), the drafter groups steps into work-streams, and
 *   ship-task 3b keeps one task per plan step. Pins key terms, never sentences.
 * @domain workflow-spec
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSpec, section } from './spec-text.mjs';
import { ALL_HOLD, GATE_REASONS } from '../sf-parallel-gate.mjs';

const PROMPTS = readSpec('skills/shared/plan-prompts.md');
const drafter = section(PROMPTS, /The plan MUST include:/, /^## Decisions table/m);
const reviewer = section(PROMPTS, /^## Round 1 — `sf-plan-reviewer`/m, /Write the structured output exactly/);
const taskStage3b = section(readSpec('skills/ship-task/SKILL.md'), /^#### 3b\b/m, /^#### 3c\b/m);
const bundlePath = section(readSpec('skills/ship-task/SKILL.md'), /^#### Bundle path/m, /^### Stage 2\b/m);

const has = (text, term, where) => assert.ok(text.includes(term), `${where} must name "${term}"`);

test('P3-2: the plan template asks for a scope and depends-on for each step', () => {
  for (const term of ['scope:', 'depends-on:', 'none']) has(drafter, term, 'drafter step bullet');
});

test('P3-3: the plan reviewer checks per-step scope and depends-on', () => {
  for (const term of ['scope:', 'depends-on:', 'DAG', 'overlapping scope', 'outside its scope']) {
    has(reviewer, term, 'plan reviewer template');
  }
});

test('P3-1 contract: the 3b section name the fields sf-log requires', () => {
  for (const [where, text] of [['ship-task 3b', taskStage3b]]) {
    for (const term of ['scope', 'seam_touched', 'parallelizable_reason', 'sf-route classify', 'all four hold', 'plan-files.txt']) {
      has(text, term, where);
    }
  }
  has(taskStage3b, 'depends-on:', 'ship-task 3b');
});

test('3b seam check passes scope paths positionally, never as a --files list file', () => {
  // `--files` names a newline-separated list file: given a path, sf-route reads that file's
  // contents as paths and never classifies it, so seam_touched reads false on seam batches.
  for (const [where, text] of [['ship-task 3b', taskStage3b], ['ship-task bundle path', bundlePath]]) {
    assert.ok(!/classify[^`]*--files </.test(text), `${where} must not pass paths to sf-route classify --files`);
  }
  for (const [where, text] of [['ship-task 3b', taskStage3b]]) {
    has(text, 'sf-route classify --cwd "$WT_PATH"', where);
    has(text, '--compact <batch scope files…>', where);
  }
});

test('3b fallback scope has a source on every path: files list, step union, express, bundle', () => {
  for (const term of ['## Files to modify / create', '**Files:**', 'express-files.txt', '`file:` lines']) {
    has(taskStage3b, term, 'ship-task 3b fallback');
  }
  assert.ok(!taskStage3b.includes('express.no_seam'), 'ship-task 3b derives seam_touched from sf-route classify only');
  // A bundle item's `file:` line is path:line; scope takes the path, and sf-route refuses the rest.
  const refused = ['holding a `:`', 'backtick', '`#L<digits>`', 'parenthesised note'];
  for (const term of ['path part', ...refused]) has(taskStage3b, term, 'ship-task 3b bundle scope');
  for (const term of ['one fixer per item', 'own scratch', "that item's findings only"]) has(bundlePath, term, 'ship-task bundle path');
});

test('P1-2: the drafter groups steps into work-streams and ship-task 3b never merges plan steps', () => {
  has(drafter, 'work-stream', 'drafter step bullet');
  for (const term of ['never merged', 'sf-route batches']) has(taskStage3b, term, 'ship-task 3b');
});

test('P1-3 contract: the gate conditions the 3b section lists are the reasons sf-log accepts', () => {
  for (const [where, text] of [['ship-task 3b', taskStage3b]]) {
    const listed = [...text.matchAll(/\breason `([^`]+)`/g)].map((m) => m[1]);
    assert.deepEqual(listed, GATE_REASONS, `${where} must list every gate reason once, in gate order`);
    has(text, `\`${ALL_HOLD}\``, where);
  }
});
