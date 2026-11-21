---
name: ship-task
description: "Autonomously ship a GitHub issue end-to-end: pick up (or cut) the issue, worktree, blast-area routing (express path for small well-specified work, adversarially reviewed plan otherwise, epic fan-out for parent tasks with phase subtasks), implementation + review + fix, and one PR or a dependency-ordered PR stack to development. One entrypoint, three dev paths; the tracker is behind one adapter (scripts/tracker.mjs). Pauses only on CHECKPOINT_REQUIRED. Usage: $ship-task <#issue|issue-url> | $ship-task \"Task title\" | $ship-task <path-to-prd.md>"
---

> Codex compatibility: this file is generated from the Claude skill source.
> For worker dispatch, read `../../references/shared/runtime.md` and resolve each role with
> `node ../../scripts/sf-runtime.mjs resolve --host codex --role <role>`; use the returned
> GPT model and effort with Codex collaboration tools. Claude model metadata describes the
> Claude backend only. Set `SF_PLUGIN_ROOT` to this plugin's absolute root before running
> shell examples, and resolve `../` references relative to this SKILL.md. Preserve every
> confirmation gate and destructive-operation guard.

# $ship-task — Autonomously ship a GitHub issue end-to-end

**Runtime first:** read `../../references/shared/runtime.md` before Stage 0. Resolve the actual
host (`claude` or `codex`) and execution mode (`claude`, `codex`, `hybrid`) once with
`scripts/sf-runtime.mjs`. Its dispatch/tool/accounting rules override the Claude-specific
examples below. Native Codex runs every role on GPT, including planners, security and
UX; hybrid retains the existing Claude pins. The stages and acceptance gates are shared.

One entrypoint for tracker-tracked work (GitHub Issues by default — a "task" below is an
issue, a "subtask" a sub-issue, a "tag" a label). It classifies the work's **blast area** with
`sf-route` and takes one of three paths — **express** (small, single-workspace,
seam-free, fully specified → no plan loop), **full** (adversarially reviewed plan →
implement → routed review → fix → PR), or **epic** (parent task + phase subtasks →
one PR off a shared integration branch, or a dependency-ordered PR stack when a layer must
land independently). Stops only on `CHECKPOINT_REQUIRED`. The human always
makes the merge call.

**Usage:**
- `$ship-task #<n>`, `$ship-task <n>` or `$ship-task https://github.com/<owner>/<repo>/issues/<n>` — pick up an
  existing task (single, or a parent with phase subtasks) created by `$cut-task`
- `$ship-task "Task title here"` — cut a fresh task from a title + conversation context,
  then ship it
- `$ship-task <path-to-prd.md>` — cut a task (or parent + phase subtasks) from a PRD
  file, then ship it

The single-task path is **fully specified in this file**. Epic fan-out (Stage 2.7 / 3E)
and the stacked-PR topology live in `epic.md` beside this file, loaded only on an epic. Every rule's measured
rationale lives in `rationale.md` beside this file — cite it, don't load it.

## Helpers — `tracker`, `sf-route`, `sf-log`, `sf-sync`

All four live in `../../scripts/`; invoke as `node "../../scripts/<name>.mjs" …`. They exist so the orchestrator never judges from prose what a script can compute.

- **`tracker`** — every tracker read/write, and the only file that knows which tracker
  holds the state. This build backs it with GitHub Issues through `gh` (status =
  one `status:<slug>` label, subtask = sub-issue, tag = label, PR/branch links = one sticky
  comment); porting to another PM platform re-implements its verbs and nothing else. It
  uses `gh`'s auth and the repo `gh` resolves from cwd (`--repo` / `$SF_TRACKER_REPO`
  override). Verbs used here: `task view <id> [--subtasks]`,
  `task edit <id> --body-file <md>` (full replacement — fetch, re-emit), `task comments
  <id> [--all]`, `task status <id> "<status>"` (**quote — names contain spaces**),
  `task comment <id> --body-file <f>`, `task pr <id> --url <u>`, `task branch <id> --url
  <u>`, `task create`, `tag ensure <tag>`, `lists`. Every agent comment opens with
  `**[<skill> · <context>]**` — all comments post as the token's user, so the signature is
  the attribution. On an auth error tell the user to run `gh auth login`; never repair
  credentials yourself.
- **`sf-sync`** — the §Integration sync block as one command: `eval "$(node "$SF/sf-sync.mjs" --cwd "$WT_PATH" --base "$BASE_BRANCH" --at <point> [--layer k] [--probe] --export)"` fetches, merges (or probes at `phase`), writes the `integration-sync` event and sets `$SYNC_BEFORE $BEHIND $CONFLICTS $REVIEW_BASELINE $PROBE $MIGRATION_COLLISIONS $MIGRATION_COLLISIONS_JSON $MIGRATIONS` (a count > 0 → renumber before the next step; `MIGRATIONS=error` is never 0 — `shared/integration-sync.md` §Migration collisions). A bare `git rev-list`/`git merge` in its place logs nothing and is read as an unsynced run (`shared/integration-sync.md`).
- **`sf-route`** — file classification. `classify` takes a file list (or `--diff <range>`)
  and returns the three-class split (test / meta / prod), workspaces, the **seam list**
  verdict (auth, shared-contract, barrel, api-contract, config, package, lockfile,
  migration — this script is the canonical seam list), the reviewer roster (routed +
  gated baselines + test-only narrowing), and the express conditions 1–3.
  `cold-roster` returns the fix-round cold pass roster and whether it is skippable.
  `reviewer-routing.md` documents the table the script encodes.
- **`sf-log`** — every audit event. `init` creates the log and writes `run-meta`;
  `stage <name> k=v…`, `spawn k=v…`, `checkpoint reason=… at=…`, `cursor <runstate>
  k=v…`, `check`. The stage name is validated against an enum (unknown → exit 2; the
  escape hatch is `note event=…`). `spawn` and `stage` read `RUN_LOG` and `SF_RUN_TASK`
  from the environment — export both once in Stage 0. `$ship-report` is the binding
  consumer of this schema.
- **`sf-gates`** — the repo's gates (`shared/repo-config.md`, `shared/run-preflight.md`
  §Push-gate baseline). `gate --mode full|smoke|layer` runs a whole gate job set — 3f, the
  3c step 4 smoke, the 2.7 layer gate — and prints one JSON verdict with the `next` step;
  `run` runs one declared check, and with `--only` on the base too; `baseline` measures
  the push-gated suites on the base at pickup; `push-env` prints the approved skip
  variables for a push.
- **`sf-push`** — a run's push and pull-request mechanics. `--kind checkpoint|layer`
  pushes through the repo's declared verified push command (`.shipflow.json`
  `push.verified`, read from the base; else the built-in push) under `push-env`'s approved
  skips, and reports `verified` only when the remote branch tip equals the local `HEAD`.
  `--kind final` (3g) also finds or creates the draft PR, updates its body and reads it
  back, reads `mergeable`, and does §PR link-back. One JSON line; the orchestrator still
  writes the body and decides `gh pr ready`.
- **`sf-codex`** — the Codex review backend (`../../references/shared/review-backend.md`), used only
  when `SHIP_REVIEW_BACKEND=codex`. `review` runs one reviewer seat through headless
  `codex exec` (read-only sandbox, JSON output schema) and writes the same `.md` artifact a
  Claude seat would; `panel` fans a `sf-route` roster out concurrently and emits the
  `spawn` events; `home init|gc` manages the per-run isolated `CODEX_HOME`. The default
  backend is Claude and nothing below changes for it.

**Spawn accounting.** After every `Agent` spawn returns (explorers, plan roles,
implementers, reviewers, fixers), one call:
`sf-log spawn role=<role> agent_type=<type> model=<m> phase=<plan|implement|review|fix>
round=<n> tokens=<from usage block|omit> duration_ms=<…|omit> agent_id=<id> artifact=<path>
started=<epoch ms captured before the spawn>`. Two fields are measured, never recalled:
`started=` is `T0=$(date +%s%3N)` from the Bash call **before** the spawn message (a
`wall_ms` under a second means it was taken at log time — `sf-log` warns and `sf-log
check` flags the row); `model=` is the agent's frontmatter `model:` value read when
logging — `grep -m1 '^model:' "${SF_PLUGIN_ROOT}"/../*/agents/<agent>.md` (the glob
spans every installed plugin, which is where the routed reviewers live; `session` for
`inherit`). A built-in with no agent file (`general-purpose`, `Explore`) logs the model
passed on the spawn call, else `session`. With `SOLO_MODEL` set, every non-Explore spawn
passes `model: "$SOLO_MODEL"` and logs that value instead (`runtime.md` §Solo-model
fleet). Never what `model-tiering.md` says the role
normally runs at. `agent_id` is **required on reviewer and
plan-role spawns** — it is the only durable address for warm continuation. Warm
exchanges log `stage closure-exchange` / `clarify` with the same cost fields plus
`agent_id=<id>` (refused without it whenever usage is present): `sf-log` de-cumulates a
Claude continuation's usage against that agent's earlier rows, so each row carries its
own turn (`warm-closure.md` §Audit events). Roles are enforced at write — a role outside
`spawn-accounting.md`'s prefixes, a bare `reviewer:`, or an implementer at `phase=fix` is
refused (a reviewer logs `reviewer:<agent>`, a fixer `fixer`). With `SHIP_REVIEW_BACKEND=codex`, `sf-codex` writes
its own seats' `spawn` / `closure-exchange` / `clarify` events (`backend=codex`,
`agent_type=codex-exec`, `agent_id=<thread_id>`) — **the orchestrator logs no event for a
Codex seat, cold or warm**; it adds `backend=claude` to the pinned Claude seats' spawn
events in such a run. Field semantics: `../../references/shared/spawn-accounting.md`.

**Artifact handoff.** Every spawn writes its report to a declared path under
`$ARTIFACT_DIR` and returns one line; the orchestrator reads the file, never the return
text (empty return + file on disk = success; missing file after the spawn settles →
retry once, then failed spawn). `$ARTIFACT_DIR` is committed on every run (phase
skills pick it up on another machine — `phase-contract.md`). Templates and the output
contract: `../../references/shared/reviewer-prompts.md`, `../../references/shared/plan-prompts.md`.

**Interview policy** — the one operator-question policy; every question site below points
here. A question that blocks nothing must never idle the run.
- **Form.** Every user prompt is an the available structured user-input tool with enumerated options, the
  recommendation first (include an explicit "Other / type your own" option when free text
  is valid). Never a prose question.
- **Severity decides whether a finding's question blocks.** A question raised by a
  MEDIUM/LOW finding — a policy call or an `UNVERIFIED … confirm with the operator` note on
  one included — is never asked mid-run: it always gets one entry in
  `$ARTIFACT_DIR/pr-questions.md` (question, options, the follow-up it belongs to when it
  has one). The finding itself goes to §Follow-up tasks (or the review residue when it is
  below the floor) only when it names a code change; one whose only content is "confirm
  with the operator" is not filed (`scope-policy.md` Rule 6). That PR-time list is asked once, after the PR
  opens (3g), and never delays it. A question that decides a CRITICAL/HIGH fix is blocking
  (3e bucket 2), policy call or not.
- **Blocking questions are queued.** Beyond those, a question is blocking only when the
  next step cannot run without the answer. Append it to
  `$ARTIFACT_DIR/operator-questions.md` (id, question, options with the recommendation
  first, what it blocks, `answer:` left empty until answered) and keep doing the work that does not depend on it: other batches,
  other epic phases, seats and panels already running, closures and fixes for unaffected
  findings, gates, follow-up filing, and PR-body drafting (§Use the waits).
- **Ask the queue together** — every entry with an empty `answer:` in one exchange, ≤ 4
  per call in back-to-back calls — only when no unblocked work remains; fill each
  `answer:` as it lands.
- **Entry-time questions are asked at once**, because no other work exists yet: Stage 0's
  input and title prompts, 1A requirements, 1.9 express bounding and bundle split, Stage 2
  acceptance-criteria bounding, Stage 2 open questions and premises, and the epic kickoff.
- **New feature toggles are the operator's call (CANONICAL).** A toggle is anything new
  whose job is to switch a behavior on or off: an env var, infrastructure context key, remote config parameter,
  database or admin flag, or a constant read as a switch. No seat adds one on its own
  judgment. When the plan, an express bound, or a writer wants one, it is an entry-time
  question (plan gate, 1.9) or, when it first appears in a diff, a blocking bucket-2
  question — one the available structured user-input tool per toggle naming the behavior it gates and what
  breaks if it is on by default, options: **None — ship the behavior on** (recommended
  unless the toggle protects a live rollout), **Remote config parameter** (operator flips it per
  environment without a deploy), **Admin page switch** (the app's system feature flags, per
  environment, audited), "Other". Record the answer in the plan's `## Decisions`; an
  unapproved toggle in a diff is removed by the fixer, the behavior shipping on.
- **Mark every wait.** Before every the available structured user-input tool, and before ending a turn that waits
  on the operator, log
  `sf-log stage operator-wait questions=<n> at=<stage> blocking='["<id>",…]' artifact=<queue file>`;
  on the answer, `sf-log stage note event=operator-answered questions=<n>`. `$ship-report`
  counts that interval as operator wait (`spawn-accounting.md` §Session marks). Stage 0
  steps 1–2 run before `$RUN_LOG` exists and are exempt.

**Notifications.** `PushNotification` (status `proactive`, ≤ 200 chars, one line) at:
plan accepted (`ship-task <id>: plan accepted, implementing`), reviews clean
(`… reviews clean, running build check`), PR open (`… done: PR #M open against
<base>`), and every `CHECKPOINT_REQUIRED`. Nothing per batch, round, or reviewer. A
failed push is logged and ignored.

## Status lifecycle

Transitions marked *(auto)* are made here via `tracker task status`; everything after PR-open
is the human's. Merge-close is **manual** — the skill never auto-merges.

| Status (`status:<slug>` label) | Meaning | Who sets it |
|---|---|---|
| `backlog` | pre-triage | human |
| `to do` | ready to plan | cut-task / checkpoint rollback *(auto)* |
| `planning` | Stage 2 running | Stage 2 entry *(auto)* |
| `ready for development` | plan accepted, or express classified | Stage 2 clean pass / Stage 1.9 *(auto)* |
| `in development` | Stage 3 running | Stage 3 entry *(auto)* |
| `remediating` | draft PR with unresolved CRITICAL/HIGH findings | `unresolved-review-findings` at PR-open *(auto)* |
| `development complete` | PR open, AC verified — the agent's terminal state; a PR on a non-integration base stays here until that base merges (§PR link-back release rule) | 3g *(auto)* |
| `ready for testing` → `testing` → `shipped` | post-merge validation and deploy | human (`shipped` = manual close after merge) |
| `blocked` | a `CHECKPOINT_REQUIRED` stopped the run | every other checkpoint *(auto)* |
| `cancelled` | won't do | human |

**Checkpoint convention.** Before stopping on any `CHECKPOINT_REQUIRED`: write the run
cursor (§Run state), then `tracker task status "$TASK_ID" blocked` — except
`unresolved-review-findings`, which sets `remediating` at PR-open and never stops — and
post the checkpoint block as a task comment (`**[ship-task · checkpoint]**`, including the
`resume:` line). Stage 1B routes a `blocked`/`remediating` task from that comment plus the
runstate: the status says *stopped*, the comment says *why and where*. The `sf-log
checkpoint` row is the wait mark for a stop; any question asked on the way in or out of
one logs `operator-wait` first (§Interview policy).

## PR link-back

The tracker, not GitHub's closing keywords, owns the task's lifecycle:

- Every PR body carries `Refs #<n>` (the phase sub-issue on an epic layer PR, plus the
  parent on the final layer). Never `Closes`/`Fixes`/`Resolves`: those keywords fire only
  on a merge into the default branch, so they skip the human's `shipped` close on an
  integration base and read as a promise the lifecycle won't keep.
- At PR-open (or per-layer submit) `sf-push --kind final` does the link-back and reports
  it as its `tracker` result: it posts the PR URL as a task comment signed with the
  entering skill (`--skill`: `**[ship-task · pr]**`, `**[review-task-code · pr]**`), records
  the **GitHub PR** link (`tracker task pr`) and the **GitHub Branch** link
  (`tracker task branch`, `<repo url>/tree/<branch>`) in the issue's sticky links comment, then the status passed as
  `--task-status`: `development complete` — or `remediating` when the PR stayed a draft. A
  missing status or link write is fail-soft: the script falls back to
  `ready for testing` / reports the field `failed`, and the final report flags it; a
  tracker gap never halts a finished run. The comment and the status are left unwritten
  on `CONFLICTING` and while the hook's test arms are unconfirmed; 3g says who writes
  them then. On an epic, the per-phase subtask link-backs stay with the orchestrator
  (`tracker` directly).
- **One link-back per PR.** A skill that runs 3g by reference (`review-task-code`) posts
  no PR comment, field or status of its own: the 3g call has written them under that
  skill's name.
