#!/usr/bin/env python3
"""Post-game analyzer for shipflow ship-* audit logs.

Reads one or many ship-task-*.jsonl / fix-task-*.jsonl audit logs (see
skills/shared/spawn-accounting.md for the event schema) and prints a
post-mortem: token + wall-clock attribution by sub-agent role, cycle hotspots
(plan rounds, fix rounds, escalations, checkpoints), and, across many runs, the
trends the model-tiering measurement section calls for.

Usage:
    report.py                      # newest log in ./docs/plans/
    report.py <file.jsonl>         # one run
    report.py <dir>                # aggregate every ship-*.jsonl in <dir>
    report.py latest [<dir>]       # newest log in <dir> (default ./docs/plans)
    report.py --json <target>      # machine-readable summary instead of text

Never raises on a malformed line or a missing field — it degrades. A run whose
spawn events carry null tokens is reported workflow-only (no cost columns).
"""
import sys
import os
import json
import glob
from collections import defaultdict, Counter
from datetime import datetime, timezone

LOG_GLOBS = ("ship-task-*.jsonl", "fix-task-*.jsonl")


def _parse_ts(v):
    if not isinstance(v, str):
        return None
    s = v.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def _load(path):
    """Return list of event dicts from one jsonl file, skipping bad lines."""
    events = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    if isinstance(obj, dict):
                        events.append(obj)
                except json.JSONDecodeError:
                    continue
    except OSError as e:
        print(f"WARN: cannot read {path}: {e}", file=sys.stderr)
    return events


def _num(v):
    return v if isinstance(v, (int, float)) else None


def _union_len(intervals):
    """Total length of the union of [a, b] intervals (seconds)."""
    total = 0.0
    cur = None
    for a, b in sorted(i for i in intervals if i[1] > i[0]):
        if cur is None or a > cur[1]:
            if cur is not None:
                total += cur[1] - cur[0]
            cur = [a, b]
        else:
            cur[1] = max(cur[1], b)
    if cur is not None:
        total += cur[1] - cur[0]
    return total


def _subtract_len(intervals, minus):
    """Length of the union of `intervals` not covered by the union of `minus`."""
    if not intervals:
        return 0.0
    cuts = sorted(a for i in intervals + minus for a in i)
    covered = 0.0
    for a, b in zip(cuts, cuts[1:]):
        if b <= a:
            continue
        mid = (a + b) / 2
        if any(x <= mid <= y for x, y in intervals) and not any(x <= mid <= y for x, y in minus):
            covered += b - a
    return covered


def _dedupe_spawns(events):
    """Drop repeat spawn rows for one seat (same agent_id + artifact), keeping the row that
    carries tokens. sf-log refuses these as of 0.28.0; earlier ledgers carry them (an
    orchestrator re-logging a Codex seat's own row to add a field) and each one doubled the
    seat's tokens and wall in every aggregate. Returns (events, dropped_count)."""
    keep = {}
    for i, e in enumerate(events):
        if (e.get("stage") or e.get("event")) != "spawn":
            continue
        if not e.get("agent_id") or not e.get("artifact"):
            continue
        key = (e["agent_id"], e["artifact"])
        prev = keep.get(key)
        if prev is None or (_num(events[prev].get("tokens")) is None and _num(e.get("tokens")) is not None):
            keep[key] = i
    drop = set()
    seen = {}
    for i, e in enumerate(events):
        if (e.get("stage") or e.get("event")) != "spawn" or not e.get("agent_id") or not e.get("artifact"):
            continue
        key = (e["agent_id"], e["artifact"])
        if i != keep[key]:
            drop.add(i)
    return [e for i, e in enumerate(events) if i not in drop], len(drop)


