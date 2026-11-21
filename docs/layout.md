# What's in the box

Back to the [README](../README.md).


```text
plugins/shipflow/
  skills/
    ship-task/        the orchestrator (SKILL.md), epic fan-out (epic.md), rationale.md
    cut-task/         create a well-formed issue (Requirements / ACs / Branch / Phases)
    fix-task/         bug-first entry: reproduce, then ship
    plan-task/ review-task-plan/ implement-task/ review-task-code/
                      the same pipeline split into resumable phases, for multi-session work
    review-plan/      the plan-review rubric the plan reviewer scores against
    ship-report/      audit-log post-mortem (report.py)
    sync-branch/ create-worktree/
    shared/           contracts every stage reads: runtime, model tiering, reviewer
                      routing and prompts, scope policy, gates, warm closure, …
  agents/             planners, writers, direction reviewer, and the routed reviewer panel
  scripts/            tracker, sf-route, sf-log, sf-gates, sf-push, sf-sync, sf-codex,
                      sf-runtime, … (zero dependencies, with node:test suites)
  schemas/            JSON schemas for review findings, plan reviews, implement reports
  hooks/              safety guard, seat guard, session-resume (Python, with tests)
.agents/plugins/      generated Codex distribution (do not edit)
scripts/generate-codex.py
```
