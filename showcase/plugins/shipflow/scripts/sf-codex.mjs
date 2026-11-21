#!/usr/bin/env node
/**
 * @file sf-codex.mjs
 * @description Headless-Codex review and writer seats for the shipflow ship-* skills (skills/shared/review-backend.md).
 *   Runs one reviewer seat (plan review, code review, warm closure, clarification) through
 *   `codex exec` with a read-only sandbox and a JSON output schema, renders the same Markdown
 *   artifact a Claude reviewer would have written, and prints one JSON line the orchestrator
 *   feeds into `sf-log spawn`. Warm continuation is `codex exec resume <thread_id>`. Writer seats
 *   (implement, fix) run instead over `codex app-server --stdio` (JSON-RPC) for liveness: an idle
 *   timer, a wrap-up steer, and an interrupt-then-report turn, so a seat that runs out of budget
 *   still delivers a schema-valid report for what it committed (`--transport exec` opts back out).
 *   Verbs: review, panel, implement, fix, home, seat-file, templates. Zero dependencies.
 * @domain workflow-review-backend
 *
 * Usage:
 *   sf-codex review --role <reviewer:name|plan-reviewer[:failure-over-time]> --template <round1|round2|regression|closure|clarify|plan-r1|plan-fot-r1|plan-rereview>
 *                   --cwd <worktree> --artifact <path-without-ext> --round <n> [--seat <name|path|none>]
 *                   [--change-ref <text>] [--range <a..b>] [--resume <thread_id>] [--ephemeral]
 *                   [--findings-table <json file>] [--prior-artifact <path>] [--prior-files <text>]
 *                   [--project-context <line>] [--plan <path> --requirements <path>] [--fix-summary <path>]
 *                   [--finding <id> --question <text>] [--timeout-min <n>] [--model <m>] [--effort <e>]
 *                   [--tier <name>] [--service-tier <t>] [--codex-home <dir>] [--keep-prompt] [--dry-run]
 *   sf-codex panel  --roster <route.json> | --seats <a,b,c>  --template <round1|regression|round2>
 *                   --cwd <worktree> --artifact-dir <dir> --round <n> [--pin <a,b>] [--range <a..b>]
 *                   [--change-ref <text>] [--project-context <line>] [--max-parallel <n>] [--started <epoch ms>]
 *                   [--phase <review|plan>] [plus any review flag, forwarded to every seat]
 *   sf-codex implement --tasks <file> --plan <p> --baseline <sha> --cwd <wt> --artifact <p> [--batch <id>]
 *                      [--explore <a.md,b.md>] [--write-sandbox yolo|workspace-write]
 *   sf-codex fix       --findings <file> --baseline <sha> --cwd <wt> --artifact <p> --round <n> [--role fixer|mopup-fixer]
 *   sf-codex home init [--run <id>] [--no-sandbox-probe] | home gc [--older-than <days>]
 *   sf-codex seat-file <name> [--cwd <dir>]
 *   sf-codex templates
 *
 * HYBRID_MODE=codex (review-backend.md §Hybrid mode) adds the implement / fix seats; Explore stays
 *   the host's built-in Claude agent.
 *   Writer seats (implement, fix) run over the `codex app-server` protocol with liveness — an idle
 *   timer, a wrap-up steer at wall − wrap-up, and a wall interrupt followed by a short report turn;
 *   `codex exec` remains the transport for the reviewer / closure / clarify / plan seats.
 *   Writers run --dangerously-bypass-approvals-and-sandbox by default (the worktree is the
 *   boundary; landlock cannot do workspace-write) or -s workspace-write via SF_CODEX_WRITE_SANDBOX.
 *   workspace-write is refused (exit 1, before any spawn) when the run home enables the landlock
 *   backend: there the exec tool panics before a command is recorded and the seat is silently blind.
 *   A writer's report is verified: every reported commit sha must exist in --baseline..HEAD.
 *
 * Exit codes (review): 0 delivered; 1 usage/config error (bad flag, missing seat file, renamed
 *   template heading — no result line; fix the call, never fall back); 2 codex could not deliver
 *   (auth, rate limit after retry, timeout, invalid JSON twice; result line status:"failed") → the
 *   orchestrator falls back to the Claude seat; 3 `--resume` could not continue the thread → the
 *   orchestrator runs the cold fallback template; 4 review-plan criteria unreadable → the
 *   orchestrator's plan-review-exhausted checkpoint (the Claude seat would lack them too).
 *   A seat none of whose shell commands succeeded (or that ran none) is BLIND — it never read
 *   the diff — and is reported as exit 2 / status:"blind", never as a verdict. `home init`
 *   probes the codex Linux sandbox and enables the landlock backend when bubblewrap cannot
 *   create user namespaces (devcontainers), so seats are not blind in the first place; when no
 *   backend starts at all, reader seats run unsandboxed in a disposable snapshot worktree at the
 *   reviewed commit and one that changes it exits 2 / status:"tampered" (readSandboxFor).
 *
 * Seat tiers: a cold seat's model/effort come from scripts/review-tiers.json (per seat and per
 *   template; review-backend.md §Seat tiers) unless --model/--effort/--service-tier/--tier say otherwise; a
 *   null tier value inherits the run home's config.toml. Each cold thread records what it was
 *   opened with in <CODEX_HOME>/sf-threads/<thread_id>.json and `--resume` re-applies exactly
 *   that (never the table, never the run home) — a thread is never re-tiered. The resolved
 *   `tier`, `model` and `effort` ride the result line and the ledger spawn event.
 *
 * Requires Node >= 18 and the `codex` CLI (>= 0.153) on PATH (the app-server JSON-RPC shapes the
 *   writer seats drive were verified on codex-cli 0.153.4).
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync,
  symlinkSync, copyFileSync, utimesSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginRoot as PLUGIN_ROOT, sharedDir as SHARED_DIR, schemaDir as SCHEMA_DIR, resolveRole } from './sf-resources.mjs';
import { roleError } from './sf-roles.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const SF_LOG = join(SCRIPT_DIR, 'sf-log.mjs');

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const DEFAULT_TIMEOUT_MIN = 40;
// Writer-seat (app-server) lifecycle budgets, in minutes. idle = longest legitimate single command
// (a scoped type-check + `vitest run --changed` runs 4–7 min here) must fit under it; wrap-up = the
// steer window before the wall; report = the post-interrupt report turn's own budget. All
// env-tunable (SF_CODEX_IDLE_MIN / _WRAPUP_MIN / _REPORT_MIN) without a code change.
const DEFAULT_IDLE_MIN = 10;
const DEFAULT_WRAPUP_MIN = 10;
const DEFAULT_REPORT_MIN = 5;
const TRANSPORTS = new Set(['exec', 'app-server']);
const DEFAULT_MAX_PARALLEL = 4;
const RATE_LIMIT_WAIT_SEC = process.env.SF_CODEX_RATE_LIMIT_WAIT_SEC !== undefined
  ? Number(process.env.SF_CODEX_RATE_LIMIT_WAIT_SEC) : 60;
// Per-seat model/effort tiers (review-backend.md §Seat tiers). SF_CODEX_TIERS swaps the whole
// table for an experiment; the checked-in file is the reviewed policy.
const TIERS_PATH = process.env.SF_CODEX_TIERS || join(SCRIPT_DIR, 'review-tiers.json');

// codex 0.151 model_reasoning_effort values (models_cache.json); a stray quote in a custom
// table would otherwise reach `-c` as malformed TOML with no local error.
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const checkEffort = (e, where) => { if (e && !EFFORTS.has(e)) die(`${where}: effort "${e}" is not one of ${[...EFFORTS].join(' ')}`); return e || null; };
// OpenAI/codex service_tier values (billing/priority). A per-seat tier may pin one (every
// checked-in tier pins `default`); a validated set catches a typo before it reaches `-c` as a value
// codex rejects only at the API with an opaque error — same guard as EFFORTS above.
const SERVICE_TIERS = new Set(['auto', 'default', 'flex', 'priority', 'scale']);
const checkServiceTier = (s, where) => { if (s && !SERVICE_TIERS.has(s)) die(`${where}: service_tier "${s}" is not one of ${[...SERVICE_TIERS].join(' ')}`); return s || null; };

function loadTiers() {
  let t;
  try { t = JSON.parse(readFileSync(TIERS_PATH, 'utf8')); } catch (e) { die(`cannot read seat tiers at ${TIERS_PATH}: ${e.message}`); }
  if (!t || !t.tiers || typeof t.tiers !== 'object' || !t.seats || typeof t.seats !== 'object') die(`${TIERS_PATH}: expected {tiers:{…}, seats:{…}, templates?:{…}}`);
  return t;
}

/** Validate a --tier name against the table (panel calls this BEFORE fanning out, so a typo is
 *  a usage error and never "every seat failed → fall back to Claude"). */
function checkTierName(name) {
  const t = loadTiers();
  if (!t.tiers[name]) die(`unknown seat tier "${name}" — ${TIERS_PATH} defines: ${Object.keys(t.tiers).join(', ')}`);
  return t.tiers[name];
}

/** Per-thread sidecar: the model/effort/tier a thread was opened with, so a warm continuation
 *  re-applies them explicitly (`codex exec resume` accepts -m / -c) and reports them, instead of
 *  trusting either the run home or codex's own persistence. */
/** A thread id reaches us from the server (`thread/start`) and the exec event stream and is then
 *  used as a bare filename (sidecar, rollout match). Reject anything that is not a filename token
 *  so a `/`-bearing or traversal id cannot read or write outside sf-threads/ / the sessions tree. */