def analyze_run(path, events):
    """Collapse one run's events into a summary dict."""
    r = {
        "log": os.path.basename(path),
        "issue": None,
        "task": None,
        "ship_mode": None,
        "branch": None,
        "pr_url": None,
        "pr_base": None,
        "review_status": None,
        "plan_rounds": None,
        "fix_rounds": None,
        "checkpoints": [],       # list of {reason, stage}
        "reviewers": {},         # name -> verdict
        "wall_clock_s": None,
        "roles": {},             # role -> {spawns, tokens, duration_ms, models, escalations, tokens_known}
        "spawn_events": 0,
        "tokens_total": 0,
        "tokens_known": True,    # False if any spawn lacked tokens
        "tokens_missing": 0,     # turns with no token count (rendered as missing, never 0)
        "is_epic": False,
        "epic_layers": 0,  # epic-layer events (integrated layers); sync coverage is judged per layer
        "epic_landed": [],
        "epic_deferred": [],
        "triage_rounds": [],     # per-round triage records, ordered
        "express_mode": None,    # "express" | "full" | None (pre-1.9 log)
        "express_abandoned": None,
        "closure_warm": 0,       # warm-closure exchanges that ran warm
        "closure_fallback": 0,   # exchanges that fell back to a cold re-spawn
        "closure_unknown": 0,    # exchanges with no/unrecognized path field
        "closure_reopened": 0,   # findings reopened across all exchanges
        "closure_declines_ok": 0,  # fixer declines verified by their author
        "clarify_events": 0,     # pre-fix clarification exchanges
        "direction_reviews": 0,          # sf-direction-reviewer spawns (fix direction gated, 0.31.0)
        "direction_revised_blocking": 0, # blocking findings resolved by a direction revision
        "direction_reviews_skipped": 0,  # gated directions whose reviewer produced no artifact
        "adjudication_rounds": 0,        # distinct (epic_phase, round) with a numeric adjudication row (0.31.0)
        "adjudication_gaps": 0,
        "adjudication_accepted": 0,
        "adjudication_redirected": 0,
        "adjudication_bad_rows": [],     # ts of adjudication rows with non-numeric counts (skipped, flagged)
        "oscillation_stops": [],         # oscillation-stop events: {finding, severity, action, has_design_note} (0.31.0)
        "mopup": None,           # {fixed, residue, filed, generation_capped} or None
        "round_extensions": [],  # fix-round-extension events: {round, reason, phase}
        "operator_rounds": [],   # note event=operator-authorized-round: {round, phase, reason}
        "escape_rounds": 0,      # legacy fix-convergence-escape events (pre-0.24 loop)
        "followups_filed": 0,    # ids across every followup-tasks event (filed at triage as of 0.24)
        "followups_extended": 0, # existing tasks a followup-tasks event extended instead of creating
        "followup_bundle": None, # the run's cleanup-bundle parent task id, when one was created
        "absurd_walls": 0,       # rows whose wall exceeded 48 h (dropped from cost — sf-log check lists them)
        "pairing_checks": 0,     # pre-commit pairing checks on reopened findings
        "pairing_rejected": 0,   # checks that came back REJECTED
        "paired_closures": 0,    # closure exchanges covering a paired fix
        "paired_reopened": 0,    # reopened findings within paired closures
        "idle_after_seat_s": 0.0,  # wall between a seat's completion event and the next event, gaps > 5 min
        # Wall-clock segments (0.28.0): seat_busy = union of seat intervals [ts - wall, ts];
        # operator_wait = gaps after a checkpoint / operator-pause / operator-wait; session_gap = the gap before a
        # session-resumed or run-meta resumed mark (the orchestrating session was gone); orchestrator = the rest.
        "seat_busy_s": 0.0,
        "operator_wait_s": 0.0,
        "operator_wait_marks": 0,  # operator-wait events (ship-task §Interview policy)
        "session_gap_s": 0.0,
        "session_resumes": 0,
        "orchestrator_s": 0.0,
        "duplicate_spawns": 0,   # repeat rows for one seat, dropped before aggregation
        "failed_seats": [],      # [{role, round, detail, tokens}] codex-seat-failed notes (0.29.0: cost-bearing)
        "idle_gaps": [],         # [{role, round, gap_s}] the gaps that make up idle_after_seat_s
        "fix_rounds_derived": False,  # fix_rounds came from fixer spawn events, not implement-issue
        "integration_sync": [],  # [{at, behind, conflicts}]
    }
    prev_seat = None         # (ts, role, round) of the last seat completion event
    ts_seen = []
    roles = defaultdict(lambda: {"spawns": 0, "tokens": 0, "duration_ms": 0,
                                 "models": Counter(), "tiers": Counter(), "escalations": 0,
                                 "tokens_known": True, "tokens_missing": 0, "backends": Counter(),
                                 "has_time": False})
    # backend -> [tokens, spawns] (review-backend.md): a codex-backed run's ledger
    # carries backend=codex|claude on its reviewer spawns; absent means claude.
    r["backends"] = defaultdict(lambda: [0, 0])

    fixer_rounds = set()
    adjudication_round_keys = set()  # distinct (epic_phase, round) — the "round(s)" figure
    events, r["duplicate_spawns"] = _dedupe_spawns(events)
    seat_iv = []        # [(start_s, end_s)] one per timed seat/continuation row
    wait_iv = []        # [(start_s, end_s)] checkpoint / operator-pause / operator-wait → its close
    session_iv = []     # [(start_s, end_s)] previous event → session-resumed mark
    prev_ts = None      # ts of the previous event of any kind
    pending_wait = None # (ts, kind) of a checkpoint / operator-pause / operator-wait awaiting its close
    for e in events:
        # Some runs logged spawn-accounting under "event" instead of "stage"
        # (older ledgers) — normalize so their cost ledger is
        # not silently misread as "predates spawn-accounting". "checkpoint"
        # events carry their stage in "stage", which wins here anyway.
        stage = e.get("stage") or e.get("event")
        ts = _parse_ts(e.get("ts"))
        if ts:
            ts_seen.append(ts)
            if pending_wait is not None and _closes_wait(pending_wait[1], stage, e):
                wait_iv.append((pending_wait[0].timestamp(), ts.timestamp()))
                pending_wait = None
            if _is_resume_mark(stage, e):
                r["session_resumes"] += 1
                if prev_ts is not None:
                    session_iv.append((prev_ts.timestamp(), ts.timestamp()))
            if e.get("event") == "checkpoint" or (stage == "note" and e.get("event") == "operator-pause"):
                pending_wait = (ts, "stop")
            elif stage == "operator-wait":
                r["operator_wait_marks"] += 1
                pending_wait = (ts, "operator-wait")
            prev_ts = ts
            # Idle after a finished seat: a spawn/closure event is logged when the seat RETURNS,
            # so the gap to the next event of any kind is time the orchestrator did nothing
            # with a finished result — asleep on a nohup'd fixer, or waiting on the operator.
            if prev_seat is not None:
                gap = (ts - prev_seat[0]).total_seconds()
                if gap > 300:
                    r["idle_after_seat_s"] += gap
                    r["idle_gaps"].append({"role": prev_seat[1], "round": prev_seat[2], "gap_s": gap})
                prev_seat = None
            if stage in ("spawn", "closure-exchange"):
                prev_seat = (ts, e.get("role") or e.get("agent_type") or "unknown", _num(e.get("round")))
        if r["issue"] is None:
            r["issue"] = e.get("issue") or e.get("epic")
        if r["task"] is None:
            r["task"] = e.get("task")
        for k in ("ship_mode", "branch", "pr_url", "pr_base", "review_status"):
            if e.get(k) is not None and r[k] is None:
                r[k] = e.get(k)

        # Plan gaps (review-backend.md §Hybrid mode): the batch-implement sum is authoritative
        # when present; Codex writer spawn events carry per-seat counts as the fallback source.
        for src, cond in (("bi", stage == "batch-implement"), ("spawn", stage == "spawn")):
            if cond and (e.get("plan_gaps_semantic") is not None or e.get("plan_gaps_cosmetic") is not None):
                pg = r.setdefault(f"plan_gaps_{src}", {"semantic": 0, "cosmetic": 0, "events": 0})
                pg["semantic"] += int(_num(e.get("plan_gaps_semantic")) or 0)
                pg["cosmetic"] += int(_num(e.get("plan_gaps_cosmetic")) or 0)
                pg["events"] += 1

        # A failed Codex seat (timeout, crash) writes a note, not a spawn row; as of 0.29.0 the
        # note carries the seat's usage recovered from its rollout, so it is a cost-bearing turn —
        # the most expensive failure shape (a timed-out writer) must not vanish from the ledger.
        is_failed_seat = stage == "note" and str(e.get("event") or "").startswith("codex-seat-") \
            and e.get("event") != "codex-seat-fallback"
        if is_failed_seat:
            r["failed_seats"].append({"role": e.get("role"), "round": _num(e.get("round")),
                                      "detail": e.get("detail"), "tokens": _num(e.get("tokens"))})
        if stage in ("spawn", "closure-exchange", "clarify", "pairing-check") or is_failed_seat:
            # closure-exchange and clarify are SendMessage continuations, not
            # Agent spawns, but they are cost-bearing sub-agent turns — same
            # ledger (spawn-accounting.md §Continuations). Their roles are
            # namespaced (reviewer:<x>:closure / :clarify) so the split stays
            # visible.
            r["spawn_events"] += 1
            role = e.get("role") or e.get("agent_type") or "unknown"
            slot = roles[role]
            slot["spawns"] += 1
            tok = _num(e.get("tokens"))
            if tok is None:
                slot["tokens_known"] = False
                slot["tokens_missing"] += 1
                r["tokens_known"] = False
                r["tokens_missing"] += 1
            else:
                slot["tokens"] += tok
                r["tokens_total"] += tok
            # duration_ms comes from the harness usage block; wall_ms is the
            # orchestrator's own clock and survives paths that drop usage.
            backend = e.get("backend") or ("codex" if e.get("agent_type") == "codex-exec" else "claude")
            dur = _num(e.get("duration_ms"))
            if dur is None:
                dur = _num(e.get("wall_ms"))
                # A sub-second wall on a Claude spawn is started= taken at log time, not a
                # measurement (sf-log check: spawns_wall_implausible) — never fold it into cost.
                if dur is not None and dur < 1000 and backend != "codex" and stage == "spawn":
                    dur = None
            # A wall over 48 h is a started= that was never this row's start — a stray value
            # would otherwise swamp the role's total.
            if dur is not None and dur > 48 * 3600 * 1000:
                r["absurd_walls"] += 1
                dur = None
            if dur is not None:
                slot["duration_ms"] += dur
                slot["has_time"] = True
                if ts:
                    seat_iv.append((ts.timestamp() - dur / 1000, ts.timestamp()))
            # The transcript-measured identity wins over the logged alias when sf-log found one.
            served = e.get("model_served")
            if isinstance(served, str) and served:
                effort = e.get("effort_served")
                label = served + ("/" + effort if isinstance(effort, str) and effort else "")
                slot["models"][label] += 1
            elif e.get("model"):
                slot["models"][e["model"]] += 1
            if e.get("tier"):
                slot["tiers"][e["tier"]] += 1
            slot["backends"][backend] += 1
            r["backends"][backend][1] += 1
            if tok is not None:
                r["backends"][backend][0] += tok
            if e.get("escalated"):
                slot["escalations"] += 1
            if is_failed_seat:
                slot["failed"] = slot.get("failed", 0) + 1
            if stage == "spawn" and role in ("fixer", "mopup-fixer") and _num(e.get("round")) is not None:
                fixer_rounds.add((role, int(_num(e.get("round")))))
            if stage == "spawn" and str(role).startswith("direction-reviewer"):
                r["direction_reviews"] += 1
            if stage == "closure-exchange":
                # Only an explicit path counts toward the warm-hit rate — a
                # missing/misspelled path must not inflate the number that
                # decides whether the protocol is retired.
                path = e.get("path")
                if path == "warm":
                    r["closure_warm"] += 1
                elif path == "cold-fallback":
                    r["closure_fallback"] += 1
                else:
                    r["closure_unknown"] += 1
                reopened = _num(e.get("findings_reopened"))
                if reopened:
                    r["closure_reopened"] += reopened
                da = _num(e.get("findings_decline_accepted"))
                if da:
                    r["closure_declines_ok"] += da
                if e.get("paired"):
                    r["paired_closures"] += 1
                    # An exchange covers ALL of a reviewer's findings, so only
                    # the per-finding paired counts attribute outcomes — the
                    # exchange-level reopen count would blame the paired fix
                    # for its unpaired neighbours.
                    pr_ = _num(e.get("paired_findings_reopened"))
                    if pr_:
                        r["paired_reopened"] += pr_
            elif stage == "clarify":
                r["clarify_events"] += 1
            elif stage == "pairing-check":
                r["pairing_checks"] += 1
                if e.get("verdict") == "REJECTED":
                    r["pairing_rejected"] += 1

        elif stage == "integration-sync":
            r["integration_sync"].append({"at": e.get("at"), "behind": _num(e.get("behind")),
                                          "conflicts": _num(e.get("conflicts")),
                                          "layer": _num(e.get("layer")),
                                          "probe": bool(e.get("probe")),
                                          "resolved": bool(e.get("resolved"))})
        elif stage == "mopup":
            r["mopup"] = {k: _num(e.get(k)) or 0 for k in
                          ("fixed", "residue", "filed", "generation_capped")}
        elif stage == "fix-round-extension":
            r["round_extensions"].append({"round": _num(e.get("round")),
                                          "reason": e.get("reason"),
                                          "phase": e.get("phase")})
        elif stage == "fix-convergence-escape":
            r["escape_rounds"] += 1
        elif stage == "adjudication":
            gaps, acc, red = _num(e.get("gaps")), _num(e.get("accepted")), _num(e.get("redirected"))
            if gaps is None or acc is None or red is None:
                # A count the write gate would now reject (pre-0.31.0 ledger): skip the row
                # from the totals and flag it, rather than coercing the bad count to 0. A
                # skipped row does not count toward the distinct-round figure either.
                r["adjudication_bad_rows"].append(e.get("ts"))
            else:
                # A redirect round writes two adjudication events (first + accept-only second),
                # so count distinct (epic_phase, round) keys, not events.
                adjudication_round_keys.add((e.get("epic_phase"), _num(e.get("round"))))
                r["adjudication_gaps"] += int(gaps)
                r["adjudication_accepted"] += int(acc)
                r["adjudication_redirected"] += int(red)
        elif stage == "oscillation-stop":
            r["oscillation_stops"].append({"finding": e.get("finding"),
                                           "severity": e.get("severity"),
                                           "action": e.get("action"),
                                           "has_design_note": bool(e.get("design_note"))})
        elif stage == "note" and e.get("event") == "direction-revised":
            r["direction_revised_blocking"] += int(_num(e.get("blocking")) or 0)
        elif stage == "note" and e.get("event") == "direction-review-skipped":
            r["direction_reviews_skipped"] += 1
        elif stage == "note" and e.get("event") == "operator-authorized-round":
            r["operator_rounds"].append({"round": _num(e.get("round")),
                                         "phase": e.get("phase"),
                                         "reason": e.get("reason")})
        elif stage == "followup-tasks":
            for key, slot in (("created", "followups_filed"), ("extended", "followups_extended")):
                v = e.get(key)
                if isinstance(v, str):
                    # sf-log stores a k='["a","b"]' value as the JSON list, but a hand-written
                    # row may carry the string — count it rather than silently drop it.
                    try:
                        v = json.loads(v)
                    except (TypeError, ValueError):
                        v = [v] if v else []
                if isinstance(v, list):
                    r[slot] += len(v)
            if e.get("bundle") and r["followup_bundle"] is None:
                r["followup_bundle"] = e.get("bundle")
        elif stage == "followup-bundle":
            if e.get("bundle"):
                r["followup_bundle"] = e.get("bundle")

        elif stage == "plan-issue":
            if _num(e.get("rounds")) is not None:
                r["plan_rounds"] = e["rounds"]
        elif stage == "implement-issue":
            if _num(e.get("fix_rounds")) is not None:
                r["fix_rounds"] = e["fix_rounds"]
            if isinstance(e.get("reviewers"), dict):
                r["reviewers"].update(e["reviewers"])
            for k in ("review_status", "pr_url", "pr_base", "branch", "ship_mode"):
                if e.get(k) is not None:
                    r[k] = e.get(k)
        elif stage == "triage":
            r["triage_rounds"].append({
                "round": _num(e.get("round")),
                "b1": _num(e.get("bucket1_fix_now")),
                "b2": _num(e.get("bucket2_human")),
                "b3": _num(e.get("bucket3_followup")),
                "b4": _num(e.get("bucket4_dropped")),
                "goal_post": _num(e.get("goal_post")),
                "verdicts": e.get("reviewer_verdicts") if isinstance(
                    e.get("reviewer_verdicts"), dict) else {},
                "rereview_mode": e.get("rereview_mode"),
                "rereview_reviewers": e.get("rereview_reviewers") or [],
            })
        elif stage == "express-classification":
            r["express_mode"] = e.get("mode")
        elif stage == "express-abandoned":
            r["express_abandoned"] = e.get("reason") or "unspecified"
        elif stage in ("epic-decompose", "epic-cut", "epic-layer", "epic-finalize"):
            r["is_epic"] = True
            if stage == "epic-layer":
                r["epic_layers"] += 1
            if isinstance(e.get("landed"), list):
                r["epic_landed"] = e["landed"]
            if isinstance(e.get("deferred"), list):
                r["epic_deferred"] = e["deferred"]
        if e.get("event") == "checkpoint":
            r["checkpoints"].append({"reason": e.get("reason"), "stage": stage})

    if ts_seen:
        r["wall_clock_s"] = (max(ts_seen) - min(ts_seen)).total_seconds()
        lo, hi = min(ts_seen).timestamp(), max(ts_seen).timestamp()
        # An operator-wait still open when the log ends (run stopped mid-wait) runs to the last event.
        if pending_wait is not None and pending_wait[1] == "operator-wait":
            wait_iv.append((pending_wait[0].timestamp(), hi))
        clip = lambda iv: [(max(lo, a), min(hi, b)) for a, b in iv if min(hi, b) > max(lo, a)]
        seat_iv, wait_iv, session_iv = clip(seat_iv), clip(wait_iv), clip(session_iv)
        r["seat_busy_s"] = _union_len(seat_iv)
        # A detached Codex seat keeps running through a dropped session or an operator pause, so
        # the attributable segments count only where no seat was busy; a session gap inside an
        # operator wait is the wait (the operator was away either way).
        r["session_gap_s"] = _subtract_len(session_iv, seat_iv + wait_iv)
        r["operator_wait_s"] = _subtract_len(wait_iv, seat_iv)
        r["orchestrator_s"] = max(0.0, r["wall_clock_s"] - r["seat_busy_s"] - r["session_gap_s"] - r["operator_wait_s"])
    if r["fix_rounds"] is None and fixer_rounds:
        # implement-issue never logged (run ended before 3g, or the event was skipped): the
        # fixer spawn events are the ground truth for how many rounds ran.
        r["fix_rounds"] = len({rd for role, rd in fixer_rounds if role == "fixer"})
        r["fix_rounds_derived"] = True
    r["adjudication_rounds"] = len(adjudication_round_keys)
    r["roles"] = {k: v for k, v in roles.items()}
    return r


