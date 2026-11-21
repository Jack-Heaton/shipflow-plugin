#!/usr/bin/env node
/**
 * @file sf-sync.mjs
 * @description One-call integration sync for the shipflow ship-* skills: fetch the base branch,
 *   measure how far behind the tree is, merge (or, for a phase branch, probe with merge-tree),
 *   log the `integration-sync` ledger event, and print the values the caller needs
 *   ($SYNC_BEFORE, $BEHIND, $CONFLICTS, $REVIEW_BASELINE, $PROBE). skills/shared/integration-sync.md
 *   is the contract; this is its executable form. Zero dependencies.
 * @domain workflow-integration-sync
 *
 * Usage:
 *   sf-sync --cwd <worktree> --base <branch> --at <1b|3d|3e|3f|3g|layer|phase|resume>
 *           [--layer <k>] [--probe] [--remote origin] [--export] [--no-log]
 *
 * Why a script: the sync was a nine-line bash block the orchestrator had to paste at every
 * boundary, and ship-task-1788826709 shows what that buys — the orchestrator ran a bare
 * `git rev-list --count` at 3d/3f/3g, never merged, never logged, and /ship-report flagged the run
 * as unsynced. One command, one event, no paste.
 *
 * Behaviour:
 *   - `--at phase` or `--probe`: read-only `git merge-tree --write-tree` (git >= 2.38); the tree
 *     and $REVIEW_BASELINE are untouched. When merge-tree is unavailable: conflicts=-1, probe=none.
 *   - otherwise: behind > 0 -> `git merge --no-edit origin/<base>`. A conflicted merge is LEFT IN
 *     PROGRESS (merge_in_progress:true, conflicts = unmerged file count) for the caller's conflict
 *     rule (integration-sync.md §Conflict rule) — resolve or `git merge --abort`.
 *   - always recomputes review_baseline = merge-base(HEAD, origin/<base>) after a merge.
 *   - when the base's `.shipflow.json` (read from <remote>/<base>, never the branch) declares
 *     `migrations`, reports migration-number collisions between the branch and <remote>/<base>
 *     (merge and probe paths alike) — integration-sync.md §Migration collisions. A config or
 *     ls-tree error never reads as 0 collisions: `migrations:"error"`, a warning, and
 *     `migrations=error` on the event; the sync itself still runs.
 *   - logs `sf-log stage integration-sync at= behind= conflicts= [probe=1] [layer=]
 *     [migration_collisions=] [migrations=error]` when $RUN_LOG is set (or --log), unless --no-log.
 * Output: one JSON line (default) or, with --export, shell assignments for `eval "$(sf-sync …)"`.
 * Exit: 0 clean (merged or nothing to do or probe clean); 3 conflicts (merge in progress, or probe
 * conflict); 2 usage error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, loadRepoConfigAt } from './sf-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SF_LOG = join(HERE, 'sf-log.mjs');
const SYNC_POINTS = new Set(['1b', '3d', '3e', '3f', '3g', 'layer', 'phase', 'resume']);

function die(msg, code = 2) {
  process.stderr.write(`sf-sync: ${msg}\n`);
  process.exit(code);
}
const warn = (msg) => process.stderr.write(`sf-sync: warning: ${msg}\n`);

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) die(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (['probe', 'export', 'no-log', 'help'].includes(key)) { flags[key] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) die(`--${key} needs a value`);
    flags[key] = v;
    i += 1;
  }
  return flags;
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}
function gitOk(cwd, args) {
  try { execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); return true; } catch { return false; }
}

const HELP = `sf-sync — integration sync for shipflow ship-* runs (skills/shared/integration-sync.md)

  sf-sync --cwd <worktree> --base <branch> --at <${[...SYNC_POINTS].join('|')}>
          [--layer <k>] [--probe] [--remote origin] [--export] [--no-log] [--log <path>]

  Prints {at, behind, conflicts, probe, merged, merge_in_progress, sync_before, head,
  review_baseline, layer, logged, migrations[, migration_collisions, base_duplicates]} — or,
  with --export, SYNC_BEFORE= BEHIND= CONFLICTS= REVIEW_BASELINE= PROBE= SYNC_HEAD= SYNC_MERGED=
  MIGRATIONS= MIGRATION_COLLISIONS= MIGRATION_COLLISIONS_JSON= lines for eval. migrations is
  declared | undeclared | error (the base's .shipflow.json); migration_collisions (an array of
  {number, dir, base, branch}) and base_duplicates appear only when declared;
  MIGRATION_COLLISIONS is their count (0 when undeclared or error — read MIGRATIONS).
  Exit 0 clean, 3 conflicts, 2 usage.
`;

// --full-tree/--full-name: `dir` and the output are repo-relative whatever --cwd is. A git
// error throws: an unreadable tree must never read as "no migrations".
function listTree(cwd, treeish, dir) {
  try {
    return git(cwd, ['ls-tree', '-r', '--full-tree', '--full-name', '--name-only', treeish, '--', dir]).split('\n').filter(Boolean);
  } catch (e) {
    throw new Error(`git ls-tree ${treeish} -- ${dir} failed: ${`${e.stderr || e.message}`.trim()}`);
  }
}

/**
 * Migration numbers claimed by more than one path across HEAD ∪ <ref>, per declared dir. A
 * collision needs at least one branch-side path (absent from the base tree): a number whose paths
 * all sit in the base is a pre-existing duplicate the branch did not cause, reported, never gated.
 */
