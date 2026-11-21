#!/usr/bin/env node
/**
 * @file sf-log.mjs
 * @description One-call audit-log writer for the shipflow ship-* skills. Appends one JSON line per
 *   event to the run's docs/plans/<skill>-<epoch>.jsonl log with an ENFORCED stage enum and the
 *   field names /ship-report (skills/ship-report/report.py) consumes. Replaces the hand-rolled
 *   `jq -nc … >> $LOG` blocks (skills/shared/spawn-accounting.md) — every line is written with
 *   JSON.stringify, never interpolation, so a malformed ledger line cannot happen. Verbs: init,
 *   stage, spawn, checkpoint, cursor, check. Zero dependencies.
 * @domain workflow-audit-log
 *
 * Usage:
 *   sf-log init [--log <path>] [--skill <name>] [--task <id> | --issue <n>] [--phase <p>]
 *   sf-log init --resume <runstate.json>
 *   sf-log stage <name> [k=v ...]
 *   sf-log spawn [--late] k=v ...       (required: role agent_type model phase, and started= or wall_ms= unless --late)
 *   sf-log checkpoint reason=<slug> at=<stage-name> [detail=..] [artifact=..]
 *   sf-log cursor <runstate.json> k=v ...  (dotted keys allowed: checkpoint.reason=build-failed)
 *   sf-log check [<log path>]
 *
 * Common: --log <path> or $RUN_LOG (fallback $SHIP_TASK_LOG / $SHIP_ISSUE_LOG / $SHIP_PRD_LOG);
 *   --task/--issue or $SF_RUN_TASK / $SF_RUN_ISSUE; --compact for one-line JSON on stdout.
 *   k=v values parse as JSON when they parse (numbers, booleans, null, arrays, objects), else string.
 *
 * Requires Node >= 18.
 */

import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ROLE_PREFIXES, roleError } from './sf-roles.mjs';
import { ALL_HOLD, GATE_REASONS } from './sf-parallel-gate.mjs';
import { basename, dirname, join, resolve } from 'node:path';

// ---- Stage enum (the escape hatch is `note`, which requires event=<free text>) ---
const STAGES = [
  'run-meta',
  'preflight',
  'resume-adopted',
  'session-resumed',
  'cut-task',
  'cut-issue',
  'express-classification',
  'express-abandoned',
  'plan-issue',
  'plan-converged-early',
  'plan-interview',
  'auto-ready-to-implement',
  'epic-decompose',
  'epic-cut',
  'epic-layer',
  'epic-finalize',
  'task-decomposition',
  'batch-implement',
  'smoke-build',
  'spawn',
  'clarify',
  'closure-exchange',
  'adjudication',
  'oscillation-stop',
  'triage',
  'fix-convergence-escape',
  'fix-seam-extension',
  'fix-round-extension',
  'mopup',
  'integration-sync',
  'build-gate',
  'lint-gate',
  'ac-verification',
  'followup-tasks',
  'followup-bundle',
  'followup-issues',
  'implement-issue',
  'no-code-outcome',
  'postmortem',
  'phase-cursor',
  'orchestrator-error',
  'operator-wait',
  'note',
];
const STAGE_SET = new Set(STAGES);

