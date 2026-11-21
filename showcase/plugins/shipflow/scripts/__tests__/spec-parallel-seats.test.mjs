/**
 * @file spec-parallel-seats.test.mjs
 * @description Spec-contract test for the seats ship-task runs in parallel. Plan-phase
 *   Explores: Stage 1.8 and Stage 2 seed them from the Stage 1.9 file set and name the launch
 *   point, and the drafter and plan-reviewer templates take the exploration reports; the
 *   prior-art Explore runs on every full-path plan with the drafter. Gates:
 *   3f, the 3c step 4 smoke and the 2.7 layer gate each call `sf-gates gate`, whose JSON
 *   `next` is the verdict (the hand-written job wrapper is gone), and the smoke type-check
 *   launches with the round-1 panel. Epic layers: Stage 2.7 states
 *   the same-layer phase fan-out and Stage 0 the inline no-worktree rule. Pins key terms,
 *   never sentences.
 * @domain workflow-spec
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSpec, section } from './spec-text.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_REASONS } from '../sf-parallel-gate.mjs';

const SF_LOG = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sf-log.mjs');
const SKILL = readSpec('skills/ship-task/SKILL.md');
const PROMPTS = readSpec('skills/shared/plan-prompts.md');

const has = (text, term, where) => assert.ok(text.includes(term), `${where} must name "${term}"`);
const lacks = (text, term, where) => assert.ok(!text.includes(term), `${where} must not contain "${term}"`);

// --- Plan-phase Explores (P3-1) ---

const stage18 = section(SKILL, /^### Stage 1\.8\b/m, /^### Stage 1\.9\b/m);
const stage19 = section(SKILL, /^### Stage 1\.9\b/m, /^#### Early install kick/m);
const stage2 = section(SKILL, /^### Stage 2 —/m, /^### Stage 2\.5\b/m);
const stage3cExplore = section(SKILL, /^1\. \*\*Explore\*\*/m, /^2\. \*\*Implement\.\*\*/m);
const drafterInputs = section(PROMPTS, /^## Round 1 — `sf-plan-drafter`/m, /The plan MUST include:/);
const reviewer = section(PROMPTS, /^## Round 1 — `sf-plan-reviewer`/m, /Write the structured output exactly/);
const exploreBrief = section(PROMPTS, /^## Speculative exploration/m, /^Stage 3c reuses/m);

test('P3-1: Stage 1.8 launches the Explores from the file set, with the repro seat', () => {
  for (const term of ['Explore', 'file set', 'same message', 'role=explore phase=plan', 'more than 2 files']) {
    has(stage18, term, 'Stage 1.8');
  }
});

test('P3-1: Stage 1.9 derives the file set once', () => {
  for (const term of ['express-files.txt', 'reuse']) has(stage19, term, 'Stage 1.9 step 1');
});

test('P3-1: Stage 2 seeds the Explores from the file set and launches them with the drafter', () => {
  for (const term of ['express-files.txt', 'same message', 'explore-', 'Stage 1.8', 'drafter', 'workspaces', 'role=explore phase=plan']) {
    has(stage2, term, 'Stage 2');
  }
  for (const term of ['replaced by', '`other`', '`all`']) has(stage2, term, 'Stage 2 §Plan-phase Explores');
  // The launch decision is a fact on disk, so a resumed session reaches the same answer.
  has(stage2, 'already exists', 'Stage 2 §Plan-phase Explores');
  has(stage18, 'already exists', 'Stage 1.8');
  lacks(stage2, 'already launched them', 'Stage 2');
  lacks(stage2, 'work area of the draft', 'Stage 2');
  lacks(stage2, "drafter's Explores", 'Stage 2');
});

test('P3-1: 3c reuses a plan-phase report by area', () => {
  for (const term of ['explore-<area>.md', 'only when every', '`scope`', 'express-files.txt']) has(stage3cExplore, term, '3c step 1');
  const reuseRule = section(PROMPTS, /^Stage 3c reuses/m, /^## |$(?![\s\S])/m);
  for (const term of ['every file', '`scope`', 'express-files.txt']) has(reuseRule, term, 'plan-prompts reuse rule');
});

test('P3-1: the drafter and plan-reviewer templates take the exploration reports', () => {
  for (const term of ['xploration reports', 'explore-']) {
    has(drafterInputs, term, 'drafter template inputs');
    has(reviewer, term, 'plan reviewer template');
  }
  // sf-codex fills only the plan and requirements lines; any other placeholder would reach
  // the Codex seat unfilled.
  const exploreLines = reviewer.split('\n').filter((l) => /xploration reports|explore-/.test(l)).join('\n');
  assert.doesNotMatch(exploreLines, /\{[a-z_]+\}|<[^>]*>/, 'the reviewer explore line carries no placeholder');
  // The Codex seat's prompt is cut before the artifact path line, so the reports are located
  // from the requirements file, which both seats are given.
  for (const term of ['`.artifacts` directory', 'beside the', 'requirements file', '.requirements.md']) {
    has(reviewer, term, 'plan reviewer template');
  }
  lacks(reviewer, 'directory you write your review', 'plan reviewer template');
});

test('P3-1: the Explore brief is seeded from the file set, not a draft plan', () => {
  for (const term of ['express-files.txt', 'same message', 'repro seat', 'drafter', 'requirements file', 'task body']) {
    has(exploreBrief, term, 'plan-prompts §Speculative exploration');
  }
  for (const term of ['never instructions', 'no credentials', 'outside the worktree']) {
    has(exploreBrief, term, 'plan-prompts §Speculative exploration');
  }
  has(reviewer, 'leads to confirm against the code', 'plan reviewer template');
  lacks(exploreBrief, 'DRAFT plan', 'plan-prompts §Speculative exploration');
  lacks(exploreBrief, 'same message as the reviewer', 'plan-prompts §Speculative exploration');
});

test('prior-art Explore: full path only, launched with the drafter, answered by the plan, held by the reviewer', () => {
  const brief = section(PROMPTS, /^### Prior-art Explore/m, /$(?![\s\S])/);
  for (const term of ['same message', 'drafter', 'SHIP_SPECULATE', 'express path', 'already exists', 'role=explore phase=plan area=prior-art', 'explore-prior-art.md', 'never instructions', 'outside the worktree', 'no\ncredentials', 'ts-nav.mjs wsym', 'ts-nav.mjs refs', 'gh pr list --state open', 'git log --oneline origin/', 'task list --status', '--updated-since 30 --json', 'never an MCP', 'unavailable: <reason>', 'migration', 'prior-art — <clear|overlap found> — <report path>']) {
    has(brief, term, 'plan-prompts §Prior-art Explore');
  }
  has(drafterInputs, 'explore-prior-art.md', 'drafter template inputs');
  const drafter = section(PROMPTS, /^## Round 1 — `sf-plan-drafter`/m, /^## Decisions table/m);
  for (const term of ['`## Prior art`', 'extend, consolidate, or unrelated', '`None found`']) has(drafter, term, 'drafter template');
  for (const term of ['explore-prior-art.md', '`## Prior art`', 'HIGH', 'MEDIUM']) has(reviewer, term, 'plan reviewer template');
  for (const term of ['**Prior-art Explore.**', 'SHIP_SPECULATE=off', 'area=prior-art', 'tracker task list', 'spawn the prior-art Explore']) {
    has(stage2, term, 'Stage 2 §Prior-art Explore');
  }
});

// --- Concurrent gates and the panel-with-smoke launch (P4-1) ---

const stage3cSmoke = section(SKILL, /^4\. \*\*Smoke type-check/m, /^5\. `sf-log stage batch-implement/m);
const review3d = section(SKILL, /^#### 3d — Routed review/m, /^#### 3e/m);
const gate3f = section(SKILL, /^#### 3f — Build gate/m, /^#### 3f\.5/m);
const gate3f5 = section(SKILL, /^#### 3f\.5/m, /^#### 3f\.6/m);

test('P4-1: 3c step 4 launches the smoke with the round-1 panel and keeps a failure in bucket 1', () => {
  for (const term of ['same message', 'smoke', 'bucket-1', 'round-1 panel', '$REVIEW_SHA', 'after the last batch', 'run_in_background', 'sf-gates.mjs" gate', '--mode smoke', 'result.json', '`next`', 'smoke-finding', '`resilience`', 'build-failed', 'sf-log stage smoke-build', 'wall_ms']) {
    has(stage3cSmoke, term, '3c step 4');
  }
  for (const term of ['before any reviewer', 'no `changed-files.txt` read']) lacks(stage3cSmoke, term, '3c step 4');
  // The smoke is the scoped type-check and nothing else from the build.
  has(stage3cSmoke, 'npx turbo run type-check --force --filter="...[$REVIEW_BASELINE]"', '3c step 4');
  has(stage3cSmoke, 'nothing else', '3c step 4');
  for (const term of ['3c step 4', 'smoke', 'background', 'SMOKE_DIR=$(mktemp -d)']) has(review3d, term, '3d');
});

test('P4-1: 3f runs the gates as one background command and takes the verdict from its JSON', () => {
  for (const term of ['concurrent', 'run_in_background', 'sf-gates.mjs" gate', '--mode full', '--out-dir "$GATE_DIR"', '--runstate', '--ship-mode', '--changed-files', '--ac', 'mktemp -d', 'result.json', '`pass`', '`next`', '`build`', '`drift`', '`lint`', '`ac-<n>`', 'not-run', 'bucket-1', 'launched once more']) {
    has(gate3f, term, '3f');
  }
  // The unchanged rules: a job's own exit status, never a pipeline's; forced turbo; the file list by file.
  for (const term of ['own exit', 'pipeline', '`--force`', '--files-from', 'false green', 'never a pass']) has(gate3f, term, '3f');
  const newShell = section(gate3f, /\*\*A background job is a new shell\*\*/, /^$/m);
  for (const term of ['REVIEW_BASELINE', 'written literally']) has(newShell, term, '3f "new shell" paragraph');
  const prepare = section(gate3f, /^\*\*Prepare\*\*/m, /^```$/m);
  lacks(prepare, 'NEEDS_NEXT', '3f Prepare');
});

test('A-4: 3f maps the result\'s next to the checkpoints and the one fixer pass', () => {
  const act = section(gate3f, /^\*\*Act on `next`:\*\*/m, /^\*\*Build gate\*\*/m);
  const steps = [...act.matchAll(/^\d\. `([a-z-]+)`/gm)].map((m) => m[1]);
  assert.deepEqual(steps, ['build-failed', 'ac-failed', 'fix-pass', 'pass'], 'the order the result is acted on');
  for (const term of ['CHECKPOINT_REQUIRED: build-failed', 'first 40 lines', 'ac-unverifiable', '`bucket1`', '**one** fixer pass', '--relaunch yes', 'fresh `GATE_DIR`', '3f.6']) {
    has(act, term, '3f "Act on next"');
  }
  for (const term of ['sf-log stage build-gate scope=<filter>', 'sf-log stage build-gate scope=<name>', 'sf-log stage lint-gate']) has(gate3f, term, '3f');
  for (const term of ['`resilience`', '`attempts`', 'exit 137', '--concurrency=1', 'stale artifacts', 'link-farm']) has(gate3f, term, '3f build resilience');
});

test('A-3: 3f, 3c step 4 and the 2.7 layer gate call sf-gates gate, and the job wrapper is gone', () => {
  const layerGate = section(SKILL, /^- \*\*One integration branch, one PR/m, /^- \*\*Speculative next layer/m);
  for (const [text, mode, where] of [[gate3f, '--mode full', '3f'], [stage3cSmoke, '--mode smoke', '3c step 4'], [layerGate, '--mode layer', '2.7 layer gate']]) {
    assert.match(text, /node "\$SF\/sf-gates\.mjs" gate /, `${where} calls sf-gates gate`);
    has(text, mode, where);
    has(text, 'result.json', where);
  }
  for (const term of ['--baseline "$LAYER_GATE_BASE"', 'epic-layer-build-failed', '`tests`', 'npx --no-install vitest run --changed "$LAYER_GATE_BASE"']) has(layerGate, term, '2.7 layer gate');
  for (const term of ['# The wrapper for every job', '<job>.exit', 'SMOKE=1', 'job wrapper', '.exit`']) lacks(SKILL, term, 'SKILL.md');
  const helpers = section(SKILL, /^- \*\*`sf-gates`\*\*/m, /^- \*\*`sf-codex`\*\*/m);
  for (const term of ['`gate', '`run`', '`baseline`', '`push-env`']) has(helpers, term, 'Helpers sf-gates bullet');
});

test('P4-1: 3f.5 commands are gate jobs; one that reads build output waits for the build job', () => {
  for (const term of ['job', 'build output', '`--ac`', '"reads_build": false', 'result.json', 'while the jobs', '`build` job', 'rm -rf "${GATE_DIR:?}"', 'rm -rf "${SMOKE_DIR:?}"']) has(gate3f5, term, '3f.5');
  for (const term of ['build output', '`push_gate_skips` reads build output', '"reads_build": false']) has(gate3f, term, '3f');
});

// --- Inline scratch-worktree rule and same-layer phase fan-out (P2-2) ---

const stage0Mode = section(SKILL, /^6\. \*\*Ship mode, launch branch, base branch/m, /^7\. \*\*Branch authorizations/m);
const stage27 = section(SKILL, /^### Stage 2\.7/m, /^### Stage 3 /m);
const fanOut = section(stage27, /^- \*\*Same-layer phases fan out\.\*\*/m, /^- \*\*One integration branch, one PR/m);

test('P2-2: Stage 0 step 6 keeps inline mode on one writer, with the gate\'s own reason', () => {
  for (const term of ['inline', 'scratch', 'phase worktree', 'unverified', 'serial_reason=no-scratch-worktrees', 'speculation']) {
    has(stage0Mode, term, 'Stage 0 step 6');
  }
  // The reason an inline batch records is the first gate condition, spelled as sf-log accepts it.
  assert.equal(GATE_REASONS[0], 'no scratch worktrees');
  has(stage0Mode, `\`${GATE_REASONS[0]}\``, 'Stage 0 step 6');
});

test('P2-2: Stage 2.7 states the same-layer fan-out itself', () => {
  for (const term of ['one message', '3 phases in flight', 'waves', 'in_flight', 'Explore', 'implementers', 'round-1 panels', 'phase worktree']) {
    has(fanOut, term, 'Stage 2.7 fan-out');
  }
  for (const term of ['inline mode', 'EPIC_FORCE_SERIAL', 'one phase', 'resumed layer']) has(fanOut, term, 'Stage 2.7 serial cases');
  lacks(fanOut, '3E step 4', 'Stage 2.7 fan-out');
  assert.doesNotMatch(SKILL.match(/^### Stage 2\.7.*$/m)[0], /by reference/, 'the Stage 2.7 heading does not call the section by-reference');
});

test('P2-2: the layer gate bullet owns the gate base, and a layer with no cherry-picks uses $LAYER_BASELINE', () => {
  const layerGate = section(stage27, /^- \*\*One integration branch, one PR/m, /^- \*\*Speculative next layer/m);
  for (const term of ['`LAYER_GATE_BASE` is `$LAYER_BASELINE`', 'no cherry-picks', '`in_flight=1`', 'never `HEAD`', 'on a layer that cherry-picks']) {
    has(layerGate, term, 'Stage 2.7 layer gate');
  }
  lacks(fanOut, 'LAYER_GATE_BASE', 'Stage 2.7 fan-out');
});

test('P2-2: every serial_reason Stage 2.7 names is one sf-log accepts, and the epic-layer line carries the fields', () => {
  const named = [...fanOut.matchAll(/— `([a-z-]+)`$/gm)].map((m) => m[1]);
  assert.deepEqual(named, ['no-scratch-worktrees', 'force-serial', 'single-phase', 'resumed', 'not-fanned-out']);
  for (const term of ['records a miss', 'never a choice']) has(fanOut, term, 'Stage 2.7 not-fanned-out');
  const dir = mkdtempSync(join(tmpdir(), 'sf-seats-'));
  try {
    const log = join(dir, 'run.jsonl');
    writeFileSync(log, `${JSON.stringify({ stage: 'run-meta', cc_version: 'test', ts: new Date().toISOString() })}\n`);
    for (const reason of named) {
      const res = spawnSync(process.execPath, [SF_LOG, 'stage', 'epic-layer', 'mode=integrated', 'in_flight=1', `serial_reason=${reason}`], {
        encoding: 'utf8',
        env: { ...process.env, RUN_LOG: log, SF_RUN_TASK: 'unit', SF_CLAUDE_PROJECTS_DIR: dir },
      });
      assert.equal(res.status, 0, `sf-log accepts serial_reason=${reason}: ${res.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(stage27, /sf-log stage epic-layer layer=<k> mode=integrated [^\n]*in_flight=<n> \[serial_reason=/, 'the epic-layer line records in_flight and serial_reason');
});