function safeThreadId(threadId) { return typeof threadId === 'string' && /^[A-Za-z0-9._-]+$/.test(threadId); }
function sidecarPath(codexHome, threadId) {
  if (!codexHome || !threadId) return null;
  if (!safeThreadId(threadId)) { warn(`refusing thread id as a filename: ${JSON.stringify(threadId)}`); return null; }
  return join(codexHome, 'sf-threads', `${threadId}.json`);
}
function readSidecar(codexHome, threadId) {
  const p = sidecarPath(codexHome, threadId);
  if (!p || !existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function writeSidecar(codexHome, threadId, data) {
  const p = sidecarPath(codexHome, threadId);
  if (!p) return;
  try { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `${JSON.stringify(data)}\n`); } catch (e) { warn(`could not record thread tier: ${e.message}`); }
}

/** Which model/effort a seat runs at. Cold: explicit --model/--effort > --tier >
 *  templates[template] > seats[seat] > seats['*'] (the table is not even read on a resume).
 *  Warm (--resume): the thread's own sidecar — re-tiering mid-thread would make closure
 *  verdicts incomparable with the finding; a thread without a sidecar (opened by an older
 *  sf-codex) runs whatever codex resumes it with, reported as model "thread". */
function resolveTier(flags, spec, codexHome) {
  const explicit = { model: flags.model || null, effort: checkEffort(flags.effort, '--effort'), serviceTier: checkServiceTier(flags['service-tier'], '--service-tier') };
  if (flags.resume) {
    const side = readSidecar(codexHome, flags.resume);
    return { name: 'thread', model: explicit.model || side?.model || null, effort: explicit.effort || side?.effort || null, serviceTier: explicit.serviceTier || side?.service_tier || null, opened_as: side?.tier || null };
  }
  if (explicit.model || explicit.effort || explicit.serviceTier) return { name: 'explicit', ...explicit };
  const t = loadTiers();
  const seat = spec.kind === 'plan' ? (spec.seat ?? 'plan-reviewer') : roleName(flags.role || '');
  const name = flags.tier || t.templates?.[flags.template] || t.seats?.[seat] || t.seats?.['*'];
  if (!name) die(`${TIERS_PATH}: no tier for seat "${seat}" and no seats['*'] default`);
  const tier = t.tiers[name];
  if (!tier) die(`unknown seat tier "${name}" — ${TIERS_PATH} defines: ${Object.keys(t.tiers).join(', ')}`);
  // A null service_tier inherits the run home's config.toml (the user's own default); only a
  // tier that pins one (every checked-in tier pins `default`) overrides it with -c.
  return { name, model: tier.model || null, effort: checkEffort(tier.effort, `${TIERS_PATH} tier "${name}"`), serviceTier: checkServiceTier(tier.service_tier, `${TIERS_PATH} tier "${name}"`) };
}

// =============================================================================
// Template registry — every seat reads the SAME template text a Claude seat gets
// (reviewer-prompts.md / plan-prompts.md), located by section heading; only the
// delivery paragraphs are replaced by the JSON contract.
// =============================================================================
// Baseline seats with no agent file of their own: the template section is the whole brief.
const BARE_TEMPLATE_SEATS = new Set(['architecture', 'performance', 'failure-over-time']);

const TEMPLATES = {
  round1: {
    file: 'reviewer-prompts.md',
    heading: 'Domain reviewer — Round 1',
    baselines: {
      security: 'Baseline reviewer 1 — security',
      architecture: 'Baseline reviewer 2 — architecture',
      performance: 'Baseline reviewer 3 — performance',
      'failure-over-time': 'Baseline reviewer 4 — failure over time',
    },
    kind: 'review',
    schema: 'review-findings.schema.json',
  },
  round2: { file: 'reviewer-prompts.md', heading: 'Domain reviewer — Round 2+', kind: 'review', schema: 'review-findings.schema.json' },
  regression: { file: 'reviewer-prompts.md', heading: 'Regression pass — cold', kind: 'review', schema: 'review-findings.schema.json' },
  closure: {
    file: 'reviewer-prompts.md',
    heading: 'Closure verification — warm continuation',
    kind: 'closure',
    schema: 'review-closure.schema.json',
    cutFrom: /^Write your closure table to/,
    resumeOnly: true,
  },
  clarify: {
    file: 'reviewer-prompts.md',
    heading: 'Pre-fix clarification — warm continuation',
    kind: 'clarify',
    schema: 'review-closure.schema.json',
    cutFrom: /^Reply with ONE paragraph/,
    resumeOnly: true,
  },
  implement: { file: 'writer-prompts.md', heading: 'Implementer seat', kind: 'implement', schema: 'implement-report.schema.json', write: true },
  fix: { file: 'reviewer-prompts.md', heading: 'Fixer prompt', kind: 'implement', schema: 'implement-report.schema.json', write: true },
  'plan-r1': {
    file: 'plan-prompts.md',
    heading: 'Round 1 — `sf-plan-reviewer`',
    kind: 'plan',
    schema: 'plan-review.schema.json',
    cutFrom: /^Write the structured output exactly/,
  },
  // Plan-stage failure-over-time seat; tiered as its own seat, rendered like plan-r1.
  'plan-fot-r1': {
    file: 'plan-prompts.md',
    heading: 'Round 1 — plan failure-over-time seat',
    kind: 'plan',
    seat: 'plan-failure-over-time',
    schema: 'plan-review.schema.json',
    cutFrom: /^Write the structured output exactly/,
  },
  'plan-rereview': {
    file: 'plan-prompts.md',
    heading: 'Rounds ≥ 2 — targeted re-review, warm',
    kind: 'plan',
    schema: 'plan-review.schema.json',
    cutFrom: /^Write the structured output \(same format/,
  },
};

const JSON_CONTRACTS = {
  review: `OUTPUT CONTRACT (Codex seat — replaces any output format your role definition names):
Do NOT write any files. Your FINAL message must be ONLY a JSON object matching the
schema you were given — no prose before or after it, no code fences.
- Severity levels: CRITICAL, HIGH, MEDIUM, LOW. Give every finding a stable id
  (\`<ROLE>-<n>\`, e.g. SEC-1).
- verdict is FAIL if ANY CRITICAL or HIGH finding exists, else PASS.
- what / wrong / impact / recommendation are the four fields of a finding. A
  recommendation is held to the same evidence bar as the finding: recommendation_cite
  must be the exact live file:line the change applies to — code you opened and
  confirmed is reached (not commented out, feature-flagged off, or marked DISABLED),
  live_code_verified true. If you cannot cite live code, set recommendation_cite to
  null, live_code_verified false, and state the problem without prescribing the fix.
- Prose budget scales with severity: CRITICAL and HIGH get complete fields; a MEDIUM
  gets one short paragraph across the four fields; a LOW gets one clause per field —
  LOWs reach the fixer too, so the recommendation clause is held to the same bar.
- clean_areas: at most one short line per area you checked and found clean — never a
  narrated section. deferred_to_domain: one line each naming the domain reviewer a
  finding belongs to; do not develop another reviewer's finding.
- probes_suggested: any mutation probe you WOULD have run (exact edit + expected
  outcome). You are read-only; never run it.
- confidence: your probability (0–1) that the defect is real as stated. Severity is a
  claim about consequence, confidence about evidence — do not trade one for the other;
  below 0.5, prefer reporting the item as an area to check rather than a finding.
- No preamble, no restating the diff, no praise. A file:line reference beats a quoted
  code block.`,
  closure: `OUTPUT CONTRACT (Codex seat):
Do NOT write any files. Your FINAL message must be ONLY a JSON object matching the
schema you were given — no prose, no code fences. One entry in \`closures\` per finding
in the table above, using its exact id, with verdict CLOSED | REOPENED |
DECLINE-ACCEPTED | NOT-MINE, the file:line evidence, and a one-sentence reason. Put a
CRITICAL/HIGH defect in the fix commits themselves under \`new_fix_introduced\` (that
heading is the only new finding a closure may raise). \`answer\` is the empty string.
If you no longer hold the analysis that produced a finding (context loss), its verdict
is REOPENED with the reason "original analysis not held" — never reconstruct a verdict
from the fix diff alone.`,
  clarify: `OUTPUT CONTRACT (Codex seat):
Do NOT write any files. Your FINAL message must be ONLY a JSON object matching the
schema you were given — \`closures\` and \`new_fix_introduced\` empty, \`answer\` = one
paragraph.`,
  plan: `OUTPUT CONTRACT (Codex seat — replaces the Step 4 Markdown layout in the criteria file):
Do NOT write any files. Your FINAL message must be ONLY a JSON object matching the
schema you were given — no prose, no code fences. The orchestrator renders it into the
criteria file's Step 4 layout, so fill the same fields: for each finding a stable id
(P-<n>, kept stable across rounds), severity per the rubric, the dimension (3.1–3.11),
plan_says / problem / impact / evidence / recommendation; set \`unverified\` true when
the recommendation could not be verified against live code or vendor evidence and say
in the recommendation which exact check would settle it. overall_risk = the highest
finding severity (NONE if no findings). verdict per the criteria file: "Stop and
redesign" when any CRITICAL, "Proceed as-is" only when findings are LOW-only or
absent, else "Proceed with modifications". clean_dimensions: one entry per dimension
with no findings ("3.4 — Security Implications"). open_questions: questions the plan
does not answer that must be resolved before implementation (empty if none).
Prose budget scales with severity: CRITICAL/HIGH complete; MEDIUM one short
paragraph across the fields; LOW one clause per field. No praise, no restating the
plan.`,
};

JSON_CONTRACTS.implement = `OUTPUT CONTRACT (Codex writer seat):
Do the work in the working tree and commit locally. Your FINAL message must be ONLY a
JSON object matching the schema you were given — no prose before or after it, no code
fences. commits: every commit you created (sha as printed by git, subject, task_id where
the task had one) — the orchestrator verifies each sha exists in the worktree; a commit
you did not make fails the seat. acceptance: one row per acceptance criterion assigned to
this work, status PASS / FAIL / DEFERRED / NOT_VERIFIED with the exact command or check
and its outcome in "how". plan_gaps: every decision the plan (or the findings) did not
specify, kind "semantic" when it changed behaviour or an interface, "cosmetic" otherwise.
declined: (fix seats) findings you declined, each with one line of evidence.
verify_first: (fix seats) one row per probe the FIX DIRECTION asked you to run before
editing — finding id, the exact probe, its outcome, contradicts_approach true when the
outcome invalidated the planned approach (then that finding is reported, not improvised).
Empty when the direction asked for none. scope_violations: files you were told to leave alone but the work required editing —
report them, do not edit them. blockers: anything that made a task or finding
unactionable (missing code, dead path, a decision only the operator can make). Empty is
the normal answer for both.`;

// The wrap-up steer (advisory) and the post-interrupt report prompt for app-server writer seats.
// The report is still a claim — the writer branch keeps git as the source of truth for commits.
const WRAPUP_STEER = (wrapupMin) => `WRAP UP NOW — the orchestrator's time budget for this seat ends in about ${wrapupMin} minutes.
Stop starting new tasks. Finish or revert the edit you are in the middle of, run the scoped gates
for what is complete, commit what is gate-green, leave nothing uncommitted, and then send your
final JSON report (schema unchanged) listing the commits you made and every task you did not
finish as acceptance status DEFERRED with the reason "wrap-up".`;
const REPORT_PROMPT = (reason, baseline) => `Your turn was interrupted by the orchestrator (${reason} timeout). Do NOT start or
continue any work and do NOT run any command other than \`git status --porcelain\` and
\`git log --oneline ${baseline}..HEAD\`. Reply with ONLY the JSON report (same schema): commits =
exactly the shas \`git log\` shows in that range; every task or finding not fully committed is
acceptance status DEFERRED with reason "interrupted"; scope_violations/blockers as they stand.`;

// =============================================================================
// CLI plumbing
// =============================================================================
/** Usage / configuration error: exit 1, no result line. Never a per-seat fallback signal. */
function die(msg, code = 1) {
  process.stderr.write(`sf-codex: ${msg}\n`);
  process.exit(code);
}

function numFlag(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  const n = Number(flags[name]);
  if (!Number.isFinite(n) || n <= 0) die(`--${name} must be a positive number (got ${JSON.stringify(flags[name])})`);
  return n;
}
const warn = (msg) => process.stderr.write(`sf-codex: warning: ${msg}\n`);

/** A positive finite number from an env var, validated like numFlag; the fallback when unset/empty. */
function envNum(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) die(`${name} must be a positive number (got ${JSON.stringify(v)})`);
  return n;
}

/** Which transport a seat runs on: --transport flag > SF_CODEX_WRITER_TRANSPORT (writers only) >
 *  default (app-server for writer seats, exec for everything else). A non-writer on app-server is a
 *  usage error — only writer seats (implement, fix) have the live lifecycle this transport adds;
 *  reviewer/closure/clarify/plan seats stay on exec in this version (design constraint f). */
function transportFor(flags, spec) {
  const t = flags.transport || (spec.write ? process.env.SF_CODEX_WRITER_TRANSPORT : null) || (spec.write ? 'app-server' : 'exec');
  if (!TRANSPORTS.has(t)) die(`--transport must be one of ${[...TRANSPORTS].join(', ')} (got ${JSON.stringify(t)})`);
  if (t === 'app-server' && !spec.write) die(`--transport app-server is for writer seats only (implement, fix) — ${flags.template || 'this template'} stays on exec`);
  return t;
}

/** Writer-seat time budgets in milliseconds from --timeout-min (wall, default 40) and the idle /
 *  wrap-up / report knobs (flag > SF_CODEX_* env > default). Fractional minutes are valid — that is
 *  how tests scale these timers down to milliseconds. When wrap-up ≥ wall the steer point would be
 *  at or before the turn starts, so no steer fires (the wall interrupt still does): warn, never die,
 *  so an explicit short --timeout-min stays as valid as it is on the exec path. */
function writerBudgets(flags) {
  const wallMin = numFlag(flags, 'timeout-min', DEFAULT_TIMEOUT_MIN);
  const idleMin = numFlag(flags, 'idle-min', envNum('SF_CODEX_IDLE_MIN', DEFAULT_IDLE_MIN));
  const wrapupMin = numFlag(flags, 'wrapup-min', envNum('SF_CODEX_WRAPUP_MIN', DEFAULT_WRAPUP_MIN));
  const reportMin = numFlag(flags, 'report-min', envNum('SF_CODEX_REPORT_MIN', DEFAULT_REPORT_MIN));
  if (wrapupMin >= wallMin) warn(`--wrapup-min ${wrapupMin} ≥ --timeout-min ${wallMin}: no wrap-up steer will fire (the wall interrupt still does)`);
  return { wallMs: wallMin * 60000, idleMs: idleMin * 60000, wrapupMs: wrapupMin * 60000, reportMs: reportMin * 60000 };
}

const BOOL_FLAGS = new Set(['ephemeral', 'keep-prompt', 'dry-run', 'help', 'compact', 'no-log', 'routed-only']);

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { flags.help = true; continue; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    const eq = key.indexOf('=');
    if (eq !== -1) { flags[key.slice(0, eq)] = key.slice(eq + 1); continue; }
    if (BOOL_FLAGS.has(key)) { flags[key] = true; continue; }
    const next = args[i + 1];
    if (next === undefined || (next.startsWith('--') && next.length > 2)) die(`--${key} requires a value`);
    flags[key] = args[++i];
  }
  return { flags, positional };
}

const HELP = `sf-codex — headless Codex review seats for the shipflow ship-* skills

  sf-codex review --role <reviewer:name|plan-reviewer[:failure-over-time]> --template <name> --cwd <worktree>
                  --artifact <path-without-ext> --round <n> [--seat <name|path|none>]
                  [--decisions <adjudication.md>] [--epic-phase <id>] ...
                  (--decisions splices the file's "## Accepted" lines into a closure prompt as facts)
  sf-codex panel  (--roster <route.json> | --seats <a,b,c>) --template <name> --cwd <worktree>
                  --artifact-dir <dir> --round <n> [--pin <a,b>] [--max-parallel <n>] ...
  sf-codex implement --tasks <file> --plan <path> --baseline <sha> --cwd <worktree>
                     --artifact <path-without-ext> [--batch <id>] [--explore <a.md,b.md>]
                     [--write-sandbox yolo|workspace-write] [--transport app-server|exec]
                     [--idle-min <n>] [--wrapup-min <n>] [--report-min <n>]                 (sole writer)
  sf-codex fix       --findings <file> --baseline <sha> --cwd <worktree> --artifact <path> --round <n>
                     [--direction <file>] [--merged-items <n>] [--finding-ids '[…]'] [--epic-phase <id>]
                     [--role fixer|mopup-fixer] [--write-sandbox yolo|workspace-write]
                     [--transport app-server|exec] [--idle-min <n>] [--wrapup-min <n>] [--report-min <n>]  (sole writer)
  sf-codex home init [--run <id>] | home gc [--older-than <days>]
  sf-codex seat-file <name> [--cwd <dir>]
  sf-codex templates

  Common flags (every command that logs a ledger row): [--epic-phase <id>]

Templates: ${Object.keys(TEMPLATES).join(' ')}
Contract, placeholders, and fallback rules: skills/shared/review-backend.md
`;

function nowMs() { return Date.now(); }

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { die(`cannot read JSON ${path}: ${e.message}`); }
}

// =============================================================================
// Minimal JSON-schema validator (draft-2020 subset our schemas use)
// =============================================================================
function validate(value, schema, path = '$') {
  const errors = [];
  const add = (m) => errors.push(`${path}: ${m}`);
  if (schema.anyOf) {
    if (!schema.anyOf.some((s) => validate(value, s, path).length === 0)) add(`matches none of ${schema.anyOf.length} alternatives`);
    return errors;
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((s) => validate(value, s, path).length === 0);
    if (matches.length !== 1) add(`expected exactly one of ${schema.oneOf.length} alternatives to match (${matches.length} did)`);
    return errors;
  }
  if (schema.type) {
    // `type` may be an array (`["string","null"]`) — how OpenAI strict structured outputs express
    // an optional field, since every declared property must be listed in `required`.
    const t = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const wants = types.map((x) => (x === 'integer' ? 'number' : x));
    if (!wants.includes(t)) { add(`expected ${types.join('|')}, got ${t}`); return errors; }
    if (types.includes('integer') && t === 'number' && !Number.isInteger(value)) add('expected integer');
  }
  if (schema.enum && !schema.enum.includes(value)) add(`expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) add(`shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) add(`does not match /${schema.pattern}/`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add(`below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add(`above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errors.push(...validate(v, schema.items, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) add(`missing required "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub) errors.push(...validate(v, sub, `${path}.${k}`));
      else if (schema.additionalProperties === false) add(`unexpected property "${k}"`);
    }
  }
  return errors;
}

// =============================================================================
// Templates and prompt assembly
// =============================================================================
/** The first fenced block under the `## <heading…>` section of a shared prompt file. */
function loadTemplate(file, headingPrefix) {
  const path = join(SHARED_DIR, file);
  if (!existsSync(path)) throw new Error(`template source missing: ${path}`);
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).trim().startsWith(headingPrefix));
  if (start === -1) throw new Error(`template heading not found in ${file}: "## ${headingPrefix}"`);
  let i = start + 1;
  while (i < lines.length && !lines[i].startsWith('```')) {
    if (lines[i].startsWith('## ')) throw new Error(`no fenced template under "## ${headingPrefix}" in ${file}`);
    i++;
  }
  if (i >= lines.length) throw new Error(`no fenced template under "## ${headingPrefix}" in ${file}`);
  const body = [];
  for (i += 1; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
  return body.join('\n').trim();
}

/** Drop ONLY the "If you NO LONGER hold … reply with exactly NOT-CONTINUABLE and write …"
 *  signalling clause — a schema'd seat cannot reply with a bare token; resume failure is the
 *  CLI-level equivalent (exit 3). Any rule that follows it in the same sentence (e.g. "do not
 *  attempt verification from the fix diff alone") is kept, rejoined to the sentence start. */
function stripNotContinuable(text) {
  const start = text.indexOf('If you NO LONGER hold');
  if (start === -1) return text;
  const marker = text.indexOf('NOT-CONTINUABLE', start);
  if (marker === -1) return text;
  const stop = text.indexOf('.', marker);
  if (stop === -1) return text;
  // The clause after "NOT-CONTINUABLE" up to the period: "and write no artifact — do not …"
  const tail = text.slice(marker + 'NOT-CONTINUABLE'.length, stop);
  const dash = tail.indexOf('—');
  const keptRule = dash === -1 ? '' : tail.slice(dash + 1).replace(/\s+/g, ' ').trim();
  let before = text.slice(0, start).replace(/[ \t]+$/, '');
  const after = text.slice(stop + 1).replace(/^[ \t]+/, '');
  const replacement = keptRule ? `If you no longer hold your original analysis, ${keptRule}.` : '';
  if (replacement && before && !/\s$/.test(before)) before += ' ';
  return `${before}${replacement}${after}`.replace(/\n{3,}/g, '\n\n');
}

function cutFrom(text, re) {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => re.test(l));
  if (idx === -1) throw new Error(`template cut marker ${re} not found — reviewer-prompts.md / plan-prompts.md changed shape; update sf-codex.mjs TEMPLATES`);
  return lines.slice(0, idx).join('\n').trimEnd();
}

/** A closure findings table is a bare JSON array; a wrapped `{findings|rows|table: [...]}` is
 *  accepted too. */
function findingsTableOf(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object') for (const k of ['findings', 'rows', 'table']) if (Array.isArray(x[k])) return x[k];
  return x;
}

function fill(text, vars) {
  let out = text;
  for (const [k, v] of Object.entries(vars)) out = out.split(k).join(v);
  return out;
}

/** Parse an adjudication file (ship-task 3e step 3.5). Returns `content` — the non-blank
 *  lines under `## Accepted` up to the next `## ` heading, spliced verbatim into the closure
 *  prompt (`$&`-safe via the literal `fill`) — plus `hasAnyHeading` (has a `## Accepted` or
 *  `## Redirected` section at all) so the caller can tell an all-redirected file (empty
 *  `## Accepted`) from a file that is not an adjudication file (neither heading). */
function acceptedSection(text) {
  const out = [];
  let inSection = false;
  let hasAnyHeading = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^##\s/.test(line)) {
      if (/^##\s+(Accepted|Redirected)\b/i.test(line)) hasAnyHeading = true;
      inSection = /^##\s+Accepted\b/i.test(line);
      continue;
    }
    if (inSection && line.trim()) out.push(line);
  }
  return { content: out.join('\n'), hasAnyHeading };
}

function gitFiles(cwd, range) {
  try {
    return execFileSync('git', ['diff', '--name-only', range], { cwd, encoding: 'utf8' }).trim();
  } catch (e) {
    die(`git diff --name-only ${range} failed in ${cwd}: ${e.stderr || e.message}`);
  }
}

function resolveSeatFile(spec, cwd) {
  return resolveRole(spec, { cwd });
}

function seatBody(path) {
  let text = readFileSync(path, 'utf8');
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) text = text.slice(end + 4);
  }
  return text.trim();
}

function roleName(role) {
  return role.startsWith('reviewer:') ? role.slice('reviewer:'.length) : role;
}

