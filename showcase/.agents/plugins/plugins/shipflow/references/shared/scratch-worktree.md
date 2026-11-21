# Scratch worktree seeding (shared reference)

> Canonical snippet for giving a parallel writer its **own** worktree without an
> `npm install`. Referenced by `ship-task` 3c (parallel batches) and `epic.md` 3E
> (phase worktrees). Uses the SAME layout as
> `shipflow:create-worktree` (its Safety Rule #5) — keep the three in sync.

Why the shape matters: a blanket symlink of the parent's `node_modules` points
`node_modules/@<scope>` at the **parent's** `packages/*`, so a task that edits a
workspace package cannot see its own edit — its type-check resolves the parent's copy
and reports stale errors (or silently passes against the wrong code). Each scratch tree
therefore gets its own scoped workspace links and shares only third-party.

```bash
# Inputs: $PARENT_WT (the worktree to seed from), $SCRATCH_BRANCH, $SCRATCH_WT (target
# path), $BASE_SHA (commit to cut from).
git worktree add -b "$SCRATCH_BRANCH" "$SCRATCH_WT" "$BASE_SHA"
ROOT_P=$(cd "$PARENT_WT" && pwd -P)
mkdir -p "$SCRATCH_WT/node_modules"
declare -A WS_SCOPE=()
for scope in $(find "$PARENT_WT/node_modules" -mindepth 1 -maxdepth 1 -name '@*' 2>/dev/null); do   # find, not a glob: zsh aborts the whole block on an unmatched glob
  [ -d "$scope" ] || continue
  has_ws=""
  for e in "$scope"/*; do
    [ -L "$e" ] || continue
    t=$(cd "$e" 2>/dev/null && pwd -P) || continue
    case "$t/" in "$ROOT_P"/*) has_ws=1; break;; esac
  done
  # -P preserves relative targets (../../packages/foo) → resolve to THIS worktree.
  [ -n "$has_ws" ] && { cp -RP "$scope" "$SCRATCH_WT/node_modules/"; WS_SCOPE["$(basename "$scope")"]=1; }
done
# Symlink everything else (incl. .bin). Needed even though Node walks up unaided:
# tsconfig typeRoots/paths are relative ../../node_modules/... and otherwise hit a
# nonexistent path → TS2688 "Cannot find type definition file for 'node'".
for e in "$PARENT_WT"/node_modules/*; do
  n="$(basename "$e")"
  [ -n "${WS_SCOPE[$n]:-}" ] && continue
  [ -e "$SCRATCH_WT/node_modules/$n" ] && continue
  ln -s "$e" "$SCRATCH_WT/node_modules/$n"
done
[ -d "$PARENT_WT/node_modules/.bin" ] && [ ! -e "$SCRATCH_WT/node_modules/.bin" ] \
  && ln -s "$PARENT_WT/node_modules/.bin" "$SCRATCH_WT/node_modules/.bin"
unset WS_SCOPE
# Materialize this tree's own gitignored dist/ for its packages. Repo-pinned turbo, not npx.
TURBO="$PARENT_WT/node_modules/.bin/turbo"; [ -x "$TURBO" ] || TURBO="npx turbo"
[ -f "$SCRATCH_WT/turbo.json" ] && ( cd "$SCRATCH_WT" && $TURBO run build --filter='./packages/*' )
```

No `npm install` per scratch tree — third-party is shared from the parent. A task that
genuinely needs isolated dependency versions can run its own install, which replaces
the symlinks with a real tree.

**Integrate** in task order with `git -C "$PARENT_WT" cherry-pick "$BASE_SHA..$SCRATCH_BRANCH"`
(disjoint scopes ⇒ no conflict; a conflict means the disjointness gate was wrong —
abort and checkpoint). **Clean up** with `git worktree remove "$SCRATCH_WT" --force;
git branch -D "$SCRATCH_BRANCH"`.
