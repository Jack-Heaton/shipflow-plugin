---
name: ship-report
description: "Post-game a $ship-task or $fix-task run from its audit log: attribute tokens + wall-clock to each sub-agent role (implementer, fixer, reviewers, plan loop, explore), surface cycle hotspots (plan/fix rounds, escalations, checkpoints), and recommend model/effort-tier tuning. Reads docs/plans/ship-task-*.jsonl and fix-task-*.jsonl (no OTel needed \u2014 the ship-* skills log per-spawn usage per ../../references/shared/spawn-accounting.md). Usage: $ship-report [<log-file> | <dir> | latest]"
---

> Codex compatibility: this file is generated from the Claude skill source.
> For worker dispatch, read `../../references/shared/runtime.md` and resolve each role with
> `node ../../scripts/sf-runtime.mjs resolve --host codex --role <role>`; use the returned
> GPT model and effort with Codex collaboration tools. Claude model metadata describes the
> Claude backend only. Set `SF_PLUGIN_ROOT` to this plugin's absolute root before running
> shell examples, and resolve `../` references relative to this SKILL.md. Preserve every
> confirmation gate and destructive-operation guard.

# $ship-report — Post-game a ship-* run and find where to improve

Turns a `$ship-task` or `$fix-task` audit log into a cost + cycle post-mortem so
the model/effort tiers in `../../references/shared/model-tiering.md` can be tuned against
real data. It answers: **where did the tokens go, where did cycles thrash, and
what should I change next.**

**Usage:**
- `$ship-report` — the newest `ship-*.jsonl` in `./docs/plans/`
- `$ship-report <path.jsonl>` — one specific run
- `$ship-report <dir>` — aggregate every `ship-*.jsonl` in a directory (the
  "few weeks of runs" trend the measurement section calls for)
- `$ship-report latest [<dir>]` — newest log in `<dir>`

`$ARGUMENTS` is an optional path/dir; empty ⇒ newest log in `./docs/plans/`.

## What it reads

The ship-* skills record two kinds of audit events (see
`../../references/shared/spawn-accounting.md`):
- **Stage events** (`plan-issue`, `implement-issue`, `batch-implement`,
  `epic-*`, checkpoints) — workflow shape: rounds, verdicts, escalations, halts.
- **`spawn` events** — one per `Agent` spawn, carrying `role`, `model`, `tokens`,
  and `duration_ms` pulled from the harness usage block, plus orchestrator-measured
  `wall_ms` (used when the usage block is absent). This is the cost ledger.
- **`closure-exchange` / `clarify` events** — one per warm-closure `SendMessage`
  continuation (`warm-closure.md`; plan-loop continuations use roles
  `plan-drafter:fix` / `plan-reviewer:rereview`); counted into the cost ledger under
  their namespaced roles and summarized as a warm-hit rate. `pairing-check` events
  appear only in legacy logs (from before the pairing sub-protocol was retired).
- **`triage` events** — one per fix round **plus a closing event after the loop
  settles** (`rereview_mode: "none"`, recording what the final re-review surfaced,
  zeros included). Each carries the four bucket counts, the reviewer verdicts, and
  `rereview_mode` (`warm` | `warm+cold-panel` | `cold-fallback` | `none`; legacy
  logs use `full` | `scoped`). These drive the **fix-round yield**
  table: what did round 2 find that round 1 did not? Note the offset: a round's
  `rereview_mode` names the re-review run *after* that round's fixes, whose yield
  appears as the *next* event's fix-now count — the closing event exists precisely
  so a final re-review that found nothing is a logged fact, not an inference.
- **`express-classification` / `express-abandoned`** — whether Stage 1.9 took the
  express path, and whether the run had to abandon it mid-flight.

A log written **before** spawn-accounting shipped (no `spawn` events) still
reports — workflow-only, with a `[no spawn events…]` note and no cost columns.
Likewise a log predating per-round triage logging reports without the yield table.

> **The yield table is the point of the `triage` events.** A run that logs round 1
> and omits round 2 has measured nothing about its own fix loop — the analyzer says
> so explicitly rather than rendering a misleadingly tidy single row. If you see
> that note, fix the logging before tuning the round cap.

> **Scope caveat, state it in the summary:** the ledger attributes **sub-agent**
> tokens only. The orchestrator's own main-loop tokens are not in it — pair the
> report with `/usage` (session total) for the grand total.

## Procedure

1. **Resolve the target** from `$ARGUMENTS` (file, dir, `latest`, or empty →
   `./docs/plans/`). Do not fabricate a path — if nothing resolves, tell the user
   where logs live and stop.

2. **Run the analyzer** (deterministic; do not hand-compute token sums):
   ```bash
   python3 "${SF_PLUGIN_ROOT}/skills/ship-report/report.py" <target>
   ```
   For a machine-readable pass (e.g. to reason over the numbers yourself), add
   `--json` before the target. Prefer the text output for the user.

   The `wall segments` line splits wall-clock into seats busy / operator waits /
   session gaps / orchestrator-unattributed (`spawn-accounting.md` §Session marks).
   Only the last segment is the orchestrator's own serial time — and only on a
   ledger with the 0.28.0 marks; on an older ledger it also holds every unmarked
   session drop, so say so before reading it as a bottleneck. Duplicate spawn rows
   (same `agent_id` + `artifact`) are dropped before aggregation and counted. A
   `codex-seat-failed` note with recovered usage (0.29.0) is a turn in the cost table,
   marked `✗N failed seat(s) counted`; one without tokens makes the table a lower bound.

3. **Relay the analyzer output verbatim** (it is already formatted — the cost-by-role
   table, checkpoints, cross-run aggregate, and the deterministic tuning signals).
   Do **not** rewrite its numbers.

4. **Add a short interpretation** below the raw output — 3–6 sentences, grounded in
   `../../references/shared/model-tiering.md` §Measurement and the
   effort-cap guidance. Turn the analyzer's `tuning signals` into concrete next
   actions, e.g.:
   - A role dominating tokens with **no** escalations and **passing** reviews → it
     is doing its job; the lever is terseness/effort on *it*, not the gates.
   - A role escalating repeatedly on the same scope → widen the §3b risky-scope
     list (so it starts at opus) **or** raise that agent's frontmatter `effort`.
   - A reviewer that **never FAILs** across many runs but costs a lot → a candidate
     to down-tier — but flag the silent-miss risk (a capped gate drops findings
     without moving `fix_rounds`); recommend reverting reviewer effort caps first
     if PR quality has slipped.
   - Frequent `plan-review-exhausted` / high plan rounds → the plan loop, not the
     implement loop, is the cost sink; the plan roles run at session model by design.
   Do not invent findings the data doesn't support. If the run is clean and cheap,
   say so plainly.

5. **If cost columns are absent** (legacy log), tell the user to re-run a ship-*
   flow now that spawn-accounting is in place, and point them at `/usage` for the
   session total in the meantime.

## Notes

- Read-only. This skill never edits code, agents, or tiers — it reports and
  recommends. Apply changes by editing `model-tiering.md` / the agent frontmatter
  yourself (or ask for it as a follow-up).
- The analyzer tolerates malformed lines and missing fields — a partial log still
  produces a partial report rather than an error.
- `report.py` is stdlib-only Python 3 (no pip deps).