export function migrationCollisions(cwd, ref, migrations) {
  const collisions = [];
  const baseDuplicates = [];
  for (const m of migrations) {
    const re = new RegExp(m.pattern);
    const basePaths = new Set(listTree(cwd, ref, m.dir));
    const union = new Set([...listTree(cwd, 'HEAD', m.dir), ...basePaths]);
    const byNumber = new Map();
    for (const p of [...union].sort()) {
      const hit = re.exec(p);
      if (!hit || hit[1] === undefined) continue;
      if (!byNumber.has(hit[1])) byNumber.set(hit[1], []);
      byNumber.get(hit[1]).push(p);
    }
    for (const [number, paths] of byNumber) {
      if (paths.length < 2) continue;
      const branch = paths.filter((p) => !basePaths.has(p));
      const base = paths.filter((p) => basePaths.has(p));
      if (branch.length > 0) collisions.push({ number, dir: m.dir, base, branch });
      else baseDuplicates.push({ number, dir: m.dir, paths });
    }
  }
  return { collisions, baseDuplicates };
}

/** The base's declared migrations: { migrations } | { migrations: null } (undeclared) | { error }. */
function declaredMigrations(cwd, ref) {
  let loaded;
  try { loaded = loadRepoConfigAt(cwd, ref); } catch (e) { return { error: e.message }; }
  for (const w of loaded.warnings) warn(w);
  let wtText = null;
  try { wtText = readFileSync(join(git(cwd, ['rev-parse', '--show-toplevel']), CONFIG_FILE), 'utf8'); } catch { /* absent */ }
  if (wtText !== (loaded.text ?? null)) warn(`the worktree's ${CONFIG_FILE} differs from ${ref}'s; the collision check uses ${ref}'s`);
  const m = loaded.config.migrations;
  return { migrations: Array.isArray(m) && m.length ? m : null };
}

