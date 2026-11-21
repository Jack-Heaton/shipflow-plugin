---
name: create-worktree
description: "Create a new git worktree cut from the repo's base branch (the shared sf-base-branch resolver: an explicit override or the workspace's .sf-developer target=, else the integration branch development/develop, else the repo default such as main) and prep it for development. Usage: $create-worktree <branch-name>"
---

> Codex compatibility: this file is generated from the Claude skill source.
> For worker dispatch, read `../../references/shared/runtime.md` and resolve each role with
> `node ../../scripts/sf-runtime.mjs resolve --host codex --role <role>`; use the returned
> GPT model and effort with Codex collaboration tools. Claude model metadata describes the
> Claude backend only. Set `SF_PLUGIN_ROOT` to this plugin's absolute root before running
> shell examples, and resolve `../` references relative to this SKILL.md. Preserve every
> confirmation gate and destructive-operation guard.

# $create-worktree — Create a new git worktree and prep it for development

Create a new worktree under `<repo-root>/.worktrees/`. **Prefer the repo's own
provisioning script** at `scripts/create-worktree.sh` when it exists — the same
script the shipflow `/ship-*` skills call — and fall back to plain `git worktree`
otherwise. Stack-agnostic: never *assume* a project script exists (gate on
`[ -f … ]`), and hardcode no directories. If `$ARGUMENTS` is empty, ask the user for
a branch name.

## Procedure

### 1. Resolve repo root, base branch, and target path

```bash
ROOT=$(git rev-parse --path-format=absolute --git-common-dir)/..; ROOT=$(cd "$ROOT" && pwd)
git fetch origin --quiet 2>/dev/null || true
```

**Resolve the base branch** — the branch new work is cut from — with the shared
resolver, `scripts/sf-base-branch.mjs` (shipflow's own copy; its header documents the
precedence and the `.sf-developer` grammar, and shipflow's `../../references/shared/base-branch.md`
is the full rule). Precedence: an explicit override, then `target=` in this checkout's
`.sf-developer`, then the integration branch (`development`, then `develop`), then the
repo default (`origin/HEAD`), then `main`/`master`/`trunk`, then — for this skill only —
the current branch. An override that is not on origin is a hard stop, never a silent
fallback: the resolver names the branch and where it was set.

```bash
DEFAULT=$(node "../../scripts/sf-base-branch.mjs" --allow-current) || { echo "ERROR: no usable base branch (see the message above); nothing was created."; exit 1; }
echo "Base branch resolved to: $DEFAULT"
```

If the resolver exits non-zero, stop and relay its message — push the named branch or
correct the setting, then `git fetch origin` and re-run. Never substitute a default
branch.

The branch name is `$ARGUMENTS`. Derive the directory name by replacing `/` with `-`:
`DIR="${BRANCH//\//-}"` and target `WORKTREE="$ROOT/.worktrees/$DIR"`.

Refuse if `$WORKTREE` already exists — tell the user to remove it
(`git worktree remove "$WORKTREE"`) or pick another name.

### 1.5. Branch-name validity + namespace-collision guard

Git stores branches as files under `refs/heads/`, so a bare ref and a namespaced ref **cannot coexist**: if `refactor` exists as a branch, `git` refuses to create `refactor/foo` (it would need `refactor` to be a directory), and vice-versa. This collision silently fails `git worktree add -b` and costs a retry. Catch it before creating.

```bash
# (a) The name must be a well-formed ref.
if ! git check-ref-format --branch "$BRANCH" >/dev/null 2>&1; then
  echo "ERROR: '$BRANCH' is not a valid branch name."; exit 1
fi

# (b) An EXISTING ref must not occupy this name's namespace (or be occupied BY it).
#     Compare against both local and remote refs.
CONFLICT=""
while IFS= read -r ref; do
  [ -z "$ref" ] && continue
  [ "$ref" = "$BRANCH" ] && continue   # exact match = attach, handled in Step 3 (not a conflict)
  # ref is an ancestor namespace of BRANCH (e.g. ref="refactor", BRANCH="refactor/foo")
  case "$BRANCH/" in "$ref/"*) CONFLICT="$ref (blocks the '$BRANCH' namespace)"; break;; esac
  # BRANCH is an ancestor namespace of ref (e.g. BRANCH="refactor", ref="refactor/foo")
  case "$ref/" in "$BRANCH/"*) CONFLICT="$ref (lives under the '$BRANCH' namespace)"; break;; esac
done <<EOF
$(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes/origin | sed 's@^origin/@@' | sort -u)
EOF

if [ -n "$CONFLICT" ]; then
  echo "ERROR: branch name '$BRANCH' collides with existing ref: $CONFLICT"
  exit 1
fi
```