- **Release rule** (`../../references/shared/base-branch.md` §Release rule). Compare the run's
  `$BASE_BRANCH` — the ultimate base, never a stacked layer's PR base — with
  `$INTEGRATION_BRANCH` (the `--integration` resolve, Stage 0 step 6). When they differ,
  the task still goes `development complete`, and both the `**[ship-task · pr]**` comment
  (the sentence travels as `sf-push`'s `--note`) and the final report say that the PR
  targets `<base>` and that the task stays `development complete` until `<base>` merges
  into `<integration>`; cutting that release is the operator's step.
- The final report restates the manual-close convention (`shipped` after merge).

## Follow-up tasks — filed at triage, into the run's cleanup bundle

Bucket-3 findings that clear the filing floor (`scope-policy.md` §"The filing floor…" —
de-dupe, floor, generation cap; Rule 4) are filed **in the triage that bucketed them**,
never held for 3f.6 (holding them to the PR tail strands their provenance in a footer). They are tracker tasks (issues in
the same repo), and every one is a subtask of **one cleanup bundle per run**:

1. **Bundle parent — lazy, once per run**, on the first finding that clears the floor.
   `tracker tag ensure followup && tracker tag ensure followup-bundle`, then
   `tracker task create --title "Cleanup: $TITLE (run $(basename "$RUN_LOG" .jsonl))" --status "to do" --tag followup-bundle --tag tech-debt --body-file <f>`
   — the bundle and its subtasks live in the run's repo, so a bundle groups by
   **provenance**, and each item records its domain.
   Body: `## Requirements` (out-of-scope review findings from this run; each subtask is
   self-contained), `## Acceptance Criteria` (every subtask's own criteria met; nothing new
   filed below HIGH — the generation cap), `## Branch` (`chore/cleanup-<slug>-<run epoch>`),
   `## Origin` (task URL, `$RUN_LOG` basename; the PR URL is added at 3g), `## Context`.
   Record `$BUNDLE_ID` / URL; `sf-log stage followup-bundle bundle=<id> round=<n>`.
2. **One subtask per finding**, at its triage:
   `tracker task create --parent "$BUNDLE_ID" --title "<finding title>" --status "to do" --tag followup --tag <bug|tech-debt> --body-file <f>`
   — the standard body (Requirements = the finding and its recommendation, verbatim;
   Acceptance Criteria = the finding's own verification; Branch = the bundle's; Context)
   plus an `## Origin` section, one line each: `run:` (`$RUN_LOG` basename) · `phase:` (epic
   phase id or `single`) · `round:` · `reviewer:` · `finding:` (id) · `severity:` · `file:`
   (`path:line`) · `artifact:` (the review artifact path) · `domain:` (the cut-task §5 domain
   the code belongs to) · `goal-post: yes|no` (3e's goal-post rule). De-dupe across rounds
   by file + mechanism before filing — the same defect reopened later is the same task.
   Footer: `*Auto-filed from an out-of-scope review finding via $ship-task (task <url>). Reviewer: <role>. Severity: <sev>.*`
3. Append ids/urls to `$FOLLOWUP_TASKS` (the PR body's `## Follow-up tasks` lists the
   bundle URL, then one line per subtask) and log
   `sf-log stage followup-tasks created='["<id>",…]' bundle=<id> round=<n>` per filing
   batch — several per run is the expected shape.

Epic runs share one bundle across layers (`phase:` tells the items apart); `$EPIC_FOLLOWUPS`
is the same list. A run whose task carries `followup` or `followup-bundle` raises the filing
bar to HIGH+ / recurrence-guard (the generation cap). Shipping a bundle: Stage 1.9 §Bundle path.

**Nothing parks** (`scope-policy.md` Rule 7). The bundle ships as its own run immediately after
this run's PR is verified (§Ship the bundle, end of 3g). An item that cannot ship now goes to
`blocked` with a `## Blocker` naming the operator ruling, cleanup release, or external party it
waits on — `tracker task edit <id> --status blocked` — never left in `to do`.

## Procedure

### Stage 0 — Preflight + input mode

1. **Classify `$ARGUMENTS`.** `^https://github\.com/[^/]+/[^/]+/issues/([0-9]+)$` → existing-task
   mode, `$TASK_ID` = the issue number. `^#?[0-9]+$` and `tracker task view` resolves → existing-task
   mode (a 404 falls through to title mode — the API is the arbiter). A readable `*.md`
   path inside the repo → PRD mode (parse Title / Requirements / Acceptance Criteria /
   Context; a missing section → `CHECKPOINT_REQUIRED: prd-schema-incomplete`). Anything
   else → new-task mode, `$RAW_TITLE`. Empty → the available structured user-input tool (existing id / new title /
   PRD path) and re-classify.
2. **Sanitize the title once**: strip `` $ ` " \ ! ( ) | ; & > < `` and newlines → `$TITLE`
   (in existing-task mode, sanitize the task `name` the same way). >20% loss →
   the available structured user-input tool (use sanitized / enter a different title — never "use original").
   `$TITLE` is the only form that reaches a shell.
3. **Audit log.** `export RUN_LOG=$(node "$SF/sf-log.mjs" init --skill ship-task ${TASK_ID:+--task $TASK_ID})`
   (absolute path, anchored at the launch dir — a relative path splits the log the moment a
   later step `cd`s). It moves into the worktree at §Worktree (below) so the log ships with
   the branch; until then it lives under the launch checkout's `docs/plans/`. `export SF_RUN_TASK="$TASK_ID"` as soon as it is known (Stage 1A sets
   it after the cut).
4. **Clean launch tree.** `if [ -n "$(git status --short -- ':/' ':(top,exclude)docs/plans/*.jsonl' ':(top,exclude)docs/plans/*.runstate.json')" ]; then echo "ERROR: working tree is dirty"; exit 1; fi`
   (`if/fi`, not `&& { }` — the bare form exits non-zero on a clean tree too; the excludes are
   the run's own bookkeeping, §Run state & resume).
5. **Run preflight** per `../../references/shared/run-preflight.md` (it logs the `preflight` event).
   Missing `sf-*` plugins or a damaged worktree → `CHECKPOINT_REQUIRED: preflight-failed`
   now, before anything outward exists. Expired cloud credentials are carried to 3f.5's AC
   table as `NOT VERIFIED — credentials expired at Stage 0`, never read as a pass.
5.5. **Execution mode.** Resolve `sf-runtime resolve --host "$SF_HOST"` per
   `runtime.md`, and record `host` / `mode` / `solo_model` in the preflight event and run cursor.
   **`SOLO_MODEL`** (e.g. `SOLO_MODEL=opus`) locks every non-Explore seat to one Claude
   model — `runtime.md` §Solo-model fleet; the resolver rejects it with hybrid or Codex.
   Native Codex uses native subagents for every stage; skip the headless setup in this
   paragraph and use the runtime adapter for every spawn/continuation below.
   **Claude-host hybrid mode:** `HYBRID_MODE` ∈ {`off` (default), `review`, `codex`} —
   `../../references/shared/review-backend.md` §Hybrid mode. `review` = the review seats on Codex
   (`SHIP_REVIEW_BACKEND=codex` is its back-compat alias); `codex` = review **plus** the
   implementer, fixer and mop-up seats on Codex (`gpt-6.1-sol` / low on the `default`
   service tier — tier `writer` in `scripts/review-tiers.json`). Explore stays the built-in
   Claude agent in every mode. When not `off`: run that file's §Preflight (`codex --version`, `codex login
   status`, `export SF_CODEX_HOME=$(node "$SF/sf-codex.mjs" home init --run
   "$(basename "$RUN_LOG" .jsonl)")`); any failure → `CHECKPOINT_REQUIRED: preflight-failed`
   (detail: `hybrid mode <mode>: <reason>`) — never a silent downgrade of the run to Claude.
   Either way the choice is recorded once, as `hybrid_mode=<off|review|codex>` and
   `review_backend=<claude|codex>` on the `preflight` event (step 5). Every "with
   `SHIP_REVIEW_BACKEND=codex`" clause below reads as "with `HYBRID_MODE` ≠ `off`"; the
   writer substitutions apply only under `HYBRID_MODE=codex`; Explore is never substituted. Use the exported
   `HYBRID_MODE` from `runtime.md`; never recompute it from legacy variables.
   Resolve the fix-loop ceiling here too: `SHIP_FIX_ROUND_CEILING="${SHIP_FIX_ROUND_CEILING:-6}"`
   (3e step 7; per phase on an epic).
6. **Ship mode, launch branch, base branch.**
   ```bash
   if [ -n "$SHIP_MODE_OVERRIDE" ]; then SHIP_MODE="$SHIP_MODE_OVERRIDE"
   elif [ "$CLAUDE_CODE_ENTRYPOINT" = "cli" ] && [ -d /workspace ] && [ -w /workspace ]; then SHIP_MODE="worktree"
   else SHIP_MODE="inline"; fi
   LAUNCH_BRANCH=$(git rev-parse --abbrev-ref HEAD)
   git fetch origin --quiet 2>/dev/null || true
   BASE_BRANCH=$(node "$SF/sf-base-branch.mjs") || { echo "CHECKPOINT_REQUIRED: preflight-failed (base branch)"; exit 1; }
   INTEGRATION_BRANCH=$(node "$SF/sf-base-branch.mjs" --integration) || { echo "CHECKPOINT_REQUIRED: preflight-failed (integration branch)"; exit 1; }
   ```
   The shared resolver (`../../references/shared/base-branch.md`) owns the precedence and the stop
   rule; an override missing on origin stops the run here, before anything exists. This
   `$BASE_BRANCH` serves new-task mode only; every pickup re-resolves in §Worktree
   (runstate, then the task body's `## Base branch`). `$INTEGRATION_BRANCH` ignores every
   override and feeds the release rule (§PR link-back).
   `development` in this file always means `$BASE_BRANCH`. **worktree** = local
   devcontainer with writable `/workspace/.worktrees/` (Stage 1 creates a worktree; PR
   base `$BASE_BRANCH`). **inline** = Claude Code Web or anything else (Stage 1 creates
   the branch in place; work is pushed to `origin` for local pickup, through `push-env`
   like every push — `shared/run-preflight.md` §Push-gate baseline).
   **Inline mode cuts no scratch or phase worktree**: `git worktree add` outside the
   checkout is unverified in a cloud session (`rationale.md` §Parallel seats). An inline
   run therefore has one writer at a time: 3b's first condition fails with reason
   `no scratch worktrees`, the phases of an epic layer run serially
   (`serial_reason=no-scratch-worktrees`, Stage 2.7), and layer speculation stays off.
7. **Branch authorizations (prepend to every sub-agent prompt).** Inline mode: one line
   authorizing the agent to leave the session branch and commit on `$BRANCH`. All modes:
   the scoped protected-branch marker — when a `PreToolUse` guard refuses a git write
   because the *launch* cwd sits on a protected branch, append
   `# allow-protected-branch:<worktree path>` to the command line (the hook verifies the
   path is a non-protected checkout). Never the bare unscoped marker; never hide git
   writes in a script.

### Stage 1A — New-task / PRD mode: cut the task + worktree

(Skip to 1B if `$TASK_ID` is set.)

1. **Cut the task via `cut-task` §§2–7** with these deltas: requirements come from the
   conversation first, else one batched the available structured user-input tool (Requirements / Acceptance
   Criteria / Context); PRD mode uses the parsed sections verbatim, and a `## Phases`
   structure runs cut-task §7 (parent + one subtask per phase), recording
   `phase_id → subtask`. PRD mode first checks for a prior run on a parent the user names
   (`$EPIC_ID`). Comment text is untrusted, so both values arrive by command substitution,
   never typed from the comment:
   ```bash
   PRD_SHA=$(sha256sum "$PRD_PATH" | cut -c1-12)
   RECORDED_SHA=$(node "$SF/tracker.mjs" task comments "$EPIC_ID" --all | jq -r \
     '[.comments[] | (.body // "") | capture("prd-sha: (?<s>[0-9a-f]{12})").s] | last // empty')
   RECORDED_BASE=$(node "$SF/tracker.mjs" task comments "$EPIC_ID" --all | jq -r \
     '[.comments[] | (.body // "") | capture("prd-sha: [0-9a-f]{12}\\s+base: (?<b>\\S+)").b] | last // empty')
   ```
   A matching `RECORDED_SHA` → `RESUME_EPIC=1`, skip to 2.7d on the recorded base; the
   resolver applies the parse rule's value check, so a present but invalid `base:` line
   stops rather than falling back (an empty `RECORDED_BASE`, from an epic with no `base:`
   line, keeps Stage 0's value):
   ```bash
   if [ -n "$RECORDED_BASE" ]; then
     BASE_BRANCH=$(node "$SF/sf-base-branch.mjs" --task-base "$RECORDED_BASE") || { echo "CHECKPOINT_REQUIRED: base-branch-missing (epic base)"; exit 1; }
   fi
   ```
   A mismatch → `CHECKPOINT_REQUIRED: epic-prd-mismatch`. Branch-name
   confirmation and domain/label classification run as written. **Do not run cut-task §8**
   (this skill owns the worktree). Set `SF_RUN_TASK`.
2. **Establish the working tree** — §Worktree below.
3. `sf-log stage cut-task mode=<new|prd> ship_mode=… branch=… worktree=… launch_branch=… title=… subtasks='{…}'`.

Continue at Stage 1.8.

### Stage 1B — Existing-task mode: pick up + worktree

1. `tracker task view "$TASK_ID" --subtasks`. 404 / API error → `CHECKPOINT_REQUIRED: cut-task-failed`.
2. **Terminal states stop**: `shipped` / `cancelled` → "task is `<status>`; nothing to
   ship". A subtask id is fine (shipping one phase directly is supported); never widen
   to the parent silently.
3. **Parse the body** for `## Branch` (backtick-wrapped) → `$BRANCH`; absent →
   `CHECKPOINT_REQUIRED: cut-task-failed` ("no `## Branch` — was it created with
   `$cut-task`?"). The optional `## Base branch` (backtick-wrapped) → `$TASK_BASE`, empty
   when absent; §Worktree passes it to the pickup resolve. Both values pass
   base-branch.md §Task-body rule's parse rule before any assignment (a failing `## Branch`
   → `cut-task-failed`, a failing `## Base branch` → `base-branch-missing`) and are assigned
   in single quotes. `$TITLE` from `name`, sanitized.
4. **Epic detection**: a non-empty `subtasks` array whose bodies carry `## Phase` sections
   → epic pickup (structure from the subtasks, plan from the parent). Note it for 2.7.
   **Bundle detection**: a parent tagged `followup-bundle` (or whose subtasks all carry
   `followup` with `## Origin` sections and no `## Phase`) → Stage 1.9 §Bundle path; a
   bundle is never an epic and never express. Detection selects the *path*; step 5's table
   still governs the *entry stage* — a bundle already `ready for development` resumes at
   2.5 → 3 against its committed bundle plan and does not redo the reviewability split.
5. **Entry stage from status:**

   | Status | Entry |
   |---|---|
   | `backlog`, `to do` | Stage 1.8 (then 1.9) |
   | `ready for development` (single) | Stage 3 via 2.5 — plan from `docs/plans/task-$TASK_ID.plan.md` on the branch, else the latest plan-shaped comment. A **subtask**'s plan is the parent's `docs/plans/task-<parent>.plan.md`, scoped to its `## Phase`. |
   | `ready for development` (epic) | 2.5 → **2.7d** (never single-task Stage 3) |
   | `planning` | read the runstate: a committed `checkpoint` → adopt via the `blocked` row; else stop ("a run is live or crashed mid-plan; if stalled, set `to do` and re-run") |
   | `in development` | staleness probe: runstate `updated` < 2h → stop ("may be live"); older/absent → adopt the crashed run (§Run state): the ledger continues in the runstate's `log_path`, next event `resume-adopted` |
   | `blocked`, `remediating` | read the latest `**[ship-task · checkpoint]**` comment + runstate; a committed checkpoint adopts immediately; resume at the recorded stage, restoring the pre-checkpoint status (`planning`-stage checkpoints re-enter at `to do` → 1.8) |
   | `development complete`, `ready for testing`, `testing` | stop — development is done; inspect the PR. First, a runstate whose `pending_operation.kind` is `live-smoke` (any status, `remediating` included) → apply §Live smoke **Resume**, then stop |

6. **Establish the working tree** — §Worktree, with `PICKUP=1`. A reused worktree that is dirty →
   `CHECKPOINT_REQUIRED: worktree-dirty` (a prior run crashed mid-write; a human decides).
7. `sf-log stage cut-task mode=existing entry_stage=<1.8|2.5|3|resume> …`.

#### Worktree (both modes)

A pickup (`PICKUP=1`, Stage 1B) re-resolves the base before any worktree or branch exists,
in both modes (`../../references/shared/base-branch.md` §Pickup rule): the runstate outranks the task
body's `## Base branch`, which outranks the workspace settings, and `--head` skips an
override naming the task branch itself. A stop here is
`CHECKPOINT_REQUIRED: base-branch-missing` — `preflight-failed` fires only before a
worktree exists. New-task mode keeps Stage 0's value.

```bash
RS_REL="docs/plans/task-$TASK_ID.runstate.json"
WT_PATH=""; [ "$SHIP_MODE" = "worktree" ] && WT_PATH="/workspace/.worktrees/$(echo "$BRANCH" | tr '/' '-')"
PERSIST_TARGET=""
if [ -n "$PICKUP" ]; then   # base-branch.md §Pickup rule Steps 1–2 block
  RS_FILE=""   # the reused worktree's runstate, else the branch tip's (inline mode: read before git switch)
  if [ -n "$WT_PATH" ] && [ -f "$WT_PATH/$RS_REL" ]; then RS_FILE="$WT_PATH/$RS_REL"
  elif git cat-file -e "origin/$BRANCH:$RS_REL" 2>/dev/null; then RS_FILE=$(mktemp); git show "origin/$BRANCH:$RS_REL" > "$RS_FILE"; fi
  RESOLVE_CWD=$(git rev-parse --show-toplevel); [ -n "$WT_PATH" ] && [ -d "$WT_PATH" ] && RESOLVE_CWD="$WT_PATH"
  BASE_BRANCH=$(node "$SF/sf-base-branch.mjs" --cwd "$RESOLVE_CWD" ${RS_FILE:+--runstate "$RS_FILE"} --task-base "$TASK_BASE" --head "$BRANCH") || { echo "CHECKPOINT_REQUIRED: base-branch-missing"; exit 1; }
  RS_BASE=""
  [ -n "$RS_FILE" ] && RS_BASE=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).base_branch ?? ""' "$RS_FILE")
  { [ "$BASE_BRANCH" = "$RS_BASE" ] || [ "$BASE_BRANCH" = "$TASK_BASE" ]; } && PERSIST_TARGET="$BASE_BRANCH"   # recorded as the new worktree's target=
fi
if [ "$SHIP_MODE" = "worktree" ]; then
  mkdir -p /workspace/.worktrees
  if [ -d "$WT_PATH" ]; then
    echo "Reusing $WT_PATH"   # never reset a reused worktree
    [ -z "$(git -C "$WT_PATH" status --short -- ':/' ':(top,exclude)docs/plans/*.jsonl' ':(top,exclude)docs/plans/*.runstate.json')" ] || echo "ERROR: reused worktree is dirty"   # → worktree-dirty; bookkeeping excluded (§Run state & resume)
    AT=1b   # then run the §Integration sync block (shared/integration-sync.md): a reused branch waited, and the base moved
  else
    # The name question first (base-branch.md §Worktree name question → DEV_NAME and
    # LAUNCH_TARGET; log
    # operator-wait), then its fresh-branch block: the repo script with the base, the
    # name (--developer) and, only when the script advertises it, --target
    # "$PERSIST_TARGET" (long-running — a generous timeout or background and wait); with
    # no repo script, shipflow $create-worktree Steps 1.5, 2, 3, 4 with
    # WT_TARGET="${PERSIST_TARGET:-$LAUNCH_TARGET}". Then base-correct a FRESH branch only: reset --hard when
    # it has no origin counterpart and no local-only commits; otherwise merge the base in.
    if ! git -C "$WT_PATH" merge-base --is-ancestor "origin/$BASE_BRANCH" HEAD 2>/dev/null; then
      if ! git -C "$WT_PATH" show-ref --verify --quiet "refs/remotes/origin/$BRANCH" \
         && [ "$(git -C "$WT_PATH" rev-list --count HEAD --not --remotes)" = "0" ]; then
        git -C "$WT_PATH" reset --hard "origin/$BASE_BRANCH"
      else
        git -C "$WT_PATH" merge --no-edit "origin/$BASE_BRANCH" || { git -C "$WT_PATH" merge --abort; echo "ERROR: base-merge conflict"; }
      fi
    fi
  fi
  cd "$WT_PATH"; [ "$(pwd -P)" = "$(cd "$WT_PATH" && pwd -P)" ] || { echo "ERROR: failed to enter $WT_PATH"; exit 1; }
else
  git switch -c "$BRANCH" 2>/dev/null || git switch "$BRANCH"
  WT_PATH=$(git rev-parse --show-toplevel)
  AT=1b   # §Integration sync block (shared/integration-sync.md); a conflict here → integration-conflict, never build on a tip that lacks the base
fi
ARTIFACT_DIR="$WT_PATH/docs/plans/task-$TASK_ID.artifacts"; mkdir -p "$ARTIFACT_DIR"
RUNSTATE="$WT_PATH/docs/plans/task-$TASK_ID.runstate.json"
# Anchor the audit log to the worktree (same basename, so the derived Codex run home is
# unchanged): a log left in the launch checkout is untracked there and invisible to
# `$ship-report latest` from the branch (a ledger left in the launch checkout is invisible there).
if [ "$(dirname "$RUN_LOG")" != "$WT_PATH/docs/plans" ]; then
  mkdir -p "$WT_PATH/docs/plans" && mv "$RUN_LOG" "$WT_PATH/docs/plans/" && export RUN_LOG="$WT_PATH/docs/plans/$(basename "$RUN_LOG")"
fi
```

**Adopting a run keeps its ledger.** On every adopt (§Run state & resume), right after
the block above: `export RUN_LOG=$(node "$SF/sf-log.mjs" init --resume "$RUNSTATE")` — it folds this
session's lines into the runstate's `log_path` and prints that path (no recorded log → a
new one, warned). When `HYBRID_MODE` ≠ `off`, re-run `export SF_CODEX_HOME=$(node
"$SF/sf-codex.mjs" home init --run "$(basename "$RUN_LOG" .jsonl)")` (idempotent) so the
Codex run home follows the ledger; then log `resume-adopted`.

**Push-gate baseline kick** — next, where `$RUNSTATE` exists. On an adopt, `init --resume`
above runs first, before any `sf-log cursor`: the kick's cursor write would otherwise
repoint `log_path` to this session's log and orphan the run's ledger. The kick is the
foreground path record and background `sf-gates.mjs baseline` of `shared/run-preflight.md`
§Push-gate baseline (the command lives there), logged `event=push-gate-kick`, and is
skipped when the runstate already holds `push_gate_skips`. Its result governs every push
in the run: suites already failing on the base become one queued skip approval. Beside
the kick, in the same order (after an adopt's `init --resume`), record the base:
`node "$SF/sf-log.mjs" cursor "$RUNSTATE" base_branch="\"$BASE_BRANCH\""` — JSON-quoted so a
numeric-looking name stays a string; idempotent; never skipped.

**Pickup ends current with the base.** The `AT=1b` lines above run the §Integration sync
block (`../../references/shared/integration-sync.md`) on every path that does
not cut a fresh worktree from `origin/$BASE_BRANCH`: a reused worktree, the inline-mode
branch, and every entry that adopts a paused or crashed run (§Run state & resume,
`at=resume`). The block's sync-point table is the whole schedule — 1b, 3d, every 3e round,
3f, the 3g probe, and the epic `layer` sync — and its conflict rule is the only one
(resolve what this run rewrote; abort + `integration-conflict` on a product-decision or
foreign-file conflict). The split-phase skills and `fix-task` enter through 1B and inherit
it.

**The full local install is deferred.** Do **not** kick a background `npm install` here —
§Early install kick (under Stage 1.9) starts it, in the background, once the computed
file set shows the diff reaches a workspace whose build needs it (`rationale.md`
§Implementation — a multi-GB install per worktree, only ever consumed by the production
front-end build). Every later tool call runs from
`$WT_PATH` (a shell `cd` does not persist across calls — Codex sets `workdir`; Claude
uses `git -C`/absolute paths).

### Stage 1.8 — Reproduce first (bug, performance, concurrency)

A defect fix is planned against a failing test that ran in the real environment, never
against a theory.

1. **Select.** Stage 1.8 applies when the task carries the `bug` tag (`$fix-task` sets it)
   or its **title** matches
   `\b(deadlock|race condition|concurren\w*|contention|performance|latency|slow(er|down)?|timeout)\b`
   (case-insensitive; the body is not scanned — requirements describe a domain as often as
   a defect). Epic parents and bundle parents are exempt: epic phases and bundle items are
   planned and fixed by their parent's path, not here. A selected task is claimed at once
   (`tracker task status "$TASK_ID" planning`), so a concurrent run sees it taken while the seat
   works. **Resume** checks, in order: a `[repro] <task id>` commit in
   `git -C "$WT_PATH" log "origin/$BASE_BRANCH..HEAD"` with neither record →
   `CHECKPOINT_REQUIRED: worktree-dirty`, never a reset, and no waiver overrides it. Otherwise
   skip the stage when the runstate holds `repro.sha` (an ancestor of `HEAD`; step 7's
   criterion comes from `repro.test`), or holds `repro.waived` and that comment, re-read,
   still meets the waiver's text and author rules below. **Waiver:** with no record and no
   unrecorded `[repro]` commit, the stage is skipped for a comment whose whole text starts `reproduce-first: waived — ` with a
   real reason (not empty, not a `<placeholder>`), posted after the latest
   `**[ship-task · checkpoint]**` comment (or at any time, when none exists), and not signed
   `**[ship-task · …]**` or `**[fix-task · …]**`. Accepting it persists
   `sf-log cursor "$RUNSTATE" repro.waived=<comment id>`. Every task that does not run the seat logs
   `sf-log stage note event=reproduce-first kind=n/a reason=<no-trigger|epic-parent|bundle-parent|resumed|waived>`
   and continues at 1.9.
2. **Real environment.** A reproduction runs in the runtime components the failure occurs
   in: the same database engine, schema, triggers and code, the real processes, the real
   concurrent actors — run locally, on a local or containerized instance. A mock, stub,
   fake cursor, recorded statement order or in-memory stand-in is not a reproduction,
   however faithful. It is never a shared or deployed environment: a failure observable only
   there is not reproduced, and the diagnosis says so.
3. **Seat.** Before the seat spawns, derive the file set per 1.9 step 1 and run 1.9
   step 2's classification on it. When `SHIP_SPECULATE` is not `off` and the file set
   has more than 2 files, the plan-phase Explores (Stage 2 §Plan-phase Explores: one
   `Explore` per area of the file set, briefed from the task body) are spawned in the
   same message as the repro seat, each logged `role=explore phase=plan`. An area whose
   `explore-<area>.md` already exists in `$ARTIFACT_DIR` is not explored again.
   `REPRO_BASELINE=$(git -C "$WT_PATH" rev-parse HEAD)` and
   `REPRO_KEY=$(jq -cS '{repro, push_gate_skips}' "$RUNSTATE")`, then spawn
   `sf-implementer` on Claude in every `HYBRID_MODE` (`sf-codex implement` needs a plan,
   which does not exist yet), logged `role=implementer:repro phase=plan`, with a
   **test-files-only** brief: write one test that fails in the real environment for the
   reason the task states; run it unmarked and confirm it fails for that reason; then add
   the repository test framework's expected-failure marker (vitest: `test.fails`) so
   pre-push suites stay green, and commit it with the subject `[repro] <task id>`. No
   production code. When no real-environment reproduction exists, commit nothing and write
   what was tried and observed to `$ARTIFACT_DIR/repro-diagnosis.md` — summarized errors,
   never credentials, connection strings or environment dumps (the file is pushed).
4. **Accept, then re-verify** (the orchestrator, after the seat returns). `REPRO_TEST` is
   the seat's reported test path, always quoted. Accept the commit only when
   `node "$SF/sf-route.mjs" classify --cwd "$WT_PATH" --config-ref "origin/$BASE_BRANCH" --diff "$REPRO_BASELINE..HEAD"` shows
   prod=0, meta=0 and exactly one test file, `"$REPRO_TEST"` is that file in
   `git -C "$WT_PATH" diff --name-only "$REPRO_BASELINE..HEAD"`, and
   `git -C "$WT_PATH" status --porcelain` lists nothing outside the **allowlist**
   (`$ARTIFACT_DIR`, the runstate and `$RUN_LOG`) while `jq -cS '{repro, push_gate_skips}' "$RUNSTATE"`
   still equals `$REPRO_KEY`. The guard covers `repro` and `push_gate_skips`, the records a
   seat could forge to pass this gate or skip push suites; the orchestrator's other keys
   (`log_path`, the cursor fields, the rest of `push_gate_*`) may change while the seat runs.
   When the orchestrator itself records `push_gate_skips` while the seat runs, it re-takes
   `REPRO_KEY` right after that write. Then strip the marker in the working tree, run the test with the
   repository test runner (vitest: `npx vitest run "$REPRO_TEST"`), and require the output
   to show it failing for the stated reason; restore it
   (`git -C "$WT_PATH" checkout -- "$REPRO_TEST"`) and require the marked run green. A
   commit that passes acceptance and re-verification is recorded with
   `sf-log cursor "$RUNSTATE" repro.sha=<sha> repro.test="$REPRO_TEST"`.
   A missing commit, or one that fails any check, is dropped: restore `"$REPRO_TEST"` with
   `git -C "$WT_PATH" checkout --` when that file exists in the working tree, then
   `git -C "$WT_PATH" reset --keep "$REPRO_BASELINE"` (never `--hard`). The drop succeeds
   when the reset exits 0, `HEAD` is `$REPRO_BASELINE`, `status --porcelain` lists
   nothing outside the allowlist, and `jq -cS '{repro, push_gate_skips}' "$RUNSTATE"` still equals `$REPRO_KEY`; otherwise → `CHECKPOINT_REQUIRED: worktree-dirty`. After a
   successful drop the orchestrator appends what it observed to
   `$ARTIFACT_DIR/repro-diagnosis.md` under step 3's rule, and the result is not reproduced.
5. **Log** `sf-log stage note event=reproduce-first kind=<bug|performance|concurrency> result=<reproduced|not-reproduced> test="<path|none>"`.
6. **Not reproduced** → `CHECKPOINT_REQUIRED: not-reproduced` with
   `$ARTIFACT_DIR/repro-diagnosis.md` attached: the run stops at diagnosis, no test is
   committed, and planning does not start. Step 3's Explore reports stay in
   `$ARTIFACT_DIR` for the resumed run. `resume:` add a reproduction hint to the task,
   or post a waiver comment per Stage 1.8 step 1, then re-run.
7. **Reproduced** → the test becomes criterion `R-1 guard: <test file> passes with no
   expected-failure marker` — the first bounded criterion of the Stage 2 requirements, or
   the first line of the express plan file's criteria. The implementer's fix removes the
   marker. Continue at 1.9 with the test file in the file set.

### Stage 1.9 — Blast-area routing

An epic (PRD fan-out or 1B subtask detection) is never express — go to Stage 2 (or 2.7d).
A bundle (1B) → §Bundle path below. Otherwise:

1. **Derive the file set**, once per run. Files the task body names, plus one `rg -l` over the body's
   distinctive terms (symbols, route segments, table names), capped at the first 40 hits;
   write it to `$ARTIFACT_DIR/express-files.txt`. When Stage 1.8 step 3 already wrote the
   file, reuse it and append the reproduction's test file — never derive it a second time.
2. **Compute conditions 1–3:** `node "$SF/sf-route.mjs" classify --cwd "$WT_PATH" --config-ref "origin/$BASE_BRANCH" --files "$ARTIFACT_DIR/express-files.txt"`
   → `express.bounded` (≤ 8 prod+test files), `express.few_workspaces` (≤ 3 prod
   workspaces — a small fix that touches a package and the two stacks that consume it is
   still small), `express.no_seam`. These are read from the output, never re-judged. The
   diff form at 3c adds `express.bounded_lines` (≤ 400 added+deleted lines), which is the
   abandonment tripwire for a fix that grew.
3. **Judge conditions 4–5 from the body:** acceptance criteria are already testable
   (something 3f.5 can run — not a plan artifact) **and bounded** — run
   `node "$SF/sf-route.mjs" ac-scan --file <task body as markdown> --compact`; an
   unbounded universal criterion counts as the one user-decidable question below (bound
   it: `guard:` / `fixture:`, written into the plan file) — and there is **no open
   question**. One user-decidable question (a product choice, naming, scope in/out, the
   bounding above) does not fail the condition: ask it now in a single the available structured user-input tool,
   write the answer into the plan file, continue. An investigation-bound question, or more
   than one open question, routes full.
4. **All five hold → express**: write the task body verbatim to
   `docs/plans/task-$TASK_ID.plan.md` under an `# Express path` header (noting that no
   adversarial review ran), `tracker task status "$TASK_ID" "ready for development"`, and
   continue at 2.5. Express downstream: Stage 2 skipped; one batch (scope per 3b), no separate
   `Explore` unless > 2 files; reviewers = 3d's roster (express deltas are stated
   there); fix loop max 1 round, no escape; build, AC,
   and PR gates unchanged. **Abandonment is mandatory** the moment the implementer's
   diff reports `express.eligible=false` under `sf-route classify --config-ref "origin/$BASE_BRANCH" --diff` (see 3c) —
   restore the full roster and the 2-round loop for the rest of the run and log
   `express-abandoned`.
5. Any condition fails → Stage 2. Log either way:
   `sf-log stage express-classification mode=<express|full> failed_conditions='[…]' file_count=N workspaces='[…]' seam=<bool> files=<path>`.
6. Run §Early install kick with `FILESET="$ARTIFACT_DIR/express-files.txt"`.

#### Early install kick (worktree mode)

The per-worktree full `npm install` exists only for the production front-end build. Decide from the
**computed file set** — never at worktree creation — and run it in the background so it
overlaps planning/implementation:

```bash
# $FILESET = express-files.txt (Stage 1.9) or the plan's scope files (3b); re-check at 3c if the diff grows
if [ "$SHIP_MODE" = worktree ] && grep -Eq "^(${SF_FULL_INSTALL_PATHS:-apps/web/|packages/})" "$FILESET" && [ ! -f .npm-install-full.done ] && [ ! -f .npm-install-full.pid ]; then
  ( nohup npm install --no-audit --no-fund > .npm-install-full.log 2>&1 && touch .npm-install-full.done ) &
  echo $! > .npm-install-full.pid
fi
```

`SF_FULL_INSTALL_PATHS` names the workspaces that need it (default: the web app and the
shared `packages/` it imports — a shared package counts as front-end-reachable). The build
gate awaits the done-marker; a run whose diff never reaches them never installs.

#### Bundle path (a `followup-bundle` parent)

A bundle is a bag of review findings that each arrived as `file:line` + recommendation +
verification — the fixer's input shape, reviewed once already. It gets no plan loop and no
epic machinery:

1. **Items** = the parent's open subtasks (`tracker task view --subtasks`; skip `cancelled`,
   `development complete`, `shipped`). Write `docs/plans/task-$TASK_ID.plan.md` under a
   `# Bundle path` header (noting that no adversarial review ran): one `## Item <subtask id>`
   per item with its Requirements, Acceptance Criteria and `## Origin` verbatim, and a
   `## Files` list from the items' `file:` lines. Also write
   `$ARTIFACT_DIR/bundle-items.md` — the same items in the `reviewer-prompts.md` §Fixer
   prompt findings shape (id, `file:line`, recommendation, verification), grouped by file:
   it is the writer's input at 3c; the plan file is the record. The plan's first instruction
   to the writer is **`scope-policy.md` Rule 0**: bundles are premise-aged by construction —
   re-confirm each finding against the current base; when the premise is gone, decline with
   evidence, never edit correct code to satisfy a stale criterion.
2. **Reviewability bound.** `node "$SF/sf-route.mjs" classify --cwd "$WT_PATH" --config-ref "origin/$BASE_BRANCH" <the items' files…>` (positional paths):
   more than ~15 prod files or more than two workspaces → one the available structured user-input tool to split
   (options: this workspace's items only (Recommended) / the first N by severity / all of
   it); unpicked items ship as the next bundle run right after this one (Rule 7) — never left `to do`. A bundle nobody can review is the failure
   this path exists to avoid.
3. `tracker task status "$TASK_ID" "ready for development"`; picked subtasks go `in development`
   at 3c. Continue at 2.5 → 3 with these deltas: 3b batches = items (parallelizable under the
   ordinary gate); 3c's writer runs the **fixer contract** (`reviewer-prompts.md` §Fixer
   prompt: items grouped by file, declines carry evidence). A serial batch has one fixer
   over the batch's items; a parallel batch has one fixer per item, each in its own scratch
   worktree and given that item's findings only (a findings file holding that item alone).
   Serial batch, HYBRID_MODE=codex:
   `sf-codex fix --findings "$ARTIFACT_DIR/bundle-items.md" --role fixer --round 0 --baseline "$BATCH_BASELINE" --cwd "$WT_PATH" --artifact "$ARTIFACT_DIR/implement-bundle"` (3c's `$BATCH_BASELINE`),
   Claude: `sf-fixer` given `$ARTIFACT_DIR/bundle-items.md`. Parallel batch, per item:
   `--findings` (the file `sf-fixer` is given) is that item's findings file, `--cwd` (the
   fixer's worktree) is the item's scratch worktree, and `--artifact` carries the item id.
   3d = 3d's roster (express deltas are stated there;
   `--routed-only`, as express); 3e = the ordinary loop and budget; filing only at HIGH+ / recurrence-guard
   (the generation cap — a new bundle only for those); 3f.5's AC table has one row per item
   (a declined item reads `PASS (premise gone: <evidence>)`); 3g opens one PR listing items
   landed and items declined. Link-back: each landed subtask `development complete` with the
   PR comment; a declined subtask gets the evidence as a comment and keeps its status (a
   human closes it); the parent `development complete`.
4. `sf-log stage express-classification mode=bundle items=<n> picked=<n> file_count=<n> workspaces='[…]'`
   (`bundle` is in `sf-log`'s mode enum as of 0.24.0).


### Stage 2 — Draft & adversarially review the plan

(Skip if express, or if 1B routed past planning.) Enter with `tracker task status "$TASK_ID" planning`.

Write `docs/plans/task-$TASK_ID.requirements.md` (Source / Requirements / Acceptance
Criteria / Context from the task body), then **bound the acceptance criteria** before any
drafter reads them:
`node "$SF/sf-route.mjs" ac-scan --file "docs/plans/task-$TASK_ID.requirements.md" --compact`
lists every criterion carrying a universal quantifier (no / any / all / never / always /
100%) with no `guard:`, `fixture:` or pinned set. Add a `## Acceptance criteria (bounded)`
section: each criterion restated with its finish line — `guard:` the structural check that
fails on the whole class (a contract / type / lint test) and/or `fixture:` the named inputs
it is verified on (ids, pages, runs, files) and/or `live:` the dev trigger and the evidence
that decides it, for a criterion only a deployed run can show (one named input, one log or
query to read — 3g §Live smoke) — keeping the original wording **inline, on the
same line**, as `(source: …)`, never as its own bullet (a `source:` bullet would scan as a
fresh unbounded criterion; `ac-scan` also skips lines that begin `source:`);
already-bounded criteria are copied as-is. When Stage 1.8 reproduced the failure (or a
resume recovered its test), Stage 1.8's R-1 criterion goes first. Bounding that needs a product decision (which
inputs count; whether a heuristic must be perfect on a set or merely not regress) is ONE
the available structured user-input tool now, options = the candidate sets plus "keep it universal" — an operator
who declines to bound a criterion has decided: record it as `goal-post: exempt` on that
criterion (the 3e goal-post rule does not apply to it) and continue; never loop the
interview. Log
`sf-log stage note event=ac-bounding criteria=<n> universal=<n> rewritten=<n> asked=<n> exempt=<n>`.
Phases whose criteria are universal over heuristic inputs (document layouts, classifiers) run
round after round chasing counterexamples; a phase with a structural invariant and a
contract test converges in one. Plan path
`docs/plans/task-$TASK_ID.plan.md`; template `docs/plans/TEMPLATE.plan.md` if present.
Prompts: `../../references/shared/plan-prompts.md`.
Plan roles use the model and effort resolved by `runtime.md` / `model-tiering.md`.
Bounded planning uses medium effort; consequential design uses the high profile. With
`SHIP_REVIEW_BACKEND=codex` the **reviewer** seat runs on Codex per `review-backend.md`
§Plan review — round 1 `sf-codex review --template plan-r1` (Bash, `run_in_background`,
after the drafter returns), rounds ≥ 2 `--resume <thread_id> --template
plan-rereview`; the drafter and fixer stay Claude. The plan failure-over-time seat runs the
same way (`--role plan-reviewer:failure-over-time --template plan-fot-r1`, artifact
`plan-review-fot-r<n>`). The loop below is unchanged: read the
reviewer's `agent_id` as the Codex `thread_id`, "SendMessage the round-1 REVIEWER" as the
resume call, and a `sf-codex` exit 3 as `NOT-CONTINUABLE`.

**Plan failure-over-time seat.** Every full-path plan seats it — nearly every plan here
touches a queue, transaction or concurrency, so a term trigger would gate almost nothing. The seat
(`plan-prompts.md` §Round 1 — plan failure-over-time seat, a `general-purpose` spawn)
launches in the same message as `sf-plan-reviewer` and its findings join the same round:
one adjudication, one rubric, one plan-fix pass over both artifacts. The express path has
no plan loop and no seat.

**Plan-phase Explores.** Unless `SHIP_SPECULATE=off`, one read-only `Explore` per **area**
of the Stage 1.9 file set starts no later than the round-1 drafter, each writing
`$ARTIFACT_DIR/explore-<area>.md` and logged `role=explore phase=plan`. The areas are the
`workspaces` that 1.9 step 2's classification of `$ARTIFACT_DIR/express-files.txt` reports,
one Explore each, at most 4 — past that the smallest groups merge into the fourth.
A file set with no prod workspace (documentation, tests, tooling) is one area covering the
whole set. In the report's file name `<area>` is the workspace with every `/` replaced by
`-`; the merged group is `other`; the no-workspace area is `all`. Each brief carries its area's lines of `express-files.txt` (`plan-prompts.md`
§Speculative exploration). An area whose `explore-<area>.md` already exists in
`$ARTIFACT_DIR` is not explored again — Stage 1.8 step 3 writes them with the repro seat.
Every other area's Explore launches in the same message as the round-1 drafter, briefed
from the requirements file. When `express-files.txt` does not exist at that point (an epic parent,
`$fix-task`, `$plan-task`), derive it per 1.9 step 1 and run 1.9 step 2's classification
on it first. The drafter's prompt lists the `explore-<area>.md` paths; the round-1
reviewer reads the `explore-*.md` files in `$ARTIFACT_DIR`.

