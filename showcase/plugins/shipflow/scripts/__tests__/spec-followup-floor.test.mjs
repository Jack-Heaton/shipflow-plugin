/**
 * @file spec-followup-floor.test.mjs
 * @description Spec-contract test for the follow-up filing rule: scope-policy's filing floor
 *   states Rule 6 (a follow-up is work, never operator validation), no skill files a
 *   validation-only follow-up for an owed live run, ship-task 3g records the live-run answers
 *   as PR comments and files a `bug` subtask on a failed run only. Pins key terms, never sentences; the passages that used to
 *   file the validation subtask also carry negative pins, so a reworded filing fails too.
 * @domain workflow-spec
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSpec, section } from './spec-text.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SKILL = readSpec('skills/ship-task/SKILL.md');
const pr3g = section(SKILL, /^#### 3g — Push \+ PR/m, /^#### Live smoke/m);
const smoke = section(SKILL, /^#### Live smoke/m, /^### Stage 4/m);
const policy = section(SKILL, /\*\*Interview policy\*\*/, /\*\*Notifications\.\*\*/);
const bucket2 = section(SKILL, /\*\*2 needs a human\*\*/, /\*\*3 out of/);
const ac = section(SKILL, /^#### 3f\.5/m, /^#### 3f\.6/m);
const scopePolicy = readSpec('skills/shared/scope-policy.md');
const floor = scopePolicy.slice(scopePolicy.search(/^## The filing floor/m));
const rule6 = section(floor, /\*\*Rule 6 /, /\*\*Audit:\*\*/);

const has = (text, term, where) => assert.ok(text.includes(term), `${where} must name "${term}"`);

test('D-2: the filing floor states Rule 6 — a follow-up is work, never operator validation', () => {
  for (const term of ['Rule 6', 'operator', 'PR body', '## Live dev run', '## Deferred visual checks', 'never filed', '`bug`']) {
    has(rule6, term, 'scope-policy §The filing floor, Rule 6');
  }
  const referrers = section(floor, /^> Referenced by/m, /^\*\*Why volume/m);
  for (const term of ['`ship-task`', '`epic.md`', 'seven rules']) has(referrers, term, 'scope-policy §The filing floor (referrers)');
});

test('D-2: no skill files a validation-only follow-up for an owed live run', () => {
  const banned = [/live (dev )?run owed/i, /owed (live|dev)[^.\n]{0,20}(sub)?task/i, /owed: <(sub)?task/i, /close candidate/i];
  const hits = [];
  for (const entry of readdirSync(join(PLUGIN_ROOT, 'skills'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = relative(PLUGIN_ROOT, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join('/');
    const text = readSpec(rel);
    for (const shape of banned) if (shape.test(text)) hits.push(`${rel}: ${shape}`);
  }
  assert.deepEqual(hits, [], 'an owed operator check is recorded in the PR body, never filed');
});

test('D-3: an owed live run stays in the PR body and the post-PR question; the ready rule still names it', () => {
  for (const term of ['## Live dev run', 'not run — owed (see Questions for the operator)', 'live_check.instructions', '$DEFERRED_LIVE', 'pr-questions.md', 'smoke-test it for me', 'Rule 6']) {
    has(pr3g, term, '3g');
  }
  const owedRun = section(pr3g, /Until then/, /^Stack:/m);
  has(owedRun, 'no task is filed', '3g, an owed live run');
  assert.doesNotMatch(owedRun, /subtask|tracker task create|into the bundle/, 'an owed live run files nothing');
  const ready = pr3g.slice(pr3g.indexOf('**Ready for review**'));
  for (const term of ['gh pr ready', '## Live dev run', 'an owed run does not block']) has(ready, term, '3g ready-for-review rule');
});

test('D-4: the live-run answers are PR comments, and a failed run files a bug subtask', () => {
  for (const term of ['ran-pass', 'ran-fail', 'defer', 'gh pr ready --undo', '--tag bug', '--parent "$TASK_ID"', 'PR comment']) has(pr3g, term, '3g');
  const answers = pr3g.slice(pr3g.indexOf('The live-dev-run answer'));
  assert.ok(answers.indexOf('**ran-fail**') < answers.indexOf('--tag bug'), 'the bug subtask belongs to ran-fail');
  assert.ok(answers.indexOf('--tag bug') < answers.indexOf('**defer**'), 'the bug subtask is not defer\'s');
  assert.equal(answers.split('tracker task create').length - 1, 1, 'the answers file one task: the failed run\'s bug subtask');
  const ranPass = section(answers, /\*\*ran-pass\*\*/, /\*\*ran-fail\*\*/);
  assert.doesNotMatch(ranPass, /subtask/, 'a passed run touches no task');
  const defer = section(answers, /\*\*defer\*\*/, /\.(\s|$)/);
  assert.doesNotMatch(defer, /subtask|tracker task|file/, 'defer files nothing');
  has(defer, 'nothing changes', '3g defer answer');
  has(answers, '/fix-task $TASK_ID', '3g ran-fail answer');
  has(pr3g, 'tracker task create --parent "$TASK_ID" --status "to do" --tag bug', '3g ran-fail answer');
  has(smoke, '/fix-task $TASK_ID', '§Live smoke step 6');
  for (const term of ['`bug` subtask', 'nothing is filed', '/fix-task']) has(smoke, term, '§Live smoke step 6');
});

test('D-1: a question-only finding is not filed; the question still reaches the PR-time list', () => {
  for (const [text, where] of [[policy, '§Interview policy'], [bucket2, '3e bucket 2']]) {
    for (const term of ['pr-questions.md', 'Rule 6', 'names a code change']) has(text, term, where);
  }
  has(policy, 'is not filed', '§Interview policy');
  has(ac, 'never a follow-up task', '3f.5 (deferred in-app check)');
  has(ac, 'Rule 6', '3f.5 (deferred in-app check)');
});