If a collision is found, stop and tell the user the conflicting ref, and suggest either a different name or removing/renaming the conflicting branch (e.g. `git branch -m refactor refactor/legacy`). Do **not** auto-rename existing branches.

*Note: attaching to a branch that already exists under this exact name is fine (Step 3 handles that) — this guard only blocks names that conflict with a **different** ref's namespace.*

### 1.6. Developer name and target (asked once, before anything is created)

Read the launch checkout's `.sf-developer` settings:

```bash
SETTINGS=$(node "../../scripts/sf-base-branch.mjs" --settings) || { echo "ERROR: .sf-developer is invalid (see the message above); nothing was created."; exit 1; }
LAUNCH_DEV=$(node -p 'JSON.parse(process.argv[1]).developer ?? ""' "$SETTINGS")
LAUNCH_TARGET=$(node -p 'JSON.parse(process.argv[1]).target ?? ""' "$SETTINGS")
```

When `$LAUNCH_DEV` is non-empty, ask one the available structured user-input tool before creating the worktree:
**Inherit `<LAUNCH_DEV>`** (recommended — the worktree shares the `-dev-<name>` developer
stacks), **New name** (then ask for it), or **No name**. Set `DEV_NAME` to the answer
(empty for no name). With no launch name, `DEV_NAME` stays empty and nothing is asked.

`target=` is inherited without asking: `WT_TARGET="${WT_TARGET:-$LAUNCH_TARGET}"`. A calling
skill that picked the base up from a run's recorded base or a task body sets `WT_TARGET`
to that base before running these steps, so the new worktree records it (shipflow
`../../references/shared/base-branch.md` §Pickup rule). A base override the operator exported in
the environment is never written to the file.

### 2. Fetch (non-fatal)

```bash
git fetch origin 2>&1 || echo "WARN: fetch failed — using local refs"
```

Prefer `origin/$DEFAULT` as the base if it exists; otherwise fall back to the local
`$DEFAULT` ref.

### 3. Create the worktree — prefer the repo's provisioning script

If the repo ships its own worktree-provisioning script at `scripts/create-worktree.sh`,
**call it instead of reimplementing** the creation + prep. It is the same script the
shipflow `/ship-*` skills invoke, and it carries repo-specific prep (env copying,
workspace-package linking, turbo-cache sharing, package build, dev-port pre-seed) that
a generic `git worktree add` does not. The Step 1.5 namespace guard above still runs
first — the script has no such guard, so running it here is a genuine pre-check.

```bash
if [ -f scripts/create-worktree.sh ]; then
  # LONG-RUNNING on a large monorepo (a node_modules link farm + a turbo package
  # build). It can exceed a short (~2-min) foreground exec cap and get SIGTERM'd
  # mid-provision, leaving a half-built worktree that breaks downstream work. Invoke
  # it so a short timeout can't kill it: run it in the background (run_in_background)
  # and wait for completion, or with a generous explicit timeout — never a default
  # foreground call. Pass --no-push to keep the branch local (the script otherwise
  # pushes + sets upstream); ask the user before allowing that push.
  # The script inherits the launch checkout's target= itself; the name comes only
  # through --developer (Step 1.6).
  bash scripts/create-worktree.sh "$BRANCH" ${DEV_NAME:+--developer "$DEV_NAME"}
  # Verify provisioning actually finished — do NOT continue on a half-built tree.
  # If interrupted, remove the partial and re-run:
  #   git worktree remove --force "$WORKTREE" 2>/dev/null; rm -rf "$WORKTREE"
  if [ ! -d "$WORKTREE/node_modules/.bin" ]; then
    echo "ERROR: worktree provisioning incomplete at $WORKTREE (node_modules/.bin missing)"; exit 1
  fi
else
  # Fallback: plain git worktree. Attach if the branch already exists locally or on
  # origin; otherwise create it from the resolved base.
  if git show-ref --verify --quiet "refs/heads/$BRANCH" || git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
    git worktree add "$WORKTREE" "$BRANCH"
  else
    git worktree add -b "$BRANCH" "$WORKTREE" "$BASE"   # BASE = origin/$DEFAULT or $DEFAULT
  fi
  # .sf-developer: the name line first, then target= (the grammar in sf-base-branch.mjs).
  # Written only when there is something to write.
  if [ -n "$DEV_NAME" ] || [ -n "$WT_TARGET" ]; then
    {
      [ -n "$DEV_NAME" ] && printf '%s\n' "$DEV_NAME"
      [ -n "$WT_TARGET" ] && printf 'target=%s\n' "$WT_TARGET"
    } > "$WORKTREE/.sf-developer"
  fi
fi
```

