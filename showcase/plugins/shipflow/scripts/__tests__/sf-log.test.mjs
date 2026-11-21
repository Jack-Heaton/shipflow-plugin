/**
 * @file sf-log.test.mjs
 * @description Tests for sf-log.mjs's ledger ratchet: spawn and timed continuation events
 *   refuse to log without started=/wall_ms= (--late records null explicitly), wall_ms is
 *   computed from started for closure-exchange/clarify, and `check` flags triage verdicts
 *   whose reviewer has no prior spawn event. Run: node --test plugins/shipflow/scripts/__tests__/
 * @domain workflow-audit-log
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_HOLD, GATE_REASONS } from '../sf-parallel-gate.mjs';

const SF_LOG = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sf-log.mjs');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-log-'));
  const log = join(dir, 'run.jsonl');
  writeFileSync(log, `${JSON.stringify({ stage: 'run-meta', cc_version: 'test', ts: new Date().toISOString() })}\n`);
  return { dir, log };
}

// No transcripts here: a test that logs a spawn never reads the developer's own sessions.
const NO_TRANSCRIPTS = mkdtempSync(join(tmpdir(), 'sf-log-projects-'));

function sflog(log, args) {
  const res = spawnSync(process.execPath, [SF_LOG, ...args], {
    encoding: 'utf8',
    env: { ...process.env, RUN_LOG: log, SF_RUN_TASK: 'unit', SF_CLAUDE_PROJECTS_DIR: NO_TRANSCRIPTS },
  });
  return res;
}

function lastEvent(log) {
  return JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop());
}

const SPAWN_BASE = ['spawn', 'role=reviewer:security', 'agent_type=security-reviewer', 'model=opus', 'phase=review'];

test('spawn without started= or wall_ms= is refused; started= computes wall_ms; --late records null explicitly', () => {
  const { log } = fixture();
  const refused = sflog(log, SPAWN_BASE);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /started=<epoch ms/);
  assert.match(refused.stderr, /--late/);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'nothing appended');

  const t0 = Date.now() - 1500;
  const ok = sflog(log, [...SPAWN_BASE, `started=${t0}`]);
  assert.equal(ok.status, 0, ok.stderr);
  const ev = lastEvent(log);
  assert.ok(Number.isInteger(ev.wall_ms) && ev.wall_ms >= 1500 && ev.wall_ms < 60000, `wall_ms=${ev.wall_ms}`);
  assert.equal(ev.late, undefined);
  assert.equal(ev.started, undefined, 'started is consumed, not stored');

  const late = sflog(log, [...SPAWN_BASE, '--late']);
  assert.equal(late.status, 0, late.stderr);
  const lev = lastEvent(log);
  assert.equal(lev.wall_ms, null);
  assert.equal(lev.late, true);

  const bad = sflog(log, [...SPAWN_BASE, 'started=yesterday']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /epoch milliseconds/);
});

test('closure-exchange and clarify carry the same requirement, and wall_ms is computed from started=', () => {
  const { log } = fixture();
  const refused = sflog(log, ['stage', 'closure-exchange', 'role=reviewer:security:closure', 'round=1', 'path=warm']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /closure-exchange requires started=/);
  // round= is required at write, so a closure/clarify can never be silently exempt from the gates.
  const noRound = sflog(log, ['stage', 'closure-exchange', 'role=reviewer:security:closure', 'path=warm', 'wall_ms=1']);
  assert.equal(noRound.status, 2, 'closure-exchange without round= is refused at write');
  assert.match(noRound.stderr, /closure-exchange requires round=/);
  const clarifyNoRound = sflog(log, ['stage', 'clarify', 'role=reviewer:security:clarify', 'finding=S-1', 'answered=true', '--late']);
  assert.equal(clarifyNoRound.status, 2, 'clarify without round= is refused at write');
  assert.match(clarifyNoRound.stderr, /clarify requires round=/);

  const t0 = Date.now() - 2000;
  const ok = sflog(log, ['stage', 'closure-exchange', 'role=reviewer:security:closure', 'round=1', 'path=warm', 'findings_closed=1', `started=${t0}`]);
  assert.equal(ok.status, 0, ok.stderr);
  const ev = lastEvent(log);
  assert.ok(Number.isInteger(ev.wall_ms) && ev.wall_ms >= 2000, `wall_ms=${ev.wall_ms}`);
  assert.equal(ev.started, undefined, 'started consumed');

  const late = sflog(log, ['stage', 'clarify', 'role=reviewer:security:clarify', 'round=1', 'finding=S-1', 'answered=true', '--late']);
  assert.equal(late.status, 0, late.stderr);
  assert.equal(lastEvent(log).wall_ms, null);
  assert.equal(lastEvent(log).late, true);

  // untimed stages are unaffected
  const note = sflog(log, ['stage', 'note', 'event=free-text']);
  assert.equal(note.status, 0, note.stderr);
});

test('check flags a triage verdict whose reviewer has no prior spawn/continuation event', () => {
  const { log } = fixture();
  const t0 = Date.now();
  assert.equal(sflog(log, ['spawn', 'role=reviewer:frontend-reviewer', 'agent_type=codex-exec', 'model=m', 'phase=review', `started=${t0}`]).status, 0);
  assert.equal(sflog(log, ['spawn', 'role=reviewer:security-reviewer', 'agent_type=security-reviewer', 'model=opus', 'phase=review', `started=${t0}`]).status, 0);
  assert.equal(sflog(log, ['stage', 'triage', 'round=1', 'rereview_mode=warm',
    'reviewer_verdicts={"frontend-reviewer":"PASS","security-reviewer":"PASS","performance":"FAIL"}']).status, 0);
  const res = sflog(log, ['check', log]);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.triage_verdicts_without_prior_spawn.map((x) => x.reviewer), ['performance'],
    'reviewer:-prefixed spawns cover their verdicts; the unlogged one is flagged');
  // a --late spawn is the only way to a null wall_ms, and check still lists it
  assert.equal(sflog(log, ['spawn', 'role=reviewer:performance', 'agent_type=codex-exec', 'model=m', 'phase=review', '--late']).status, 0);
  const res2 = JSON.parse(sflog(log, ['check', log]).stdout);
  assert.equal(res2.spawns_missing_wall_ms.length, 1);
  assert.deepEqual(res2.triage_verdicts_without_prior_spawn.map((x) => x.reviewer), ['performance'],
    'the late spawn comes AFTER the triage line, so the ordering finding stands');
});

test('a sub-second Claude spawn wall is warned about and flagged by check; codex seats and the seam-extension stage are accepted', () => {
  const { log } = fixture();
  const late = sflog(log, ['spawn', 'role=fixer', 'agent_type=shipflow:sf-fixer', 'model=opus', 'phase=fix', `started=${Date.now()}`]);
  assert.equal(late.status, 0, 'logged as-is — the ledger is the evidence');
  assert.match(late.stderr, /started= must be captured BEFORE the spawn/);
  const codex = sflog(log, ['spawn', 'role=reviewer:performance', 'agent_type=codex-exec', 'model=gpt-6.1-sol', 'tier=standard', 'phase=review', 'backend=codex', 'wall_ms=12']);
  assert.equal(codex.status, 0, codex.stderr);
  assert.doesNotMatch(codex.stderr, /captured BEFORE/);
  const ok = sflog(log, ['spawn', 'role=implementer', 'agent_type=shipflow:sf-implementer', 'model=opus', 'phase=implement', `started=${Date.now() - 90000}`]);
  assert.equal(ok.status, 0);
  assert.equal(sflog(log, ['stage', 'fix-seam-extension', 'round=3', 'seam_rounds=[2]']).status, 0, 'new stage is in the enum');
  const report = JSON.parse(sflog(log, ['check', log]).stdout);
  assert.deepEqual(report.spawns_wall_implausible.map((x) => x.role), ['fixer']);
  assert.deepEqual(report.unknown_stages, []);
  const events = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.find((e) => e.stage === 'spawn' && e.role === 'reviewer:performance').tier, 'standard', 'tier passes through');
});

test('implausible walls: explicit wall_ms on a Claude spawn and a log-time started= on a continuation are both warned and flagged', () => {
  const { log } = fixture();
  const explicit = sflog(log, ['spawn', 'role=reviewer:copy-lead', 'agent_type=shipflow:copy-lead', 'model=sonnet', 'phase=fix', 'wall_ms=37']);
  assert.equal(explicit.status, 0); assert.match(explicit.stderr, /captured BEFORE/);
  const cont = sflog(log, ['stage', 'closure-exchange', 'role=reviewer:security:closure', 'round=1', 'path=warm', 'findings_closed=1', `started=${Date.now()}`]);
  assert.equal(cont.status, 0, cont.stderr); assert.match(cont.stderr, /closure-exchange reviewer:security:closure: wall_ms=/);
  const codexCont = sflog(log, ['stage', 'closure-exchange', 'role=reviewer:performance:closure', 'round=1', 'path=warm', 'backend=codex', 'wall_ms=12']);
  assert.equal(codexCont.status, 0); assert.doesNotMatch(codexCont.stderr, /captured BEFORE/);
  const report = JSON.parse(sflog(log, ['check', log]).stdout);
  assert.deepEqual(report.spawns_wall_implausible.map((x) => x.role), ['reviewer:copy-lead']);
  assert.deepEqual(report.continuations_wall_implausible.map((x) => x.role), ['reviewer:security:closure']);
});

test('a wall over 48 h is warned about and flagged by check on any backend (started= not in epoch ms)', () => {
  const { log } = fixture();
  const huge = 496753 * 3600 * 1000; // a wall in ms far beyond any real run — started= captured in seconds, not ms
  const res = sflog(log, ['stage', 'closure-exchange', 'role=reviewer:security:closure', 'round=7', 'path=warm', `wall_ms=${huge}`]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /exceeds 48 h/);
  const codex = sflog(log, ['spawn', 'role=fixer', 'agent_type=codex-exec', 'model=gpt-6.1-sol', 'phase=fix', 'backend=codex', `wall_ms=${huge}`]);
  assert.equal(codex.status, 0, codex.stderr);
  assert.match(codex.stderr, /exceeds 48 h/, 'the upper bound applies to codex rows too');
  const check = sflog(log, ['check', log]);
  const report = JSON.parse(check.stdout);
  assert.equal(report.continuations_wall_implausible.length, 1);
  assert.equal(report.continuations_wall_implausible[0].why, 'over-48h');
  assert.equal(report.spawns_wall_implausible.length, 1);
  assert.equal(report.spawns_wall_implausible[0].why, 'over-48h');
});

test('fix-round-extension and followup-bundle are valid stages', () => {
  const { log } = fixture();
  const ext = sflog(log, ['stage', 'fix-round-extension', 'round=3', 'reason=progress', 'open_high=1', 'prev_high=3', 'ceiling=6']);
  assert.equal(ext.status, 0, ext.stderr);
  assert.equal(lastEvent(log).reason, 'progress');
  const bundle = sflog(log, ['stage', 'followup-bundle', 'bundle=124', 'list=901', 'round=1']);
  assert.equal(bundle.status, 0, bundle.stderr);
  assert.equal(lastEvent(log).stage, 'followup-bundle');
});

test('express-classification accepts mode=bundle (the ship-task bundle path) and still rejects unknown modes', () => {
  const { log } = fixture();
  assert.equal(sflog(log, ['stage', 'express-classification', 'mode=bundle', 'items=4', 'picked=4']).status, 0);
  const bad = sflog(log, ['stage', 'express-classification', 'mode=stack']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /express\|full\|no-code\|bundle/);
});

test('0.26.0: integration-sync requires at/behind/conflicts and a known at', () => {
  const { log } = fixture();
  assert.notEqual(sflog(log, ['stage', 'integration-sync', 'behind=205', 'conflicts=6']).status, 0, 'missing at= is refused');
  assert.notEqual(sflog(log, ['stage', 'integration-sync', 'at=3x', 'behind=205', 'conflicts=6']).status, 0, 'unknown at= is refused');
  const ok = sflog(log, ['stage', 'integration-sync', 'at=3d', 'behind=205', 'conflicts=6']);
  assert.equal(ok.status, 0, ok.stderr);
  const last = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop());
  assert.equal(last.stage, 'integration-sync'); assert.equal(last.at, '3d'); assert.equal(last.behind, 205); assert.equal(last.conflicts, 6);
});

test('0.27.0: integration-sync accepts every sync point in shared/integration-sync.md; layer= is required at=layer', () => {
  const { log } = fixture();
  for (const at of ['1b', '3e', '3f', 'phase', 'resume']) {
    const r = sflog(log, ['stage', 'integration-sync', `at=${at}`, 'behind=3', 'conflicts=0']);
    assert.equal(r.status, 0, `${at}: ${r.stderr}`);
  }
  const noLayer = sflog(log, ['stage', 'integration-sync', 'at=layer', 'behind=13', 'conflicts=0']);
  assert.notEqual(noLayer.status, 0, 'at=layer without layer= is refused');
  assert.match(noLayer.stderr, /layer=<value> is required when at=layer/);
  const ok = sflog(log, ['stage', 'integration-sync', 'at=layer', 'layer=2', 'behind=13', 'conflicts=0']);
  assert.equal(ok.status, 0, ok.stderr);
  const probe = sflog(log, ['stage', 'integration-sync', 'at=phase', 'behind=4', 'conflicts=1', 'probe=1']);
  assert.equal(probe.status, 0, probe.stderr);
  const last = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop());
  assert.equal(last.at, 'phase'); assert.equal(last.probe, 1);
});

test('0.28.0: a second spawn with the same agent_id + artifact is a duplicate — warned, not written, exit 0; check lists it', () => {
  const { log } = fixture();
  const seat = ['spawn', 'role=implementer', 'agent_type=codex-exec', 'model=gpt-6.1-sol', 'phase=implement',
    'agent_id=01a07c53-9acc', 'artifact=/x/implement-phase-8.md', 'wall_ms=398399', 'tokens_out=23218'];
  const first = sflog(log, seat);
  assert.equal(first.status, 0, first.stderr);
  // The shape seen on ship-task-1788747694: the orchestrator re-logged a Codex seat's own row to add epic_phase=.
  const again = sflog(log, [...seat.slice(0, 7), 'epic_phase=8', 'wall_ms=398431']);
  assert.equal(again.status, 0, 'a duplicate never fails the orchestrator');
  assert.match(again.stderr, /duplicate spawn for agent_id=01a07c53-9acc/);
  assert.match(again.stdout, /"skipped": "duplicate-spawn"/);
  const rows = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.filter((r) => r.stage === 'spawn').length, 1, 'the second row is not appended');
  assert.equal(rows[1].tokens_out, 23218, 'the token-bearing row is the one kept');

  // Different artifact, same agent id (a Claude reviewer re-spawned cold on a later round) is NOT a duplicate.
  const other = sflog(log, [...seat.slice(0, 6), 'artifact=/x/implement-phase-9.md', 'wall_ms=10']);
  assert.equal(other.status, 0, other.stderr);
  assert.doesNotMatch(other.stderr, /duplicate spawn/);
  // No agent_id → nothing to key on; always written.
  const anon = sflog(log, ['spawn', 'role=reviewer:security', 'agent_type=security-reviewer', 'model=opus', 'phase=review', 'artifact=/x/implement-phase-8.md', 'wall_ms=10']);
  assert.equal(anon.status, 0, anon.stderr);
  assert.doesNotMatch(anon.stderr, /duplicate spawn/);

  // `check` reports a duplicate that was written by some other path (a hand-rolled jq line).
  writeFileSync(log, readFileSync(log, 'utf8') + `${JSON.stringify({ stage: 'spawn', role: 'implementer', agent_type: 'codex-exec', model: 'm', phase: 'implement', agent_id: '01a07c53-9acc', artifact: '/x/implement-phase-8.md', wall_ms: 1, ts: new Date().toISOString() })}\n`);
  const check = sflog(log, ['check']);
  const report = JSON.parse(check.stdout);
  assert.equal(report.spawns_duplicate.length, 1);
  assert.equal(report.spawns_duplicate[0].agent_id, '01a07c53-9acc');
  assert.equal(report.spawns_duplicate[0].first_line, 2);
});

test('0.31.0: check flags a gated fixer that ran on a direction with no direction-reviewer spawn in its round', () => {
  const { log } = fixture();
  const t0 = Date.now() - 60000;
  // direction-reviewer is a known role prefix (no warning) and covers its namespaced round.
  const rev = sflog(log, ['spawn', 'role=direction-reviewer', 'agent_type=sf-direction-reviewer', 'model=session', 'phase=fix', 'round=1', 'direction=/x/fix-direction-r1.md', 'merged_items=1', `started=${t0}`]);
  assert.equal(rev.status, 0, rev.stderr);
  assert.doesNotMatch(rev.stderr, /does not start with a known prefix/);

  const codexFixer = (extra) => ['spawn', 'role=fixer', 'agent_type=codex-exec', 'model=gpt-6.1-sol', 'backend=codex', 'phase=fix', 'wall_ms=60000', ...extra];
  assert.equal(sflog(log, codexFixer(['round=1', 'direction=true', 'merged_items=1'])).status, 0, 'round 1 has the reviewer above → covered');
  assert.equal(sflog(log, codexFixer(['round=2', 'direction=true', 'merged_items=2'])).status, 0, 'round 2 has no reviewer → listed');
  assert.equal(sflog(log, codexFixer(['round=3', 'direction=false'])).status, 0, 'ungated → not listed');
  assert.equal(sflog(log, codexFixer(['round=4', 'direction=true', 'merged_items=0'])).status, 0, 'zero merged items → not listed');
  assert.equal(sflog(log, codexFixer(['round=5', 'direction=true'])).status, 0, 'merged_items absent → listed as unknown');
  // Collision: an epic_phase=A round=1 reviewer does not cover an epic_phase=B round=1 fixer.
  assert.equal(sflog(log, ['spawn', 'role=direction-reviewer', 'agent_type=sf-direction-reviewer', 'model=session', 'phase=fix', 'round=1', 'epic_phase=A', 'direction=/x/A.md', 'merged_items=1', `started=${t0}`]).status, 0);
  assert.equal(sflog(log, codexFixer(['round=1', 'epic_phase=B', 'direction=true', 'merged_items=1'])).status, 0);
  // Out-of-order write: the round-10 fixer is logged before its reviewer, so it is listed —
  // but the reviewer exists, which the post-pass distinguishes via reviewer_logged_later.
  assert.equal(sflog(log, codexFixer(['round=10', 'direction=true', 'merged_items=3'])).status, 0);
  assert.equal(sflog(log, ['spawn', 'role=direction-reviewer', 'agent_type=sf-direction-reviewer', 'model=session', 'phase=fix', 'round=10', 'direction=/x/r10.md', 'merged_items=1', `started=${t0}`]).status, 0);
  // A fixer with no round is never flagged (the gate keys on the namespaced round).
  assert.equal(sflog(log, codexFixer(['direction=true', 'merged_items=1'])).status, 0, 'no round → written, never flagged');
  // Write-side field invariants: a malformed count or blank direction is refused (exit 2), no row written.
  assert.equal(sflog(log, codexFixer(['round=8', 'direction=true', 'merged_items=abc'])).status, 2, 'merged_items=abc refused at write');
  assert.equal(sflog(log, codexFixer(['round=9', 'direction='])).status, 2, 'direction= refused at write');
  // Pre-written rows a stricter write would now reject still fail closed at check: a
  // non-numeric count and a blank direction both stay gated-and-listed as 'unknown'.
  const synth = (o) => writeFileSync(log, readFileSync(log, 'utf8') + `${JSON.stringify({ stage: 'spawn', role: 'fixer', agent_type: 'codex-exec', model: 'm', phase: 'fix', wall_ms: 1, ts: new Date().toISOString(), ...o })}\n`);
  synth({ round: 6, direction: true, merged_items: 'abc' });
  synth({ round: 7, direction: '' });

  const report = JSON.parse(sflog(log, ['check', log]).stdout);
  const listed = report.fixers_without_direction_review.map((x) => ({ round: x.round, epic_phase: x.epic_phase, merged_items: x.merged_items }));
  assert.deepEqual(listed, [
    { round: 2, epic_phase: null, merged_items: 2 },
    { round: 5, epic_phase: null, merged_items: 'unknown' },
    { round: 1, epic_phase: 'B', merged_items: 1 },
    { round: 10, epic_phase: null, merged_items: 3 },
    { round: 6, epic_phase: null, merged_items: 'unknown' },
    { round: 7, epic_phase: null, merged_items: 'unknown' },
  ]);
  // reviewer_logged_later distinguishes an out-of-order reviewer (round 10) from one never logged (round 2).
  const byRound = (r) => report.fixers_without_direction_review.find((x) => x.round === r && x.epic_phase === null);
  assert.equal(byRound(10).reviewer_logged_later, true);
  assert.equal(byRound(2).reviewer_logged_later, false);
});

test('0.31.0: adjudication stage requires its counts, and check flags a closure that ran on unadjudicated semantic gaps', () => {
  const { log } = fixture();
  // The stage validates its four required counts.
  assert.equal(sflog(log, ['stage', 'adjudication', 'round=1', 'gaps=2', 'accepted=1', 'redirected=1']).status, 0);
  const missing = sflog(log, ['stage', 'adjudication', 'round=1', 'gaps=2', 'redirected=1']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /requires accepted=/);
  // …and each count must be a non-negative integer, not just present.
  const nonNumeric = sflog(log, ['stage', 'adjudication', 'round=1', 'gaps=abc', 'accepted=1', 'redirected=1']);
  assert.equal(nonNumeric.status, 2, 'a non-numeric count is refused at write');
  assert.match(nonNumeric.stderr, /gaps must be a non-negative integer/);

  // Build a ledger exercising every check path on a fresh log.
  const fresh = fixture();
  const t0 = Date.now() - 60000;
  const fixer = (extra) => ['spawn', 'role=fixer', 'agent_type=codex-exec', 'model=gpt-6.1-sol', 'backend=codex', 'phase=fix', 'wall_ms=60000', ...extra];
  const closure = (extra) => ['stage', 'closure-exchange', 'role=reviewer:security', 'wall_ms=60000', ...extra];
  const coldReviewer = (extra) => ['spawn', 'role=reviewer:security', 'agent_type=security-reviewer', 'model=opus', 'phase=review', `started=${t0}`, ...extra];

  // round 1: fixer reported gaps, closure ran with no adjudication → flagged.
  assert.equal(sflog(fresh.log, fixer(['round=1', 'plan_gaps_semantic=2'])).status, 0);
  assert.equal(sflog(fresh.log, closure(['round=1'])).status, 0);
  // round 2: fixer gaps, adjudication clears them, then closure → not flagged.
  assert.equal(sflog(fresh.log, fixer(['round=2', 'plan_gaps_semantic=2'])).status, 0);
  assert.equal(sflog(fresh.log, ['stage', 'adjudication', 'round=2', 'gaps=2', 'accepted=2', 'redirected=0']).status, 0);
  assert.equal(sflog(fresh.log, closure(['round=2'])).status, 0);
  // round 3: fixer(2) → adjudication(redirected=1) → redirect addendum fixer(1) → closure,
  // no second adjudication → flagged with redirected(1) + the addendum's own gaps(1) = 2.
  assert.equal(sflog(fresh.log, fixer(['round=3', 'plan_gaps_semantic=2'])).status, 0);
  assert.equal(sflog(fresh.log, ['stage', 'adjudication', 'round=3', 'gaps=2', 'accepted=1', 'redirected=1']).status, 0);
  assert.equal(sflog(fresh.log, fixer(['round=3', 'addendum=redirect', 'plan_gaps_semantic=1'])).status, 0);
  assert.equal(sflog(fresh.log, closure(['round=3'])).status, 0);
  // round 4: same as round 3 but a second adjudication after the addendum → not flagged.
  assert.equal(sflog(fresh.log, fixer(['round=4', 'plan_gaps_semantic=2'])).status, 0);
  assert.equal(sflog(fresh.log, ['stage', 'adjudication', 'round=4', 'gaps=2', 'accepted=1', 'redirected=1']).status, 0);
  assert.equal(sflog(fresh.log, fixer(['round=4', 'addendum=redirect', 'plan_gaps_semantic=1'])).status, 0);
  assert.equal(sflog(fresh.log, ['stage', 'adjudication', 'round=4', 'gaps=1', 'accepted=1', 'redirected=0']).status, 0);
  assert.equal(sflog(fresh.log, closure(['round=4'])).status, 0);
  // round 5: a cold-fallback review-phase reviewer spawn is the closure seat → flagged.
  assert.equal(sflog(fresh.log, fixer(['round=5', 'plan_gaps_semantic=1'])).status, 0);
  assert.equal(sflog(fresh.log, coldReviewer(['round=5'])).status, 0);
  // round 6: fixer reported zero semantic gaps → closure never gated.
  assert.equal(sflog(fresh.log, fixer(['round=6', 'plan_gaps_semantic=0'])).status, 0);
  assert.equal(sflog(fresh.log, closure(['round=6'])).status, 0);
  // round 7 (DR-4): a hand-written adjudication with a non-numeric redirected gates as 'unknown'
  // (a live write would be refused by the ints rule, so synthesize a pre-0.31.0 row).
  assert.equal(sflog(fresh.log, fixer(['round=7', 'plan_gaps_semantic=1'])).status, 0);
  writeFileSync(fresh.log, readFileSync(fresh.log, 'utf8') + `${JSON.stringify({ stage: 'adjudication', round: 7, gaps: 1, accepted: 0, redirected: 'abc', ts: new Date().toISOString() })}\n`);
  assert.equal(sflog(fresh.log, closure(['round=7'])).status, 0);
  // Collision: two phases reuse round=1; only the phase whose gaps went unadjudicated is flagged.
  assert.equal(sflog(fresh.log, fixer(['round=1', 'epic_phase=A', 'plan_gaps_semantic=2'])).status, 0);
  assert.equal(sflog(fresh.log, fixer(['round=1', 'epic_phase=B', 'plan_gaps_semantic=2'])).status, 0);
  assert.equal(sflog(fresh.log, ['stage', 'adjudication', 'round=1', 'epic_phase=B', 'gaps=2', 'accepted=2', 'redirected=0']).status, 0);
  assert.equal(sflog(fresh.log, closure(['round=1', 'epic_phase=A'])).status, 0);
  assert.equal(sflog(fresh.log, closure(['round=1', 'epic_phase=B'])).status, 0);

  const report = JSON.parse(sflog(fresh.log, ['check', fresh.log]).stdout);
  const flagged = report.closures_without_adjudication.map((x) => ({ round: x.round, epic_phase: x.epic_phase, plan_gaps_semantic: x.plan_gaps_semantic }));
  assert.deepEqual(flagged, [
    { round: 1, epic_phase: null, plan_gaps_semantic: 2 },
    { round: 3, epic_phase: null, plan_gaps_semantic: 2 },
    { round: 5, epic_phase: null, plan_gaps_semantic: 1 },
    { round: 7, epic_phase: null, plan_gaps_semantic: 'unknown' },
    { round: 1, epic_phase: 'A', plan_gaps_semantic: 2 },
  ]);
  assert.equal(report.ok, true, 'all new checks are warn-level; exit code unchanged');
});

test('0.31.0: plan_gaps_semantic is validated at write, accumulates across fixer spawns, and gates as unknown when absent', () => {
  const { log } = fixture();
  const fixerArgs = (extra) => ['spawn', 'role=fixer', 'agent_type=codex-exec', 'model=gpt-6.1-sol', 'backend=codex', 'phase=fix', 'wall_ms=60000', ...extra];
  // Write-side field invariant (mirrors merged_items): a malformed count is refused, no row written.
  assert.equal(sflog(log, fixerArgs(['round=1', 'plan_gaps_semantic=abc'])).status, 2, 'plan_gaps_semantic=abc refused at write');
  assert.equal(sflog(log, fixerArgs(['round=1', 'plan_gaps_cosmetic=abc'])).status, 2, 'plan_gaps_cosmetic=abc refused at write');
  assert.equal(sflog(log, fixerArgs(['round=1', 'plan_gaps_semantic=-1'])).status, 2, 'a negative count is refused at write');

  const fresh = fixture();
  const closure = (extra) => ['stage', 'closure-exchange', 'role=reviewer:security', 'wall_ms=60000', ...extra];
  // Accumulation: first fixer(2) + a late-seat addendum(0) → the round still owes 2 gaps; a
  // closure with no adjudication is flagged with the SUM, not the addendum's overwrite (0).
  assert.equal(sflog(fresh.log, fixerArgs(['round=1', 'plan_gaps_semantic=2'])).status, 0);
  assert.equal(sflog(fresh.log, fixerArgs(['round=1', 'addendum=true', 'plan_gaps_semantic=0'])).status, 0);
  assert.equal(sflog(fresh.log, closure(['round=1'])).status, 0);
  // Unknown: a pre-0.31.0 fixer row (no plan_gaps_semantic) gates its round as 'unknown';
  // a later numeric fixer spawn does not clear it (unknown absorbs).
  const synth = (o) => writeFileSync(fresh.log, readFileSync(fresh.log, 'utf8') + `${JSON.stringify({ stage: 'spawn', role: 'fixer', agent_type: 'codex-exec', model: 'm', phase: 'fix', wall_ms: 1, ts: new Date().toISOString(), ...o })}\n`);
  synth({ round: 2 });                                  // absent count
  assert.equal(sflog(fresh.log, fixerArgs(['round=2', 'plan_gaps_semantic=3'])).status, 0);
  assert.equal(sflog(fresh.log, closure(['round=2'])).status, 0);
  synth({ round: 3, plan_gaps_semantic: 'abc' });       // non-numeric on a hand-written row
  assert.equal(sflog(fresh.log, closure(['round=3'])).status, 0);

  const report = JSON.parse(sflog(fresh.log, ['check', fresh.log]).stdout);
  const flagged = report.closures_without_adjudication.map((x) => ({ round: x.round, plan_gaps_semantic: x.plan_gaps_semantic }));
  assert.deepEqual(flagged, [
    { round: 1, plan_gaps_semantic: 2 },
    { round: 2, plan_gaps_semantic: 'unknown' },
    { round: 3, plan_gaps_semantic: 'unknown' },
  ]);
  assert.equal(report.ok, true, 'all adjudication checks are warn-level');
});

test('0.28.0: session-resumed is a known stage that requires source=', () => {
  const { log } = fixture();
  const bad = sflog(log, ['stage', 'session-resumed']);
  assert.notEqual(bad.status, 0);
  const ok = sflog(log, ['stage', 'session-resumed', 'source=resume', 'session_id=abc']);
  assert.equal(ok.status, 0, ok.stderr);
  const ev = lastEvent(log);
  assert.equal(ev.stage, 'session-resumed'); assert.equal(ev.source, 'resume');
  const check = sflog(log, ['check']);
  assert.equal(JSON.parse(check.stdout).unknown_stages.length, 0);
});

test('operator-wait requires an integer questions=; blocking must be a string array', () => {
  const { log } = fixture();
  const ok = sflog(log, ['stage', 'operator-wait', 'questions=2', 'at=3e', 'blocking=["Q1","Q2"]', 'artifact=/a/operator-questions.md']);
  assert.equal(ok.status, 0, ok.stderr);
  const ev = lastEvent(log);
  assert.equal(ev.stage, 'operator-wait'); assert.equal(ev.questions, 2); assert.deepEqual(ev.blocking, ['Q1', 'Q2']);
  const lines = () => readFileSync(log, 'utf8').trim().split('\n').length;
  const before = lines();
  for (const args of [[], ['questions=two'], ['questions=1.5'], ['questions=2', 'blocking=Q1']]) {
    const bad = sflog(log, ['stage', 'operator-wait', ...args]);
    assert.equal(bad.status, 2, `refused: ${args.join(' ')}`);
  }
  assert.equal(lines(), before, 'nothing appended');
  assert.equal(JSON.parse(sflog(log, ['check']).stdout).unknown_stages.length, 0);
});

test('0.31.0: oscillation-stop validates severity/action, and check flags re-entered stops, repeated stops, and missed stops', () => {
  const { log } = fixture();
  // Stage validation: severity is a required enum, action an optional enum.
  assert.equal(sflog(log, ['stage', 'oscillation-stop', 'finding=U3', 'round=2', 'severity=HIGH']).status, 0);
  assert.equal(sflog(log, ['stage', 'oscillation-stop', 'finding=U3', 'round=2', 'severity=BLOCKER']).status, 2, 'BLOCKER is not a severity');
  assert.equal(sflog(log, ['stage', 'oscillation-stop', 'finding=U3', 'round=2', 'severity=HIGH', 'action=retry']).status, 2, 'retry is not an action');
  assert.equal(sflog(log, ['stage', 'oscillation-stop', 'finding=U3', 'round=2', 'severity=HIGH', 'action=design-note']).status, 0, 'action is optional but checked');

  const fixer = (extra) => ['spawn', 'role=fixer', 'agent_type=codex-exec', 'model=gpt-6.1-sol', 'backend=codex', 'phase=fix', 'wall_ms=60000', ...extra];
  const stop = (extra) => ['stage', 'oscillation-stop', ...extra];
  const closure = (extra) => ['stage', 'closure-exchange', 'role=reviewer:security', 'wall_ms=60000', ...extra];

  // Cluster A — fixers_on_stopped_findings + oscillation_stops_repeated (no reopened_ids here).
  const a = fixture();
  assert.equal(sflog(a.log, stop(['finding=U3', 'round=2', 'severity=HIGH'])).status, 0);                                  // no design note
  assert.equal(sflog(a.log, stop(['finding=U5', 'round=2', 'severity=HIGH', 'design_note=/abs/design-note-U5.md'])).status, 0);
  assert.equal(sflog(a.log, stop(['finding=U6', 'round=2', 'severity=HIGH', 'design_note=/abs/n1.md'])).status, 0);         // first U6 stop
  assert.equal(sflog(a.log, stop(['finding=U6', 'round=3', 'severity=HIGH', 'design_note=/abs/n2.md'])).status, 0);         // second U6 stop → repeated
  assert.equal(sflog(a.log, stop(['finding=U7', 'round=2', 'severity=HIGH'])).status, 0);                                  // no design note, but no fixer carries it
  assert.equal(sflog(a.log, fixer(['round=3', 'findings=["U3","U4"]'])).status, 0);   // U3 stopped, no note → flagged
  assert.equal(sflog(a.log, fixer(['round=3', 'findings=["U5"]'])).status, 0);        // U5 has a note, one stop → not flagged
  assert.equal(sflog(a.log, fixer(['round=4', 'findings=["U6"]'])).status, 0);        // U6 has two stops → flagged regardless of note
  assert.equal(sflog(a.log, fixer(['round=3', 'findings=["U8"]'])).status, 0);        // omits stopped U7 → not flagged

  const ra = JSON.parse(sflog(a.log, ['check', a.log]).stdout);
  assert.deepEqual(
    ra.fixers_on_stopped_findings.map((x) => ({ finding: x.finding, reason: x.reason })),
    [{ finding: 'U3', reason: 'no-design-note' }, { finding: 'U6', reason: 'second-design-note' }],
  );
  assert.deepEqual(ra.oscillation_stops_repeated.map((x) => x.finding), ['U6']);
  assert.deepEqual(ra.reopened_twice_without_stop, [], 'no reopened_ids in cluster A');
  assert.equal(ra.ok, true, 'oscillation checks are warn-level');

  // Cluster B1 — an id reopened in two distinct rounds that a later fixer ran on with no stop.
  const b1 = fixture();
  assert.equal(sflog(b1.log, closure(['round=1', 'reopened_ids=["U3"]'])).status, 0);
  assert.equal(sflog(b1.log, closure(['round=2', 'reopened_ids=["U3"]'])).status, 0);
  assert.equal(sflog(b1.log, fixer(['round=3'])).status, 0);
  const rb1 = JSON.parse(sflog(b1.log, ['check', b1.log]).stdout);
  assert.equal(rb1.reopened_twice_without_stop.length, 1);
  assert.equal(rb1.reopened_twice_without_stop[0].finding, 'U3');
  assert.equal(rb1.reopened_twice_without_stop[0].rounds.length, 2);

  // Cluster B2 — two closure seats reopen the id in the SAME round → one distinct round → empty.
  const b2 = fixture();
  assert.equal(sflog(b2.log, closure(['round=1', 'reopened_ids=["U9"]'])).status, 0);
  assert.equal(sflog(b2.log, closure(['round=1', 'reopened_ids=["U9"]'])).status, 0);
  assert.equal(sflog(b2.log, fixer(['round=2'])).status, 0);
  assert.deepEqual(JSON.parse(sflog(b2.log, ['check', b2.log]).stdout).reopened_twice_without_stop, []);

  // Cluster B3 — two rounds but a stop between them suppresses the missed-stop flag.
  const b3 = fixture();
  assert.equal(sflog(b3.log, closure(['round=1', 'reopened_ids=["U3"]'])).status, 0);
  assert.equal(sflog(b3.log, stop(['finding=U3', 'round=1', 'severity=HIGH'])).status, 0);
  assert.equal(sflog(b3.log, closure(['round=2', 'reopened_ids=["U3"]'])).status, 0);
  assert.equal(sflog(b3.log, fixer(['round=3'])).status, 0);
  assert.deepEqual(JSON.parse(sflog(b3.log, ['check', b3.log]).stdout).reopened_twice_without_stop, []);

  // Collision — the same round in two epic phases; only the phase reopened twice is flagged.
  const c = fixture();
  assert.equal(sflog(c.log, closure(['round=1', 'epic_phase=A', 'reopened_ids=["U3"]'])).status, 0);
  assert.equal(sflog(c.log, closure(['round=2', 'epic_phase=A', 'reopened_ids=["U3"]'])).status, 0);
  assert.equal(sflog(c.log, closure(['round=1', 'epic_phase=B', 'reopened_ids=["U3"]'])).status, 0);
  assert.equal(sflog(c.log, fixer(['round=3', 'epic_phase=A'])).status, 0);
  assert.equal(sflog(c.log, fixer(['round=2', 'epic_phase=B'])).status, 0);
  const rc = JSON.parse(sflog(c.log, ['check', c.log]).stdout);
  assert.equal(rc.reopened_twice_without_stop.length, 1, 'only phase A reopened twice');
  assert.deepEqual(rc.reopened_twice_without_stop[0].rounds, ['A:1', 'A:2']);
});

test('0.31.0: oscillation disposition — checkpoint/bucket-3 second stops are not repeats; fixer reason follows the latest disposition', () => {
  const { log } = fixture();
  const fixer = (extra) => ['spawn', 'role=fixer', 'agent_type=codex-exec', 'model=gpt-6.1-sol', 'backend=codex', 'phase=fix', 'wall_ms=60000', ...extra];
  const stop = (extra) => ['stage', 'oscillation-stop', ...extra];

  // U1: design-note stop (with note) → checkpoint second stop is the §3 terminal move, not a repeat.
  assert.equal(sflog(log, stop(['finding=U1', 'round=2', 'severity=HIGH', 'design_note=/abs/n.md'])).status, 0);
  assert.equal(sflog(log, stop(['finding=U1', 'round=4', 'severity=HIGH', 'action=checkpoint'])).status, 0);
  // U2: design-note stop → bucket-3 second stop, also terminal.
  assert.equal(sflog(log, stop(['finding=U2', 'round=2', 'severity=HIGH', 'design_note=/abs/n2.md'])).status, 0);
  assert.equal(sflog(log, stop(['finding=U2', 'round=4', 'severity=HIGH', 'action=bucket-3'])).status, 0);
  // U3: design-note → checkpoint → design-note flags the THIRD row (N6).
  assert.equal(sflog(log, stop(['finding=U3', 'round=2', 'severity=HIGH', 'design_note=/abs/a.md'])).status, 0);
  assert.equal(sflog(log, stop(['finding=U3', 'round=3', 'severity=HIGH', 'action=checkpoint'])).status, 0);
  assert.equal(sflog(log, stop(['finding=U3', 'round=4', 'severity=HIGH', 'action=design-note', 'design_note=/abs/b.md'])).status, 0);
  // A fixer carrying each id after its latest stop.
  assert.equal(sflog(log, fixer(['round=5', 'findings=["U1","U2","U3"]'])).status, 0);

  const r = JSON.parse(sflog(log, ['check', log]).stdout);
  assert.deepEqual(r.oscillation_stops_repeated.map((x) => x.finding), ['U3'], 'only the design-note third row is a repeat');
  assert.deepEqual(
    r.fixers_on_stopped_findings.map((x) => ({ finding: x.finding, reason: x.reason })),
    [
      { finding: 'U1', reason: 're-entered-after-checkpoint' },
      { finding: 'U2', reason: 're-entered-after-bucket-3' },
      { finding: 'U3', reason: 'second-design-note' },
    ],
  );
  assert.equal(r.ok, true, 'oscillation checks are warn-level');
});

test('0.31.0: oscillation collisions, linear ordering, and the one sanctioned re-entry', () => {
  const fixer = (extra) => ['spawn', 'role=fixer', 'agent_type=codex-exec', 'model=gpt-6.1-sol', 'backend=codex', 'phase=fix', 'wall_ms=60000', ...extra];
  const stop = (extra) => ['stage', 'oscillation-stop', ...extra];

  // Collision: a stop in epic_phase A and one in B for the same id are two first stops (no repeat);
  // a fixer carrying the id is flagged only in the phase whose stop it shares.
  const c = fixture();
  assert.equal(sflog(c.log, stop(['finding=U3', 'round=2', 'epic_phase=A', 'severity=HIGH'])).status, 0);
  assert.equal(sflog(c.log, stop(['finding=U3', 'round=2', 'epic_phase=B', 'severity=HIGH'])).status, 0);
  assert.equal(sflog(c.log, fixer(['round=3', 'epic_phase=B', 'findings=["U3"]'])).status, 0);
  assert.equal(sflog(c.log, fixer(['round=3', 'epic_phase=A', 'findings=["U3"]'])).status, 0);
  const rc = JSON.parse(sflog(c.log, ['check', c.log]).stdout);
  assert.deepEqual(rc.oscillation_stops_repeated, [], 'two phases, two first stops — no repeat');
  assert.deepEqual(
    rc.fixers_on_stopped_findings.map((x) => ({ finding: x.finding, epic_phase: x.epic_phase, reason: x.reason })),
    [{ finding: 'U3', epic_phase: 'B', reason: 'no-design-note' }, { finding: 'U3', epic_phase: 'A', reason: 'no-design-note' }],
  );

  // Linear ordering (B6): a fixer logged BEFORE the stop is an out-of-order write, not a
  // re-entry — not flagged; a fixer logged AFTER the stop is.
  const o = fixture();
  assert.equal(sflog(o.log, fixer(['round=2', 'findings=["U5"]'])).status, 0);
  assert.equal(sflog(o.log, stop(['finding=U5', 'round=2', 'severity=HIGH'])).status, 0);
  assert.equal(sflog(o.log, fixer(['round=3', 'findings=["U5"]'])).status, 0);
  const ro = JSON.parse(sflog(o.log, ['check', o.log]).stdout);
  assert.equal(ro.fixers_on_stopped_findings.length, 1, 'only the fixer after the stop is flagged');
  assert.equal(ro.fixers_on_stopped_findings[0].round, 3);

  // The one sanctioned re-entry: a single design-note stop WITH its note; a later fixer → no row.
  const s = fixture();
  assert.equal(sflog(s.log, stop(['finding=U7', 'round=2', 'severity=HIGH', 'design_note=/abs/n.md'])).status, 0);
  assert.equal(sflog(s.log, fixer(['round=3', 'findings=["U7"]'])).status, 0);
  assert.deepEqual(JSON.parse(sflog(s.log, ['check', s.log]).stdout).fixers_on_stopped_findings, [], 'sanctioned re-entry not flagged');
});

test('0.31.0: findings/reopened_ids/round/design_note write invariants and read-side malformed_fields', () => {
  const { log } = fixture();
  const fixer = (extra) => ['spawn', 'role=fixer', 'agent_type=codex-exec', 'model=gpt-6.1-sol', 'backend=codex', 'phase=fix', 'wall_ms=60000', ...extra];
  const stop = (extra) => ['stage', 'oscillation-stop', ...extra];
  const closure = (extra) => ['stage', 'closure-exchange', 'role=reviewer:security', 'wall_ms=60000', ...extra];

  // Write-time rejections (exit 2).
  assert.equal(sflog(log, fixer(['round=2', 'findings=U3'])).status, 2, 'scalar findings refused');
  assert.equal(sflog(log, fixer(['round=2', 'findings=["U3",""]'])).status, 2, 'empty element refused');
  assert.equal(sflog(log, closure(['round=2', 'reopened_ids=U3'])).status, 2, 'scalar reopened_ids refused');
  assert.equal(sflog(log, closure(['round=2', 'reopened_ids=[]'])).status, 0, 'empty array valid (B5)');
  assert.equal(sflog(log, stop(['finding=U3', 'round=abc', 'severity=HIGH'])).status, 2, 'round=abc refused');
  assert.equal(sflog(log, stop(['finding=U3', 'round=2', 'severity=HIGH', 'design_note='])).status, 2, 'empty design_note refused');
  assert.equal(sflog(log, stop(['finding=U3', 'round=2', 'severity=HIGH', 'design_note=true'])).status, 2, 'boolean design_note refused');

  // Read-side: hand-written pre-0.31 rows the write gate would now refuse.
  const f = fixture();
  const synth = (o) => writeFileSync(f.log, readFileSync(f.log, 'utf8') + `${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);
  synth({ stage: 'oscillation-stop', finding: 'U3', severity: 'HIGH' });                            // no round → missing-round, not stored (N3)
  synth({ stage: 'spawn', role: 'fixer', phase: 'fix', wall_ms: 1, round: 3, findings: 'U3' });     // scalar findings → not-array, still scanned (N2)
  synth({ stage: 'closure-exchange', role: 'reviewer:security', round: 1, reopened_ids: 'U9' });    // scalar reopened_ids → not-array
  const rf = JSON.parse(sflog(f.log, ['check', f.log]).stdout);
  assert.deepEqual(
    rf.malformed_fields.map((x) => ({ stage: x.stage, field: x.field, reason: x.reason })),
    [
      { stage: 'oscillation-stop', field: 'round', reason: 'missing-round' },
      { stage: 'spawn', field: 'findings', reason: 'not-array' },
      { stage: 'closure-exchange', field: 'reopened_ids', reason: 'not-array' },
    ],
  );
  // N3: the round-less stop was not stored, so the fixer carrying U3 is neither flagged nor suppressed.
  assert.deepEqual(rf.fixers_on_stopped_findings, [], 'round-less stop neither triggers nor suppresses');
  assert.equal(rf.ok, true, 'malformed_fields is warn-level');
});

// 0.33.0 — accounting honesty: an orphaned wall and a dead usage channel are reported.
test('check: a wall far past the seat\'s own duration is spawns_wall_orphaned; all-null tokens is usage_channel_dead', () => {
  const { log } = fixture();
  const base = ['spawn', 'agent_type=Explore', 'model=session', 'phase=plan', 'artifact=/a'];
  assert.equal(sflog(log, [...base, 'role=explore', 'agent_id=e1', 'duration_ms=565212', 'wall_ms=35153295']).status, 0);
  assert.equal(sflog(log, [...base, 'role=explore', 'agent_id=e2', 'duration_ms=130643', 'wall_ms=149574']).status, 0);
  assert.equal(sflog(log, [...base, 'role=explore', 'agent_id=e3', 'wall_ms=70000']).status, 0);
  const res = JSON.parse(sflog(log, ['check', '--compact']).stdout);
  assert.deepEqual(res.spawns_wall_orphaned.map((x) => x.role), ['explore']);
  assert.equal(res.spawns_wall_orphaned[0].wall_ms, 35153295);
  assert.equal(res.claude_spawns, 3);
  assert.equal(res.usage_channel_dead, true, 'three Claude spawns, none with tokens');
  assert.equal(sflog(log, [...base, 'role=explore', 'agent_id=e4', 'tokens=1000', 'wall_ms=70000']).status, 0);
  assert.equal(JSON.parse(sflog(log, ['check', '--compact']).stdout).usage_channel_dead, false);
});

test('check: a SOLO_MODEL run flags non-Explore Claude spawns at another model', () => {
  const { log } = fixture();
  assert.equal(sflog(log, ['stage', 'preflight', 'solo_model=opus']).status, 0);
  const base = ['spawn', 'phase=review', 'wall_ms=70000', 'artifact=/a'];
  assert.equal(sflog(log, [...base, 'role=explore', 'agent_type=Explore', 'model=haiku', 'agent_id=s1']).status, 0);
  assert.equal(sflog(log, [...base, 'role=implementer', 'agent_type=sf-implementer', 'model=opus', 'agent_id=s2']).status, 0);
  assert.equal(sflog(log, [...base, 'role=reviewer:copy', 'agent_type=copy-lead', 'model=sonnet', 'agent_id=s3']).status, 0);
  const res = JSON.parse(sflog(log, ['check', '--compact']).stdout);
  assert.deepEqual(res.spawns_off_solo_model.map((x) => [x.role, x.model]), [['reviewer:copy', 'sonnet']]);
});

// Phase 2 — trustworthy audit logs.
test('cursor records log_path relative to the runstate directory; an explicit log_path= wins', () => {
  const { dir, log } = fixture();
  const rs = join(dir, 'task-x.runstate.json');
  const res = sflog(log, ['cursor', rs, 'stage=3e', '--compact']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(readFileSync(rs, 'utf8')).log_path, 'run.jsonl');
  assert.equal(sflog(log, ['cursor', rs, 'log_path=pinned.jsonl']).status, 0);
  assert.equal(JSON.parse(readFileSync(rs, 'utf8')).log_path, 'pinned.jsonl');
});

test('cursor stamps session_id from CLAUDE_CODE_SESSION_ID; an explicit session_id= wins; unset leaves it', () => {
  const { dir, log } = fixture();
  const rs = join(dir, 'task-x.runstate.json');
  const run = (args, sid) => spawnSync(process.execPath, [SF_LOG, 'cursor', rs, ...args], {
    encoding: 'utf8',
    env: { ...process.env, RUN_LOG: log, SF_RUN_TASK: 'unit', SF_CLAUDE_PROJECTS_DIR: NO_TRANSCRIPTS, CLAUDE_CODE_SESSION_ID: sid },
  });
  assert.equal(run(['stage=3e'], 'sess-a').status, 0);
  assert.equal(JSON.parse(readFileSync(rs, 'utf8')).session_id, 'sess-a');
  assert.equal(run(['stage=3f'], 'sess-b').status, 0, 'an adopting session takes ownership');
  assert.equal(JSON.parse(readFileSync(rs, 'utf8')).session_id, 'sess-b');
  assert.equal(run(['stage=3g', 'session_id=pinned'], 'sess-c').status, 0);
  assert.equal(JSON.parse(readFileSync(rs, 'utf8')).session_id, 'pinned');
  assert.equal(run(['stage=3h'], '').status, 0);
  assert.equal(JSON.parse(readFileSync(rs, 'utf8')).session_id, 'pinned', 'no session in env leaves the owner');
});

test('cursor refuses a log_path outside the runstate directory: $RUN_LOG elsewhere is warned and left, an explicit one exits 2', () => {
  const { dir, log } = fixture();
  const rs = join(dir, 'plans', 'task-x.runstate.json');
  const res = sflog(log, ['cursor', rs, 'stage=3e']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /not beside the runstate/);
  assert.equal(JSON.parse(readFileSync(rs, 'utf8')).log_path, undefined);
  for (const bad of ['../run.jsonl', '../../.env', 'notes.txt']) {
    const r = sflog(log, ['cursor', rs, `log_path=${bad}`]);
    assert.equal(r.status, 2, bad);
    assert.equal(JSON.parse(readFileSync(rs, 'utf8')).log_path, undefined, `${bad} not written`);
  }
});

test('init --resume refuses a recorded log_path that escapes the runstate directory, names a directory, or is not *.jsonl', () => {
  const { dir } = fixture();
  const plans = join(dir, 'repo', 'docs', 'plans');
  mkdirSync(plans, { recursive: true });
  const env = join(dir, 'repo', '.env');
  writeFileSync(env, 'SECRET=1\n');
  mkdirSync(join(plans, 'adir.jsonl'));
  const rs = join(plans, 'task-x.runstate.json');
  for (const logPath of ['../../.env', 'adir.jsonl', '../../repo/.env']) {
    writeFileSync(rs, JSON.stringify({ log_path: logPath }));
    const fresh = join(plans, `fresh-${logPath.length}.jsonl`);
    const res = sflog(fresh, ['init', '--resume', rs, '--host', 'codex']);
    assert.equal(res.status, 0, `${logPath}: ${res.stderr}`);
    assert.match(res.stderr, /continuing in a new log/);
    assert.equal(res.stdout.trim(), fresh);
  }
  assert.equal(readFileSync(env, 'utf8'), 'SECRET=1\n', '.env untouched');
});

test('init --resume through a symlinked alias of the recorded ledger neither folds nor deletes it', () => {
  const { dir } = fixture();
  const real = join(dir, 'real', 'docs', 'plans');
  mkdirSync(real, { recursive: true });
  const ledger = join(real, 'ship-task-1.jsonl');
  writeFileSync(ledger, `${JSON.stringify({ stage: 'run-meta', ts: '2026-09-25T17:00:00.000Z' })}\n`);
  const rs = join(real, 'task-x.runstate.json');
  writeFileSync(rs, JSON.stringify({ log_path: 'ship-task-1.jsonl' }));
  symlinkSync(join(dir, 'real'), join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const res = sflog(join(dir, 'alias', 'docs', 'plans', 'ship-task-1.jsonl'), ['init', '--resume', rs, '--host', 'codex']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(ledger), true, 'the ledger survives');
  const events = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.length, 2, 'one resumed mark, nothing folded');
  assert.equal(events[1].resumed, true);
});

test('init --resume prints the ledger in the runstate\'s own spelling, not its realpath', () => {
  const { dir, log } = fixture();
  const real = join(dir, 'real', 'docs', 'plans');
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'ship-task-1.jsonl'), `${JSON.stringify({ stage: 'run-meta', ts: '2026-09-25T17:00:00.000Z' })}\n`);
  writeFileSync(join(real, 'task-x.runstate.json'), JSON.stringify({ log_path: 'ship-task-1.jsonl' }));
  symlinkSync(join(dir, 'real'), join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const aliasDir = join(dir, 'alias', 'docs', 'plans');
  const res = sflog(log, ['init', '--resume', join(aliasDir, 'task-x.runstate.json'), '--host', 'codex']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), join(aliasDir, 'ship-task-1.jsonl'), 'matches a "$WT_PATH"/docs/plans/*.jsonl guard');
});

test('init --resume after a crash between fold and unlink only unlinks the Stage-0 log', () => {
  const { dir, log: recorded } = fixture();
  const rs = join(dir, 'task-x.runstate.json');
  writeFileSync(rs, JSON.stringify({ log_path: 'run.jsonl' }));
  const stage0 = [
    { stage: 'run-meta', skill: 'ship-task', ts: '2026-09-25T18:00:00.000Z' },
    { stage: 'preflight', ts: '2026-09-25T18:00:05.000Z' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  const current = join(dir, 'ship-task-2.jsonl');
  writeFileSync(current, stage0);
  assert.equal(sflog(current, ['init', '--resume', rs]).status, 0);
  const after = readFileSync(recorded, 'utf8');
  writeFileSync(current, stage0); // the unlink never happened
  const res = sflog(current, ['init', '--resume', rs]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(recorded, 'utf8'), after, 'no second fold');
  assert.equal(existsSync(current), false);
});

test('init --resume appends to the recorded log: resumed mark first, then the current log, which is removed', () => {
  const { dir, log: recorded } = fixture();
  const rs = join(dir, 'task-x.runstate.json');
  writeFileSync(rs, JSON.stringify({ stage: '3e', log_path: 'run.jsonl' }));
  const current = join(dir, 'ship-task-2.jsonl');
  writeFileSync(current, [
    { stage: 'run-meta', skill: 'ship-task', ts: '2026-09-25T18:00:00.000Z' },
    { stage: 'preflight', ts: '2026-09-25T18:00:05.000Z' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const res = sflog(current, ['init', '--resume', rs]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), recorded);
  assert.equal(existsSync(current), false, 'the Stage-0 log is folded and deleted');
  const events = readFileSync(recorded, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.length, 3);
  assert.deepEqual([events[1].stage, events[1].resumed, events[1].ts], ['run-meta', true, '2026-09-25T18:00:00.000Z']);
  assert.equal(events[2].stage, 'preflight');
});

test('init --resume: a missing recorded log falls back to a new log with a warning; an unreadable runstate exits 2', () => {
  const { dir } = fixture();
  const rs = join(dir, 'task-x.runstate.json');
  writeFileSync(rs, JSON.stringify({ log_path: 'gone.jsonl' }));
  const fresh = join(dir, 'fresh.jsonl');
  const res = sflog(fresh, ['init', '--resume', rs, '--host', 'codex']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /does not exist/);
  assert.equal(res.stdout.trim(), fresh);
  assert.equal(JSON.parse(readFileSync(fresh, 'utf8').trim()).stage, 'run-meta');
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.equal(sflog(fresh, ['init', '--resume', bad]).status, 2);
});

test('spawn refuses a bare reviewer name, an empty reviewer:, and an implementer logged at phase=fix', () => {
  const { log } = fixture();
  const lines = () => readFileSync(log, 'utf8').trim().split('\n').length;
  const base = ['spawn', 'agent_type=a', 'model=m', 'wall_ms=60000'];
  for (const [role, phase, re] of [
    ['security-reviewer', 'review', /must start with one of/],
    ['reviewer:', 'review', /names no agent/],
    ['implementer', 'fix', /role=fixer/],
  ]) {
    const res = sflog(log, [...base, `role=${role}`, `phase=${phase}`]);
    assert.equal(res.status, 2, `${role} ${phase}`);
    assert.match(res.stderr, re);
  }
  assert.equal(lines(), 1, 'nothing appended');
  assert.equal(sflog(log, [...base, 'role=implementer', 'phase=implement']).status, 0);
});

test('a Claude continuation stores per-turn usage as the delta against the same agent_id; no agent_id is refused', () => {
  const { log } = fixture();
  assert.equal(sflog(log, [...SPAWN_BASE, 'tokens=1000', 'agent_id=A', 'wall_ms=60000']).status, 0);
  const closure = ['stage', 'closure-exchange', 'role=reviewer:security:closure', 'round=1', 'path=warm', 'wall_ms=60000'];
  const res = sflog(log, [...closure, 'tokens=1500', 'agent_id=A']);
  assert.equal(res.status, 0, res.stderr);
  const ev = lastEvent(log);
  assert.deepEqual([ev.tokens, ev.tokens_cumulative, ev.usage_basis], [500, 1500, 'delta']);
  assert.equal(sflog(log, [...closure, 'round=2', 'tokens=1800', 'agent_id=A']).status, 0);
  assert.deepEqual([lastEvent(log).tokens, lastEvent(log).tokens_cumulative], [300, 1800]);
  assert.equal(sflog(log, [...closure, 'round=3', 'tokens=200', 'agent_id=A']).status, 0);
  assert.deepEqual([lastEvent(log).tokens, lastEvent(log).usage_basis], [200, 'per-turn'], 'lower than prev → per-turn raw');
  const anon = sflog(log, [...closure, 'tokens=100']);
  assert.equal(anon.status, 2);
  assert.match(anon.stderr, /requires agent_id/);
  const codex = sflog(log, [...closure, 'backend=codex', 'tokens=100']);
  assert.equal(codex.status, 0, 'codex resume turns are per-turn already');
  assert.equal(lastEvent(log).usage_basis, undefined);
});

test('de-cumulation: a per-turn channel stays per-turn, and an intervening row without usage keeps the baseline', () => {
  const { log } = fixture();
  const closure = ['stage', 'closure-exchange', 'role=reviewer:security:closure', 'round=1', 'path=warm', 'wall_ms=60000'];
  assert.equal(sflog(log, [...SPAWN_BASE, 'tokens=1000', 'agent_id=P', 'wall_ms=60000']).status, 0);
  assert.equal(sflog(log, [...closure, 'tokens=300', 'agent_id=P']).status, 0);
  assert.deepEqual([lastEvent(log).tokens, lastEvent(log).usage_basis], [300, 'per-turn']);
  assert.equal(sflog(log, [...closure, 'round=2', 'tokens=400', 'agent_id=P']).status, 0);
  assert.deepEqual([lastEvent(log).tokens, lastEvent(log).usage_basis], [400, 'per-turn'], 'not a delta against a per-turn row');
  assert.equal(sflog(log, [...SPAWN_BASE, 'tokens=1000', 'agent_id=Q', 'wall_ms=60000']).status, 0);
  assert.equal(sflog(log, ['stage', 'note', 'event=aside', 'agent_id=Q']).status, 0);
  assert.equal(sflog(log, [...closure, 'tokens=1500', 'agent_id=Q']).status, 0);
  assert.deepEqual([lastEvent(log).tokens, lastEvent(log).tokens_cumulative, lastEvent(log).usage_basis], [500, 1500, 'delta']);
});

test('de-cumulation: a first value with no baseline is not a per-turn channel; stickiness is per field', () => {
  const { log } = fixture();
  const closure = ['stage', 'closure-exchange', 'role=reviewer:security:closure', 'round=1', 'path=warm', 'wall_ms=60000'];
  assert.equal(sflog(log, [...SPAWN_BASE, 'agent_id=N', 'wall_ms=60000']).status, 0, 'spawn without tokens');
  const stored = [];
  for (const t of [60000, 80000, 100000]) {
    assert.equal(sflog(log, [...closure, `tokens=${t}`, 'agent_id=N']).status, 0);
    stored.push(lastEvent(log).tokens);
  }
  assert.deepEqual(stored, [60000, 20000, 20000], 'cumulative stream sums to 100k, not 240k');
  assert.equal(sflog(log, [...SPAWN_BASE, 'tokens=1000', 'duration_ms=9000', 'agent_id=F', 'wall_ms=60000']).status, 0);
  assert.equal(sflog(log, [...closure, 'tokens=1500', 'duration_ms=4000', 'agent_id=F']).status, 0);
  assert.deepEqual([lastEvent(log).tokens, lastEvent(log).duration_ms], [500, 4000]);
  assert.equal(sflog(log, [...closure, 'tokens=1800', 'duration_ms=5000', 'agent_id=F']).status, 0);
  assert.deepEqual([lastEvent(log).tokens, lastEvent(log).tokens_cumulative, lastEvent(log).duration_ms], [300, 1800, 5000],
    'duration_ms went per-turn; tokens still de-cumulates');
});

test('stage refuses caller-supplied stage=, *_cumulative= and usage_basis=', () => {
  const { log } = fixture();
  for (const kv of ['stage=run-meta', 'tokens_cumulative=5', 'duration_ms_cumulative=5', 'usage_basis=delta']) {
    const res = sflog(log, ['stage', 'note', 'event=x', kv]);
    assert.equal(res.status, 2, kv);
    assert.match(res.stderr, /set by sf-log/);
  }
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'nothing appended');
});

test('a Claude spawn or continuation without tokens carries usage_missing:true; a codex row does not', () => {
  const { log } = fixture();
  assert.equal(sflog(log, [...SPAWN_BASE, 'wall_ms=60000']).status, 0);
  assert.equal(lastEvent(log).usage_missing, true);
  assert.equal(sflog(log, ['stage', 'clarify', 'role=reviewer:security:clarify', 'round=1', 'wall_ms=60000']).status, 0);
  assert.equal(lastEvent(log).usage_missing, true);
  assert.equal(sflog(log, [...SPAWN_BASE, 'wall_ms=60000', 'tokens=5']).status, 0);
  assert.equal(lastEvent(log).usage_missing, undefined);
  assert.equal(sflog(log, ['spawn', 'role=reviewer:performance', 'agent_type=codex-exec', 'model=m', 'phase=review', 'backend=codex', 'wall_ms=60000']).status, 0);
  assert.equal(lastEvent(log).usage_missing, undefined);
});

test('task-decomposition requires per-task scope, per-batch seam_touched and parallelizable_reason (D9)', () => {
  const { log } = fixture();
  const complete = () => [
    {
      id: 'B1',
      tasks: [{ id: '1.1', scope: ['a.mjs'] }, { id: '1.2', scope: ['b.mjs'], depends_on: ['1.1'] }],
      seam_touched: false,
      parallelizable: false,
      parallelizable_reason: 'fewer than 2 independent tasks',
    },
  ];
  const run = (batches) => sflog(log, ['stage', 'task-decomposition', `batches=${JSON.stringify(batches)}`]);

  const ok = run(complete());
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(lastEvent(log).batches, complete());

  const lines = () => readFileSync(log, 'utf8').trim().split('\n').length;
  const before = lines();
  const cases = [
    ['a task without scope', (b) => { delete b[0].tasks[1].scope; }, /tasks\[1\].*scope/],
    ['an empty task scope', (b) => { b[0].tasks[0].scope = []; }, /tasks\[0\].*scope/],
    ['a batch without seam_touched', (b) => { delete b[0].seam_touched; }, /batches\[0\].*seam_touched/],
    ['a batch without parallelizable_reason', (b) => { delete b[0].parallelizable_reason; }, /batches\[0\].*parallelizable_reason/],
    ['a batch without id', (b) => { delete b[0].id; }, /batches\[0\]\.id/],
    ['a non-boolean parallelizable', (b) => { b[0].parallelizable = 'no'; }, /parallelizable must be a boolean/],
    ['a non-string depends_on entry', (b) => { b[0].tasks[1].depends_on = [1]; }, /tasks\[1\].*depends_on/],
  ];
  for (const [what, mutate, re] of cases) {
    const b = complete();
    mutate(b);
    const res = run(b);
    assert.equal(res.status, 2, `${what}: ${res.stderr}`);
    assert.match(res.stderr, re, what);
  }
  for (const empty of [[], 'x']) assert.equal(run(empty).status, 2, `batches=${JSON.stringify(empty)}`);
  assert.equal(sflog(log, ['stage', 'task-decomposition']).status, 2, 'batches is required');
  assert.equal(lines(), before, 'nothing appended on refusal');
});

test('task-decomposition refuses a parallelizable batch that contradicts its own evidence', () => {
  const { log } = fixture();
  const parallel = () => [
    {
      id: 'B1',
      tasks: [{ id: '1', scope: ['a.mjs'] }, { id: '2', scope: ['b.mjs'], depends_on: ['0'] }],
      seam_touched: false,
      parallelizable: true,
      parallelizable_reason: 'all four hold',
    },
  ];
  const run = (batches) => sflog(log, ['stage', 'task-decomposition', `batches=${JSON.stringify(batches)}`]);
  const ok = run(parallel());
  assert.equal(ok.status, 0, ok.stderr);

  const lines = () => readFileSync(log, 'utf8').trim().split('\n').length;
  const before = lines();
  const cases = [
    ['seam touched', (b) => { b[0].seam_touched = true; }, /B1.*seam_touched/],
    ['fewer than 2 tasks', (b) => { b[0].tasks.pop(); }, /B1.*fewer than 2/],
    ['overlapping scopes', (b) => { b[0].tasks[1].scope.push('a.mjs'); }, /B1.*share scope a\.mjs/],
    ['an in-batch depends_on edge', (b) => { b[0].tasks[1].depends_on = ['1']; }, /B1.*depends on 1/],
    ['a gate reason other than all four hold', (b) => { b[0].parallelizable_reason = GATE_REASONS[3]; }, /B1.*all four hold/],
  ];
  for (const [what, mutate, re] of cases) {
    const b = parallel();
    mutate(b);
    const res = run(b);
    assert.equal(res.status, 2, `${what}: ${res.stderr}`);
    assert.match(res.stderr, re, what);
  }
  assert.equal(lines(), before, 'nothing appended on refusal');
});

test('task-decomposition accepts only the enumerated gate reasons', () => {
  const { log } = fixture();
  const batch = (over) => [
    {
      id: 'B1',
      tasks: [{ id: '1', scope: ['a.mjs'] }, { id: '2', scope: ['b.mjs'] }],
      seam_touched: false,
      parallelizable: false,
      parallelizable_reason: GATE_REASONS[0],
      ...over,
    },
  ];
  const run = (batches) => sflog(log, ['stage', 'task-decomposition', `batches=${JSON.stringify(batches)}`]);

  for (const reason of GATE_REASONS) {
    const res = run(batch({ parallelizable_reason: reason, seam_touched: reason === 'seam touched' }));
    assert.equal(res.status, 0, `${reason}: ${res.stderr}`);
    assert.equal(lastEvent(log).batches[0].parallelizable_reason, reason);
  }

  const lines = () => readFileSync(log, 'utf8').trim().split('\n').length;
  const before = lines();
  const freeText = 'serial by choice: one writer in the shared worktree';
  const refused = [
    ['free text on a serial batch', batch({ parallelizable_reason: freeText }), /B1.*parallelizable_reason must be one of/],
    ['free text on a parallel batch', batch({ parallelizable: true, parallelizable_reason: freeText }), /B1.*parallelizable_reason must be one of/],
    ['all four hold on a serial batch', batch({ parallelizable_reason: ALL_HOLD }), /B1.*not parallelizable/],
    ['seam touched without seam_touched', batch({ parallelizable_reason: 'seam touched' }), /B1.*seam_touched is false/],
  ];
  for (const [what, batches, re] of refused) {
    const res = run(batches);
    assert.equal(res.status, 2, `${what}: ${res.stderr}`);
    assert.match(res.stderr, re, what);
  }
  assert.equal(lines(), before, 'nothing appended on refusal');
});

test('epic-layer records the phases in flight for an integrated layer and names why a layer was serial', () => {
  const { log } = fixture();
  const run = (...kv) => sflog(log, ['stage', 'epic-layer', 'layer=0', ...kv]);

  const fanOut = run('mode=integrated', 'head=abc1234', 'children=["1","3"]', 'pr_url=null', 'in_flight=2');
  assert.equal(fanOut.status, 0, fanOut.stderr);
  const row = lastEvent(log);
  assert.equal(row.stage, 'epic-layer'); assert.equal(row.mode, 'integrated'); assert.equal(row.in_flight, 2);
  assert.equal(row.serial_reason, undefined);

  for (const reason of ['single-phase', 'no-scratch-worktrees', 'force-serial', 'resumed', 'not-fanned-out']) {
    const res = run('mode=integrated', 'in_flight=1', `serial_reason=${reason}`);
    assert.equal(res.status, 0, `${reason}: ${res.stderr}`);
    assert.equal(lastEvent(log).serial_reason, reason);
  }

  // an epic stack-mode row: a PR, no mode=, no in_flight=.
  const stack = run('head=abc1234', 'base=def5678', 'pr_url=https://example.invalid/pr/1', 'children=["1"]');
  assert.equal(stack.status, 0, stack.stderr);
  assert.equal(lastEvent(log).in_flight, undefined);

  const lines = () => readFileSync(log, 'utf8').trim().split('\n').length;
  const before = lines();
  const refused = [
    ['integrated without in_flight', ['mode=integrated'], /in_flight=<n> is required when mode=integrated/],
    ['in_flight=0', ['mode=integrated', 'in_flight=0'], /in_flight must be an integer/],
    ['a non-integer in_flight', ['mode=integrated', 'in_flight=two'], /in_flight must be an integer/],
    ['in_flight=1 without serial_reason', ['mode=integrated', 'in_flight=1'], /serial_reason=<reason> is required when in_flight=1/],
    ['an unknown serial_reason', ['mode=integrated', 'in_flight=1', 'serial_reason=by-choice'], /serial_reason must be one of/],
    ['a serial_reason on a fan-out', ['mode=integrated', 'in_flight=2', 'serial_reason=resumed'], /only valid with in_flight=1/],
    ['in_flight=0 with no mode', ['in_flight=0'], /in_flight must be an integer/],
    ['an empty serial_reason', ['mode=integrated', 'in_flight=1', 'serial_reason='], /serial_reason must be one of/],
    ['a null serial_reason', ['mode=integrated', 'in_flight=1', 'serial_reason=null'], /serial_reason must be one of/],
    ['an empty serial_reason on a fan-out', ['mode=integrated', 'in_flight=2', 'serial_reason='], /serial_reason must be one of/],
    ['an empty serial_reason with no mode', ['serial_reason='], /serial_reason must be one of/],
    ['an empty in_flight with no mode', ['in_flight='], /in_flight must be an integer/],
    ['a null in_flight', ['mode=integrated', 'in_flight=null'], /in_flight must be an integer/],
  ];
  for (const [what, kv, re] of refused) {
    const res = run(...kv);
    assert.equal(res.status, 2, `${what}: ${res.stderr}`);
    assert.match(res.stderr, re, what);
  }
  assert.equal(lines(), before, 'nothing appended on refusal');
});

// Served identity: the transcript says what ran; the alias says what was asked for.
function transcriptFixture(dir, agentId, rows) {
  const sub = join(dir, 'projects', '-repo', 'session-1', 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return join(dir, 'projects');
}

function pklogWithProjects(log, projects, args) {
  return spawnSync(process.execPath, [SF_LOG, ...args], {
    encoding: 'utf8',
    env: { ...process.env, RUN_LOG: log, SF_RUN_TASK: 'unit', SF_CLAUDE_PROJECTS_DIR: projects },
  });
}

test('spawn records model_served and effort_served from the agent transcript; check flags an alias another family served', () => {
  const { dir, log } = fixture();
  const projects = transcriptFixture(dir, 'a1b2c3', [
    { type: 'user', message: { role: 'user', content: 'brief' } },
    { type: 'assistant', effort: 'high', message: { model: 'claude-opus-5-5', content: [] } },
  ]);
  const base = ['spawn', 'phase=plan', 'wall_ms=70000'];
  const explore = pklogWithProjects(log, projects, [...base, 'role=explore', 'agent_type=Explore', 'model=haiku', 'agent_id=a1b2c3', 'artifact=/a']);
  assert.equal(explore.status, 0, explore.stderr);
  const ev = lastEvent(log);
  assert.equal(ev.model, 'haiku', 'the logged alias is kept as written');
  assert.equal(ev.model_served, 'claude-opus-5-5');
  assert.equal(ev.effort_served, 'high');

  const unknown = pklogWithProjects(log, projects, [...base, 'role=explore', 'agent_type=Explore', 'model=session', 'agent_id=missing', 'artifact=/b']);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(lastEvent(log).model_served, undefined, 'no transcript, nothing recorded');

  const traversal = pklogWithProjects(log, projects, [...base, 'role=explore', 'agent_type=Explore', 'model=session', 'agent_id=../a1b2c3', 'artifact=/c']);
  assert.equal(traversal.status, 0, traversal.stderr);
  assert.equal(lastEvent(log).model_served, undefined, 'an id that is not a plain token is never resolved to a path');

  const codex = pklogWithProjects(log, projects, [...base, 'role=plan-reviewer', 'agent_type=codex-exec', 'backend=codex', 'model=gpt-6.1-sol', 'agent_id=a1b2c3', 'artifact=/d']);
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(lastEvent(log).model_served, undefined, 'a Codex seat has no Claude transcript');

  const res = JSON.parse(pklogWithProjects(log, projects, ['check', '--compact']).stdout);
  assert.deepEqual(res.spawns_model_mismatch.map((x) => [x.role, x.model, x.model_served]), [['explore', 'haiku', 'claude-opus-5-5']]);
});

test('spawn: a served model in the same family as the alias is not a mismatch', () => {
  const { dir, log } = fixture();
  const projects = transcriptFixture(dir, 'same1', [
    { type: 'assistant', effort: 'medium', message: { model: 'claude-sonnet-5-5', content: [] } },
  ]);
  const ok = pklogWithProjects(log, projects, ['spawn', 'phase=review', 'wall_ms=70000', 'role=reviewer:copy', 'agent_type=copy-lead', 'model=sonnet', 'agent_id=same1', 'artifact=/a']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(lastEvent(log).model_served, 'claude-sonnet-5-5');
  assert.deepEqual(JSON.parse(pklogWithProjects(log, projects, ['check', '--compact']).stdout).spawns_model_mismatch, []);
});

test('spawn: caller-passed served fields are dropped; a final row without a newline and a workflow transcript resolve; a linked transcript does not', () => {
  const { dir, log } = fixture();
  const projects = join(dir, 'projects');
  const sub = join(projects, '-repo', 'session-1', 'subagents');
  mkdirSync(join(sub, 'workflows', 'wf_1'), { recursive: true });
  const assistant = (model, effort) => JSON.stringify({ type: 'assistant', effort, message: { model, content: [] } });
  writeFileSync(join(sub, 'agent-tail1.jsonl'), `${JSON.stringify({ type: 'user' })}\n${assistant('claude-opus-5-5', 'medium')}`);
  writeFileSync(join(sub, 'workflows', 'wf_1', 'agent-wf1.jsonl'), `${assistant('claude-sonnet-5-5', 'low')}\n`);
  const base = ['spawn', 'phase=implement', 'wall_ms=70000', 'role=implementer', 'agent_type=sf-implementer', 'model=opus'];

  const passed = pklogWithProjects(log, projects, [...base, 'agent_id=absent', 'artifact=/a', 'model_served=claude-haiku-4-5', 'effort_served=5']);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(lastEvent(log).model_served, undefined);
  assert.equal(lastEvent(log).effort_served, undefined);

  assert.equal(pklogWithProjects(log, projects, [...base, 'agent_id=tail1', 'artifact=/b', 'effort_served=low']).status, 0);
  assert.equal(lastEvent(log).model_served, 'claude-opus-5-5');
  assert.equal(lastEvent(log).effort_served, 'medium');

  assert.equal(pklogWithProjects(log, projects, [...base, 'agent_id=wf1', 'artifact=/c']).status, 0);
  assert.equal(lastEvent(log).model_served, 'claude-sonnet-5-5');

  let linked = true;
  try { symlinkSync(join(sub, 'agent-tail1.jsonl'), join(sub, 'agent-link1.jsonl')); } catch { linked = false; }
  if (linked) {
    assert.equal(pklogWithProjects(log, projects, [...base, 'agent_id=link1', 'artifact=/d']).status, 0);
    assert.equal(lastEvent(log).model_served, undefined, 'a linked transcript is not read');
  }
});

test('check: plan_explores_after_drafter flags a planned run whose plan-phase Explores all started after the drafter ended', () => {
  const T0 = Date.parse('2026-10-01T10:00:00.000Z');
  const MIN = 60000;
  // A spawn row stores its end (ts) and wall only, so each row is placed by start and end minute.
  const row = (role, phase, startMin, endMin, extra = {}) => ({
    stage: 'spawn', role, agent_type: role.startsWith('explore') ? 'Explore' : `sf-${role}`, model: 'session', phase,
    wall_ms: (endMin - startMin) * MIN, ts: new Date(T0 + endMin * MIN).toISOString(), ...extra,
  });
  const check = (rows) => {
    const { log } = fixture();
    writeFileSync(log, readFileSync(log, 'utf8') + rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
    const res = sflog(log, ['check', '--compact']);
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, true, 'warn-level: never flips ok');
    return report.plan_explores_after_drafter;
  };
  const drafterEnd = new Date(T0 + 12 * MIN).toISOString();

  const late = check([
    row('plan-drafter', 'plan', 0, 12),
    row('explore', 'plan', 12, 15),
    row('explore:infra', 'plan', 13, 16),
    row('plan-reviewer', 'plan', 12, 18),
  ]);
  assert.deepEqual(late, { flagged: true, explores: 2, drafter_end: drafterEnd });

  const early = check([
    row('explore', 'plan', 0, 3),
    row('plan-drafter', 'plan', 0, 12),
    row('explore', 'plan', 13, 16),
  ]);
  assert.deepEqual(early, { flagged: false, explores: 2, drafter_end: drafterEnd }, 'one Explore overlapped the drafter');

  const express = check([
    row('explore', 'plan', 0, 3),
    row('implementer', 'implement', 3, 20),
  ]);
  assert.deepEqual(express, { flagged: false, explores: 1, drafter_end: null }, 'no drafter: not a planned run');

  // A warm plan fix, an implement-phase Explore and a wall-less row never decide the flag.
  const undecided = check([
    row('plan-drafter', 'plan', 0, 12),
    row('plan-drafter-fixer', 'plan', 20, 25),
    row('explore', 'implement', 30, 33),
    { ...row('explore', 'plan', 13, 16), wall_ms: null, late: true },
  ]);
  assert.deepEqual(undecided, { flagged: false, explores: 1, drafter_end: drafterEnd });

  // The drafter returned at minute 12 and its row was logged at minute 20: its end is its
  // start plus its own duration, not the time the row was written.
  const loggedLate = check([
    row('plan-drafter', 'plan', 0, 20, { duration_ms: 12 * MIN }),
    row('explore', 'plan', 13, 16),
    row('explore:infra', 'plan', 14, 17),
  ]);
  assert.deepEqual(loggedLate, { flagged: true, explores: 2, drafter_end: drafterEnd });

  // A duration longer than the wall never moves the end past the row's ts.
  const longDuration = check([
    row('plan-drafter', 'plan', 0, 12, { duration_ms: 30 * MIN }),
    row('explore', 'plan', 13, 16),
  ]);
  assert.deepEqual(longDuration, { flagged: true, explores: 1, drafter_end: drafterEnd });

  // An Explore row whose wall is implausible has no usable start: it is counted, never decides.
  const implausible = check([
    row('plan-drafter', 'plan', 0, 12),
    { ...row('explore', 'plan', 13, 16), wall_ms: 49 * 60 * MIN },
    row('explore:infra', 'plan', 13, 16),
  ]);
  assert.deepEqual(implausible, { flagged: true, explores: 2, drafter_end: drafterEnd });
  const onlyImplausible = check([
    row('plan-drafter', 'plan', 0, 12),
    { ...row('explore', 'plan', 13, 16), wall_ms: 49 * 60 * MIN },
  ]);
  assert.deepEqual(onlyImplausible, { flagged: false, explores: 1, drafter_end: drafterEnd });

  // A drafter row whose wall is implausible, or whose duration is not positive, has no usable
  // start: its end is the row's ts. An Explore that overlapped it keeps the run unflagged.
  const overlapped = { flagged: false, explores: 1, drafter_end: drafterEnd };
  const secondsScaledStart = check([
    row('explore', 'plan', 0, 3),
    { ...row('plan-drafter', 'plan', 0, 12, { duration_ms: 12 * MIN }), wall_ms: T0 + 12 * MIN - Math.floor(T0 / 1000) },
  ]);
  assert.deepEqual(secondsScaledStart, overlapped, 'started= in seconds');
  const hugeWall = check([
    row('explore', 'plan', 0, 3),
    { ...row('plan-drafter', 'plan', 0, 12, { duration_ms: 12 * MIN }), wall_ms: 1e20 },
  ]);
  assert.deepEqual(hugeWall, overlapped, 'a wall beyond the Date range never throws');
  const zeroDuration = check([
    row('explore', 'plan', 0, 3),
    row('plan-drafter', 'plan', 0, 12, { duration_ms: 0 }),
  ]);
  assert.deepEqual(zeroDuration, overlapped, 'a zero duration is not a measurement');
});

test('check: intervals reports last seat → PR and implementer → first reviewer', () => {
  const T0 = Date.parse('2026-10-01T10:00:00.000Z');
  const MIN = 60000;
  const at = (min) => new Date(T0 + min * MIN).toISOString();
  const spawn = (role, phase, startMin, endMin, extra = {}) => ({
    stage: 'spawn', role, agent_type: 'sf-seat', model: 'session', phase,
    wall_ms: (endMin - startMin) * MIN, ts: at(endMin), ...extra,
  });
  const check = (rows) => {
    const { log } = fixture();
    writeFileSync(log, readFileSync(log, 'utf8') + rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
    const res = sflog(log, ['check', '--compact']);
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, true, 'warn-level: never flips ok');
    return report.intervals;
  };
  const pr = (min) => ({ stage: 'implement-issue', pr_url: 'https://example.invalid/pr/1', ts: at(min) });

  // Implementer returns at 20; reviewers start at 27 and 28; the last seat (a closure) returns
  // at 50; the PR opens at 66. A seat logged after the PR row never moves the first interval.
  const run = check([
    spawn('implementer:repro', 'plan', 0, 5),
    spawn('implementer', 'implement', 5, 20),
    spawn('reviewer:security', 'review', 28, 40),
    spawn('reviewer:architecture', 'review', 27, 41),
    spawn('implementer', 'implement', 42, 45),
    { stage: 'closure-exchange', role: 'reviewer:security', wall_ms: 2 * MIN, ts: at(50) },
    pr(66),
    spawn('reviewer:security', 'review', 70, 75),
    pr(90),
  ]);
  assert.deepEqual(run, { last_seat_to_pr_ms: 16 * MIN, implementer_to_first_reviewer_ms: 7 * MIN });

  const noPr = check([
    spawn('implementer', 'implement', 5, 20),
    spawn('reviewer:security', 'review', 23, 40),
  ]);
  assert.deepEqual(noPr, { last_seat_to_pr_ms: null, implementer_to_first_reviewer_ms: 3 * MIN }, 'no implement-issue row');

  assert.deepEqual(check([]), { last_seat_to_pr_ms: null, implementer_to_first_reviewer_ms: null }, 'an empty run');
  assert.deepEqual(check([pr(10)]), { last_seat_to_pr_ms: null, implementer_to_first_reviewer_ms: null }, 'a PR with no seat before it');

  // A reviewer start is known only from a plausible wall; without one the gap is unknown.
  const unknownStart = check([
    spawn('implementer', 'implement', 5, 20),
    { ...spawn('reviewer:security', 'review', 23, 40), wall_ms: null, late: true },
    { ...spawn('reviewer:architecture', 'review', 23, 40), wall_ms: 1e20 },
    { stage: 'spawn', role: 'reviewer:ux', agent_type: 'sf-seat', model: 'session', phase: 'review', wall_ms: MIN },
    pr(45),
  ]);
  assert.deepEqual(unknownStart, { last_seat_to_pr_ms: 5 * MIN, implementer_to_first_reviewer_ms: null });

  // No implementer ended before the first reviewer started, and a seat row stamped after
  // the PR row is out of order: both are unknown, never negative.
  const outOfOrder = check([
    spawn('reviewer:security', 'review', 1, 10),
    spawn('implementer', 'implement', 5, 20),
    pr(15),
  ]);
  assert.deepEqual(outOfOrder, { last_seat_to_pr_ms: null, implementer_to_first_reviewer_ms: null });

  // A pairing-check is a timed seat continuation, so it counts as the last seat before the PR.
  const pairing = check([
    spawn('implementer', 'implement', 5, 20),
    { stage: 'pairing-check', role: 'reviewer:security', wall_ms: 2 * MIN, ts: at(30) },
    pr(34),
  ]);
  assert.equal(pairing.last_seat_to_pr_ms, 4 * MIN);

  // The implementer row count is unbounded input: a very long ledger still reports.
  const many = Array.from({ length: 200000 }, () => spawn('implementer', 'implement', 5, 20));
  const long = check([...many, spawn('reviewer:security', 'review', 26, 40)]);
  assert.equal(long.implementer_to_first_reviewer_ms, 6 * MIN);
});