**Prior-art Explore.** Every full-path plan also launches one read-only prior-art `Explore`
in the same message as the round-1 drafter (`plan-prompts.md` §Prior-art Explore), writing
`$ARTIFACT_DIR/explore-prior-art.md` and logged `role=explore phase=plan area=prior-art`. It
is not speculative: it runs even when `SHIP_SPECULATE=off`, and it does not count against
the 4-area cap. It reports existing capabilities repo-wide, the callers of what the change
modifies, and in-flight overlap — open PRs and unmerged branches on the same files, tracker
tasks in flight (`tracker task list`, statuses `planning`, `ready for development`,
`in development`), and migration numbers already claimed. When the report already exists
(a resumed run) it is not run again. The drafter answers it in the plan's `## Prior art`
section; the round-1 reviewer holds the plan to it. The express path has no plan loop and
no prior-art Explore.

```
max_rounds = 5; prev_high = ∞
round 1, in ONE message:
  spawn sf-plan-drafter (record agent_id)            → writes plan
  unless $ARTIFACT_DIR/explore-prior-art.md exists (every SHIP_SPECULATE value):
    spawn the prior-art Explore                      → $ARTIFACT_DIR/explore-prior-art.md
  when SHIP_SPECULATE != off (default: explore), for each area of the Stage 1.9 file set
  with no $ARTIFACT_DIR/explore-<area>.md:
    spawn one Explore                                → $ARTIFACT_DIR/explore-<area>.md
after the drafter returns:
  in ONE message:
    spawn sf-plan-reviewer (record agent_id)          → $ARTIFACT_DIR/plan-review-r1.md
                                                        (full 11-dimension pass)
    spawn the plan failure-over-time seat (record agent_id)
                                                      → $ARTIFACT_DIR/plan-review-fot-r1.md
each round:
  read verdict + open CRITICAL/HIGH from the review artifact — and the seat's artifact
  when it ran this round: counts summed, the stricter verdict wins
  ADJUDICATE before any fixer pass: for each open CRITICAL/HIGH, YOU verify the
  finding's cited evidence yourself (open the cited file:line, run the named
  read-only check) and mark it confirmed / refuted: <one line of evidence> /
  needs-operator (→ the operator-question batch). Prepend the marks to the fixer
  prompt's findings list — a refuted finding is closed-by-adjudication and costs
  no fixer work; a round spent "fixing" a wrong CRITICAL is the loop's most
  expensive waste (the plan loop is the run's largest serial block).
  "Proceed as-is"                                     → break
  0 CRITICAL, 0 HIGH ("Proceed with modifications")   → NO fixer pass: append the review's
                                                        MEDIUM/LOW findings verbatim to the
                                                        plan under `## Review notes (unresolved
                                                        MEDIUM/LOW)` — the implementer reads
                                                        them as constraints — and break
                                                        (a warm plan-fix pass costs 190–270k
                                                        tokens; only a CRITICAL/HIGH earns one)
  0 CRITICAL, high ≤ 2, high < prev_high, round ≥ 2   → one fixer pass (warm),
                                                        log plan-converged-early, break
  round == max_rounds                                 → CHECKPOINT_REQUIRED: plan-review-exhausted
  otherwise:
    fixer pass  = SendMessage the round-1 DRAFTER by agent_id with the plan-fixer
                  template (it holds the plan's context) → $ARTIFACT_DIR/plan-fix-r<n>.md
    re-review   = SendMessage the round-1 REVIEWER by agent_id with the targeted
                  re-review template (prior artifact + fixer summary; scope = closed
                  findings, touched sections, implementability) → plan-review-r<n+1>.md;
                  in the same message, the failure-over-time seat by its agent_id only
                  when its round-n artifact raised a CRITICAL/HIGH → plan-review-fot-r<n+1>.md
                  (a seat that raised none is not re-run)
    either continuation unavailable (no agent_id, NOT-CONTINUABLE, no artifact after
    one retry) → cold spawn of sf-plan-fixer / sf-plan-reviewer with the same
    template; log path=warm|cold-fallback on the closure-exchange event
    prev_high = high
```

