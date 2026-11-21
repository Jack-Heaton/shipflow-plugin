/**
 * @file spec-base-branch.test.mjs
 * @description Spec-contract test for the shared base-branch resolver: no skill or agent under
 *   plugins/ resolves the base inline (reads the override variable or probes development/develop
 *   itself); every resolver call stops on a non-zero exit with no fallback after it; ship-task,
 *   the companions carry the pickup, task-body and release rules; the
 *   eight reviewer agents stop when they have no base; every skill and agent file has balanced
 *   code fences (the call-site checks read bash blocks by fence). Pins key terms, never sentences.
 * @domain workflow-spec
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSpec, section } from './spec-text.mjs';

const PLUGINS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const rel = (abs) => relative(PLUGINS, abs).split(sep).join('/');
const readPlugin = (p) => readFileSync(join(PLUGINS, p), 'utf8');
const has = (text, term, where) => assert.ok(text.includes(term), `${where} must name "${term}"`);

// The one file allowed to name the override variable and the auto-detect rungs.
const ALLOWLIST = new Set(['shipflow/skills/shared/base-branch.md']);

// D10 guard patterns; \s spans line wraps in prose.
const INLINE_PATTERNS = [
  /SF_BASE_BRANCH/,
  /for \w+ in development\s+develop/,
  /`development`\/\s*`develop`\s+when\s+present/,
];

function walkMd(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walkMd(abs, out);
    else if (name.endsWith('.md')) out.push(abs);
  }
  return out;
}

function specFiles() {
  const files = [];
  for (const plugin of readdirSync(PLUGINS)) {
    const root = join(PLUGINS, plugin);
    if (!statSync(root).isDirectory()) continue;
    for (const sub of ['skills', 'agents']) {
      const dir = join(root, sub);
      try { if (statSync(dir).isDirectory()) walkMd(dir, files); } catch { /* plugin without that dir */ }
    }
  }
  return files;
}

export function inlineHits(text) {
  return INLINE_PATTERNS.filter((re) => re.test(text)).map(String);
}