def _is_resume_mark(stage, e):
    """A session-resumed hook row, or the `run-meta resumed:true` mark `sf-log init --resume`
    writes at the head of the lines it folds into the recorded ledger."""
    return stage == "session-resumed" or (stage == "run-meta" and e.get("resumed") is True)


def _closes_wait(kind, stage, e):
    """Whether event `e` ends a pending wait (spawn-accounting.md §Session marks).

    A checkpoint / operator-pause ends at the next event of any kind. An operator-wait ends at
    `note event=operator-answered`, else at the next orchestrator-authored event: a detached
    Codex seat's own row, its codex-seat-* note, or a session-resumed mark can land while the
    operator is still away, so none of them ends it.
    """
    if kind != "operator-wait":
        return True
    if _is_resume_mark(stage, e) or e.get("backend") == "codex":
        return False
    if stage == "note" and str(e.get("event") or "").startswith("codex-seat-"):
        return False
    return True


def _fmt_secs(s):
    if s is None:
        return "—"
    s = int(s)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m"
    if m:
        return f"{m}m{sec:02d}s"
    return f"{sec}s"


def _fmt_tok(n):
    if n is None:
        return "—"
    if n >= 1_000_000:
        return f"{n/1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}k"
    return str(int(n))


def render_run(r):
    out = []
    if r["task"] is not None:
        label = f"task {r['task']}"
    else:
        label = f"epic #{r['issue']}" if r["is_epic"] else f"#{r['issue']}"
    out.append(f"=== ship-report — {label}  ({r['log']}) ===")
    out.append(f"mode: {r['ship_mode'] or '?'}   branch: {r['branch'] or '?'}   "
               f"review: {r['review_status'] or '?'}")
    out.append(f"plan rounds: {r['plan_rounds'] if r['plan_rounds'] is not None else '?'}   "
               f"fix rounds: {r['fix_rounds'] if r['fix_rounds'] is not None else '?'}"
               f"{' (from fixer spawns)' if r.get('fix_rounds_derived') else ''}   "
               f"wall-clock: {_fmt_secs(r['wall_clock_s'])}")
    if r.get("wall_clock_s"):
        w = r["wall_clock_s"]
        pct = lambda s: f"{(s / w * 100):.0f}%" if w else "?"
        out.append(f"wall segments: seats busy {_fmt_secs(r['seat_busy_s'])} ({pct(r['seat_busy_s'])})   "
                   f"operator waits {_fmt_secs(r['operator_wait_s'])} ({pct(r['operator_wait_s'])}, {r.get('operator_wait_marks', 0)} marked)   "
                   f"session gaps {_fmt_secs(r['session_gap_s'])} ({pct(r['session_gap_s'])}, {r['session_resumes']} resume(s))   "
                   f"orchestrator/unattributed {_fmt_secs(r['orchestrator_s'])} ({pct(r['orchestrator_s'])})"
                   + (f"   [{r['duplicate_spawns']} duplicate spawn row(s) dropped]" if r.get("duplicate_spawns") else ""))
    if r.get("idle_after_seat_s"):
        gaps = sorted(r["idle_gaps"], key=lambda g: -g["gap_s"])
        top = ", ".join(f"{_fmt_secs(g['gap_s'])} after {g['role']} r{g['round']}" for g in gaps[:3])
        share = (r["idle_after_seat_s"] / r["wall_clock_s"] * 100) if r.get("wall_clock_s") else 0
        out.append(f"idle after a finished seat: {_fmt_secs(r['idle_after_seat_s'])} ({share:.0f}% of wall, "
                   f"{len(gaps)} gap(s) > 5 min; largest: {top})")
    if r.get("integration_sync"):
        out.append("integration sync: " + "; ".join(_fmt_sync(s) for s in r["integration_sync"]))
    if r["pr_url"]:
        out.append(f"PR: {r['pr_url']} (base {r['pr_base'] or '?'})")
    if r["is_epic"]:
        out.append(f"phases landed: {r['epic_landed'] or '—'}   deferred: {r['epic_deferred'] or '—'}")

    # Token / time by role
    out.append("")
    if r["spawn_events"] == 0:
        out.append("[no spawn events — this log predates spawn-accounting; workflow-only]")
    else:
        k, n = r.get("tokens_missing", 0), r["spawn_events"]
        total = "missing" if k and k >= n else ("≥" if k else "") + _fmt_tok(r["tokens_total"])
        note = f"   (usage missing on {k} of {n} turns → totals are lower bounds)" if k else ""
        out.append(f"--- cost by role ({n} turns, "
                   f"{total} tokens total){note} ---")
        rows = []
        for role, v in r["roles"].items():
            share = (v["tokens"] / r["tokens_total"] * 100) if r["tokens_total"] else 0
            models = ",".join(f"{m}×{c}" for m, c in v["models"].most_common())
            if v["tiers"]:
                models += " [" + ",".join(f"{t}×{c}" for t, c in v["tiers"].most_common()) + "]"
            backend = "/".join(b for b, _ in v["backends"].most_common()) or "claude"
            rows.append((v["tokens"], role, v["spawns"], v["duration_ms"], share,
                         models, v["escalations"], v.get("tokens_missing", 0), backend,
                         v["has_time"], v.get("failed", 0)))
        rows.sort(reverse=True)
        mixed = len(r["backends"]) > 1 or "codex" in r["backends"]
        out.append(f"  {'role':<30}{'spawns':>7}{'tokens':>10}{'share':>7}{'wall':>8}"
                   f"{'  backend' if mixed else ''}  models")
        for tok, role, spawns, dur, share, models, esc, missing, backend, has_time, failed in rows:
            tokd = "missing" if missing >= spawns else ("≥" if missing else "") + _fmt_tok(tok)
            esct = f"  ⇧{esc} escalated" if esc else ""
            if failed:
                esct += f"  ✗{failed} failed seat(s) counted"
            bcol = f"  {backend:<7}" if mixed else ""
            # "?" = no duration_ms and no wall_ms on any of this role's turns — an
            # unmeasured seat, which must not render as a zero-cost one.
            wall = _fmt_secs(dur / 1000) if has_time else "?"
            out.append(f"  {role:<30}{spawns:>7}{tokd:>10}{share:>6.0f}%"
                       f"{wall:>8}{bcol}  {models}{esct}")
        if mixed:
            parts = ", ".join(f"{b}: {_fmt_tok(t)} tokens / {n} turns"
                              for b, (t, n) in sorted(r["backends"].items()))
            out.append(f"  by backend — {parts}   (review-backend.md)")

    # Fix-round yield — does round N+1 earn its cost?
    if r["triage_rounds"]:
        out.append("")
        out.append("--- fix-round yield (bucket 1 = fix-now findings that round) ---")
        out.append(f"  {'round':<7}{'fix-now':>8}{'human':>7}{'follow':>8}{'dropped':>9}"
                   f"  {'re-review':<16}reviewers re-engaged")
        for t in sorted(r["triage_rounds"], key=lambda x: (x["round"] is None, x["round"])):
            rr = t["rereview_mode"] or "—"
            names = ", ".join(t["rereview_reviewers"]) if t["rereview_reviewers"] else "—"
            out.append(f"  {str(t['round']):<7}{str(t['b1']):>8}{str(t['b2']):>7}"
                       f"{str(t['b3']):>8}{str(t['b4']):>9}  {rr:<16}{names}")
        rounds = [t for t in r["triage_rounds"] if t["round"] is not None]
        if len(rounds) >= 2:
            later = [t for t in rounds if t["round"] >= 2]
            marginal = sum(t["b1"] or 0 for t in later)
            out.append(f"  → rounds ≥2 surfaced {marginal} new fix-now finding(s). "
                       f"{'Round 2+ earned its cost.' if marginal else 'Round 2+ found nothing new.'}")
        elif len(rounds) == 1 and (r.get("fix_rounds") or 0) >= 2:
            out.append("  → ONLY round 1 was logged despite fix_rounds≥2 — marginal yield "
                       "is unmeasurable for this run. Emit a triage event every round.")
    elif (r.get("fix_rounds") or 0) >= 1:
        out.append("")
        out.append("[no triage events — this log predates per-round triage logging; "
                   "fix-round yield unmeasurable]")

    # Plan gaps — is the plan bounded enough for a cheaper implementer?
    pg = r.get("plan_gaps_bi") or r.get("plan_gaps_spawn")
    if pg:
        src = "batch-implement" if r.get("plan_gaps_bi") else "writer spawn events"
        out.append("")
        out.append(f"--- plan gaps (decisions the plan did not specify): semantic {pg['semantic']} / "
                   f"cosmetic {pg['cosmetic']}  [{pg['events']} event(s), from {src}] ---")
        out.append("  semantic ≈ 0 across runs → the plan path is bounded enough for a Sonnet-class "
                   "implementer; rising → the drafter needs the tier, not the implementer.")

    # Warm-closure protocol (fix-round re-review via SendMessage continuations)
    if (r["closure_warm"] or r["closure_fallback"] or r["closure_unknown"]
            or r["clarify_events"] or r["pairing_checks"]):
        out.append("")
        known = r["closure_warm"] + r["closure_fallback"]
        rate = (f"{r['closure_warm']}/{known} exchanges warm "
                f"({r['closure_warm'] / known * 100:.0f}%)") if known else "no exchanges"
        unk = f", {r['closure_unknown']} with no path field (excluded from rate)" \
            if r["closure_unknown"] else ""
        out.append(f"--- warm closure: {rate}{unk}, "
                   f"{r['closure_reopened']} finding(s) reopened"
                   + (f", {r['closure_declines_ok']} decline(s) author-verified"
                      if r["closure_declines_ok"] else "")
                   + (f", {r['clarify_events']} pre-fix clarification(s)"
                      if r["clarify_events"] else "") + " ---")
        if r["pairing_checks"]:
            out.append(f"--- pairing: {r['pairing_checks']} check(s), "
                       f"{r['pairing_rejected']} rejected, "
                       f"{r['paired_closures']} paired closure(s)"
                       + (f", {r['paired_reopened']} paired finding(s) reopened again"
                          if r["paired_reopened"] else "") + " ---")

    # Direction review (0.31.0): the sf-direction-reviewer pass that gates a merged fix
    # direction before the fixer runs (ship-task 3e step 2b).
    if r["direction_reviews"] or r["direction_revised_blocking"] or r["direction_reviews_skipped"]:
        out.append("")
        out.append(f"--- direction review: {r['direction_reviews']} pass(es), "
                   f"{r['direction_revised_blocking']} blocking finding(s) resolved, "
                   f"{r['direction_reviews_skipped']} skipped ---")

    # Semantic-gap adjudication (0.31.0): the accept/redirect pass before closure that
    # turns a fixer's design decisions into facts the closure reviewer verifies against
    # (ship-task 3e step 3.5).
    if r["adjudication_rounds"]:
        out.append("")
        out.append(f"--- adjudication: {r['adjudication_rounds']} round(s), "
                   f"{r['adjudication_gaps']} semantic gap(s): "
                   f"{r['adjudication_accepted']} accepted, "
                   f"{r['adjudication_redirected']} redirected ---")

    # Mop-up (final-round M/L drainage — scope-policy §filing floor)
    if r["mopup"]:
        m = r["mopup"]
        out.append("")
        out.append(f"--- mop-up: {m['fixed']} fixed, {m['residue']} residue, "
                   f"{m['filed']} filed"
                   + (f", {m['generation_capped']} generation-capped"
                      if m["generation_capped"] else "") + " ---")

    # Round extensions beyond the base budget (ship-task 3e, 0.24.0): the orchestrator's own
    # extensions vs the operator questions they replaced. Every operator round is an
    # AskUserQuestion wall.
    if r["round_extensions"] or r["operator_rounds"] or r["escape_rounds"]:
        out.append("")
        reasons = Counter(x["reason"] or "?" for x in r["round_extensions"])
        parts = [f"{len(r['round_extensions'])} orchestrator"
                 + (f" ({', '.join(f'{k}×{v}' for k, v in reasons.items())})" if reasons else ""),
                 f"{len(r['operator_rounds'])} operator-authorized"]
        if r["escape_rounds"]:
            parts.append(f"{r['escape_rounds']} convergence-escape (pre-0.24)")
        out.append(f"--- round extensions: {', '.join(parts)} ---")
        for x in r["operator_rounds"]:
            where = " ".join(s for s in (f"round {x['round']}" if x['round'] is not None else "round ?",
                                         x['phase'] or "") if s)
            out.append(f"  operator {where}: {(x['reason'] or '')[:110]}")

    # Oscillation stops (0.31.0): findings that reopened twice and left the mechanical loop.
    # Each is <finding>/<action>; a design-note action re-enters once, checkpoint/bucket-3 do not.
    if r["oscillation_stops"]:
        out.append("")
        stops = r["oscillation_stops"]
        detail = ", ".join(f"{s['finding']}/{s['action'] or '?'}" for s in stops)
        out.append(f"--- oscillation stops: {len(stops)} ({detail}) ---")

    # Follow-ups (filed at triage into the run's cleanup bundle as of 0.24.0)
    goal_post = sum(t.get("goal_post") or 0 for t in r["triage_rounds"])
    if r["followups_filed"] or r["followup_bundle"] or goal_post:
        out.append("")
        out.append(f"--- follow-ups: {r['followups_filed']} filed"
                   + (f", {r['followups_extended']} extended" if r["followups_extended"] else "")
                   + (f", {goal_post} goal-post counterexample(s) filed instead of fixed" if goal_post else "")
                   + (f" → bundle {r['followup_bundle']}" if r["followup_bundle"] else " (no bundle — standalone tasks)")
                   + " ---")

    # Express path
    if r["express_mode"]:
        out.append("")
        line = f"--- express path: {r['express_mode']} ---"
        out.append(line)
        if r["express_abandoned"]:
            out.append(f"  ABANDONED mid-run: {r['express_abandoned']} "
                       f"(full reviewer set + 2-round fix loop restored)")

    # Hotspots
    if r["checkpoints"]:
        out.append("")
        out.append("--- checkpoints hit ---")
        for c in r["checkpoints"]:
            out.append(f"  {c['reason']}  (stage {c['stage']})")
    if r["reviewers"]:
        fails = [n for n, v in r["reviewers"].items() if str(v).upper().startswith("FAIL")]
        if fails:
            out.append("")
            out.append(f"--- reviewers that FAILed at least once: {', '.join(fails)} ---")
    return "\n".join(out)