The script may cut its branch from a fixed base (e.g. `origin/development`) rather than
the base resolved in Step 1. When that base differs from `$DEFAULT`, base-correct a
**freshly created** branch only — never a reused one carrying its own work — exactly as
the `/ship-*` skills do: `git -C "$WORKTREE" reset --hard "origin/$DEFAULT"` when the
branch has no `origin/$BRANCH` counterpart and no local-only commits, otherwise
`git -C "$WORKTREE" merge --no-edit "origin/$DEFAULT"`.

### 4. Prep (env hoist always; deps/linking/push are fallback-path only — detect, don't assume)

Before any prep or other follow-on work, **adopt the new worktree as the active
working directory**:

```bash
cd "$WORKTREE"
pwd
```

Verify `pwd` is exactly `$WORKTREE`. All subsequent shell/tool calls in this skill
and any work continued after it must run with `$WORKTREE` as their working directory
(or use `git -C "$WORKTREE" ...` for an isolated git command). A `cd` inside one
shell invocation does not persist into a later Codex tool call, so set that call's
`workdir`/`cwd` to `$WORKTREE`; do not rely on the launch directory's current branch.

- **Env files (ALWAYS — run on both paths):** recursively hoist every local
  environment file from the main worktree into the new worktree, preserving each
  file's relative path so it lands in its correct spot. Run this **even when
  `scripts/create-worktree.sh` provisioned the tree** — that script copies only a
  fixed set of locations, so the recursive hoist backfills any it missed. It never
  overwrites an existing destination, so re-running it after the script is safe, and
  copied files land at paths the repo's `.gitignore` already ignores (the eligibility
  filter below only copies files git already treats as ignored + untracked), so they
  stay git-ignored in the worktree. Do not ask for confirmation. A file is eligible
  only when all of these are true:
  - its basename is `.env` or starts with `.env.`;
  - it is untracked and `git check-ignore` reports it as ignored;
  - it is outside `.git/`, `.worktrees/`, and every `node_modules/` directory; and
  - its basename does not end in `.example`, `.sample`, `.template`, or
    `.worktree` (worktree-specific state must be regenerated).

  Never overwrite a destination file. Report each copied relative path without
  printing file contents. Use this bounded procedure so ignored files unrelated to
  environment configuration are never copied:

  ```bash
  ENV_COPIED=()
  while IFS= read -r -d '' source; do
    relative=${source#"$ROOT"/}
    basename=${relative##*/}

    case "$relative" in
      .git/*|.worktrees/*|node_modules/*|*/node_modules/*) continue ;;
    esac
    case "$basename" in
      .env|.env.*) ;;
      *) continue ;;
    esac
    case "$basename" in
      *.example|*.sample|*.template|*.worktree) continue ;;
    esac

    git -C "$ROOT" check-ignore --quiet -- "$relative" || continue
    if git -C "$ROOT" ls-files --error-unmatch -- "$relative" >/dev/null 2>&1; then
      continue
    fi

    destination="$WORKTREE/$relative"
    if [ -e "$destination" ]; then
      echo "Env file: skipped existing $relative"
      continue
    fi

    mkdir -p "$(dirname "$destination")"
    cp -p -- "$source" "$destination"
    ENV_COPIED+=("$relative")
    echo "Env file: copied $relative"
  done < <(
    find "$ROOT" \
      \( -path "$ROOT/.git" -o -path "$ROOT/.worktrees" -o -name node_modules \) -prune -o \
      -type f \( -name .env -o -name '.env.*' \) -print0
  )
  ```
The remaining prep below is **fallback-path only.** When `scripts/create-worktree.sh`
provisioned the tree it already installed dependencies, linked + built the workspace
packages, shared the turbo cache, and (unless `--no-push`) pushed the branch — skip
straight to Step 5 after the env hoist. Run the bullets below only on the plain
`git worktree` path.

