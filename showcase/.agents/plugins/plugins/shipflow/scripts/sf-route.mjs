#!/usr/bin/env node
/**
 * @file sf-route.mjs
 * @description Mechanical file classification + reviewer routing for the shipflow ship-* skills.
 *   Encodes the file-classification and reviewer-routing judgment from
 *   skills/shared/reviewer-routing.md: classifies a changed-file list into test / meta / prod,
 *   derives workspaces, the contract-seam list, the routed domain reviewers, the baseline
 *   reviewers (security / architecture / performance gates), test-only narrowing, and express
 *   eligibility. The routed list is capped at the panel cap; a failure-over-time baseline fires
 *   when the changed prod lines touch concurrency, queues, durable steps or retries; `live_check`
 *   reports whether the repo (`.shipflow.json`) says the change owes a live dev run.
 *   `cold-roster` derives the fix-round cold regression roster from the fix commits.
 *   `fix-trend` reads the audit log's triage rows and says when the fix loop must re-plan.
 *   `ac-scan` flags acceptance criteria written as universal claims (no/any/all/never/always/
 *   100%) with no structural guard or pinned fixture set — the goal-post tripwire ship-task
 *   Stage 2 runs before a plan is drafted (rationale.md §Plan loop, "unbounded ACs").
 *   `batches` turns a plan's tasks (id, scope, depends_on) into the 3b implementation batches:
 *   dependency layers, a layer's seam tasks as a serial batch that lands first, and each
 *   batch's gate reason from sf-parallel-gate.mjs.
 *   Zero dependencies; JSON on stdout. The ROUTING_TABLE constant below is the executable
 *   source of truth — reviewer-routing.md documents it.
 * @domain workflow-routing
 *
 * Usage:
 *   sf-route classify   [--diff <git range>] [--files <path|->] [--bound N] [--panel-cap N] [--config-ref <ref>] [--cwd <dir>] [--compact] [file ...]
 *   sf-route cold-roster [--diff <git range>] [--files <path|->] [--had-high] [--cap N] [--cwd <dir>] [--compact] [file ...]
 *   sf-route ac-scan     --file <markdown> [--fail-on-unbounded] [--compact]
 *   sf-route fix-trend   --log <path> [--epic-phase <id>] [--compact]
 *   sf-route batches     --tasks <json file|-> [--no-scratch] [--compact]
 *
 * File list sources (union): positional args, --files (newline-separated file, or `-` for
 * stdin), --diff <range> (runs `git -C <cwd> diff --name-only <range>`). Paths are repo-relative.
 *
 * Requires Node >= 18.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILE, loadRepoConfigAt, tryLoadRepoConfig } from './sf-config.mjs';
import { ALL_HOLD, GATE_REASONS } from './sf-parallel-gate.mjs';

// =============================================================================
// ROUTING TABLE — mirrors skills/shared/reviewer-routing.md row order.
// The .md documents THIS constant; edit here first, then update the prose.
// Patterns are unanchored regex searches unless they carry an explicit `^`.
// The paths are CONVENTIONS, not a specific repo: retarget them to your layout here (one
// table) and every skill, gate and roster follows.
// Notes:
//   - frontend-reviewer fires on BOUNDARY files (routes/pages/layouts, server actions,
//     framework config, middleware); plain components route to ux-consistency-lead.
//   - test-coverage-guardian (45): fires only when a PROD file matches AND the diff carries
//     no test-class file (`prodOnly` + `requiresNoTestFiles`).
// =============================================================================
const CODE = '(ts|tsx|js|jsx|mjs|cjs|py|go|rb|rs|java|kt)';
const UI = '(tsx|jsx|vue|svelte)';
const ROUTING_TABLE = [
  {
    // Same definition as the `auth` seam category below (a directory or filename that STARTS
    // with one of the words) — kept as literals because this table is evaluated first.
    reviewer: 'security-reviewer',
    priority: 100,
    patterns: [
      new RegExp(`(^|/)(auth|authentication|login|session|password|credential|token|secret)[^/]*/.*\\.${CODE}$`),
      new RegExp(`(^|/)(auth|authentication|login|session|password|credential|token|secret)[^/]*\\.${CODE}$`),
    ],
  },
  {
    reviewer: 'prompt-reviewer',
    priority: 90,
    patterns: [
      /\.claude\/agents\/.*\.md$/,
      /(^|\/)agents\/[^/]+\.md$/,
      new RegExp(`(^|/)agents?/.*\\.${CODE}$`),
      /(^|\/)prompts?\/.*\.(ts|js|py|md|txt|ya?ml|json)$/,
      /\.prompt\.[a-z]+$/,
      new RegExp(`(^|/)(llm|ai)/.*\\.${CODE}$`),
    ],
  },
  {
    reviewer: 'database-reviewer',
    priority: 80,
    patterns: [/\.(sql|pgsql)$/, /(^|\/)migrations?\//, /(^|\/)prisma\//, /(^|\/)(db|database)\/(src\/)?schema/, /(^|\/)schema\.prisma$/],
  },
  {
    reviewer: 'backend-reviewer',
    priority: 77,
    patterns: [new RegExp(`(^|/)(server|api|handlers?|functions|services|workers?|jobs)/.*\\.${CODE}$`)],
  },
  {
    // Infrastructure definitions only — application code that happens to live near infra
    // stays with backend-reviewer (77).
    reviewer: 'infra-reviewer',
    priority: 75,
    patterns: [
      /(^|\/)(infra|infrastructure|terraform|cdk|k8s|kubernetes|helm|deploy)\//,
      /\.(tf|tfvars)$/,
      /-stack\.(ts|js)$/,
      /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/,
      /^\.github\/workflows\//,
      /(^|\/)iam\//,
    ],
  },
  {
    // BOUNDARY patterns only — see header note.
    reviewer: 'frontend-reviewer',
    priority: 65,
    patterns: [
      new RegExp(`(^|/)(app|pages|routes)/.*\\.${UI}$`),
      new RegExp(`(^|/)(app|pages|routes)/.*/(layout|page|loading|error|not-found|\\+page|\\+layout)\\.(tsx|ts|svelte)$`),
      /(^|\/)(actions|queries|loaders)\/.*\.(ts|js)$/,
      /(^|\/)(next|vite|nuxt|svelte|astro|remix)\.config\.(js|mjs|cjs|ts)$/,
      /(^|\/)(middleware|proxy)\.(ts|js)$/,
    ],
  },
  {
    reviewer: 'ux-consistency-lead',
    priority: 60,
    patterns: [new RegExp(`(^|/)components/.*\\.${UI}$`), /(^|\/)styles?\//, /\.(css|scss|sass|less)$/, /tailwind\.config/],
  },
  {
    reviewer: 'api-contract-reviewer',
    priority: 50,
    patterns: [/\.graphql$/, /\.gql$/, /(^|\/)openapi[^/]*\.(ya?ml|json)$/, /\.proto$/, /^packages\/(shared|contracts?|types|schemas?)[^/]*\//],
  },
  {
    // Coverage nudge: prod UI/server code changed and NO test file came with it.
    reviewer: 'test-coverage-guardian',
    priority: 45,
    patterns: [new RegExp(`\\.${UI}$`), new RegExp(`(^|/)(src|server|api|handlers?|functions|services|lib)/.*\\.${CODE}$`)],
    prodOnly: true,
    requiresNoTestFiles: true,
  },
  {
    reviewer: 'test-coverage-guardian',
    priority: 35,
    patterns: [/.*\.(test|spec)\.(ts|tsx|js|jsx|mjs|py)$/, /.*\/tests?\/.*/, /.*playwright.*/, /(^|\/)e2e\//],
  },
];

// Path predicates for the cross-domain rule in route().
const IS_FRONTEND = (f) => new RegExp(`\\.${UI}$`).test(f) || /^(apps\/)?(web|frontend|client|ui)\//.test(f);
const IS_API_SURFACE = (f) => /\.(graphql|gql|proto)$/.test(f) || /(^|\/)openapi[^/]*\.(ya?ml|json)$/.test(f) || /(^|\/)(resolvers|api)\//.test(f);
const IS_BACKEND = (f) => new RegExp(`(^|/)(server|api|handlers?|functions|services|workers?)/.*\\.${CODE}$`).test(f) || /^(apps\/)?(api|server|backend)\//.test(f);
const IS_SHARED_CONTRACT = (f) => /^packages\/(shared|contracts?|types|schemas?)[^/]*\//.test(f);

// ---- Three-class split (reviewer-routing.md "Test-only diffs") ----------------
const TEST_PATTERNS = [/\.(test|spec)\.(ts|tsx|js|jsx|mjs|py)$/, /(^|\/)(tests?|__tests__)\//, /_test\.(go|py)$/];
const META_PATTERNS = [/^docs\//, /\.md$/, /(^|\/)typecheck-baseline[^/]*\.json$/];

// ---- SEAM LIST (canonical — the one place it lives) ---------------------------
// A prod file is a seam file when it matches any category. Category names are the output vocabulary.
const AUTH_WORDS = '(auth|authentication|login|session|password|credential|token|secret)';
const SEAM_CATEGORIES = [
  {
    name: 'auth',
    patterns: [
      // a DIRECTORY that starts with one of the words (route groups like `(auth)` start with `(` → no match)
      new RegExp(`(^|/)${AUTH_WORDS}[^/]*/.*\\.${CODE}$`),
      // a FILENAME that starts with one of the words
      new RegExp(`(^|/)${AUTH_WORDS}[^/]*\\.${CODE}$`),
    ],
  },
  { name: 'shared-contract', patterns: [/^packages\/(shared|contracts?|types|schemas?)[^/]*\//] },
  { name: 'barrel', patterns: [/^(packages|libs)\/[^/]+\/(src\/)?index\.(ts|js|mjs)$/] },
  { name: 'api-contract', patterns: [/\.(graphql|gql|proto)$/, /(^|\/)openapi[^/]*\.(ya?ml|json)$/, /(^|\/)resolvers\//] },
  { name: 'config', patterns: [/\.config\.(c|m)?(js|ts)$/, /^turbo\.json$/, /^nx\.json$/, /^tsconfig[^/]*\.json$/, /^\.shipflow\.json$/, /(^|\/)\.gitattributes$/] },
  { name: 'package', patterns: [/(^|\/)package\.json$/, /(^|\/)pyproject\.toml$/, /(^|\/)go\.mod$/, /(^|\/)Cargo\.toml$/] },
  { name: 'lockfile', patterns: [/package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|bun\.lockb?$|poetry\.lock$|uv\.lock$|go\.sum$|Cargo\.lock$/] },
  { name: 'migration', patterns: [/(^|\/)migrations?\//, /(^|\/)prisma\/schema\.prisma$/, /(^|\/)(db|database)\/(src\/)?schema/] },
];

// The standalone performance baseline seat is retired (0.33.0): across ten ship-task
// ledgers it returned PASS nine times at opus price with no CRITICAL/HIGH. Its checklist
// lives inside backend-reviewer and database-reviewer now (reviewer-routing.md).

const DEFAULT_EXPRESS_BOUND = 8;
const DEFAULT_EXPRESS_WORKSPACES = 3;
const DEFAULT_EXPRESS_LINES = 400;
const DEFAULT_COLD_CAP = 3;
// Routed domain seats beyond this many (highest priority first) go to reviewers.capped_out.
export const DEFAULT_PANEL_CAP = 3;

// Failure-over-time trigger (reviewer-routing.md §Baselines and gates). Matched against the
// added and removed lines of PROD files after normalizeForTerms: camel humps split into words,
// `_ . - /` read as spaces, lowercased — so `SendMessageCommand`, `MAX_RETRIES`, `branchCtx.step(`
// and `pg_advisory_xact_lock` reach the word-bounded terms while `blockId` ("block id"),
// `unlock` and `clock` never read as `lock`. RAW_TERMS match the unnormalized line.
// Content, not paths: path rules would be repo-specific.
export const FAILURE_OVER_TIME_TERMS = [
  ['lock', /\block(s|ed|ing)?\b/],
  ['FOR UPDATE', /\bfor\s+update\b/],
  ['SKIP LOCKED', /\bskip\s+locked\b/],
  ['advisory lock', /\badvisory\s+(xact\s+)?locks?\b|\bpg\s+advisory\b/],
  ['retry', /\bretr(y|ies|ied|ying|yable)\b/],
  ['backoff', /\bback\s?off\b/],
  ['lease', /\bleases?\b/],
  ['heartbeat', /\bheart\s?beats?\b/],
  ['visibility timeout', /\bvisibility\s+timeout\b/],
  ['queue message', /\b(send|receive|delete|change)\s+message\b/],
  ['MessageGroupId', /\bmessage\s+group\s+id\b/],
  ['dead-letter', /\bdead\s?letter\b/],
  ['DLQ', /\bdlq\b/],
  ['queue', /\bqueues?\b/],
  ['waitForCallback', /\bwait\s+for\s+callback\b/],
  ['durable', /\bdurable\b/],
  ['ctx.step', /\b(ctx|context)\s+step\b/],
  ['transaction', /\btransactions?\b/],
  ['BEGIN', /\bbegin\b/],
  ['COMMIT', /\bcommit\b/],
  ['ROLLBACK', /\brollback\b/],
  ['mutex', /\bmutex(es)?\b/],
  ['semaphore', /\bsemaphores?\b/],
  ['at-least-once', /\bat\s+least\s+once\b/],
  ['idempotent', /\bidempoten\w*/],
  ['concurrent', /\bconcurren\w*/],
];
// Forms the normalization would break apart: query-builder `.for('update')`, parallel fan-out.
export const FAILURE_OVER_TIME_RAW_TERMS = [
  ['FOR UPDATE', /\.for\(\s*['"`]update/],
  ['Promise.all', /\bPromise\.all(Settled)?\(/],
];

