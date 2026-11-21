# Run preflight — environment + plugin registration at Stage 0

Resolve `runtime.md` first. On a **Codex host**, use `sf-runtime check --host codex`
with the working checkout as `--cwd`, then resolve the routed roles and verify the
native subagent and required tool capabilities. Run a repository environment probe
only when it is host-neutral; do not execute the Claude registration snippet or
headless backend probe below. Log `host=codex mode=codex review_backend=codex-native`
and any real capability gaps. Missing Claude CLI, Claude registration or Claude hooks
is not a Codex failure. Required missing roles/tools are a preflight checkpoint.

The snippets below remain the Claude-host preflight, including hybrid runs.

> Canonical snippet for the **environment preflight** every long-running skill
> (`/ship-task`, and `/fix-task` through it) runs at Stage 0, immediately after its
> clean-tree check and before any outward action. Skills reference this file; do not
> fork the snippet into a SKILL.md.

## Why this exists

A repository's `SessionStart` hook (where one exists) runs **once**, when the session
opens. A ship run starts hours later in the same session and regularly outlives what that
hook checked: a cloud-credential session (an SSO token, a short-lived role) valid at
session start is expired by the time Stage 3's acceptance verification needs a live read,
and the run discovers it mid-flight as an empty result rather than a credential error.
Separately, a run whose plugin never registered fails only at its first `sf-*` spawn —
after the task, branch, and worktree already exist — and a run without `gh` auth fails at
its first tracker write. All of these are a ten-second check at Stage 0.

## The snippet (run verbatim, after setting `RUN_LOG`)

The caller sets `RUN_LOG` to its own audit log first (`RUN_LOG="$SHIP_TASK_LOG"`); the
snippet refuses to run without it rather than appending to an empty path.

```bash
# --- Run preflight (skills/shared/run-preflight.md) ---
RUN_LOG="${RUN_LOG:?set RUN_LOG to the audit log of this run before running the preflight snippet}"  # no apostrophes here: bash parses quotes inside \${:?}
PREFLIGHT_FINDINGS=""

# 1. Repo-provided environment preflight, if the repo ships one. It ALWAYS exits 0
#    and prints one line per finding; silent when healthy. This is where a repository
#    checks its own credentials (cloud SSO, database tunnels) and dependency links.
PREFLIGHT_SCRIPT="$(git rev-parse --show-toplevel)/.claude/hooks/preflight.sh"
if [ -x "$PREFLIGHT_SCRIPT" ]; then
  PREFLIGHT_FINDINGS="$("$PREFLIGHT_SCRIPT" 2>/dev/null || true)"
fi

# 2. Toolchain — git, node, jq and an authenticated gh (the tracker adapter and every PR use it).
for bin in git node gh jq; do
  command -v "$bin" >/dev/null 2>&1 || PREFLIGHT_FINDINGS="${PREFLIGHT_FINDINGS:+$PREFLIGHT_FINDINGS
}missing tool: $bin"
done
gh auth status >/dev/null 2>&1 || PREFLIGHT_FINDINGS="${PREFLIGHT_FINDINGS:+$PREFLIGHT_FINDINGS
}gh not authenticated — run gh auth login"

# 3. Plugin registration — every sf-* agent this skill spawns must be installed.
#    Output format (verified): one `<plugin>@<marketplace>` token per installed plugin.
#    A failed enumeration is reported as such, never as "everything missing".
PREFLIGHT_MISSING_PLUGINS=""
PLUGIN_LIST_OK=1
PLUGIN_LIST="$(claude plugin list 2>/dev/null)" || PLUGIN_LIST_OK=0
if [ "$PLUGIN_LIST_OK" = 0 ] || [ -z "$PLUGIN_LIST" ]; then
  echo "PREFLIGHT: cannot enumerate plugins (claude plugin list failed) — registration check skipped"
  PLUGIN_LIST="shipflow@" # treat as present
fi
printf '%s' "$PLUGIN_LIST" | grep -q "shipflow@" || PREFLIGHT_MISSING_PLUGINS="$PREFLIGHT_MISSING_PLUGINS shipflow"

# 4. Hybrid only (HYBRID_MODE != off): the Codex CLI is probed in review-backend.md §Preflight.

if [ -n "$PREFLIGHT_FINDINGS" ]; then printf 'PREFLIGHT findings:\n%s\n' "$PREFLIGHT_FINDINGS"; fi
if [ -n "$PREFLIGHT_MISSING_PLUGINS" ]; then echo "PREFLIGHT: plugins not registered:$PREFLIGHT_MISSING_PLUGINS"; fi
echo "PREFLIGHT: done"   # if/fi, not && — a healthy run must exit 0, not with the status of a skipped echo
```

