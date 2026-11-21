# Model tiering (shared reference)

Canonical role and effort policy for ship-* and related workflows. Runtime dispatch
is defined in `runtime.md` (hybrid transport in `review-backend.md`); GPT seat assignments live in
`scripts/review-tiers.json`. Claude agent frontmatter supplies Claude defaults.
Model family and execution host are separate choices: a Claude orchestrator may
dispatch GPT workers in hybrid mode; a Codex orchestrator uses GPT workers without
requiring Claude. Never translate a Claude model alias into a GPT effort level.

> **Revision 11 — 2026-09-30 (every Codex seat on `gpt-6.2-sol`; Explore stays Claude):** every
> tier in `scripts/review-tiers.json` runs `gpt-6.2-sol` on the `default` service tier; Terra and
> Luna are retired from the table and no seat runs `priority`. Reviewer efforts hold (`frontier`
> medium, `standard` high, `standard-light` medium). The writer seats — implementer, fixer and
> mop-up — move from Luna / max to Sol / low under the tier renamed `fast-max` → `writer`. The
> Codex Explore seat (`fast` tier, `sf-codex explore`) is removed: Explore runs as the host's
> built-in agent in every `HYBRID_MODE`, so `HYBRID_MODE=codex` now moves review, implementer,
> fixer and mop-up seats only. The `home init` fallback default follows to `gpt-6.2-sol`.
> Operator decision; the writer-effort watch is under §Evidence behind retained writer tiers.

## The principle

Choose a capable model for the decisions the role must make, then choose effort
by the unresolved risk. An important artifact does not automatically require the
maximum effort: plans receive independent review, implementation checks, code
review, and acceptance verification. A clean review is a successful decision.
Single factual lookups need an inline tool call, not another agent.

Keep code writer and substantive review models fixed during the planning-effort
trial. The changes under trial are bounded planning effort, concise plans,
actionable review findings, and limited optional cleanup. Frontmatter effort pins are
part of a run's configuration: compare runs only within one set of pins.

## The table

| Role | Claude | GPT | Effort policy |
|---|---|---|---|
| Orchestrator | Session model | Session model | Preserve the operator's selection; adjudication and operator routing need capable judgment. |
| Plan drafter / plan fixer | Session model (`inherit`) | `gpt-6.2-sol` (`frontier` default) | Medium for bounded work; high for consequential design (below). |
| Plan reviewer | Session model (`inherit`) | `plan-reviewer` tier (`gpt-6.2-sol` / medium) | Claude medium for bounded plans, high for consequential design; retain GPT gate configuration. |
| Direction reviewer | Session model (`inherit`) | Host's native role mapping | Medium for bounded synthesis; high for consequential design. |
| Explore | Built-in `Explore`, session model and effort — in every `HYBRID_MODE` | Codex host only: the host's native agent at `seats['*']` (`gpt-6.2-sol` / medium) | The host's own agent; the brief carries the symbol-tools rule and the plan-conflict tripwire. |
| Implementer / fixer / mop-up | Opus / high | `writer` tier (`gpt-6.2-sol` / low) | Effort is pinned in frontmatter; preserve commit-verification gates. |
| Architecture | Opus, session effort (`general-purpose` spawn) | `standard` tier (`gpt-6.2-sol` / high) | Preserve substantive code-review tier; route only when applicable. |
| Test coverage / cold regression | Role's frontmatter (Opus / medium) | `standard-light` tier (`gpt-6.2-sol` / medium) | Preserve current tiers. |
| Security / routed domain / holistic | Role's frontmatter at medium (Opus; `copy-lead` Sonnet); holistic is template-only, Opus at session effort | Explicit runtime seat mapping | Preserve capable gates; pure Codex uses GPT, never a hidden Claude dependency. |

Performance is retired as a standalone seat. Its template remains for historical
ledgers; relevant checks belong to the routed backend/database reviewers.

Every Claude agent file pins `effort:`. A seat without one runs at whatever effort the
operator's session is set to, so its cost and quality change with a setting the run does
not control. Writers and the `-complex` planning profiles are pinned high; every other
agent is pinned medium. A `general-purpose` or built-in
`Explore` spawn has no agent file and takes the session's effort; `sf-log spawn` records
what served each seat as `model_served` and `effort_served`. Effort names do not carry the
same amount of reasoning across model generations, so re-measure a pin when the model
behind an alias changes.