def _fmt_sync(s):
    tag = s["at"] if s.get("layer") is None else f"{s['at']} {s['layer']}"
    if s.get("probe"):
        tag += " (probe)"
    if s.get("resolved"):
        tag += " (resolved)"
    return f"{tag}: {s['behind']} behind, {s['conflicts']} conflict(s)"


def _disposition(ev):
    """The disposition an oscillation-stop records (warm-closure.md §3): its explicit action
    when written, else bucket-3 for a MEDIUM/LOW stop and design-note for a CRITICAL/HIGH one.
    The same rule sf-log's dispositionOf applies."""
    action = ev.get("action")
    if action:
        return action
    return "bucket-3" if ev.get("severity") in ("MEDIUM", "LOW") else "design-note"


def _run_flags(r):
    """Deterministic tuning flags for a single run (the report skill turns these
    into prose against the model-tiering revert rules)."""
    flags = []
    if r.get("failed_seats"):
        fs = r["failed_seats"]
        untok = [f for f in fs if f["tokens"] is None]
        flags.append(f"{len(fs)} failed Codex seat(s) ({', '.join(str(f['role']) for f in fs)}) — "
                     + ("their usage is in the cost table (recovered from the rollout)." if not untok else
                        f"{len(untok)} carried no tokens (pre-0.29.0 sf-codex): the cost table is a lower bound."))
    if r.get("duplicate_spawns"):
        flags.append(f"{r['duplicate_spawns']} duplicate spawn row(s) (same agent_id + artifact) dropped before "
                     "aggregation — a Codex seat logs its own row; the orchestrator must not re-log it "
                     "(sf-log ≥ 0.28.0 refuses the second write).")
    for ts in r.get("adjudication_bad_rows", []):
        flags.append(f"adjudication row with non-numeric counts (ts {ts}) — skipped from the adjudication "
                     "totals (sf-log ≥ 0.31.0 refuses such a write).")
    # A design-note oscillation stop must carry its note artifact before the id re-enters the
    # fixer (warm-closure.md §3). Only a stop whose disposition is design-note needs one; a
    # checkpoint or bucket-3 stop (a MEDIUM/LOW stop with no action is bucket-3 by severity)
    # never does, so it is not flagged when the artifact is absent.
    for s in r.get("oscillation_stops", []):
        if _disposition(s) == "design-note" and not s["has_design_note"]:
            flags.append(f"finding {s['finding']} stopped without a design note — a design-note "
                         "re-entry needs the note artifact (warm-closure.md §3).")
    if (r.get("wall_clock_s") or 0) > 2 * 3600 and (r.get("orchestrator_s") or 0) > 0.4 * r["wall_clock_s"]:
        flags.append(f"orchestrator/unattributed time is {_fmt_secs(r['orchestrator_s'])} "
                     f"({r['orchestrator_s'] / r['wall_clock_s'] * 100:.0f}% of wall) — no seat was running, no "
                     "checkpoint or session-resumed mark explains it. This interval may include waiting, "
                     "operator decisions or an unmarked session gap; it is not evidence of active "
                     "orchestrator work or token spend.")
    if r.get("idle_after_seat_s", 0) > 3600:
        flags.append(f"{_fmt_secs(r['idle_after_seat_s'])} idle after finished seats — inspect session and "
                     "operator-wait marks before attributing latency. Native hosts use their wait tools; "
                     "headless hybrid seats use the registered background waiter.")
    if not r.get("integration_sync") and r.get("pr_url"):
        flags.append("no integration-sync event — the panel and push ran without merging the base branch "
                     "(ship-task §3d/§3g, 0.26.0).")
    syncs = r.get("integration_sync") or []
    if r.get("is_epic") and r.get("epic_layers", 0) > 1:
        # any merge sync carrying layer= counts (pre-0.27.0 runs logged the improvised one as at=3d layer=0)
        layer_syncs = {s["layer"] for s in syncs if s.get("layer") is not None and not s.get("probe")}
        missing = r["epic_layers"] - len(layer_syncs)
        if missing > 0:
            flags.append(f"{missing} of {r['epic_layers']} epic layers integrated with no `at=layer` sync — phase "
                         "worktrees were cut from a stale base; the finalize merge pays for it "
                         "(shared/integration-sync.md, 0.27.0).")
    late = [s for s in syncs if s.get("at") in ("3g", "3f") and not s.get("probe")
            and (s.get("behind") or 0) >= 20 and (s.get("conflicts") or 0) > 0]
    for s in late:
        flags.append(f"the {s['at']} sync arrived {s['behind']} commits behind with {s['conflicts']} conflict(s) — "
                     "the base moved for hours with no boundary sync (3e rounds / epic layers); "
                     "a conflict absorbed at the boundary it appeared on is a one-commit merge.")
    roles = r["roles"]
    if r.get("fix_rounds") is not None and r["fix_rounds"] >= 2:
        flags.append(f"fix loop ran {r['fix_rounds']} rounds — findings churned; "
                     f"inspect which reviewer kept failing.")
    if r.get("plan_rounds") is not None and r["plan_rounds"] >= 4:
        flags.append(f"plan took {r['plan_rounds']} rounds — plan-drafter/reviewer disagreement is expensive.")
    for role, v in roles.items():
        if v.get("escalations"):
            flags.append(f"{role} escalated {v['escalations']}× (sonnet→opus) — recurring? "
                         f"raise its effort cap or widen the risky-scope list.")
    if r["tokens_total"]:
        for role, v in roles.items():
            share = v["tokens"] / r["tokens_total"] * 100
            if share >= 45 and v["spawns"] >= 1:
                flags.append(f"{role} is {share:.0f}% of sub-agent tokens — the dominant cost; "
                             f"the biggest lever for this run.")
    for c in r["checkpoints"]:
        if c["reason"] in ("unresolved-review-findings", "ambiguous-fix-required",
                           "implementer-failed", "build-failed"):
            flags.append(f"halted on '{c['reason']}' — a human gate or a real failure, not routine.")

    # Fix-round yield signals
    rounds = sorted((t for t in r["triage_rounds"] if t["round"] is not None),
                    key=lambda t: t["round"])
    if len(rounds) == 1 and (r.get("fix_rounds") or 0) >= 2:
        flags.append("only round 1 emitted a triage event despite fix_rounds≥2 — the marginal "
                     "yield of round 2 is unmeasurable. Fix the logging before tuning the cap.")
    elif len(rounds) >= 2:
        marginal = sum(t["b1"] or 0 for t in rounds[1:])
        # A round's rereview_mode describes the re-review run AFTER that round's
        # fixes; what that re-review found shows up as the NEXT round's fix-now
        # count. So "a full re-review yielded nothing" is a property of adjacent
        # pairs, not of any single event.
        zero_yield_full = any(
            a.get("rereview_mode") in ("full", "warm+cold-panel") and not (b["b1"] or 0)
            for a, b in zip(rounds, rounds[1:]))
        if marginal == 0 and zero_yield_full:
            flags.append("a full-panel re-review surfaced 0 new fix-now findings — "
                         "check whether the seam/severity gate should have chosen the "
                         "minimal cold roster ('scoped' pre-protocol, 'warm' post).")
        elif marginal == 0:
            flags.append("rounds ≥2 surfaced 0 new fix-now findings — if this repeats across "
                         "runs, the 2-round cap is buying confirmation, not coverage.")
    if r.get("express_abandoned"):
        flags.append(f"express path abandoned mid-run ({r['express_abandoned']}) — the Stage 1.9 "
                     f"classifier mis-scoped this issue; tighten its bounded-scope condition.")
    if r.get("operator_rounds"):
        flags.append(f"{len(r['operator_rounds'])} operator-authorized fix round(s) — each one is a "
                     f"wall the run waits on; if the operator took the recommended option, the 3e "
                     f"extension rules (progress / bounded bucket / no oscillation / no fix-introduced "
                     f"HIGH) should have self-authorized it. Check which rule blocked.")
    if r.get("absurd_walls"):
        flags.append(f"{r['absurd_walls']} row(s) logged a wall over 48 h and were dropped from "
                     f"cost — started= was not that row's epoch-ms start; see `sf-log check`.")
    m = r.get("mopup")
    if m and m["filed"] > m["fixed"] + m["residue"]:
        flags.append(f"mop-up filed {m['filed']} issue(s) but drained only "
                     f"{m['fixed'] + m['residue']} finding(s) — the final-round pile mostly "
                     f"became backlog; check the filing floor was applied.")
    if r["triage_rounds"] and r["mopup"] is None:
        last = max((t for t in r["triage_rounds"] if t["round"] is not None),
                   key=lambda t: t["round"], default=None)
        if last and (last["b1"] or 0) + (last["b3"] or 0) >= 10:
            flags.append(f"final triage carried {(last['b1'] or 0) + (last['b3'] or 0)} findings "
                         f"with NO mopup event — pre-floor run or the mop-up was skipped; "
                         f"every one of these becomes a follow-up issue.")
    if r["paired_reopened"]:
        flags.append(f"{r['paired_reopened']} paired finding(s) reopened AFTER a confirmed "
                     f"pairing — the pre-commit check approved a fix its own closure then "
                     f"rejected; if this repeats, pairing is adding cost without convergence.")
    total_ex = r["closure_warm"] + r["closure_fallback"]
    if total_ex and r["closure_fallback"] / total_ex > 0.5:
        flags.append(f"warm-closure fell back cold on {r['closure_fallback']}/{total_ex} "
                     f"exchanges — the protocol is not paying here; check why round-1 "
                     f"reviewer agents were not continuable (resume? harness?).")
    return flags


