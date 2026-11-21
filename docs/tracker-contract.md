# Tracker contract

Back to the [README](../README.md).


shipflow keeps its state (status, sub-issues, comments, follow-ups, PR links) in an issue
tracker, because a run spans hours, machines and humans. It was built and run in production
against **ClickUp**. This version ships pointed at **GitHub Issues**, so it runs straight
off the repo with nothing but `gh`.

Every tracker call in every skill goes through **one CLI with a JSON contract**:
[`plugins/shipflow/scripts/tracker.mjs`](../plugins/shipflow/scripts/tracker.mjs).

| Concept | Contract verb | GitHub implementation |
|---|---|---|
| Task | `task view / create / edit` | Issue (id = issue number) |
| Status | `task status <id> "<status>"` | One `status:<slug>` label. `shipped` / `cancelled` close the issue. |
| Subtask / phase | `task create --parent` | GitHub sub-issue |
| Tag | `tag ensure`, `--tag` | Label |
| Comments | `task comment / comments` | Issue comments, signed `**[<skill> · <context>]**` |
| PR / branch link-back | `task pr / branch` | One sticky "Links" comment, edited in place |

To run shipflow on **ClickUp, Linear, Jira, Asana or anything else**, re-implement those
verbs against that platform's API so they emit the same JSON. Nothing else changes: no
skill, script or agent knows which tracker it's talking to. (The original ClickUp adapter
was this same CLI over ClickUp's REST API, plus two URL custom fields for the PR and branch
links.)