**Speculative implementation (opt-in, `SHIP_SPECULATE=implement`).** When the round-1
verdict has 0 CRITICAL and ≤ 2 HIGH, spawn the Stage 3c implementer against the round-1
plan in the same message as the round-2 fixer/re-review. When the plan settles, diff
round-1 → final plan; if the diff touches the implementer's files, hand it to the 3e fixer
as round-0 bucket-1 items before review. Log `sf-log stage note event=speculative-implement
discarded=<bool>`. Default is `explore` only (`rationale.md` §Plan loop).

**After the loop** (every exit except a checkpoint) scan the final plan:
- verdict `Stop and redesign` → `CHECKPOINT_REQUIRED: architecture-reframe`
- `DROP TABLE` / `DROP COLUMN` / `TRUNCATE ` / `DELETE FROM ` in a SQL block without
  `-- SAFE:`, or destructive cloud-resource ops → `destructive-migration`
- a DB trigger / function / procedure proposed as DDL or prose (judge intent) →
  `database-trigger` — no annotation bypasses it
- additions to `package.json` deps / `Pipfile` / `requirements.txt` → `new-dependency`
- a new feature toggle (§Interview policy, "New feature toggles") without a recorded
  operator answer → **interview first**, batched with the Open Questions below
- unchecked `- [ ]` under `## Open Questions`, or a `## Premises` entry with
  `status: unconfirmed` → **interview first**: user-decidable Open Questions items and the
  unconfirmed premises (each: confirm / strike, plus "Other") → one batched exchange per
  §Interview policy (`operator-wait` first, ≤ 4 per call), answers written into the plan
  as `- [x] … — Answer: <a> (user, <date>)` and as each premise's `status: confirmed|struck`
  in `## Premises`; only investigation-bound items left →
  `CHECKPOINT_REQUIRED: open-questions` listing only those. When the exchange confirmed or
  struck any premise a step cites (`(P<n>)`), run one targeted re-review scoped to
  `## Premises` and the citing steps; if it has findings, one warm plan-fix pass (the
  drafter by `agent_id`, plan-fixer template; cold `sf-plan-fixer` when not continuable, as
  in the loop), then one scoped re-review of that fix. All of these count against
  `max_rounds`. No rounds left, or CRITICAL/HIGH open after the scoped re-review →
  `CHECKPOINT_REQUIRED: plan-review-exhausted`. New unconfirmed premises or open questions
  → this bullet runs once more; any still unconfirmed after that repeat →
  `CHECKPOINT_REQUIRED: open-questions`.
- `## Pull request topology` must be present (`single`, or a `stack` — a migration
  forces a migration-first stack; missing/incorrect → a blocking plan finding, not
  something 3c repairs).
- `## Decisions` follows `plan-prompts.md`: unresolved behavioral/contract choices are
  reviewed by consequence. Missing structure or a delegated local implementation
  detail is MEDIUM, not a blocking finding. Only a concrete CRITICAL/HIGH defect or
  a required unresolved operator decision blocks; do not reopen a passed plan for
  table formatting or choices the implementer can safely make.
- `node "$SF/sf-route.mjs" ac-scan --file <plan> --fail-on-unbounded` exits 1 (a universal
  criterion re-entered the plan without its guard / fixtures) → the same interview as the
  bounding step, answers written into the plan (`goal-post: exempt` is an answer); the run
  proceeds only on criteria that are bounded or explicitly exempt.

**Clean pass**: post the plan as a task comment (`**[ship-task · plan]**`; summary +
file path if it exceeds a comment), commit `task-$TASK_ID.requirements.md` +
`task-$TASK_ID.plan.md` + `$ARTIFACT_DIR` + the runstate and its ledger (§Run state &
resume) on `$BRANCH`,
`tracker task status "$TASK_ID" "ready for development"`,
`sf-log stage plan-issue plan_path=… verdict=… rounds=N`. **Checkpoint**: §Status lifecycle
(`blocked` + comment) — never leave the task in `planning`.

### Stage 2.5 — Auto-bridge

No status write (Stage 3 sets `in development`). `PushNotification`: plan accepted.
`sf-log stage auto-ready-to-implement`. The Stage 2 hard stops are the human-judgment
gates; the bridge skips only the acknowledgement.

### Stage 2.7 — Epic detection + fan-out

Read the reviewed plan's `## Phases`: absent or one phase → Stage 3. Two or more → epic.
Run **`epic.md` §Stage 2.7 — Epic detection + fan-out cutting and §Stage 3E — Epic
fan-out** (beside this file) with the deltas below. This section states the phase fan-out,
the per-phase engine and the integrated-layer gate; decomposition and the layer
scheduler's integration and submit mechanics are `epic.md`'s, kept in their own file
because epic runs are rare and the scheduler is long:

- Phases → sub-issues (`tracker task create --parent "$TASK_ID"`, cut-task §7, body with
  `## Phase` id/depends-on and `## Base branch` carrying the run's `$BASE_BRANCH`).
  Phase subtasks and phase or scratch worktrees take the epic's recorded base (the
  parent's `## Base branch`, or the runstate `base_branch`) and never re-resolve from their
  own checkout (`../../references/shared/base-branch.md`). If Stage 1A already cut subtasks, **reconcile** by phase id
  (then scope similarity): `tracker task edit` changed phases, create only new ones, list
  unmatched subtasks as cancel-candidates in a new `**[ship-task · reconcile]**` comment
  (never delete/cancel yourself; `tracker` has no comment-edit). Set every live phase subtask
  `ready for development`; parent `in development` + phase-checklist comment (with
  `prd-sha:` and, on the next line, `base: $BASE_BRANCH` in PRD mode).
- Subtasks inherit the parent's domain (no per-child domain override; a phase in a
  different product domain is planned as its own top-level task with a `depends-on`).
- 2.7d resume: rebuild `phase_id → subtask` from `tracker task view --subtasks`; done =
  `development complete` / `ready for testing` / `testing` / `shipped`.
- 3E status mapping: phase start → subtask `in development`; **integrated mode**: a phase
  goes `development complete` when its layer's `epic-layer mode=integrated` event is
  logged (the pushed integration branch is the record; the PR comment is posted at the
  top); **stack mode**: layer PR submitted + reviewed → `development complete` + PR
  comment. Finalize: parent `development complete` when nothing was deferred, else
  `remediating`; integrated mode posts the one PR's URL with `## Phases landed` /
  `## Phases deferred` (each a subtask URL line) instead of a stack summary; stack mode
  keeps the stack summary comment. Each layer PR carries `Refs #<child>`, never a closing
  keyword; the auto-close verification is moot (restate the manual-close convention). `epic.md` Finalize step 2's
  holistic fix lands on `$BRANCH` directly in integrated mode (no restack); its step 6
  stack-mode clauses (per-layer PR readiness, migration-dependent drafts) apply only in stack mode; the
  `epic-finalize` event's `stack` array carries one entry with the single PR.
  `$EPIC_FOLLOWUPS` file per §Follow-up tasks.
- Scratch/phase worktree seeding: `../../references/shared/scratch-worktree.md`.
- Every push in `epic.md` 3E runs under the approved skips: `env $(node "$SF/sf-gates.mjs" push-env --runstate "$RUNSTATE") git push …`, and in stack
  mode `env $(node "$SF/sf-gates.mjs" push-env --runstate "$RUNSTATE") gh stack submit --auto` (`shared/run-preflight.md` §Push-gate baseline).
- **Kickoff is notify-only when no subtask is created.** `epic.md` 2.7b's the available structured user-input tool
  is skipped when the plan loop exited on a clean pass (open questions answered, no
  checkpoint), 2.7a validated the DAG, **and every phase subtask already exists** (1A/1B
  pickup, or a reconcile that edits but creates nothing) — that is the run's authorization;
  a checkpoint here idles the run on a question whose answer is the accepted plan and whose
  subtasks are already cut. Send the `PushNotification` with the
  layer plan (`ship-task <id>: epic kickoff — <L> layers, <N> phases`) and log
  `sf-log stage note event=epic-kickoff confirm=auto`. A fan-out that would **create**
  subtasks keeps 2.7b's question (outward-facing, hard to reverse); `SHIP_EPIC_CONFIRM=1`
  restores it always; `EPIC_FORCE_SERIAL=1` still forces serial layers;
  `SHIP_EPIC_NOCONFIRM` keeps its meaning (skip even when creating).
- **The per-phase engine is this file's 3c–3g** (explore, implement, routed review, the 3e
  loop with its extension rules, gates); `epic.md` 3E supplies only the layer scheduler,
  integration and submit mechanics.
- **Same-layer phases fan out.** The phases of a layer share no dependency, so they run
  concurrently, each as the sole writer of its own phase worktree. Every phase of the
  layer is spawned in one message, and so is each stage of the per-phase engine across the
  layer's phases: the layer's `Explore`s in one message, its implementers in one message,
  and the round-1 panels of every phase that is ready for review in one message. A phase
  that reaches a stage alone is spawned at once; it never waits for a sibling's fix loop.
  Cap: 3 phases in flight; a larger layer runs in waves, the next phase starting when one
  finishes. The layer is serial — one phase at a time through the per-phase engine on the
  integration worktree, with no phase worktree and no 3E step 5 cherry-pick — when one of
  causes 1–4 holds; its gate base is stated in the next bullet. A serial layer's
  `serial_reason` is the first of the five that holds:
  1. scratch worktrees are unavailable (inline mode, Stage 0 step 6) — `no-scratch-worktrees`
  2. `EPIC_FORCE_SERIAL=1` — `force-serial`
  3. the layer has one phase — `single-phase`
  4. a resumed layer has one phase left to run — `resumed`
  5. two or more phases were runnable and still ran one at a time — `not-fanned-out`

  `not-fanned-out` records a miss, never a choice: no rule here lets such a layer run
  serially, and the reason exists so its completion record says what happened.

  `in_flight` on the layer's `epic-layer` event is the largest number of its phases in
  flight at once (1–3); `in_flight=1` carries the `serial_reason`. Integrated-mode rows
  record `in_flight`; a stack-mode row may omit it.
