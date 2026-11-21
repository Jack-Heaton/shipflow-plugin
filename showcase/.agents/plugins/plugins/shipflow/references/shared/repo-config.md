# Repo config — `.shipflow.json` (shared reference)

> shipflow serves several repositories. Anything one repository needs that another does
> not — which suites its push hook runs, how it checks a test manifest, where its
> migrations live — is declared by that repository in `<git toplevel>/.shipflow.json`,
> never hardcoded in a plugin script or skill. Executable form: `scripts/sf-config.mjs`
> (`loadRepoConfig(cwd)`). Consumers: `sf-gates.mjs` (push-gate baseline, manifest drift),
> `sf-sync.mjs` (migration collisions), `sf-route.mjs` (`live_check`, `review.cap_exempt`),
> `sf-push.mjs` (`push.verified`).

## Loading rules

- **Gates read the base's copy.** `sf-gates` and `sf-sync` read the file committed at
  `origin/<base>` (`loadRepoConfigAt`), never the branch's, so a diff cannot rewrite the
  checks that judge it; a worktree copy that differs is a warning. No file at the base → the
  repo declares nothing; every consumer skips its check and says so.
- **`sf-push` reads `push.verified` from the base's copy**, like the gates: a branch cannot
  swap the command that pushes it. Undeclared at the base → the built-in
  `git push -u -- <remote> refs/heads/<branch>:refs/heads/<branch>`. Whatever the command reports, `sf-push` compares the
  remote branch tip with the local commit itself before it reports a push as verified.
- **`sf-route classify` reads the copy at `--config-ref`** (ship-task passes
  `origin/<base>`), else at the start of its `--diff` range, else the working tree: the
  `live_check` requirement gates `gh pr ready`, so the branch cannot waive it. A config or
  ref error never stops routing — `classify` reports `live_check.required: true` and lifts
  the panel cap (every routed reviewer seated), with the error in the note, and exits 0.
- **Unknown keys are warnings**, not errors, so a config written for a newer plugin still
  loads under an older vendored copy.
- **Invalid JSON, a wrong type, or a base ref that cannot be read is an error, never
  undeclared.** `sf-gates` exits 2 with no JSON on stdout; `sf-sync` still syncs but reports
  `migrations=error`. The run's error rule is `run-preflight.md` §Push-gate baseline.
- **Commands are argv arrays**, run without a shell: `["npm", "run", "test:gates"]`, never
  `"npm run test:gates"`. A step that needs a shell pipeline belongs in a repo script.
- **Path patterns are JavaScript regex sources** matched against repo-relative POSIX paths
  (the same convention as `sf-route`).

## Schema

| Key | Shape | Used by |
|---|---|---|
| `push_gates.setup` | argv array, optional. Runs once in the scratch base worktree before the suites, with `SF_PARENT_WT` set to the run's worktree (link `node_modules`, build packages); the result then records `linked_deps: true`. | `sf-gates baseline`, `sf-gates run --only` |
| `push_gates.suites[]` | `{ name, run, timeout_ms?, skip_env? }` — the suites the repo's push hook blocks on. `name` is unique; `run` is an argv array; `timeout_ms` defaults to 1,200,000 (a timeout counts as a failure); `skip_env` is the environment variable the push hook honours to skip that suite; it is pinned into the baseline result and the runstate at approval, and never passed to a suite `sf-gates` runs. | `sf-gates baseline`, `sf-gates run`, `sf-gates push-env` |
| `manifest_drift` | `{ name, run }` — the check that the repo's test manifest matches the tree. Exit 0 = no drift; it runs under the suite timeout. | `sf-gates run --set manifest-drift` |
| `migrations[]` | `{ dir, pattern, renumber }` — `dir` is a repo-relative directory; `pattern` matches a migration's repo-relative path and its first capture group is the migration number; `renumber` is the repo's procedure, in prose, for giving a branch-side migration the next free number (what else must change with the file name). | `sf-sync` migration collisions |
| `live_check` | `{ paths, instructions, dev_probe? }`, optional — `paths` is a non-empty array of regex sources; a PR whose prod files match any of them is pipeline work that owes a recorded live dev run (ship-task 3g `## Live dev run`). `instructions` is the repo's recipe for that check on dev — deploy command, trigger, what to read. ship-task runs it itself when the operator picks "smoke-test it for me" (3g §Live smoke), so write it as steps an agent can execute: exact commands, where to find a known-good trigger payload, the log groups or queries that decide pass/fail, and how to confirm the deployed code is the branch's. `dev_probe` is an argv whose exit 0 proves the current credentials reach the dev environment (for example a describe call on a dev-only stack); the smoke option is offered only when it is declared and passes. | `sf-route classify` → `live_check` |
| `push` | `{ verified? }`, optional — `verified` is an argv array: the repo's verified push command. `sf-push` appends `<remote> <branch>` and runs it with `SF_PUSH_LOG` set to the file the command writes its push transcript to. The command must pass its environment to `git push` unchanged: the approved `skip_env` variables and the run inputs `SF_HOOK_RUN_CHECKPOINT` and `SF_HOOK_RANGE_BASE` reach the push hook through it. | `sf-push` |
| `review` | `{ cap_exempt? }`, optional — `cap_exempt` is an array of reviewer names the panel cap never drops (for example a reviewer the repo requires on every UI change). | `sf-route classify` → `reviewers.routed` |

## Example (a TypeScript monorepo — an example, not a default)

```json
{
  "push_gates": {
    "setup": ["bash", "scripts/create-worktree.sh", "--link-only"],
    "suites": [
      { "name": "pre-push-pg", "run": ["npm", "run", "test:pg"], "skip_env": "SF_SKIP_PG_SUITES" },
      { "name": "test-gates", "run": ["npm", "run", "test:gates"], "skip_env": "SF_SKIP_TEST_GATES" },
      { "name": "deploy-plan", "run": ["npm", "run", "deploy-plan"], "timeout_ms": 600000, "skip_env": "SF_SKIP_DEPLOY_PLAN" }
    ]
  },
  "manifest_drift": { "name": "test:gates", "run": ["npm", "run", "test:gates"] },
  "migrations": [
    {
      "dir": "db/migrations",
      "pattern": "^db/migrations/(\\d{4})_[^/]*\\.sql$",
      "renumber": "Rename the branch-side .sql to the next free number and update any migration journal or index that lists it."
    }
  ],
  "live_check": {
    "paths": ["^services/worker/", "^db/migrations/"],
    "instructions": "Deploy the worker to dev, enqueue one fixture job, and confirm it reaches Completed in the worker logs."
  },
  "push": { "verified": ["bash", "scripts/push-verified.sh"] }
}
```

The script names, environment variables and setup command above are illustrative; a
repository's real file is its own change (the push hook must honour each `skip_env`).