`SOLO_MODEL` overrides the Claude column for every role except Explore, which stays on
the session model (`runtime.md` §Solo-model fleet). It is an operator choice for the run, not a tier
change, so segment such runs separately in `/ship-report` comparisons.

## Planning effort selection

Use medium when requirements are bounded and existing contracts determine the
design, including mechanical revisions that incorporate confirmed findings. Use
high when the role must resolve architecture, a new cross-module contract, an
authorization or data-integrity model, migration ordering, or an irreversible
choice. Merely touching such a file does not require high if the relevant decision
is already settled. Record the reason when selecting high.

Select effort before a cold spawn. Claude named roles default to `effort: medium`;
for consequential design the runtime selects the matching `-complex` named profile
(`sf-plan-drafter-complex`, `sf-plan-fixer-complex`, `sf-plan-reviewer-complex`, or
`sf-direction-reviewer-complex`). Those profiles use `model: inherit`, `effort: high`,
and load the base role's instructions without duplicating them. GPT planners and
direction review select high through their native runtime; the GPT plan-reviewer
gate remains `gpt-6.2-sol` / medium.
Do not claim that prose instructions or a per-call model override change effort.
When the runtime cannot select the requested effort, report the actual setting
and use the documented adapter fallback; do not silently lower it.

Warm continuations preserve context and normally retain their original model and
effort. A medium `sf-plan-fixer` frontmatter default affects a cold fallback, not a
high-effort drafter's existing thread. Use an in-thread change only when the backend
supports it; do not discard retained context merely to obtain a cheaper setting.
If new consequential design requires a cold escalation, hand off the current plan,
findings, and accepted decisions explicitly and record the reason.

## Review and output discipline

Review the relevant invariant and changed behavior, supported by repository rules
and live evidence. A domain-wide criticality label does not establish that every
edit has the same risk. Findings need a concrete trigger, consequence, and evidence;
uncertain questions and optional improvements do not become mandatory fixes.
Use `review-plan/scoring-rubric.md` for plan severity and `scope-policy.md` for the
LOW cleanup budget. Preserve current correctness, build, and acceptance gates.

Plans specify behavior, interfaces, integrity, and irreversible choices. Delegate
local mechanics to implementers. Short artifacts and targeted warm re-reviews
reduce repeated context without weakening the evidence bar.

## Evidence behind retained writer tiers

The August 31 writer-cap evaluation covered 170 logs, separating full Claude runs
from express and GPT runs. The low-effort population had higher fix-round counts
and no measured token reduction: median implementer tokens were 126,155 versus
109,760 for the earlier Opus sample. Model generations and protocol changes
confounded causality. The low caps were removed; keep them removed pending a new
controlled evaluation. Sonnet remains a possible measured rollback, not an automatic
fallback for failed Opus work.

Run `ship-task-1788363503` recorded defects introduced in four of five Luna/xhigh
fix rounds. Writer seats subsequently moved to Luna/max. That observation does
not prove effort caused the defects, and it was measured on another model. Codex
writer seats now run `gpt-6.2-sol` / low (revision 11): watch fix-introduced
regressions and semantic plan gaps on those seats, and raise their effort before
changing anything else if either rises against revision-10 runs.

## Measurement — and when to revert

Use `/ship-report` and the `spawn-accounting.md` ledger. Record resolved model,
actual effort, runtime mode, active duration, input/output/cache tokens, and billed
cost when available. Token totals alone are not dollar costs. Segment express/full
runs, warm/cold continuations, runtime modes, model versions, and plugin versions (effort
pins) before comparing.

Evaluate roughly six comparable full runs, including plans with known defects.
Compare planning/review cost and duration with confirmed defects, rejected findings,
semantic plan gaps, implementation rework, fix-introduced regressions, checkpoints,
and escaped bugs. Finding count and fix-round count alone cannot measure misses.
Raise planning effort for the affected class if evidence shows a missed consequential
decision; retain concise output and actionable-findings rules. Change model tiers
only in a separate measured trial. Stop tuning when savings are repaid in rework.