Then **log the result** to the run's audit log, whatever it was — a clean preflight
that went unrecorded is indistinguishable from one that never ran:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sf-log.mjs" stage preflight \
  findings="$(printf '%s' "$PREFLIGHT_FINDINGS" | jq -Rsc 'split("\n")|map(select(length>0))')" \
  missing_plugins="$(printf '%s' "$PREFLIGHT_MISSING_PLUGINS" | jq -Rsc 'split(" ")|map(select(length>0))')" \
  cloud_creds="${PREFLIGHT_CLOUD_CREDS:-ok}"
```
(`RUN_LOG` must already be exported by the calling skill's Stage 0; `cloud_creds` records
`expired` when the repo hook reported an expired credential, so Stage 3's AC table can
cite it.)

## What to do with the result

| Finding | Action |
|---|---|
| `PREFLIGHT_MISSING_PLUGINS` non-empty | **`CHECKPOINT_REQUIRED: preflight-failed`** (detail: the missing plugin names; recovery: `claude plugin install shipflow@<marketplace>`, then restart the skill). Every later stage spawns these agents; there is no useful work to do without them, and stopping here costs nothing outward. |
| A finding matching `missing tool` or `gh not authenticated` | **`CHECKPOINT_REQUIRED: preflight-failed`** — the tracker adapter, pushes and the PR all need them. Recovery text is in the finding. |
| A finding matching `write-through hazard` or `resolution broken` (match **case-insensitively**: `grep -qiE 'write-through hazard\|resolution broken'`) | **`CHECKPOINT_REQUIRED: preflight-failed`** — the worktree's dependency links are damaged; builds and tests in it are meaningless and `npm install` would corrupt the shared root. Recovery text is in the finding itself. |
| A finding matching `expired` (cloud credentials; case-insensitive) | **Continue, but carry the fact forward.** Most of a run needs no cloud call. Set `PREFLIGHT_CLOUD_CREDS=expired` for the log line above and, at the acceptance-criteria stage, mark any criterion that needs a live cloud/DB read as **`NOT VERIFIED — credentials expired at Stage 0`** rather than attempting it and reading an empty result as a pass. If the operator is present (interactive run), surface the re-auth command once at Stage 0 so they can fix it while the plan stage runs. |
| A finding matching `NO node_modules` or `broken top-level symlink` (case-insensitive) | **Repair here, once, before any seat spawns** (0.33.0). The repo documents the repair in the finding itself (its worktree link script, or `npm install` inside the worktree); run it in the foreground, re-run the preflight script, and log `sf-log stage note event=env-repaired what=node_modules ok=<bool>`. Still broken → `CHECKPOINT_REQUIRED: preflight-failed`. Every seat that spawns into an unlinked worktree rediscovers and reports this at its own price; three of the five most recent measured ledgers opened with it. |
| A finding matching `without dist/` (case-insensitive) | **Kick the package build in the background now** — the command the finding names, e.g. `npx turbo run build --filter='./packages/*' > "$WT_PATH/.pkg-build.log" 2>&1 &` — log `sf-log stage note event=env-repaired what=package-dist background=true`, and let the Stage 3 build gate await it: workspace imports that resolve through `dist/` make every navigation and type read in the plan phase look like a missing symbol in an unbuilt worktree. |
| A finding matching `LSP` absent (child/bridge session) | Informational; every seat prompt already names `node scripts/ts-nav.mjs` as the navigation rung where a repo ships one. Continue. |
| Anything else (stale lock removed, orphaned worktrees) | Informational — already logged; continue. |

The repair rows run wherever the run started — a task cut by `/cut-task`, a branch adopted
at 1B, or a `/fix-task` entry — because preflight is the one step every path shares.

The tokens above are a **contract with the repo hook** (`.claude/hooks/preflight.sh`): a hook that rewords a finding must keep the token, or this table silently
downgrades a damaged worktree to "informational". An unmatched finding is reported verbatim in
the run summary, never swallowed.

`preflight-failed` is a Stage 0 checkpoint: it fires **before** any issue, task, branch, or
worktree is created, so recovery is always "fix the environment, re-invoke".

## Push-gate baseline (ship-task)

A push hook that blocks on a suite already failing on the base stops the run at its first
push, hours in, on a failure the run did not cause. The baseline finds those suites at run
start, so the operator rules on them once while the run works.

- **Kick — in ship-task §Worktree**, where `$RUNSTATE` exists, in the order it states (on an
  adopt, after `init --resume`). Skip it when the runstate already holds `push_gate_skips`:
  the question is settled and a resume never re-runs the suites. Otherwise resolve the output path in the foreground and record it
  before anything runs:
  ```bash
  OUT="$(mktemp -d)/push-gates.json"
  node "$SF/sf-log.mjs" cursor "$RUNSTATE" push_gate_out="$OUT"
  node "$SF/sf-log.mjs" stage note event=push-gate-kick out="$OUT"
  echo "$OUT"
  ```
  Then start `node "$SF/sf-gates.mjs" baseline --cwd "$WT_PATH" --base "$BASE_BRANCH" --out <the printed path>`
  with `run_in_background`, passing the literal path (shell state does not persist). Suite
  logs sit beside it in the `mktemp` directory, never under the repo tree. The suites are
  the base's `push_gates.suites` (`.shipflow.json` read from `origin/<base>`,
  `repo-config.md`); the plugin names no suite itself.
- **Read the result before any push** — a checkpoint push included — and earlier whenever
  the orchestrator is between steps. Still running at a push → wait for it (the background
  task re-invokes on exit). A resume whose runstate has `push_gate_out` but no
  `push_gate_skips`, and whose file is gone, kicks again. Log
  `sf-log stage preflight kind=push-gate-baseline base_sha=<sha> suites='[{"name":…,"pass":…}]' preexisting_failures='["<name>",…]'`,
  then record the outcome with `sf-log cursor "$RUNSTATE"`:
  - `declared:false` (log `push_gates=undeclared`) or no failures → `push_gate_skips='[]'`.
  - Exit 1 (setup failed), exit 2 or no JSON → log `result=unavailable` and record nothing,
    so a resume kicks again; until then every push runs every suite.
  - A non-empty `preexisting_failures` → the question below.
  Every recorded outcome also sets `push_gate_base_sha=<base_sha>`.
- **One question, one approval for the whole run.** A non-empty `preexisting_failures`
  becomes **one** queued blocking question (ship-task §Interview policy; it blocks the next
  push, nothing before it). It names each suite, its log and `<base>` at `<base_sha>`,
  notes `linked_deps:true` (the base run used this worktree's dependencies), and says what
  approval means: pushes skip these suites, and the 3f gate runs each of them once on the
  branch and on the current base, so a failure the base does not share becomes a finding.
  Checking once at 3f rather than before every push is deliberate. Approved →
  `push_gate_skips='[{"name":"<name>","skip_env":"<VAR>"},…]'`, each `skip_env` copied from
  the baseline JSON (a suite without one cannot be skipped and still runs). Declined →
  `push_gate_skips='[]'`. It is never asked again in this run, resumes included.
- **Every push goes through `push-env`.** The 2.7 layer push, the 3g push and checkpoint
  pushes are `node "$SF/sf-push.mjs" --kind layer|final|checkpoint … --runstate "$RUNSTATE"`,
  which adds `push-env`'s variables to the push itself and reports `verified` only when
  the remote branch tip equals the local `HEAD`. Every other `git push` and
  `gh stack submit` the run executes — inline pickup pushes, the stack submit, and the
  pushes in `epic.md` 3E — is written
  `env $(node "$SF/sf-gates.mjs" push-env --runstate "$RUNSTATE") git push …`. `push-env`
  reads only the runstate's pinned `push_gate_skips`, never `.shipflow.json`; with nothing
  recorded it prints nothing, and a missing or corrupt runstate warns and skips nothing.
- **Test arms run once, at the final push.** `sf-push --kind checkpoint|layer --arms skip`
  marks the push a run checkpoint (`SF_HOOK_RUN_CHECKPOINT=1`): a hook that reads the
  input skips its test arms and prints the range still owed. `sf-push --kind final` sends
  `SF_HOOK_RANGE_BASE` — the merge-base of `HEAD` and the base — so the hook then judges
  the run's whole range. `sf-push` reports what the hook did as `test_arms`, read from the
  push transcript; when to pass `--arms skip` and what an owed result means are ship-task
  §CHECKPOINT_REQUIRED and 3g. A repo whose hook reads neither input runs every arm on
  every push.
- **Checkpoints.** A checkpoint that finds a finished baseline with its question unanswered
  asks it through `AskUserQuestion` (logging `operator-wait` first) and records the answer
  before the checkpoint's commit and push (`sf-push --kind checkpoint`). A baseline still
  running → push without skips and report the persistence result (the call's `verified`).
- **Pre-existing is decided per check, never per suite name.** A failing check — each suite
  in `push_gate_skips` at 3f, and a failing manifest-drift check at 3f or the 2.7 layer
  gate — runs on the branch and on the current base. `sf-gates gate` does this inside its
  `drift` job (the comparison
  `node "$SF/sf-gates.mjs" run --set <suites|manifest-drift> --only <name> --cwd "$WT_PATH" --base "$BASE_BRANCH"`
  prints), computes the predicate and reports it as `checks[].verdict`, with both logs and
  `branch_only_failures`.
  It is pre-existing only when the base also fails **and** every failing test identifier in
  the branch log also fails in the base log. Anything else — a branch-only failure, a log
  whose failures cannot be compared, a base run whose setup failed — is a finding (3f:
  bucket 1; 2.7: `epic-layer-build-failed`). Log
  `sf-log stage build-gate scope=<name> result=<pass|fail|preexisting|undeclared|error>`.
- **Errors never pass.** `sf-gates gate`, `sf-gates run` and `sf-sync`'s migration check
  read `.shipflow.json` from `origin/<base>`. Stdout JSON is the result; no JSON (exit 2), a
  config or ref read error, a job or check whose verdict is `error`, or `migrations=error`
  is neither a pass nor undeclared: re-run once, and if it
  persists, 2.7 raises `epic-layer-build-failed` and 3f raises a bucket-1 finding.

## Review backend probe (when `HYBRID_MODE` is `review` or `codex`, or `SHIP_REVIEW_BACKEND=codex`)

Run **after** the snippet above, per `skills/shared/review-backend.md` §Preflight:

```bash
CODEX_PREFLIGHT=""
CODEX_VER="$(codex --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)"
if [ -z "$CODEX_VER" ]; then CODEX_PREFLIGHT="codex CLI not on PATH"
elif [ "$(printf '%s\n0.151\n' "$CODEX_VER" | sort -V | head -1)" != "0.151" ]; then CODEX_PREFLIGHT="codex $CODEX_VER < 0.151"
fi
LOGIN_STATUS="$(codex login status 2>&1)"   # verified on 0.151: prints "Logged in using ChatGPT"; exit code not relied on
case "$LOGIN_STATUS" in *"Logged in"*) ;; *) CODEX_PREFLIGHT="${CODEX_PREFLIGHT:-codex not logged in (run: codex login)}";; esac
if [ -z "$CODEX_PREFLIGHT" ]; then
  SF_CODEX_HOME="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/sf-codex.mjs" home init --run "$(basename "$RUN_LOG" .jsonl)")" \
    && export SF_CODEX_HOME || CODEX_PREFLIGHT="sf-codex home init failed"
fi
```

`home init` also probes the codex Linux sandbox (`codex sandbox -- /bin/true`) and, when
bubblewrap cannot create user namespaces (devcontainers), enables the landlock backend in
the run home; when neither works it switches the reader seats to disposable snapshot
worktrees (`review-backend.md` §Runtime, item 4) and says so on stderr — carry that line into the
`preflight` event's findings. It exits 1 only when `SF_CODEX_SNAPSHOT_FALLBACK=0` — that is
the `home init failed` case above.

Any `CODEX_PREFLIGHT` → `CHECKPOINT_REQUIRED: preflight-failed` with detail `review backend
codex: $CODEX_PREFLIGHT`. The operator chose the backend; a run that silently fell back to
Claude would make every later measurement a lie, and this probe costs seconds before
anything outward exists. Record the choice — on every run, both backends — as
`review_backend=<claude|codex>` on the `preflight` event above (add the key to that
`sf-log stage preflight` call); this is the **only** place the backend is logged.