// Per-stage required keys + allowed values (report.py reads these fields verbatim).
const STAGE_RULES = {
  note: { required: ['event'] },
  'express-classification': { required: ['mode'], enums: { mode: ['express', 'full', 'no-code', 'bundle'] } },
  // Written by hooks/session-resumed.py on a SessionStart(resume): the orchestrating session came
  // back after a drop, so the gap before it is a session gap, not orchestrator time (ship-report).
  'session-resumed': { required: ['source'], enums: { source: ['resume', 'startup', 'compact', 'clear'] } },
  triage: { required: ['round', 'rereview_mode'], enums: { rereview_mode: ['warm', 'warm+cold-panel', 'cold-fallback', 'none'] } },
  // Continuation events must namespace their round — a closure/clarify without round= slips
  // past both the adjudication gate and the oscillation check, so require it at write (role is
  // already guarded in cmdCheck, and every emitter passes round=).
  'closure-exchange': { required: ['round'], arrays: ['reopened_ids'] },
  clarify: { required: ['round'] },
  // Semantic-gap adjudication before closure (ship-task 3e step 3.5): every gap the fixer
  // reported is accepted or redirected. accepted+redirected need not equal gaps (a gap can
  // be both surfaced and folded), but all four counts must be non-negative integers so
  // report.py sums real numbers, not silently-coerced strings — no arithmetic relation
  // between them is enforced.
  // Optional decisions='[…]' (the accepted decision lines) or artifact=<adjudication file>.
  adjudication: { required: ['round', 'gaps', 'accepted', 'redirected'], ints: ['round', 'gaps', 'accepted', 'redirected'] },
  // Oscillation stop (warm-closure.md §3): an item id's second REOPENED ends its mechanical
  // loop. severity picks the disposition; action is optional (design-note re-entry, checkpoint,
  // or bucket-3) and enforced against its enum only when present. round is required so the
  // stop namespaces the same way the closure and fixer rows do. Optional design_note=<path>.
  'oscillation-stop': {
    required: ['finding', 'round', 'severity'],
    enums: { severity: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'], action: ['design-note', 'checkpoint', 'bucket-3'] },
    ints: ['round'],
    // design_note is optional but, when present, must be a real path — never true/false/0, which
    // cmdCheck would read as present/absent by JS truthiness rather than by the note's existence.
    strings: ['design_note'],
  },
  // at= is the sync point in skills/shared/integration-sync.md; `layer` events carry layer=<k>,
  // `phase` events are the read-only probe (probe=1), `resume` is any adopted run's first action.
  'integration-sync': {
    required: ['at', 'behind', 'conflicts'],
    enums: { at: ['1b', '3d', '3e', '3f', '3g', 'layer', 'phase', 'resume'] },
    requiredWhen: { layer: { at: ['layer'] } },
  },
  // Logged before every operator question and before a turn that ends waiting on the operator
  // (ship-task §Interview policy); report.py counts the gap to the answer as operator wait.
  // Optional at=<stage> and artifact=<queue file>.
  'operator-wait': { required: ['questions'], ints: ['questions'], arrays: ['blocking'] },
  // 3b decomposition (ship-task 3b): every task names its scope and every batch
  // records the seam result and the gate condition that decided it (sf-parallel-gate.mjs), so a
  // fan-out is auditable and a serial batch is countable by cause.
  'task-decomposition': { required: ['batches'], validate: validateDecomposition },
  // No `required` list: a stack-mode row (an epic stack) may carry neither mode= nor
  // in_flight=, and it must stay writable. An integrated layer records how many of its phases ran at once,
  // and a serial one the cause, so a serial layer is countable the way a serial batch is.
  'epic-layer': { validate: validateEpicLayer },
};

// `not-fanned-out` is the residual: two or more phases were runnable, no other cause held, and
// they still ran one at a time. It records a missed fan-out, so the row is honest, not refused.
const EPIC_SERIAL_REASONS = ['single-phase', 'no-scratch-worktrees', 'force-serial', 'resumed', 'not-fanned-out'];

// Returns the first shape violation as a message, or null.
function validateEpicLayer(kv) {
  // A key that is present must hold a valid value: an empty or null one is refused, never stored.
  const { in_flight: inFlight, serial_reason: reason } = kv;
  if (kv.mode === 'integrated' && inFlight === undefined) return 'in_flight=<n> is required when mode=integrated';
  if (inFlight !== undefined && (typeof inFlight !== 'number' || !Number.isInteger(inFlight) || inFlight < 1)) {
    return `in_flight must be an integer ≥ 1 (got ${JSON.stringify(inFlight)})`;
  }
  if (reason !== undefined && !EPIC_SERIAL_REASONS.includes(reason)) {
    return `serial_reason must be one of ${EPIC_SERIAL_REASONS.join('|')} (got ${JSON.stringify(reason)})`;
  }
  if (inFlight === 1 && reason === undefined) return 'serial_reason=<reason> is required when in_flight=1';
  if (reason !== undefined && inFlight !== 1) return 'serial_reason is only valid with in_flight=1';
  return null;
}

// Returns the first shape violation as a message, or null. Names the batch and task index.
function validateDecomposition(kv) {
  const nonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
  const strArray = (v) => Array.isArray(v) && v.every(nonEmptyStr);
  const { batches } = kv;
  if (!Array.isArray(batches) || batches.length === 0) return 'batches must be a non-empty JSON array';
  for (const [b, batch] of batches.entries()) {
    const at = `batches[${b}]`;
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return `${at} must be an object`;
    if (!nonEmptyStr(batch.id)) return `${at}.id must be a non-empty string`;
    if (!Array.isArray(batch.tasks) || batch.tasks.length === 0) return `${at} (${batch.id}).tasks must be a non-empty array`;
    for (const [t, task] of batch.tasks.entries()) {
      const tat = `${at} (${batch.id}).tasks[${t}]`;
      if (!task || typeof task !== 'object' || Array.isArray(task)) return `${tat} must be an object`;
      if (!nonEmptyStr(task.id)) return `${tat}.id must be a non-empty string`;
      if (!strArray(task.scope) || task.scope.length === 0) return `${tat} (${task.id}).scope must be a non-empty array of file paths`;
      if (task.depends_on !== undefined && !strArray(task.depends_on)) return `${tat} (${task.id}).depends_on must be an array of task ids`;
    }
    if (typeof batch.seam_touched !== 'boolean') return `${at} (${batch.id}).seam_touched must be a boolean (sf-route classify seam.touched)`;
    if (typeof batch.parallelizable !== 'boolean') return `${at} (${batch.id}).parallelizable must be a boolean`;
    const reason = batch.parallelizable_reason;
    if (reason !== ALL_HOLD && !GATE_REASONS.includes(reason)) {
      return `${at} (${batch.id}).parallelizable_reason must be one of: ${[...GATE_REASONS, ALL_HOLD].map((r) => `"${r}"`).join(', ')}`;
    }
    if (reason === 'seam touched' && !batch.seam_touched) return `${at} (${batch.id}).parallelizable_reason is "seam touched" but seam_touched is false`;
    if (!batch.parallelizable && reason === ALL_HOLD) return `${at} (${batch.id}) is not parallelizable but parallelizable_reason is "${ALL_HOLD}"`;
    if (batch.parallelizable) {
      // A parallel batch must agree with its own evidence; scratch worktrees are the orchestrator's check.
      const pat = `${at} (${batch.id}) is parallelizable but`;
      if (batch.seam_touched) return `${pat} seam_touched is true`;
      if (batch.tasks.length < 2) return `${pat} has fewer than 2 tasks`;
      const owner = new Map();
      for (const task of batch.tasks) {
        for (const path of task.scope) {
          if (owner.has(path) && owner.get(path) !== task.id) return `${pat} tasks ${owner.get(path)} and ${task.id} share scope ${path}`;
          owner.set(path, task.id);
        }
      }
      const ids = new Set(batch.tasks.map((task) => task.id));
      for (const task of batch.tasks) {
        const dep = (task.depends_on ?? []).find((id) => ids.has(id));
        if (dep !== undefined) return `${pat} task ${task.id} depends on ${dep} in the same batch`;
      }
      if (reason !== ALL_HOLD) return `${pat} parallelizable_reason is not "${ALL_HOLD}"`;
    }
  }
  return null;
}

// Roles /ship-report aggregates on: sf-roles.mjs, shared with sf-codex. Enforced by cmdSpawn.
const SPAWN_REQUIRED = ['role', 'agent_type', 'model', 'phase'];

const DEFAULT_SKILL = 'ship-task';
const LOG_ENV_VARS = ['RUN_LOG', 'SHIP_TASK_LOG', 'SHIP_ISSUE_LOG', 'SHIP_PRD_LOG'];

// =============================================================================
// CLI plumbing
// =============================================================================
function die(msg, code = 2) {
  process.stderr.write(`sf-log: ${msg}\n`);
  process.exit(code);
}
const warn = (msg) => process.stderr.write(`sf-log: warning: ${msg}\n`);

const HELP = `sf-log — one-call audit-log events for the shipflow ship-* skills (enforced stage enum)

Usage:
  sf-log init [--log <path>] [--skill <name>] [--task <id> | --issue <n>] [--phase <p>]
  sf-log init --resume <runstate.json>
      Resume: when the runstate's log_path names a *.jsonl file beside the runstate, appends a
      run-meta resumed=true mark — the current $RUN_LOG's own run-meta, else a fresh one — then the
      current log's remaining lines, deletes the current log (never when it is the same file), and
      prints the recorded path. No acceptable recorded log → a new log as below (warning, exit 0).
      Unreadable runstate → exit 2.
      Creates the log (default: $PWD/docs/plans/<skill>-<epoch>.jsonl, skill default "${DEFAULT_SKILL}"),
      writes the run-meta event (cc_version from \`claude --version\`), prints the absolute path on
      stdout — so: LOG=$(sf-log init --skill ship-task --task 123)
  sf-log stage <name> [k=v ...]
      Appends {stage:<name>, ...kv, task|issue, ts}. <name> must be in the stage enum (below).
      Escape hatch: \`note\` requires event=<free text>.
      express-classification requires mode=express|full|no-code|bundle.
      triage requires round=<n> and rereview_mode=warm|warm+cold-panel|cold-fallback|none.
      adjudication requires round=<n> gaps=<n> accepted=<n> redirected=<n> (optional
      decisions='[…]' or artifact=<adjudication file>) — logged before closure when the
      round's fixer reported semantic gaps (ship-task 3e step 3.5).
      oscillation-stop requires finding=<item id> round=<n> severity=CRITICAL|HIGH|MEDIUM|LOW
      (optional action=design-note|checkpoint|bucket-3 and design_note=<path>) — logged on an
      item id's second REOPENED (warm-closure.md §3).
      closure-exchange and clarify require round=<n> (they namespace the round the gates read).
      On a Claude closure-exchange/clarify, tokens=/duration_ms= require agent_id=<id>; each is
      stored as the delta against that agent's latest earlier row carrying the field
      (usage_basis=delta, the raw value in tokens_cumulative/duration_ms_cumulative), or raw when
      lower or first (usage_basis=per-turn), and raw for every turn after a lower one.
      No tokens → usage_missing=true. stage=, tokens_cumulative=, duration_ms_cumulative= and
      usage_basis= are written by sf-log and refused from the caller (exit 2).
      integration-sync requires at=1b|3d|3e|3f|3g|layer|phase|resume behind=<commits> conflicts=<files>
      (layer=<k> when at=layer; probe=1 on a read-only merge-tree probe; resolved=1 merge_commit=<sha>
      on the follow-up event after a conflict is resolved).
      operator-wait requires questions=<n> (optional at=<stage> blocking='[…]' artifact=<queue file>);
      the wait ends at \`note event=operator-answered\` (ship-task §Interview policy).
      task-decomposition requires batches='[…]': a non-empty array of {id, tasks:[{id, scope:[paths],
      depends_on?:[ids]}], seam_touched:<bool>, parallelizable:<bool>, parallelizable_reason:<reason>}
      (seam_touched is \`sf-route classify\`'s seam.touched over the batch's scope files).
      <reason> is the first failed gate condition — ${GATE_REASONS.map((r) => `"${r}"`).join(' | ')} —
      or "${ALL_HOLD}"; any other text is refused. \`sf-route batches\` computes the batches.
      epic-layer requires in_flight=<n> when mode=integrated: the largest number of the layer's
      phases in flight at once, an integer ≥ 1. in_flight=1 requires serial_reason=<reason>, one of
      ${EPIC_SERIAL_REASONS.join(' | ')}
      (not-fanned-out: two or more runnable phases ran one at a time for no other cause — a
      miss, never a choice); serial_reason is refused with any other in_flight. A row with no
      mode= (stack mode) needs neither.
  sf-log spawn [--late] k=v ...
      stage "spawn". Required: role agent_type model phase, plus started=<epoch ms> or wall_ms=<ms>
      (--late records wall_ms=null for an adopted run whose start time is gone). Optional: round escalated tokens
      duration_ms agent_id artifact started=<epoch ms> (→ wall_ms = now - started) or wall_ms=<ms>.
      Missing tokens/duration_ms → null; a Claude row with no tokens also carries usage_missing=true.
      A Claude row with agent_id= also records model_served / effort_served from the first
      assistant row of that agent's Claude Code transcript when one is found (omitted
      otherwise, never inferred; values passed by the caller are dropped).
      role must start with one of: ${ROLE_PREFIXES.join(' ')} (refused otherwise, exit 2);
      a bare \`reviewer:\` and an implementer* role with phase=fix are refused (log a fixer as role=fixer).
      A spawn whose agent_id AND artifact already appear on an earlier spawn row is a duplicate
      (a sf-codex seat writes its own row): warned and NOT written, exit 0.
  sf-log checkpoint reason=<slug> at=<stage-name> [detail=..] [artifact=..]
      Appends {stage:<at>, event:"checkpoint", reason, detail, artifact, ts}.
  sf-log cursor <runstate.json> k=v ...
      Read-modify-write JSON (created if absent); dotted keys set nested values
      (checkpoint.reason=build-failed); sets updated=<iso>, and session_id=$CLAUDE_CODE_SESSION_ID
      when that is set (the run's owner, read by hooks/session-resumed.py). Prints the resulting document.
      When a log resolves (--log or $RUN_LOG…) and no log_path= is given, sets log_path to the
      log's basename when it is a *.jsonl beside the runstate (else warns and leaves it); an
      explicit log_path= must name such a file (exit 2 otherwise).
  sf-log check [<log path>]
      Parses every line; reports count, invalid lines, unknown stage names, duplicate spawns
      (same agent_id + artifact), spawns missing wall_ms, Claude spawns logged at a model alias
      that another model family served (spawns_model_mismatch),
      spawns/continuations with an implausible (sub-second, non-codex) wall_ms, spawns whose
      wall is orphaned (over 4× and 30 min past their own duration_ms — the orchestrator's
      wait, not the seat's cost: spawns_wall_orphaned), a dead usage channel (three or more
      Claude spawns and none carried tokens: usage_channel_dead=true), triage verdicts
      whose reviewer has no prior spawn event, and gated fixers that ran on a direction with no
      preceding direction-reviewer spawn in their round (fixers_without_direction_review; rows
      from ledgers before 0.31.0 predate the reviewer and are expected in this bucket), and
      closures that ran while the round still had unadjudicated or unredirected semantic gaps
      (closures_without_adjudication; a fixer row whose plan_gaps_semantic is absent or
      non-numeric gates its round as 'unknown', so ledgers before 0.31.0 predate the field
      and are expected here), and the oscillation-stop guards: fixers that re-entered a stopped
      finding without a design note or after a second stop (fixers_on_stopped_findings), a
      second oscillation-stop for one id (oscillation_stops_repeated), and an id reopened in two
      rounds that a fixer ran on with no stop (reopened_twice_without_stop; ledgers before 0.31.0
      predate reopened_ids and never populate it). A row an oscillation guard could not read —
      a scalar findings/reopened_ids, or a stop/closure row without round= — is recorded under
      malformed_fields (warn-level; findings and reopened_ids are validated as string arrays at
      write, so this only catches pre-0.31.0 or hand-edited rows).
      plan_explores_after_drafter {flagged, explores, drafter_end} is flagged when the run has a
      plan-drafter spawn and every plan-phase explore spawn (role explore*, phase=plan) with a
      known start (ts − wall_ms, wall plausible) started at or after the first drafter row's end
      — the earlier of its ts and ts − wall_ms + duration_ms; explores counts the plan-phase
      explore rows; a run with no drafter or no such explore is never flagged (warn-level).
      intervals {last_seat_to_pr_ms, implementer_to_first_reviewer_ms} are the run's two serial
      gaps, each an integer or null (warn-level): the first implement-issue row's ts minus the
      latest ts among the spawn / closure-exchange / clarify / pairing-check rows before it; and
      the earliest start (ts − wall_ms, wall plausible) among reviewer:* spawns at phase=review minus the
      latest ts among implementer* spawns at phase=implement that ended at or before that start
      (an epic run reports its first panel only). A missing row or unknown time gives null.
      Exit 1 if any line is invalid JSON.

Common flags: --log <path> (else $${LOG_ENV_VARS.join(' / $')}); --task <id> / --issue <n>
(else $SF_RUN_TASK / $SF_RUN_ISSUE); --compact (one-line JSON on stdout); --help.
k=v values parse as JSON when they parse (1, true, null, ["a"], {"k":1}); otherwise string.

Stage enum:
  ${STAGES.join(' ')}

Exit codes: 0 success; 1 (check) invalid JSON lines; 2 usage/validation error.
`;

const VALUE_FLAGS = ['log', 'skill', 'task', 'issue', 'phase', 'host', 'resume'];

function parseArgs(args) {
  const flags = {};
  const kv = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq !== -1) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
      } else if (VALUE_FLAGS.includes(key)) {
        const next = args[i + 1];
        if (next === undefined || next.startsWith('--')) die(`--${key} requires a value`);
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
      continue;
    }
    const m = a.match(/^([A-Za-z_][\w.-]*)=([\s\S]*)$/);
    if (m) {
      kv[m[1]] = parseValue(m[2]);
    } else {
      positional.push(a);
    }
  }
  return { flags, kv, positional };
}