const CALL = /\$\(node\s+"(?:\$\{CLAUDE_PLUGIN_ROOT\}\/scripts|\$SF)\/sf-base-branch\.mjs"/;

// Lines that invoke the resolver: every command substitution, plus any bash-fence line that runs it.
export function resolverCallLines(text) {
  const lines = text.split('\n');
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    const runs = CALL.test(line) || (inFence && /^\s*[^#\s].*\bnode\s+"[^"]*sf-base-branch\.mjs"/.test(line));
    if (runs) out.push(line);
  }
  return out;
}

export function stopProblem(line) {
  const tail = line.slice(line.indexOf('sf-base-branch.mjs'));
  if (/\|\|\s*(true|echo|:)\b/.test(tail)) return 'a fallback follows ||';
  if (!/\|\|\s*(\{[^}]*\b(exit|CHECKPOINT_REQUIRED)\b|exit\b)/.test(tail)) return 'no || stop (exit or CHECKPOINT_REQUIRED)';
  return null;
}

test('AC-1/D10: the guard patterns fire on inline copies, including a line-wrapped prose probe', () => {
  assert.ok(inlineHits('[ -n "$SF_BASE_BRANCH" ] && B="$SF_BASE_BRANCH"').length > 0);
  assert.ok(inlineHits('for b in development develop; do :; done').length > 0);
  assert.ok(inlineHits('prefers `development`/\n  `develop` when\n  present').length > 0);
  assert.equal(inlineHits('BASE_BRANCH=$(node "$SF/sf-base-branch.mjs") || exit 1').length, 0);
});

test('AC-1/D10: no skill or agent under plugins/ resolves the base inline', () => {
  const files = specFiles();
  assert.ok(files.length > 40, `expected the plugin skill and agent tree, found ${files.length} files`);
  const offenders = [];
  for (const abs of files) {
    const r = rel(abs);
    if (ALLOWLIST.has(r)) continue;
    const hits = inlineHits(readFileSync(abs, 'utf8'));
    if (hits.length) offenders.push(`${r}: ${hits.join(', ')}`);
  }
  assert.deepEqual(offenders, [], `inline base resolution outside skills/shared/base-branch.md:\n${offenders.join('\n')}`);
});

test('AC-3/D10: the stop check rejects a fallback and a missing stop', () => {
  assert.equal(stopProblem('B=$(node "$SF/sf-base-branch.mjs") || exit 1'), null);
  assert.equal(stopProblem('B=$(node "$SF/sf-base-branch.mjs" --head "$X") || { echo "CHECKPOINT_REQUIRED: base-branch-missing"; exit 1; }'), null);
  assert.ok(stopProblem('B=$(node "$SF/sf-base-branch.mjs") || true'));
  assert.ok(stopProblem('B=$(node "$SF/sf-base-branch.mjs") || echo development'));
  assert.ok(stopProblem('B=$(node "$SF/sf-base-branch.mjs")'));
});

test('AC-3/D10: every resolver call in a skill or agent stops on a non-zero exit', () => {
  const problems = [];
  let calls = 0;
  for (const abs of specFiles()) {
    for (const line of resolverCallLines(readFileSync(abs, 'utf8'))) {
      calls += 1;
      const p = stopProblem(line);
      if (p) problems.push(`${rel(abs)}: ${p}: ${line.trim()}`);
    }
  }
  assert.ok(calls >= 12, `expected the resolver call sites, found ${calls}`);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('D6: the call sites use the shared resolver', () => {
  for (const p of [
    'shipflow/skills/create-worktree/SKILL.md',
    'shipflow/skills/sync-branch/SKILL.md',
    'shipflow/skills/ship-task/SKILL.md',
    'shipflow/skills/cut-task/SKILL.md',
  ]) {
    assert.ok(CALL.test(readPlugin(p)), `${p} must call sf-base-branch.mjs`);
  }
  has(readPlugin('shipflow/skills/create-worktree/SKILL.md'), '--allow-current', 'create-worktree');
  for (const p of ['shipflow/skills/sync-branch/SKILL.md']) has(readPlugin(p), '--head', p);
});

test('D7/D6: ship-task §Worktree re-resolves at pickup and records the base; the stop is its own checkpoint', () => {
  const SKILL = readSpec('skills/ship-task/SKILL.md');
  const worktree = section(SKILL, /^#### Worktree \(both modes\)/m, /^### Stage 1\.9/m);
  for (const term of ['--runstate', '--task-base', '--head', 'PICKUP', 'git show "origin/$BRANCH:', 'base-branch-missing',
    'base_branch=', 'PERSIST_TARGET', 'base-branch.md', 'DEV_NAME', 'fresh-branch block']) {
    has(worktree, term, 'ship-task §Worktree');
  }
  const kick = section(worktree, /^\*\*Push-gate baseline kick\*\*/m, /^\*\*Pickup ends current/m);
  has(kick, 'base_branch="\\"$BASE_BRANCH\\""', 'ship-task §Worktree kick (JSON-quoted base record)');
  has(section(SKILL, /^## Run state & resume/m, /^## CHECKPOINT_REQUIRED/m), 'base_branch', 'ship-task §Run state');
  const stage1b = section(SKILL, /^### Stage 1B/m, /^#### Worktree/m);
  for (const term of ['## Base branch', '$TASK_BASE', 'PICKUP=1']) has(stage1b, term, 'ship-task Stage 1B');
  has(section(SKILL, /^### Stage 2\.7/m, /^### Stage 3 /m), '## Base branch', 'ship-task 2.7 subtask bodies');
  assert.match(section(SKILL, /^## CHECKPOINT_REQUIRED/m, /^## Safety rules/m), /^\| `base-branch-missing` \|/m, 'checkpoint table row');
  const stage0 = section(SKILL, /^6\. \*\*Ship mode, launch branch, base branch/m, /^7\. \*\*Branch authorizations/m);
  for (const term of ['preflight-failed', '--integration', 'new-task mode only']) has(stage0, term, 'ship-task Stage 0 step 6');
});

test('D7/3.6/L1: base-branch.md holds the pickup and fresh-branch blocks', () => {
  const doc = readSpec('skills/shared/base-branch.md');
  const pickup = section(doc, /^## Pickup rule/m, /^## Worktree name question/m);
  for (const term of ['--runstate', '--task-base', '--head "$BRANCH"', 'git show "origin/$BRANCH:', 'base-branch-missing',
    'PERSIST_TARGET', "grep -q -- '--target' scripts/create-worktree.sh", '--developer "$DEV_NAME"', 'WT_TARGET', 'base_branch=']) {
    has(pickup, term, 'base-branch.md §Pickup rule');
  }
  assert.ok(!/\|\|\s*(true|echo)\b/.test(pickup.slice(pickup.indexOf('sf-base-branch.mjs'))), 'no fallback after the pickup resolve');
  has(section(doc, /^## Worktree name question/m, /^## Task-body rule/m), '--settings', 'base-branch.md §Worktree name question');
});

test('P1: phase and scratch worktrees never re-resolve from their own checkout', () => {
  assert.ok(!readSpec('skills/shared/scratch-worktree.md').includes('sf-base-branch.mjs'), 'scratch-worktree.md');
  const epic3e = section(readSpec('skills/ship-task/epic.md'), /^## Stage 3E/m, /^## Pull-request topology/m);
  assert.ok(!epic3e.includes('sf-base-branch.mjs'), 'epic.md §3E');
});

test('D15: Issue bodies carry `## Base branch` and the pickup reads it', () => {
  const cut = readSpec('skills/cut-task/SKILL.md');
  has(section(cut, /^### 6\. /m, /^### 7\. /m), '## Base branch', 'cut-task §6 body');
  has(section(cut, /^### 7\. /m, /^### 8\. /m), '## Base branch', 'cut-task §7 bodies');
  has(section(cut, /^### 8\. /m, /^### 9\. /m), 'create-worktree', 'cut-task §8');
  const fix = readSpec('skills/fix-task/SKILL.md');
  has(fix, 'Stage 0 step 6', 'fix-task Stage 0');
  const bug = section(fix, /^### Stage 3 /m, /^### Stage 4 /m);
  for (const term of ['## Base branch', '--task-base', 'base-branch-missing']) has(bug, term, 'fix-task bug-subtask template');
  const phase = readSpec('skills/shared/phase-contract.md');
  for (const term of ['base_branch', '## Base branch', '$TASK_BASE']) has(phase, term, 'phase-contract');
});

test('AC-6/D8: the release rule is pinned in ship-task and its companions', () => {
  const SKILL = readSpec('skills/ship-task/SKILL.md');
  const link = section(SKILL, /^## PR link-back/m, /^## Follow-up tasks/m);
  for (const term of ['--integration', 'development complete', '**[ship-task · pr]**', '$BASE_BRANCH', '$INTEGRATION_BRANCH', 'final report', 'stacked layer']) {
    has(link, term, 'ship-task §PR link-back');
  }
  has(section(SKILL, /^## Status lifecycle/m, /^## PR link-back/m), 'release rule', 'ship-task status table');
  has(readSpec('skills/review-task-code/SKILL.md'), 'release rule', 'review-task-code');
  has(readSpec('skills/fix-task/SKILL.md'), 'release rule', 'fix-task Stage 5');
  const doc = section(readSpec('skills/shared/base-branch.md'), /^## Release rule/m, /$(?![\s\S])/);
  for (const term of ['--integration', 'development complete', 'INTEGRATION_BRANCH', 'hold such a task']) has(doc, term, 'base-branch.md §Release rule');
});

test('D9: the eight reviewer agents call the resolver and stop without a base', () => {
  for (const p of [
    'shipflow/agents/security-reviewer.md',
    'shipflow/agents/infra-reviewer.md',
    'shipflow/agents/ux-consistency-lead.md',
    'shipflow/agents/test-coverage-guardian.md',
    'shipflow/agents/frontend-reviewer.md',
    'shipflow/agents/backend-reviewer.md',
    'shipflow/agents/database-reviewer.md',
    'shipflow/agents/api-contract-reviewer.md',
  ]) {
    const text = readPlugin(p);
    for (const term of ['sf-base-branch.mjs', 'non-zero', 'stop', 'never assume']) has(text, term, p);
  }
});

test('H1: an epic records its base beside prd-sha and a resume resolves from it', () => {
  const task = readSpec('skills/ship-task/SKILL.md');
  const stage1a = section(task, /^### Stage 1A/m, /^### Stage 1B/m);
  for (const term of ['RECORDED_BASE=$(node "$SF/tracker.mjs" task comments', 'base: (?<b>\\\\S+)', 'parse rule',
    '--task-base "$RECORDED_BASE"', 'base-branch-missing']) has(stage1a, term, 'ship-task Stage 1A epic resume');
  has(section(task, /^### Stage 2\.7/m, /^### Stage 3 /m), 'base: $BASE_BRANCH', 'ship-task 2.7 checklist comment');
  const doc = section(readSpec('skills/shared/base-branch.md'), /^## Pickup rule/m, /^## Worktree name question/m);
  for (const term of ['base: <branch>', 'prd-sha:', 'command substitution', '--task-base "$RECORDED_BASE"']) has(doc, term, 'base-branch.md epic base rule');
  has(section(readSpec('skills/shared/base-branch.md'), /^## Task-body rule/m, /^## Release rule/m), "comment's `base:` line", 'base-branch.md parse rule names the epic base: line');
});

test('M1: branch values read from a task or issue body pass the parse rule before any assignment', () => {
  const rule = section(readSpec('skills/shared/base-branch.md'), /^## Task-body rule/m, /^## Release rule/m);
  for (const term of ['**Parse rule.**', '^[A-Za-z0-9._/-]+$', 'must not start with', 'base-branch-missing', 'single quotes']) {
    has(rule, term, 'base-branch.md §Task-body rule parse rule');
  }
  const task = readSpec('skills/ship-task/SKILL.md');
  const step3 = section(task, /^3\. \*\*Parse the body\*\*/m, /^4\. \*\*Epic detection\*\*/m);
  for (const term of ['parse rule', 'cut-task-failed', 'base-branch-missing', 'single quotes']) has(step3, term, 'ship-task Stage 1B step 3');
  has(readSpec('skills/shared/phase-contract.md'), 'parse rule', 'phase-contract Stage 1B');
  const bug = section(readSpec('skills/fix-task/SKILL.md'), /^### Stage 3 /m, /^### Stage 4 /m);
  has(bug, 'parse rule', 'fix-task Stage 3');
  assert.match(bug, /^PARENT_BASE='/m, 'fix-task assigns PARENT_BASE in single quotes');
});

// Problems with the fenced code blocks of one markdown text: a closing fence carrying trailing
// text (CommonMark reads it as content, so the block runs on) or a block left open at the end.
export function fenceProblems(text) {
  const problems = [];
  let open = null;
  text.split('\n').forEach((line, i) => {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) return;
    const [, fence, rest] = m;
    if (!open) { open = { ch: fence[0], len: fence.length, line: i + 1 }; return; }
    if (fence[0] !== open.ch || fence.length < open.len) return;
    if (rest.trim() !== '') problems.push(`line ${i + 1}: closing fence with trailing text`);
    else open = null;
  });
  if (open) problems.push(`line ${open.line}: fence never closed`);
  return problems;
}

test('M1 (fences): the fence check catches trailing text and an unclosed block', () => {
  assert.deepEqual(fenceProblems('```bash\nx=1\n```\ntext\n'), []);
  assert.equal(fenceProblems('```bash\nx=1\n``` Create the subtask\n').length, 2);
  assert.deepEqual(fenceProblems('```bash\nx\n'), ['line 1: fence never closed']);
  assert.deepEqual(fenceProblems('````md\n```bash\n```\n````\n'), []);
});

test('M1 (fences): every skill and agent file has balanced code fences', () => {
  const problems = [];
  for (const abs of specFiles()) {
    for (const p of fenceProblems(readFileSync(abs, 'utf8'))) problems.push(`${rel(abs)}: ${p}`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('M2: the no-repo-script fallback inherits the launch checkout target= when no run base is persisted', () => {
  const doc = readSpec('skills/shared/base-branch.md');
  has(section(doc, /^\*\*Fresh-branch block\.\*\*/m, /^```bash/m), 'WT_TARGET="${PERSIST_TARGET:-$LAUNCH_TARGET}"', 'base-branch.md fresh-branch fallback');
  has(section(doc, /^## Worktree name question/m, /^## Task-body rule/m), 'LAUNCH_TARGET=', 'base-branch.md §Worktree name question');
  const worktree = section(readSpec('skills/ship-task/SKILL.md'), /^#### Worktree \(both modes\)/m, /^### Stage 1\.9/m);
  has(worktree, 'WT_TARGET="${PERSIST_TARGET:-$LAUNCH_TARGET}"', 'ship-task §Worktree fallback');
});