/** Assemble the full prompt for one seat. Returns {prompt, spec}. */
function buildPrompt(flags, { snapshot = null } = {}) {
  const template = flags.template;
  const spec = TEMPLATES[template];
  if (!spec) die(`unknown --template ${template}; one of ${Object.keys(TEMPLATES).join(', ')}`);
  const cwd = flags.cwd ? resolve(flags.cwd) : null;
  if (!cwd) die('--cwd <worktree> is required');
  const role = flags.role;
  if (!role) die('--role is required');
  // sf-log refuses a drifted role on the seat's ledger row; refuse it here, before the seat runs.
  const roleBad = roleError(role, flags.phase || (template === 'fix' ? 'fix' : null));
  if (roleBad) die(`--role: ${roleBad}`);
  const name = roleName(role);
  const round = flags.round ?? '1';

  let body;
  if (template === 'round1' && spec.baselines[name]) {
    body = loadTemplate(spec.file, spec.baselines[name]);
  } else {
    body = loadTemplate(spec.file, spec.heading);
  }
  if (spec.cutFrom) body = cutFrom(body, spec.cutFrom);
  body = stripNotContinuable(body);
  // The pristine template text: the placeholder scan below runs on THIS, never on the body
  // after a findings bucket / tasks file was spliced in — a JSX `{false}` or `{n}` inside a
  // reviewer's code excerpt would otherwise trip the scan.
  const templateText = body;

  const worktreeContract = spec.write
    ? `Working tree: ${cwd}. You are the SOLE writer of this working tree: edit and commit only inside it, never push, never modify files under .claude/ or CLAUDE.md, never touch another worktree or the launch checkout. Every test you run names its files or uses the runner's changed-files mode (vitest run <files> / --changed <sha>); NEVER launch a whole test project or directory — a whole-project browser run is unbounded here (it hangs at dependency optimisation or runs property suites for hours), and a seat that starts one burns its timeout and has its half-work discarded. If a task text tells you to run one, run the task's named files instead and report the substitution. Your final message is a machine-consumed report.`
    : snapshot
      ? `Working tree: ${snapshot.dir}. It is a disposable snapshot of ${cwd} at commit ${snapshot.sha}, the commit under review. Run every command there; read other absolute paths this task names as given. You are read-only: never modify, create, or delete files anywhere — a snapshot that changes discards your review. Your deliverable is your final message.`
      : `Working tree: ${cwd}. Operate only under it. You are read-only: never modify, create, or delete files — your deliverable is your final message.`;
  const vars = {
    '<worktree contract>': worktreeContract,
    '<worktree path>': snapshot ? snapshot.dir : cwd,
    '<output contract>': JSON_CONTRACTS[spec.kind],
    '${CLAUDE_PLUGIN_ROOT}/skills/shared/': `${SHARED_DIR}/`,
    '${CLAUDE_PLUGIN_ROOT}': PLUGIN_ROOT,
    'skills/shared/scope-policy.md': join(SHARED_DIR, 'scope-policy.md'),
  };

  if (spec.kind === 'review') {
    const range = flags.range;
    if (!range) die(`--range <a..b> is required for --template ${template}`);
    if (template === 'round2' && !flags['prior-artifact']) die('--prior-artifact <previous round .md> is required for --template round2 — its first instruction is to read it');
    const projectLine = flags['project-context'] ? flags['project-context'] : '';
    Object.assign(vars, {
      '{change_ref}': flags['change-ref'] || `the change in ${basename(cwd)}`,
      '{list from git diff --name-only over {diff_range}}': gitFiles(cwd, range) || '(none)',
      '{diff_range}': range,
      '{fix_commit_range}': range,
      '{project_context_line}\n': projectLine ? `${projectLine}\n` : '',
      '{project_context_line}': projectLine,
      '{prior_files_list}': flags['prior-files'] || '(none)',
      '{prior_artifact_path}': flags['prior-artifact'] || '(not provided)',
      '{fix_round}': String(round),
    });
  } else if (spec.kind === 'closure') {
    if (!flags.range) die('--range <fix commit range> is required for --template closure');
    const table = flags['findings-table'] ? findingsTableOf(readJson(flags['findings-table'])) : null;
    if (!Array.isArray(table) || table.length === 0) die('--findings-table <json array, or an object wrapping one under findings/rows/table> is required for --template closure');
    const rows = table.map((f) => {
      if (f.status === 'declined') return `${f.id} — ${f.summary} — DECLINED: ${f.evidence || '(no evidence given)'}`;
      return `${f.id} — ${f.summary} — claimed fixed by ${f.commits || '(commits not listed)'}`;
    });
    // Accepted design decisions travel to the closure reviewer as facts (ship-task 3e step 3.5).
    // Filled through `fill` (a literal split/join, not a regex splice), so a `$&` in a decision
    // line is inert. Three states, so an all-redirected round is never mislabelled as "no
    // decisions": no --decisions → the round had no semantic gaps; a file with neither section
    // is not an adjudication file (die); a present-but-empty `## Accepted` → every decision was
    // redirected and fixed by the addendum.
    let accepted;
    if (!flags.decisions) {
      accepted = '(none — the fixer reported no semantic decisions this round)';
    } else {
      const decPath = resolve(flags.decisions);
      if (!existsSync(decPath)) die(`--decisions: file not found: ${decPath}`);
      const parsed = acceptedSection(readFileSync(decPath, 'utf8'));
      if (!parsed.hasAnyHeading) {
        die(`--decisions file has neither a "## Accepted" nor a "## Redirected" section — not an adjudication file: ${decPath}`);
      }
      accepted = parsed.content || '(none accepted — every decision this round was redirected and fixed by the addendum)';
    }
    Object.assign(vars, {
      '{findings_table}': rows.join('\n'),
      '{fix_commit_range}': flags.range,
      '{accepted_decisions}': accepted,
    });
  } else if (spec.kind === 'clarify') {
    if (!flags.finding || !flags.question) die('--finding <id> and --question <text> are required for --template clarify');
    Object.assign(vars, { '{finding_id}': flags.finding, '{question}': flags.question });
  } else if (spec.kind === 'implement') {
    if (!flags.baseline) die(`--baseline <sha> (HEAD before this seat runs) is required for --template ${template} — reported commits are verified against it`);
    // Resolve to a full sha NOW: a symbolic --baseline (HEAD) would re-resolve after the seat
    // commits and make every reported commit "not found".
    const full = gitRevParse(cwd, `${flags.baseline}^{commit}`);
    if (!full) die(`--baseline ${flags.baseline} is not a commit in ${cwd}`);
    if (!gitIsAncestor(cwd, full)) warn(`--baseline ${full.slice(0, 9)} is not an ancestor of HEAD in ${cwd} — the commit range will be empty or wrong`);
    flags.baseline = full;
    if (template === 'implement') {
      if (!flags.tasks) die('--tasks <file with the verbatim task text> is required for --template implement');
      if (!flags.plan) die('--plan <path> is required for --template implement');
      const reports = (flags.explore || '').split(',').map((x) => x.trim()).filter(Boolean);
      Object.assign(vars, {
        '{change_ref}': flags['change-ref'] || `the change in ${basename(cwd)}`,
        '{batch_id}': String(flags.batch || 'b1'),
        '{plan_path}': resolve(flags.plan),
        '{tasks}': readFileSync(resolve(flags.tasks), 'utf8').trim(),
        '{explore_reports}': reports.length ? reports.map((r) => `- ${resolve(r)}`).join('\n') : '(none — explore as the plan requires, minimally)',
      });
    } else {
      if (!flags.findings) die('--findings <file with the bucket-1 findings, grouped by file> is required for --template fix');
      const findings = readFileSync(resolve(flags.findings), 'utf8').trim();
      // The fixer template's two prose placeholders are multi-line angle-bracket lines. Function
      // replacers: a bucket containing `$'` or `$&` must land literally, never as a pattern.
      body = body.replace(/<worktree contract \+ branch authorizations>/, () => '<worktree contract>');
      body = body.replace(/<bucket-1 findings[\s\S]*?finding>/, () => findings);
      // Fix direction (review-backend.md §Fix direction): written by the ORCHESTRATOR at triage
      // when the bucket is design-shaped; binding on the seat. Absent → the seat designs under
      // the hypotheses rule alone (the pre-0.23 behavior), and the prompt says so.
      const direction = flags.direction
        ? readFileSync(resolve(flags.direction), 'utf8').trim()
        : '(none provided — no binding direction this round; verify every recommendation against live code and stored data shapes before applying it)';
      body = body.replace(/<fix direction>/, () => direction);
      body = body.replace(/\[fix round <N> /g, () => `[fix round ${round} `);
      if (/<bucket-1 findings|branch authorizations>|<fix direction>|<N>/.test(body)) die('reviewer-prompts.md §Fixer prompt changed shape (its <worktree contract + branch authorizations> / <bucket-1 findings …finding> / <fix direction> / [fix round <N> …] placeholders); update sf-codex.mjs');
    }
  } else if (spec.kind === 'plan') {
    const plan = flags.plan;
    if (!plan) die('--plan <path> is required for plan templates');
    const artifactDir = dirname(resolve(flags.artifact || plan));
    vars['<repo root>'] = cwd;
    if (template !== 'plan-rereview') {
      if (!flags.requirements) die(`--requirements <path> is required for --template ${template}`);
      Object.assign(vars, {
        'Plan file: <absolute path>': `Plan file: ${resolve(plan)}`,
        'Requirements file: <absolute path>': `Requirements file: ${resolve(flags.requirements)}`,
      });
    } else {
      const prev = Number(round) - 1;
      Object.assign(vars, {
        '<round>': String(round),
        '<$ARTIFACT_DIR/plan-review-r<round-1>.md>': flags['prior-artifact'] || join(artifactDir, `plan-review-r${prev}.md`),
        '<$ARTIFACT_DIR/plan-fix-r<round-1>.md>': flags['fix-summary'] || join(artifactDir, `plan-fix-r${prev}.md`),
      });
      body = `Plan file: ${resolve(plan)}\n\n${body}`;
    }
    if (!flags.resume) body = `${worktreeContract}\n\n${body}`;
    for (const p of [join(PLUGIN_ROOT, 'skills', 'review-plan', 'SKILL.md'), join(PLUGIN_ROOT, 'skills', 'review-plan', 'scoring-rubric.md')]) {
      // exit 4: the orchestrator's plan-review-exhausted checkpoint, never a Claude fallback
      if (!existsSync(p)) die(`review criteria unavailable: ${p}`, 4);
    }
  }

  // Placeholders are checked on the TEMPLATE, never on the filled text: a tasks file or
  // findings bucket legitimately contains `${id}`-style code, which is not a placeholder.
  const needed = [...new Set(templateText.match(/\{[a-z_]+\}|<N>/g) || [])].filter((k) => k !== '<N>' || /<N>/.test(body));
  const missing = needed.filter((k) => !(k in vars) && !(`${k}\n` in vars));
  if (missing.length) die(`unfilled placeholders in template ${template}: ${missing.join(' ')}`);
  let filled = fill(body, vars);

  const parts = [];
  // Default seat: the role's own agent file, except the bare-template baselines
  // (architecture, performance, failure-over-time) which have none — exactly as the Claude spawns.
  const WRITER_SEATS = { implementer: 'sf-implementer', fixer: 'sf-fixer', 'mopup-fixer': 'sf-fixer' };
  const defaultSeat = spec.kind === 'plan' || BARE_TEMPLATE_SEATS.has(name) ? 'none' : (WRITER_SEATS[name] ?? name);
  // A resumed thread already holds its role definition — re-sending it would only pay the
  // tokens again and invite the model to restart from the role text; so it is not even resolved.
  const seatFile = flags.resume ? null : resolveSeatFile(flags.seat ?? defaultSeat, cwd);
  if (seatFile === undefined) die(`seat file not found for "${flags.seat ?? name}" (searched ${seatSearchDirs(cwd).join(', ')}); pass --seat <path> or --seat none`);
  if (seatFile) {
    const what = spec.kind === 'implement' ? 'writer seat of an automated delivery pipeline' : 'reviewer seat of an automated review panel';
    parts.push(`You are the \`${basename(seatFile, '.md')}\` ${what}. Your role definition follows; the task follows after the line "=== TASK ===". Where the role definition names an output format or an artifact file, the OUTPUT CONTRACT at the end of the task wins.\n\n${seatBody(seatFile)}\n\n=== TASK ===`);
  }
  parts.push(filled);
  if (spec.kind === 'plan') parts.push(JSON_CONTRACTS.plan);
  else if (spec.kind === 'closure') parts.push(JSON_CONTRACTS.closure);
  else if (spec.kind === 'clarify') parts.push(JSON_CONTRACTS.clarify);
  else if (spec.kind === 'implement') parts.push(JSON_CONTRACTS.implement);
  // review templates carry <output contract> inline, already filled.
  return { prompt: parts.join('\n\n'), spec, seatFile, cwd, name };
}

// =============================================================================
// Codex runtime
// =============================================================================
/** The per-run CODEX_HOME. Explicit flag/env first; otherwise DERIVED from RUN_LOG — Stage 0's
 *  `export SF_CODEX_HOME=…` does not survive across Bash tool calls, and a seat that silently
 *  falls back to ~/.codex loses the landlock flag and goes blind (`bwrap: No permissions to
 *  create a new namespace`). */
function codexHomeFor(flags) {
  const h = flags['codex-home'] || process.env.SF_CODEX_HOME || '';
  if (h) return resolve(h);
  if (process.env.RUN_LOG) {
    const derived = join(homedir(), '.cache', 'sf-codex', basename(process.env.RUN_LOG, '.jsonl'));
    if (existsSync(join(derived, 'config.toml'))) return derived;
    warn(`no SF_CODEX_HOME and no run home at ${derived} — run \`sf-codex home init --run ${basename(process.env.RUN_LOG, '.jsonl')}\` in Stage 0`);
  }
  return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : null;
}

/** Top-level `key = "value"` / `key = 'value'` from a TOML file — stops at the first table
 *  header so a `[profiles.x]` value is never promoted to the root. Not a TOML parser. */
function tomlTopString(text, key) {
  const top = text.split(/^\s*\[/m)[0];
  const m = top.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'm'));
  return m ? (m[1] ?? m[2]) || null : null;
}

function configuredModel(codexHome) {
  const cfg = join(codexHome || join(homedir(), '.codex'), 'config.toml');
  try { return tomlTopString(readFileSync(cfg, 'utf8'), 'model'); } catch { return null; }
}

function configuredEffort(codexHome) {
  const cfg = join(codexHome || join(homedir(), '.codex'), 'config.toml');
  try { return tomlTopString(readFileSync(cfg, 'utf8'), 'model_reasoning_effort'); } catch { return null; }
}

function isRateLimited(text) {
  return /\b429\b|rate.?limit|usage limit|too many requests/i.test(text);
}

/** Run `codex exec …` once. Resolves {code, events, stdout, stderr, timedOut, lastMessage}. */
const WRITE_SANDBOXES = new Set(['yolo', 'workspace-write']);
/** How a writer seat is allowed to write. `yolo` (default) = codex's
 *  --dangerously-bypass-approvals-and-sandbox: the worktree is the boundary, exactly the trust a
 *  Claude implementer runs with today; needed on Linux hosts where bubblewrap cannot start and the
 *  landlock backend refuses workspace-write (verified: "permission profiles requiring direct
 *  runtime enforcement are incompatible with --use-legacy-landlock"). `workspace-write` = codex's
 *  own sandbox, for hosts where it works (macOS seatbelt, bwrap-capable Linux). */
function writeSandboxFor(flags, codexHome) {
  const mode = flags['write-sandbox'] || process.env.SF_CODEX_WRITE_SANDBOX || 'yolo';
  if (!WRITE_SANDBOXES.has(mode)) die(`--write-sandbox / SF_CODEX_WRITE_SANDBOX must be one of ${[...WRITE_SANDBOXES].join(', ')} (got ${JSON.stringify(mode)})`);
  // Refused up front rather than detected after: under the landlock backend the exec tool panics
  // before any command_execution item is emitted, so the seat surfaces only as "ran no shell
  // command" after a full model turn (verified: codex 0.155, 500k tokens for zero commits).
  if (mode === 'workspace-write' && landlockEnabled(codexHome)) {
    die(`--write-sandbox workspace-write cannot run in this run home: ${join(codexHome, 'config.toml')} enables the landlock sandbox backend (bwrap cannot create user namespaces here), and landlock refuses workspace-write — every command panics ("permission profiles requiring direct runtime enforcement are incompatible with --use-legacy-landlock") and the seat is blind. Drop the flag / unset SF_CODEX_WRITE_SANDBOX: the default yolo runs writers with the worktree as the boundary (review-backend.md §Hybrid mode).`);
  }
  return mode;
}

/** Whether `home init` switched this run home to the landlock backend (`[features]
 *  use_legacy_landlock = true`). No home, or no config → false: nothing to refuse on. */
function landlockEnabled(codexHome) {
  if (!codexHome) return false;
  try { return /^\s*use_legacy_landlock\s*=\s*true\b/m.test(readFileSync(join(codexHome, 'config.toml'), 'utf8')); } catch { return false; }
}

/** How reader seats (review, closure, clarify, plan) are held read-only. `native` = codex's own
 *  `-s read-only` sandbox. `snapshot` = no codex sandbox; the seat runs in a disposable detached
 *  worktree at the reviewed commit and a seat that changes it is discarded (status "tampered").
 *  `home init` selects snapshot when neither bubblewrap nor landlock can start (docker's default
 *  seccomp forbids user namespaces, and codex >= 0.156 refuses landlock-only restriction:
 *  "filesystem-restricted execution requires bubblewrap to isolate app-server sockets"). It
 *  detects writes to the snapshot; it cannot prevent a write to an absolute path elsewhere. */
