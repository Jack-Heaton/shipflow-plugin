# Spawn accounting (shared reference)

Native Codex uses `agent_type=codex-native backend=codex-native`; the orchestrator
logs each native spawn/continuation once with the actual model/effort and native handle.
Unavailable token usage is null, never zero or an estimate. Only headless `sf-codex`
seats self-log. `sf-log init --host codex` (or `SF_HOST=codex`) reads `codex --version`,
not the Claude CLI; `host_version` is provider-neutral and `cc_version` remains a
legacy Claude-only field. See `runtime.md` for continuation and resume semantics.

> Canonical rule for turning the ship-* audit logs into a **cost ledger**, read back by
> `/ship-report`. The goal: attribute tokens and wall-clock to each sub-agent **role**
> so a run can be post-gamed and the model/effort tiers (`model-tiering.md`) tuned
> against real data instead of intuition.

## The rule

**Every audit event is written by `sf-log`** (`${CLAUDE_PLUGIN_ROOT}/scripts/sf-log.mjs`) —
never by `jq`, `printf`, or a heredoc. It validates the stage name against the canonical
enum, serializes with `JSON.stringify`, stamps `ts`, and appends one line to `$RUN_LOG`.
Set up once per run:

```bash
SF="${CLAUDE_PLUGIN_ROOT}/scripts"
export RUN_LOG=$(node "$SF/sf-log.mjs" init --skill <skill> --task <id>)   # writes run-meta, prints the absolute path
export SF_RUN_TASK=<id>            # or SF_RUN_ISSUE=<n> on GitHub-tracked runs
```

**After every `Agent` spawn returns**, one call:

```bash
MODEL=$(grep -m1 '^model:' "${CLAUDE_PLUGIN_ROOT}"/../*/agents/security-reviewer.md | awk '{print $2}')   # read, not recalled; "inherit" → session
node "$SF/sf-log.mjs" spawn role=reviewer:security agent_type=security-reviewer model="${MODEL/inherit/session}" \
  phase=review round=1 tokens=120345 duration_ms=203118 agent_id=<id> \
  artifact="$ARTIFACT_DIR/review-security-r1.md" started="$T0"
```

where `T0=$(date +%s%3N)` was captured in the same block **before** issuing the spawn
(`wall_ms` = now − `started`; it is the field that survives a dead usage channel).
For a parallel batch, capture one `T0` and emit one event per returned result.

## Fields