def render_flags(runs):
    out = ["", "=== tuning signals ==="]
    any_flag = False
    for r in runs:
        fl = _run_flags(r)
        if fl:
            any_flag = True
            tag = f"task {r['task']}" if r["task"] is not None else f"#{r['issue']}"
            for f in fl:
                out.append(f"  [{tag}] {f}")
    if not any_flag:
        out.append("  none — no run tripped a tuning threshold (clean plan/fix loops, no escalations).")
    out.append("")
    out.append("Interpret against skills/shared/model-tiering.md §Measurement:")
    out.append("  • rising fix_rounds / escalations on a scope pattern → widen risky-scope or bump that role's effort/model.")
    out.append("  • a reviewer that never FAILs but costs a lot → over-provisioned (but a capped gate can miss findings silently — revert effort caps first if PR quality slips).")
    return "\n".join(out)


def render_aggregate(runs):
    out = ["", f"=== cross-run aggregate ({len(runs)} runs) ==="]
    fr = [r["fix_rounds"] for r in runs if r["fix_rounds"] is not None]
    pr = [r["plan_rounds"] for r in runs if r["plan_rounds"] is not None]
    if fr:
        dist = Counter(fr)
        out.append("fix-rounds distribution: " + "  ".join(f"{k}:{dist[k]}" for k in sorted(dist)))
    if pr:
        dist = Counter(pr)
        out.append("plan-rounds distribution: " + "  ".join(f"{k}:{dist[k]}" for k in sorted(dist)))
    esc = Counter()
    for r in runs:
        for role, v in r["roles"].items():
            if v["escalations"]:
                esc[role] += v["escalations"]
    if esc:
        out.append("escalations by role: " + "  ".join(f"{k}:{c}" for k, c in esc.most_common()))
    cp = Counter(c["reason"] for r in runs for c in r["checkpoints"])
    if cp:
        out.append("checkpoints by reason: " + "  ".join(f"{k}:{c}" for k, c in cp.most_common()))
    wall = sum(r.get("wall_clock_s") or 0 for r in runs)
    if wall:
        seg = {k: sum(r.get(k) or 0 for r in runs) for k in ("seat_busy_s", "operator_wait_s", "session_gap_s", "orchestrator_s")}
        out.append("wall segments across runs: " + "   ".join(
            f"{name} {_fmt_secs(seg[k])} ({seg[k] / wall * 100:.0f}%)" for k, name in
            (("seat_busy_s", "seats busy"), ("operator_wait_s", "operator waits"),
             ("session_gap_s", "session gaps"), ("orchestrator_s", "orchestrator/unattributed"))))
    # Token by role across runs
    tot = defaultdict(lambda: [0, 0])  # role -> [tokens, spawns]
    grand = 0
    for r in runs:
        for role, v in r["roles"].items():
            tot[role][0] += v["tokens"]
            tot[role][1] += v["spawns"]
            grand += v["tokens"]
    if grand:
        out.append("")
        out.append(f"tokens by role across all runs ({_fmt_tok(grand)} total):")
        for role, (tok, spawns) in sorted(tot.items(), key=lambda kv: -kv[1][0]):
            out.append(f"  {role:<30}{_fmt_tok(tok):>10}{tok/grand*100:>6.0f}%   ({spawns} spawns)")
    return "\n".join(out)


