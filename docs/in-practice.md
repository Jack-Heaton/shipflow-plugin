# In practice: usage numbers and lessons

Back to the [README](../README.md).

These numbers come from a Claude Code usage report covering five weeks of the author's
work, when ship-task was the main delivery path. They cover all Claude Code use in the
period, not only ship-task runs.

| | |
|---|---|
| Sessions | 321 (6,853 messages over 33 days) |
| Commits | 1,073 (+53k / −2k lines) |
| Sub-agent spawns | 2,668 |
| Structured operator questions | 1,025 |
| Parallel sessions | 54% of messages sent while another session was running |
| Session outcomes (99 analyzed) | 61 fully achieved, 26 mostly, 10 partially, 1 not, 1 unclear |

**Where it worked.** The run handled one-line UI fixes and three- and four-phase epics the
same way, ending each in a mergeable PR with every acceptance criterion checked. The reviewer
seats regularly caught high-severity regressions before a human saw the diff, so quality was
enforced by the pipeline rather than by the operator. The operator mostly answered
the workflow's structured questions rather than steering line by line.

**What it taught.** The friction the report found turned into rules in the skill:

- **First-pass code often had real bugs, and a fix round sometimes added a new one.** →
  Fix rounds get a cold regression review, and a defect the change caused is always fixed
  in the same run, never deferred.
- **Agents sometimes reported conclusions they hadn't verified.** → The acceptance table
  needs evidence for every PASS, and anything unchecked is labeled `NOT VERIFIED`.
  Reproduce-first makes a bug fix start from an observed failure.
- **Environment drift broke push gates on code that was actually fine.** Typical causes
  were unlinked packages, stray build output and stale branches. → Preflight measures a
  push-gate baseline on the base branch, so pre-existing failures aren't blamed on the
  change, and `sf-sync` reports how far behind the branch is.
- **Short instructions were sometimes misread.** → The interview policy uses enumerated
  options with the recommendation first, at fixed points in the run.

The natural next step, which the report also points at, is a coordinator that runs the
whole `to do` column overnight. It would start one isolated worktree run per issue and
check overlapping files and migration numbers across runs before they turn into merge
conflicts. The per-run pieces already exist: worktree isolation, migration-collision
detection in `sf-sync`, and the resumable cursor.