const READ_SANDBOXES = new Set(['native', 'snapshot']);
const SANDBOX_MARKER = 'sf-sandbox.json';
function readSandboxFor(codexHome) {
  const forced = process.env.SF_CODEX_READ_SANDBOX;
  if (forced) {
    if (!READ_SANDBOXES.has(forced)) die(`SF_CODEX_READ_SANDBOX must be one of ${[...READ_SANDBOXES].join(', ')} (got ${JSON.stringify(forced)})`);
    return forced;
  }
  if (!codexHome) return 'native';
  try { return JSON.parse(readFileSync(join(codexHome, SANDBOX_MARKER), 'utf8')).reader === 'snapshot' ? 'snapshot' : 'native'; } catch { return 'native'; }
}

function gitOut(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

/** The commit a snapshot pins: the reviewed range's end (every reviewer range ends at a captured
 *  sha, never HEAD — ship-task 3d), else the worktree's HEAD. */
function snapshotSha(cwd, range) {
  const end = range ? String(range).split(/\.\.\.?/).pop() : '';
  return (gitOut(cwd, ['rev-parse', '--verify', '--quiet', `${end || 'HEAD'}^{commit}`]) || '').trim() || null;
}

/** `git status` of a snapshot, untracked files included (ignored ones are not: a read-only
 *  tool may write its own cache there). */
function snapshotStatus(dir) {
  return gitOut(dir, ['status', '--porcelain', '--untracked-files=all']);
}

function removeSnapshot(cwd, dir) {
  if (!dir) return;
  const r = spawnSync('git', ['-C', cwd, 'worktree', 'remove', '--force', '--force', dir], { encoding: 'utf8' });
  if (r.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    spawnSync('git', ['-C', cwd, 'worktree', 'prune'], { encoding: 'utf8' });
  }
}

/** A detached worktree of `cwd` at `sha` under the run home (never inside the reviewed tree). The
 *  root node_modules is linked in so the repo's navigation tools resolve; the status taken after
 *  that link is the baseline the tamper check compares against. */
function createSnapshot(cwd, sha, codexHome, label) {
  const root = join(codexHome || join(homedir(), '.cache', 'sf-codex'), 'snapshots');
  mkdirSync(root, { recursive: true });
  const dir = join(root, `${label.replace(/[^A-Za-z0-9._-]/g, '_')}-${nowMs()}-${Math.random().toString(16).slice(2, 8)}`);
  const add = spawnSync('git', ['-C', cwd, 'worktree', 'add', '--quiet', '--detach', dir, sha], { encoding: 'utf8' });
  if (add.status !== 0) {
    removeSnapshot(cwd, dir);
    throw new Error(`git worktree add ${sha.slice(0, 9)} failed: ${(add.stderr || '').trim().split('\n').pop()}`);
  }
  const nm = join(cwd, 'node_modules');
  if (existsSync(nm) && !existsSync(join(dir, 'node_modules'))) { try { symlinkSync(nm, join(dir, 'node_modules')); } catch { /* navigation only */ } }
  const status = snapshotStatus(dir);
  if (status === null) { removeSnapshot(cwd, dir); throw new Error('cannot read the snapshot status'); }
  return { dir, sha, status };
}

/** What a seat changed in its snapshot: null when nothing, else a short description. */
function snapshotTampering(snap) {
  const head = (gitOut(snap.dir, ['rev-parse', 'HEAD']) || '').trim();
  if (head !== snap.sha) return `HEAD moved to ${head.slice(0, 9) || '(unreadable)'}`;
  const now = snapshotStatus(snap.dir);
  if (now === null) return 'snapshot status unreadable';
  if (now === snap.status) return null;
  const before = new Set(snap.status.split('\n'));
  const changed = now.split('\n').filter((l) => l && !before.has(l));
  return changed.length ? changed.slice(0, 5).join('; ') : 'files restored or removed';
}

function runCodexOnce({ prompt, cwd, schemaPath, outFile, resumeId, ephemeral, model, effort, serviceTier, codexHome, timeoutMin, write, bypass }) {
  const args = ['exec'];
  if (resumeId) args.push('resume', resumeId);
  args.push('--json', '--output-schema', schemaPath, '-o', outFile);
  if (!resumeId) {
    // bypass = a reader seat held read-only by its disposable snapshot (readSandboxFor).
    if (write === 'yolo' || bypass) args.push('--dangerously-bypass-approvals-and-sandbox');
    else if (write === 'workspace-write') args.push('-s', 'workspace-write');
    else args.push('-s', 'read-only');
    args.push('-C', cwd);
  } else if (bypass) {
    // A snapshot reader's warm turn: resume accepts the bypass flag, and the resumed thread runs
    // in the spawn cwd (verified on codex 0.159) — the fresh snapshot this turn was given.
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    // `codex exec resume` accepts no -s: the resumed turn takes the CONFIG default sandbox
    // (workspace-write), which the landlock backend refuses — every command then fails and the
    // closure seat goes blind. Re-assert read-only through -c, which resume does accept.
    // Writers never resume.
    args.push('-c', 'sandbox_mode="read-only"');
  }
  if (ephemeral) args.push('--ephemeral');
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  // A pinned service_tier overrides the run home's config for this seat (and is re-applied on
  // resume from the sidecar, like model/effort); a null one lets the home's default stand.
  if (serviceTier) args.push('-c', `service_tier="${serviceTier}"`);
  args.push('-');
  const env = { ...process.env };
  if (codexHome) env.CODEX_HOME = codexHome;
  rmSync(outFile, { force: true }); // never read a previous attempt's reply as this one's
  return new Promise((resolveP) => {
    // detached → own process group, so a timeout kills codex AND whatever tool command it
    // was running; otherwise an orphaned `sleep`/build holding our pipe defers the report.
    const child = spawn('codex', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5000).unref();
    }, timeoutMin * 60 * 1000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); if (!settled) { settled = true; resolveP({ code: -1, events: [], stdout, stderr: `${stderr}\n${e.message}`, timedOut, lastMessage: null }); } });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const events = [];
      for (const line of stdout.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try { events.push(JSON.parse(t)); } catch { /* progress noise */ }
      }
      let lastMessage = null;
      if (existsSync(outFile)) lastMessage = readFileSync(outFile, 'utf8');
      else {
        const msg = [...events].reverse().find((e) => e.type === 'item.completed' && e.item?.type === 'agent_message');
        if (msg?.item?.text) lastMessage = msg.item.text;
      }
      resolveP({ code, events, stdout, stderr, timedOut, lastMessage });
    };
    // `close` waits for every pipe holder; a leaked descendant would defer it forever, so
    // `exit` + a short drain is the real completion signal.
    child.on('exit', (code) => setTimeout(() => finish(code), 250));
    child.on('close', finish);
    child.stdin.on('error', () => { /* codex exited early; error surfaces via exit */ });
    child.stdin.end(prompt);
  });
}

/** The plugin version string, for the app-server `initialize` clientInfo. */
function pluginVersion() {
  try { return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || '0'; } catch { return '0'; }
}

/** A live `codex app-server --stdio` session (JSON-RPC 2.0, newline-delimited JSON on stdout;
 *  stderr carries tracing — protocol-notes.md §Transport). Zero dependencies. Writer seats use it
 *  for liveness, steer, and interrupt; `runCodexOnce`'s killGroup is a closure bound to its own
 *  child, so close() re-implements the process-group kill here. */
class AppServerClient {
  constructor({ cwd, codexHome, onNotification, onExit }) {
    this.cwd = cwd;
    this.codexHome = codexHome;
    this.onNotification = onNotification || (() => {});
    this.onExit = onExit || (() => {});
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.stderr = '';
    this.exited = null; // { code, signal } once the child is gone, else null
  }

  start() {
    const env = { ...process.env };
    if (this.codexHome) env.CODEX_HOME = this.codexHome;
    // detached → own process group, so close() can signal codex AND any tool command it spawned.
    const child = spawn('codex', ['app-server', '--stdio'], { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => this._onStdout(d));
    child.stderr.on('data', (d) => { this.stderr += d; });
    child.stdin.on('error', () => { /* child exited early; the exit path reports it */ });
    child.on('error', (e) => { this.stderr += `\n${e.message}`; this._onExit(-1, null); });
    child.on('exit', (code, signal) => this._onExit(code, signal));
  }

  _onStdout(chunk) {
    this.buf += chunk;
    // A line with no newline must not grow the buffer without bound: past a ceiling far larger than
    // any real JSON-RPC frame, drop the partial line and resync on the next newline — retaining
    // megabytes that hold no complete message is the failure this guards.
    if (this.buf.length > 8 * 1024 * 1024 && this.buf.indexOf('\n') === -1) {
      warn(`app-server stdout line exceeded the buffer ceiling; dropping ${this.buf.length} bytes and resyncing`);
      this.buf = '';
      return;
    }
    let nl;
    // bounded: each iteration consumes one newline-terminated line; the buffer only shrinks.
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith('{')) continue; // non-JSON line (tracing leaked to stdout): ignore
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // server → client request (both id and method): auto-reject so an unanswered approval or
    // user-input request can never hang a turn (protocol-notes.md §Transport; with
    // approvalPolicy:"never" none are expected).
    if (msg.id !== undefined && msg.method) {
      warn(`app-server requested ${msg.method}; rejecting (seats run unattended)`);
      this._send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'sf-codex seats run unattended; request rejected' } });
      return;
    }
    // response to one of our requests
    if (msg.id !== undefined && (('result' in msg) || ('error' in msg))) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if ('error' in msg) { const e = new Error(msg.error?.message || 'app-server error'); e.rpc = msg.error; p.reject(e); }
      else p.resolve(msg.result);
      return;
    }
    // notification (method, no id)
    if (msg.method) this.onNotification(msg.method, msg.params || {});
  }

  _send(obj) {
    try { this.child.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* exit path reports it */ }
  }

  /** Resolves the JSON-RPC result; rejects on a JSON-RPC error (err.rpc = {code,message}), on
   *  timeoutMs, or if the process exited first. */
  request(method, params, { timeoutMs = 30000 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.exited) { reject(new Error(`app-server exited (code ${this.exited.code})`)); return; }
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`app-server ${method} timed out after ${timeoutMs}ms`)); }
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }

  notify(method, params) { this._send({ jsonrpc: '2.0', method, params: params || {} }); }

  /** Handshake: initialize (30 s cap; observed ≈ 0.2–0.7 s) then the initialized notification. */
  async initialize(version) {
    await this.request('initialize', { clientInfo: { name: 'sf-codex', version: version || '0' } }, { timeoutMs: 30000 });
    this.notify('initialized', {});
  }

  _onExit(code, signal) {
    if (this.exited) return;
    this.exited = { code, signal };
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`app-server exited (code ${code})`)); }
    this.pending.clear();
    this.onExit(this.exited);
  }

  /** SIGTERM to the process group, await exit ≤ 5 s, else SIGKILL; resolves only once gone. */
  close() {
    return new Promise((resolveP) => {
      const child = this.child;
      if (!child || this.exited) { resolveP(); return; }
      const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
      let done = false;
      const finish = () => { if (done) return; done = true; resolveP(); };
      child.on('exit', finish);
      kill('SIGTERM');
      setTimeout(() => { if (!done) kill('SIGKILL'); }, 5000).unref?.();
    });
  }
}

/** Run one writer seat over the app-server transport: a work turn with idle/steer/wall clocks and,
 *  after any interrupt, a short report turn on the same thread (design constraints b–e). Returns an
 *  object shaped so cmdReview needs one branch, not a rewrite — `events` normalised to the exec
 *  shape so commandStats works unchanged; `usage` the thread's last cumulative total; `retryJson`
 *  one extra bounded turn for the schema re-ask; `close()` kills the process group. */