/** JSON when it parses, else the raw string. */
function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function resolveLogPath(flags) {
  if (flags.log) return resolve(flags.log);
  for (const name of LOG_ENV_VARS) {
    const v = process.env[name];
    if (v && v.trim()) return resolve(v.trim());
  }
  return null;
}

function requireLogPath(flags) {
  const p = resolveLogPath(flags);
  if (!p) die(`no log path: pass --log <path> or set $${LOG_ENV_VARS.join(' / $')}`);
  return p;
}

/** {task} or {issue} from flags, then env. Numeric issue → number. */
function identity(flags) {
  const task = flags.task ?? process.env.SF_RUN_TASK;
  const issue = flags.issue ?? process.env.SF_RUN_ISSUE;
  if (task && String(task).trim()) return { task: String(task).trim() };
  if (issue && String(issue).trim()) {
    const n = Number(issue);
    return { issue: Number.isInteger(n) ? n : String(issue).trim() };
  }
  return {};
}

function appendEvent(logPath, event) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

// The disposition an `oscillation-stop` row records (warm-closure.md §3): its explicit
// `action` when written; absent, a MEDIUM/LOW stop is `bucket-3` by severity and a
// CRITICAL/HIGH stop is a `design-note` re-entry. The oscillation guards read this rather
// than the raw count, so a checkpoint/bucket-3 terminal move is never treated as a re-entry.
function dispositionOf(row) {
  if (row.action) return row.action;
  return row.severity === 'MEDIUM' || row.severity === 'LOW' ? 'bucket-3' : 'design-note';
}

function emit(obj, compact) {
  process.stdout.write(compact ? `${JSON.stringify(obj)}\n` : `${JSON.stringify(obj, null, 2)}\n`);
}

function validateStage(name, kv) {
  if (!STAGE_SET.has(name)) {
    die(`unknown stage "${name}". Allowed: ${STAGES.join(', ')} (use \`note event=<text>\` for anything else)`);
  }
  const rules = STAGE_RULES[name];
  if (!rules) return;
  for (const k of rules.required || []) {
    if (kv[k] === undefined || kv[k] === null || kv[k] === '') die(`stage ${name} requires ${k}=<value>`);
  }
  for (const [k, allowed] of Object.entries(rules.enums || {})) {
    // An enum key not in `required` is optional: absent is fine, a present value is checked.
    if (kv[k] === undefined) continue;
    if (!allowed.includes(kv[k])) die(`stage ${name}: ${k} must be one of ${allowed.join('|')} (got ${JSON.stringify(kv[k])})`);
  }
  for (const k of rules.ints || []) {
    const v = kv[k];
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 0)) {
      die(`stage ${name}: ${k} must be a non-negative integer (got ${JSON.stringify(v)})`);
    }
  }
  for (const k of rules.arrays || []) {
    // A present array field must be a JSON array of non-empty strings (an empty array is valid);
    // a scalar value would make the read-side oscillation guard skip the row silently.
    const v = kv[k];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0)) {
      die(`stage ${name}: ${k} must be a JSON array of non-empty strings (got ${JSON.stringify(v)})`);
    }
  }
  for (const k of rules.strings || []) {
    // A present optional string field must be a non-empty string — a boolean or number would be
    // read by truthiness downstream rather than as the value it stands for.
    const v = kv[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v.length === 0) {
      die(`stage ${name}: ${k} must be a non-empty string (got ${JSON.stringify(v)})`);
    }
  }
  for (const [k, when] of Object.entries(rules.requiredWhen || {})) {
    for (const [gateKey, gateValues] of Object.entries(when)) {
      if (gateValues.includes(kv[gateKey]) && (kv[k] === undefined || kv[k] === null || kv[k] === '')) {
        die(`stage ${name}: ${k}=<value> is required when ${gateKey}=${kv[gateKey]}`);
      }
    }
  }
  if (rules.validate) {
    const problem = rules.validate(kv);
    if (problem) die(`stage ${name}: ${problem}`);
  }
}