export function sync({ cwd, base, at, layer, probe, remote = 'origin', log = true, logPath }) {
  if (!cwd || !existsSync(cwd)) die(`--cwd ${cwd} does not exist`);
  if (!base) die('--base <branch> is required');
  if (!SYNC_POINTS.has(at)) die(`--at must be one of ${[...SYNC_POINTS].join(', ')} (got ${JSON.stringify(at)})`);
  if (at === 'layer' && (layer === undefined || layer === '')) die('--layer <k> is required at=layer');
  const doProbe = probe || at === 'phase';
  const ref = `${remote}/${base}`;

  try { git(cwd, ['fetch', '-q', remote, base]); } catch (e) { die(`fetch ${remote} ${base} failed: ${e.stderr || e.message}`); }
  const syncBefore = git(cwd, ['rev-parse', 'HEAD']);
  const behind = Number(git(cwd, ['rev-list', '--count', `HEAD..${ref}`]));

  const out = { at, behind, conflicts: 0, probe: 'none', merged: false, merge_in_progress: false, sync_before: syncBefore, head: syncBefore, review_baseline: null, layer: layer === undefined ? null : Number(layer), logged: false };

  if (doProbe) {
    if (behind > 0) {
      let tree = null;
      try {
        tree = execFileSync('git', ['-C', cwd, 'merge-tree', '--write-tree', ref, 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        out.probe = 'clean';
      } catch (e) {
        const text = `${e.stdout || ''}`;
        const usage = /usage:|unknown option|not a git command/i.test(`${e.stderr || ''}`);
        if (usage || e.status === 129) { out.probe = 'none'; out.conflicts = -1; warn('git merge-tree --write-tree unavailable (git < 2.38): conflicts=-1, fall through to a merge at the next non-phase point'); }
        else { out.probe = 'conflict'; out.conflicts = (text.match(/^CONFLICT/gm) || []).length || 1; }
      }
      void tree;
    } else {
      out.probe = 'clean';
    }
  } else if (behind > 0) {
    if (gitOk(cwd, ['merge', '--no-edit', ref])) {
      out.merged = true;
    } else {
      const unmerged = git(cwd, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      out.conflicts = unmerged.length || 1;
      out.merge_in_progress = true;
    }
    out.head = git(cwd, ['rev-parse', 'HEAD']);
  }
  out.review_baseline = git(cwd, ['merge-base', 'HEAD', ref]);

  const declared = declaredMigrations(cwd, ref);
  let migrationsError = declared.error ?? null;
  out.migrations = 'undeclared';
  if (!migrationsError && declared.migrations) {
    try {
      const { collisions, baseDuplicates } = migrationCollisions(cwd, ref, declared.migrations);
      out.migrations = 'declared';
      out.migration_collisions = collisions;
      out.base_duplicates = baseDuplicates;
    } catch (e) { migrationsError = e.message; }
  }
  if (migrationsError) {
    out.migrations = 'error';
    out.migrations_error = migrationsError;
    warn(`migration collision check failed: ${migrationsError}`);
  }

  const runLog = logPath || process.env.RUN_LOG;
  if (log && runLog) {
    const kv = ['stage', 'integration-sync', `at=${at}`, `behind=${behind}`, `conflicts=${out.conflicts}`];
    if (doProbe) kv.push('probe=1');
    if (layer !== undefined && layer !== '') kv.push(`layer=${layer}`);
    if (out.merged) kv.push(`merge_commit=${out.head}`);
    if (out.migration_collisions) kv.push(`migration_collisions=${out.migration_collisions.length}`);
    if (out.migrations === 'error') kv.push('migrations=error');
    try {
      execFileSync(process.execPath, [SF_LOG, ...kv, '--log', runLog], { stdio: ['ignore', 'ignore', 'inherit'] });
      out.logged = true;
    } catch (e) { warn(`sf-log integration-sync failed: ${e.message}`); }
  } else if (log && !runLog) {
    warn('RUN_LOG is not set — the sync ran but no integration-sync event was written');
  }
  return out;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || process.argv.length === 2) { process.stdout.write(HELP); return 0; }
  const out = sync({
    cwd: flags.cwd ? resolve(flags.cwd) : null, base: flags.base, at: flags.at, layer: flags.layer,
    probe: !!flags.probe, remote: flags.remote || 'origin', log: !flags['no-log'], logPath: flags.log,
  });
  if (flags.export) {
    const sh = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    process.stdout.write([
      `SYNC_BEFORE=${sh(out.sync_before)}`, `BEHIND=${sh(out.behind)}`, `CONFLICTS=${sh(out.conflicts)}`,
      `REVIEW_BASELINE=${sh(out.review_baseline)}`, `PROBE=${sh(out.probe)}`, `SYNC_HEAD=${sh(out.head)}`,
      `SYNC_MERGED=${sh(out.merged ? 1 : 0)}`, `MIGRATIONS=${sh(out.migrations)}`,
      `MIGRATION_COLLISIONS=${sh(out.migration_collisions ? out.migration_collisions.length : 0)}`,
      `MIGRATION_COLLISIONS_JSON=${sh(JSON.stringify(out.migration_collisions ?? []))}`,
    ].join('\n') + '\n');
  } else {
    process.stdout.write(`${JSON.stringify(out)}\n`);
  }
  return out.conflicts > 0 ? 3 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
