/**
 * @file spec-review-panel.test.mjs
 * @description Spec-contract test for the narrowed review panel: 3d names the panel cap and the
 *   failure-over-time baseline (express keeps it), 3e step 7 runs `sf-route fix-trend` before the
 *   seam and round extensions and logs `fix-replan`, `triage` carries `epic_phase`, and 3g requires
 *   a `## Live dev run` section when `live_check.required`. The shared routing and backend docs
 *   carry the same seat. Pins key terms, never sentences.
 * @domain workflow-spec
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSpec, section } from './spec-text.mjs';

const SKILL = readSpec('skills/ship-task/SKILL.md');
const review3d = section(SKILL, /^#### 3d — Routed review/m, /^#### 3e/m);
const fix3e = section(SKILL, /^#### 3e/m, /^#### 3f — Build gate/m);
const step7 = section(fix3e, /^7\. /m, /^   All four are re-evaluated/m);
const pr3g = section(SKILL, /^#### 3g — Push \+ PR/m, /^### Stage 4/m);
const routing = section(readSpec('skills/shared/reviewer-routing.md'), /^## Baselines and gates/m, /^## Fix-round cold roster/m);
const backend = readSpec('skills/shared/review-backend.md');
const prompts = readSpec('skills/shared/reviewer-prompts.md');

const has = (text, term, where) => assert.ok(text.includes(term), `${where} must name "${term}"`);

test('P7-1: 3d names the panel cap and the failure-over-time baseline; express keeps it', () => {
  for (const term of ['panel cap', 'capped_out', 'failure-over-time', 'gates.failure_over_time', 'Express']) has(review3d, term, '3d');
  for (const term of ['Failure over time', 'FAILURE_OVER_TIME_TERMS', 'Panel cap', 'capped_out', 'live_check']) has(routing, term, 'reviewer-routing §Baselines and gates');
  for (const term of ['`failure-over-time`', 'frontier', '--routed-only']) has(backend, term, 'review-backend.md');
  has(prompts, '## Baseline reviewer 4 — failure over time', 'reviewer-prompts.md');
});

test('P7-2: 3e step 7 runs fix-trend first and re-plans at most once per phase', () => {
  for (const term of ['sf-route.mjs" fix-trend', '--log "$RUN_LOG"', 'replan=true', 'event=fix-replan', 'once per phase', 'sf-plan-fixer', 'SHIP_FIX_ROUND_CEILING']) {
    has(step7, term, '3e step 7');
  }
  assert.ok(step7.indexOf('fix-trend') < step7.indexOf('seam extension'), 'fix-trend runs before the seam extension');
  const ns = section(fix3e, /\*\*Round namespacing:\*\*/, /\*\*3\.5\./);
  has(ns, '`triage`', '3e Round namespacing');
});

test('P7-3: 3g requires a Live dev run section or the reason, when live_check.required', () => {
  for (const term of ['## Live dev run', 'live_check.required', 'route-build.json', 'event=live-dev-run', 'pr-questions.md', 'gh pr ready']) {
    has(pr3g, term, '3g');
  }
  const ready = pr3g.slice(pr3g.indexOf('gh pr ready'));
  has(ready, 'Live dev run', '3g ready-for-review rule');
});

test('3g offers the live smoke as an operator option and bounds what it may do', () => {
  const smoke = section(SKILL, /^#### Live smoke/m, /^### Stage 4/m);
  for (const term of ['smoke-test it for me', '§Live smoke', '$DEFERRED_LIVE']) has(pr3g, term, '3g');
  for (const term of ['dev_probe', 'sf-live-smoke.lock', 'kind:"live-smoke"', '--force', 'code identity', 'live-smoke.md', 'result=inconclusive', 'by=agent', 'until the next deploy', 'session dropped']) {
    has(pr3g, term, '3g §Live smoke');
  }
  has(smoke, 'dev only', '§Live smoke approval scope');
  has(section(SKILL, /^## Run state & resume/m, /Resume: a committed/m), 'deferred_live', 'runstate schema');
  const ac = section(SKILL, /^#### 3f\.5/m, /^#### 3f\.6/m);
  for (const term of ['DEFERRED_LIVE', 'deferred_live']) has(ac, term, '3f.5');
  has(section(SKILL, /^### Stage 2/m, /^### Stage 3/m), '`live:`', 'Stage 2 bounding');
});

test('P7 round-1 fixes: base config ref, cap exemption, re-plan exit contract, live-run answers', () => {
  const classifyCalls = SKILL.split('\n').filter((l) => /sf-route(\.mjs")? classify/.test(l));
  assert.ok(classifyCalls.length >= 5, classifyCalls.join('\n'));
  for (const l of classifyCalls) assert.ok(l.includes('--config-ref "origin/$BASE_BRANCH"'), `classify call without --config-ref: ${l}`);
  for (const term of ['cap_exempt', '## Review coverage']) has(review3d, term, '3d');
  for (const term of ['bucket1_high', 'warm+cold-panel', 'scope-expansion', 'epic_phase', 'plan-review-replan-r', 'route-replan-r', 'replan-r<n>/review-<role>.md', '--artifact-dir "$ARTIFACT_DIR/replan-r<n>"', 'cold-fallback', 'phase=implement', 'closure-exchange', 'reopened_ids', 'fix-replan-skipped']) {
    has(step7, term, '3e step 7');
  }
  const ns = section(fix3e, /\*\*Round namespacing:\*\*/, /\*\*3\.5\./);
  has(ns, 'fix-replan', '3e Round namespacing');
  for (const term of ['ran-pass', 'ran-fail', 'defer', 'gh pr ready --undo', '## Review coverage']) has(pr3g, term, '3g');
  has(prompts, 'guard you checked', 'reviewer-prompts.md §Baseline reviewer 4');
});