/** Split camel humps and acronym runs, read `_ . - /` as spaces, lowercase. */
export function normalizeForTerms(line) {
  return line
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_.\-/]/g, ' ')
    .toLowerCase();
}

/** Names of the failure-over-time terms one changed line matches. */
export function failureOverTimeTermsIn(line) {
  const norm = normalizeForTerms(line);
  const hits = [];
  for (const [name, re] of FAILURE_OVER_TIME_TERMS) if (re.test(norm)) hits.push(name);
  for (const [name, re] of FAILURE_OVER_TIME_RAW_TERMS) if (re.test(line) && !hits.includes(name)) hits.push(name);
  return hits;
}

// =============================================================================
// CLI plumbing
// =============================================================================
function die(msg, code = 2) {
  process.stderr.write(`sf-route: ${msg}\n`);
  process.exit(code);
}

const HELP = `sf-route — mechanical file classification + reviewer routing (shipflow)

Usage:
  sf-route classify    [--diff <git range>] [--files <path|->] [--bound N] [--max-workspaces N] [--max-lines N] [--panel-cap N] [--config-ref <ref>] [--cwd <dir>] [--compact] [file ...]
  sf-route cold-roster [--diff <git range>] [--files <path|->] [--had-high] [--cap N] [--cwd <dir>] [--compact] [file ...]
  sf-route ac-scan     --file <markdown> [--fail-on-unbounded] [--compact]
  sf-route fix-trend   --log <path> [--epic-phase <id>] [--compact]
  sf-route batches     --tasks <json file|-> [--no-scratch] [--compact]
  sf-route --help

File sources (union of all given): positional paths; --files <path> (newline-separated) or
--files - (stdin); --diff <range> → \`git -C <cwd> diff --name-only <range>\` (cwd default: process.cwd()).
Paths are repo-relative.

classify output (all keys always present):
  { files, classes:{test,meta,prod}, workspaces, seam:{touched,files},
    reviewers:{routed,capped_out,baselines,gates,narrowed,notes,evidence}, express, live_check }
  - classes:   test = *.test|spec.* or under tests/|test/|__tests__/; meta = docs/**, *.md,
               typecheck-baseline*.json; prod = everything else.
  - workspaces: distinct workspaces of PROD files (apps/<x>, packages/<x>,
               services/<x>, libs/<x>, tooling, <top-dir>, root).
  - seam:      prod files matching the canonical seam list (auth, shared-contract, barrel,
               api-contract, config, package, lockfile, migration).
  - reviewers.routed:    domain reviewers from the routing table, priority desc, deduped, capped
               at --panel-cap (default ${DEFAULT_PANEL_CAP}, >= 1); the rest go to reviewers.capped_out.
               A name that is also a baseline is not listed and never counts toward the cap;
               .shipflow.json review.cap_exempt names are seated uncapped; a config
               or ref error lifts the cap (every routed reviewer seated, with a note).
  - reviewers.baselines: security-reviewer always; architecture only when a seam is touched
               (workspace count alone never fires it — cross-workspace contract drift is
               api-contract-reviewer's row); failure-over-time when gates.failure_over_time
               fired. There is no performance seat (0.33.0).
  - gates.failure_over_time: scans the \`git diff --text -U0 <range>\` added/removed lines of
               PROD files for concurrency / queue / durable-step / retry terms (word-bounded
               after camelCase / snake_case / dotted names are split into lowercase words).
               Without --diff: fired:false, reason "no diff".
  - reviewers.narrowed:  "test-only" when >= 1 test file and 0 prod files (baselines dropped).
  - live_check: { declared, required, matched, instructions, dev_probe, note } from .shipflow.json
               \`live_check\`, read at --config-ref, else at the start of the --diff range, else
               the working tree (note "config-ref: worktree"); a differing worktree copy is a
               note. matched = prod files matching its paths; required = declared and matched
               is non-empty. A config or ref error gives required:true plus a note (fail
               closed; stderr warning), never an exit.
  - express:   mechanical conditions 1-3 only: bounded (prod+test files <= --bound, default
               ${DEFAULT_EXPRESS_BOUND}), few_workspaces (prod workspaces <= --max-workspaces, default
               ${DEFAULT_EXPRESS_WORKSPACES}), no_seam. With --diff a fourth, bounded_lines (added+deleted
               lines <= --max-lines, default ${DEFAULT_EXPRESS_LINES}), is measured from git numstat (a
               file numstat shows as \`-\` is counted from the --text diff);
               without a diff it is null and not judged. Conditions 4-5 (testable acceptance
               criteria, no open questions) are judged by the orchestrator from the task body — NOT here.

cold-roster output:
  seam touched AND --had-high → { mode:"warm+cold-panel", roster:"full-panel", reason, skippable:false }
  otherwise                   → { mode:"warm", roster:[...], floor_applied, skippable }
  roster = routed reviewers for the fix files, capped at --cap (default ${DEFAULT_COLD_CAP}, highest priority
  first); + security-reviewer with --had-high; a seam without --had-high adds api-contract-reviewer
  when routed, else security-reviewer; floor = ["security-reviewer"] when empty.
  skippable = no seam AND no test-class file AND not --had-high (skip the cold pass when every
  closure came back CLOSED).

fix-trend output:
  { epic_phase, rounds:[{round, must_fix, high, rereview_mode}], replan, replan_already_taken, reason }
  Reads the audit log in order: triage rows (must_fix = bucket1_fix_now, high = bucket1_high),
  keeping the LAST row per (epic_phase, round), plus scope-expansion notes and
  fix-seam-extension events. --epic-phase filters to one phase (required inside an epic);
  without it the phase of the log's last triage row is used. replan = true when the latest
  round has high > 0 and neither must_fix nor high fell from the previous round. No
  comparison when either row lacks bucket1_high, the previous row's rereview_mode is
  warm+cold-panel, a scope-expansion note lies between the two rows, or the latest round is
  the seam-extension round. replan_already_taken = a fix-replan note exists for this phase
  (any fix-replan note when the run has no phase); replan is then false.

ac-scan output:
  { file, criteria:[{n, section, text, universal:[...words], bound_markers:[...], heuristic:bool, bounded}],
    unbounded:[n...], counts:{criteria, universal, unbounded, heuristic_unbounded} }
  Reads every list item or paragraph under a heading or bold label containing "acceptance"
  (a nested sub-bullet and a wrapped line belong to the item above them; code fences are
  skipped; \`section\` is the heading the item sits under). A criterion is UNIVERSAL when it
  carries a universal quantifier (no/none/never/always/all/every/any/each/zero/100%/regardless/
  whenever/"only when|if|for") and UNBOUNDED when it is universal and names no bound: no
  \`guard:\`, \`fixture(s):\`, \`live:\`, "pinned", "regression/contract test", "lint rule"/"eslint", a
  *.test.* file, a hex id (>= 8 chars), or a backticked id-shaped token (hex run, a dotted or
  dashed code like \`12-34-56\`, or a >= 4-digit number). \`heuristic\` marks OCR / layout /
  classification / matching / ranking wording — the domain where an unbounded AC never
  converges. The scan is a
  tripwire for the orchestrator's Stage 2 bounding pass, not a verdict on the wording.
  --fail-on-unbounded → exit code 1 when counts.unbounded > 0 (the JSON is still written).

batches output:
  { batches:[{ id:"B<n>", tasks:[{id, scope, depends_on?}], seam_touched, parallelizable, parallelizable_reason }],
    unresolved_depends_on:[{task, id}] }
  --tasks is a JSON array of { id, scope:[paths], depends_on?:[ids] } (a file, or - for stdin).
  Each scope entry is a repository-relative file path; a leading ./ is stripped, and the
  stripped form is what the overlap and seam checks read and what the batch carries. An
  entry exits 2 when it holds a : (a finding's path:line) or a backtick, or ends in
  #L<digits> or in a parenthesised note after a space: scope takes the bare path.
  \`batches\` is the value \`sf-log stage task-decomposition batches=\` takes. A task joins the
  first dependency layer in which every depends_on id naming an input task sits in an earlier
  layer. An id naming no input task counts as done and is listed in unresolved_depends_on
  (empty when every id resolves). Per layer, in input order: the tasks whose
  scope holds a seam file form one serial batch emitted first; the rest form the next batch.
  parallelizable_reason is the first failed gate condition, in this order —
  ${GATE_REASONS.map((r) => `"${r}"`).join(', ')} —
  or "${ALL_HOLD}" (parallelizable:true). --no-scratch fails the first condition for every
  batch (a run that cannot cut scratch worktrees). Scopes overlap when two tasks name the same
  path, or one task's entry is a directory prefix of another's (scripts and scripts/a.mjs).
  A batch whose scopes overlap is not split.
  Exit 2: unreadable JSON, a duplicate id, an empty scope, a dependency cycle, or a scope entry
  that is empty, absolute, ends with /, holds * ? { or a backslash, has a .. or . segment or
  an empty segment (//), or has whitespace after the leading ./.

Exit codes: 0 success; 1 (ac-scan --fail-on-unbounded) unbounded criteria present;
2 usage/validation error (one line on stderr).
`;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq !== -1) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
        continue;
      }
      const next = args[i + 1];
      // `--files -` takes the literal `-` (stdin); other values must not look like flags.
      const takesValue = next !== undefined && (next === '-' || !next.startsWith('--'));
      const valueFlags = ['diff', 'files', 'bound', 'cwd', 'cap', 'file', 'panel-cap', 'log', 'epic-phase', 'max-workspaces', 'max-lines', 'config-ref', 'tasks'];
      if (valueFlags.includes(key)) {
        if (!takesValue) die(`--${key} requires a value`);
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function readFileList(source) {
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  return text.split('\n');
}

function gitDiffNames(range, cwd) {
  try {
    const outText = execFileSync('git', ['-C', cwd, 'diff', '--name-only', range], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return outText.split('\n');
  } catch (e) {
    const detail = (e.stderr || e.message || '').toString().trim().split('\n')[0];
    die(`git diff --name-only ${range} failed in ${cwd}: ${detail}`);
  }
  return [];
}

function collectFiles(flags, positional) {
  const cwd = flags.cwd || process.cwd();
  const raw = [...positional];
  if (flags.files) raw.push(...readFileList(flags.files));
  if (flags.diff) raw.push(...gitDiffNames(flags.diff, cwd));
  const seen = new Set();
  const files = [];
  for (const f0 of raw) {
    const f = f0.trim().replace(/^\.\//, '');
    if (!f || seen.has(f)) continue;
    seen.add(f);
    files.push(f);
  }
  return files;
}

function parseIntFlag(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < 0) die(`--${name} must be a non-negative integer (got ${flags[name]})`);
  return n;
}

function emit(obj, compact) {
  process.stdout.write(compact ? `${JSON.stringify(obj)}\n` : `${JSON.stringify(obj, null, 2)}\n`);
}

// =============================================================================
// Classification primitives
// =============================================================================
const anyMatch = (patterns, file) => patterns.some((re) => re.test(file));

function classify(files) {
  const classes = { test: [], meta: [], prod: [] };
  for (const f of files) {
    if (anyMatch(TEST_PATTERNS, f)) classes.test.push(f);
    else if (anyMatch(META_PATTERNS, f)) classes.meta.push(f);
    else classes.prod.push(f);
  }
  return classes;
}

// Monorepo containers whose children are each a workspace (apps/web, packages/ui, …).
const WORKSPACE_CONTAINERS = new Set(['apps', 'packages', 'services', 'libs']);

function workspaceOf(file) {
  const parts = file.split('/');
  if (parts.length === 1) return 'root';
  const [top, second] = parts;
  if (WORKSPACE_CONTAINERS.has(top)) return parts.length > 2 ? `${top}/${second}` : top;
  if (top === '.claude' || top === '.githooks' || top === '.github') return 'tooling';
  return top;
}

function workspacesOf(files) {
  return [...new Set(files.map(workspaceOf))].sort();
}

function seamOf(prodFiles) {
  const seamFiles = {};
  for (const f of prodFiles) {
    const cats = SEAM_CATEGORIES.filter((c) => anyMatch(c.patterns, f)).map((c) => c.name);
    if (cats.length) seamFiles[f] = cats;
  }
  return { touched: Object.keys(seamFiles).length > 0, files: seamFiles };
}

/**
 * Apply ROUTING_TABLE + the cross-domain rule.
 * @param {string[]} files    all files the table is applied to (rows without prodOnly)
 * @param {string[]} prodFiles prod-class files (rows with prodOnly; cross-domain rule)
 * @param {boolean} hasTestFiles whether the diff contains any test-class file
 * @returns {{routed: string[], evidence: object, notes: string[]}}
 */
function route(files, prodFiles, hasTestFiles) {
  const hits = new Map(); // reviewer -> { priority, files:Set }
  const add = (reviewer, priority, file, notes) => {
    const cur = hits.get(reviewer);
    if (cur) {
      cur.priority = Math.max(cur.priority, priority);
      if (file) cur.files.add(file);
    } else {
      hits.set(reviewer, { priority, files: new Set(file ? [file] : []) });
    }
    if (notes) hits.get(reviewer).notes = notes;
  };
  for (const row of ROUTING_TABLE) {
    if (row.requiresNoTestFiles && hasTestFiles) continue;
    const pool = row.prodOnly ? prodFiles : files;
    for (const f of pool) {
      if (anyMatch(row.patterns, f)) add(row.reviewer, row.priority, f);
    }
  }
  const notes = [];
  // Cross-domain rule (reviewer-routing.md): frontend + an API surface or backend code, OR a
  // shared contract/types package alongside frontend or backend → api-contract-reviewer.
  const hasFE = prodFiles.some(IS_FRONTEND);
  const hasApi = prodFiles.some(IS_API_SURFACE);
  const hasBE = prodFiles.some(IS_BACKEND);
  const hasShared = prodFiles.some(IS_SHARED_CONTRACT);
  if ((hasFE && (hasApi || hasBE)) || (hasShared && (hasFE || hasBE))) {
    const reason = hasFE && (hasApi || hasBE) ? 'frontend + API surface|backend' : 'shared contract package + frontend|backend';
    add('api-contract-reviewer', 50, null);
    notes.push(`cross-domain: api-contract-reviewer added (${reason})`);
  }
  if (hits.has('test-coverage-guardian') && !hasTestFiles && prodFiles.length) {
    notes.push('test-coverage-guardian: prod UI/server code changed with no test-class file in the diff');
  }
  const ordered = [...hits.entries()].sort((a, b) => b[1].priority - a[1].priority || a[0].localeCompare(b[0]));
  const evidence = {};
  for (const [name, v] of ordered) evidence[name] = { priority: v.priority, files: [...v.files].sort() };
  return { routed: ordered.map(([name]) => name), evidence, notes };
}

/** Strip test suffix + test directory segments so a test path routes like its subject. */
function stripTestPath(file) {
  return file
    .replace(/\.(test|spec)\.(ts|tsx|js|jsx|mjs|py)$/, '.$2')
    .split('/')
    .filter((seg) => !/^(tests?|__tests__)$/.test(seg))
    .join('/');
}

function baselines(workspaces, seam, failureOverTime) {
  const gates = {
    architecture: { fired: false, reason: `no seam touched (${workspaces.length} prod workspace(s); workspace count alone does not fire this seat)` },
    performance: { fired: false, reason: 'seat retired in 0.33.0 — its checklist lives in the routed domain reviewers' },
    failure_over_time: failureOverTime,
  };
  if (seam.touched) {
    gates.architecture = { fired: true, reason: `seam touched: ${Object.keys(seam.files).join(', ')}` };
  }
  const list = ['security-reviewer'];
  if (gates.architecture.fired) list.push('architecture');
  if (failureOverTime.fired) list.push('failure-over-time');
  return { list, gates };
}

// POSIX path of a `--- a/x` / `+++ b/x` header, or null for /dev/null.
function diffHeaderPath(line) {
  const rest = line.slice(4).replace(/\t.*$/, '');
  if (rest === '/dev/null') return null;
  return rest.replace(/^[ab]\//, '');
}

/**
 * `git diff --text -U0 <range>` parsed per file. `--text` keeps a file whose content git
 * withholds (`-diff` / `binary` in .gitattributes) from dropping out of the scan and the count.
 * @returns {{files: Map<string, {added:number, deleted:number, lines:string[]}>} | {error: string}}
 */
function readTextDiff(flags) {
  const cwd = flags.cwd || process.cwd();
  let out;
  try {
    out = execFileSync('git', ['-C', cwd, '-c', 'core.quotePath=false', 'diff', '--text', '--no-color', '--no-ext-diff', '-U0', flags.diff], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    return { error: (e.stderr || e.message || '').toString().trim().split('\n')[0] };
  }
  const files = new Map();
  let oldPath = null;
  let cur = null;
  // `---`/`+++` are headers only before a file's first hunk: a removed `-- comment` line is `--- comment`.
  let inHunk = false;
  // bounded: one pass over the diff text git returned
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) { oldPath = null; cur = null; inHunk = false; continue; }
    if (!inHunk) {
      if (line.startsWith('--- ')) oldPath = diffHeaderPath(line);
      else if (line.startsWith('+++ ')) {
        const file = diffHeaderPath(line) ?? oldPath;
        cur = file ? files.get(file) ?? { added: 0, deleted: 0, lines: [] } : null;
        if (file) files.set(file, cur);
      } else if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (!cur) continue;
    if (line[0] === '+') cur.added += 1;
    else if (line[0] === '-') cur.deleted += 1;
    else continue;
    cur.lines.push(line.slice(1));
  }
  return { files };
}

/**
 * Scan the added and removed lines of prod files over flags.diff for the failure-over-time terms.
 * @param {object} flags  parsed CLI flags (diff, cwd)
 * @param {string[]} prodFiles prod-class files; lines of any other file are ignored
 * @param {object|null} textDiff readTextDiff(flags)
 * @returns {{fired: boolean, reason: string, terms?: string[], files?: string[]}}
 */
function failureOverTime(flags, prodFiles, textDiff) {
  if (!flags.diff) return { fired: false, reason: 'no diff' };
  if (prodFiles.length === 0) return { fired: false, reason: 'no prod file in the diff' };
  // Unreadable diff: fire rather than silently drop the seat.
  if (textDiff.error !== undefined) return { fired: true, reason: `diff unreadable, seat kept: ${textDiff.error}`, terms: [], files: [] };
  const terms = new Set();
  const files = new Set();
  for (const file of prodFiles) {
    const entry = textDiff.files.get(file);
    if (!entry) continue;
    for (const body of entry.lines) {
      for (const name of failureOverTimeTermsIn(body)) { terms.add(name); files.add(file); }
    }
  }
  if (terms.size === 0) return { fired: false, reason: 'no failure-over-time term in the changed prod lines', terms: [], files: [] };
  const t = [...terms].sort();
  const f = [...files].sort();
  return { fired: true, reason: `changed prod lines match: ${t.join(', ')} (${f.join(', ')})`, terms: t, files: f };
}

/**
 * The repo config classify reads: the copy committed at --config-ref, else at the start of the
 * --diff range (a base commit), else the working tree. A differing worktree copy is a note.
 * @returns {{config: object, error: string|null, notes: string[]}}
 */
function routeConfig(flags) {
  const cwd = flags.cwd || process.cwd();
  const ref = flags['config-ref'] || (flags.diff ? rangeStart(flags.diff) : null);
  if (!ref) {
    const wt = tryLoadRepoConfig(cwd);
    return { config: wt.config, error: wt.error, notes: ['config-ref: worktree'] };
  }
  let loaded;
  try { loaded = loadRepoConfigAt(cwd, ref); } catch (e) { return { config: {}, error: e.message, notes: [`config-ref: ${ref}`] }; }
  const notes = [`config-ref: ${ref}`];
  let wtText = null;
  try {
    const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    wtText = readFileSync(join(top, CONFIG_FILE), 'utf8');
  } catch { /* absent */ }
  if (wtText !== (loaded.text ?? null)) notes.push(`the worktree's ${CONFIG_FILE} differs from ${ref}'s; ${ref}'s is used`);
  return { config: loaded.config, error: null, notes };
}

// `A..B` / `A...B` → A (empty → HEAD); a single revision is its own start.
function rangeStart(range) {
  const m = /^(.*?)\.{2,3}(.*)$/.exec(range);
  if (!m) return range;
  return m[1] || 'HEAD';
}

/** live_check from routeConfig; a config or ref error is required (fail closed), never an exit. */
function liveCheck(rc, prodFiles) {
  const note = rc.notes.join('; ');
  if (rc.error) {
    process.stderr.write(`sf-route: warning: .shipflow.json unreadable: ${rc.error}\n`);
    return { declared: false, required: true, matched: [], instructions: null, dev_probe: null, note: `${note}; .shipflow.json unreadable or invalid, live dev run treated as required: ${rc.error}` };
  }
  const lc = rc.config.live_check;
  if (!lc) return { declared: false, required: false, matched: [], instructions: null, dev_probe: null, note };
  const res = lc.paths.map((p) => new RegExp(p));
  const matched = prodFiles.filter((f) => anyMatch(res, f));
  return { declared: true, required: matched.length > 0, matched, instructions: lc.instructions, dev_probe: lc.dev_probe ?? null, note };
}

// Added + deleted lines over a git range, or null when there is no diff to measure. A file
// numstat reports as `-` (content withheld) is counted from the --text diff.
function diffLines(flags, textDiff) {
  if (!flags.diff) return null;
  const cwd = flags.cwd || process.cwd();
  let out;
  try {
    out = execFileSync('git', ['-C', cwd, 'diff', '--numstat', '-z', flags.diff], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  let total = 0;
  const tokens = out.split('\0');
  // bounded: one pass over numstat's NUL-separated records
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i]);
    if (!m) continue;
    let path = m[3];
    if (path === '') { path = tokens[i + 2] ?? ''; i += 2; } // rename: \0old\0new
    if (m[1] === '-' || m[2] === '-') {
      const entry = textDiff?.files?.get(path);
      if (entry) total += entry.added + entry.deleted;
      continue;
    }
    total += Number(m[1]) + Number(m[2]);
  }
  return total;
}

// =============================================================================
// Verbs
// =============================================================================
/**
 * `.shipflow.json` review.cap_exempt. A config or ref error fails closed: the exempt list is
 * unknown, so the cap is lifted for this call (null) and every routed candidate is seated.
 */
function capExempt(rc, notes) {
  if (rc.error) {
    notes.push(`panel cap not applied: review.cap_exempt unknown (.shipflow.json unreadable: ${rc.error}); every routed reviewer seated`);
    return null;
  }
  return new Set(rc.config.review?.cap_exempt ?? []);
}

function cmdClassify(flags, positional) {
  const files = collectFiles(flags, positional);
  const bound = parseIntFlag(flags, 'bound', DEFAULT_EXPRESS_BOUND);
  const classes = classify(files);
  const workspaces = workspacesOf(classes.prod);
  const seam = seamOf(classes.prod);
  const hasTestFiles = classes.test.length > 0;
  const panelCap = parseIntFlag(flags, 'panel-cap', DEFAULT_PANEL_CAP);
  if (panelCap < 1) die(`--panel-cap must be >= 1 (got ${panelCap})`);
  const rc = routeConfig(flags);
  const textDiff = flags.diff ? readTextDiff(flags) : null;

  let reviewers;
  if (hasTestFiles && classes.prod.length === 0) {
    // Test-only narrowing: test-coverage-guardian + the single highest-priority domain reviewer
    // for the directories the tests live in.
    const subjects = classes.test.map(stripTestPath);
    const domain = route(subjects, [], true);
    const top = domain.routed.find((r) => r !== 'test-coverage-guardian');
    reviewers = {
      routed: top ? ['test-coverage-guardian', top] : ['test-coverage-guardian'],
      capped_out: [],
      baselines: [],
      gates: {
        architecture: { fired: false, reason: 'test-only diff' },
        performance: { fired: false, reason: 'test-only diff' },
        failure_over_time: { fired: false, reason: 'test-only diff' },
      },
      narrowed: 'test-only',
      notes: [
        `test-only diff (${classes.test.length} test file(s), 0 prod files): baselines skipped`,
        top ? `domain reviewer from test directories: ${top}` : 'no domain reviewer matched the test directories',
      ],
      evidence: top ? { [top]: domain.evidence[top] } : {},
    };
  } else {
    const routed = route(files, classes.prod, hasTestFiles);
    const base = baselines(workspaces, seam, failureOverTime(flags, classes.prod, textDiff));
    const notes = [...routed.notes];
    // A baseline is seated anyway: it never spends a cap slot and is not repeated in routed.
    const candidates = routed.routed.filter((r) => !base.list.includes(r));
    const exempt = capExempt(rc, notes) ?? new Set(candidates);
    const counted = candidates.filter((r) => !exempt.has(r));
    const kept = new Set(counted.slice(0, panelCap));
    const cappedOut = counted.slice(panelCap);
    const seated = candidates.filter((r) => kept.has(r) || exempt.has(r));
    if (cappedOut.length) notes.push(`panel cap ${panelCap}: ${cappedOut.join(', ')} not seated (lower priority than ${[...kept].join(', ') || 'none'})`);
    reviewers = {
      routed: seated,
      capped_out: cappedOut,
      baselines: base.list,
      gates: base.gates,
      narrowed: null,
      notes,
      evidence: routed.evidence,
    };
  }

  const fileCount = classes.prod.length + classes.test.length;
  const maxWorkspaces = parseIntFlag(flags, 'max-workspaces', DEFAULT_EXPRESS_WORKSPACES);
  const maxLines = parseIntFlag(flags, 'max-lines', DEFAULT_EXPRESS_LINES);
  const lineCount = diffLines(flags, textDiff);
  const conditions = {
    bounded: fileCount <= bound,
    few_workspaces: workspaces.length <= maxWorkspaces,
    no_seam: !seam.touched,
  };
  // Only a diff has a line count; the pre-implementation --files form leaves it unjudged.
  if (lineCount !== null) conditions.bounded_lines = lineCount <= maxLines;
  const failed = Object.entries(conditions).filter(([, ok]) => !ok).map(([k]) => k);
  const express = {
    file_count: fileCount,
    bound,
    max_workspaces: maxWorkspaces,
    line_count: lineCount,
    max_lines: maxLines,
    ...conditions,
    eligible: failed.length === 0,
    failed,
    note: 'conditions 4-5 (testable acceptance criteria, no open questions) are judged by the orchestrator from the task body',
  };

  emit({ files, classes, workspaces, seam, reviewers, express, live_check: liveCheck(rc, classes.prod) }, flags.compact);
}

function cmdColdRoster(flags, positional) {
  const files = collectFiles(flags, positional);
  const cap = parseIntFlag(flags, 'cap', DEFAULT_COLD_CAP);
  const hadHigh = Boolean(flags['had-high']);
  const classes = classify(files);
  const seam = seamOf(classes.prod);
  const hasTestFiles = classes.test.length > 0;

  // The full cold panel re-reads the whole change at round-1 price. It is worth that only
  // when a fix touched a seam AND the round held a CRITICAL/HIGH; a seam touched by a
  // MEDIUM/LOW fix gets the contract seat on the warm roster instead (0.33.0).
  if (seam.touched && hadHigh) {
    emit(
      {
        mode: 'warm+cold-panel',
        roster: 'full-panel',
        reason: `fix commits touch seam files with a CRITICAL/HIGH in the bucket: ${Object.keys(seam.files).join(', ')}`,
        seam,
        skippable: false,
      },
      flags.compact,
    );
    return;
  }

  const nonMeta = [...classes.prod, ...classes.test];
  const routed = route(nonMeta, classes.prod, hasTestFiles);
  const roster = routed.routed.slice(0, cap);
  if (hadHigh && !roster.includes('security-reviewer')) roster.push('security-reviewer');
  if (seam.touched) {
    const contractSeat = routed.routed.includes('api-contract-reviewer') ? 'api-contract-reviewer' : 'security-reviewer';
    if (!roster.includes(contractSeat)) roster.push(contractSeat);
  }
  const floorApplied = roster.length === 0;
  if (floorApplied) roster.push('security-reviewer');

  emit(
    {
      mode: 'warm',
      roster,
      floor_applied: floorApplied,
      capped: routed.routed.length > cap,
      candidates: routed.routed,
      had_high: hadHigh,
      seam,
      skippable: !seam.touched && !hasTestFiles && !hadHigh,
    },
    flags.compact,
  );
}

// =============================================================================
// fix-trend — the fix loop's re-plan trigger (ship-task 3e step 7)
// =============================================================================
/**
 * The whole re-plan rule (ship-task 3e step 7). Rows are read in log order.
 * @param {string} text  audit-log JSONL
 * @param {string|null} epicPhase  filter; null → the phase of the last triage row
 * @returns {{epic_phase: string|null, rounds: {round:number, must_fix:number, high:number|null, rereview_mode:string|null}[], replan: boolean, replan_already_taken: boolean, reason: string}}
 */
export function fixTrend(text, epicPhase = null) {
  const rows = [];
  const phaseOf = (obj) => (obj.epic_phase === undefined || obj.epic_phase === null ? '' : String(obj.epic_phase));
  // bounded: one pass over the log's lines
  for (const [idx, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const round = Number(obj.round);
    if (obj.stage === 'note' && obj.event === 'fix-replan') {
      rows.push({ kind: 'fix-replan', idx, phase: phaseOf(obj) });
    } else if (obj.stage === 'note' && obj.event === 'scope-expansion') {
      rows.push({ kind: 'scope-expansion', idx, phase: phaseOf(obj), phased: obj.epic_phase != null });
    } else if (obj.stage === 'fix-seam-extension' && Number.isInteger(round)) {
      rows.push({ kind: 'seam-extension', idx, phase: phaseOf(obj), phased: obj.epic_phase != null, round });
    } else if (obj.stage === 'triage') {
      const mustFix = Number(obj.bucket1_fix_now);
      if (!Number.isInteger(round) || !Number.isInteger(mustFix)) continue;
      const high = obj.bucket1_high === undefined || obj.bucket1_high === null ? null : Number(obj.bucket1_high);
      rows.push({
        kind: 'triage', idx, phase: phaseOf(obj), round, must_fix: mustFix,
        high: Number.isInteger(high) && high >= 0 ? high : null,
        rereview_mode: typeof obj.rereview_mode === 'string' ? obj.rereview_mode : null,
      });
    }
  }
  const triage = rows.filter((r) => r.kind === 'triage');
  const phase = epicPhase !== null ? String(epicPhase) : triage.length ? triage[triage.length - 1].phase : '';
  // A note without epic_phase applies to every phase (single-task runs omit it).
  const inPhase = (r) => r.phase === phase || (r.kind !== 'triage' && !r.phased);
  const byRound = new Map();
  for (const r of triage) if (r.phase === phase) byRound.set(r.round, r); // the last row per round wins
  const ordered = [...byRound.values()].sort((x, y) => x.round - y.round);
  const rounds = ordered.map((r) => ({ round: r.round, must_fix: r.must_fix, high: r.high, rereview_mode: r.rereview_mode }));
  // At most one re-plan per phase; a single-task run (no phase) counts any fix-replan note.
  const replanTaken = rows.some((r) => r.kind === 'fix-replan' && (phase === '' || r.phase === phase));
  const out = { epic_phase: phase || null, rounds, replan: false, replan_already_taken: replanTaken, reason: '' };
  if (ordered.length < 2) {
    out.reason = `${ordered.length} triage round(s): a trend needs two`;
    return out;
  }
  const [prev, last] = ordered.slice(-2);
  const span = `round ${prev.round} ${prev.must_fix}/${prev.high ?? '?'} -> round ${last.round} ${last.must_fix}/${last.high ?? '?'} (must-fix/HIGH)`;
  if (rows.some((r) => r.kind === 'seam-extension' && inPhase(r) && r.round === last.round)) {
    out.reason = `round ${last.round} is the seam-extension round: no comparison`;
  } else if (prev.rereview_mode === 'warm+cold-panel') {
    out.reason = `round ${prev.round} ran warm+cold-panel (a round-1 re-read of a larger change): no comparison`;
  } else if (rows.some((r) => r.kind === 'scope-expansion' && inPhase(r) && r.idx > prev.idx && r.idx < last.idx)) {
    out.reason = `a scope-expansion note lies between rounds ${prev.round} and ${last.round}: no comparison`;
  } else if (prev.high === null || last.high === null) {
    out.reason = `a triage row without bucket1_high: no comparison (${span})`;
  } else if (last.high === 0) {
    out.reason = `round ${last.round} has no open CRITICAL/HIGH in bucket 1 (${span})`;
  } else if (last.must_fix >= prev.must_fix && last.high >= prev.high) {
    out.replan = !replanTaken;
    out.reason = replanTaken
      ? `neither must-fix nor HIGH fell, but this phase already re-planned once: ${span}`
      : `neither must-fix nor HIGH fell: ${span}`;
  } else out.reason = `must-fix or HIGH fell: ${span}`;
  return out;
}

function cmdFixTrend(flags, positional) {
  if (!flags.log || flags.log === true) die('fix-trend: --log <path> is required');
  if (positional.length) die('fix-trend takes no positional paths');
  if (flags['epic-phase'] === true) die('fix-trend: --epic-phase requires a value');
  let text;
  try { text = readFileSync(flags.log, 'utf8'); } catch (e) { die(`fix-trend: cannot read ${flags.log}: ${e.message}`); }
  emit(fixTrend(text, flags['epic-phase'] ?? null), flags.compact);
}

// =============================================================================
// ac-scan — acceptance-criteria goal-post tripwire
// =============================================================================
// Universal quantifiers: an AC phrased over "all inputs" has no finish line unless something
// else bounds it. `any` and `each` are included deliberately — "no citation on any result" was
// the P1 wording; the orchestrator decides whether a hit is structural or a death march.
const UNIVERSAL_WORDS = /\b(no(?!-)|none|never|always|all|every|any|each|zero|regardless|whenever)\b|\bonly\s+(when|if|for)\b|\b100\s?%/i;
// Bound markers: anything that pins the AC to a finite, checkable set or a structural guard.
const BOUND_MARKERS = [
  { name: 'guard', re: /\bguards?\s*:/i },
  { name: 'fixture', re: /\bfixtures?\s*:/i },
  // a deployed dev run on a named input (ship-task 3g §Live smoke)
  // (a hyphenated compound like `time-to-live:` is not one; a placeholder like `live: TBD` bounds nothing)
  { name: 'live', re: /(?<![-\w])live\s*:\s*(?!(?:TBD|tbd|TODO|todo|TBA|tba)\b)\S{3,}/ },
  { name: 'pinned', re: /\bpinned\b/i },
  { name: 'regression-test', re: /\bregression test\b/i },
  { name: 'contract-test', re: /\bcontract test\b/i },
  { name: 'lint-rule', re: /\blint rule\b|\beslint\b/i },
  { name: 'test-file', re: /\.(test|spec|dom\.test|browser\.test)\.[a-z]+\b/i },
  { name: 'hex-id', re: /\b[0-9a-f]{8,}\b/i },
  // id-shaped only: a hex run, a dotted/dashed code (`12-34-56`, `4021-7`), or a >= 4-digit number —
  // `S3`, `h1`, `utf8` are names, not fixtures.
  { name: 'identifier', re: /`[^`]*(?:[0-9a-f]{6,}|\d{2,}(?:[-.]\d+)+|\d{4,})[^`]*`/i },
];
// Heuristic-domain wording — where "for every input" cannot be enumerated and reviewers can
// always produce one more counterexample (OCR layouts, classifiers, matchers, rankers).
const HEURISTIC_WORDS = /\b(ocr|layout|reading[- ]order|classif\w*|heuristic\w*|fuzzy|match\w*|rank\w*|similarit\w*|embedding\w*|extract\w*|parse\w*|detect\w*|label\w*|badge\w*|quote\w*|highlight\w*|prose|narrative)\b/i;

// A heading (`## Acceptance criteria (bounded)`) or a bold label (`**Acceptance Criteria:**`,
// `**Acceptance Criteria** (per phase)`) opens the section; any other heading/label closes it.
const AC_HEADING = /^(#{1,6}\s+.*acceptance.*|\*\*[^*]*acceptance[^*]*\*\*(?::|\s*\(.*\))?.*)$/i;
const ANY_HEADING = /^(#{1,6}\s+\S.*|\*\*[^*]+\*\*(?::|\s*\(.*\))?\s*$)/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const FENCE = /^\s*(```|~~~)/;

export function scanAcceptanceCriteria(markdown) {
  const lines = markdown.split('\n');
  const criteria = [];
  let inAc = false;
  let inFence = false;
  let section = null;
  let current = null;
  const flush = () => {
    if (current) { criteria.push({ n: criteria.length + 1, section: current.section, text: current.text }); current = null; }
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (FENCE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (AC_HEADING.test(trimmed)) { flush(); inAc = true; section = trimmed.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim(); continue; }
    if (ANY_HEADING.test(trimmed)) { flush(); inAc = false; continue; }
    if (!inAc) continue;
    if (!trimmed) { flush(); continue; }
    // `source: <original wording>` is provenance for a bounded rewrite, never a criterion
    if (/^(?:[-*+]\s+|\d+[.)]\s+)?source\s*:/i.test(trimmed)) continue;
    const m = line.match(LIST_ITEM);
    if (m) {
      const indent = m[1].length;
      // a sub-bullet belongs to the item above it (the drafter's "claim, then its bound" shape)
      if (current && indent > current.indent) { current.text += ` ${m[2].trim()}`; continue; }
      flush();
      current = { section, text: m[2].trim(), indent };
      continue;
    }
    // CommonMark lazy continuation: any non-blank, non-heading line extends the open item
    if (current) { current.text += ` ${trimmed}`; continue; }
    // a paragraph under the heading that is not a list item is one criterion
    current = { section, text: trimmed, indent: 0 };
  }
  flush();
  for (const c of criteria) {
    const universal = [];
    const re = new RegExp(UNIVERSAL_WORDS.source, 'gi');
    let hit;
    while ((hit = re.exec(c.text)) !== null) universal.push(hit[0].toLowerCase());
    c.universal = [...new Set(universal)];
    // the inline `(source: …)` provenance is the original unbounded wording, never a bound
    const boundText = c.text.replace(/\(source\s*:[^)]*\)/gi, '');
    c.bound_markers = BOUND_MARKERS.filter((b) => b.re.test(boundText)).map((b) => b.name);
    c.heuristic = HEURISTIC_WORDS.test(c.text);
    c.bounded = c.universal.length === 0 || c.bound_markers.length > 0;
  }
  const unbounded = criteria.filter((c) => !c.bounded).map((c) => c.n);
  return {
    criteria,
    unbounded,
    counts: {
      criteria: criteria.length,
      universal: criteria.filter((c) => c.universal.length > 0).length,
      unbounded: unbounded.length,
      heuristic_unbounded: criteria.filter((c) => !c.bounded && c.heuristic).length,
    },
  };
}

function cmdAcScan(flags, positional) {
  const file = flags.file || positional[0];
  if (!file) die('ac-scan: --file <markdown> is required');
  if (flags.file && positional.length) die('ac-scan takes one --file, not positional paths');
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { die(`ac-scan: cannot read ${file}: ${e.message}`); }
  const result = { file, ...scanAcceptanceCriteria(text) };
  emit(result, flags.compact);
  // exitCode, not exit(): the JSON above must reach a piped consumer on every platform.
  if (flags['fail-on-unbounded'] && result.counts.unbounded > 0) process.exitCode = 1;
}

// =============================================================================
// batches — the 3b decomposition (ship-task 3b)
// =============================================================================
/**
 * Group a plan's tasks into implementation batches. Throws an Error naming the defect on a
 * malformed task list or a dependency cycle.
 * @param {Array<{id: string, scope: string[], depends_on?: string[]}>} tasks
 * @param {{scratch?: boolean}} [options] scratch:false when the run cannot cut scratch worktrees
 * @returns {{batches: Array<{id: string, tasks: object[], seam_touched: boolean, parallelizable: boolean, parallelizable_reason: string}>, unresolved_depends_on: Array<{task: string, id: string}>}}
 */
export function planBatches(tasks, { scratch = true } = {}) {
  const nonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
  const strArray = (v) => Array.isArray(v) && v.every(nonEmptyStr);
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('tasks must be a non-empty JSON array');
  const ids = new Set();
  for (const [i, task] of tasks.entries()) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error(`tasks[${i}] must be an object`);
    if (!nonEmptyStr(task.id)) throw new Error(`tasks[${i}].id must be a non-empty string`);
    if (ids.has(task.id)) throw new Error(`duplicate task id ${task.id}`);
    ids.add(task.id);
    if (!strArray(task.scope) || task.scope.length === 0) throw new Error(`task ${task.id}: scope must be a non-empty array of file paths`);
    if (task.depends_on !== undefined && !strArray(task.depends_on)) throw new Error(`task ${task.id}: depends_on must be an array of task ids`);
  }
  // Overlap and seam checks compare strings, so every scope entry is one canonical file path
  // (collectFiles' form). Only one leading ./ is stripped; any other second spelling of a path
  // is refused, never normalised. `[` and an interior space are not refused: real paths carry
  // them. A line reference or markup around the path is refused: it makes two entries for one
  // file compare as different and hides a seam file.
  const canonicalScope = (task) => task.scope.map((raw) => {
    const path = raw.trim().replace(/^\.\//, '');
    const segments = path.split('/');
    const defect = path === '' ? 'is empty'
      : path !== path.trim() ? 'has whitespace after the leading ./'
      : path.startsWith('/') ? 'is absolute'
      : path.endsWith('/') ? 'names a directory'
      : path.includes('\\') ? 'holds a backslash'
      : /[*?{]/.test(path) ? 'is a glob'
      : segments.includes('..') ? 'has a ".." segment'
      : segments.includes('.') ? 'has a "." segment'
      : segments.includes('') ? 'has an empty segment'
      : path.includes(':') ? 'holds a ":"'
      : path.includes('`') ? 'holds a backtick'
      : /#L\d+$/.test(path) ? 'ends in a #L<line> suffix'
      : / \([^)]*\)$/.test(path) ? 'ends in a parenthesised note'
      : null;
    if (defect) throw new Error(`task ${task.id}: scope entry ${JSON.stringify(raw)} ${defect} (scope takes repository-relative file paths)`);
    return path;
  });
  tasks = tasks.map((task) => ({ ...task, scope: canonicalScope(task) }));
  const unresolved = tasks.flatMap((task) => (task.depends_on ?? []).filter((id) => !ids.has(id)).map((id) => ({ task: task.id, id })));

  const layers = [];
  const placed = new Set();
  let pending = tasks;
  // bounded: every pass places at least one task or throws
  while (pending.length > 0) {
    const ready = pending.filter((task) => (task.depends_on ?? []).every((id) => !ids.has(id) || placed.has(id)));
    if (ready.length === 0) throw new Error(`dependency cycle among tasks: ${pending.map((task) => task.id).join(', ')}`);
    layers.push(ready);
    for (const task of ready) placed.add(task.id);
    pending = pending.filter((task) => !placed.has(task.id));
  }

  const batches = [];
  const push = (group, seamTouched) => {
    if (group.length === 0) return;
    // A directory named without a trailing / reads as a file path, so an entry that is a
    // /-terminated prefix of another task's entry overlaps it.
    const entries = group.flatMap((task) => task.scope.map((path) => ({ id: task.id, path })));
    const overlap = entries.some((a) => entries.some((b) => a.id !== b.id && (a.path === b.path || b.path.startsWith(`${a.path}/`))));
    // Same order as GATE_REASONS: the recorded reason is the first condition that fails.
    const failed = [!scratch, seamTouched, group.length < 2, overlap].indexOf(true);
    batches.push({
      id: `B${batches.length + 1}`,
      tasks: group.map((task) => ({
        id: task.id,
        scope: task.scope,
        ...(task.depends_on !== undefined ? { depends_on: task.depends_on } : {}),
      })),
      seam_touched: seamTouched,
      parallelizable: failed === -1,
      parallelizable_reason: failed === -1 ? ALL_HOLD : GATE_REASONS[failed],
    });
  };
  for (const layer of layers) {
    const isSeam = (task) => seamOf(classify(task.scope).prod).touched;
    push(layer.filter(isSeam), true);
    push(layer.filter((task) => !isSeam(task)), false);
  }
  return { batches, unresolved_depends_on: unresolved };
}

function cmdBatches(flags, positional) {
  if (!flags.tasks) die('batches: --tasks <json file|-> is required');
  if (positional.length) die('batches takes --tasks, not positional paths');
  let tasks;
  try {
    tasks = JSON.parse(readFileSync(flags.tasks === '-' ? 0 : flags.tasks, 'utf8'));
  } catch (e) {
    die(`batches: cannot read tasks from ${flags.tasks}: ${e.message}`);
  }
  let result;
  try { result = planBatches(tasks, { scratch: !flags['no-scratch'] }); } catch (e) { die(`batches: ${e.message}`); }
  emit(result, flags.compact);
}

// =============================================================================
// main — runs only when this file is the entry point, so its exports are importable
// =============================================================================
function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const [verb, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);
  if (verb !== 'ac-scan' && flags.file) die(`${verb}: --file belongs to ac-scan (use --files <path> for a file list)`);
  if (verb !== 'ac-scan' && verb !== 'fix-trend' && verb !== 'batches' && !flags.diff && !flags.files && positional.length === 0) die(`${verb}: no files given (positional, --files, or --diff)`);

  switch (verb) {
    case 'classify':
      cmdClassify(flags, positional);
      break;
    case 'cold-roster':
      cmdColdRoster(flags, positional);
      break;
    case 'ac-scan':
      cmdAcScan(flags, positional);
      break;
    case 'fix-trend':
      cmdFixTrend(flags, positional);
      break;
    case 'batches':
      cmdBatches(flags, positional);
      break;
    default:
      die(`unknown verb "${verb}" (expected classify | cold-roster | ac-scan | fix-trend | batches; see --help)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
