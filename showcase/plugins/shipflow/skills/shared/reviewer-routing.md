# Reviewer routing (shared reference)

> **The routing is computed by `${CLAUDE_PLUGIN_ROOT}/scripts/sf-route.mjs`; this file
> documents what the script does.** Referenced by `ship-task` 1.9 / 3b / 3d / 3e (and its
> `epic.md` phases), `review-task-code`, and `warm-closure.md`. When the table and
> the script disagree, the script is the bug or the doc is — fix both in one change;
> never re-implement a rule in prose in a skill.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sf-route.mjs" classify   --cwd "$WT_PATH" --config-ref "origin/$BASE_BRANCH" --diff "$REVIEW_BASELINE..HEAD"
node "${CLAUDE_PLUGIN_ROOT}/scripts/sf-route.mjs" classify   --config-ref "origin/$BASE_BRANCH" --files <list>   # express eligibility (Stage 1.9)
node "${CLAUDE_PLUGIN_ROOT}/scripts/sf-route.mjs" cold-roster --diff "$FIX_BASELINE..HEAD" [--had-high]
node "${CLAUDE_PLUGIN_ROOT}/scripts/sf-route.mjs" fix-trend  --log "$RUN_LOG" [--epic-phase <id>]   # ship-task 3e step 7
```

`classify` returns `{files, classes:{test,meta,prod}, workspaces, seam, reviewers:{routed,
capped_out, baselines, gates, narrowed, notes, evidence}, express, live_check}`. Spawn
`reviewers.routed` + `reviewers.baselines`.

## File classes

1. **Test** — `\.(test|spec)\.(ts|tsx|js|jsx|py)$` or under `/(tests?|__tests__)/`.
2. **Run metadata** — `docs/**`, `**/*.md`, type-gate baselines
   (`**/typecheck-baseline*.json`). Never disqualify narrowing — every ship-* run commits
   its own plan artifacts.
3. **Production code** — everything else.

`workspaces` = the distinct workspaces of production files: `apps/<app>`,
`packages/<pkg>`, `services/<svc>` (monorepo conventions), `scripts`, `tooling`
(`.claude`, `.githooks`, `.github`), else the top-level directory.

## The seam list (CANONICAL — the one place it lives)

A production file is a **seam** when it matches any category. Seams decide the express
condition 3, the 3b parallelizability gate, the architecture baseline, and the fix-round
cold-panel escalation — all from this one list. The defaults follow common repository
conventions; the exact regexes are the `SEAMS` table in `sf-route.mjs` — edit that one
table to fit a repository's layout.

| Category | What matches (by convention) |
|---|---|
| `auth` | a directory or file whose name **starts with** `auth`, `authentication`, `login`, `session`, `password`, `credential`, `token`, or `secret` (source files). A route group such as `app/(auth)/` does **not** match — its segment starts with `(`; nor does a helper like `withAuthentication.ts`. |
| `shared-contract` | shared type/schema packages: `packages/shared-*/`, `packages/types/`, `packages/schemas/` |
| `barrel` | a package entry point: `packages/<pkg>/src/index.(ts\|js)` |
| `api-contract` | API schema files: `*.graphql`, `openapi*.(json\|yaml\|yml)`, `swagger*`, `*.proto`, and `api/schema(s)/` directories |
| `config` | `*.config.(c\|m)?(js\|ts)`, root `turbo.json`, root `tsconfig*.json`, root `.shipflow.json`, any `.gitattributes` |
| `package` | any `package.json` (and other manifests: `pyproject.toml`, `go.mod`, `Cargo.toml`) |
| `lockfile` | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` (and other lockfiles) |
| `migration` | `**/migrations?/`, `**/*.sql` under a `sql/` or `db/` root, `prisma/schema.prisma` and `prisma/migrations/` |

## Routed reviewers (priority order)

| Files (by convention) | Reviewer | Priority |
|---|---|---|
| the `auth` seam category | `security-reviewer` | 100 |
| agent and prompt definitions: `.claude/agents/*.md`, `**/agents/**` and `**/prompts/**` source or text files | `prompt-reviewer` | 90 |
| SQL and schema: `**/*.sql`, `**/migrations/**`, `prisma/**`, `db/schema/**` | `database-reviewer` | 80 |
| server code: `server/`, `api/`, `backend/`, `services/`, `handlers/`, `functions/`, `workers/` source files | `backend-reviewer` | 77 |
| **infrastructure files only**: `infra/`, `terraform/`, `*.tf`, `cdk/` and `*-stack.(ts\|js)`, `k8s/`, `helm/`, `Dockerfile`, `docker-compose*`, `.github/workflows/`, `(^\|/)iam/` | `infra-reviewer` | 75 |
| **boundary files only**: framework route and data-boundary files — `app/**/(page\|layout\|route\|loading\|error\|not-found).(tsx\|ts)`, `pages/**`, `middleware.ts`, server actions / loaders, framework config (`next.config.*`, `vite.config.*`) | `frontend-reviewer` | 65 |
| UI files: `*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, `components/**`, `*.css` / `*.scss` | `ux-consistency-lead` | 60 |
| the `shared-contract` and `api-contract` seam categories | `api-contract-reviewer` | 50 |
| **production code changed and the diff contains no test file** | `test-coverage-guardian` | 45 |
| test files: `*.(test\|spec).*`, `tests/`, `__tests__/`, `e2e/`, `*playwright*` | `test-coverage-guardian` | 35 |

Two rules keep over-firing seats scoped — `frontend-reviewer` was passing on nearly
every component-only diff, and `test-coverage-guardian`'s broad match made it a fourth
de-facto baseline:

- **Components-only diffs route to `ux-consistency-lead` alone.** `frontend-reviewer`
  is added when a server/client **boundary** file is touched (the row above).
- **`test-coverage-guardian` at 45 fires on "production changed, no test changed"**,
  not on every source file. Row 35 (test files present) is unchanged.

**Cross-domain rule:** a UI or client change alongside an `api-contract` or
`shared-contract` change (producer and consumer in one diff) → add `api-contract-reviewer`.
**Multiple matches:** union, priority-sorted. **Availability:** a row whose agent is not installed is a noted gap, never a failed run.

## Baselines and gates

- `security-reviewer` — **always** (express runs keep it; only test-only narrowing drops it).
- **Architecture** (`general-purpose`, opus) — only when production files touch a **seam**.
  Workspace count alone no longer fires it (0.33.0): across ten ship-task ledgers the seat
  returned PASS nine times, and the cross-workspace defect it was meant to catch — contract
  drift between a producer and a validator — is `api-contract-reviewer`'s row, which does FAIL
  when it should. On a leaf diff its marginal output is duplicated findings at the panel's
  highest price.
- **Performance — retired (0.33.0).** Nine PASS in ten at opus price, zero CRITICAL/HIGH after
  the template legend is discounted. Its checklist (N+1, unbounded loops, missing indexes,
  payload size, cold-start cost, blocking I/O on hot paths) lives inside
  `backend-reviewer` and `database-reviewer`; `sf-route` reports the gate as
  `fired:false` with the retirement reason so old ledgers still parse.
- **Failure over time** (`general-purpose`, template `reviewer-prompts.md` §Baseline
  reviewer 4) — **mandatory** when the changed prod lines touch concurrency, queues, durable
  steps or retries: `gates.failure_over_time` scans the added and removed lines of
  `git diff --text -U0 <range>` in prod files (`--text`, so a `.gitattributes` `-diff` cannot
  hide them). Each line is normalized first — camel humps and acronym runs split into words,
  `_ . - /` read as spaces, lowercased — so `SendMessageCommand`, `MAX_RETRIES`,
  `branchCtx.step(` and `pg_advisory_xact_lock` reach the word-bounded
  `FAILURE_OVER_TIME_TERMS`: lock(s/ed/ing), FOR UPDATE, SKIP LOCKED, advisory lock /
  pg advisory, retry (retries/retried/retrying/retryable), backoff, lease(s), heartbeat,
  visibility timeout, send/receive/delete/change message, message group id, dead letter,
  DLQ, queue(s), wait for callback, durable, ctx/context step, transaction(s),
  BEGIN/COMMIT/ROLLBACK, mutex, semaphore, at least once, idempoten\*, concurren\*; plus
  an ORM row lock such as `.for('update')` and `Promise.all(` / `Promise.allSettled(` on the
  raw line.
  `blockId` ("block id"), `BlockDoc`, `unlock` and `clock` never fire it, and docs or test
  lines never do. The trigger reads content, not paths, because path rules are
  repo-specific. Without `--diff` it reports `fired:false, reason:"no diff"`. Express runs
  keep this seat.

**Panel cap.** `reviewers.routed` holds at most `--panel-cap` domain reviewers (default 3,
minimum 1), highest priority first; the rest are listed in `reviewers.capped_out` with a
note, never seated — ship-task records them on the round-1 triage event and in the PR
body's `## Review coverage`. A name that is also a baseline (`security-reviewer` on an auth
diff) is not listed in `routed` and never spends a slot. Seats a repo lists in
`.shipflow.json` `review.cap_exempt` are seated uncapped.

**Which config `classify` reads.** `live_check` and `review.cap_exempt` come from the
`.shipflow.json` committed at `--config-ref` (ship-task passes `origin/$BASE_BRANCH`), else at
the start of the `--diff` range, else the working tree (note `config-ref: worktree`) — so a
branch cannot switch off its own live-run requirement. A worktree copy that differs is a
note.

**Live dev check (`live_check`).** A repo that declares `live_check` in `.shipflow.json`
(`repo-config.md`) names the paths whose changes are pipeline work. `classify` reports
`live_check: { declared, required, matched, instructions, note }`: `required` is true when a
prod file matches one of the paths, and ship-task 3g then requires a `## Live dev run` section
in the PR body. A config or ref error fails closed: `required:true` with the error in
`note`, and the panel cap is lifted for that call (every routed reviewer is seated, with a
note), so a repo-exempt seat is never dropped; routing never stops on it.

**Fix trend (`fix-trend`).** Reads the audit log's triage rows in order and returns
`{ epic_phase, rounds, replan, replan_already_taken, reason }` — ship-task 3e step 7 states the rule.

**Typical backend fix, before → after:** six seats (security, backend, infra,
test-coverage, architecture, performance) → three (security, backend, test-coverage),
plus `api-contract-reviewer` when a shared package changed and `infra-reviewer` when an
infrastructure file did.

**Test-only narrowing:** ≥ 1 test file and 0 production files → `test-coverage-guardian`
plus the single highest-priority routed reviewer for the directories the tests live in;
no baselines (on a test-heavy diff the baselines cost tokens and return PASS with zero
findings). Any
production file in the diff → normal routing in full.

## Fix-round cold roster (`cold-roster`)

Input: the files in the fix commits. A seam touched **and** `--had-high` →
`mode=warm+cold-panel` (full round-1 panel over the full range). Otherwise `mode=warm` with
the routed rows matched by the fix files (cap 3), `security-reviewer` on `--had-high`, the
contract seat (`api-contract-reviewer` when routed, else `security-reviewer`) when a seam was
touched without a HIGH, `security-reviewer` alone when nothing matches — and
`skippable=true` when no seam, no test file, and no CRITICAL/HIGH were involved, which lets
`warm-closure.md` §2 skip the cold pass on an all-CLOSED round. Measured before 0.33.0: a
seam-only trigger re-ran six opus seats over the full range to return 0 CRITICAL / 0 HIGH /
7 MEDIUM / 29 LOW on one measured run (about 1M tokens) — the full panel is worth its price only
when the round it follows held a real defect.

## Express conditions 1–3 (`express`)

`bounded` (≤ 8 production + test files; `--bound` overrides), `few_workspaces` (≤ 3
production workspaces; `--max-workspaces` overrides), `no_seam`; with `--diff`, also
`bounded_lines` (≤ 400 added + deleted lines; `--max-lines` overrides — absent on the
pre-implementation `--files` form). Conditions 4–5 (testable acceptance criteria, no open
questions) are judged from the task body by the orchestrator (`ship-task` Stage 1.9).
The old `single_workspace` condition is gone (0.33.0): a 4-file search fix touching
one client package and two infrastructure stacks failed it on every run, so express never
fired.

**Intentional omissions:** `docs-organizer` (docs need no code review);
`code-deduplication-architect` (covered by the architecture/holistic review).