| Field | Meaning |
|---|---|
| `role` | the pipeline role, not the agent type: `plan-drafter`, `plan-reviewer`, `plan-drafter-fixer`, `explore`, `implementer`, `fixer`, `mopup-fixer`, `direction-reviewer`, `reviewer:security`, `reviewer:architecture`, `reviewer:performance`, `reviewer:<domain-agent>`, `holistic`. This is the axis `/ship-report` aggregates on — keep it stable. **Enforced at write:** `sf-log spawn` refuses (exit 2, nothing written) a role that does not start with one of those prefixes (a bare `security-reviewer` must be `reviewer:security-reviewer`), a bare `reviewer:`, and any `implementer…` role at `phase=fix` — a fixer logs `role=fixer`; a scope-expansion implementer logs `phase=implement`. |
| `agent_type` | the literal `subagent_type` (`sf-implementer`, `Explore`, `general-purpose`, `security-reviewer`, …) — lets the report confirm a named-agent promotion took. Codex seats: `codex-exec`, or `codex-app-server` for an app-server writer seat — the transport that actually ran. |
| `model` | the model the spawn **actually** ran at — for a named agent, the `model:` line of its frontmatter **read at log time** (`grep -m1 '^model:' <agent file>`; `session` when it says `inherit`), or the per-call override if one was passed. Never the tier a table says the role "normally" runs at — a stale table value makes the report wrong. Codex seats: the literal model id (below). |
| `model_served`, `effort_served` | Claude seats, written by `sf-log spawn` when `agent_id=` resolves to a Claude Code transcript (`<config dir>/projects/*/*/subagents/agent-<agent_id>.jsonl`; `SF_CLAUDE_PROJECTS_DIR` overrides the root): the model id that first served the seat and the effort it ran at, from the transcript's first assistant row. Omitted when no transcript is found, never inferred; values passed by the caller are dropped. A row logged as `session` or `inherit` names no family and is never compared. `model` stays the alias or frontmatter value that was requested; `sf-log check` lists a Claude row whose alias a different model family served under `spawns_model_mismatch`, and `/ship-report` prefers the served identity. |
| `tier` | Codex seats only: the seat tier that resolved (`frontier`, `standard`, `standard-light`, `explicit`, or a `SF_CODEX_TIERS` name) — `review-backend.md` §Seat tiers. |
| `effort` | Codex seats only: the reasoning effort the seat ran at (`low` … `ultra`). |
| `commits`, `plan_gaps_semantic`, `plan_gaps_cosmetic`, `blockers`, `scope_violations` | Codex writer seats (`implementer`, `fixer`, `mopup-fixer`): from the verified report — `commits` is `git log <baseline>..HEAD`, never the model's count. The orchestrator sums `plan_gaps_semantic` onto the `batch-implement` event (for Claude implementers, from the report's "Decisions the plan did not specify" section). `plan_gaps_semantic` is also put on Claude **fixer** spawn rows, counted by the orchestrator from the fixer report's "Decisions the findings did not specify" section (`ship-task` 3e step 3.5) — it is what `closures_without_adjudication` reads. `plan_gaps_cosmetic` is **omitted from 0.33.0**: cosmetic choices live in commit messages, not reports (a Codex result line may still carry it; the orchestrator does not copy it). |
| `transport` | Codex writer seats: the transport the seat ran on — `exec` or `app-server` (`review-backend.md` §Hybrid mode). Reviewer lines carry `exec`. |
| `outcome` | Codex app-server writer seats: `ok` (finished, no steer), `wrapped-up` (finished on its own after the wrap-up steer), `interrupted-reported` (interrupted, then delivered a report), or `failed`. The result line's `status` is this value. |
| `compactions` | Codex app-server writer seats: the `thread/compacted` count for the seat. `>1` sets `oversized=true`, the signal that the batch was larger than the seat could hold — the orchestrator splits the next batch. |
| `idle_max_ms` | Codex app-server writer seats: the longest gap between `item/completed` events in the work turn, in ms — how close the seat came to the idle interrupt. |
| `steer_sent`, `interrupt_sent` | Codex app-server writer seats: whether the wrap-up steer and the wall-or-idle interrupt fired (`review-backend.md` §Hybrid mode lifecycle). |
| `conflicts_with_plan` | Older ledgers only: the tripwire count from the retired Codex explore seat. Explore now always runs as the built-in Claude agent and logs no such field. |
| `range` | Codex review seats: the exact `<base>..<sha>` the seat judged, from `--range`. Ends at a captured commit, never `HEAD` (`reviewer-prompts.md` `{diff_range}`) — the ledger names the commit each finding was made against. |
| `attempts` | Codex seats: `codex exec` launches for a reviewer seat, or app-server turns (the work turn plus any report or schema-re-ask turn) for an app-server writer — 1 normally; 2 after a rate-limit retry or a schema re-ask. A retried seat re-reads its context, so its `tokens_cached` is roughly doubled; read `tokens_*` per attempt when comparing seats. |
| `phase` | on a spawn row, one of `plan`, `implement`, `review`, `fix`; epic membership travels in `epic_phase=` (below), never here — a spawn's `phase` stays `review` in an epic run so cold-fallback detection still fires. (The `fix-round-extension` event still uses `phase=<epic-phase:<id> \| single>`.) |
| `round` | plan round or fix round, omitted when N/A. |
| `escalated` | `true` on an escalation retry. |
| `addendum` | an addendum fixer spawn of a round, at the same `round`, run before the round's closures: `true` for a pinned seat's late findings (`warm-closure.md` §Late seats), `redirect` for the redirect-addendum that fixes an adjudication's redirected decisions (`ship-task` 3e step 3.5). The per-round writer ordering (first fixer → late-seat addendum → redirect addendum, one at a time) and the no-chaining rule are stated once in `ship-task` 3e step 3.5. |
| `direction` | fixer spawns: `true` on Codex rows, the fix-direction path on Claude rows when the round was gated; `false`/absent when the fixer ran ungated. Read by `sf-log check`'s `fixers_without_direction_review` together with `merged_items` (`ship-task` 3e step 2b). |
| `merged_items` | direction-reviewer and fixer spawns: the count of direction items merging more than one finding id. |
| `merged_high` | direction-reviewer and fixer spawns (0.33.0): among the merged items, how many merge at least one CRITICAL/HIGH — the direction-review trigger (`≥ 1`). A gated fixer whose namespaced round has no direction-reviewer spawn is flagged; `merged_high=0` is ungated and never flagged (a row without the field falls back to `merged_items=0` as the only exemption). |
| `deferred` | `adjudication` rows (0.33.0): semantic gaps whose decision added behaviour the plan does not contain — commit reverted, item filed or routed as a scope expansion. `/ship-report` reads `accepted / (accepted+redirected+deferred)`; a run at 100% accepted is adjudication not doing work. |
| `epic_phase` | every 3e event written inside an epic phase worktree (direction-reviewer spawn, fixer spawn, `adjudication`, `closure-exchange`, `oscillation-stop`) carries `epic_phase=<phase id>`; single-task runs omit it. It namespaces `round` in `sf-log check`'s round-scoped detections so phases that reuse round numbers do not collide. Codex seats via `--epic-phase`. |
| `in_flight`, `serial_reason` | `epic-layer` events: `in_flight` is the largest number of the layer's phases in flight at once (an integer ≥ 1; `ship-task` Stage 2.7 caps it at 3), required when `mode=integrated`; a stack-mode row (no `mode=`, from an epic stack) may omit both fields. `in_flight=1` requires `serial_reason`, one of `single-phase`, `no-scratch-worktrees` (inline mode), `force-serial` (`EPIC_FORCE_SERIAL`), `resumed` (a resumed layer with one phase left), `not-fanned-out` (two or more phases were runnable, none of the other causes held, and they still ran one at a time — a missed fan-out, never a choice); `serial_reason` with any other `in_flight` is refused. Validated at write (exit 2, nothing appended). |
| `findings` | fixer spawns: the item ids in the fixer's bucket as a JSON array (`findings='["U3","U4"]'`) — the DEDUPE'd item ids (`warm-closure.md` §3). Required on any fixer spawn in a round that follows an `oscillation-stop`, so `fixers_on_stopped_findings` can catch a stopped id that re-entered. Codex fixer seats pass it via `sf-codex fix --finding-ids '[…]'`. A present value is validated at write as a JSON array of non-empty strings (a scalar is refused, exit 2); a fixer spawn without the field is not inspected, and a row from a ledger before 0.31.0 that carries a scalar is recorded under `malformed_fields` and not inspected. |
| `reopened_ids` | `closure-exchange` rows: the item ids reopened this round as a JSON array, each `item ?? id` (`warm-closure.md` §3). Codex closure seats write it; the Claude orchestrator fills it from its closure table. Validated at write the same way (0.31.0); read by `reopened_twice_without_stop`, and a scalar on a pre-0.31.0 row lands in `malformed_fields`. |
| `tokens`, `duration_ms` | from the spawn result's usage block (`<usage>subagent_tokens: … duration_ms: …</usage>`). **Omit when the result carries none** (teammate / in-process and background-completion paths may surface only an idle notification) — `sf-log` writes `null`; never fabricate. After two consecutive usage-less results, stop expecting usage for the run, **switch to per-seat `T0`** (capture one `started=` per spawn, not one per batch — with the usage channel dead, `wall_ms` is the only per-seat measurement left and a batch envelope makes every seat in the batch read the same), and say so once in the final report. `sf-log check` reports `usage_channel_dead=true` when three or more Claude spawns all carry `tokens=null` (four of the ten most recent ledgers, on CC 2.1.273–2.1.277, were in this state and their cost was unmeasurable). A Claude spawn or continuation row with no `tokens` also carries `usage_missing: true`; `/ship-report` renders such a role's tokens as `missing` (all turns) or `≥<n>` (some), never 0. On a Claude `closure-exchange` / `clarify` row the stored `tokens` / `duration_ms` are that turn's own usage: `sf-log` subtracts the same `agent_id`'s latest earlier value of that field and keeps the reported figure in `tokens_cumulative` / `duration_ms_cumulative` with `usage_basis: "delta"`; a value below the earlier one, a first value (no baseline), and every later turn of a field that once went below its baseline are stored raw with `usage_basis: "per-turn"` (§Continuations). Codex rows are per-turn and untouched. |
| `wall_ms` | orchestrator-measured, always present via `started=` — **enforced: `sf-log spawn` refuses the event without `started=` or `wall_ms=`** (`--late` records `wall_ms: null, late: true` for an adopted run whose start time is genuinely gone — never fabricate one). For parallel batches, capture ONE `T0` before the message and pass it on every seat; it measures the batch envelope per spawn — report it as wall-clock, never as cost. Without it a seat's wall/cost is unmeasurable and `/ship-report` renders it as `?`, not `0s`. **`started=` is captured in the Bash call that precedes the spawn message, never in the call that logs it** — a `T0` taken at log time yields a sub-second `wall_ms`. `sf-log spawn` warns on a sub-second Claude wall and `sf-log check` lists those rows under `spawns_wall_implausible`. **Log a seat the moment its result returns**: a seat logged hours after it finished carries the orchestrator's wait as its wall (`ship-task-1789694529` recorded a 9-minute Explore at 9.8 h); `sf-log check` lists a wall over 4× and 30 min past the seat's own `duration_ms` under `spawns_wall_orphaned`, and `/ship-report` attributes by `duration_ms` when present. |
| `agent_id` | the raw id from the spawn result. **Required on reviewer and plan-role spawns** — the only durable address for warm continuation (`SendMessage` name resolution is latest-wins; a later cold spawn of the same type steals the name). |
| `artifact` | the file the spawn was told to write — the delivery proof (`reviewer-prompts.md` §Artifact handoff). |
| `backend` | `claude` or `codex` (`review-backend.md`). Present on every reviewer / plan-reviewer spawn of a codex-backed run so a mixed panel segments cleanly; absent means `claude`. |
| `commands_run`, `commands_ok` | Codex seats only: shell commands the seat executed and how many exited 0. A delivered seat always has `commands_ok ≥ 1`; `0` is a blind seat and is logged as `note event=codex-seat-blind`, never as a spawn with a verdict (`review-backend.md` §Runtime). |
| `tokens_in`, `tokens_cached`, `tokens_out`, `tokens_reasoning` | Codex seats only. Reviewer and `exec` seats: from `codex exec --json`'s `turn.completed.usage`, summed over every model call the seat made (a retry turn included). App-server writers: the last `thread/tokenUsage/updated.total`, which is cumulative for the thread, so it is read as the seat's total rather than summed. `tokens` = `tokens_in` + `tokens_out` so per-role totals stay comparable with Claude seats; `tokens_cached` is what the warm-closure economics are read from. |

