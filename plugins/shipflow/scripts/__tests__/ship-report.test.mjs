/**
 * @file ship-report.test.mjs
 * @description Pins /ship-report's 0.24.0 accounting against a fixture ledger: fix-round-extension
 *   (with and without phase) vs operator-authorized-round notes vs the legacy escape, follow-ups
 *   created/extended (list and JSON-string forms) and the bundle id, goal-post counts on triage
 *   events, and walls over 48 h dropped from cost. Run: node --test plugins/shipflow/scripts/__tests__/*.test.mjs
 * @domain workflow-audit-log
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPORT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'ship-report', 'report.py');

function ledger(events) {
  const dir = mkdtempSync(join(tmpdir(), 'ship-report-'));
  const f = join(dir, 'ship-task-1700000000.jsonl');
  const ts = (i) => new Date(Date.UTC(2026, 8, 2, 10, i)).toISOString();
  writeFileSync(f, events.map((e, i) => JSON.stringify({ task: 'unit', ts: ts(i), ...e })).join('\n') + '\n');
  return f;
}

function report(file) {
  const res = spawnSync('python3', [REPORT, file], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

test('round extensions, follow-ups, goal-post counts and absurd walls render and flag', () => {
  const out = report(ledger([
    { stage: 'run-meta', skill: 'ship-task' },
    { stage: 'spawn', role: 'reviewer:security', agent_type: 'security-reviewer', model: 'opus', phase: 'review', round: 1, wall_ms: 600000 },
    { stage: 'closure-exchange', role: 'reviewer:security:closure', round: 1, path: 'warm', wall_ms: 496753 * 3600 * 1000 },
    { stage: 'spawn', role: 'fixer', agent_type: 'codex-exec', backend: 'codex', model: 'gpt-6.2-sol', phase: 'fix', round: 1, tokens: 1000, duration_ms: 50 * 3600 * 1000 },
    { stage: 'triage', round: 1, rereview_mode: 'warm', bucket1_fix_now: 3, bucket2_human: 0, bucket3_followup: 2, bucket4_dropped: 0, goal_post: 1 },
    { stage: 'followup-bundle', bundle: 'bnd001', list: '901', round: 1 },
    { stage: 'followup-tasks', created: ['t1', 't2'], bundle: 'bnd001', round: 1 },
    { stage: 'fix-round-extension', round: 3, reason: 'bounded', open_high: 1, prev_high: 2, ceiling: 6, phase: 'epic-phase:P2' },
    { stage: 'fix-round-extension', round: 4, reason: 'progress', open_high: 0, prev_high: 1, ceiling: 6 },
    { stage: 'note', event: 'operator-authorized-round', round: 5, reason: 'two designs to choose between' },
    { stage: 'fix-convergence-escape', round: 3 },
    { stage: 'triage', round: 2, rereview_mode: 'warm', bucket1_fix_now: 1, bucket2_human: 0, bucket3_followup: 1, bucket4_dropped: 0, goal_post: 2 },
    { stage: 'followup-tasks', created: '["t3"]', extended: ['t0'], bundle: 'bnd001', round: 2 },
    { stage: 'implement-issue', fix_rounds: 5, review_status: 'clean' },
  ]));
  assert.match(out, /round extensions: 2 orchestrator \((bounded×1, progress×1|progress×1, bounded×1)\), 1 operator-authorized, 1 convergence-escape \(pre-0\.24\)/);
  assert.match(out, /operator round 5: two designs to choose between/, 'no phase → no dangling space');
  assert.match(out, /follow-ups: 3 filed, 1 extended, 3 goal-post counterexample\(s\) filed instead of fixed → bundle bnd001/);
  assert.match(out, /1 operator-authorized fix round\(s\)/);
  assert.match(out, /2 row\(s\) logged a wall over 48 h/, 'wall_ms and duration_ms over 48 h are both dropped');
  assert.doesNotMatch(out, /496753h|2d02h/, 'the absurd walls never reach the cost table');
});

test('0.31.0: a direction-reviewer spawn renders in the cost table and the direction-review summary line', () => {
  const out = report(ledger([
    { stage: 'run-meta', skill: 'ship-task' },
    { stage: 'spawn', role: 'direction-reviewer', agent_type: 'sf-direction-reviewer', model: 'session', phase: 'fix', round: 1, tokens: 1000, wall_ms: 120000 },
    { stage: 'note', event: 'direction-revised', round: 1, blocking: 2 },
    { stage: 'note', event: 'direction-review-skipped', round: 2 },
    { stage: 'implement-issue', fix_rounds: 2, review_status: 'clean' },
  ]));
  assert.match(out, /direction-reviewer\s+1\s+1\.0k/, 'the direction reviewer is its own cost-table row');
  assert.match(out, /direction review: 1 pass\(es\), 2 blocking finding\(s\) resolved, 1 skipped/);
});

test('0.31.0: an adjudication event renders the adjudication summary line', () => {
  const out = report(ledger([
    { stage: 'run-meta', skill: 'ship-task' },
    { stage: 'adjudication', round: 1, gaps: 3, accepted: 2, redirected: 1 },
    { stage: 'implement-issue', fix_rounds: 1, review_status: 'clean' },
  ]));
  assert.match(out, /adjudication: 1 round\(s\), 3 semantic gap\(s\): 2 accepted, 1 redirected/);
});

test('0.31.0: an adjudication row with non-numeric counts is skipped from the totals and flagged', () => {
  const out = report(ledger([
    { stage: 'run-meta', skill: 'ship-task' },
    { stage: 'adjudication', round: 1, gaps: 3, accepted: 2, redirected: 1 },
    { stage: 'adjudication', round: 2, gaps: 'abc', accepted: 2, redirected: 1 },
    { stage: 'implement-issue', fix_rounds: 2, review_status: 'clean' },
  ]));
  assert.match(out, /adjudication: 1 round\(s\), 3 semantic gap\(s\): 2 accepted, 1 redirected/, 'only the numeric row is summed');
  assert.match(out, /adjudication row with non-numeric counts/, 'the bad row is flagged, not summed as 0');
});

test('0.31.0: two adjudication rows in one round render 1 round(s), not 2', () => {
  const out = report(ledger([
    { stage: 'run-meta', skill: 'ship-task' },
    { stage: 'adjudication', round: 1, gaps: 2, accepted: 1, redirected: 1 },
    { stage: 'adjudication', round: 1, gaps: 1, accepted: 1, redirected: 0 },  // the accept-only second row
    { stage: 'implement-issue', fix_rounds: 1, review_status: 'clean' },
  ]));
  assert.match(out, /adjudication: 1 round\(s\), 3 semantic gap\(s\): 2 accepted, 1 redirected/, 'distinct rounds, not events');
});

test('a pre-0.24 ledger renders without the new blocks', () => {
  const out = report(ledger([
    { stage: 'run-meta', skill: 'ship-task' },
    { stage: 'triage', round: 1, rereview_mode: 'none', bucket1_fix_now: 0, bucket2_human: 0, bucket3_followup: 0, bucket4_dropped: 0 },
    { stage: 'implement-issue', fix_rounds: 0, review_status: 'clean' },
  ]));
  assert.doesNotMatch(out, /round extensions:/);
  assert.doesNotMatch(out, /follow-ups:/);
  assert.doesNotMatch(out, /direction review:/, 'no direction-reviewer spawn or notes → line omitted');
  assert.doesNotMatch(out, /adjudication:/, 'no adjudication event → line omitted');
});

test('0.26.0: idle after a finished seat, fix rounds derived from fixer spawns, integration-sync rendered', () => {
  // ledger() spaces events one minute apart; give the fixer completion a 4 h gap to the next event
  const dir = mkdtempSync(join(tmpdir(), 'ship-report-idle-'));
  const f = join(dir, 'ship-task-1700000001.jsonl');
  const at = (h, m) => new Date(Date.UTC(2026, 8, 3, h, m)).toISOString();
  const events = [
    { stage: 'run-meta', skill: 'ship-task', ts: at(0, 0) },
    { stage: 'integration-sync', at: '3d', behind: 205, conflicts: 0, ts: at(0, 5) },
    { stage: 'spawn', role: 'fixer', agent_type: 'codex-exec', backend: 'codex', model: 'gpt-6.2-sol', phase: 'fix', round: 1, tokens: 1000, wall_ms: 600000, ts: at(1, 0) },
    { stage: 'triage', round: 1, rereview_mode: 'warm', bucket1_fix_now: 3, bucket2_human: 0, bucket3_followup: 0, bucket4_dropped: 0, ts: at(1, 2) },
    { stage: 'spawn', role: 'fixer', agent_type: 'codex-exec', backend: 'codex', model: 'gpt-6.2-sol', phase: 'fix', round: 2, tokens: 1000, wall_ms: 600000, ts: at(2, 0) },
    { stage: 'build-gate', result: 'pass', ts: at(6, 0) },   // 4 h after the round-2 fixer returned: asleep on a nohup'd seat
    { stage: 'spawn', role: 'mopup-fixer', agent_type: 'codex-exec', backend: 'codex', model: 'gpt-6.2-sol', phase: 'fix', round: 3, tokens: 100, wall_ms: 60000, ts: at(6, 10) },
    { stage: 'integration-sync', at: '3g', behind: 12, conflicts: 0, ts: at(6, 20) },
    { stage: 'postmortem', pr: 1, ts: at(6, 30) },
  ];
  writeFileSync(f, events.map((e) => JSON.stringify({ task: 'unit', ...e })).join('\n') + '\n');
  const out = report(f);
  assert.match(out, /fix rounds: 2 \(from fixer spawns\)/, 'no implement-issue event → derived from fixer spawns, mop-up excluded');
  assert.match(out, /idle after a finished seat: 4h10m \(64% of wall, 2 gap\(s\) > 5 min; largest: 4h00m after fixer r2/, 'the 4 h nohup gap plus the 10 min mop-up gap; the 2-minute triage gap is under the 5-min floor');
  assert.match(out, /integration sync: 3d: 205 behind, 0 conflict\(s\); 3g: 12 behind, 0 conflict\(s\)/);
  assert.match(out, /idle after finished seats/, 'flagged as a tuning issue when over an hour');
});

test('0.27.0: epic layers without an at=layer sync are flagged; a late conflicting 3g sync is flagged; layer/probe render', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-report-sync-'));
  const f = join(dir, 'ship-task-1700000002.jsonl');
  const at = (h, m) => new Date(Date.UTC(2026, 8, 5, h, m)).toISOString();
  const base = [
    { stage: 'run-meta', skill: 'ship-task', ts: at(0, 0) },
    { stage: 'epic-decompose', phases: 3, ts: at(0, 1) },
    { stage: 'integration-sync', at: 'layer', layer: 0, behind: 13, conflicts: 0, ts: at(0, 5) },
    { stage: 'epic-layer', layer: 0, mode: 'integrated', head: 'a', ts: at(1, 0) },
    { stage: 'integration-sync', at: 'phase', behind: 4, conflicts: 1, probe: 1, ts: at(1, 30) },
    { stage: 'epic-layer', layer: 1, mode: 'integrated', head: 'b', ts: at(2, 0) },
    { stage: 'epic-layer', layer: 2, mode: 'integrated', head: 'c', ts: at(3, 0) },
    { stage: 'integration-sync', at: '3g', behind: 30, conflicts: 2, ts: at(3, 10) },
    { stage: 'integration-sync', at: '3g', behind: 0, conflicts: 2, resolved: 1, merge_commit: 'd', ts: at(3, 40) },
    { stage: 'implement-issue', fix_rounds: 1, review_status: 'clean', pr_url: 'https://example/pr/1', ts: at(4, 0) },
  ];
  writeFileSync(f, base.map((e) => JSON.stringify({ task: 'unit', ...e })).join('\n') + '\n');
  const out = report(f);
  assert.match(out, /integration sync: layer 0: 13 behind, 0 conflict\(s\); phase \(probe\): 4 behind, 1 conflict\(s\); .*3g \(resolved\): 0 behind, 2 conflict\(s\)/);
  assert.match(out, /2 of 3 epic layers integrated with no `at=layer` sync/);
  assert.match(out, /the 3g sync arrived 30 commits behind with 2 conflict\(s\)/);

  // every layer synced, and 3g clean → neither flag
  const g = join(dir, 'ship-task-1700000003.jsonl');
  const good = base.map((e) => ({ ...e }));
  good.splice(5, 0, { stage: 'integration-sync', at: 'layer', layer: 1, behind: 2, conflicts: 0, ts: at(1, 40) });
  good.splice(7, 0, { stage: 'integration-sync', at: 'layer', layer: 2, behind: 5, conflicts: 0, ts: at(2, 30) });
  const cleaned = good.filter((e) => !(e.stage === 'integration-sync' && e.at === '3g'));
  cleaned.push({ stage: 'integration-sync', at: '3g', behind: 0, conflicts: 0, probe: 1, ts: at(3, 50) });
  writeFileSync(g, cleaned.map((e) => JSON.stringify({ task: 'unit', ...e })).join('\n') + '\n');
  const out2 = report(g);
  assert.doesNotMatch(out2, /epic layers integrated with no/);
  assert.doesNotMatch(out2, /sync arrived/);
});

test('0.28.0: wall segments (seat busy / operator wait / session gap / orchestrator) and duplicate spawn rows', () => {
  // Timeline (minutes): 0 run-meta; 30 explore returns after a 20-min seat; 40 checkpoint;
  // 100 resume-adopted (60-min operator wait); 110 fixer returns after a 5-min seat (its own row
  // at 110, the orchestrator's duplicate at 111); 150 session-resumed (39-min session gap from
  // the duplicate row at 111, which is dropped, so the gap runs from 110); 160 triage.
  const dir = mkdtempSync(join(tmpdir(), 'ship-report-'));
  const f = join(dir, 'ship-task-1700000001.jsonl');
  const at = (min, e) => JSON.stringify({ task: 'unit', ts: new Date(Date.UTC(2026, 8, 7, 0, min)).toISOString(), ...e });
  writeFileSync(f, [
    at(0, { stage: 'run-meta', skill: 'ship-task' }),
    at(30, { stage: 'spawn', role: 'explore', agent_type: 'codex-exec', backend: 'codex', model: 'gpt-6.2-sol', phase: 'plan', round: 1, tokens: 500, wall_ms: 20 * 60000, agent_id: 'x1', artifact: '/a/explore.md' }),
    at(40, { stage: '2', event: 'checkpoint', reason: 'plan-needs-operator' }),
    at(100, { stage: 'resume-adopted', prior_log: 'ship-task-1700000000.jsonl' }),
    at(110, { stage: 'spawn', role: 'fixer', agent_type: 'codex-exec', backend: 'codex', model: 'gpt-6.2-sol', phase: 'fix', round: 1, tokens: 9000, wall_ms: 5 * 60000, agent_id: 'f1', artifact: '/a/fix-r1.md' }),
    at(111, { stage: 'spawn', role: 'fixer', agent_type: 'codex-exec', backend: 'codex', model: 'gpt-6.2-sol', phase: 'fix', round: 1, wall_ms: 5 * 60000, agent_id: 'f1', artifact: '/a/fix-r1.md', epic_phase: 2 }),
    at(150, { stage: 'session-resumed', source: 'resume', session_id: 's2' }),
    at(160, { stage: 'triage', round: 1, rereview_mode: 'warm', bucket1_fix_now: 1, bucket2_human: 0, bucket3_followup: 0, bucket4_dropped: 0 }),
  ].join('\n') + '\n');
  const out = report(f);
  assert.match(out, /wall-clock: 2h40m/);
  assert.match(out, /wall segments: seats busy 25m00s \(16%\)   operator waits 1h00m \(38%, 0 marked\)   session gaps 40m00s \(25%, 1 resume\(s\)\)   orchestrator\/unattributed 35m00s \(22%\)   \[1 duplicate spawn row\(s\) dropped\]/);
  assert.match(out, /fixer\s+1\s+9\.0k/, 'the token-bearing row is the one kept; the duplicate neither doubles tokens nor spawns');
  assert.match(out, /1 duplicate spawn row\(s\) \(same agent_id \+ artifact\) dropped before aggregation/);
  assert.doesNotMatch(out, /orchestrator\/unattributed time is/, 'under the 40% flag threshold');
});

test('operator-wait: the interval to operator-answered is operator wait; a codex seat row inside it does not end it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-report-'));
  const at = (min, e) => JSON.stringify({ task: 'unit', ts: new Date(Date.UTC(2026, 8, 7, 10, min)).toISOString(), ...e });
  const open = at(0, { stage: 'operator-wait', questions: 2, at: '3e', blocking: ['Q1', 'Q2'], artifact: '/a/operator-questions.md' });
  const answered = at(60, { stage: 'note', event: 'operator-answered', questions: 2 });
  const plain = join(dir, 'ship-task-1700000010.jsonl');
  writeFileSync(plain, [open, answered].join('\n') + '\n');
  assert.match(report(plain), /operator waits 1h00m \(100%, 1 marked\)/);

  const withSeat = join(dir, 'ship-task-1700000011.jsonl');
  writeFileSync(withSeat, [
    open,
    at(20, { stage: 'spawn', role: 'reviewer:security-reviewer', agent_type: 'codex-exec', backend: 'codex', model: 'm', phase: 'review', round: 1, tokens: 10, wall_ms: 60000, agent_id: 'r1', artifact: '/a/r1.md' }),
    answered,
  ].join('\n') + '\n');
  assert.match(report(withSeat), /operator waits 59m00s \(98%, 1 marked\)/, 'only the seat minute is subtracted');
});

test('operator-wait: session-resumed and codex-seat notes do not end it; the next orchestrator event does; open-at-end runs to the last event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-report-'));
  const at = (min, e) => JSON.stringify({ task: 'unit', ts: new Date(Date.UTC(2026, 8, 7, 10, min)).toISOString(), ...e });
  const open = at(0, { stage: 'operator-wait', questions: 1, at: '3e', blocking: ['Q1'], artifact: '/a/operator-questions.md' });
  const write = (name, rows) => { const f = join(dir, name); writeFileSync(f, rows.join('\n') + '\n'); return f; };

  const resumed = write('ship-task-1700000020.jsonl', [
    open,
    at(10, { stage: 'session-resumed', source: 'resume', session_id: 's2' }),
    at(30, { stage: 'note', event: 'operator-answered', questions: 1 }),
  ]);
  assert.match(report(resumed), /operator waits 30m00s \(100%, 1 marked\)/, 'session-resumed inside the wait is the wait');

  const seatNote = write('ship-task-1700000021.jsonl', [
    open,
    at(10, { stage: 'note', event: 'codex-seat-failed', role: 'reviewer:security-reviewer', round: 1 }),
    at(30, { stage: 'note', event: 'operator-answered', questions: 1 }),
  ]);
  assert.match(report(seatNote), /operator waits 30m00s \(100%, 1 marked\)/, 'a codex-seat-* note does not end it');

  const fallback = write('ship-task-1700000022.jsonl', [
    open,
    at(20, { stage: 'note', event: 'tick' }),
    at(40, { stage: 'triage', round: 1, rereview_mode: 'warm', bucket1_fix_now: 0, bucket2_human: 0, bucket3_followup: 0, bucket4_dropped: 0 }),
  ]);
  assert.match(report(fallback), /operator waits 20m00s \(50%, 1 marked\)/, 'the next orchestrator-authored event closes it');

  const openAtEnd = write('ship-task-1700000023.jsonl', [
    open,
    at(45, { stage: 'session-resumed', source: 'resume', session_id: 's3' }),
  ]);
  assert.match(report(openAtEnd), /operator waits 45m00s \(100%, 1 marked\)/, 'a wait still open at end of log runs to the last event');
});

test('operator-pause (legacy note) opens a wait that the next event of any kind closes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-report-'));
  const f = join(dir, 'ship-task-1700000024.jsonl');
  const at = (min, e) => JSON.stringify({ task: 'unit', ts: new Date(Date.UTC(2026, 8, 7, 10, min)).toISOString(), ...e });
  writeFileSync(f, [
    at(0, { stage: 'run-meta', skill: 'ship-task' }),
    at(10, { stage: 'note', event: 'operator-pause' }),
    at(40, { stage: 'session-resumed', source: 'resume', session_id: 's2' }),
    at(50, { stage: 'note', event: 'tick' }),
  ].join('\n') + '\n');
  assert.match(report(f), /operator waits 30m00s \(60%, 0 marked\)/);
});

test('0.28.0: a run with no marks attributes every non-seat minute to orchestrator/unattributed and flags it past 40%', () => {
  const out = report(ledger([
    { stage: 'run-meta', skill: 'ship-task' },
    ...Array.from({ length: 200 }, (_, i) => (i === 199
      ? { stage: 'spawn', role: 'implementer', agent_type: 'codex-exec', backend: 'codex', model: 'm', phase: 'implement', round: 1, tokens: 1, wall_ms: 10 * 60000, agent_id: 'i1', artifact: '/a/i.md' }
      : { stage: 'note', event: 'tick' })),
  ]));
  assert.match(out, /wall segments: seats busy 10m00s \(5%\)   operator waits 0s \(0%, 0 marked\)   session gaps 0s \(0%, 0 resume\(s\)\)   orchestrator\/unattributed 3h10m \(95%\)/);
  assert.match(out, /orchestrator\/unattributed time is 3h10m \(95% of wall\)/);
});

test('0.29.0: a codex-seat-failed note with recovered usage is a cost-bearing turn; one without tokens is flagged as a lower bound', () => {
  const out = report(ledger([
    { stage: 'run-meta', skill: 'ship-task' },
    { stage: 'spawn', role: 'implementer', agent_type: 'codex-exec', backend: 'codex', model: 'gpt-6.2-sol', phase: 'implement', round: 1, tokens: 1000, wall_ms: 60000, agent_id: 'i1', artifact: '/a/i1.md' },
    { stage: 'note', event: 'codex-seat-failed', role: 'implementer', backend: 'codex', round: 1, detail: 'timed out after 40 min', agent_id: 'i2', tokens: 34906570, tokens_in: 34796312, tokens_cached: 34167296, tokens_out: 110258, usage_source: 'rollout', wall_ms: 2400000, commands_run: 156, commands_ok: 129 },
    { stage: 'note', event: 'codex-seat-fallback', role: 'implementer', detail: 'adopt-dirty' },
  ]));
  assert.match(out, /implementer\s+2\s+34\.91M/, 'the failed seat counts as a turn with its recovered tokens');
  assert.match(out, /✗1 failed seat\(s\) counted/);
  assert.match(out, /1 failed Codex seat\(s\) \(implementer\) — their usage is in the cost table/);
  const old = report(ledger([
    { stage: 'run-meta', skill: 'ship-task' },
    { stage: 'note', event: 'codex-seat-failed', role: 'implementer', backend: 'codex', round: 1, detail: 'timed out after 40 min', agent_id: 'i2' },
  ]));
  assert.match(old, /1 carried no tokens \(pre-0\.29\.0 sf-codex\): the cost table is a lower bound/);
});

test('0.31.0: oscillation stops render the stops line and flag only a design-note stop with no note', () => {
  const out = report(ledger([
    { stage: 'run-meta', skill: 'ship-task' },
    { stage: 'oscillation-stop', finding: 'U1', round: 2, severity: 'HIGH', action: 'design-note', design_note: '/abs/design-note-U1.md' },
    { stage: 'oscillation-stop', finding: 'U2', round: 3, severity: 'HIGH', action: 'checkpoint' },
    { stage: 'oscillation-stop', finding: 'U3', round: 4, severity: 'HIGH', action: 'design-note' },
    // U4: a MEDIUM stop with no action is bucket-3 by severity (_disposition), a terminal move
    // that never re-enters the fixer — so it needs no note artifact and must not be flagged.
    { stage: 'oscillation-stop', finding: 'U4', round: 5, severity: 'MEDIUM' },
    { stage: 'implement-issue', fix_rounds: 5, review_status: 'clean' },
  ]));
  assert.match(out, /oscillation stops: 4 \(U1\/design-note, U2\/checkpoint, U3\/design-note, U4\/\?\)/);
  // Only U3 (design-note re-entry with no artifact) is flagged; U1 has the note, U2 is a
  // checkpoint, U4 is a bucket-3 (MEDIUM, action-less) terminal stop.
  const flags = out.match(/stopped without a design note/g) || [];
  assert.equal(flags.length, 1, 'exactly one oscillation flag');
  assert.match(out, /finding U3 stopped without a design note/);
  assert.doesNotMatch(out, /finding U4 stopped without a design note/);
});

test('missing usage renders as missing, never 0; a partly-missing role is a lower bound', () => {
  const out = report(ledger([
    { stage: 'run-meta', skill: 'ship-task' },
    { stage: 'spawn', role: 'explore', agent_type: 'Explore', model: 'haiku', phase: 'plan', tokens: null, usage_missing: true, wall_ms: 60000 },
    { stage: 'spawn', role: 'implementer', agent_type: 'sf-implementer', model: 'opus', phase: 'implement', tokens: 2000, wall_ms: 60000 },
    { stage: 'spawn', role: 'implementer', agent_type: 'sf-implementer', model: 'opus', phase: 'implement', tokens: null, usage_missing: true, wall_ms: 60000 },
  ]));
  assert.match(out, /explore\s+1\s+missing/);
  assert.match(out, /implementer\s+2\s+≥2\.0k/);
  assert.match(out, /usage missing on 2 of 3 turns/);
});

test('a folded resume (sf-log init --resume) reports the gap before the resumed mark as a session gap', () => {
  const SF_LOG = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sf-log.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ship-report-'));
  const at = (h, min, e) => JSON.stringify({ task: 'unit', ts: new Date(Date.UTC(2026, 8, 7, h, min)).toISOString(), ...e });
  const prior = join(dir, 'ship-task-1700000020.jsonl');
  writeFileSync(prior, [
    at(10, 0, { stage: 'run-meta', skill: 'ship-task' }),
    at(10, 10, { stage: 'triage', round: 1, rereview_mode: 'warm', bucket1_fix_now: 1, bucket2_human: 0, bucket3_followup: 0, bucket4_dropped: 0 }),
  ].join('\n') + '\n');
  const stage0 = join(dir, 'ship-task-1700028800.jsonl');
  writeFileSync(stage0, [
    at(18, 10, { stage: 'run-meta', skill: 'ship-task' }),
    at(18, 11, { stage: 'resume-adopted' }),
  ].join('\n') + '\n');
  const rs = join(dir, 'task-unit.runstate.json');
  writeFileSync(rs, JSON.stringify({ log_path: 'ship-task-1700000020.jsonl' }));
  const res = spawnSync(process.execPath, [SF_LOG, 'init', '--resume', rs], { encoding: 'utf8', env: { ...process.env, RUN_LOG: stage0 } });
  assert.equal(res.status, 0, res.stderr);
  assert.match(report(prior), /session gaps 8h00m \(\d+%, 1 resume\(s\)\)/);
});

test('0.37.0: the cost table names the served model and effort when the ledger carries them; a malformed value falls back', () => {
  const out = report(ledger([
    { stage: 'run-meta', skill: 'ship-task' },
    { stage: 'spawn', role: 'explore', agent_type: 'Explore', model: 'session', model_served: 'claude-opus-5-5', effort_served: 'high', phase: 'plan', tokens: 1000, wall_ms: 60000 },
    { stage: 'spawn', role: 'implementer', agent_type: 'sf-implementer', model: 'opus', model_served: 'claude-opus-5-5', effort_served: 5, phase: 'implement', tokens: 1000, wall_ms: 60000 },
    { stage: 'spawn', role: 'fixer', agent_type: 'sf-fixer', model: 'opus', model_served: 7, phase: 'fix', round: 1, tokens: 1000, wall_ms: 60000 },
  ]));
  assert.match(out, /explore\b.*claude-opus-5-5\/high×1/);
  assert.match(out, /implementer\b.*claude-opus-5-5×1/);
  assert.match(out, /fixer\b.*opus×1/);
});