// =============================================================================
// Verbs
// =============================================================================
function hostVersion(host) {
  try {
    const text = execFileSync(host, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const first = text.split('\n')[0].trim();
    return first || null;
  } catch {
    return null;
  }
}

function runMetaEvent(flags) {
  const skill = flags.skill || DEFAULT_SKILL;
  const host = flags.host || process.env.SF_HOST || (process.env.CODEX_THREAD_ID ? 'codex' : 'claude');
  if (!['claude', 'codex'].includes(host)) die('host must be claude or codex');
  const version = hostVersion(host);
  const event = { stage: 'run-meta', host, host_version: version, cc_version: host === 'claude' ? version : null, skill, ...identity(flags) };
  if (flags.phase) event.phase = flags.phase;
  return event;
}

function cmdInit(flags) {
  if (flags.resume !== undefined) {
    cmdInitResume(flags);
    return;
  }
  const skill = flags.skill || DEFAULT_SKILL;
  const logPath = resolveLogPath(flags) || resolve(process.cwd(), 'docs', 'plans', `${skill}-${Math.floor(Date.now() / 1000)}.jsonl`);
  const event = runMetaEvent(flags);
  event.ts = nowIso();
  appendEvent(logPath, event);
  process.stdout.write(`${logPath}\n`);
}

// A ledger named by a runstate lives beside it: a plain *.jsonl file in the runstate's own
// directory. Anything else (`../../.env`, a directory, a symlink out) would be appended to and
// then force-staged by `git add -f "$RUN_LOG"`, so it is refused.
const LEDGER_NAME = /^[\w.-]+\.jsonl$/;
/** The realpath of `p` when it is an acceptable ledger for a runstate in `rsDir`, else
 *  { reason }. `mustExist: false` accepts a not-yet-created file whose parent is `rsDir`. */
function containedLedger(rsDir, p, { mustExist = true } = {}) {
  let dirReal;
  try { dirReal = realpathSync(rsDir); } catch { return { reason: `runstate directory ${rsDir} does not exist` }; }
  let real;
  if (existsSync(p)) {
    real = realpathSync(p);
    if (!statSync(real).isFile()) return { reason: `${p} is not a regular file` };
  } else if (mustExist) {
    return { reason: `recorded log ${p} does not exist` };
  } else {
    try { real = resolve(realpathSync(dirname(p)), basename(p)); } catch { return { reason: `${dirname(p)} does not exist` }; }
  }
  if (dirname(real) !== dirReal || !LEDGER_NAME.test(basename(real))) {
    return { reason: `${p} is not a *.jsonl file beside the runstate in ${dirReal}` };
  }
  return { real };
}

/** A resumed run keeps one ledger: the runstate's recorded log_path. The resumed mark goes in
 *  FIRST, stamped with the new session's start, so /ship-report reads the gap before it as a
 *  session gap; the current (Stage-0) log's other lines follow and that file is removed. */
function cmdInitResume(flags) {
  const rsPath = resolve(String(flags.resume));
  let rs;
  try {
    rs = JSON.parse(readFileSync(rsPath, 'utf8'));
  } catch (e) {
    die(`init --resume: cannot read runstate ${rsPath} (${e.message})`);
  }
  if (rs === null || typeof rs !== 'object' || Array.isArray(rs)) die(`init --resume: ${rsPath} must hold a JSON object`);
  const recordedRaw = typeof rs.log_path === 'string' && rs.log_path.trim() ? resolve(dirname(rsPath), rs.log_path.trim()) : null;
  const checked = recordedRaw ? containedLedger(dirname(rsPath), recordedRaw) : { reason: `${rsPath} records no log_path` };
  const recorded = checked.real ?? null;
  const current = resolveLogPath(flags);
  if (!recorded) {
    warn(`init --resume: ${checked.reason} — continuing in a new log`);
    if (current && existsSync(current)) {
      process.stdout.write(`${current}\n`);
      return;
    }
    cmdInit({ ...flags, resume: undefined });
    return;
  }
  let mark = null;
  const rest = [];
  // Identity, not spelling: a symlinked or case-folded alias of the ledger must never fold
  // into itself and then be unlinked.
  const currentReal = current && existsSync(current) && statSync(current).isFile() ? realpathSync(current) : null;
  const folding = currentReal !== null && currentReal !== recorded;
  if (folding) {
    let earliest = null;
    for (const line of readFileSync(current, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let obj = null;
      try { obj = JSON.parse(line); } catch { /* copied verbatim; `check` reports it */ }
      if (mark === null && obj && obj.stage === 'run-meta') {
        mark = { ...obj, resumed: true };
        continue;
      }
      if (obj && typeof obj.ts === 'string' && (earliest === null || obj.ts < earliest)) earliest = obj.ts;
      rest.push(line);
    }
    if (mark === null) mark = { ...runMetaEvent(flags), resumed: true, ts: earliest ?? nowIso() };
  } else {
    mark = { ...runMetaEvent(flags), resumed: true, ts: nowIso() };
  }
  const existing = readFileSync(recorded, 'utf8');
  // Append, then unlink: a crash between the two leaves the Stage-0 file behind, and the re-run
  // finds its mark (same ts) already in the ledger and only unlinks.
  const alreadyFolded = folding && existing.split('\n').some((line) => {
    try {
      const o = JSON.parse(line);
      return o && o.stage === 'run-meta' && o.resumed === true && o.ts === mark.ts;
    } catch { return false; }
  });
  if (!alreadyFolded) {
    const lead = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    appendFileSync(recorded, lead + [JSON.stringify(mark), ...rest].map((l) => `${l}\n`).join(''));
  }
  if (folding) unlinkSync(currentReal);
  // The runstate's own spelling, not the realpath: the callers' `case "$RUN_LOG" in
  // "$WT_PATH"/…` staging guard compares strings, and $WT_PATH may pass through a symlink.
  process.stdout.write(`${resolve(dirname(rsPath), basename(recorded))}\n`);
}

const RESERVED_STAGE_KEYS = new Set(['stage', 'tokens_cumulative', 'duration_ms_cumulative', 'usage_basis']);
const TIMED_CONTINUATION_STAGES = new Set(['closure-exchange', 'clarify', 'pairing-check']);

/** An Agent spawn or a SendMessage exchange cannot complete in under a second; a tiny wall
 *  means started= was captured at logging time instead of before the call. Logged as-is — the
 *  ledger is the evidence — but named, and `check` lists the row so it is never read as cost.
 *  The mirror defect: a wall longer than any plausible run means started= was captured in
 *  seconds not milliseconds, or pasted from another row. Same treatment, any backend. */
const MAX_PLAUSIBLE_WALL_MS = 48 * 60 * 60 * 1000;
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];
const TRANSCRIPT_SCAN_BYTES = 8 * 1024 * 1024;

/** The Claude Code transcript for a subagent, or null. Layouts:
 *  <projects>/<cwd slug>/<session id>/subagents/agent-<agent_id>.jsonl
 *  <projects>/<cwd slug>/<session id>/subagents/workflows/<run>/agent-<agent_id>.jsonl */
function findAgentTranscript(agentId) {
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(agentId)) return null;
  const root = process.env.SF_CLAUDE_PROJECTS_DIR
    || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const list = (dir) => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
  // A regular file only: a link could point the ledger at text from outside the projects tree.
  const regular = (path) => { try { return lstatSync(path).isFile(); } catch { return false; } };
  const file = `agent-${agentId}.jsonl`;
  for (const project of list(root)) {
    if (!project.isDirectory()) continue;
    for (const session of list(join(root, project.name))) {
      if (!session.isDirectory()) continue;
      const subagents = join(root, project.name, session.name, 'subagents');
      if (regular(join(subagents, file))) return join(subagents, file);
      for (const run of list(join(subagents, 'workflows'))) {
        if (run.isDirectory() && regular(join(subagents, 'workflows', run.name, file))) {
          return join(subagents, 'workflows', run.name, file);
        }
      }
    }
  }
  return null;
}

function servedFromLine(line) {
  if (!line.includes('"assistant"')) return null;
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  const model = row?.type === 'assistant' ? row.message?.model : null;
  if (typeof model !== 'string' || model.startsWith('<')) return null;
  return { model_served: model, ...(typeof row.effort === 'string' ? { effort_served: row.effort } : {}) };
}

/** What first served a Claude seat, read from its transcript's first assistant row:
 *  frontmatter and tier tables record what a seat was asked for, and an alias or a
 *  same-named built-in can resolve to something else. Returns {} when nothing is found;
 *  a served value is never inferred. */
function servedIdentity(agentId) {
  const path = findAgentTranscript(agentId);
  if (!path) return {};
  let fd;
  try {
    fd = openSync(path, 'r');
    const chunk = Buffer.alloc(256 * 1024);
    let carry = '';
    let offset = 0;
    while (offset < TRANSCRIPT_SCAN_BYTES) {
      const read = readSync(fd, chunk, 0, chunk.length, offset);
      if (read === 0) return servedFromLine(carry) ?? {};
      offset += read;
      const lines = (carry + chunk.toString('utf8', 0, read)).split('\n');
      carry = lines.pop();
      for (const line of lines) {
        const served = servedFromLine(line);
        if (served) return served;
      }
    }
  } catch { /* an unreadable transcript records nothing */ } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to release */ } }
  }
  return {};
}

function isClaudeRow(kv) { return !['codex-exec', 'codex-native'].includes(kv.agent_type) && !['codex', 'codex-native'].includes(kv.backend); }
function implausibleWall(kv, wallMs) {
  if (typeof wallMs !== 'number') return null;
  if (wallMs < 1000 && isClaudeRow(kv)) return 'sub-second';
  if (wallMs > MAX_PLAUSIBLE_WALL_MS) return 'over-48h';
  return null;
}
/** A seat whose reported duration ended long before the orchestrator logged it: the wall is
 *  the orchestrator's wait, not the seat's cost (ship-task-1789694529 logged a 9-minute Explore
 *  at 9.8 h of wall, which made its plan phase read as 605 min). Flagged, and skipped by
 *  /ship-report's wall attribution, when wall exceeds 4× duration and by more than 30 min. */