**Codex seats.** On their `spawn` events: `agent_type=codex-exec`, `model=<the literal
model id, e.g. gpt-6.1-sol>` (not an alias — the id that ran, per seat tier),
`tier=<seat tier>`, `effort=<reasoning effort>`, `agent_id=<the codex thread_id>`,
`duration_ms` = the seat's wall time (codex reports no separate duration). Warm
`closure-exchange` / `clarify` events carry `backend=codex`, `agent_id` and the token
fields but no `agent_type` / `model` — the thread's model is on its cold `spawn` event.
`sf-codex review` writes every one of these itself when `RUN_LOG` is exported (a failed
seat writes a `note event=codex-seat-failed` instead — as of 0.29.0 that note carries
`wall_ms`, `commands_run/ok` and, when codex's stdout never delivered `turn.completed`
(timeout, crash), the seat's usage recovered from its rollout file: `tokens`, `tokens_*`
and `usage_source=rollout`; `/ship-report` counts it as a cost-bearing turn; a failed
app-server writer's note additionally carries `transport=`, `crashed=` and
`compactions=`) — the orchestrator never logs a Codex seat. **Enforced as of 0.28.0:** `sf-log spawn` refuses a second row whose
`agent_id` and `artifact` match an earlier spawn row (warns, writes nothing, exits 0), and
`sf-log check` / `/ship-report` list any that reached a ledger by another path. The shape
this closes: `ship-task-1788747694` re-logged four Codex implementer seats' own rows to add
`epic_phase=`, doubling each seat's tokens and wall in every aggregate. Add a field to a
seat's row by passing it to `sf-codex`, or record it with `sf-log stage note`.