async function runWriterSession({ prompt, cwd, schema, model, effort, serviceTier, codexHome, write, budgets, baseline }) {
  const num = (x) => (typeof x === 'number' ? x : null);
  const sandbox = write === 'yolo' ? 'danger-full-access' : 'workspace-write';
  const sandboxPolicy = write === 'yolo' ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite', writableRoots: [cwd] };
  // The report and JSON-retry turns only describe the tree. They run read-only where codex can
  // sandbox; on a snapshot host (no working sandbox) a read-only turn cannot run even `git log`,
  // so a yolo writer keeps the access it already had.
  const quietPolicy = write === 'yolo' && readSandboxFor(codexHome) === 'snapshot' ? { type: 'dangerFullAccess' } : { type: 'readOnly' };
  const wrapupMin = Math.round((budgets.wrapupMs / 60000) * 100) / 100;

  const session = {
    code: 0, events: [], stderr: '', timedOut: false, lastMessage: null, threadId: null,
    transport: 'app-server', outcome: null,
    usage: { tokens_in: null, tokens_cached: null, tokens_out: null, tokens_reasoning: null },
    stats: null, compactions: 0, idleMaxMs: 0, turns: 0,
    steerSent: false, interruptSent: false, reportTurn: false, detail: null, crashed: false,
    rateLimited: false, contextFraction: null,
  };

  // turn-scoped state shared with the notification handler
  let currentTurnId = null;
  let turnResolver = null; // set by runTurn: receives the turn/completed `turn` payload
  let turnCrash = null;    // set by runTurn: called by onExit to settle an in-flight turn as crashed
  let rearmIdle = () => {}; // set by runTurn: the active turn's idle re-arm

  const onNotification = (method, params) => {
    if (method === 'turn/started') {
      if (!currentTurnId && params.turn?.id) currentTurnId = params.turn.id;
      return;
    }
    if (method === 'item/completed') {
      const item = params.item || {};
      const turnId = params.turnId;
      // Stray: a command from the previous (interrupted) turn whose completion arrives during the
      // next turn (protocol-notes.md §turn/interrupt). Counted in stats, never used as a turn's
      // final message, never resets the idle clock.
      const stray = !!(currentTurnId && turnId && turnId !== currentTurnId);
      if (item.type === 'commandExecution') {
        session.events.push({ type: 'item.completed', turn_id: turnId, item: { type: 'command_execution', command: item.command, exit_code: item.exitCode, status: item.status, aggregated_output: capAggregatedOutput(item.aggregatedOutput) } });
      } else if (item.type === 'agentMessage') {
        session.events.push({ type: 'item.completed', turn_id: turnId, item: { type: 'agent_message', text: item.text, phase: item.phase } });
      }
      if (!stray) rearmIdle();
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const total = params.tokenUsage?.total;
      if (total) {
        // total is cumulative for the thread — REPLACE, never add (protocol-notes.md §Notifications).
        session.usage = { tokens_in: num(total.inputTokens), tokens_cached: num(total.cachedInputTokens), tokens_out: num(total.outputTokens), tokens_reasoning: num(total.reasoningOutputTokens) };
        const win = params.tokenUsage.modelContextWindow;
        if (typeof total.totalTokens === 'number' && typeof win === 'number' && win > 0) session.contextFraction = total.totalTokens / win;
      }
      return;
    }
    if (method === 'thread/compacted') { session.compactions += 1; return; }
    if (method === 'turn/completed') { if (turnResolver) turnResolver(params.turn || {}); return; }
    if (method === 'error') {
      session.detail = params.error?.message || session.detail;
      if (params.willRetry) rearmIdle();               // server alive and retrying
      else if (isRateLimited(String(params.error?.message || ''))) session.rateLimited = true;
      return;
    }
    // everything else ignored (protocol-notes.md §Notifications noise list)
  };

  const client = new AppServerClient({
    cwd, codexHome, onNotification,
    onExit: () => { if (turnCrash) turnCrash(); },
  });

  /** One turn: turn/start, then idle/steer/wall clocks; interrupt on idle or wall; settle once on
   *  the first of turn/completed, crash, or no-completion. Returns {status, finalText, reason, error}. */
  async function runTurn(input, { wallMs, idleMs, steerAtMs, sandboxPolicy: turnSandboxPolicy = sandboxPolicy }) {
    session.turns += 1;
    let turnId = null;
    let settled = false;
    let reason = null;
    let completed = null; // the turn/completed `turn` payload
    const timers = [];    // wall, steer, interrupt-wait cap — cleared once on settle
    let idleTimer = null; // rebuilt on each item/completed; the only timer that re-arms
    let lastItemAt = 0;
    let resolveTurn;
    const turnDone = new Promise((r) => { resolveTurn = r; });

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      for (const t of timers) clearTimeout(t);
      rearmIdle = () => {};
      turnResolver = null;
      turnCrash = null;
      currentTurnId = null;
      resolveTurn(result);
    };

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { reason = 'idle'; session.idleMaxMs = Math.max(session.idleMaxMs, Date.now() - lastItemAt); doInterrupt(); }, idleMs);
      idleTimer.unref?.();
    };
    // Idle re-arms only on an item/completed of THIS turn — a command that hangs after its
    // item/started must not keep the seat alive; the longest gap seen rides out as idle_max_ms.
    const bumpIdle = () => {
      const now = Date.now();
      if (lastItemAt) session.idleMaxMs = Math.max(session.idleMaxMs, now - lastItemAt);
      lastItemAt = now;
      armIdle();
    };

    const doInterrupt = async () => {
      if (settled) return;
      session.interruptSent = true;
      try {
        await client.request('turn/interrupt', { threadId: session.threadId, turnId }, { timeoutMs: 15000 });
      } catch (e) {
        // -32600 "no active turn to interrupt" → the turn already ended; a benign race, not a crash.
        if (e.rpc?.code === -32600) warn(`stale interrupt: ${e.rpc.message}`);
      }
      if (settled) return;
      // turn/completed for an interrupt arrives within ~10 ms; cap the wait at 15 s, else the
      // session is effectively crashed (no completion will come).
      const cap = setTimeout(() => settle({ status: 'crashed', reason: 'no-completion' }), 15000);
      cap.unref?.();
      timers.push(cap);
    };

    turnResolver = (turn) => { completed = turn; settle({ status: turn.status, reason, error: turn.error }); };
    turnCrash = () => settle({ status: 'crashed', reason: 'crashed' });

    let startRes;
    try {
      startRes = await client.request('turn/start', {
        threadId: session.threadId, cwd, input: [{ type: 'text', text: input }],
        ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(serviceTier ? { serviceTier } : {}),
        approvalPolicy: 'never', sandboxPolicy: turnSandboxPolicy, outputSchema: schema,
      }, { timeoutMs: 30000 });
    } catch (e) {
      turnResolver = null; turnCrash = null;
      return { status: 'crashed', finalText: null, reason: 'crashed', error: { message: e.message } };
    }
    if (settled) return { status: 'crashed', finalText: null, reason, error: null };
    turnId = startRes.turn?.id || null;
    currentTurnId = turnId;
    // turn/start's response is serialised before turn/started (protocol-notes.md §Probe 3), so
    // turnId is set before any item arrives. Arm the clocks now (measured from turn start).
    const wall = setTimeout(() => { reason = 'budget'; doInterrupt(); }, wallMs);
    wall.unref?.();
    timers.push(wall);
    if (steerAtMs != null) {
      const steer = setTimeout(() => {
        if (settled) return;
        session.steerSent = true;
        client.request('turn/steer', { threadId: session.threadId, expectedTurnId: turnId, input: [{ type: 'text', text: WRAPUP_STEER(wrapupMin) }] }, { timeoutMs: 15000 })
          .catch((e) => { if (e.rpc?.code === -32600) warn(`stale steer: ${e.rpc.message}`); });
      }, steerAtMs);
      steer.unref?.();
      timers.push(steer);
    }
    rearmIdle = bumpIdle;
    lastItemAt = Date.now();
    armIdle();

    const result = await turnDone;

    const finalTextOf = () => {
      const mine = session.events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message' && e.turn_id === turnId && typeof e.item.text === 'string');
      const pick = [...mine].reverse().find((e) => e.item.phase === 'final_answer') || mine[mine.length - 1];
      if (pick?.item?.text) return pick.item.text;
      if (completed?.items) {
        const msgs = completed.items.filter((it) => it.type === 'agentMessage' && typeof it.text === 'string');
        if (msgs.length) return msgs[msgs.length - 1].text;
      }
      return null;
    };
    return { status: result.status, finalText: finalTextOf(), reason: result.reason, error: result.error };
  }

  // --- Session setup (constraint: a setup-request rejection or process exit is a crash) ---
  client.start();
  try {
    await client.initialize(pluginVersion());
    const started = await client.request('thread/start', {
      cwd, ...(model ? { model } : {}), ...(serviceTier ? { serviceTier } : {}), sandbox, approvalPolicy: 'never',
    }, { timeoutMs: 30000 });
    session.threadId = started.thread?.id || null;
  } catch (e) {
    session.outcome = 'failed';
    session.crashed = true;
    session.detail = `app-server crashed: ${e.message}`;
    session.code = -1;
  }

  if (!session.crashed) {
    const steerAtMs = budgets.wrapupMs >= budgets.wallMs ? null : budgets.wallMs - budgets.wrapupMs;
    const work = await runTurn(prompt, { wallMs: budgets.wallMs, idleMs: budgets.idleMs, steerAtMs });
    if (work.status === 'crashed') {
      session.outcome = 'failed'; session.crashed = true; session.code = -1;
      session.detail = `app-server crashed: ${work.reason}${work.error?.message ? ` (${work.error.message})` : ''}`;
    } else if (work.status === 'completed') {
      session.outcome = session.steerSent ? 'wrapped-up' : 'ok';
      session.lastMessage = work.finalText;
    } else if (work.status === 'interrupted') {
      session.reportTurn = true;
      // The report turn only describes the tree (git status / git log); it must not keep the
      // writer's write/exec access for the whole report budget where codex can sandbox it
      // (quietPolicy; review-backend.md §Sandbox).
      const rep = await runTurn(REPORT_PROMPT(work.reason || 'budget', baseline), { wallMs: budgets.reportMs, idleMs: budgets.reportMs, steerAtMs: null, sandboxPolicy: quietPolicy });
      if (rep.status === 'completed' && rep.finalText) {
        session.outcome = 'interrupted-reported'; session.lastMessage = rep.finalText;
      } else {
        session.outcome = 'failed';
        // A report turn that itself crashes (the app-server exited during it) must log crashed=true,
        // not the default false, so /ship-report sees the process crash.
        if (rep.status === 'crashed') {
          session.crashed = true;
          session.detail = `app-server crashed during the report turn after ${work.reason} interrupt${rep.error?.message ? ` (${rep.error.message})` : ''}`;
        } else {
          session.detail = `report turn did not complete after ${work.reason} interrupt`;
        }
      }
    } else {
      // turn error (status 'failed') or an unexpected status
      session.outcome = 'failed';
      session.detail = work.error?.message || session.detail || `turn ended with status ${work.status}`;
    }
  }

  session.stderr = client.stderr;
  session.stats = commandStats(session.events);

  session.retryJson = async (fixPrompt) => {
    // Re-asking for the corrected JSON needs no write/exec access: run it read-only too.
    const r = await runTurn(fixPrompt, { wallMs: budgets.reportMs, idleMs: budgets.reportMs, steerAtMs: null, sandboxPolicy: quietPolicy });
    session.lastMessage = r.finalText;
    return r.finalText;
  };
  session.close = () => client.close();
  return session;
}

/** The last error the event stream reported (codex prints API errors as events, not on stderr). */
function errorOf(attempt) {
  const ev = [...attempt.events].reverse().find((e) => e.type === 'error' || e.type === 'turn.failed');
  const raw = ev?.message || ev?.error?.message || '';
  let msg = raw;
  try { const j = JSON.parse(raw); msg = j.error?.message || j.message || raw; } catch { /* plain text */ }
  const err = [msg, attempt.stderr.trim().split('\n').filter(Boolean).slice(-2).join(' | ')].filter(Boolean).join(' | ');
  return err || `codex exit ${attempt.code}`;
}

/** Usage summed over every `turn.completed` in the stream (spawn-accounting.md: "every model call"). */
function usageOf(events) {
  const out = { tokens_in: null, tokens_cached: null, tokens_out: null, tokens_reasoning: null };
  const map = { tokens_in: 'input_tokens', tokens_cached: 'cached_input_tokens', tokens_out: 'output_tokens', tokens_reasoning: 'reasoning_output_tokens' };
  for (const e of events) {
    if (e.type !== 'turn.completed' || !e.usage) continue;
    for (const [k, src] of Object.entries(map)) {
      if (typeof e.usage[src] === 'number') out[k] = (out[k] ?? 0) + e.usage[src];
    }
  }
  return out;
}

/** Usage for a seat whose stdout never carried `turn.completed` (killed on timeout, crashed):
 *  codex's rollout file for the thread holds a `token_count` event per turn whose
 *  `info.total_token_usage` is the running total — the last one is the seat's cost. Without this
 *  a timed-out writer (the most expensive failure shape: 34.8M input on ship-task-1788747694's
 *  phase 7) is a `codex-seat-failed` note with no tokens, and /ship-report under-counts the run. */
function rolloutUsage(codexHome, threadId) {
  if (!codexHome || !safeThreadId(threadId)) return null;
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return null;
  const stack = [root];
  let file = null;
  while (stack.length && !file) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else if (name.startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`)) { file = p; break; }
    }
  }
  if (!file) return null;
  let total = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"token_count"')) continue;
    try {
      const ev = JSON.parse(line);
      const u = ev?.payload?.type === 'token_count' ? ev.payload.info?.total_token_usage : null;
      if (u) total = u;
    } catch { /* partial last line */ }
  }
  if (!total) return null;
  const pick = (k) => (typeof total[k] === 'number' ? total[k] : null);
  return { tokens_in: pick('input_tokens'), tokens_cached: pick('cached_input_tokens'), tokens_out: pick('output_tokens'), tokens_reasoning: pick('reasoning_output_tokens') };
}

function addUsage(a, b) {
  for (const k of Object.keys(a)) if (b[k] != null) a[k] = (a[k] ?? 0) + b[k];
  return a;
}

/** Shell commands the seat ran, from `item.completed` command_execution items. A reviewer
 *  that ran none, or none successfully, never read the diff — that is a blind seat. */
/** Only the first failing line of a command's output is ever read (commandStats), yet every
 *  command's aggregated output is retained in session.events for the life of the session — so a
 *  single huge-output command must not pin megabytes. Keep a head large enough to hold any first
 *  line; the rest is never consumed. */
function capAggregatedOutput(s) {
  if (typeof s !== 'string' || s.length <= 4096) return s;
  return `${s.slice(0, 4096)}…[truncated]`;
}

function commandStats(events) {
  const st = { run: 0, ok: 0, first_failure: null };
  for (const e of events) {
    if (e.type !== 'item.completed' || e.item?.type !== 'command_execution') continue;
    st.run += 1;
    if (e.item.exit_code === 0) st.ok += 1;
    else if (!st.first_failure) st.first_failure = String(e.item.aggregated_output ?? e.item.output ?? '').trim().split('\n')[0].slice(0, 160);
  }
  return st;
}

function addStats(a, b) { a.run += b.run; a.ok += b.ok; a.first_failure = a.first_failure ?? b.first_failure; return a; }

function threadIdOf(events, fallback) {
  const t = events.find((e) => e.type === 'thread.started' && e.thread_id);
  return t ? t.thread_id : fallback || null;
}

function parseJsonMessage(text) {
  if (!text) return { error: 'empty final message' };
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1];
  try { return { value: JSON.parse(t) }; } catch (e) { return { error: `final message is not JSON: ${e.message}` }; }
}

// =============================================================================
// Rendering — the .md artifact a Claude seat would have written
// =============================================================================
function countBySeverity(findings) {
  const c = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) c[f.severity] = (c[f.severity] || 0) + 1;
  return c;
}

function cite(f) { return `${f.file}:${f.line_start}${f.line_end && f.line_end !== f.line_start ? `-${f.line_end}` : ''}`; }

function renderReview(data, { role, round, template, verdictCorrected }) {
  const out = [`# Review — ${role} — round ${round} (${template}, codex seat)`, ''];
  if (verdictCorrected) out.push(`> Verdict corrected by sf-codex: the reviewer reported ${verdictCorrected.from} with ${verdictCorrected.blocking} CRITICAL/HIGH finding(s).`, '');
  const by = (sev) => data.findings.filter((f) => f.severity === sev);
  for (const sev of ['CRITICAL', 'HIGH']) {
    const list = by(sev);
    if (!list.length) continue;
    out.push(`## ${sev}`, '');
    for (const f of list) {
      out.push(`### ${f.id} — ${f.title} (${cite(f)})`, '',
        `- **What the code does:** ${f.what}`,
        `- **What is wrong:** ${f.wrong}`,
        `- **Impact:** ${f.impact}`,
        `- **Recommendation:** ${recommendationLine(f)}`,
        `- **Confidence:** ${f.confidence}`, '');
    }
  }
  const mediums = by('MEDIUM');
  if (mediums.length) {
    out.push('## MEDIUM', '');
    for (const f of mediums) out.push(`**${f.id} — ${f.title}** (${cite(f)}): ${f.what} ${f.wrong} ${f.impact} Recommendation: ${recommendationLine(f)} (confidence ${f.confidence})`, '');
  }
  const lows = by('LOW');
  if (lows.length) {
    out.push('## LOW', '', '| id | file:line | what | why it matters | suggested fix |', '|---|---|---|---|---|');
    for (const f of lows) out.push(`| ${f.id} | ${cite(f)} | ${cell(f.title)} — ${cell(f.wrong)} | ${cell(f.impact)} | ${cell(recommendationLine(f))} |`);
    out.push('');
  }
  if (data.clean_areas.length) out.push('## Clean', '', ...data.clean_areas.map((l) => `- ${l}`), '');
  if (data.deferred_to_domain.length) out.push('## Deferred to another reviewer', '', ...data.deferred_to_domain.map((l) => `- ${l}`), '');
  if (data.probes_suggested.length) out.push('## PROBE-SUGGESTED (not run — reviewers are read-only)', '', ...data.probes_suggested.map((l) => `- ${l}`), '');
  out.push(`**Verdict: ${data.verdict}**`, '');
  return out.join('\n');
}

function recommendationLine(f) {
  if (!f.recommendation_cite) return `${f.recommendation || 'Problem stated; no live code could be cited for a fix.'} *(no live-code cite — fix not prescribed)*`;
  return `${f.recommendation} (${f.recommendation_cite.file}:${f.recommendation_cite.line}${f.live_code_verified ? '' : ' — NOT verified live'})`;
}

function cell(s) { return String(s).replace(/\|/g, '\\|').replace(/\n+/g, ' '); }

function renderClosure(data, { role, round, missing }) {
  const out = [`# Closure — ${role} — fix round ${round} (codex seat)`, '', '| id | verdict | file:line evidence | reason |', '|---|---|---|---|'];
  for (const c of data.closures) out.push(`| ${c.id} | ${c.verdict} | ${c.file ? `${c.file}:${c.line}` : '—'} | ${cell(c.reason)} |`);
  for (const id of missing) out.push(`| ${id} | REOPENED | — | not verdicted by the reviewer (sf-codex skeptical default) |`);
  out.push('');
  if (data.new_fix_introduced.length) {
    out.push('## NEW (fix-introduced)', '');
    for (const f of data.new_fix_introduced) {
      out.push(`### ${f.id} — [${f.severity}] ${f.title} (${cite(f)})`, '',
        `- **What the code does:** ${f.what}`, `- **What is wrong:** ${f.wrong}`, `- **Impact:** ${f.impact}`,
        `- **Recommendation:** ${recommendationLine(f)}`, '');
    }
  }
  const counts = closureCounts(data, missing);
  out.push(`Closure: ${counts.CLOSED} CLOSED / ${counts.REOPENED} REOPENED / ${counts['DECLINE-ACCEPTED']} DECLINE-ACCEPTED / ${counts['NOT-MINE']} NOT-MINE`, '');
  return out.join('\n');
}

function closureCounts(data, missing = []) {
  const c = { CLOSED: 0, REOPENED: missing.length, 'DECLINE-ACCEPTED': 0, 'NOT-MINE': 0 };
  for (const x of data.closures) c[x.verdict] += 1;
  return c;
}

function renderClarify(data, { role, round, finding }) {
  return [`# Clarification — ${role} — round ${round} — finding ${finding}`, '', data.answer, ''].join('\n');
}

function renderPlan(data, { planPath, round, corrected }) {
  const out = [`## Plan Review: \`${basename(planPath)}\` (round ${round}, codex seat)`, ''];
  if (corrected) out.push(`> Adjusted by sf-codex: ${corrected}`, '');
  out.push(`### Overall Risk: **${data.overall_risk}**`, '');
  out.push('### Summary', '');
  if (data.findings.length) {
    out.push('| Severity | Dimension | Finding |', '|---|---|---|');
    for (const f of data.findings) out.push(`| ${f.severity} | ${f.dimension} | ${f.id} — ${cell(f.title)} |`);
  } else out.push('No findings.');
  out.push('', '### Detailed Findings', '');
  for (const f of data.findings) {
    out.push(`**[${f.severity}] ${f.dimension} — ${f.id}: ${f.title}**`, '',
      `- **Plan says:** ${f.plan_says}`, `- **Problem:** ${f.problem}`, `- **Impact:** ${f.impact}`,
      `- **Evidence:** ${f.evidence}`, `- **Recommendation:** ${f.unverified ? 'UNVERIFIED — ' : ''}${f.recommendation}`, '');
  }
  if (!data.findings.length) out.push('None.', '');
  out.push('### Dimensions With No Issues', '');
  out.push(...(data.clean_dimensions.length ? data.clean_dimensions.map((d) => `- ${d}: No issues identified.`) : ['- (none listed)']), '');
  out.push('### Open Questions', '');
  out.push(...(data.open_questions.length ? data.open_questions.map((q) => `- ${q}`) : ['None — the plan addresses all foreseeable concerns.']), '');
  out.push('### Verdict', '', `**${data.verdict}.**`, '');
  return out.join('\n');
}

// =============================================================================
// Post-processing rules (the orchestrator never trusts a verdict from the model)
// =============================================================================
function maxSeverity(findings) {
  for (const s of SEVERITY_ORDER) if (findings.some((f) => f.severity === s)) return s;
  return 'NONE';
}

function countBy(items, key) {
  const out = {};
  for (const it of items || []) out[it[key]] = (out[it[key]] || 0) + 1;
  return out;
}

function gitCommitsSince(cwd, baseline) {
  try {
    const out = execFileSync('git', ['log', '--format=%H%x09%s', `${baseline}..HEAD`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\n').filter(Boolean).map((l) => { const [sha, ...rest] = l.split('\t'); return { sha, subject: rest.join('\t') }; });
  } catch { return null; }
}

function gitRevParse(cwd, ref) {
  try { return execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null; } catch { return null; }
}
function gitIsAncestor(cwd, sha) {
  try { execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd, stdio: 'ignore' }); return true; } catch { return false; }
}
function gitDirtyCount(cwd) {
  try { return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean).length; } catch { return null; }
}
/** What a writer seat left behind, for the fail line: commits already in range and dirty paths. */
function writerState(cwd, baseline) {
  const commits = baseline ? gitCommitsSince(cwd, baseline) : null;
  return { commits_in_range: commits ? commits.length : null, dirty: gitDirtyCount(cwd) };
}