const ORPHAN_SLACK_MS = 30 * 60 * 1000;
function orphanedWall(kv, wallMs) {
  const d = typeof kv.duration_ms === 'number' ? kv.duration_ms : null;
  if (typeof wallMs !== 'number' || d === null || d <= 0) return false;
  return wallMs > d * 4 && wallMs - d > ORPHAN_SLACK_MS;
}
function warnImplausibleWall(what, kv, wallMs) {
  const why = implausibleWall(kv, wallMs);
  if (why === 'sub-second') {
    warn(`${what} ${kv.role}: wall_ms=${wallMs} — started= must be captured BEFORE the spawn/exchange is issued, not when it is logged; this row will be flagged by \`sf-log check\``);
  } else if (why === 'over-48h') {
    warn(`${what} ${kv.role}: wall_ms=${wallMs} exceeds 48 h — started= is not this row's epoch-millisecond start (seconds instead of ms, or another spawn's T0); this row will be flagged by \`sf-log check\``);
  }
}

/** A Claude row with no token count: recorded explicitly so a report never reads it as zero. */
function usageMissing(kv) {
  return isClaudeRow(kv) && (kv.tokens === undefined || kv.tokens === null || kv.tokens === '');
}

// A Claude SendMessage continuation reports usage cumulative over the agent's life (UNVERIFIED as
// a rule; seen as duration_ms far above wall_ms), so each row stores its own turn: the delta
// against the latest earlier row for the same agent_id that carries that field. Once a field has
// demonstrated a per-turn channel (an earlier raw value below its baseline), its later turns stay
// per-turn (a delta against a per-turn value is meaningless). A first value, or one with no
// baseline, is stored raw but proves nothing, so the next turn still de-cumulates against it.
// Codex resume turns are per-turn already.
const DECUMULATED_STAGES = new Set(['closure-exchange', 'clarify']);
const DECUMULATED_FIELDS = ['tokens', 'duration_ms'];
function decumulate(name, kv, logPath) {
  const present = DECUMULATED_FIELDS.filter((f) => typeof kv[f] === 'number');
  if (present.length === 0) return;
  const id = kv.agent_id;
  if (id === undefined || id === null || id === '') {
    die(`${name}: ${present.join('/')} on a Claude continuation requires agent_id=<id> (its usage is de-cumulated against that agent's earlier rows)`);
  }
  const rows = rowsFor(logPath, id);
  let basis = null;
  for (const f of present) {
    const cur = kv[f];
    let prev = null;
    let perTurnChannel = false;
    for (const r of rows) {
      if (typeof r[f] !== 'number') continue;
      const cumulative = typeof r[`${f}_cumulative`] === 'number';
      if (!cumulative && typeof prev === 'number' && r[f] < prev) perTurnChannel = true;
      prev = cumulative ? r[`${f}_cumulative`] : r[f];
    }
    const fieldBasis = !perTurnChannel && typeof prev === 'number' && cur >= prev ? 'delta' : 'per-turn';
    if (fieldBasis === 'delta') {
      kv[`${f}_cumulative`] = cur;
      kv[f] = cur - prev;
    }
    // tokens is the cost field /ship-report sums, so its basis names the row.
    if (basis === null || f === 'tokens') basis = fieldBasis;
  }
  kv.usage_basis = basis;
}

/** Every ledger row carrying this agent_id, in order (tolerant read, as findDuplicateSpawn). */
function rowsFor(logPath, agentId) {
  if (!existsSync(logPath)) return [];
  const found = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj && obj.agent_id === agentId) found.push(obj);
  }
  return found;
}

function cmdStage(flags, kv, positional) {
  const name = positional[0];
  if (!name) die('stage <name> [k=v ...] — stage name required');
  // Written by sf-log itself: a caller-supplied stage= would forge another row kind (a resume
  // mark), and a caller-supplied cumulative/basis would be read back as de-cumulation state.
  const reserved = Object.keys(kv).filter((k) => RESERVED_STAGE_KEYS.has(k));
  if (reserved.length) die(`stage ${name}: ${reserved.join(', ')} are set by sf-log, never passed`);
  validateStage(name, kv);
  // Continuations are ledger turns (spawn-accounting.md §Continuations): same wall_ms
  // rule as spawn — computed from started=, refused without it, --late records null.
  if (TIMED_CONTINUATION_STAGES.has(name)) {
    if (kv.wall_ms === undefined) {
      if (kv.started !== undefined) {
        const started = Number(kv.started);
        if (!Number.isFinite(started)) die(`${name}: started must be epoch milliseconds (got ${JSON.stringify(kv.started)})`);
        kv.wall_ms = Math.max(0, Date.now() - started);
      } else if (flags.late) {
        kv.wall_ms = null;
        kv.late = true;
      } else {
        die(`${name} requires started=<epoch ms captured before the exchange> or wall_ms=<ms> (pass --late only when the start time is genuinely unrecoverable)`);
      }
    }
    delete kv.started;
    warnImplausibleWall(name, kv, kv.wall_ms === null ? null : Number(kv.wall_ms));
  }
  const logPath = requireLogPath(flags);
  if (DECUMULATED_STAGES.has(name) && isClaudeRow(kv)) {
    decumulate(name, kv, logPath);
    if (usageMissing(kv)) kv.usage_missing = true;
  }
  const event = { stage: name, ...identity(flags), ...kv, ts: nowIso() };
  appendEvent(logPath, event);
  emit(event, flags.compact);
}

function cmdSpawn(flags, kv) {
  for (const k of SPAWN_REQUIRED) {
    if (kv[k] === undefined || kv[k] === '') die(`spawn requires ${SPAWN_REQUIRED.join(', ')} (missing ${k})`);
  }
  const role = String(kv.role);
  // /ship-report aggregates on role, so a drifted name (security-reviewer, plan-fixer) splits a
  // seat's cost across rows that no report joins; refused at write, nothing appended.
  const bad = roleError(role, kv.phase);
  if (bad) die(`spawn: ${bad}`);
  // merged_items and direction are role-independent field invariants: a spawn row that
  // carries either must carry a well-formed value, or the direction-review gate reads
  // garbage. Refuse rather than write a malformed row (null counts as absent per the
  // `?? null` ledger convention; a refused write appends nothing, exit 2).
  for (const field of ['merged_items', 'merged_high']) {
    if (kv[field] !== undefined && kv[field] !== null) {
      const mi = kv[field];
      if (typeof mi !== 'number' || !Number.isInteger(mi) || mi < 0) {
        die(`spawn: ${field} must be a non-negative integer (got ${JSON.stringify(mi)})`);
      }
    }
  }
  if (kv.direction !== undefined && kv.direction !== null) {
    const d = kv.direction;
    if (d !== true && d !== false && !(typeof d === 'string' && d.length > 0)) {
      die(`spawn: direction must be true, false, or a non-empty path (got ${JSON.stringify(d)})`);
    }
  }
  // plan_gaps_* are role-independent field invariants (same rule as merged_items): a present
  // count must be a non-negative integer, or closures_without_adjudication reads garbage.
  // null counts as absent; a refused write appends nothing (exit 2).
  for (const field of ['plan_gaps_semantic', 'plan_gaps_cosmetic']) {
    const v = kv[field];
    if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0)) {
      die(`spawn: ${field} must be a non-negative integer (got ${JSON.stringify(v)})`);
    }
  }
  // findings is a role-independent field invariant (same rule as merged_items): a present
  // value must be a JSON array of non-empty strings, or fixers_on_stopped_findings reads a
  // scalar and silently skips the row — a one-character typo would blind the oscillation
  // guard. null counts as absent; an empty array is valid; a refused write appends nothing.
  if (kv.findings !== undefined && kv.findings !== null) {
    const f = kv.findings;
    if (!Array.isArray(f) || f.some((x) => typeof x !== 'string' || x.length === 0)) {
      die(`spawn: findings must be a JSON array of non-empty strings (got ${JSON.stringify(f)})`);
    }
  }
  let wallMs = null;
  if (kv.wall_ms !== undefined) {
    wallMs = kv.wall_ms;
  } else if (kv.started !== undefined) {
    const started = Number(kv.started);
    if (!Number.isFinite(started)) die(`spawn: started must be epoch milliseconds (got ${JSON.stringify(kv.started)})`);
    wallMs = Math.max(0, Date.now() - started);
  } else if (flags.late) {
    // Adopted/resumed run where the start time is genuinely gone: recorded as null, never fabricated.
  } else {
    die('spawn requires started=<epoch ms captured BEFORE issuing the spawn> or wall_ms=<ms> — wall_ms is the one cost field that survives a dead usage channel (spawn-accounting.md; without it a run\'s Claude cost is unmeasurable). Capture T0=$(date +%s%3N) in the block that issues the spawn. If the start time is genuinely unrecoverable (adopted run), pass --late to record wall_ms=null explicitly.');
  }
  warnImplausibleWall('spawn', kv, wallMs);
  // model_served / effort_served are measured by sf-log, so a caller's values are dropped.
  const { started: _started, wall_ms: _wall, model_served: _model, effort_served: _effort, ...rest } = kv;
  const logPath = requireLogPath(flags);
  // A Codex seat writes its own spawn row (spawn-accounting.md §Codex seats); an orchestrator that
  // logs the same seat again — to add a field it wanted on the row — doubles its tokens and wall
  // in every aggregate. The row already there wins; add fields with `stage note` instead.
  const dup = findDuplicateSpawn(logPath, kv.agent_id, kv.artifact);
  if (dup) {
    warn(`duplicate spawn for agent_id=${kv.agent_id} artifact=${kv.artifact} already logged at ${dup.ts} (role=${dup.role}) — not written; a sf-codex seat logs itself, add fields with \`sf-log stage note\``);
    emit({ skipped: 'duplicate-spawn', existing: dup }, flags.compact);
    return;
  }
  const event = {
    stage: 'spawn',
    role,
    agent_type: kv.agent_type,
    model: kv.model,
    phase: kv.phase,
    round: kv.round ?? null,
    escalated: kv.escalated ?? false,
    tokens: kv.tokens ?? null,
    duration_ms: kv.duration_ms ?? null,
    wall_ms: wallMs,
    ...(flags.late ? { late: true } : {}),
    ...(usageMissing(kv) ? { usage_missing: true } : {}),
    agent_id: kv.agent_id ?? null,
    artifact: kv.artifact ?? null,
    ...identity(flags),
    ...rest, // any extra keys (e.g. path, findings_reopened) pass through
    ...(isClaudeRow(kv) ? servedIdentity(kv.agent_id) : {}),
    ts: nowIso(),
  };
  appendEvent(logPath, event);
  emit(event, flags.compact);
}

