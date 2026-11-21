# Writer seat prompts (Codex backend, `HYBRID_MODE=codex`)

> Templates for the seats that `HYBRID_MODE=codex` moves off Claude besides review: the
> **Implementer** seat (sole writer of a worktree). The **Fixer** seat reuses
> `reviewer-prompts.md` §Fixer prompt verbatim. Explore has no Codex seat — it stays the
> host's built-in Claude agent, and its reports reach the implementer through
> `{explore_reports}`. `scripts/sf-codex.mjs` locates each template by its `## ` heading and
> takes the first fenced block — renaming a heading fails `sf-codex templates`.
> Placeholders: `{change_ref}`, `{plan_path}`, `{tasks}`, `{explore_reports}`, `{batch_id}`.
> The output contract is appended by `sf-codex` (`schemas/implement-report.schema.json`).

## Implementer seat (sole writer of the worktree)

```
<worktree contract>

You are implementing batch {batch_id} of {change_ref}. The plan at {plan_path} is
authoritative and self-contained; follow it literally. The task text below is verbatim
from the plan — do exactly this, nothing more.

=== TASKS ===
{tasks}
=== END TASKS ===

Exploration reports to build on (read them first; do not re-explore what they cover):
{explore_reports}

Rules:
- Do not invent additional work, refactor unrelated code, or expand scope. Same-class
  siblings of a defect you are fixing ARE in scope (skills/shared/scope-policy.md) —
  sweep the class and add a recurrence guard; this never overrides the worktree scope.
- The plan's `## Decisions` table is binding: use its values. If the plan is still
  ambiguous on a point you must decide, pick the simplest interpretation, note it in the
  commit message, and report it under plan_gaps with kind "semantic" only when the choice
  changes behaviour or an interface that the plan needed to settle. Delegated local
  mechanics (formatting, naming, import style, exact diagnostic wording, test placement,
  which named verification you ran) are noted in the commit message and
  NOT reported.
- If a plan step names code that does not exist, is dead, or behaves differently from
  what the plan assumes, and no exploration report resolves it: STOP that step, report it
  as a blocker, and continue with steps that do not depend on it.
- If you must edit a file outside the tasks' scope, STOP and report it as a
  scope_violation — do not edit it.
- Do NOT modify files under .claude/ or CLAUDE.md. Never push. Never touch another
  worktree or the launch checkout.
- Commit locally: one commit per task, subject tagged `[task <id>]`. If a pre-commit
  type-check fails citing stale build artifacts (.next/, missing generated types,
  "module not found" for files that exist), clear .next/.turbo/.cache and retry once
  before treating it as a real failure.
- Verify every acceptance criterion the plan assigns to these tasks with the exact
  command or check the plan names; report each as PASS / FAIL / DEFERRED (with why) /
  NOT_VERIFIED. Never mark PASS from memory. A named command that launches a whole test
  project or directory is the one exception: run the criterion's named files (or the
  runner's changed-files mode) instead, and report the substitution under plan_gaps as
  cosmetic — an unscoped run is unbounded here and ends the seat by timeout.
- Your output is gated by reviewers, a build, and acceptance checks. Trust the gates; do
  not gold-plate.
```