def resolve_targets(argv):
    """Return list of jsonl paths from the CLI target."""
    target = argv[0] if argv else "latest"
    default_dir = os.path.join(os.getcwd(), "docs", "plans")
    if target == "latest":
        d = argv[1] if len(argv) > 1 else default_dir
        cands = []
        for g in LOG_GLOBS:
            cands += glob.glob(os.path.join(d, g))
        if not cands:
            return []
        return [max(cands, key=os.path.getmtime)]
    if os.path.isdir(target):
        cands = []
        for g in LOG_GLOBS:
            cands += glob.glob(os.path.join(target, g))
        return sorted(cands, key=os.path.getmtime)
    if os.path.isfile(target):
        return [target]
    # bare 'latest' fallback if target was actually a dir-less default
    cands = []
    for g in LOG_GLOBS:
        cands += glob.glob(os.path.join(default_dir, g))
    return [max(cands, key=os.path.getmtime)] if cands else []


def main():
    argv = sys.argv[1:]
    as_json = False
    if argv and argv[0] == "--json":
        as_json = True
        argv = argv[1:]
    paths = resolve_targets(argv)
    if not paths:
        print("No ship-*.jsonl audit logs found. Point me at a file or a dir "
              "(default: ./docs/plans/).", file=sys.stderr)
        sys.exit(1)

    runs = [analyze_run(p, _load(p)) for p in paths]

    if as_json:
        print(json.dumps({"runs": runs, "flags": {
            str(r["task"] if r["task"] is not None else r["issue"]): _run_flags(r)
            for r in runs
        }},
                         default=str, indent=2))
        return

    for r in runs:
        print(render_run(r))
        print()
    if len(runs) > 1:
        print(render_aggregate(runs))
    print(render_flags(runs))


if __name__ == "__main__":
    main()