- **Dependencies:** detect a package manager only if a lockfile is present at the
  repo root, then install:
  - `pnpm-lock.yaml` → `pnpm install`
  - `yarn.lock` → `yarn install`
  - `package-lock.json` → `npm install`
  - `bun.lockb` → `bun install`

  Skip dependency install entirely if no lockfile is found (e.g. non-JS repos).
- **Workspace package linking (workspace monorepos):** after deps are installed,
  shadow the repo's internal workspace packages inside the new worktree so their
  imports resolve to **this** worktree's code, not the base branch's. Gated behind
  detection — a silent no-op on non-workspace repos. See Safety Rule #5 for the
  invariants this code must preserve.

  ```bash
  # --- Workspace package linking (npm/yarn-style workspace monorepos only) ---
  # WHY: a fresh worktree has no node_modules/@<scope> entries, so workspace imports
  # (e.g. import ... from "@scope/pkg") resolve UP the tree to the ROOT checkout's
  # node_modules, whose relative symlinks point back to the ROOT's packages/* — i.e.
  # the BASE branch's code, serving stale, gitignored dist/. That silently runs the
  # wrong branch's compiled output (no error — just wrong types/behaviour). Fix:
  # shadow the workspace package symlinks in the worktree so they resolve to ITS
  # own packages/*.

  # 1. Detect — skip silently unless this is a workspace monorepo: root package.json
  #    declares `workspaces` AND root node_modules has an @scope/* entry that is a
  #    symlink resolving back inside the repo.
  ROOT_P=$(cd "$ROOT" && pwd -P)
  IS_WORKSPACE=""
  if [ -f "$ROOT/package.json" ] && grep -q '"workspaces"' "$ROOT/package.json"; then
    for e in "$ROOT"/node_modules/@*/*; do
      [ -L "$e" ] || continue
      t=$(cd "$e" 2>/dev/null && pwd -P) || continue
      case "$t/" in "$ROOT_P"/*) IS_WORKSPACE=1; break;; esac
    done
  fi

  WS_STATUS="n/a (not a workspace monorepo)"
  if [ -n "$IS_WORKSPACE" ]; then
    # 2. Shadow ONLY the scoped workspace packages, preserving symlinks (-P). Their
    #    targets are relative (../../packages/foo), so the copied links resolve to
    #    THIS worktree's packages/*. Third-party deps and .bin deliberately fall
    #    through to the root node_modules (identical across branches) — so do NOT
    #    copy all of node_modules. INVARIANTS (see Safety Rule #5 — do not regress):
    #      * NEVER `cp -R` the whole node_modules — gigabytes/worktree, pointless.
    #      * ALWAYS `-P` (no-dereference) — a plain `cp -R` turns the workspace and
    #        .bin symlinks into stale physical copies, breaking tsc/turbo/pre-push
    #        and re-introducing the stale-package bug.
    #      * `npm install` is NOT a substitute — it recreates the symlinks but does
    #        NOT build dist/, so imports still fail until a build runs. Copy+build is
    #        both correct and far faster (no network).
    mkdir -p "$WORKTREE/node_modules"
    for scope in $(find "$ROOT/node_modules" -mindepth 1 -maxdepth 1 -name '@*' 2>/dev/null); do   # find, not a glob: zsh aborts the whole block on an unmatched glob
      [ -d "$scope" ] || continue
      has_ws=""
      for e in "$scope"/*; do
        [ -L "$e" ] || continue
        t=$(cd "$e" 2>/dev/null && pwd -P) || continue
        case "$t/" in "$ROOT_P"/*) has_ws=1; break;; esac
      done
      # copy the whole scope dir (preserving symlinks) only when it holds a workspace pkg
      [ -n "$has_ws" ] && cp -RP "$scope" "$WORKTREE/node_modules/"
    done

    # 3. Build the workspace packages so their gitignored dist/ exists in the worktree.
    #    The worktree has no node_modules/.bin, so a bare `npx turbo` falls through to
    #    a globally installed turbo (version drift) or a network fetch — use the ROOT
    #    checkout's repo-pinned binary when it exists.
    TURBO="$ROOT/node_modules/.bin/turbo"; [ -x "$TURBO" ] || TURBO="npx turbo"
    if [ -f "$WORKTREE/turbo.json" ]; then
      ( cd "$WORKTREE" && $TURBO run build --filter='./packages/*' ) \
        && WS_STATUS="linked + built (turbo)" \
        || WS_STATUS="linked; build FAILED — run the package build before type-check"
    else
      WS_STATUS="linked; no turbo.json — build the packages' dist/ before type-check"
    fi
  fi
  echo "Workspace packages: $WS_STATUS"
  ```