## Session marks (wall-clock attribution)

`/ship-report` splits a run's wall-clock into **seats busy** (the union of every timed
seat/continuation interval), **operator waits**, **session gaps**, and the remainder,
**orchestrator/unattributed**. An operator wait starts at a `checkpoint`, an `operator-wait`
event, or the legacy `note event=operator-pause`. A checkpoint or operator-pause wait ends at
the next event. An `operator-wait` (logged before every operator question — ship-task
§Interview policy) ends at `note event=operator-answered`, else at the next
orchestrator-authored event: a `backend=codex` row, a `note event=codex-seat-*` and a
`session-resumed` mark never end it, because a detached seat or a resumed session can land
while the operator is still away. Seat time that overlaps a wait is subtracted from it, and
the report counts the `operator-wait` marks next to the figure. A session gap is the interval before a `session-resumed`
event — written by the plugin's `SessionStart(resume)` hook (`hooks/session-resumed.py`)
onto the ledger of every live run that session owns (a runstate not `done`, touched within
48 h, whose `session_id` — stamped by `sf-log cursor` — is the resuming session's) when the
orchestrating session comes back through `claude --resume` / `--continue`. Without the
mark, a dropped session and an orchestrator that thought for an hour are the same silent
gap; with it, the orchestrator/unattributed segment is the one to read for serial
bottlenecks (triage, fix direction, closure reads). The hook needs the plugin loaded in the
resumed session; `SF_SESSION_MARK=off` disables it.

## Continuations (warm exchanges)

A `SendMessage` continuation spawns nothing, so it gets its own event:
`sf-log stage closure-exchange role=reviewer:<role>:closure round=N path=<warm|cold-fallback> findings_closed=… findings_reopened=… findings_decline_accepted=… findings_not_mine=… agent_id=<id> artifact=… tokens=… started=…`
(`closure-exchange` / `clarify` / `pairing-check` carry the same `started=`/`wall_ms=` requirement as `spawn` — sf-log computes `wall_ms` from `started=` and refuses the event without either; `--late` is the same escape)
(**`agent_id=<id>` is required on a Claude continuation that carries `tokens=` or `duration_ms=`** — a continued agent's usage has been observed to arrive cumulative, so `sf-log` stores the delta against that agent's earlier rows and refuses the row without the id; see the `tokens` field above)
(`clarify` for pre-fix clarification; plan-loop continuations use roles
`plan-drafter:fix` / `plan-reviewer:rereview`). `path` is what decides whether warm
continuation is paying for itself — `/ship-report` computes the warm-hit rate from it.

## Run metadata

`init` writes `{"stage":"run-meta","cc_version":…,"skill":…,"task"|"issue":…,"ts":…}`.
Alias→model resolution is a function of the Claude Code version (`opus` resolved to
Opus 4.8 before CC v2.1.219 and to Opus 5 from it), so cross-run
comparisons bucket by the resolved model this implies and never average across an alias
flip (`model-tiering.md` §Confound warnings).

## Before the post-mortem

`node "$SF/sf-log.mjs" check "$RUN_LOG"` — reports invalid lines, unknown stages, spawns
missing `wall_ms` (only `--late` rows can be), `spawns_wall_implausible` /
`continuations_wall_implausible` (sub-second Claude walls — `started=` taken at log time;
the row's wall is not a measurement and `/ship-report` skips it),
`triage_verdicts_without_prior_spawn`, `fixers_without_direction_review` (a gated
fixer whose round has no earlier `direction-reviewer` spawn), and
`closures_without_adjudication` (a closure seat that ran while its round still had
unadjudicated or unredirected semantic gaps — `ship-task` 3e step 3.5; a fixer row whose
`plan_gaps_semantic` is absent or non-numeric gates its round as `unknown`), and the
oscillation-stop guards (`warm-closure.md` §3): `fixers_on_stopped_findings` (a fixer
carried a stopped id that had no design note, or a second design note),
`oscillation_stops_repeated` (a second `oscillation-stop` for one id), and
`reopened_twice_without_stop` (an id reopened in two rounds that a fixer ran on with no
stop). Rows from ledgers before 0.31.0 predate these gates and are expected in those
buckets — pre-0.31.0 ledgers carry no `reopened_ids`, so `reopened_twice_without_stop`
stays empty for them.
`plan_explores_after_drafter` (`{flagged, explores, drafter_end}`) is flagged when a
planned run's plan-phase Explores (`role=explore phase=plan`) all started — `ts − wall_ms` —
at or after the first `plan-drafter` spawn ended (the earlier of its `ts` and
`ts − wall_ms + duration_ms`; an Explore row with an implausible wall decides nothing), so no report could inform the draft
(`ship-task` Stage 2 §Plan-phase Explores); it is warn-level and never changes `ok`.
`intervals` (`{last_seat_to_pr_ms, implementer_to_first_reviewer_ms}`, each an integer or
`null`) reports the run's two serial gaps: the first `implement-issue` row's `ts` minus the
latest `ts` among the `spawn` / `closure-exchange` / `clarify` / `pairing-check` rows before it, and the
earliest `reviewer:*` start at `phase=review` (`ts − wall_ms`, plausible walls only) minus
the latest `ts` among `implementer*` rows at `phase=implement` that ended at or before it
(an epic run reports its first panel only); a missing row gives `null`, and the key is
warn-level.
A reviewer verdict in a `triage` event with no earlier `spawn`/continuation event for that
role means the spawn was logged late (after the triage that consumed it) or never — log
each spawn **the moment its result returns**, never batched after triage. Fix the log
before running `report.py` over it.

## Scope & honesty

- The ledger attributes **sub-agent** cost only. The orchestrator's own main-loop tokens
  are not in it — `/usage` is the grand total.
- One event per spawn, right after it returns. A run with all-`null` tokens is still
  useful (timing + workflow), just not for cost.

## Why it is a script

Across 54 ship-task logs the orchestrator improvised ~120 distinct stage names and spawn
accounting was present in only 29; on one run's ledger 7 of 44 spawn events were
invalid JSON — the round-1 reviewer batch, the run's most expensive phase — because the
line was assembled by `printf`. The analyzer tolerates malformed lines by design, which
is what let that survive unnoticed. A validating writer is the fix; a paragraph asking
for care was not.