/** The earlier spawn row with this agent_id AND artifact, or null. Both must be present — a
 *  null agent_id (Claude seats logged without one) or a null artifact identifies nothing. */
function findDuplicateSpawn(logPath, agentId, artifact) {
  if (agentId === undefined || agentId === null || agentId === '' || artifact === undefined || artifact === null || artifact === '') return null;
  if (!existsSync(logPath)) return null;
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj && obj.stage === 'spawn' && obj.agent_id === agentId && obj.artifact === artifact) return obj;
  }
  return null;
}

function cmdCheckpoint(flags, kv) {
  if (!kv.reason) die('checkpoint requires reason=<slug>');
  if (!kv.at) die('checkpoint requires at=<stage-name>');
  const { reason, at, detail, artifact, ...rest } = kv;
  const logPath = requireLogPath(flags);
  const event = {
    stage: String(at),
    event: 'checkpoint',
    reason,
    detail: detail ?? null,
    artifact: artifact ?? null,
    ...identity(flags),
    ...rest,
    ts: nowIso(),
  };
  appendEvent(logPath, event);
  emit(event, flags.compact);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] === null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function cmdCursor(flags, kv, positional) {
  const target = positional[0];
  if (!target) die('cursor <runstate.json> k=v ... — path required');
  if (Object.keys(kv).length === 0) die('cursor: at least one k=v required');
  const path = resolve(target);
  let doc = {};
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    if (text.trim()) {
      try {
        doc = JSON.parse(text);
      } catch (e) {
        die(`cursor: ${path} is not valid JSON (${e.message})`);
      }
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) die(`cursor: ${path} must hold a JSON object`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  // log_path obeys init --resume's containment rule: a *.jsonl beside the runstate.
  if (kv.log_path !== undefined) {
    const ok = typeof kv.log_path === 'string' && containedLedger(dirname(path), resolve(dirname(path), kv.log_path), { mustExist: false });
    if (!ok || !ok.real) die(`cursor: log_path ${JSON.stringify(kv.log_path)} must name a *.jsonl file beside the runstate${ok ? ` (${ok.reason})` : ''}`);
  }
  for (const [k, v] of Object.entries(kv)) setPath(doc, k, v);
  // Relative to the runstate's directory — the resolution hooks/session-resumed.py and
  // `init --resume` use — so the pair survives a worktree move or a fresh clone.
  const logPath = resolveLogPath(flags);
  if (logPath && kv.log_path === undefined) {
    const ok = containedLedger(dirname(path), logPath, { mustExist: false });
    if (ok.real) doc.log_path = basename(ok.real);
    else warn(`cursor: $RUN_LOG ${logPath} is not beside the runstate (${ok.reason}) — log_path left unchanged`);
  }
  // The session that last advanced the run owns it: hooks/session-resumed.py marks only the
  // runs whose session_id matches the resuming session, so another session's resume in the
  // same checkout never writes into this run's ledger. An explicit session_id= wins.
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (sessionId && kv.session_id === undefined) doc.session_id = sessionId;
  doc.updated = nowIso();
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  emit(doc, flags.compact);
}

function cmdCheck(flags, positional) {
  const logPath = positional[0] ? resolve(positional[0]) : requireLogPath(flags);
  if (!existsSync(logPath)) die(`check: ${logPath} does not exist`);
  const lines = readFileSync(logPath, 'utf8').split('\n');
  const report = {
    log: logPath,
    lines: 0,
    events: 0,
    invalid_lines: [],
    unknown_stages: [],
    spawns_missing_wall_ms: [],
    spawns_duplicate: [],
    spawns_wall_implausible: [],
    continuations_wall_implausible: [],
    // Wall far past the seat's own duration: the orchestrator's wait, not the seat's cost.
    spawns_wall_orphaned: [],
    // Every Claude spawn row carries tokens=null: the usage channel was dead for the whole
    // run, so its cost story is timing-only (spawn-accounting.md §Scope & honesty).
    usage_channel_dead: false,
    claude_spawns: 0,
    claude_spawns_without_tokens: 0,
    triage_verdicts_without_prior_spawn: [],
    fixers_without_direction_review: [],
    closures_without_adjudication: [],
    fixers_on_stopped_findings: [],
    oscillation_stops_repeated: [],
    reopened_twice_without_stop: [],
    // Rows an oscillation guard could not read: a present-but-non-array findings/reopened_ids,
    // or a stop/closure row without round= (pre-0.31 or hand-edited). Warn-level: recorded so a
    // silently-skipped row is visible, never flips ok. { line, stage, field, reason }.
    malformed_fields: [],
    // SOLO_MODEL run (preflight solo_model=): a non-Explore Claude spawn at any other model
    // broke the operator's fleet lock. { line, role, agent_type, model, solo_model }.
    spawns_off_solo_model: [],
    // A Claude spawn logged at a model alias that a different model family served (the
    // transcript's model_served). A row logged as session or inherit names no family, so it
    // is never compared. Warn-level. { line, role, agent_type, model, model_served }.
    spawns_model_mismatch: [],
    // A planned run whose plan-phase Explores all started after the drafter had returned:
    // the reports could not inform the draft and the drafter ran alone. Warn-level.
    plan_explores_after_drafter: { flagged: false, explores: 0, drafter_end: null },
    // The two serial gaps of a run: the last seat's return to the PR, and the implementer's
    // return to the first reviewer's start. null when a row or a time is missing. Warn-level.
    intervals: { last_seat_to_pr_ms: null, implementer_to_first_reviewer_ms: null },
    stages: {},
  };
  let soloModel = null;
  // Only a spawn row's end (ts) is stored; its start is ts − wall_ms, so a row without a
  // wall, or with an implausible one, has no known start and cannot decide the flag either way.
  let drafterEndMs = null;
  const planExploreStarts = [];
  let lastSeatEndMs = null;
  let prSeen = false;
  let firstReviewerStartMs = null;
  const implementerEnds = [];
  const seenRoles = new Set();
  // Namespaced rounds (`${epic_phase}:${round}`) that have a direction-reviewer spawn.
  // The reviewer spawn is logged before the round's fixer (ship-task 3e step 2b), so a
  // linear pass has it in hand by the time the fixer row is read.
  const directionReviewedRounds = new Set();
  // Semantic-gap adjudication (ship-task 3e step 3.5): per namespaced round, pendingGaps holds
  // the running sum of the round's fixer-spawn plan_gaps_semantic (or the sentinel 'unknown'
  // when a count was absent/non-numeric); an `adjudication` row resets it to its `redirected`
  // count; a closure seat (a `closure-exchange` row or a cold-fallback review-phase reviewer
  // spawn) seen while it is 'unknown' or > 0 marks the round. One row per marked round, keyed to dedupe.
  const pendingGaps = new Map(); // `${epic_phase}:${round}` → summed gaps, or 'unknown'
  const adjudicationOffenses = new Map(); // same key → { line, count, round, epic_phase, plan_gaps_semantic }
  const seenSpawnKeys = new Map(); // `${agent_id}\u0000${artifact}` → first line
  // Oscillation stop (warm-closure.md §3): an item id's second REOPENED ends its mechanical
  // loop. A fixer that carries a stopped id in its findings is a defect when the stop had no
  // design_note (the id must not re-enter) or when the id already has two stops (a second
  // design note is never allowed). Keyed `${epic_phase}:${finding}` — rounds restart per
  // epic phase, so the finding id (not the round) namespaces the stop.
  const oscillationStops = new Map(); // key → { line, first_line, design_note, disposition, count }
  // reopened_twice_without_stop: per `${epic_phase}:${finding}` the set of namespaced rounds
  // whose closure-exchange listed the id in reopened_ids. A fixer seen (in the same epic
  // phase) while an id has ≥2 such rounds and no stop is a missed oscillation stop.
  const reopenedRounds = new Map(); // key → { rounds: Set, epic_phase, finding }
  const reopenedFlagged = new Set(); // keys already pushed (one row per id)
  const covers = (name) => {
    for (const r of seenRoles) {
      if (r === name || r === `reviewer:${name}` || r.startsWith(`${name}:`) || r.startsWith(`reviewer:${name}:`)) return true;
    }
    return false;
  };
  lines.forEach((line, idx) => {
    const n = idx + 1;
    if (!line.trim()) return;
    report.lines += 1;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      report.invalid_lines.push(n);
      return;
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      report.invalid_lines.push(n);
      return;
    }
    report.events += 1;
    const stage = obj.stage;
    report.stages[stage] = (report.stages[stage] || 0) + 1;
    // checkpoint events carry the skill's cursor stage in `stage` (e.g. "3f") — exempt from the enum.
    if (obj.event !== 'checkpoint' && !STAGE_SET.has(stage)) {
      report.unknown_stages.push({ line: n, stage: stage ?? null });
    }
    if (stage === 'spawn' && (obj.wall_ms === undefined || obj.wall_ms === null)) {
      report.spawns_missing_wall_ms.push(n);
    }
    if (stage === 'spawn' && obj.agent_id && obj.artifact) {
      const key = `${obj.agent_id}\u0000${obj.artifact}`;
      if (seenSpawnKeys.has(key)) report.spawns_duplicate.push({ line: n, first_line: seenSpawnKeys.get(key), role: obj.role ?? null, agent_id: obj.agent_id, artifact: obj.artifact });
      else seenSpawnKeys.set(key, n);
    }
    // A Claude Agent spawn logged with a sub-second wall had started= captured at logging time;
    // a wall over 48 h had a started= that was never this row's start. Neither is a
    // measurement and /ship-report must not read either as one.
    const why = implausibleWall(obj, obj.wall_ms);
    if (why) {
      if (stage === 'spawn') report.spawns_wall_implausible.push({ line: n, role: obj.role ?? null, wall_ms: obj.wall_ms, why });
      else if (TIMED_CONTINUATION_STAGES.has(stage)) report.continuations_wall_implausible.push({ line: n, stage, role: obj.role ?? null, wall_ms: obj.wall_ms, why });
    }
    if (stage === 'spawn' && orphanedWall(obj, obj.wall_ms)) {
      report.spawns_wall_orphaned.push({ line: n, role: obj.role ?? null, wall_ms: obj.wall_ms, duration_ms: obj.duration_ms });
    }
    if (stage === 'preflight' && obj.solo_model) soloModel = String(obj.solo_model);
    const rowMs = typeof obj.ts === 'string' ? Date.parse(obj.ts) : NaN;
    if (!prSeen && Number.isFinite(rowMs)) {
      if (stage === 'implement-issue') {
        prSeen = true;
        // A seat row logged with a later ts than the PR row is out of order, not a gap.
        if (lastSeatEndMs !== null && rowMs >= lastSeatEndMs) report.intervals.last_seat_to_pr_ms = rowMs - lastSeatEndMs;
      } else if (stage === 'spawn' || TIMED_CONTINUATION_STAGES.has(stage)) {
        lastSeatEndMs = lastSeatEndMs === null ? rowMs : Math.max(lastSeatEndMs, rowMs);
      }
    }
    if (stage === 'spawn' && typeof obj.role === 'string') {
      const endMs = rowMs;
      if (obj.role.startsWith('reviewer:') && obj.phase === 'review' && Number.isFinite(endMs) && Number.isFinite(obj.wall_ms) && !why) {
        const startMs = endMs - obj.wall_ms;
        if (firstReviewerStartMs === null || startMs < firstReviewerStartMs) firstReviewerStartMs = startMs;
      }
      if (obj.role.startsWith('implementer') && obj.phase === 'implement' && Number.isFinite(endMs)) implementerEnds.push(endMs);
      const isDrafter = obj.role === 'plan-drafter' || obj.role.startsWith('plan-drafter:');
      if (isDrafter && drafterEndMs === null && Number.isFinite(endMs)) {
        // ts is when the row was logged, which can trail the seat's return; the seat's own
        // duration from its start bounds the end from below. An implausible wall or a
        // non-positive duration gives no usable start, so the end stays at ts.
        const ownEndMs = Number.isFinite(obj.wall_ms) && !why && Number.isFinite(obj.duration_ms) && obj.duration_ms > 0
          ? endMs - obj.wall_ms + obj.duration_ms : endMs;
        drafterEndMs = Math.min(endMs, ownEndMs);
        report.plan_explores_after_drafter.drafter_end = drafterEndMs === endMs ? obj.ts : new Date(drafterEndMs).toISOString();
      }
      if (obj.role.startsWith('explore') && obj.phase === 'plan') {
        report.plan_explores_after_drafter.explores += 1;
        if (Number.isFinite(endMs) && Number.isFinite(obj.wall_ms) && !why) planExploreStarts.push(endMs - obj.wall_ms);
      }
    }
    if (stage === 'spawn' && soloModel && isClaudeRow(obj) && obj.agent_type !== 'Explore' && obj.model !== soloModel) {
      report.spawns_off_solo_model.push({ line: n, role: obj.role ?? null, agent_type: obj.agent_type ?? null, model: obj.model ?? null, solo_model: soloModel });
    }
    if (stage === 'spawn' && isClaudeRow(obj) && MODEL_ALIASES.includes(obj.model)
      && typeof obj.model_served === 'string' && !obj.model_served.includes(obj.model)) {
      report.spawns_model_mismatch.push({ line: n, role: obj.role ?? null, agent_type: obj.agent_type ?? null, model: obj.model, model_served: obj.model_served });
    }
    if (stage === 'spawn' && isClaudeRow(obj)) {
      report.claude_spawns += 1;
      if (obj.tokens === null || obj.tokens === undefined) report.claude_spawns_without_tokens += 1;
    }
    if (['spawn', 'closure-exchange', 'clarify', 'pairing-check'].includes(stage) && obj.role) {
      seenRoles.add(String(obj.role));
    }
    // A gated fixer whose namespaced round never saw a direction-reviewer spawn ran on an
    // unreviewed direction (ship-task 3e step 2b). Gated = a binding direction AND a
    // merged_items that is absent, unparseable, or positive — an explicit 0 is the only
    // exemption (fail-closed: a malformed count gates rather than exempts). Pre-0.31.0 rows
    // carry a direction but no reviewer and land here as expected. No round, no flag.
    if (stage === 'spawn' && obj.role && obj.round !== undefined && obj.round !== null) {
      const role = String(obj.role);
      if (role.startsWith('direction-reviewer')) {
        directionReviewedRounds.add(`${obj.epic_phase ?? ''}:${obj.round}`);
      } else if (role.startsWith('fixer')) {
        const hasDirection = obj.direction !== undefined && obj.direction !== null && obj.direction !== false;
        const merged = obj.merged_items;
        // 0.33.0: the review is gated on merged items that carry a CRITICAL/HIGH. A row that
        // states merged_high=0 is ungated even when merged_items > 0; a row without
        // merged_high falls back to the pre-0.33.0 rule.
        const mergedHigh = obj.merged_high;
        const gated = typeof mergedHigh === 'number'
          ? mergedHigh > 0
          : merged === undefined || typeof merged !== 'number' || merged > 0;
        if (hasDirection && gated && !directionReviewedRounds.has(`${obj.epic_phase ?? ''}:${obj.round}`)) {
          report.fixers_without_direction_review.push({
            line: n,
            round: obj.round,
            epic_phase: obj.epic_phase ?? null,
            direction: obj.direction,
            merged_items: typeof merged === 'number' ? merged : 'unknown',
          });
        }
      }
    }
    // A closure seat that ran while the round still had unadjudicated or unredirected semantic gaps
    // (ship-task 3e step 3.5). pendingGaps accumulates the plan_gaps_semantic of every fixer
    // spawn in the namespaced round (first fixer + any addendum); an `adjudication` row resets
    // it to its own `redirected` count (the redirect addendum's gaps then accumulate onto that,
    // and the round's second adjudication with redirected=0 clears it). A fixer count that is
    // absent or non-numeric gates the round as 'unknown' (fail-closed, matching merged_items)
    // and absorbs — once unknown, stays unknown until an adjudication row resolves it;
    // pre-0.31.0 Claude fixer rows predate the field and land here as expected. A closure while
    // pending is 'unknown' or > 0 is flagged.
    if (obj.round !== undefined && obj.round !== null) {
      const key = `${obj.epic_phase ?? ''}:${obj.round}`;
      const roundRole = obj.role ? String(obj.role) : '';
      if (stage === 'spawn' && roundRole.startsWith('fixer')) {
        const prev = pendingGaps.get(key);
        const g = obj.plan_gaps_semantic;
        if (prev === 'unknown' || typeof g !== 'number') pendingGaps.set(key, 'unknown');
        else pendingGaps.set(key, (typeof prev === 'number' ? prev : 0) + g);
      } else if (stage === 'adjudication') {
        // Reset to what this adjudication left unresolved: its `redirected` count. A
        // non-numeric redirected gates as 'unknown' (fail-closed, matching a fixer count).
        pendingGaps.set(key, typeof obj.redirected === 'number' ? obj.redirected : 'unknown');
      } else {
        // A cold-fallback closure is a review-phase reviewer spawn that follows the round's
        // fixer — implied here because pendingGaps is only set by that fixer spawn.
        const isClosureSeat =
          stage === 'closure-exchange' ||
          (stage === 'spawn' && roundRole.startsWith('reviewer:') && obj.phase === 'review');
        const pending = pendingGaps.get(key);
        const gated = pending === 'unknown' || (typeof pending === 'number' && pending > 0);
        if (isClosureSeat && gated) {
          const existing = adjudicationOffenses.get(key);
          if (existing) existing.count += 1;
          else adjudicationOffenses.set(key, { line: n, count: 1, round: obj.round, epic_phase: obj.epic_phase ?? null, plan_gaps_semantic: pending });
        }
      }
    }
    // Oscillation stop (warm-closure.md §3): record each `oscillation-stop` row, then flag a
    // later fixer that carries a stopped id. Linear order gives "later" for free — the Map holds
    // only stops seen so far. A second (or later) row is a repeated stop only when its
    // disposition is `design-note`; a `checkpoint`/`bucket-3` row is the §3-prescribed terminal
    // move, so it updates the entry's latest disposition without being flagged.
    if (stage === 'oscillation-stop' && obj.finding !== undefined && obj.finding !== null) {
      if (obj.round === undefined || obj.round === null) {
        // round is required at write, so a stop without it is a pre-0.31 or hand-edited row:
        // recorded and neither stored nor counted, so it can neither trigger nor suppress a
        // later fixer flag. The count increment and the repeated push share this one gate.
        report.malformed_fields.push({ line: n, stage, field: 'round', reason: 'missing-round' });
      } else {
        const key = `${obj.epic_phase ?? ''}:${obj.finding}`;
        const disposition = dispositionOf(obj);
        const existing = oscillationStops.get(key);
        if (existing) {
          existing.count += 1;
          existing.line = n;
          existing.design_note = obj.design_note ?? null;
          existing.disposition = disposition;
          if (disposition === 'design-note') {
            report.oscillation_stops_repeated.push({ line: n, finding: obj.finding, first_line: existing.first_line });
          }
        } else {
          oscillationStops.set(key, { line: n, first_line: n, design_note: obj.design_note ?? null, disposition, count: 1 });
        }
      }
    }
    // A closure-exchange row that carries reopened ids feeds reopened_twice_without_stop:
    // track, per id, the distinct namespaced rounds that reopened it. A scalar reopened_ids or
    // a row without round= (both pre-0.31 or hand-edited) would silently drop that reopen
    // history — recorded under malformed_fields instead. A closure row with no reopened_ids
    // carries nothing for the guard and is ignored.
    if (stage === 'closure-exchange' && obj.reopened_ids !== undefined && obj.reopened_ids !== null) {
      if (!Array.isArray(obj.reopened_ids)) {
        report.malformed_fields.push({ line: n, stage, field: 'reopened_ids', reason: 'not-array' });
      } else if (obj.round === undefined || obj.round === null) {
        report.malformed_fields.push({ line: n, stage, field: 'round', reason: 'missing-round' });
      } else {
        const roundKey = `${obj.epic_phase ?? ''}:${obj.round}`;
        for (const id of obj.reopened_ids) {
          const key = `${obj.epic_phase ?? ''}:${id}`;
          let entry = reopenedRounds.get(key);
          if (!entry) {
            entry = { rounds: new Set(), epic_phase: obj.epic_phase ?? '', finding: id };
            reopenedRounds.set(key, entry);
          }
          entry.rounds.add(roundKey);
        }
      }
    }
    if (stage === 'spawn' && obj.role && String(obj.role).startsWith('fixer') && obj.round !== undefined && obj.round !== null) {
      // A stopped id that re-enters a fixer round is a defect unless it is the one sanctioned
      // re-entry §3 allows (a single design-note stop with its note attached). The reason is
      // read from the LATEST stop's disposition (warm-closure.md §3): a checkpoint/bucket-3 stop
      // ended the mechanical loop, so any fixer carrying the id afterwards re-entered a closed
      // loop; a second design-note stop is never allowed; a first design-note stop with no note
      // means the note artifact is missing. A fixer with no findings field is not inspected.
      if (Array.isArray(obj.findings)) {
        for (const id of obj.findings) {
          const stop = oscillationStops.get(`${obj.epic_phase ?? ''}:${id}`);
          if (!stop) continue;
          let reason = null;
          if (stop.disposition === 'checkpoint') reason = 're-entered-after-checkpoint';
          else if (stop.disposition === 'bucket-3') reason = 're-entered-after-bucket-3';
          else if (stop.count >= 2) reason = 'second-design-note';
          else if (!stop.design_note) reason = 'no-design-note';
          if (reason) report.fixers_on_stopped_findings.push({ line: n, round: obj.round, epic_phase: obj.epic_phase ?? null, finding: id, stop_line: stop.line, reason });
        }
      } else if (obj.findings !== undefined && obj.findings !== null) {
        // A present-but-non-array findings value (pre-0.31 or hand-edited): recorded so the
        // skipped fixer row is visible. The missed-stop scan below still runs for it (N2).
        report.malformed_fields.push({ line: n, stage, field: 'findings', reason: 'not-array' });
      }
      // A missed stop: an id reopened in ≥2 distinct rounds of this epic phase that this fixer
      // ran on while no stop for it has been logged. Scoped to the fixer's own epic phase so a
      // sibling phase's fixer cannot flag it. One row per id.
      const fixerPhase = obj.epic_phase ?? '';
      for (const [key, entry] of reopenedRounds) {
        if (entry.epic_phase !== fixerPhase) continue;
        if (entry.rounds.size < 2) continue;
        if (reopenedFlagged.has(key)) continue;
        if (oscillationStops.has(key)) continue;
        reopenedFlagged.add(key);
        report.reopened_twice_without_stop.push({ line: n, finding: entry.finding, rounds: [...entry.rounds] });
      }
    }
    // A triage verdict for a reviewer with no earlier spawn/continuation event means the
    // spawn was logged late (after the triage that consumed it) or never — either way
    // /ship-report's cost story for that reviewer is broken at read time.
    if (stage === 'triage' && obj.reviewer_verdicts && typeof obj.reviewer_verdicts === 'object') {
      for (const name of Object.keys(obj.reviewer_verdicts)) {
        if (!covers(name)) report.triage_verdicts_without_prior_spawn.push({ line: n, reviewer: name });
      }
    }
  });
  // The linear pass flags a fixer whose reviewer spawn was not yet seen. By now the Set is
  // complete, so distinguish "reviewer never logged" from "reviewer logged after the fixer"
  // (out-of-order write): the latter still ran unreviewed, but the reviewer exists.
  for (const row of report.fixers_without_direction_review) {
    row.reviewer_logged_later = directionReviewedRounds.has(`${row.epic_phase ?? ''}:${row.round}`);
  }
  for (const off of adjudicationOffenses.values()) report.closures_without_adjudication.push(off);
  // Three or more Claude spawns and not one carried usage: the channel was dead, not one
  // seat unlucky. /ship-report reads this flag and reports the run as timing-only.
  report.usage_channel_dead = report.claude_spawns >= 3 && report.claude_spawns_without_tokens === report.claude_spawns;
  report.plan_explores_after_drafter.flagged = drafterEndMs !== null
    && planExploreStarts.length > 0
    && planExploreStarts.every((start) => start >= drafterEndMs);
  if (firstReviewerStartMs !== null) {
    let latestBefore = null;
    for (const end of implementerEnds) {
      if (end <= firstReviewerStartMs && (latestBefore === null || end > latestBefore)) latestBefore = end;
    }
    if (latestBefore !== null) report.intervals.implementer_to_first_reviewer_ms = firstReviewerStartMs - latestBefore;
  }
  report.ok = report.invalid_lines.length === 0;
  emit(report, flags.compact);
  process.exit(report.ok ? 0 : 1);
}

// =============================================================================
// main
// =============================================================================
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}
const [verb, ...rest] = argv;
const { flags, kv, positional } = parseArgs(rest);

switch (verb) {
  case 'init':
    cmdInit(flags);
    break;
  case 'stage':
    cmdStage(flags, kv, positional);
    break;
  case 'spawn':
    cmdSpawn(flags, kv);
    break;
  case 'checkpoint':
    cmdCheckpoint(flags, kv);
    break;
  case 'cursor':
    cmdCursor(flags, kv, positional);
    break;
  case 'check':
    cmdCheck(flags, positional);
    break;
  default:
    die(`unknown verb "${verb}" (expected init | stage | spawn | checkpoint | cursor | check; see --help)`);
}