- **One integration branch, one PR (default).** Layers integrate onto `$BRANCH` in
  topological order — no per-layer PR, no `gh stack`, no per-layer 3f / 3f.5 / 3g. The
  per-layer gate is the phases' own review loops (3d–3e, unchanged) plus, on the integrated
  layer, one command (`LAYER_GATE_DIR=$(mktemp -d)`, outside the repo):
  `node "$SF/sf-gates.mjs" gate --mode layer --cwd "$WT_PATH" --base "$BASE_BRANCH" --baseline "$LAYER_GATE_BASE" --out-dir "$LAYER_GATE_DIR"`.
  Its jobs are `smoke` (the scoped type-check only, against `$LAYER_GATE_BASE`), `tests`
  (`npx --no-install vitest run --changed "$LAYER_GATE_BASE"`) and `drift`. On a layer that cherry-picks,
  `$LAYER_GATE_BASE` is the integration tip immediately **before** the cherry-picks and
  **after** the pre-cherry-pick `layer` sync (3E step 5), so the gate selects the layer's
  own changes and not the base commits the sync merged; there it is distinct from
  `$LAYER_BASELINE`, the top-of-layer tip the phase worktrees were cut from. On a layer
  with no cherry-picks — any `in_flight=1` layer run on the integration worktree, whatever
  its `serial_reason` — `LAYER_GATE_BASE` is `$LAYER_BASELINE`, never `HEAD`: the gate
  selects the layer's own commits and also the files the phase's own syncs merged. The ref
  argument is load-bearing: a bare
  `--changed` selects staged and unstaged files, and a cherry-picked tree is clean, so it
  runs nothing and reports green. Never the production build here. `drift` is the repo's
  manifest-drift check (read from the base; undeclared → skipped), logged from its
  `checks[].verdict` as
  `sf-log stage build-gate scope=manifest-drift result=<pass|fail|preexisting|undeclared|error>`.
  The gate's verdict is the `next` in `$LAYER_GATE_DIR/result.json`: `pass`, or
  `epic-layer-build-failed` → `CHECKPOINT_REQUIRED: epic-layer-build-failed` as in 3E
  step 6, with the log of each job the result marks `fail` or `error`. A manifest-drift
  failure is run by the command on the branch and the current base; it passes only as
  pre-existing under `shared/run-preflight.md` §Push-gate baseline, and an error — no JSON
  included — never passes. A passing gate removes its directory
  (`rm -rf "${LAYER_GATE_DIR:?}"`). Then record the skip on the branch — note the
  runstate's current `arms_owed`, `sf-log cursor "$RUNSTATE" arms_owed=true`, and commit
  the runstate and ledger (§Run state & resume) — and push the integration branch with
  `node "$SF/sf-push.mjs" --kind layer --arms skip --cwd "$WT_PATH" --branch "$BRANCH" --base "$BASE_BRANCH" --runstate "$RUNSTATE"`,
  run and judged like the 3g call (the resumability checkpoint — a thorough pre-push
  hook runs a few minutes on a large layer; `verified: false` or no JSON means the layer
  is not on the remote: `CHECKPOINT_PERSIST_FAILED`, §Run state & resume). `--arms skip`
  (§CHECKPOINT_REQUIRED, which also states the `arms_owed` rule) has the hook skip its
  test arms on this push: the layer gate just ran them on these commits, and the final
  push covers the run's range. A result of `test_arms: ran` when the noted value was not
  `true` → `sf-log cursor "$RUNSTATE" arms_owed=false`; any other result leaves it
  `true`. Then log
  `sf-log stage epic-layer layer=<k> mode=integrated head=<sha> children='[…]' pr_url=null in_flight=<n> [serial_reason=<reason>]`.
  **Every layer starts and integrates current with the base.** Run the §Integration sync
  block on the integration worktree (`$WT_PATH` = `$INTEGRATION_WT`) with
  `AT=layer LAYER=<k>` (a) at the top of each layer, **before** `$LAYER_BASELINE` is
  taken and any phase worktree is cut, and (b) on a layer that cherry-picks, again
  immediately before 3E step 5's cherry-picks, capturing
  `LAYER_GATE_BASE=$(git rev-parse HEAD)` right after it.
  Phase worktrees never merge the base (their 3d/3e/3f
  points run the block's probe as `AT=phase` — a merge commit on a phase branch breaks the
  `LAYER_BASELINE..PHASE_BRANCH` cherry-pick range). A cherry-pick conflict after a `layer`
  sync is classified per the block (base collision → its conflict rule on `$BRANCH`,
  `git cherry-pick --continue`; phase-vs-phase → 3E's `epic-integration-conflict`). The
  layer gate then runs on a tip that carries the base, so the finalize sync (3f) is the
  small step it should be (the measured miss: `rationale.md` §Integration sync).
  That event plus the pushed branch is the completion record: on 2.7d resume a phase is
  done when its `epic-layer` head is an ancestor of `origin/$BRANCH` (`git merge-base
  --is-ancestor`), never from GitHub; the runstate `stage` reads `3E-layer-<k>` while a
  layer runs. `epic.md` 3E's Setup (`gh stack init` / `gh stack sync`), step 3's per-layer
  branches and steps 6–7 apply only in stack mode; in integrated mode
  `LAYER_BRANCH = $BRANCH` for every layer and `LAYER_BASELINE` is its tip after the
  top-of-layer sync.
  The full 3f build gate, the 3f.5 AC table (PRD-level plus every landed phase's criteria)
  and 3g's PR run **once**, after the last layer. Each layer's tail (install +
  production build + mop-up + AC + PR ceremony) is its own multi-step cost, and
  every higher layer restacks whenever a lower layer's review changes it.
  **Stack mode** (`gh stack`, one PR per layer against the layer below, `epic.md` 3E as
  written) is a **whole-run** mode — there is no hybrid of one stacked layer under
  integrated ones — entered only when the plan contains a layer that must land
  independently (a migration layer, or a layer marked `deploy-gate: independent`) or when
  `SHIP_EPIC_TOPOLOGY=stack`. `## Pull request topology` records which (`single` = the
  integration-branch default for an epic, which the drafter template now emits unless a
  layer must land independently; `stack` = the exception). Ship-what-landed is unchanged:
  a failed phase and its dependents are not integrated, and the one PR ships the layers
  that passed.
- **Speculative next layer.** Explores are read-only and their plan-vs-code notes hold
  under every outcome, so layer k+1's `Explore` starts when layer
  k's round-1 panel launches (the P2 explore's four notes were all "consequences of P1
  landing first" — known at that point). Layer k+1's **implementer** starts speculatively,
  in a scratch worktree (`scratch-worktree.md`) cut from `$BRANCH` with layer k's passed
  phase commits cherry-picked in (layer k's phases live on their own `-phase-<id>`
  branches until 3E step 5 integrates them; a conflict while assembling that base means
  do not speculate), once every phase of layer k has closed its round-1 fix-now bucket
  with no open CRITICAL/HIGH and no `REOPENED` finding — never earlier: a lower layer
  still churning rewrites the files the upper layer edits. Cap: one speculative layer in
  flight, and its phases count against the cap of 3 phases in flight; speculation is off
  in inline mode and under `EPIC_FORCE_SERIAL` (both exist to keep one writer per tree),
  and `SHIP_SPECULATE_LAYERS=0` turns it off elsewhere (default `1`). Its review panel
  never starts before layer k integrates **and passes its gate**: then `git rebase` the
  speculative branch onto the integrated tip — clean → 3d as usual, its panel launch carrying the smoke; a
  conflict, or a failed layer-k gate → discard it (`sf-log stage note
  event=speculative-layer layer=<k+1> discarded=true`) and run the phase from explore on
  the integrated tip (that rebase absorbs layer k's `layer` sync — never merge the base
  into the speculative tree). Log `discarded=false` on the clean path. Measured: P2 waited from 00:47 (P1's ledger closed)
  to 01:51 (its own implementer done) — the explore, implementer and layer setup (≈ 35 min)
  come off the critical path, and the single-branch topology removes the 37-min layer tail
  in front of them.

### Stage 3 — Implement + review

Enter with `tracker task status "$TASK_ID" "in development"`. Topology `stack` (a migration
layer, a `deploy-gate: independent` layer, or `SHIP_EPIC_TOPOLOGY=stack` — never the
default for an epic, see 2.7) → verify `gh stack --help` (else
`CHECKPOINT_REQUIRED: stacked-prs-unavailable`), create layer branches
`${BRANCH}-layer-<k>-<slug>` from `$BASE_BRANCH`, and run 3b–3g per layer, lower layers
first (`epic.md` §Pull-request topology governs stack mechanics, late migrations, and
the deployment gate — it is repo-side, not tracker-side).

#### 3a — Baseline

```bash
BASELINE=$(git rev-parse HEAD)
REVIEW_BASELINE=$(git merge-base HEAD "origin/$BASE_BRANCH" 2>/dev/null || echo "$BASELINE")   # the range the PR ships
git restore package-lock.json 2>/dev/null || true
```
`$BASELINE` drives the empty-implementation check; `$REVIEW_BASELINE` drives review and
AC verification (a reused worktree's earlier commits ship too). **Every §Integration sync
that merges recomputes `$REVIEW_BASELINE`** (the block's last line): a two-dot diff against
a stale merge-base hands the panel and the gates the base's own commits as if this run
wrote them.

#### 3b — Decompose into batches

Each plan step that carries `scope:` / `depends-on:` is one task: `scope` is the step's file
paths and `depends_on` the step ids it names. Steps are never merged into one task — a plan
with six scoped steps yields six tasks. The one-task fallback ("implement the entire plan")
applies only when no step carries a scope; its `scope` is the plan's full file list: its
`## Files to modify / create`, else the union of every step's `scope:` / `**Files:**` lines.
Express path: one batch, one task, `scope` = the lines of `$ARTIFACT_DIR/express-files.txt`.
Bundle path: each item is a task whose `scope` is the path part of each of its `file:` lines
(`src/a.ts:40` → `src/a.ts`).

Write the tasks to `$ARTIFACT_DIR/tasks.json` (a JSON array of `{id, scope, depends_on}`) and
run `sf-route batches --tasks "$ARTIFACT_DIR/tasks.json" --compact` (add `--no-scratch` in
inline mode). Its `batches` array is the decomposition, in the order the batches run: tasks
with no unmet `depends_on` share a dependency layer and dependent tasks go to a later layer.
**Seam rule:** the seam tasks of a layer form one serial batch that lands first; the rest of
the layer is its own batch, gated on its own.

Every `scope` entry is one repository-relative file path, so list the files: `sf-route
batches` exits 2 on an entry holding a `:` (a finding's `path:line`) or a backtick, ending in
`/`, in `#L<digits>` or in a parenthesised note after a space, a glob, an absolute path, a
backslash, or a `..`, `.` or empty segment. A directory named without the trailing `/` is not refused; it counts
as overlapping any other task's file under it. Its
`unresolved_depends_on` array lists each `depends_on` id that names no task in
`tasks.json`; such an id counts as already done. Each listed id must name a step outside
this decomposition (an earlier stack layer or phase). Any other listed id is a mistyped
task id: correct it in `tasks.json` and re-run before logging.

A batch is `parallelizable` only when all four conditions hold (default `false`);
`parallelizable_reason` names the first one that fails:

1. The run can cut scratch worktrees (worktree mode) — else reason `no scratch worktrees`
2. No task's scope holds a seam file (`seam_touched=false`) — else reason `seam touched`
3. The batch has ≥ 2 independent tasks — else reason `fewer than 2 independent tasks`
4. Task scopes are pairwise disjoint — else reason `scopes overlap`

When every condition holds, `parallelizable_reason` is `all four hold`. The seam rule changes
which tasks share a batch, never the gate: a batch with `seam_touched=true` is always serial.

An express or fallback batch is not computed by `sf-route batches`: run
`sf-route classify --cwd "$WT_PATH" --config-ref "origin/$BASE_BRANCH" --compact <batch scope files…>` (paths as positional
arguments), record its `.seam.touched` as `seam_touched`, and set `parallelizable: false`
with the first failed condition as its `parallelizable_reason`.
Stacked topology: a batch never crosses a layer (`CHECKPOINT_REQUIRED: stack-scope-violation`).
`sf-log stage task-decomposition batches='[…]'` — sf-log refuses a task without `scope`,
a batch without `seam_touched` / `parallelizable_reason`, a `parallelizable_reason` outside
the five values above, and a `parallelizable: true` batch whose own fields break one of the
conditions:
```json
{"stage":"task-decomposition","batches":[{"id":"B1","tasks":[{"id":"1.3","scope":["package.json"]}],"seam_touched":true,"parallelizable":false,"parallelizable_reason":"seam touched"},{"id":"B2","tasks":[{"id":"1.1","scope":["scripts/a.mjs"]},{"id":"1.2","scope":["scripts/b.mjs"]}],"seam_touched":false,"parallelizable":true,"parallelizable_reason":"all four hold"}]}
```
Write every task's scope files to `$ARTIFACT_DIR/plan-files.txt` and run §Early install
kick with it (idempotent — a kick from Stage 1.9 is not repeated).

#### 3c — Explore, implement

Every sub-agent prompt begins with the worktree contract:
```
First action: run `cd <worktree path> && pwd` and verify pwd matches <worktree path>.
If it does not match, stop and report — do not operate in /workspace.
For all subsequent git commands, run from inside <worktree path> (or use
`git -C <worktree path> ...`). Edit only files under <worktree path>.
Every test you run names its files or uses the runner's changed-files mode
(`vitest run <files>` / `--changed <sha>`); never launch a whole test project or
directory — a whole-project browser run is unbounded here and a seat that starts one
burns its timeout. A task text that asks for one means its named files.
```
plus the Stage 0.7 authorization lines. The test-scope line is not advice: three seats
in two days (two epic phases on separate tasks) timed out at 40 minutes polling an
unscoped `--project=browser` run — once from a plan step, once from a phase task file
that prescribed it as the acceptance check. The tasks files YOU write (3b, 2.7's
`tasks-<phase>.md`) and the plan's Verification section carry the same rule: name the
files.

For each batch, `BATCH_BASELINE=$(git rev-parse HEAD)`, then:

1. **Explore** — skip when the batch touches ≤ 2 files. A plan-phase report
   (`explore-<area>.md`, Stage 2 §Plan-phase Explores) is reused for a task only when every
   file in the task's `scope` appears in `express-files.txt` under an area whose
   report exists — the task then reuses each report that covers one of its files; any
   other task with more than 2 files is explored here. For those, one `Explore` per
   task, in parallel, read-only, writing `$ARTIFACT_DIR/explore-<task>.md` (exact
   file:line ranges to change, patterns to reuse, imports/types to align with, conflicts
   between plan and code). The brief tells the seat to start from the repository's symbol
   tools when they exist (`node scripts/ts-nav.mjs`, `ast-grep`; `.claude/skills/nav/SKILL.md`)
   and to locate, not critique quality or propose designs. A reported blocker → `CHECKPOINT_REQUIRED: ambiguous-fix-required`. Every `HYBRID_MODE` runs this Claude `Explore`; at `HYBRID_MODE=codex` its reports reach the Codex implementer through `sf-codex implement --explore`.
2. **Implement.** **Batch size cap: ≤ 8 plan steps per serial batch** — split along phase
   boundaries first, then by step ranges, and each part keeps the batch id with a letter
   suffix (`B2a`, `B2b`) on its own `batch-implement` line. The cap does not apply to a
   parallel batch, which has one writer per task. A batch that outruns the seat's wall budget is
   steered to wrap up and, failing that, interrupted and asked for a report — it lands as
   `status:"wrapped-up"` or `"interrupted-reported"` with `DEFERRED` acceptance rows that
   go back into the next batch, and `compactions>1` (`oversized=true`) on the result line
   means split the next batch. A dirty tree on any of these lines follows
   `review-backend.md` §Hybrid mode's writer-fallback row — gated **adopt-dirty**, the
   exception for a crash or an interrupt whose steer the seat did not act on, committing
   only when the gates pass on the tree as it stands: the
   scoped type-check and `vitest run --changed "$BATCH_BASELINE"` per project, never a
   whole-project run: the orchestrator that adopted one of those phases re-launched the
   same unscoped browser run the seat had timed out on.
   Serial (default): one `sf-implementer` for the batch, prompt =
   worktree contract + tasks (id, scope, verbatim text) + explore report paths +
   constraints (follow the plan literally; one commit per task tagged `[task <id>]`;
   clear `.next`/`.turbo`/`.cache` and retry once if pre-commit cites stale artifacts;
   report commits, `--numstat`, per-AC verification). Batches run in the order
   `sf-route batches` emits them, so a layer's serial seam batch is committed before the
   scratch worktrees of the parallel batch after it are cut. A serial seam batch that ends
   with `DEFERRED` rows finishes them as its own serial batch before the next batch's
   scratch worktrees are cut. Parallel (`parallelizable: true`):
   one scratch worktree per task per `../../references/shared/scratch-worktree.md`, one
   implementer each (cap 3 in flight), integrate by cherry-pick in task order; a scope
   violation or unresolved error → discard the scratch trees and fall back to serial for
   the whole batch; a cherry-pick conflict → `CHECKPOINT_REQUIRED: parallel-integration-conflict`.
   An implementer error it cannot resolve → `CHECKPOINT_REQUIRED: implementer-failed`.
   No diff after the batch → `CHECKPOINT_REQUIRED: empty-implementation`. HYBRID_MODE=codex: the batch's `sf-implementer` spawn becomes the `sf-codex implement` command in `review-backend.md` §Hybrid mode (tasks file + `--baseline "$BATCH_BASELINE"`; one call per scratch worktree when parallel); its report is verified against the worktree (`commits` on the result line is git's count — `0` is this same checkpoint), `blockers` → `ambiguous-fix-required`, `scope_violations` → the serial fallback as above, `status:"failed"` → `sf-implementer` on Claude with the same tasks file and `codex-seat-fallback role=implementer`.
3. **Express abandonment check** (express runs only):
   `sf-route classify --config-ref "origin/$BASE_BRANCH" --diff "$REVIEW_BASELINE..HEAD"`; `express.eligible=false` →
   abandon per Stage 1.9.
4. **Smoke type-check with the round-1 panel.** After each batch, re-run §Early install
   kick with the batch's actual diff (`git diff --name-only "$BATCH_BASELINE"..HEAD` — the
   plan's file list may have under-estimated). The smoke itself is not part of the per-batch
   loop: it runs **once, after the last batch, on `$REVIEW_SHA`**. 3d syncs, captures
   `$REVIEW_SHA`, creates `SMOKE_DIR` and classifies; then the **same message** that spawns
   the round-1 panel also carries one Bash call with `run_in_background`:
   `node "$SF/sf-gates.mjs" gate --mode smoke --cwd "$WT_PATH" --base "$BASE_BRANCH" --baseline "$REVIEW_BASELINE" --out-dir "$SMOKE_DIR"`,
   every value written literally (a background job is a new shell). Its one job, `smoke`,
   is `npx turbo run type-check --force --filter="...[$REVIEW_BASELINE]"` and nothing else
   — no install wait, no production build. No reviewer waits for the smoke, and the smoke is
   never started ahead of the panel.
   - **Verdict**: the `next` in `$SMOKE_DIR/result.json` — `pass` or `smoke-finding` —
     read once the command has ended; never the Bash call's own status and never a
     pipeline's. No JSON is an error, never a pass: run the command once more. Round-1
     triage (3e) starts when that file exists and the seats 3e triages have returned (3e
     step 3: on a Codex-backend run, the panel summary; a late pinned seat goes to the
     addendum).
   - **Failure**: the command applies §Build gate's build resilience itself, once per
     class, by re-running the smoke job alone; the result names the class (`resilience`)
     and the count (`attempts`). `next = smoke-finding` is what still fails: a genuine
     smoke failure is a bucket-1 finding (the first 40 lines of the `smoke` job's `log`,
     the failing workspace) merged into round 1's triage: the round-1 fixer gets it
     together with the panel's findings, and when the panel raised none, round 1's fix
     round runs for the smoke finding alone. A `smoke` verdict of `error` (`npx turbo`
     not resolvable, or the job killed twice) says nothing about the code: run the command
     once more before treating it as the finding.
   - **Re-run**: only when round 1's bucket held a smoke finding. The command then runs
     once more on the fixer's commit, in a fresh `SMOKE_DIR`, before that round's closure
     is read. `next = pass` closes the smoke finding, with no closure exchange, and a
     round whose only item was the smoke finding logs `rereview_mode=none`. A genuine
     failure of that re-run is the second consecutive one →
     `CHECKPOINT_REQUIRED: build-failed`.
   - Log every smoke run: `sf-log stage smoke-build result=<pass|fail> wall_ms=<n>` (`<n>`
     is the `smoke` job's `wall_ms`).
5. `sf-log stage batch-implement batch=… mode=<serial|parallel> tasks='[…]' plan_gaps_semantic=<n>` (summed from the implementer report(s) — the Codex result line, or the Claude report's "Decisions the plan did not specify" section; as of 0.33.0 the report carries semantic gaps only — cosmetic choices live in commit messages, so `plan_gaps_cosmetic` is omitted, and a batch with `plan_gaps_semantic > 0` is a plan-quality signal: the plan's `## Decisions` table (`plan-prompts.md`) should have answered it) and
   `sf-log cursor "$RUNSTATE" stage=3-implement batches_done='[…]'` (commit the runstate
   and its ledger with the batch — §Run state & resume).

#### No-code outcome

Before 3c, and only when the task contract **enumerates** its deliverables and every one
is tracker/task content or verification of already-existing state (an absent file list,
express mode, or an empty diff is never evidence), confirm the repository delta is truly
empty (`git diff --quiet "$REVIEW_BASELINE"..HEAD`, clean index and tree, no untracked
task work) — then skip 3c–3g except 3f.5: verify every AC, post
`**[ship-task · implemented]**` (deliverable + AC evidence) and `**[ship-task · pr]**`
("no PR — the accepted deliverable required no repository change"), set
`development complete`, and `sf-log stage no-code-outcome ac_status=PASSED status=…`.
Any AC failure keeps the `ac-failed` / `ac-unverifiable` checkpoints.

#### 3d — Routed review

**Integration sync first** — the §Integration sync block
(`../../references/shared/integration-sync.md`) with `AT=3d`; conflicts follow
its rule. The panel must review a tip that can merge: a branch far behind `development`
reviews clean, then opens CONFLICTING against files other merged PRs rewrote. Inside an
epic **phase** worktree this point is the read-only probe (`AT=phase`), never a merge —
the phase branch must stay cherry-pickable (the block's `phase` row).

```bash
REVIEW_SHA=$(git rev-parse HEAD)   # the commit every seat this round judges — never HEAD
SMOKE_DIR=$(mktemp -d); echo "$SMOKE_DIR"   # the smoke command's result.json and log — outside the repo; reuse this printed path in every later call
node "$SF/sf-route.mjs" classify --cwd "$WT_PATH" --config-ref "origin/$BASE_BRANCH" --diff "$REVIEW_BASELINE..$REVIEW_SHA" > "$ARTIFACT_DIR/route-r1.json"
```
**Every reviewer range ends at a captured commit, never at `HEAD`.** A pinned Claude seat
(`security-reviewer`, `ux-consistency-lead`) keeps reading after the Codex panel has
summarised and the round's fixer has started writing (3e step 3); a range ending in `HEAD`
hands that seat a moving target, and its findings then mix the reviewed commit with the
fixer's half-applied edits. `$REVIEW_SHA` is captured here and re-captured wherever a
range is built (`$FIX_SHA` after each fixer returns, warm-closure.md §Prerequisite); the
Codex spawn events record it as `range=`, so the ledger names the exact commit reviewed.
Spawn, in one message, `reviewers.routed` + `reviewers.baselines` — and, in that same
message on either review backend, start 3c step 4's smoke type-check as a background Bash
job; its verdict joins round 1's triage (the script applies
test-only narrowing, the seam-only architecture gate and the **panel cap** — at most 3
routed domain reviewers plus any repo-declared cap-exempt seats (`.shipflow.json`
`review.cap_exempt`), highest priority first; a baseline never takes a cap slot;
`reviewers.capped_out` are never seated, go on the round-1 triage event as
`capped_out='[…]'` and into the PR body under `## Review coverage` (3g) — there is no
performance seat as of 0.33.0, its checklist lives in the routed domain reviewers). The **failure-over-time** baseline is listed whenever `gates.failure_over_time`
fired (the changed prod lines touch concurrency, queues, durable steps or retries) and is
mandatory then. Express runs drop the architecture baseline but keep `security-reviewer`
and `failure-over-time`. Prompts: the baseline
templates and "Domain reviewer — Round 1" from `reviewer-prompts.md`, `{diff_range}` =
`$REVIEW_BASELINE..$REVIEW_SHA`, `{artifact_path}` = `$ARTIFACT_DIR/review-<role>-r1.md`. Read
verdicts from the files. **Record `agent_id` and `range` on every reviewer spawn event.** A routed
agent that is not installed → note the gap in the audit log, continue.

With `SHIP_REVIEW_BACKEND=codex` (`review-backend.md` §Substitution table): set
`PROJECT_CONTEXT` to the repo's declared criticality line from CLAUDE.md (empty when it
declares none) and `PRIOR_FILES` to the same list the Claude round-1 template gets as
`{prior_files_list}`; then, in the **same message**, one Bash call with `run_in_background`
```bash
T0=$(date +%s%3N); node "$SF/sf-codex.mjs" panel --roster "$ARTIFACT_DIR/route-r1.json" \
  --pin security-reviewer,ux-consistency-lead --template round1 --cwd "$WT_PATH" \
  --range "$REVIEW_BASELINE..$REVIEW_SHA" --artifact-dir "$ARTIFACT_DIR" --round 1 \
  --change-ref "task $TASK_ID: $TITLE" --project-context "$PROJECT_CONTEXT" \
  --prior-files "$PRIOR_FILES" --started "$T0"          # express runs add --routed-only
```
plus the Claude `Agent` spawns for the pinned seats (`backend=claude` on their events —
log each one with `started="$T0"` **the moment its result returns**, never batched after
triage; `sf-log` refuses a spawn or closure/clarify event without `started=`/`wall_ms=`,
and `sf-log check` flags a triage verdict whose reviewer has no prior spawn event).
`panel` runs longer than the Bash tool's cap: its completion signal is the summary file
`$ARTIFACT_DIR/panel-round1-r1.json` — and while it runs, READ THE DIFF yourself
(`git diff "$REVIEW_BASELINE..$REVIEW_SHA"` — the artifact every seat is judging), so 3e's
bucket calls and dedupe are grounded in code you have seen, not in finding prose alone.
Wait for the summary file (`Monitor`) before 3e, and read each
seat's `thread_id` (its `agent_id` for 3e) and `status` from the `results` entries there,
never from the panel's exit code. Each Codex seat writes its own `spawn` event; a seat
with `status:"failed"` → spawn that role on Claude with the round-1 template and log
`sf-log stage note event=codex-seat-fallback role=<role>`. The 3e closure / clarify
calls write their own `closure-exchange` / `clarify` events — do not log them a second
time.

#### 3e — Triage-driven fix loop (base 2 rounds, +1 seam extension, orchestrator-extended to a ceiling of 6)

First DEDUPE across seats: findings naming the same defect (same file and mechanism,
different wording) collapse into ONE item crediting every raising seat — the fixer must
see one item, not two; your own read of the diff (3d) is the tiebreak on whose wording is right.
Then sort actionable findings into the four buckets. Uncertain suggestions are not
confirmed defects; LOW-only cleanup never starts a fixer or review cycle (see
`scope-policy.md` for the optional cleanup budget). **1 fix now** (legitimate,
mechanically resolvable, in scope per `scope-policy.md` — same-class siblings included,
plus **touched-file adjacent** findings: MEDIUM+, bounded, in a file already in
`$REVIEW_BASELINE..HEAD`; mark those `ADJACENT` in the fixer prompt),
**2 needs a human** (a CRITICAL/HIGH that needs an operator decision is queued per
§Interview policy, and its fix waits for the answer while unaffected findings proceed;
unanswerable → `CHECKPOINT_REQUIRED: ambiguous-fix-required`; a question on a MEDIUM/LOW
finding, policy calls included → the PR-time list `pr-questions.md`, never a
mid-run question — and the finding is bucket 3 only when it names a code change,
`scope-policy.md` Rule 6), **3 out of
scope** (→ §Follow-up tasks if it clears the floor — filed **now**, in this triage, into
the run's bundle; state which scope-policy condition failed; "pre-existing" and "different
file" are not conditions; a finding this change caused or made more likely — a regression
against the base on an input the run measured, or a latent defect the change widens — is
bucket 1, never bucket 3, `scope-policy.md` Rule 5a), **4 not legitimate** (drop). **Goal-post rule** (`scope-policy.md`
Rule 5): a finding whose only evidence is a new counterexample to a **bounded** criterion
(one carrying `guard:` / `fixture:`; a run that skipped Stage 2 or an `exempt` criterion
has no pinned set and triages normally) — an input outside its fixture set (another
layout, document type, phrase pattern) — is bucket 3 at its stated severity with
`goal-post: yes` **only when the counterexample shows a quality shortfall: a correct-but-
worse output** on an input the run never measured; worse-than-base on a measured input is
bucket 1 (Rule 5a). A counterexample demonstrating a crash, data loss, wrong data attributed to
the wrong source, or an authorization / tenancy miss is bucket 1 at its severity regardless
of the fixture set. It is also bucket 1 when it breaks a pinned fixture or the structural
guard. A CRITICAL or HIGH goal-post finding earns one bucket-2 question (widen the set?)
before it is filed. Count them on the triage event (`goal_post=<n>`). All PASS and bucket 1
empty → `sf-log stage triage round=1 rereview_mode=none …`, go to 3f. Every triage event
carries `bucket1_high=<n>` (the CRITICAL/HIGH items in bucket 1) next to `bucket1_fix_now`,
and round 1's carries `capped_out='[…]'` from `route-r1.json`.

**Scope expansion is not a finding.** When a bucket-2 answer (or any operator decision
taken during the loop) adds work the accepted plan does not contain — a new behaviour on
more than one surface, a hook or observer threaded through several callers, a rule stated
for the first time — it leaves the fix loop: write it as a plan amendment (a `sf-plan-fixer`
warm pass appending a phase with numbered steps and acceptance, or an appended phase you
write yourself when it is under ~6 steps), spawn **`sf-implementer`** on a tasks file per
3c (never `sf-fixer`), then run a **round-1 routed panel over the new range** before the
findings join the next fix round's bucket 1. Log
`sf-log stage note event=scope-expansion round=<n> steps=<n> files=<n>`. Backstop: a fix
direction whose approaches touch more than ~12 files, or introduce one new behaviour on
several surfaces, is this case even when nobody called it scope — treat it as a batch.
Why: run through the fix loop with only a cold regression pass, a multi-surface change
draws fresh HIGH/MEDIUM findings in the new code round after round, and a fix can introduce
a new blocker; run as a batch (drafter → implementer → gates) the same change needs no
follow-up round.

Per round:
0. **Sync** — the §Integration sync block with `AT=3e` (`AT=phase`, probe only, inside an
   epic phase worktree) before the fixer is spawned, every round, not only on long runs:
   the fix loop is where a run spends its hours and where the base moves under it. A
   merge whose delta overlaps `$REVIEW_BASELINE..HEAD` adds the overlapping files to this
   round's cold roster diff (`--diff "$SYNC_BEFORE..HEAD"` alongside the fix range).
1. Triage (above). Ambiguous findings → one orchestrator-mediated clarification each to
   the originating reviewer by `agent_id` (`warm-closure.md` §Pre-fix clarification;
   Codex seats: the complete `clarify` command in `review-backend.md` §Substitution table).
2. **Fix direction (gated).** When bucket 1 holds any CRITICAL/HIGH **or** ≥ 5 findings,
   YOU write `$ARTIFACT_DIR/fix-direction-r<N>.md` before spawning the fixer — you hold
   the plan, the explore reports, the operator's decisions and every reviewer's findings
   side by side; the fixer holds only its prompt. **Budget (enforced, 0.33.0): at most 120
   words per item and 1,200 words per file** — check with `wc -w` before spawning; over
   budget → rewrite, never trim by dropping an invariant. A direction is the defect, the
   decision, and the file — not a design essay: no class taxonomy, no probe scripts beyond
   the three mandatory `verify_first` classes below, no redesign of a mechanism the plan
   did not name. An item that cannot be stated within budget is not fixer-shaped: it is a
   §Scope expansion (plan amendment → `sf-implementer`) or a bucket-3 follow-up. Measured:
   the 19 KB, four-item direction on one task carried a class assignment, a mandatory
   failing-test-first rule and three line-numbered probes for one item, and the fixer on
   another wrote a three-case concurrency proof inside a fix round — design work that
   no plan reviewer ever saw. Per finding id, at most ~6 lines:
   - **approach** — the fix shape you choose between competing recommendations (a
     recommendation is a hypothesis; your direction is the decision);
   - **verify_first** — the exact probes the fixer must run BEFORE editing (e.g. "enumerate
     the stored `ad_info` shapes, AI-authored rows included, and make any schema accept
     what you find"), each with what outcome would invalidate the approach;
   - **`verify_first` is mandatory for three classes**, whatever the bucket size: (a) a fix
     that introduces a **terminal / permanent / cached-negative classification**, or a proxy
     signal standing in for one — the probe enumerates the production write paths of that
     signal (`rg` for INSERT/UPDATE/set sites; a signal with zero production writers
     invalidates the approach); (b) a fix that introduces or changes a **timing constant** —
     the probe states the interlock inequality against every constant it interacts with
     (TTL, skew, poll cadence) with the numbers substituted; (c) a fix that **replaces an
     existing mechanism** — a query, predicate, resolver, gate, or per-item loop rewritten
     as a set-based or batched form — see the replacement rule below. For example: a
     holding-pattern row that no production path inserts leaves every fresh upload cached
     permanently unavailable; a 180 s refresh armed against a 300 s TTL with a 60 s skew
     filter is arithmetically unable to fire. The fixer reports each probe in its
     `verify_first` array (`sf-codex` flags a direction that asked for probes the report
     does not carry).
   - **Replacement rule (class c).** When the approach replaces a mechanism, YOU open the
     body of the thing being replaced before writing the direction and list, under
     `constraints`, **every predicate and invariant it enforces** — status filters,
     invalidation or cutoff timestamps, tenancy/scope joins, ordering, null handling — by
     name. Class (c) also fires when the approach touches a **lock, retry, idempotency or
     at-least-once guarantee**: then the list is every transaction / commit boundary the
     guarantee must span (each connection, each commit, each check-then-insert), and the
     direction states which single mechanism covers all of them. A guarantee that must
     span more than one transaction boundary is not a fixer-shaped change — route it as a
     §Scope expansion (plan amendment → `sf-implementer` → routed panel), never one
     boundary per round. Measured: one epic phase spent rounds 2–5 on a multi-record import's
     idempotency because round 3 locked the document insert while constraining the fix to
     the existing per-boundary connections, so round 4 found the lock released before the
     downstream record writes — the direction that finally closed it ("enumerate EVERY
     transaction boundary … comprehensively") is the one this rule requires up front. A direction that spells out the replacement query owns that query's predicates:
     the fixer follows the direction literally, so an invariant the direction omits is an
     invariant the fix drops. `verify_first` then requires the fixer to **write the failing
     behavioral test first** — a differential test (old mechanism vs new on one fixture) or
     a fixture that exercises each listed predicate — run it red before editing, and
     report the red output in its `verify_first` array. Measured miss this rule closes:
     one task's round 3, a readiness direction that prescribed `DISTINCT ON … WHERE
     status IN (complete, degraded)` verbatim and omitted the invalidation cutoff of the
     `resolveEligibleRun` it replaced; the fixer built exactly that, the architecture
     closure filed it as a fix-introduced HIGH, and the test-coverage seat spent a further
     round on the source-text assertion that stood in for the missing behavioral test.
   - **constraints / out-of-scope** — what the fix must not touch (e.g. a strict
     schema rejecting the codebase's own stored data, a query predicate locking out legacy
     rows, a repo-wide config bump — classic fix-introduced HIGHs), plus the class-c
     invariant list above.
   Skip it for a small MEDIUM/LOW-only bucket and for the mop-up. Codex seats: pass
   `--direction "$ARTIFACT_DIR/fix-direction-r<N>.md"` on the `fix` command (the spawn
   event records `direction=true|false`); Claude `sf-fixer`: paste the file into the
   §Fixer prompt's FIX DIRECTION block.
   **2b. Direction review (before the fixer).** A direction that merges findings is a
   synthesis you wrote from inside the long context that produced it; you cannot red-team
   it there. So a read-only reviewer does, before the fixer runs:
   - **trigger** — count the direction items that cite more than one finding id:
     `MERGED=<n>`, and among those the items that merge at least one CRITICAL/HIGH:
     `MERGED_HIGH=<n>`. When `MERGED_HIGH ≥ 1`, run this step; otherwise skip it — a
     direction that merges only MEDIUM/LOW findings is checked by the fixer's closures and
     the gates (`warm-closure.md` §0 has the measurement). The fixer spawn carries both
     `merged_items=$MERGED merged_high=$MERGED_HIGH`; `merged_high=0` is ungated.
   - **spawn** `sf-direction-reviewer` (`subagent_type: sf-direction-reviewer`, model from
     its frontmatter → `session`) with the `reviewer-prompts.md` §Direction review template
     (`{direction_path}=$ARTIFACT_DIR/fix-direction-r<N>.md`, `{reviewer_artifacts}` = one
     absolute path per line of the round's reviewer artifacts, `{merged_items}` = the merged
     item ids), artifact `$ARTIFACT_DIR/direction-review-r<N>.md`. Log it:
     ```
     sf-log spawn role=direction-reviewer agent_type=sf-direction-reviewer model=session \
       phase=fix round=N direction=$ARTIFACT_DIR/fix-direction-r<N>.md merged_items=$MERGED merged_high=$MERGED_HIGH \
       agent_id=<id> artifact=$ARTIFACT_DIR/direction-review-r<N>.md started=$T0
     ```
   - **resolve every BLOCKING finding by editing the direction** — write the invariant or
     the state model the finding asked for into the item, **inside the item's 120-word
     budget**; a BLOCKING answer that does not fit is a design question, and its item
     leaves the round as a §Scope expansion or a bucket-3 follow-up (never a longer
     direction — that is how one task's round 1 grew an object-storage claim-check). Never delete
     the item or re-split it back into the original recommendations. Log
     `sf-log stage note event=direction-revised round=N blocking=<n>`. A BLOCKING finding
     that needs a product decision is a bucket-2 item, queued per §Interview policy;
     unanswerable → `CHECKPOINT_REQUIRED: ambiguous-fix-required` (existing reason).
   - **no artifact after one retry** (§Artifact handoff) → log
     `sf-log stage note event=direction-review-skipped round=N` and launch the fixer; the
     `fixers_without_direction_review` check row is the record.
   - only then step 3. The gate is **one review, one revision** — no second review round;
     the fixer's closures are the check on the revised direction.
3. `FIX_BASELINE=$(git rev-parse HEAD)`; spawn **one `sf-fixer`** with the whole bucket
   (CRITICAL → LOW, grouped by file, with recommendations and the fixer contract from
   `reviewer-prompts.md` §Fixer prompt). **Codex-backend runs only** (`HYBRID_MODE` ≠ `off`,
   where `security-reviewer` / `ux-consistency-lead` stay on Claude): launch it when the
   Codex panel summary lands and the bucket is triaged — never hold it for a pinned Claude
   seat still running (`warm-closure.md` §Late seats: the seat's bucket-1 findings, if any,
   go to an addendum fixer in the same round, `sf-log spawn … round=N addendum=true`, with
   its own direction when gated, spawned **only after the first fixer has returned** — one
   writer at a time; the round's closures and cold pass run once, after the addendum). On a
   Claude-backend run every seat is read together, as before. Recommendations are hypotheses — the fixer
   verifies the cited code is live before applying, and may decline with one line of
   evidence. HYBRID_MODE=codex: write the bucket to `$ARTIFACT_DIR/findings-r<N>.md` and
   run the `sf-codex fix` command from `review-backend.md` §Hybrid mode (`--baseline
   "$FIX_BASELINE"`) **as a `run_in_background` Bash call** — the `fix-r<N>.md` artifact
   is the completion signal. **Never end a turn with a writer seat running**: a seat is
   either a background call (the harness wakes you) or is followed in the same message by a
   `Monitor`/background waiter on its artifact; `nohup … &` in a foreground call is
   forbidden (it returns immediately and nothing wakes you — the shipflow `Stop` hook
   blocks the turn end while a run's codex seat is alive). Its report is verified against the worktree and it writes its own
   spawn event; `status:"failed"` → spawn `sf-fixer` on Claude with the same bucket and
   log `codex-seat-fallback role=fixer`. **Fixer spawn ledger fields:** a Claude `sf-fixer`
   spawn event carries `direction=$ARTIFACT_DIR/fix-direction-r<N>.md merged_items=$MERGED`
   (the direction path, or `direction=false merged_items=0` when ungated); a Codex fixer gets
   `--merged-items $MERGED` (and `--direction` when gated). In a round after an
   `oscillation-stop`, the bucket's item ids also go on the spawn as `findings=` (so
   `fixers_on_stopped_findings` sees a stopped id that re-entered) — Claude sets it directly,
   Codex via `--finding-ids '[…]'`. **Round namespacing:** every 3e
   event written inside an epic phase worktree (the direction-reviewer spawn, the fixer spawn,
   `adjudication`, `closure-exchange`, `oscillation-stop`, `triage`, the `fix-replan` note) carries `epic_phase=<phase id>` —
   Codex seats via `--epic-phase`; single-task runs omit it. Rounds restart at 1 per phase;
   the `<layer><round>` numbering seen in older epic ledgers is not a convention.
   **3.5. Adjudicate semantic gaps (before closure).** A fixer that resolved a merged item
   often had to pick a design the direction left open; that pick reaches closure as a fact,
   not the reviewer's guess. Read `plan_gaps_semantic` from the fixer report — Codex: the
   result line; Claude: count the `## Decisions the findings did not specify` section the
   same way 3c step 5 counts the implementer's — and put it on the Claude fixer's spawn
   event (`plan_gaps_semantic=<n>`; Codex rows already carry it). When the round's **first**
   fixer report has `plan_gaps_semantic = 0`: no adjudication event, and step 4's closure gets
   the `(none — the fixer reported no semantic decisions this round)` literal. When
   `plan_gaps_semantic > 0`:
   - for each decision the fixer reported, write one line to
     `$ARTIFACT_DIR/adjudication-r<N>.md` under **`## Accepted`** (the decision becomes a
     fact of the design — it must be consistent with the direction's stated invariants),
     **`## Redirected`** (state the decision the direction actually requires), or
     **`## Deferred`** (the decision added behaviour the accepted plan does not contain: a
     new surface, a new timing constant, a new message class, a guarantee spanning more
     than one boundary — the fixer's commit for it is **reverted** in the redirect
     addendum and the item is filed bucket 3 at the finding's severity, or routed as a
     §Scope expansion when it blocks an acceptance criterion). **Accept is not the
     default.** Measured before 0.33.0: adjudication accepted 3/3, 5/5, 3/3 and 3/3 with
     zero redirects across four runs, which is how a bounded fixer pass became the place
     where interfaces, batch sizes and retry windows got decided. Accept only a decision
     the direction's invariants already imply; a decision that answers a question the
     plan never asked is deferred. Log
     `sf-log stage adjudication round=N gaps=<n> accepted=<n> redirected=<n> deferred=<n> artifact=$ARTIFACT_DIR/adjudication-r<N>.md`
     (add `epic_phase=<id>` in an epic phase; `deferred` is the number `$ship-report` reads
     to see whether adjudication is doing work).
   - **redirects → one targeted redirect-addendum fixer in the same round**, on either
     backend (the same one-writer-at-a-time sequencing as §Late seats' addendum, which is
     otherwise Codex-only): findings file `$ARTIFACT_DIR/findings-r<N>-redirect.md` holding
     the redirected decisions only, artifact `$ARTIFACT_DIR/fix-r<N>-redirect`, spawn row
     `round=N addendum=redirect`, started **only after** the first fixer (and any late-seat
     addendum) has returned and **before** any closure exchange; capture `FIX_SHA` after it
     returns. The addendum's own semantic gaps are **accept-only** — append each to that
     **same** `$ARTIFACT_DIR/adjudication-r<N>.md` under its `## Accepted` section (one
     adjudication file per round, so step 4's `{accepted_decisions}` carries both writers'
     accepted lines), then **always** log a second `adjudication` row (`gaps=<the addendum's
     count, possibly 0>`, `redirected=0`, the **same** `artifact=$ARTIFACT_DIR/adjudication-r<N>.md`),
     so a round that ran a redirect addendum has exactly two adjudication rows. **Writer invariant
     (stated once, here):** a
     round runs its writers strictly one at a time in the order first fixer → late-seat
     addendum (`addendum=true`, Codex-backend only, `warm-closure.md` §Late seats) →
     redirect addendum (`addendum=redirect`); no addendum spawns a further addendum, which
     is why the redirect addendum's gaps are accept-only. The round's **first** `adjudication`
     row covers the first fixer's gaps and any late-seat addendum's together (`gaps` = their
     sum), so it is written after the late-seat addendum returns and before the redirect
     addendum; the second row covers the redirect addendum.
   - then step 4 runs with `{accepted_decisions}` = every `## Accepted` line (Codex:
     `--decisions "$ARTIFACT_DIR/adjudication-r<N>.md"`).
4. **Warm closure** — `SendMessage` each reviewer that **qualifies** (`warm-closure.md`
   §1: its round verdict was FAIL, or the fixer declined one of its findings, or one of its
   findings was reopened before — a PASS reviewer whose MEDIUM/LOW findings were applied
   is not contacted and carries PASS), by recorded `agent_id`, with the "Closure verification (warm)" template
   (`{fix_commit_range}` = `$FIX_BASELINE..$FIX_SHA`, where `FIX_SHA=$(git rev-parse HEAD)`
   is captured once the round's last writer has returned; absolute closure artifact path;
   `{accepted_decisions}` = the adjudication `## Accepted` lines from step 3.5 — Codex:
   `--decisions "$ARTIFACT_DIR/adjudication-r<N>.md"` — or the none marker when the round
   had no semantic gaps).
   Verdicts per finding: `CLOSED | REOPENED | DECLINE-ACCEPTED | NOT-MINE`. No
   continuation → cold "Domain reviewer — Round 2+" spawn. One `closure-exchange` event
   per exchange, carrying `reopened_ids='[…]'` (`item ?? id` for every reopened finding, from
   the closure table). Codex seats: write the findings table (declined rows included) to
   `$ARTIFACT_DIR/closure-table-<name>-r<N>.json` — each entry carries `item=<item id>`
   whenever the seat id was merged into an item at DEDUPE, so `reopened_ids` keys on the item —
   then the complete `closure` command in
   `review-backend.md` §Substitution table; exit 3 is the no-continuation case → that
   table's `round2` command (`--prior-artifact` required), `path=cold-fallback`.
5. **Cold regression pass** — `node "$SF/sf-route.mjs" cold-roster --diff "$FIX_BASELINE..$FIX_SHA" [--had-high]`:
   - `mode=warm+cold-panel` (a fix commit touched a seam **and** the bucket held a
     CRITICAL/HIGH — pass `--had-high` only then) → the full round-1 panel, cold,
     over `$REVIEW_BASELINE..$FIX_SHA` with the round-1 templates (Codex seats: the 3d
     `panel` command with `--round N`; for the `warm` roster below save `cold-roster`'s
     JSON to `$ARTIFACT_DIR/cold-roster-r<N>.json` and run the `regression` panel
     command from `review-backend.md` §Substitution table).
   - `mode=warm` → the returned roster with the "Regression pass (cold)" template over
     the fix range — **unless** `skippable=true` **and** every closure came back
     `CLOSED`/`DECLINE-ACCEPTED`: then no cold spawn this round (`rereview_mode=warm`,
     `rereview_reviewers=[]`).
   Emit the round's triage event **after the closures settle, before the cold pass**:
   `sf-log stage triage round=N rereview_mode=<warm|warm+cold-panel|cold-fallback> rereview_reviewers='[…]' reviewer_verdicts='{…}' bucket1_fix_now=… bucket1_high=… bucket2_human=… bucket3_followup=… bucket4_dropped=… goal_post=…`,
   and `sf-log cursor … stage=3-fix fix_round=N`.
6. **Round verdict**: clean when every finding is `CLOSED`/`DECLINE-ACCEPTED` and the
   cold pass (and any `NEW (fix-introduced)` heading) reports no CRITICAL/HIGH → break.
   `REOPENED` findings join the next round's bucket 1 (ordinary path — there is no
   pairing sub-protocol). On an item's **second** `REOPENED`, apply `warm-closure.md` §3's
   oscillation stop (log `oscillation-stop`; a design note lets a CRITICAL/HIGH id re-enter
   once, otherwise `ambiguous-fix-required`; MEDIUM/LOW → bucket 3): the next round's fixer
   spawn carries `findings='[…]'` and the closure carries `reopened_ids='[…]'`. Uncontacted
   reviewers carry their prior verdict.
7. **Re-plan trigger first.** `node "$SF/sf-route.mjs" fix-trend --log "$RUN_LOG" [--epic-phase <id>]`
   (`--epic-phase` is mandatory inside an epic phase) → `{ rounds, replan, replan_already_taken, reason }`. The
   whole rule lives in `fix-trend`: `replan=true` when the latest round has
   `bucket1_high > 0` and neither `bucket1_fix_now` nor `bucket1_high` fell against the
   previous round; no comparison after a `warm+cold-panel` round, across a `scope-expansion`
   note, or on the seam-extension round. It means the fix loop is not converging on this
   plan: leave the loop, **at most once per phase** (`fix-trend` enforces this: it reports
   `replan_already_taken` from the log's `fix-replan` notes and then returns `replan=false`),
   and log `sf-log stage note event=fix-replan
   round=<n> must_fix=<n> prev_must_fix=<n> [epic_phase=<id>]`. Bundle runs skip re-plan
   (`sf-log stage note event=fix-replan-skipped reason=bundle`). Route: a plan amendment
   (§Scope expansion's `sf-plan-fixer` pass over the open findings) → a **cold**
   `sf-plan-reviewer` scoped to the amendment, artifact
   `$ARTIFACT_DIR/plan-review-replan-r<n>.md`; its CRITICAL/HIGH get one `sf-plan-fixer`
   pass, then proceed (no loop) → `sf-implementer` (logged `phase=implement`) → a full
   routed panel (3d) over the new range, routed to `$ARTIFACT_DIR/route-replan-r<n>.json`.
   That panel writes into `$ARTIFACT_DIR/replan-r<n>/` — Claude seats get `{artifact_path}` =
   `$ARTIFACT_DIR/replan-r<n>/review-<role>.md`, Codex seats run the 3d `panel` command with
   `--roster "$ARTIFACT_DIR/route-replan-r<n>.json" --artifact-dir "$ARTIFACT_DIR/replan-r<n>"`
   — so round 1's files stay intact, and its triage logs `round=<post-replan round>` with `rereview_mode=cold-fallback`.
   3g's `## Review coverage` still reads round 1's `route-r1.json` only. The carried finding
   ids go into that panel's prompt as "verify closed"; each seat that verifies them logs one
   `closure-exchange` row (`round=<post-replan round>`, `epic_phase` inside an epic) with
   `reopened_ids='[…]'` for the ids still open, so the oscillation guard sees them. That
   panel and every later round count toward `SHIP_FIX_ROUND_CEILING`; after the one
   re-plan the rules below apply unchanged.
   `replan=false` → continue below.
   After round 2, still failing → **seam extension** first: when the **last completed
   round's** `cold-roster` returned `mode=warm+cold-panel` (a fix commit touched a seam),
   the full cold panel that ran was a new round-1 read of a larger change — its findings
   get one ordinary fix round before the draft-PR fallback. **Once per run: skip when
   `$RUN_LOG` already holds a `fix-seam-extension` event** (`grep -c '"stage":"fix-seam-extension"' "$RUN_LOG"`).
   Log `sf-log stage fix-seam-extension round=<next> seam_round=<the round whose mode was warm+cold-panel>`.
   Then, still failing → **round extension** (replaces the 0.23 convergence escape). YOU
   authorize the next round — without asking — when ALL hold:
   - **progress, or a bounded bucket**: open CRITICAL/HIGH strictly decreased against the
     previous round, OR every remaining open CRITICAL/HIGH is bounded — `file:line`, a fix
     shape you can write into `fix-direction-r<next>.md` with a `verify_first` probe, no
     product decision, not a goal-post counterexample (bucket 3 by the rule in step 1);
   - **no oscillation**: no *open bucket-1 CRITICAL/HIGH* has been `REOPENED` twice (a
     twice-reopened one carries an `oscillation-stop` event: with a `design_note` it
     re-enters once, otherwise it has left via `ambiguous-fix-required`; a twice-reopened
     MEDIUM/LOW is bucket 3 and does not block), and
     no fix in the last round reverted or inverted an earlier round's fix;
   - **no fix-introduced CRITICAL/HIGH** in the last round's closures or cold pass;
   - the round about to run ≤ `SHIP_FIX_ROUND_CEILING` (default **6** per phase, the seam
     extension counted).
   All four are re-evaluated after **every** round — each extension is authorized on its
   own. Log `sf-log stage fix-round-extension round=<next> reason=<progress|bounded> open_high=<n> prev_high=<n> ceiling=<n> phase=<epic-phase:<id> | single>`
   and run it as an ordinary round (direction gated as in step 2); the ledger is the
   authorization. Any condition fails → a question queued per §Interview policy **only
   when there is a decision to make** (a bucket-2 dispute; a reverted/inverted fix whose two
   designs the operator must choose between); otherwise, and past the ceiling,
   `CHECKPOINT_REQUIRED: unresolved-review-findings` (informational — the PR opens as a
   draft, the run continues). An operator-granted round is logged
   `sf-log stage note event=operator-authorized-round round=<n> phase=<…> reason=…` so `$ship-report`
   counts the questions the rules did not absorb. Why: a fixed 2-round budget forces
   repeated operator questions whose recommended answer is mechanical, idling the run; and an
   exhausted budget can leave a late panel's fix-now findings verifiable only by gates
   (`draft-unverified-final-round`).

**Close the ledger.** Append a closing triage event (`round` = last + 1,
`rereview_mode=none`) recording what the final re-review surfaced — zeros included —
unless the loop exited at step 1's empty-bucket break. Then the **mop-up**: one
`sf-fixer` pass when the final round has mechanically-resolvable in-scope MEDIUM
findings. Optional LOW cleanup shares that pass only within `scope-policy.md`'s
run-wide budget; LOWs alone never start it. Verify with the scoped type-check plus
`npx vitest run --changed` — no closure
exchanges, no cold pass, PASS not reopened, one generation only
(`scope-policy.md` §Rule 1). HYBRID_MODE=codex: the same `sf-codex fix` command with
`--role mopup-fixer`. Below-floor leftovers → `## Review residue (not filed)` in
the PR body. `sf-log stage mopup fixed=… residue=… filed=… generation_capped=…`.
`PushNotification`: reviews clean.

**Wait through the host adapter.** Native Codex uses its collaboration wait/follow-up
tools and explicitly reconciles artifacts on resume. Claude-host headless launches use
`run_in_background` or a registered waiter; the Claude `Stop` hook guards that path.
Await required work before completion. Waiting and operator decisions are expected;
an idle interval alone is not evidence of orchestration overhead.

**Use the waits.** While a backgrounded fixer, panel, or closure batch runs, do the tail
work that needs no new information: draft the PR-body sections already known (summary,
`Refs #<n>` line, residue/deferred skeletons), assemble 3f.5's AC table (each AC → the exact
command you will run and what output passes it), pre-write the closure tables for
reviewers whose findings were fixed, and draft §Follow-up task bodies from bucket 3.
Every artifact is consumed within two stages, so none of it is speculative — it moves the
3f–3g serial tail inside the fix round's wall.

#### 3f — Build gate + lint gate

**Sync first** — the §Integration sync block with `AT=3f`, so the build, the manifest-drift
check, the lint ratchet and the acceptance commands (3f.5) all run **on the tip that
ships**. A merge delta that overlaps
`$REVIEW_BASELINE..HEAD` gets the cold regression roster
(`sf-route cold-roster --diff "$SYNC_BEFORE..HEAD"`) and one fix round if it fails, before
the gate. In an epic this point runs on the integration branch at finalize (2.7); a phase
worktree probes only.

**Prepare** (foreground, after the sync):
```bash
CHANGED=$(git diff --name-only "$REVIEW_BASELINE"..HEAD)
node "$SF/sf-route.mjs" classify --cwd "$WT_PATH" --config-ref "origin/$BASE_BRANCH" --diff "$REVIEW_BASELINE..HEAD" > "$ARTIFACT_DIR/route-build.json"
printf '%s\n' "$CHANGED" > "$ARTIFACT_DIR/changed-files.txt"
GATE_DIR=$(mktemp -d); echo "$GATE_DIR"   # result.json and job logs — outside the repo, never committed; reuse this printed path in every later call
# When the entering skill runs 3f.5: write "$GATE_DIR/ac.json", one entry per command-backed
# criterion — [{"id": <n>, "sh": "<command>"}, …]; add "reads_build": false only to a command
# that reads no build output.
```

**The gates run as one background command on that tip** — one Bash call with
`run_in_background` and an explicit `timeout` at the tool's maximum:
```bash
node "$SF/sf-gates.mjs" gate --mode full --cwd "$WT_PATH" --base "$BASE_BRANCH" --baseline "$REVIEW_BASELINE" \
  --out-dir "$GATE_DIR" --runstate "$RUNSTATE" --ship-mode "$SHIP_MODE" \
  --changed-files "$ARTIFACT_DIR/changed-files.txt" --ac "$GATE_DIR/ac.json"   # no --ac when 3f.5 is not run
```
While it runs, the orchestrator and seats write only the ledger, the runstate and
`$ARTIFACT_DIR` files in the worktree, and the orchestrator does 3f.5's non-command
criteria. **A background job is a new shell**: no variable from an
earlier call exists in it, so every value the command needs (`SF`, `GATE_DIR`,
`ARTIFACT_DIR`, `REVIEW_BASELINE`, `SHIP_MODE`, `WT_PATH`, `BASE_BRANCH`, `RUNSTATE`) is
written literally into the call.

The command runs the job set as concurrent child processes and prints one JSON line, also
written to `$GATE_DIR/result.json`:

| Job | What it runs | Starts |
|---|---|---|
| `build` | the install await, then the scoped build: `npx turbo run build --force --filter="...[$REVIEW_BASELINE]"`, without the front end when the diff touches none of `SF_FULL_INSTALL_PATHS` | at once |
| `drift` | the manifest-drift check, then each suite in `push_gate_skips`, one after another | at once — unless the runstate has `push_gate_skips`: a suite in `push_gate_skips` reads build output, so the job then starts once `build` passes |
| `lint` | `node scripts/lint-ratchet.mjs --files-from "$ARTIFACT_DIR/changed-files.txt"`, when the repo has that script | at once |
| `ac-<n>` | one job per `--ac` entry (3f.5), as `bash -c 'set -o pipefail; <command>'` | once `build` passes — unless the entry says `"reads_build": false` |

A command **reads build output** when it reads `dist/`, `.next/`, or any workspace the
build rebuilds (a test that resolves a built package's `.js` files does); when unsure,
leave `reads_build` unset. Jobs held for the build start together when `build` passes and
are `not-run` when it does not. An `ac-<n>` command carries no trailing `&`.

**The verdict is the JSON's `pass` and `next`, read from `$GATE_DIR/result.json`.** Each
job's `verdict` (`pass`, `fail`, `preexisting`, `error`, `not-run`) is that job's own exit
status. Never take a verdict from the Bash call's own status, from a pipeline (`| tail`,
`| grep`), or from a log that merely looks clean. No JSON — exit 2, or a command that was
killed — is an error, never a pass: repeat **Prepare** (a fresh `GATE_DIR`,
`changed-files.txt` written again, and `ac.json` written again into the new `GATE_DIR` —
the old directory's `ac.json` is not carried over) and launch the command once more, and
an error that persists is a bucket-1 finding (`shared/run-preflight.md` §Push-gate
baseline). Read a job's `log` only when the result marks that job `fail` or `error`.

**Act on `next`:**
1. `build-failed` — `build` did not pass after its resilience retries →
   `CHECKPOINT_REQUIRED: build-failed` (first 40 lines of the `build` job's `log`, failing
   workspace).
2. `ac-failed` — an `ac-<n>` job did not pass → 3f.5's `ac-failed`. A criterion with no
   command is not in the result; `ac-unverifiable` stays the orchestrator's call (3f.5).
3. `fix-pass` — `drift` (manifest drift or a skipped suite, unless pre-existing) or `lint`
   failed, and `bucket1` names them: collect their failures into **one** bucket-1 list for
   **one** fixer pass. The fix moves the tip, so **Prepare** is repeated on the new tip —
   `changed-files.txt` from the new `$REVIEW_BASELINE..HEAD`, a fresh `GATE_DIR`, and
   `ac.json` written into it — and the whole command is launched once more there, with
   `--relaunch yes`. On that run a `drift` or
   `lint` failure comes back as `next = build-failed` → `CHECKPOINT_REQUIRED: build-failed`
   with its log; a `build` or `ac-<n>` failure keeps its checkpoint above.
4. `pass` — every verdict is `pass` or `preexisting` → 3f.5's table, then 3f.6.

**Build gate** — the `build` job. **Every turbo gate in this skill runs with `--force`.**
A cache hit is not a run: a
`FULL TURBO`, fully-cached, sub-second exit reads no line of the new code; `--force` re-runs
it. A gate's exit code is its verdict only when the gate executed.
`--filter="...[$REVIEW_BASELINE]"` = touched workspaces plus everything that depends on
them. The full repository build is never required by this skill. The command applies **build
resilience** itself, once per class per job, re-running that job alone after every started
job has ended; the result names the class (`resilience`) and the count (`attempts`): a job
killed with no exit status → re-run as it was; exit 137 / `Killed` / heap OOM in any job →
`NODE_OPTIONS=--max-old-space-size=8192`, and `--concurrency=1` on a turbo job; for `build`
and `smoke`, stale artifacts (`.next/`, missing generated types, "module not found" for
files that exist) → clear `.next`/`.turbo`/`.cache` and retry, and link-farm resolution
(`cannot resolve next/package.json`, empty workspace `node_modules`) → run the install and
retry. A genuine compile error, or a failed retry, is `next = build-failed`. A `build`
verdict of `error` has one of three causes, none of them a finding about the code:
`npx turbo` could not be resolved (the job did not run, `attempts` 0); the job was killed
with no exit status on its re-run too (`signal` set, `resilience` `killed`); or the command
could not be started. `sf-log stage build-gate scope=<filter> next=<bool> result=<pass|fail>`.

**Manifest drift and skipped suites** — the `drift` job: the repo-declared
`manifest_drift` check, read from the base (`--base "$BASE_BRANCH"`; `shared/repo-config.md`;
undeclared → skipped). Then each suite in the runstate's `push_gate_skips` runs once, and a
failing manifest-drift check re-runs, on the branch and the current base — the
`run --set <suites|manifest-drift> --only <name>` comparison, one check after another inside
the job. The result lists each check under `checks` with its `verdict`, both logs and
`branch_only_failures`: a failure is `preexisting` only under the
predicate in `shared/run-preflight.md` §Push-gate baseline, and only when the branch and
base runs both ended by their own exit status. `fail`, or an `error` — a branch run that
timed out, one killed again on the job's one re-run, a `push_gate_skips` suite the base
no longer declares, or a check that could not be set up twice — is a bucket-1 finding (`next = fix-pass`). Log, per check,
`sf-log stage build-gate scope=<name> result=<pass|fail|preexisting|undeclared|error>`.

**Lint** — the `lint` job takes the file list with `--files-from` (never a whole-workspace
`npm run lint`, and never `$CHANGED`
unquoted on the command line — zsh hands the whole list over as one argument and the ratchet
saw "no lintable files" on a 96-file diff; run via `xargs` it exited 123 with two
real regressions). The job's exit status is the verdict, and the result carries the count
beside it — `lint: {checked, expected, false_green}`: `checked` is the N of the ratchet's
`ok (N file(s) checked)` line, `expected` the changed, existing, lintable files,
and fewer than half of them checked is a false green — the job fails; fix the invocation.
A regression is a bucket-1 finding (`next = fix-pass`). `sf-log stage lint-gate result=…`.

#### 3f.5 — Acceptance criteria

For each AC in the plan's `## Acceptance criteria (bounded)` (the task body's
`## Acceptance Criteria` when Stage 2 was skipped) produce an artifact — a criterion's
`guard:` is verified by running it, its `fixture:` set is the inputs the check runs on.
**Command-backed criteria are 3f's `ac-<n>` jobs**: each command is one entry of the
`--ac` file and runs as its own job beside `build`, `drift` and `lint`; its output is the
job's `log` and its verdict the job's `verdict` in `result.json`. A command that reads
build output starts once the `build` job has passed; one marked `"reads_build": false`
starts with the build. Entered without 3f (§No-code outcome), each command runs in the
foreground as `bash -c 'set -o pipefail; <command>'`, its verdict that call's own exit
status, with no build wait. The criteria that are not commands
(a screenshot, a spec read against the code) are done by the orchestrator while the jobs
run. Per criterion:
executable behavior → the command and
its output; UI behavior → the highest available tier — `/screenshot <route>` only when a
dev server for **this** worktree is already running (don't start one — take the tier 2/3 artifact and add "run the in-app check on
`<route>`" to `pr-questions.md`, §Interview policy — never a follow-up task, `scope-policy.md` Rule 6), else a
`*.browser.test.tsx` (vitest browser project), else a `*.dom.test.tsx` or story — an AC
verified at tier 2/3 is `PASS (browser-deferred)` and goes on `$DEFERRED_VISUAL`;
type/contract guarantees → the `build` job's verdict (3f); schema changes → the migration output or a
query. **A spec that was never run is not an artifact**: read it against the code and
record `DEFERRED_NO_ENV (spec verified consistent)` or `FAIL (spec contradicts <file:line>)`.
A criterion's `live:` part needs the branch deployed, so it is verified at 3g §Live smoke,
never here: verify its local parts as above and record the live part as `DEFERRED_LIVE`
(it counts as passed for `gh pr ready`, like `browser-deferred`) and put it on `$DEFERRED_LIVE`, persisted as the runstate's `deferred_live` (a resumed or split run reads it back).
Acceptance logs live in `$GATE_DIR`; quote the lines a criterion needs into the table.
Render the table to stdout and `sf-log stage ac-verification results='[…]' deferred_visual='[…]' deferred_live='[…]'`.
Unverifiable at any tier → `CHECKPOINT_REQUIRED: ac-unverifiable`; a failing check →
`ac-failed`. Neither pushes.
When every criterion passed, remove every `GATE_DIR` this run created, and every
`SMOKE_DIR` — `rm -rf "${GATE_DIR:?}"` / `rm -rf "${SMOKE_DIR:?}"`; `${…:?}`, never a bare
variable: an unset one must stop the shell, never widen the removal. A checkpoint (`ac-failed`, `ac-unverifiable`, `build-failed`) leaves them
in place.

#### 3f.6 — Follow-ups (verify, not file)

Every bucket-3 finding that cleared the floor was filed at its triage (§Follow-up tasks);
confirm `$FOLLOWUP_TASKS` accounts for every triage event's `bucket3_followup` — filed, or
listed under `## Review residue (not filed)` (filed ≤ bucketed, by the floor). File here
only the mop-up's residue that clears the floor (same bundle). The bundle's `## Origin`
gets the PR URL at 3g.

#### 3g — Push + PR

**Probe first** — the §Integration sync block's read-only probe with `AT=3g` (it sets
`$PROBE`, `$BEHIND`, `$SYNC_BEFORE`). `PROBE=clean` and `BEHIND=0` → push. Behind but clean → merge (the block), re-run the scoped gate
(`type-check --force` + `vitest run --changed "$SYNC_BEFORE"`), then push. A conflict →
the block's merge + conflict rule, the cold roster over `"$SYNC_BEFORE"..HEAD`, the scoped
gate, then push. **A tip that does not probe clean is never pushed as a PR head** — this is
the rule that makes a one-phase run merge clean, not a wish. After the PR exists, read
the call's `mergeable`; `CONFLICTING` is a failure of this rule (the base moved during the
push — loop once: merge, the scoped gate, the call again), and the value goes in the
report.

**Push and PR are one background command.** First write the body (below) to a file
outside the repo (`BODY=$(mktemp)`) and decide ready-versus-draft (**Ready for review**,
below): the call takes `--task-status "development complete"`, or `remediating` when the
PR stays a draft, and `--skill` names the entering skill (`ship-task`, or the skill
running 3g by reference). Then one Bash call with `run_in_background` and an explicit `timeout`
at the tool's maximum, every value written literally (a background job is a new shell):
```bash
node "$SF/sf-push.mjs" --kind final --cwd "$WT_PATH" --branch "$BRANCH" --base "$BASE_BRANCH" --runstate "$RUNSTATE" \
  --title "$TITLE" --body-file "$BODY" --task "$TASK_ID" --task-status "development complete" --skill "<entering skill>"   # --note "<the release-rule sentence>" when §PR link-back's release rule applies
# stack: env $(node "$SF/sf-gates.mjs" push-env --runstate "$RUNSTATE") gh stack submit --auto
#   then per layer, bottom-up: the same call with --push no --branch <layer branch> --base <that layer's PR base>
```
It pushes under the approved skips (the repo's `push.verified` command, read from the
base — `shared/repo-config.md`), finds the open PR for the branch or creates the draft,
updates the body through `gh api` and reads it back, reads `mergeable` (once more about
10 s after `UNKNOWN`) and does §PR link-back. `--push no` runs no push — the stack submit
already pushed — and still requires the remote tip to equal the layer branch. It prints
one JSON line: `{kind, branch, base, remote, pushed_sha, remote_sha, verified,
push:{via, exit, log, duration_ms}, test_arms, range_base, pr_number, pr_url, pr_created,
body_verified, mergeable, tracker:{comment, pr_field, branch_field, status}, error?}`
(`push.log` is the transcript path whenever one was written).
**Judge it from the JSON, never from an exit status alone.** `verified: true` is the only
proof the tip is on the remote; `body_verified: true` is the only proof the PR carries
this body; `mergeable` is the value above (`MERGEABLE | CONFLICTING | UNKNOWN`). An
`error` names the step that failed (`push`, `verify`, `pr-find`, `pr-create`,
`body-update`, `body-verify`, `mergeable`) and nothing after it ran: read `push.log` for
a `push` failure, fix the cause and call again — a push with nothing new still verifies
and the PR is found, not created twice. No JSON (exit 2) is an error, never a push.
`$PR_NUMBER` and `$PR_URL` are the JSON's `pr_number` and `pr_url`; the orchestrator runs
`gh pr ready` itself, after the call. On `mergeable: UNKNOWN` (the script has already
read it twice) read `gh pr view "$PR_NUMBER" --json mergeable --jq .mergeable` once more
before `gh pr ready`; a `CONFLICTING` there is handled like the call's.
On `CONFLICTING` the script leaves the link-back comment and the status unwritten
(`skipped-conflicting`), so the loop-once call writes them. A second `CONFLICTING` is not
looped again: the PR stays a draft and the orchestrator writes both itself —
`tracker task status "$TASK_ID" remediating` and `tracker task comment "$TASK_ID" --body-file <file>`
(`**[<entering skill> · pr]** <PR url>`, saying the PR conflicts with `<base>`).

**The final push is the one that runs the hook's test arms over the run's whole range**
(it sends the range base; `shared/run-preflight.md` §Push-gate baseline). Commit the
`stage=3g` runstate cursor and ledger before the call, so the push carries a ref line,
and log the result: `sf-log stage note event=push kind=final test_arms=<value> pushed_sha=<sha>`.
`test_arms: ran` means the push was not skipped as a checkpoint; suites skipped with the
operator's approval are reported from `push_gate_skips`, not from this field.

**Whether the arms are owed is read from the runstate's `arms_owed`** (a boolean,
§CHECKPOINT_REQUIRED: `true` is committed with every push that asked the hook to skip
its arms) — never from a ledger line, so a resume in another checkout reads the same
answer. The PR is marked ready only when the arms were confirmed on the run's range, or
no push of the run asked to skip them:
- `test_arms: ran` — a result that carries an `error` included: a later step failed after
  the hook judged the range → nothing owed; `sf-log cursor "$RUNSTATE" arms_owed=false`.
  The write rides the next runstate commit; losing it only repeats this decision.
- Any other value — `skipped-checkpoint`, `no-ref-pushed`, `unconfirmed`, or `null` (a
  `--push no` call) → owed exactly when `arms_owed` is `true`. A runstate that cannot be
  read, or a key that is present and not a boolean, is owed; an absent key is `false`. A
  stack run never sets the key, so its per-layer `null` owes nothing.
- **Not owed, and the result's `tracker.comment` is `skipped-arms-unconfirmed`** (the
  script writes no comment and no status while `test_arms` is neither `ran` nor `null`)
  → one more call writes the link-back: the same command with `--push no` and the same
  `--skill`, `--note` and `--task-status`. In a clone whose hook does not read the range
  input every final push is `unconfirmed`, so there this second call is the usual path.
- **Owed** → the hook's test arms have not been confirmed on the run's commits: the PR
  stays a draft and the orchestrator writes `tracker task status "$TASK_ID" remediating` and,
  unless the result's `tracker.comment` is `ok` (a `--push no` call wrote it), the
  link-back the script withheld: `tracker task comment "$TASK_ID" --body-file <file>`
  (`**[<entering skill> · pr]** <PR url>`, saying the test arms are unconfirmed). What
  ends it depends on the value. `no-ref-pushed` (the remote already held this tip, so the
  hook was handed nothing): commit the runstate cursor and ledger — `sf-log cursor`
  always changes `updated`, so the commit is never empty — and call `--kind final` again.
  `unconfirmed`, `skipped-checkpoint` or `null`: no call ends it — no hook judged the
  range; the report says the test arms were never confirmed on
  `<range_base>..<pushed_sha>` and have to be run outside the hook.

Body: summary, `Refs #<n>`, `## Follow-up tasks` (when any — the bundle URL,
then one line per subtask), `## Deferred visual checks` (one line per deferred AC: route, what to look at, tier-2/3 artifact),
`## Review residue (not filed)` (when any), `## Questions for the operator` (when
`$ARTIFACT_DIR/pr-questions.md` has entries — one line each, with its follow-up when it has one),
`## Review coverage` (when round 1's `capped_out` is non-empty — the seats the panel cap
did not seat), and `## Live dev run` when a live run is owed: `route-build.json` has
`live_check.required` (pipeline work, as the repo's `.shipflow.json` `live_check` declares it;
a config error also sets it — state the `live_check.note`) or `$DEFERRED_LIVE` is non-empty.
The run executes a live check only when the operator picks the smoke option (§Live smoke);
otherwise a run is recorded from an operator report. Until then no task is filed — an
owed check is the operator's, not backlog work (`scope-policy.md` Rule 6): the
section says `not run — owed (see Questions for the operator)` and lists the
`live_check.instructions` and every `$DEFERRED_LIVE` criterion, and `pr-questions.md`
gets an entry for it (options: smoke-test it
for me / ran-pass / ran-fail / defer — the smoke option first and recommended when the
§Live smoke preconditions hold, else omitted with the reason in the question).
Stack: verify bases bottom-up; only the final
layer carries the parent's `Refs #<parent>`. **Ready for review** (`gh pr ready`) only when no
CRITICAL/HIGH is open, AC passed (`browser-deferred` and `DEFERRED_LIVE` count as passed) and,
when a live run is owed, the body carries `## Live dev run` (an owed run does not block,
§Interview policy); an
`unresolved-review-findings` run stays a draft. Post one PR comment only for what remains
(unresolved findings, deferred bucket-2 notes). Then §PR link-back — the comment, fields
and status are the call's `tracker` result (never posted a second time by the entering
skill); flag a `failed` one in the final report —
`tracker task edit "$BUNDLE_ID"` adding the PR URL under the bundle's `## Origin` (when
one exists), and an implementation-notes comment (`**[ship-task · implemented]**`).
`sf-log stage implement-issue branch=… pr_url=… pr_base=… review_status=… fix_rounds=N reviewers='{…}'`.
`PushNotification`: done. After the PR is open, ask the `pr-questions.md` list once
(§Interview policy — `operator-wait` first) and record each answer: a question whose
finding was filed is answered in a comment on that follow-up subtask, every other answer
in one PR comment; the PR never waits on
this exchange. An in-app check the operator reports as failing is a defect and is handled
like **ran-fail** below (Rule 6). The live-dev-run answer is always a PR comment — no task holds it:
**smoke-test it for me** → run §Live smoke now; its
verdict is handled as the matching answer below (inconclusive: §Live smoke step 6), with `by=agent evidence=<live-smoke.md>` on
the log line; **ran-pass** → `sf-log stage note event=live-dev-run
result=pass evidence=<operator report>`, rewrite the section with the result;
**ran-fail** → log `result=fail`, rewrite the section,
`gh pr ready --undo`, and file one `bug` subtask of `$TASK_ID` — a failed run is a
defect, which is work (Rule 6): `tracker tag ensure bug`, then
`tracker task create --parent "$TASK_ID" --status "to do" --tag bug` with
`fix-task` Stage 3's body shape, the evidence in `## Requirements`; the PR comment names
it, and the fix is `$fix-task $TASK_ID`, which adopts that `bug` subtask;
**defer** → nothing changes.

#### Live smoke (operator opt-in)

The agent runs the owed live check itself: deploy the PR head to dev, trigger it, read the
evidence. It runs only on the operator's **smoke-test it for me** answer, which is the
approval for this task's dev deploy — dev only, the stacks `live_check.instructions` names,
this PR head. It never deploys to any other environment, and the approval does not carry to
another task.

**Preconditions** — checked before the option is offered and again before deploying; a
failed one drops the option (or ends the smoke `inconclusive`) with the reason stated:
`route-build.json` `live_check` carries both `instructions` (the only source of the deploy
command — `$DEFERRED_LIVE` criteria add triggers, never a deploy) and `dev_probe`; the
`dev_probe` argv exits 0 now — it proves the credentials reach dev, not merely some account
(on an auth error, name the login command in the question); the PR head is pushed and equals
the worktree `HEAD`.

1. **Record, then lock.** First write `pending_operation:{kind:"live-smoke",sha,lock}` with
   `sf-log cursor`, so a crash at any later point is visible to a resume. One smoke per clone
   at a time — it does not fence other people deploying to dev, which is why step 3 proves
   what runs:
   `LOCK="$(git rev-parse --git-common-dir)/sf-live-smoke.lock"; mkdir "$LOCK" && echo "$BRANCH $(git rev-parse HEAD) $(date -u +%FT%TZ)" > "$LOCK/owner"`.
   Held → wait (Monitor, not sleep) up to 30 min, then end `inconclusive (lock held by
   <owner>)`; an `owner` older than 2 h is stale and is taken over. The lock is held
   through step 5 and released (`rm -r "${LOCK:?}"`) on every exit path, with
   `pending_operation` cleared.
2. **Deploy** from `$WT_PATH` per `live_check.instructions`, in the foreground under a long
   timeout, dependencies built with `--force` (a cache hit ships the base's code), output to
   `$ARTIFACT_DIR/live-smoke/deploy.log`. Before deploying, record each changed deployable's
   code identity (a function's code hash, an image digest). A deploy that fails is retried once; a second failure is `inconclusive`.
3. **Prove the branch is what runs.** Each deployable the diff changes must show a new
   code identity and, when the diff adds a string literal to it, that literal in its downloaded
   code. Either proof missing → the deploy reused a stale bundle: follow the recipe's stale
   bundle fallback (or redeploy) once; still missing → `inconclusive (stale deploy)`. A diff
   that changes no function code (a route config, a workflow definition, a schema) is proven the way the
   recipe states; a recipe that states no proof for it makes the smoke `inconclusive`.
4. **Trigger and observe** per the instructions and each `$DEFERRED_LIVE` criterion's `live:`
   part — named inputs only, no data changed beyond the trigger. Read only logs and queries
   bounded by the trigger time. A step the recipe does not state is resolved from the repo's
   docs and runbooks, never guessed; one that stays unclear makes the smoke `inconclusive`.
5. **Record** `$ARTIFACT_DIR/live-smoke.md`: PR head SHA, stacks deployed, the deployed-code
   proof, then one row per check — input id, trigger, evidence excerpt (log line or query
   result), verdict. Commit it with the runstate.
6. **Verdict.** Every check passes → `result=pass`. A check fails with evidence that points
   at the changed code → `result=fail`, the evidence goes into the `bug` subtask that 3g's
   **ran-fail** answer files. Anything else — a
   dev outage, throttling, an input that turned out unusable, a failure the evidence does not
   tie to the diff — is `result=inconclusive`: the section says why, nothing is filed, the run
   stays owed, and readiness does not change. A failing smoke is reported, not fixed here:
   the fix is `$fix-task $TASK_ID`, which adopts that `bug` subtask.
7. **Say what dev now runs.** The `## Live dev run` section ends with `dev runs
   <branch>@<sha> until the next deploy of <base>`; the base's next push deploy replaces it.

**Resume.** A runstate whose `pending_operation.kind` is `live-smoke` means a session dropped
mid-smoke: release its lock if the `owner` names this branch, end the smoke `inconclusive
(session dropped)` — the `## Live dev run` section says dev may still run the branch — and
clear `pending_operation`. Never resume a half-run deploy.

### Stage 4 — Final report

1. **Decommission run processes**: `[ -f "$WT_PATH/.npm-install-full.pid" ] && kill "$(cat "$WT_PATH/.npm-install-full.pid")" 2>/dev/null`
   if the early kick is still running, plus any node process whose cwd is under
   `$WT_PATH` — never another worktree's. With `SHIP_REVIEW_BACKEND=codex`:
   `node "$SF/sf-codex.mjs" home gc --older-than 7`.
2. **Post-mortem, unconditional**: `node "$SF/sf-log.mjs" check "$RUN_LOG"` then
   `python3 "${SF_PLUGIN_ROOT}/skills/ship-report/report.py" "$RUN_LOG"` (one ledger,
   resumed runs included); post the condensed result as a PR comment (task comment
   `**[ship-task · post-mortem]**` for a no-code outcome).
   `sf-log stage postmortem pr=M`. Analyzer failure → note it, continue.
3. Print:
   ```
   === $ship-task complete ===
   Task:       <TASK_ID> — <TITLE>   (<task url>)
   Path:       express | full | epic
   Branch:     <BRANCH>          Ship mode: <SHIP_MODE>     Review backend: <claude | codex>
   PR:         <PR_URL or stack>  (base: <base>, <ready | DRAFT — unresolved findings>, <MERGEABLE | CONFLICTING | UNKNOWN>)
   Base sync:  <N> syncs, <total commits merged> merged, <conflicts> resolved   (last: <at>)
   Reviewers:  <name>=<V> …   (fix rounds: <N>, plan rounds: <N | express>)
   Follow-ups: <bundle url (N subtasks) | none>
   Audit log:  <RUN_LOG>

   Next step: review and merge the PR. Merging does NOT close the issue (the PR says
   `Refs`, not `Closes`) — flip it to `shipped` after merge, which closes it. The task is `development complete` with the
   PR linked in its comments.
   ===========================
   ```
4. **Ship the bundle** (`scope-policy.md` Rule 7). When this run filed a cleanup bundle with
   unblocked subtasks, start it now as its own run: spawn one background agent whose prompt
   is `$ship-task <bundle id>` (it cuts its own worktree from the base branch), and name it on
   the `Follow-ups:` line as `<bundle url> — shipping (agent <name>)`. Items set to `blocked`
   are listed with their blocker. Skip only when the bundle is empty or every item is
   blocked. `sf-log stage note event=bundle-launched bundle=<id> agent=<name>`.

## Run state & resume

`docs/plans/task-$TASK_ID.runstate.json` in the worktree, written with `sf-log cursor` at
every stage transition, batch integration, review-round triage, and **immediately before
any checkpoint**:
`{task, branch, stage: "1.8|2|2.5|3-implement|3-review|3-fix|3E-layer-<k>|3f|3g|done", batches_done:[{id,sha}],
pr_topology:{kind,layers:[…]}, migrations:[…], repro:{sha,test,waived}, deferred_live:[…], pending_operation:{…}, checkpoint:{reason,detail,ts},
review_round, fix_round, log_path, base_branch, push_gate_skips:[{name,skip_env}], push_gate_base_sha, push_gate_out, arms_owed, updated}`. `arms_owed` (boolean) is `true` from the commit of a push that asked the hook to skip its test arms until a final push confirms them (§CHECKPOINT_REQUIRED, 3g). `sf-log cursor` records `log_path`
(relative to the runstate's directory) whenever `$RUN_LOG` is set. `base_branch` is the
run's base, recorded JSON-quoted at the push-gate kick (§Worktree); a resume's pickup
resolve passes the runstate, so it keeps that base even after the workspace's
`.sf-developer` `target=` changes.
**Every commit of the runstate also stages the ledger** —
`case "$RUN_LOG" in "$WT_PATH"/docs/plans/*.jsonl) git add -f -- "$RUN_LOG";; *) echo "WARN: ledger $RUN_LOG not staged" >&2;; esac`
(`-f`: a repo may gitignore its ledgers; the `case` guard stages nothing outside the
worktree's `docs/plans/`) — so the ledger a resume appends to is on the branch. Only commits
made in the worktree that holds `$RUN_LOG` stage it — `$WT_PATH`, which is
`$INTEGRATION_WT` on an epic; a phase worktree (`$PHASE_WT`) never stages its copy of the
ledger, which would put it in the phase's cherry-pick range.
**Bookkeeping never dirties a tree.** The ledger and runstate change after every commit (a
checkpoint logs after it commits the cursor), and an adopt appends to exactly those files,
so every dirty probe — Stage 0's clean launch tree, the 1B reuse probe, the `epic.md`
reuse guard, phase-contract pickup — excludes them:
`git status --short -- ':/' ':(top,exclude)docs/plans/*.jsonl' ':(top,exclude)docs/plans/*.runstate.json'`.
A checkpoint commits the runstate + ledger + artifacts on `$BRANCH` (`chore: checkpoint ship task
<id>`) and pushes with
`node "$SF/sf-push.mjs" --kind checkpoint --cwd "$WT_PATH" --branch "$BRANCH" --base "$BASE_BRANCH" --runstate "$RUNSTATE"`
(`--arms` and the `arms_owed` write per §CHECKPOINT_REQUIRED),
run and judged like the 3g call; `verified: false`, an `error` or no JSON → report
`CHECKPOINT_PERSIST_FAILED` and never claim resumability. Resume: a committed `checkpoint` overrides the 2-hour freshness probe;
`batches_done` shas that are ancestors of `HEAD` are skipped; a resume inside a parallel
batch removes the leftover scratch worktrees and branches (`scratch-worktree.md` §Clean up)
and skips each task whose `[task <id>]` commit is already an ancestor of `HEAD`; a mid-review or mid-fix
resume re-runs the current round **cold** (warm continuation does not survive a
session); the adopting session runs `sf-log init --resume "$RUNSTATE"` (§Worktree) and
appends to the runstate's `log_path` — one ledger per run, its `run-meta resumed:true` mark
followed by `resume-adopted`, and the first action after it is the §Integration sync block with `AT=resume` (on
`$BRANCH` for an epic — a paused run is behind by however long it slept). A session that
drops and comes back through `claude --resume` / `--continue` — same context, no adopt — is
marked on the ledger by the plugin's `SessionStart` hook (`session-resumed`,
`spawn-accounting.md` §Session marks); nothing to do, but never delete a runstate before
`done` — it is how the hook finds the log.

## CHECKPOINT_REQUIRED

Write the cursor, set the status, post the comment (§Status lifecycle), `PushNotification`
(`ship-task <id> stopped: <reason> — needs your input`), then print and log:

```
=== CHECKPOINT_REQUIRED ===
stage: <stage>   reason: <slug>   detail: <one line>
task: <TASK_ID>  artifact: <path | n/a>
test arms: not run on <from>..<to> — the final push runs them
resume: <how to resume>
===========================
```
`sf-log checkpoint reason=<slug> at=<stage> detail=… artifact=…`.
The checkpoint push is `node "$SF/sf-push.mjs" --kind checkpoint …` (§Run state & resume),
which applies `push-env`'s approved skips itself and verifies the remote tip; a finished
push-gate baseline's open question is asked and recorded before it
(`shared/run-preflight.md` §Push-gate baseline).

**`--arms skip` — only when a final push will follow.** `--arms skip` on a
`--kind checkpoint|layer` call sets the pre-push hook's `SF_HOOK_RUN_CHECKPOINT=1`: the
hook skips its unit and browser-environment (jsdom) test arms and still runs every type-check, the
security suites, the lint ratchet and the database gate. It is safe only because the
run's last push is `sf-push --kind final` with a push, which sends `SF_HOOK_RANGE_BASE`
so the hook judges every commit of the run once. Pass it on exactly two pushes: an
integrated-mode layer push (2.7), and a checkpoint push when the committed runstate
records a `pr_topology.kind` that is not `stack` and the entering skill is `ship-task` or
`review-task-code`. A runstate with no `pr_topology` yet (a checkpoint before the plan
picks one), a stack run (its last push is the stack submit) and `implement-task` (it
never reaches 3g) pass `--arms run`, the default. Nothing else sets either variable.

**`arms_owed` — the skip is recorded on the branch.** Before each `--arms skip` call,
note the runstate's current `arms_owed`, then `sf-log cursor "$RUNSTATE" arms_owed=true`
and include that write in the commit being pushed. After the call: `test_arms: ran` and
the noted value was not `true` → `sf-log cursor "$RUNSTATE" arms_owed=false` (this hook
skipped nothing, and no earlier push did); every other result — `skipped-checkpoint`,
`unconfirmed`, `no-ref-pushed`, an `error` — leaves it `true`. Only 3g's final push
clears a `true` that an earlier push set. `sf-push` never reads or writes the key.
After every `sf-push` call log
`sf-log stage note event=push kind=<kind> test_arms=<value> pushed_sha=<sha>`.
The `test arms:` line is printed whenever the run's last push reported
`test_arms: skipped-checkpoint`; `<from>..<to>` is the range the hook's banner names in
that push's `push.log`. A run that ends at a checkpoint has not run the test arms on the
pushed commits, and its report says so in those words.

| Reason | Stage | When |
|---|---|---|
| `preflight-failed` | 0 | missing `sf-*` plugin or damaged worktree |
| `prd-schema-incomplete` | 0 | PRD missing a required section |
| `cut-task-failed` | 1 | `tracker` create/view failed, no `## Branch`, worktree script failed |
| `base-branch-missing` | 1A / 1B | a base resolve stopped (§Worktree, or an epic resume): the recorded base (runstate `base_branch` or the epic's `base:` line), the task's `## Base branch`, an exported override or `.sf-developer` `target=` is not on origin, or a value or the file is invalid. `resume:` a recorded base outranks every setting, so re-push it from its merge commit or edit `base_branch` in the committed runstate; otherwise push the branch or correct the setting. Then `git fetch origin` and re-run |
| `worktree-dirty` | 1B, 1.8 | reused worktree has uncommitted changes; a repro seat left stray files, changed the runstate, or its drop failed; or a `[repro]` commit has no record. 1.8 `resume:` drop the unrecorded `[repro]` commit with `git reset --keep <parent>`, or record it after verifying it, then re-run |
| `epic-prd-mismatch` | 1A | recorded `prd-sha` differs from the file |
| `not-reproduced` | 1.8 | no real-environment reproduction; diagnosis artifact attached |
| `plan-review-exhausted` | 2 | 5 rounds with CRITICAL/HIGH open, the post-exchange premise re-review (After the loop) out of rounds or still CRITICAL/HIGH, or criteria files unreadable |
| `architecture-reframe` / `destructive-migration` / `database-trigger` / `new-dependency` / `open-questions` | 2 | the plan scan (above) |
| `ambiguous-fix-required` | 3c / 3e | explorer blocker, or a CRITICAL/HIGH finding needs a human decision |
| `empty-implementation` / `implementer-failed` / `parallel-integration-conflict` / `stack-scope-violation` | 3c | as named |
| `stacked-prs-unavailable` / `late-migration-after-dependent-merge` / `stack-modification-blocked` | 3 | stack mechanics (`epic.md` §Pull-request topology) |
| `unresolved-review-findings` | 3e | the extension rules refused a round, or the ceiling was reached — **informational**, PR opens as draft, `remediating` |
| `integration-conflict` | 1b / 3d / 3e / 3f / 3g / layer / resume | a base merge conflicts in a file this run never touched, or the two sides are different product decisions (`shared/integration-sync.md` §Conflict rule) |
| `build-failed` | 3c / 3f | the gate command's `next = build-failed`: a genuine compile error after resilience retries, or any `drift` or `lint` failure on the `--relaunch yes` run after the one fixer pass; a second consecutive genuine smoke failure (3c step 4) |
| `ac-unverifiable` / `ac-failed` | 3f.5 | as named |
| epic reasons (`epic-decomposition-invalid`, `epic-integration-conflict`, `epic-layer-build-failed`, `epic-all-phases-failed`, `resource-budget-reached`) | 2.7 / 3E | per `epic.md` |

## Safety rules

1. **Never merge; never let an unclean run produce a mergeable PR.** Drafts until clean.
   And never push a PR head that does not merge clean into the base: the branch syncs at
   every boundary in `shared/integration-sync.md` (pickup, 3d, each 3e round, 3f, the 3g
   probe, each epic layer, resume) — a one-phase run and a six-layer epic alike.
2. **Fail loud on checkpoints.** The Stage 2 hard stops are the human-judgment gates.
3. **One tracker per run.** Every task write goes through `tracker` — never a raw `gh issue`
   call or a second tracker. PRs are the repo (`gh pr`, `sf-push`).
4. **Never set `shipped`, never delete a task.** Terminal writes are `development
   complete` / `remediating` / `blocked`; statuses move only along §Status lifecycle.
5. **Comments are signed; body edits are read-modify-write.**
6. **Preserve the audit log. One task per invocation. Clean launch tree.**
7. **Implementer, fixer, and reviewer are separate spawns; reviewers are read-only**
   (probes are `PROBE-SUGGESTED`, orchestrator-run, serial).
8. **Reads parallel, writes serial** unless the 3b gate proves isolation; the fixer is
   always a single writer — one fixer at a time per worktree; an addendum fixer starts only
   after the first has returned.
9. **Topology is binding; migrations land first** as their own lower layer.
10. **Fix actionable in-scope defects.** Optional LOW cleanup obeys the run-wide budget;
    it never starts another cycle. File eligible follow-ups at the filing floor.
11. **Classification is computed.** Express eligibility, the seam list, the reviewer
    roster, and the cold-pass mode come from `sf-route`, never from reading the task.
12. **The runtime never changes provider silently.** Native Codex retries/resumes GPT
    roles or reports the missing capability; it never requires Claude. Hybrid keeps
    `review-backend.md`'s logged Claude fallback and security/UX pins. Failed required
    preflight stops the run before dependent work.

## Cost note

Implementation is a minority of a run's sub-agent tokens (the fixer can be the largest
single writer, and an epic's worst case is `SHIP_FIX_ROUND_CEILING` rounds per
phase); the plan loop and review are the
rest, which is what the express path, warm continuation, routing gates, and the
zero-floor cold pass target. Numbers and incidents: `rationale.md`.