function gitNumstat(cwd, baseline) {
  try {
    const out = execFileSync('git', ['diff', '--numstat', `${baseline}..HEAD`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\n').filter(Boolean).map((l) => { const [added, deleted, ...path] = l.split('\t'); return { path: path.join('\t'), added, deleted }; });
  } catch { return []; }
}

function renderImplement(data, { role, round, template, batch, baseline, actual, numstat }) {
  const title = template === 'fix' ? `# Fix round ${round}` : `# Implement — batch ${batch || 'b1'}`;
  const out = [title, '', `_${role} · codex seat · verified against \`${baseline}..HEAD\`_`, ''];
  out.push(`## Commits (${actual.length} in the worktree, ${data.commits.length} reported)`, '');
  for (const c of actual) { const rep = data.commits.find((r) => c.sha.startsWith(r.sha) || r.sha.startsWith(c.sha)); out.push(`- \`${c.sha.slice(0, 9)}\` ${c.subject}${rep?.task_id ? ` _[task ${rep.task_id}]_` : ''}`); }
  if (!actual.length) out.push('_no commits — empty implementation_');
  out.push('', `## Files changed (${numstat.length})`, '');
  if (numstat.length) { out.push('| file | + | − |', '|---|---|---|'); for (const n of numstat) out.push(`| \`${n.path}\` | ${n.added} | ${n.deleted} |`); }
  else out.push('_none_');
  out.push('', '## Acceptance criteria', '');
  if (!data.acceptance.length) out.push('_none assigned_');
  else { out.push('| id | status | how |', '|---|---|---|'); for (const a of data.acceptance) out.push(`| ${a.id} | **${a.status}** | ${a.how} |`); }
  out.push('', '## Decisions the plan did not specify', '');
  if (!data.plan_gaps.length) out.push('_none — the plan was fully specified for this work_');
  else for (const g of data.plan_gaps) out.push(`- **${g.kind}** — ${g.what} → ${g.decision}`);
  const probes = Array.isArray(data.verify_first) ? data.verify_first : [];
  if (probes.length) { out.push('', '## verify_first probes', '', '| finding | probe | outcome | contradicts approach |', '|---|---|---|---|'); for (const p of probes) out.push(`| ${p.id} | ${p.probe} | ${p.outcome} | ${p.contradicts_approach ? '**yes**' : 'no'} |`); }
  if (data.verify_first_missing) out.push('', '## ⚠ verify_first probes missing', '', `The fix direction asked for probes on: ${data.verify_first_missing.join(', ')} — the report carries none for them. Treat those items as UNVERIFIED (re-review them cold).`);
  if (data.declined.length) { out.push('', '## Declined findings', ''); for (const d of data.declined) out.push(`- **${d.id}** — ${d.evidence}`); }
  if (data.scope_violations.length) { out.push('', '## Scope violations (NOT edited)', ''); for (const v of data.scope_violations) out.push(`- ${v}`); }
  if (data.blockers.length) { out.push('', '## Blockers', ''); for (const b of data.blockers) out.push(`- ${b}`); }
  return `${out.join('\n').trimEnd()}\n`;
}

function enforceReview(data) {
  const blocking = data.findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').length;
  const want = blocking ? 'FAIL' : 'PASS';
  if (data.verdict !== want) {
    const from = data.verdict;
    data.verdict = want;
    return { from, blocking };
  }
  return null;
}

function enforcePlan(data) {
  const notes = [];
  const risk = maxSeverity(data.findings);
  if (data.overall_risk !== risk) { notes.push(`overall_risk ${data.overall_risk} → ${risk} (highest finding severity)`); data.overall_risk = risk; }
  const hasCritical = risk === 'CRITICAL';
  const hasMidOrHigh = risk === 'HIGH' || risk === 'MEDIUM';
  if (hasCritical && data.verdict !== 'Stop and redesign') { notes.push(`verdict "${data.verdict}" → "Stop and redesign" (CRITICAL present)`); data.verdict = 'Stop and redesign'; }
  else if (!hasCritical && data.verdict === 'Stop and redesign') { notes.push(`verdict "Stop and redesign" → "Proceed with modifications" (no CRITICAL)`); data.verdict = 'Proceed with modifications'; }
  else if (hasMidOrHigh && data.verdict === 'Proceed as-is') { notes.push(`verdict "Proceed as-is" → "Proceed with modifications" (${risk} present)`); data.verdict = 'Proceed with modifications'; }
  return notes.length ? notes.join('; ') : null;
}

// =============================================================================
// review
// =============================================================================
async function cmdReview(flags) {
  if (!flags.artifact) die('--artifact <path-without-ext> is required');
  const started = nowMs();
  const { prompt, spec, seatFile, cwd } = buildPrompt(flags);
  const role = flags.role;
  const round = flags.round ?? '1';
  const artifactBase = resolve(flags.artifact.replace(/\.(md|json)$/, ''));
  mkdirSync(dirname(artifactBase), { recursive: true });
  const mdPath = `${artifactBase}.md`;
  const jsonPath = `${artifactBase}.json`;
  if (flags['keep-prompt'] || flags['dry-run']) writeFileSync(`${artifactBase}.prompt.md`, prompt);
  if (flags['dry-run']) {
    const dryHome = codexHomeFor(flags);
    const t = resolveTier(flags, spec, dryHome);
    const dryTransport = transportFor(flags, spec);
    const dryBudgets = (spec.write && dryTransport === 'app-server')
      ? { idle_min: numFlag(flags, 'idle-min', envNum('SF_CODEX_IDLE_MIN', DEFAULT_IDLE_MIN)), wrapup_min: numFlag(flags, 'wrapup-min', envNum('SF_CODEX_WRAPUP_MIN', DEFAULT_WRAPUP_MIN)), report_min: numFlag(flags, 'report-min', envNum('SF_CODEX_REPORT_MIN', DEFAULT_REPORT_MIN)) }
      : {};
    process.stdout.write(`${JSON.stringify({ role, template: flags.template, seat: seatFile, prompt_path: `${artifactBase}.prompt.md`, prompt_chars: prompt.length, tier: t.name, model: t.model, effort: t.effort, ...(t.serviceTier ? { service_tier: t.serviceTier } : {}), ...(spec.write ? { write_sandbox: writeSandboxFor(flags, dryHome) } : {}), transport: dryTransport, ...dryBudgets, status: 'dry-run' })}\n`);
    return 0;
  }
  if (spec.resumeOnly && !flags.resume) die(`--template ${flags.template} requires --resume <thread_id> (it is a warm continuation)`, 3);
  // Writer seats are always cold: `codex exec resume` cannot re-assert -s/-C, and a
  // new round is a new seat with a new baseline.
  if (spec.write && flags.resume) die(`--template ${flags.template} never resumes — writer seats are cold, one call each`);
  if (spec.write && flags.ephemeral) warn('--ephemeral on a writer seat disables the one JSON-fix retry after the seat has already written — prefer a real thread');

  const codexHome = codexHomeFor(flags);
  touchHome(codexHome);
  const schemaPath = join(SCHEMA_DIR, spec.schema);
  const schema = readJson(schemaPath);
  const outFile = `${artifactBase}.last.json`;
  // A failed seat must never leave a previous attempt's artifact behind as a false delivery.
  for (const p of [mdPath, jsonPath, outFile]) rmSync(p, { force: true });
  const timeoutMin = numFlag(flags, 'timeout-min', DEFAULT_TIMEOUT_MIN);
  const tier = resolveTier(flags, spec, codexHome);
  const write = spec.write ? writeSandboxFor(flags, codexHome) : null;
  const readSandbox = spec.write ? null : readSandboxFor(codexHome);
  let snap = null; // the reader's disposable worktree, created inside the try so finally removes it
  let seatPrompt = prompt;
  const transport = transportFor(flags, spec);
  const appServer = transport === 'app-server';
  const budgets = (spec.write && appServer) ? writerBudgets(flags) : null;
  const runOpts = {
    cwd, schemaPath, outFile, ephemeral: !!flags.ephemeral, model: tier.model, effort: tier.effort, serviceTier: tier.serviceTier, codexHome, timeoutMin, write, bypass: readSandbox === 'snapshot',
  };
  // Cold: what codex will run (a frontier seat = the run home's config). Warm: the thread's
  // sidecar; without one the model is genuinely unknown to us and is reported as "thread".
  const model = tier.model || (flags.resume ? 'thread' : (configuredModel(codexHome) || 'codex-default'));
  const effort = tier.effort || (flags.resume ? null : configuredEffort(codexHome));
  // null → this seat inherits the run home's service_tier; only reported/logged when pinned.
  const serviceTier = tier.serviceTier || null;

  const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const base = { role, template: flags.template, seat: seatFile ? basename(seatFile, '.md') : null, artifact: mdPath, round: Number(round), tier: tier.name, ...(serviceTier ? { service_tier: serviceTier } : {}), ...(write ? { write_sandbox: write } : {}), ...(readSandbox === 'snapshot' ? { read_sandbox: 'snapshot' } : {}), transport };
  let threadId = flags.resume || null;
  let usage = { tokens_in: null, tokens_cached: null, tokens_out: null, tokens_reasoning: null };
  let stats = { run: 0, ok: 0, first_failure: null };
  let attempts = 0; // codex exec launches / app-server turns for this seat — the ledger's attempts=
  // App-server writer state: usage/stats/attempts are DERIVED from these before every use (a
  // session's usage is its thread's last cumulative total, so summing across a re-launch is right
  // while re-adding within a thread would double-count — Step 3.2 / Appendix).
  const sessions = [];
  let activeSession = null;
  const deriveAppServer = () => {
    usage = sessions.reduce((acc, s) => addUsage(acc, { ...s.usage }), { tokens_in: null, tokens_cached: null, tokens_out: null, tokens_reasoning: null });
    stats = commandStats(sessions.flatMap((s) => s.events));
    attempts = sessions.reduce((a, s) => a + (s.turns || 0), 0);
  };
  const fail = (status, detail, code = 2) => {
    rmSync(outFile, { force: true });
    // A failed WRITER may already have committed or dirtied the tree: the orchestrator needs
    // that evidence to reset or adopt before any fallback (review-backend.md §Hybrid mode).
    const evidence = spec.kind === 'implement' ? writerState(cwd, flags.baseline) : {};
    let usageSource = null;
    if (usage.tokens_in == null && usage.tokens_out == null) {
      const recovered = rolloutUsage(codexHome, threadId);
      if (recovered) { usage = recovered; usageSource = 'rollout'; }
    }
    // app-server writer evidence (transport already rides on base): the orchestrator's
    // writer-fallback row keys its reset / adopt / adopt-dirty decision on these.
    const asCompactions = sessions.reduce((a, s) => a + (s.compactions || 0), 0);
    const asExtra = appServer && spec.kind === 'implement'
      ? { compactions: asCompactions, crashed: !!(activeSession && activeSession.crashed), steer_sent: sessions.some((s) => s.steerSent), interrupt_sent: sessions.some((s) => s.interruptSent) }
      : {};
    const line = { ...base, status, detail, thread_id: threadId, ...usage, ...(usageSource ? { usage_source: usageSource } : {}), commands_run: stats.run, commands_ok: stats.ok, wall_ms: nowMs() - started, model, effort, path: flags.resume ? 'warm' : 'cold', ...evidence, ...asExtra };
    if (process.env.RUN_LOG && !flags['no-log']) {
      const kv = ['stage', 'note', `event=codex-seat-${status}`, `role=${role}`, 'backend=codex', `round=${round}`, `detail=${JSON.stringify(detail)}`, `wall_ms=${nowMs() - started}`, `commands_run=${stats.run}`, `commands_ok=${stats.ok}`];
      if (spec.kind === 'implement') kv.push(`transport=${transport}`);
      if (appServer && spec.kind === 'implement') kv.push(`crashed=${!!(activeSession && activeSession.crashed)}`, `compactions=${asCompactions}`);
      if (threadId) kv.push(`agent_id=${threadId}`);
      if (readSandbox === 'snapshot') kv.push('read_sandbox=snapshot');
      if (usage.tokens_in != null || usage.tokens_out != null) kv.push(`tokens=${(usage.tokens_in ?? 0) + (usage.tokens_out ?? 0)}`);
      for (const k of ['tokens_in', 'tokens_cached', 'tokens_out', 'tokens_reasoning']) if (usage[k] != null) kv.push(`${k}=${usage[k]}`);
      if (usageSource) kv.push(`usage_source=${usageSource}`);
      try { execFileSync(process.execPath, [SF_LOG, ...kv], { stdio: ['ignore', 'ignore', 'inherit'] }); } catch (e) { warn(`sf-log note failed: ${e.message}`); }
    }
    emit(line);
    return code;
  };

  // A thrown error in the writer branch must never leak a live app-server: close() the last one.
  try {
  if (readSandbox === 'snapshot') {
    const sha = snapshotSha(cwd, flags.range);
    if (!sha) return fail('failed', `cannot resolve the snapshot commit (${flags.range ? `end of ${flags.range}` : 'HEAD'}) in ${cwd}`);
    try { snap = createSnapshot(cwd, sha, codexHome, `${roleName(role)}-r${round}`); } catch (e) { return fail('failed', `snapshot worktree: ${e.message}`); }
    base.snapshot_sha = sha;
    seatPrompt = buildPrompt(flags, { snapshot: snap }).prompt;
    // A warm thread remembers the previous turn's snapshot, which is gone; name this turn's.
    if (flags.resume) seatPrompt = `Your working tree for this turn is ${snap.dir}: a fresh read-only snapshot of ${cwd} at commit ${sha}. Any earlier snapshot path no longer exists; run every command here.\n\n${seatPrompt}`;
    runOpts.cwd = snap.dir;
  }
  let finalMsg;
  if (appServer) {
    const mkSession = () => runWriterSession({ prompt, cwd, schema, model: tier.model, effort: tier.effort, serviceTier: tier.serviceTier, codexHome, write, budgets, baseline: flags.baseline });
    activeSession = await mkSession();
    sessions.push(activeSession);
    threadId = activeSession.threadId;
    if (threadId && !flags.ephemeral) writeSidecar(codexHome, threadId, { model, effort, service_tier: serviceTier, tier: tier.name, role, opened: new Date().toISOString() });
    // Rate limit: the app-server surfaces a 429 either as the willRetry:false error notification
    // (session.rateLimited) or as a turn `failed` whose detail matches — both covered (unverified
    // which shape it uses). One retry after the same wait the exec path uses; a fresh thread.
    // Gate on non-delivery (outcome === 'failed') for BOTH shapes, mirroring the exec path's
    // `attempt.code !== 0`: a 429 error that is followed by a completed turn delivered a seat, and
    // relaunching would discard committed work and burn quota on a second seat.
    if (activeSession.outcome === 'failed' && (activeSession.rateLimited || (activeSession.detail && isRateLimited(activeSession.detail)))) {
      warn(`rate limited; retrying once in ${RATE_LIMIT_WAIT_SEC}s`);
      await activeSession.close();
      await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_SEC * 1000));
      activeSession = await mkSession();
      sessions.push(activeSession);
      threadId = activeSession.threadId;
      if (threadId && !flags.ephemeral) writeSidecar(codexHome, threadId, { model, effort, service_tier: serviceTier, tier: tier.name, role, opened: new Date().toISOString() });
    }
    deriveAppServer();
    if (activeSession.outcome === 'failed') return fail('failed', activeSession.detail || 'app-server writer failed');
    finalMsg = activeSession.lastMessage;
  } else {
    let attempt = await runCodexOnce({ ...runOpts, prompt: seatPrompt, resumeId: flags.resume || null });
    attempts += 1;
    threadId = threadIdOf(attempt.events, flags.resume);
    if (threadId && !flags.resume && !flags.ephemeral) writeSidecar(codexHome, threadId, { model, effort, service_tier: serviceTier, tier: tier.name, role, opened: new Date().toISOString() });
    addUsage(usage, usageOf(attempt.events));
    addStats(stats, commandStats(attempt.events));
    if (attempt.timedOut) return fail('failed', `timed out after ${timeoutMin} min`);
    // codex 0.151: "thread/resume failed: no rollout found for thread id …" (missing) or the
    // thread-store error observed on a malformed sqlite; both mean "cannot continue".
    if (attempt.code !== 0 && flags.resume && /thread\/resume|thread-store|no rollout found|no such thread|failed to list thread/i.test(`${attempt.stderr}\n${errorOf(attempt)}`)) {
      return fail('not-continuable', errorOf(attempt), 3);
    }
    if (attempt.code !== 0 && isRateLimited(`${attempt.stderr}\n${errorOf(attempt)}`)) {
      warn(`rate limited; retrying once in ${RATE_LIMIT_WAIT_SEC}s`);
      await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_SEC * 1000));
      attempt = await runCodexOnce({ ...runOpts, prompt: seatPrompt, resumeId: flags.resume || null });
      attempts += 1;
      threadId = threadIdOf(attempt.events, flags.resume);
      addUsage(usage, usageOf(attempt.events));
      addStats(stats, commandStats(attempt.events));
      if (attempt.timedOut) return fail('failed', `timed out after ${timeoutMin} min`);
    }
    if (attempt.code !== 0) return fail('failed', `codex exit ${attempt.code}: ${errorOf(attempt)}`);
    finalMsg = attempt.lastMessage;
  }
  // A reviewer that never ran a command, or whose every command failed, never read the diff.
  // Its verdict is worthless however well-formed — and a sandbox that cannot start (bwrap
  // without user namespaces) makes EVERY command fail while the model still answers.
  if (spec.kind !== 'clarify' && stats.ok === 0) {
    // A writer interrupted before any command completed can still deliver a valid report turn that
    // ran no git command (it answered the report prompt from context); git already verifies its
    // commits below, so a zero-successful-command `interrupted-reported` seat is a "did nothing"
    // answer, not a blind seat. The blind check still applies to every reviewer and work-turn seat.
    const interruptedReported = appServer && activeSession && activeSession.outcome === 'interrupted-reported';
    if (interruptedReported) {
      warn('interrupted-reported seat ran no successful command; git is the evidence (commits verified below), not blind');
    } else {
      const why = stats.run === 0 ? 'the seat ran no shell command' : `all ${stats.run} shell commands failed: ${stats.first_failure || 'unknown error'}`;
      // A writer under codex's own sandbox that never got a command through is far more often a
      // sandbox the host cannot enforce than a model that chose not to act — name the flag.
      const hint = write === 'workspace-write' ? '; the seat ran under --write-sandbox workspace-write — if the host sandbox cannot enforce it the exec tool fails before any command is recorded, so relaunch without the flag (default yolo) before any Claude fallback' : '';
      return fail('blind', `${why}${hint} — see review-backend.md §Sandbox (run \`sf-codex home init\` to probe the sandbox)`);
    }
  }

  let parsed = parseJsonMessage(finalMsg);
  let errors = parsed.value ? validate(parsed.value, schema) : [parsed.error];
  if (errors.length && threadId && !flags.ephemeral) {
    warn(`invalid final message (${errors.slice(0, 3).join('; ')}); asking the thread once more`);
    const fixPrompt = `Your final message did not match the required JSON schema:\n${errors.slice(0, 10).join('\n')}\nReply again with ONLY the corrected JSON object — no prose, no code fences.`;
    let retryMsg = null;
    if (appServer) {
      // One extra bounded turn on the same thread; the derivation below already sees its tokens,
      // commands and turn count, so nothing else to bookkeep.
      retryMsg = await activeSession.retryJson(fixPrompt);
      deriveAppServer();
    } else {
      const retry = await runCodexOnce({ ...runOpts, prompt: fixPrompt, resumeId: threadId });
      attempts += 1;
      addUsage(usage, usageOf(retry.events));
      addStats(stats, commandStats(retry.events));
      if (retry.code === 0) retryMsg = retry.lastMessage;
    }
    if (retryMsg != null) {
      parsed = parseJsonMessage(retryMsg);
      errors = parsed.value ? validate(parsed.value, schema) : [parsed.error];
    }
  }
  // Checked after the seat's last turn (the JSON retry included) and before any verdict is kept.
  if (snap) {
    const changed = snapshotTampering(snap);
    if (changed) return fail('tampered', `reader seat changed its read-only snapshot (${changed}) — its verdict is discarded`);
  }
  if (errors.length) return fail('failed', `final message invalid after retry: ${errors.slice(0, 5).join('; ')}`);
  const data = parsed.value;

  let md;
  let summary = {};
  if (spec.kind === 'review') {
    const verdictCorrected = enforceReview(data);
    md = renderReview(data, { role, round, template: flags.template, verdictCorrected });
    const counts = countBySeverity(data.findings);
    summary = { verdict: data.verdict, critical: counts.CRITICAL, high: counts.HIGH, medium: counts.MEDIUM, low: counts.LOW, verdict_corrected: !!verdictCorrected };
  } else if (spec.kind === 'closure') {
    const table = findingsTableOf(readJson(flags['findings-table']));
    const tableIds = new Set(table.map((f) => f.id));
    // Only ids from the table count: a hallucinated CLOSED for an unknown id, or a duplicate
    // row, must not inflate the closure counts the round verdict is computed from.
    const seen = new Set();
    const kept = [];
    for (const c of data.closures) {
      if (!tableIds.has(c.id)) { warn(`closure verdict for unknown finding ${c.id} ignored`); continue; }
      if (seen.has(c.id)) { warn(`duplicate closure verdict for ${c.id} ignored`); continue; }
      seen.add(c.id); kept.push(c);
    }
    data.closures = kept;
    const missing = table.map((f) => f.id).filter((id) => !seen.has(id));
    md = renderClosure(data, { role, round, missing });
    const c = closureCounts(data, missing);
    // The reopened item ids for the oscillation ledger (warm-closure.md §3): each seat id maps
    // to the item it was merged into at DEDUPE (`item ?? id`); a REOPENED verdict and an
    // unverdicted (missing → skeptical-default REOPENED) id both count. Deduped to distinct
    // item ids (first-seen order) so two seats merged into one item write it once — a repeat
    // would misstate the reopen count for any consumer summing the array. Every missing id
    // comes from the table, so itemOf.get(id) is always defined there.
    const itemOf = new Map(table.map((f) => [f.id, f.item ?? f.id]));
    const reopened_items = [...new Set([
      ...kept.filter((x) => x.verdict === 'REOPENED').map((x) => itemOf.get(x.id) ?? x.id),
      ...missing.map((id) => itemOf.get(id)),
    ])];
    summary = { closed: c.CLOSED, reopened: c.REOPENED, decline_accepted: c['DECLINE-ACCEPTED'], not_mine: c['NOT-MINE'], new_fix_introduced: data.new_fix_introduced.length, missing_ids: missing, reopened_items };
  } else if (spec.kind === 'clarify') {
    md = renderClarify(data, { role, round, finding: flags.finding });
    summary = { answered: !!data.answer };
  } else if (spec.kind === 'implement') {
    // A writer's JSON is a claim; the worktree is the evidence. Every reported sha must be a
    // commit in --baseline..HEAD, and the numstat comes from git, not from the model.
    const actual = gitCommitsSince(cwd, flags.baseline);
    if (actual === null) return fail('failed', `cannot list commits ${flags.baseline}..HEAD in ${cwd}`);
    const unknown = data.commits.filter((c) => !(c.sha.length >= 7 && actual.some((a) => a.sha.startsWith(c.sha) || c.sha.startsWith(a.sha)))).map((c) => c.sha);
    if (unknown.length) return fail('failed', `reported commit(s) not found in ${flags.baseline}..HEAD: ${unknown.join(', ')} — the report is not evidence`);
    const numstat = gitNumstat(cwd, flags.baseline);
    // A direction that asked for verify_first probes must get them back: list the finding ids
    // named in a `verify_first` line of the direction that have no probe row in the report.
    if (flags.template === 'fix' && flags.direction) {
      const dir = readFileSync(resolve(flags.direction), 'utf8');
      const asked = new Set();
      for (const block of dir.split(/^##\s+/m).slice(1)) {
        if (!/verify_first/i.test(block)) continue;
        const m = block.match(/\b([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+|[A-Z]{2,}-\d+|[A-Z]+\d+)\b/g);
        for (const id of m || []) asked.add(id);
      }
      const have = new Set((Array.isArray(data.verify_first) ? data.verify_first : []).map((p) => p.id));
      const missing = [...asked].filter((id) => !have.has(id));
      if (missing.length) data.verify_first_missing = missing;
    }
    const gaps = countBy(data.plan_gaps, 'kind');
    md = renderImplement(data, { role, round, template: flags.template, batch: flags.batch, baseline: flags.baseline, actual, numstat });
    summary = {
      commits: actual.length, commits_reported: data.commits.length, files_changed: numstat.length, dirty: gitDirtyCount(cwd),
      acceptance: countBy(data.acceptance, 'status'),
      plan_gaps_semantic: gaps.semantic || 0, plan_gaps_cosmetic: gaps.cosmetic || 0,
      verify_first_probes: Array.isArray(data.verify_first) ? data.verify_first.length : 0, verify_first_missing: (data.verify_first_missing || []).length,
      declined: data.declined.length, scope_violations: data.scope_violations.length, blockers: data.blockers.length,
    };
  } else {
    const corrected = enforcePlan(data);
    md = renderPlan(data, { planPath: flags.plan, round, corrected });
    const counts = countBySeverity(data.findings);
    summary = { verdict: data.verdict, overall_risk: data.overall_risk, critical: counts.CRITICAL, high: counts.HIGH, medium: counts.MEDIUM, low: counts.LOW, open_questions: data.open_questions.length, verdict_corrected: !!corrected };
  }
  writeFileSync(mdPath, md);
  // App-server writer result fields: the line's `status` IS the outcome (ok / wrapped-up /
  // interrupted-reported all exit 0, the artifact and verified commits on disk). compactions>1
  // (oversized) is the batch-split signal; idle_max_ms / steer_sent / interrupt_sent / context
  // diagnose the run. Reviewer and exec-writer lines carry only transport.
  const asFields = appServer ? {
    outcome: activeSession.outcome,
    compactions: sessions.reduce((a, s) => a + (s.compactions || 0), 0),
    idle_max_ms: Math.round(Math.max(0, ...sessions.map((s) => s.idleMaxMs || 0))),
    steer_sent: sessions.some((s) => s.steerSent),
    interrupt_sent: sessions.some((s) => s.interruptSent),
    context_fraction: activeSession.contextFraction ?? null,
  } : {};
  if (appServer) asFields.oversized = asFields.compactions > 1;
  const finalStatus = appServer ? activeSession.outcome : 'ok';
  const seatMeta = { role, template: flags.template, round: Number(round), tier: tier.name, model, effort, ...(serviceTier ? { service_tier: serviceTier } : {}), transport, ...(snap ? { read_sandbox: 'snapshot', snapshot_sha: snap.sha } : {}), ...asFields, status: finalStatus, wall_ms: nowMs() - started, tokens_in: usage.tokens_in, tokens_out: usage.tokens_out, tokens_reasoning: usage.tokens_reasoning, thread_id: threadId };
  writeFileSync(jsonPath, `${JSON.stringify({ ...data, _seat: seatMeta }, null, 2)}\n`);
  try { rmSync(outFile); } catch { /* keep going */ }

  const tokens = usage.tokens_in == null && usage.tokens_out == null ? null : (usage.tokens_in ?? 0) + (usage.tokens_out ?? 0);
  const wallMs = nowMs() - started;
  if (process.env.RUN_LOG && !flags['no-log']) {
    logLedger(spec, flags, { role, round, threadId, usage, tokens, wallMs, mdPath, summary, model, effort, serviceTier, tier: tier.name, stats, attempts, started: Number(flags.started) || started, transport, readSandbox: readSandbox === 'snapshot' ? 'snapshot' : null, ...(appServer ? asFields : {}) });
  }
  emit({
    ...base,
    ...summary,
    thread_id: threadId,
    path: flags.resume ? 'warm' : 'cold',
    ...usage,
    tokens,
    commands_run: stats.run,
    commands_ok: stats.ok,
    wall_ms: wallMs,
    model,
    effort,
    ...asFields,
    json: jsonPath,
    status: finalStatus,
  });
  return 0;
  } finally {
    if (activeSession) { try { await activeSession.close(); } catch { /* already gone */ } }
    if (snap) removeSnapshot(cwd, snap.dir);
  }
}