- **Push (optional):** ask before pushing. If the user wants a remote tracking branch:
  `cd "$WORKTREE" && git push --set-upstream origin "$BRANCH"`.

### 5. Report

Report the branch, the base it was cut from, the developer name and `target=` the worktree
received (or "none"), the active worktree path, whether env files
were copied, whether deps were installed, whether workspace packages were linked +
built (the `$WS_STATUS` value — `n/a` on non-workspace repos), and the remote
tracking branch (if pushed). State that subsequent work will run from `$WORKTREE`;
do not present changing directory as a step the user still needs to perform.

## Safety Rules

1. **Prefer the repo's provisioning script; fall back to `git worktree`.** When
   `scripts/create-worktree.sh` exists, call it (it is the same script `/ship-*`
   uses) rather than reimplementing its repo-specific prep; otherwise use plain
   `git worktree`. Never *assume* the script exists — gate on `[ -f … ]`. The
   recursive env-file hoist runs on **both** paths.
2. **Detect, don't assume** — copy only allowlisted environment files proven ignored
   and untracked; install dependencies only when a lockfile identifies the package
   manager; push only after user confirmation.
3. **Never overwrite** — refuse if the target worktree directory already exists.
4. **Fetch is non-fatal; a missing base is fatal** — offline/auth failures must not block
   worktree creation, but a base-branch override that is not on origin stops it (Step 1).
5. **Workspace linking: copy symlinks, never full-copy, never `npm install` instead.**
   When shadowing workspace packages into a worktree, copy **only** the scoped
   workspace package dirs and **always** with `cp -RP` (no-dereference). Never
   `cp -R` the whole `node_modules` (gigabytes per worktree, pointless), and never
   drop the `-P` (a plain `cp -R` dereferences the workspace/`.bin` symlinks into
   stale physical copies, breaking `tsc`/turbo/pre-push and re-introducing the
   stale-package bug). `npm install` is **not** a substitute — it recreates the
   symlinks but does not build `dist/`; the copy-symlinks-then-build path is both
   correct and faster. Keep the whole step gated behind detection so it stays a
   no-op on non-workspace repos.
6. **Never symlink a scope directory or `.bin` into the shared install.**
   Some repos need more than the workspace scopes shadowed: tsconfig `typeRoots` and
   `paths` written as relative `../../node_modules/...` resolve, from a worktree, to
   a path that does not otherwise exist, so every stack fails type-check with TS2688
   until third-party entries are present. If you extend the linking step to cover
   them, link **individual packages** — never the directories that contain them.

   Symlinking a *package* dir is safe: anything replacing `node_modules/react`
   renames or unlinks the symlink itself and the shared copy is untouched.
   Symlinking a *scope* dir is not. `node_modules/@swc` as a link means every write
   to `node_modules/@swc/helpers` lands inside the SHARED install, because the tool
   descends THROUGH the link before it touches anything. `.bin` has the same shape —
   npm writes shims into it.

   This is not theoretical. One `npm install` inside such a worktree deleted ~130
   packages out of the shared checkout (`@swc/helpers`, `@babel/core`, a dozen
   `@scope/*` SDK clients, `@playwright/test`, …), breaking
   builds in the shared checkout and in every other worktree at once — silently, with
   the install reporting success.

   The safe shape is a real local directory holding one symlink per entry:

   ```
   node_modules/@scope/          real dir
   node_modules/@scope/pkg   ->  <shared>/node_modules/@scope/pkg
   node_modules/.bin/            real dir
   node_modules/.bin/tsc     ->  <shared>/node_modules/.bin/tsc
   ```

   It costs ~0 bytes and makes `npm install` inside a worktree do what it should:
   build a full local tree for that worktree alone. **Assert it** — a symlinked scope
   dir or `.bin` in the finished worktree is a hard failure, not a warning, because
   the damage it causes is silent and repo-wide.
7. **Stay in the worktree after creation.** Immediately adopt `$WORKTREE` as the
   active working directory. Every later Codex tool call must set its `workdir`/`cwd`
   to `$WORKTREE`; a shell-local `cd` is not sufficient for the next call.