/** One sf-log event per delivered seat (spawn-accounting.md; review-backend.md §Accounting):
 *  `spawn` for cold templates, `closure-exchange` for closure and plan re-review, `clarify`
 *  for clarification — always backend=codex, so a mixed panel segments in /ship-report. */
function logLedger(spec, flags, x) {
  const common = ['backend=codex', `started=${x.started}`, `artifact=${x.mdPath}`, `commands_run=${x.stats.run}`, `commands_ok=${x.stats.ok}`];
  if (x.tokens != null) common.push(`tokens=${x.tokens}`);
  for (const k of ['tokens_in', 'tokens_cached', 'tokens_out', 'tokens_reasoning']) if (x.usage[k] != null) common.push(`${k}=${x.usage[k]}`);
  if (x.threadId) common.push(`agent_id=${x.threadId}`);
  // The reviewed range names the exact commit a seat judged (reviewer-prompts.md `{diff_range}`
  // ends at a captured sha, never HEAD); attempts lets ship-report tell a retried seat's
  // doubled context re-read from a single long one.
  if (flags.range) common.push(`range=${flags.range}`);
  if (x.readSandbox) common.push(`read_sandbox=${x.readSandbox}`);
  // Every 3e event inside an epic phase carries epic_phase=<id> so sf-log's round-namespaced
  // checks (fixer↔direction-review, adjudication, oscillation-stop) do not collide across phases
  // that reuse round numbers (spawn-accounting.md; ship-task 3e).
  if (flags['epic-phase'] !== undefined) common.push(`epic_phase=${flags['epic-phase']}`);
  if (x.attempts) common.push(`attempts=${x.attempts}`);
  let args;
  if (spec.kind === 'closure') {
    args = ['stage', 'closure-exchange', `role=${x.role}:closure`, `round=${x.round}`, 'path=warm',
      `findings_closed=${x.summary.closed}`, `findings_reopened=${x.summary.reopened}`,
      `findings_decline_accepted=${x.summary.decline_accepted}`, `findings_not_mine=${x.summary.not_mine}`,
      `reopened_ids=${JSON.stringify(x.summary.reopened_items ?? [])}`];
  } else if (spec.kind === 'clarify') {
    args = ['stage', 'clarify', `role=${x.role}:clarify`, `round=${x.round}`, `finding=${flags.finding}`, 'answered=true', 'path=warm'];
  } else if (flags.template === 'plan-rereview') {
    args = ['stage', 'closure-exchange', `role=${x.role}:rereview`, `round=${x.round}`, 'path=warm', `verdict=${x.summary.verdict}`];
  } else {
    const phase = flags.phase || (spec.kind === 'plan' ? 'plan' : spec.kind === 'implement' ? (flags.template === 'fix' ? 'fix' : 'implement') : 'review');
    // agent_type is "the thing that ran": codex-app-server for app-server writer seats, codex-exec
    // otherwise. /ship-report segments on backend=codex (unchanged), so rows stay comparable.
    const agentType = x.transport === 'app-server' ? 'codex-app-server' : 'codex-exec';
    args = ['spawn', `role=${x.role}`, `agent_type=${agentType}`, `model=${x.model}`, `tier=${x.tier}`,
      `phase=${phase}`, `round=${x.round}`, `duration_ms=${x.wallMs}`];
    if (x.effort) args.push(`effort=${x.effort}`);
    if (x.serviceTier) args.push(`service_tier=${x.serviceTier}`);
    if (spec.kind === 'implement') {
      args.push(`transport=${x.transport}`, `commits=${x.summary.commits}`, `dirty=${x.summary.dirty}`, `plan_gaps_semantic=${x.summary.plan_gaps_semantic}`, `plan_gaps_cosmetic=${x.summary.plan_gaps_cosmetic}`, `blockers=${x.summary.blockers}`, `scope_violations=${x.summary.scope_violations}`);
      if (x.transport === 'app-server') args.push(`outcome=${x.outcome}`, `compactions=${x.compactions}`, `oversized=${x.oversized}`, `idle_max_ms=${x.idle_max_ms}`, `steer_sent=${x.steer_sent}`, `interrupt_sent=${x.interrupt_sent}`);
      if (flags.template === 'fix') {
        args.push(`direction=${flags.direction ? 'true' : 'false'}`);
        // The count of items merging more than one finding — the direction-review trigger and
        // what sf-log's fixers_without_direction_review check reads (ship-task 3e step 2b).
        if (flags['merged-items'] !== undefined) args.push(`merged_items=${flags['merged-items']}`);
        // The item ids in this fixer's bucket (validated at parse) — findings= is what sf-log's
        // fixers_on_stopped_findings reads to catch a stopped id that re-entered (warm-closure.md §3).
        if (flags['finding-ids'] !== undefined) args.push(`findings=${flags['finding-ids']}`);
      }
    }
  }
  try {
    execFileSync(process.execPath, [SF_LOG, ...args, ...common], { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch (e) {
    warn(`sf-log ${args[0]} failed for ${x.role}: ${e.message}`);
  }
}

// =============================================================================
// panel — fan a roster out concurrently, one child `review` per seat
// =============================================================================
const PANEL_ONLY_FLAGS = new Set(['roster', 'seats', 'pin', 'artifact-dir', 'max-parallel', 'routed-only', 'summary', 'compact', 'help']);
// Per-seat values the panel computes itself; passing them would make every seat share one.
const PANEL_REJECTED_FLAGS = ['artifact', 'role', 'seat', 'resume', 'findings-table', 'finding', 'question'];

function rosterFrom(flags) {
  if (flags.seats) return flags.seats.split(',').map((s) => s.trim()).filter(Boolean);
  if (!flags.roster) die('panel needs --roster <route.json> or --seats <a,b,c>');
  const r = readJson(flags.roster);
  if (r.reviewers) {
    // --routed-only: express runs drop the architecture and security baselines here (ship-task 3d
    // pins security-reviewer on its own); sf-route does not know about express, so its roster
    // file still lists them. failure-over-time is kept: express never skips that seat.
    const baselines = r.reviewers.baselines || [];
    return flags['routed-only']
      ? [...(r.reviewers.routed || []), ...baselines.filter((b) => b === 'failure-over-time')]
      : [...(r.reviewers.routed || []), ...baselines];
  }
  if (Array.isArray(r.roster)) return r.roster;
  die(`--roster ${flags.roster}: neither sf-route classify (.reviewers) nor cold-roster (.roster) output`);
}

function roleFor(seat) {
  if (seat === 'security-reviewer') return 'reviewer:security';
  return `reviewer:${seat}`;
}

async function cmdPanel(flags) {
  if (!flags['artifact-dir']) die('--artifact-dir <dir> is required');
  if (!flags.template) die('--template is required');
  if (TEMPLATES[flags.template]?.write) die(`panel runs review templates only — ${flags.template} is a one-call seat (N concurrent writers in one worktree is never what you want)`);
  for (const f of PANEL_REJECTED_FLAGS) if (flags[f] !== undefined) die(`--${f} is per-seat; panel computes it — pass it to \`review\` directly instead`);
  // A bad panel-wide override is a usage error HERE, before any seat runs — otherwise every
  // child dies exit 1, the panel reports "every seat failed", and the skill falls back to Claude.
  if (flags.tier !== undefined) checkTierName(String(flags.tier));
  checkEffort(flags.effort, '--effort');
  const pins = new Set((flags.pin || '').split(',').map((s) => s.trim()).filter(Boolean));
  const all = rosterFrom(flags);
  const seats = [...new Set(all)].filter((s) => !pins.has(s));
  const pinned = all.filter((s) => pins.has(s));
  const round = flags.round ?? '1';
  const startedAll = Number(flags.started) || nowMs();
  if (!flags.started) flags.started = String(startedAll); // children log the batch envelope (spawn-accounting.md)
  const maxParallel = Math.floor(numFlag(flags, 'max-parallel', DEFAULT_MAX_PARALLEL));
  const artifactDir = resolve(flags['artifact-dir']);
  mkdirSync(artifactDir, { recursive: true });
  // The summary file is the completion signal for a backgrounded panel (artifact handoff:
  // the orchestrator reads a file, never stdout). Removed first so a stale one cannot be read.
  const summaryPath = resolve(flags.summary || join(artifactDir, `panel-${flags.template}-r${round}.json`));
  rmSync(summaryPath, { force: true });
  const forward = [];
  for (const [k, v] of Object.entries(flags)) {
    if (PANEL_ONLY_FLAGS.has(k)) continue;
    if (v === true) forward.push(`--${k}`);
    else forward.push(`--${k}`, String(v));
  }

  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < seats.length) {
      const seat = seats[cursor++];
      const role = roleFor(seat);
      const artifact = join(artifactDir, `review-${roleName(role)}-r${round}`);
      const seatArg = BARE_TEMPLATE_SEATS.has(seat) ? 'none' : seat;
      const args = [SCRIPT_PATH, 'review', '--role', role, '--seat', seatArg, '--artifact', artifact, ...forward];
      const t0 = nowMs();
      const line = await new Promise((res) => {
        const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('close', (code) => {
          const last = out.trim().split('\n').filter(Boolean).pop();
          let obj;
          // exit 1 with no result line is a usage/config error in the seat's own call (missing
          // seat file, bad flag) — never a Codex failure, so never a Claude-fallback signal.
          try { obj = JSON.parse(last); } catch { obj = { role, status: code === 1 ? 'usage-error' : 'failed', detail: `no result line (exit ${code})`, artifact: `${artifact}.md`, wall_ms: nowMs() - t0 }; }
          obj.exit = code;
          res(obj);
        });
      });
      results.push(line);
      process.stdout.write(`${JSON.stringify(line)}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxParallel, seats.length) }, worker));
  const ok = results.filter((r) => r.status === 'ok').length;
  const usageErrors = results.filter((r) => r.status === 'usage-error').map((r) => r.role);
  const summary = { panel: true, template: flags.template, round: Number(round), seats, pinned, delivered: ok, failed: results.filter((r) => r.status !== 'ok' && r.status !== 'usage-error').map((r) => r.role), usage_errors: usageErrors, wall_ms: nowMs() - startedAll, summary: summaryPath };
  writeFileSync(summaryPath, `${JSON.stringify({ ...summary, results }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (usageErrors.length) { warn(`usage error in ${usageErrors.join(', ')} — fix the call; this is not a Codex failure`); return 1; }
  return seats.length && ok === 0 ? 2 : 0;
}

// =============================================================================
// home — isolated CODEX_HOME per run (auth shared, thread store private)
// =============================================================================
function cmdHome(positional, flags) {
  const verb = positional[0];
  const root = join(homedir(), '.cache', 'sf-codex');
  if (verb === 'init') {
    const runId = String(flags.run || nowMs());
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || runId === '.' || runId === '..') die(`--run must be a plain id (letters, digits, . _ -), got ${JSON.stringify(runId)}`);
    const home = join(root, runId);
    mkdirSync(home, { recursive: true });
    const source = process.env.CODEX_HOME && !process.env.CODEX_HOME.startsWith(root) ? process.env.CODEX_HOME : join(homedir(), '.codex');
    const auth = join(source, 'auth.json');
    if (!existsSync(auth)) die(`no Codex credentials at ${auth} — run \`codex login\` first`);
    const target = join(home, 'auth.json');
    if (!existsSync(target)) {
      try { symlinkSync(auth, target); } catch { copyFileSync(auth, target); }
    }
    const cfgPath = join(home, 'config.toml');
    if (!existsSync(cfgPath)) {
      const userCfg = readFileSafe(join(source, 'config.toml'));
      const model = flags.model || tomlTopString(userCfg, 'model') || 'gpt-6.1-sol';
      const effort = checkEffort(flags.effort, '--effort') || tomlTopString(userCfg, 'model_reasoning_effort') || 'medium';
      // service_tier is a billing/priority setting the user chose for their own sessions; a
      // run home that drops it silently moves every seat to the API default.
      const serviceTier = tomlTopString(userCfg, 'service_tier');
      // sandbox_mode pinned: a resumed thread cannot take -s and would otherwise inherit codex's
      // workspace-write default, which landlock refuses (blind closure seats).
      const lines = [`model = "${model}"`, `model_reasoning_effort = "${effort}"`, 'sandbox_mode = "read-only"'];
      if (serviceTier) lines.push(`service_tier = "${serviceTier}"`);
      writeFileSync(cfgPath, `# generated by sf-codex home init — per-run isolated CODEX_HOME\n${lines.join('\n')}\n`);
    }
    if (!flags['no-sandbox-probe']) sandboxProbe(home, cfgPath);
    process.stdout.write(`${home}\n`);
    return 0;
  }
  if (verb === 'gc') {
    const days = Number(flags['older-than'] || 7);
    if (!existsSync(root)) return 0;
    const cutoff = nowMs() - days * 86400000;
    let removed = 0;
    for (const d of readdirSync(root)) {
      const p = join(root, d);
      try {
        if (statSync(p).mtimeMs < cutoff) { rmSync(p, { recursive: true, force: true }); removed += 1; }
      } catch { /* skip */ }
    }
    process.stdout.write(`removed ${removed} run home(s) older than ${days}d under ${root}\n`);
    return 0;
  }
  die('home <init|gc>');
}

function readFileSafe(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

/** Can codex's Linux sandbox actually run a command here? Bubblewrap needs unprivileged user
 *  namespaces, which devcontainers commonly forbid — every seat command then fails with
 *  "bwrap: No permissions to create a new namespace" while the model keeps answering. The
 *  deprecated landlock backend needs no namespaces and still enforces read-only (verified:
 *  write to /tmp denied), so enable it in the run home's config when bwrap cannot start.
 *  Neither working (codex >= 0.156 refuses landlock-only restriction) → reader seats switch to
 *  disposable snapshots (readSandboxFor), recorded in the run home's sf-sandbox.json;
 *  SF_CODEX_SNAPSHOT_FALLBACK=0 makes that case exit 1 instead (the caller's preflight-failed). */
function sandboxProbe(home, cfgPath) {
  const marker = join(home, SANDBOX_MARKER);
  if (process.platform !== 'linux') { rmSync(marker, { force: true }); return 'native'; }
  const run = (extra) => {
    const r = spawnSync('codex', ['sandbox', ...extra, '--', '/bin/true'], { env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 60000 });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const lines = out.trim().split('\n').filter(Boolean);
    // A panic prints its reason on the line after the "panicked at" header, then a backtrace hint.
    const reason = lines.find((l, i) => i > 0 && /panicked at/.test(lines[i - 1])) || lines.pop() || `exit ${r.status}`;
    return { ok: r.status === 0 && !/bwrap:|No permissions to create a new namespace|panicked at/.test(out), out: reason };
  };
  const bwrap = run([]);
  if (bwrap.ok) { rmSync(marker, { force: true }); return 'bwrap'; }
  const landlock = run(['--enable', 'use_legacy_landlock']);
  if (!landlock.ok) {
    const why = `bwrap → ${bwrap.out}; landlock → ${landlock.out}`;
    if (process.env.SF_CODEX_SNAPSHOT_FALLBACK === '0') die(`no working codex sandbox: ${why}`);
    writeFileSync(marker, `${JSON.stringify({ reader: 'snapshot', reason: why, probed: new Date().toISOString() }, null, 2)}\n`);
    warn(`sandbox backend = snapshot — no working codex sandbox (${why}); reader seats run unsandboxed in a disposable worktree and a seat that changes it is discarded`);
    return 'snapshot';
  }
  rmSync(marker, { force: true });
  const cfg = readFileSafe(cfgPath);
  if (!/use_legacy_landlock\s*=\s*true/.test(cfg)) {
    writeFileSync(cfgPath, `${cfg.trimEnd()}\n\n# bwrap cannot create user namespaces here (sf-codex sandbox probe); the landlock backend can.\n[features]\nuse_legacy_landlock = true\n`);
  }
  warn(`sandbox backend = landlock (bwrap: ${bwrap.out})`);
  return 'landlock';
}

/** Bump the run home's mtime so `home gc --older-than` measures the last seat, not `init`. */
function touchHome(home) {
  if (!home) return;
  try { const now = new Date(); utimesSync(home, now, now); } catch { /* not ours, or gone */ }
}

// =============================================================================
// main
// =============================================================================
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || flags.help) { process.stdout.write(HELP); return 0; }
  switch (cmd) {
    case 'review': return cmdReview(flags);
    // Writer seats share the engine; the verb FIXES the template (an explicit
    // --template that differs is a usage error) and supplies the default role.
    case 'implement': case 'fix': {
      const roleFor = { implement: 'implementer', fix: 'fixer' };
      if (flags.template !== undefined && flags.template !== cmd) die(`sf-codex ${cmd}: --template ${flags.template} conflicts with the verb — use \`sf-codex review\` for review templates`);
      // Fail before spawning a seat: --merged-items reaches sf-log's direction-review gate, so a
      // malformed count must not survive to the ledger row.
      // Reject leading zeros too (007): sf-log parses merged_items as a JSON number, where a
      // leading zero is invalid, so the value would arrive as a string and its ledger row be
      // silently refused after the seat already ran.
      if (cmd === 'fix' && flags['merged-items'] !== undefined && !/^(0|[1-9]\d*)$/.test(String(flags['merged-items']))) {
        die(`--merged-items must be a non-negative integer (got ${JSON.stringify(flags['merged-items'])})`);
      }
      // --finding-ids reaches sf-log's oscillation guard as findings= on the fixer's spawn row;
      // a malformed value must not survive to the ledger (it would silently blind the guard).
      if (cmd === 'fix' && flags['finding-ids'] !== undefined) {
        let ids;
        try { ids = JSON.parse(flags['finding-ids']); } catch { ids = undefined; }
        if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string' || x.length === 0)) {
          die(`--finding-ids must be a JSON array of non-empty strings (got ${JSON.stringify(flags['finding-ids'])})`);
        }
      }
      return cmdReview({ role: roleFor[cmd], ...flags, template: cmd });
    }
    case 'panel': return cmdPanel(flags);
    case 'home': return cmdHome(positional, flags);
    case 'seat-file': {
      const p = resolveSeatFile(positional[0], flags.cwd ? resolve(flags.cwd) : process.cwd());
      if (!p) die(`no seat file for "${positional[0]}"`, 1);
      process.stdout.write(`${p}\n`);
      return 0;
    }
    case 'templates': {
      // Resolves every template for real (heading lookup + cut marker), so a renamed heading
      // or trailing paragraph in the shared prompt files fails HERE, not mid-review on a seat.
      let bad = 0;
      for (const [k, v] of Object.entries(TEMPLATES)) {
        let status = 'ok';
        try {
          let body = loadTemplate(v.file, v.heading);
          if (v.cutFrom) body = cutFrom(body, v.cutFrom);
          if (!body.trim()) throw new Error('empty template');
          JSON.parse(readFileSync(join(SCHEMA_DIR, v.schema), 'utf8'));
        } catch (e) { status = `BROKEN: ${e.message}`; bad += 1; }
        process.stdout.write(`${k.padEnd(14)} ${v.kind.padEnd(8)} ${v.schema}${v.resumeOnly ? '  (resume only)' : ''}  ← ${v.file} §${v.heading}  [${status}]\n`);
        // bounded: the fixed baseline headings of one template
        for (const [seat, heading] of Object.entries(v.baselines || {})) {
          let bstatus = 'ok';
          try {
            if (!loadTemplate(v.file, heading).trim()) throw new Error('empty template');
          } catch (e) { bstatus = `BROKEN: ${e.message}`; bad += 1; }
          process.stdout.write(`${`${k}:${seat}`.padEnd(14)} ${v.kind.padEnd(8)} ${v.schema}  ← ${v.file} §${heading}  [${bstatus}]\n`);
        }
      }
      return bad ? 1 : 0;
    }
    default:
      die(`unknown command "${cmd}"\n${HELP}`);
  }
}

main().then((code) => process.exit(code ?? 0), (e) => die(e.stack || String(e)));
