#!/usr/bin/env node
/**
 * @file sf-gates.mjs
 * @description Runs the repo-declared gate suites for the shipflow ship-* skills
 *   (skills/shared/repo-config.md). `baseline` runs the push-gated suites against the base
 *   branch in a scratch worktree at run start, so a suite that already fails on the base is
 *   known before the run's first push (skills/shared/run-preflight.md §Push-gate baseline).
 *   `run` runs one declared check in the run's worktree and, with `--only`, on the base too, so
 *   the orchestrator can tell a pre-existing failure from one the run caused. `gate` runs a
 *   whole gate job set (ship-task 3f, the 3c smoke, the 2.7 layer gate) as child processes and
 *   prints one JSON verdict. `push-env` prints the approved skip variables recorded in the
 *   runstate. Never writes to the ledger — the caller logs. Zero dependencies.
 * @domain workflow-gates
 *
 * Usage:
 *   sf-gates baseline --cwd <dir> --base <branch> [--remote origin] --out <json>
 *   sf-gates run --set manifest-drift --cwd <dir> --base <branch> [--remote origin]
 *   sf-gates run --set suites|manifest-drift --only <name> --cwd <dir> --base <branch> [--remote origin]
 *   sf-gates gate --mode full|smoke|layer --cwd <dir> --base <branch> --baseline <sha> --out-dir <dir>
 *     [--remote origin] [--runstate <json>] [--ship-mode worktree|inline] [--changed-files <file>]
 *     [--ac <json file>] [--relaunch yes]
 *   sf-gates push-env --runstate <runstate.json>
 *
 * Config trust: every verb that runs a check reads `.shipflow.json` from <remote>/<base>, never
 *   from the branch, so a diff cannot rewrite the checks that judge it. A worktree copy that
 *   differs is a warning. The caller fetched the base; there is no fetch here.
 * baseline: undeclared at the base → {declared:false} without a checkout. Otherwise
 *   `git worktree add --detach` a scratch tree at <remote>/<base>, run `push_gates.setup` (env
 *   SF_PARENT_WT=<cwd>; `linked_deps:true` records that the base measurement could use the run
 *   worktree's dependencies), then each suite with its timeout_ms (default 1,200,000; a timeout
 *   is a failure). Writes {base, base_sha, declared, linked_deps, suites:[{name, skip_env, pass,
 *   exit, duration_ms, log}], preexisting_failures} to --out; suite logs sit beside it. Exit 0
 *   when the baseline ran (failing suites included); 1 when the setup command failed (no suite
 *   ran); 2 on a usage, config or git error (no JSON on stdout).
 * run: stdout JSON is the result; exit = the branch check's exit; undeclared → exit 0 with
 *   {declared:false}; no JSON on stdout (exit 2) is an error, never a pass or undeclared.
 * gate: jobs by mode — full: build, drift, lint, one ac-<id> per --ac entry; smoke: smoke; layer:
 *   smoke, tests, drift (manifest drift only). Jobs start together, except the ones that read
 *   build output (drift when the runstate has push_gate_skips; an ac entry unless it says
 *   "reads_build": false), which start together once `build` passes and are `not-run` when it
 *   does not. A job's verdict is its own process's exit status. A failure that matches a
 *   resilience class (oom, killed, stale-artifacts, link-farm) is re-run once per class, after
 *   every job's first attempt has ended and never beside another retry. A failing drift check is
 *   `preexisting` only under the predicate in run-preflight.md §Push-gate baseline, and only when
 *   the branch and base runs both ended by their own exit status: a branch run that timed out,
 *   was killed or did not start is `error` (a killed one after the job's `killed` re-run), as is
 *   a `push_gate_skips` suite the base does not declare. One stdout
 *   line, also written to <out-dir>/result.json: {mode, tip, baseline, pass, next, bucket1,
 *   out_dir, jobs:[{name, verdict, exit, signal, wall_ms, log, attempts, resilience,
 *   held_for_build, checks?, lint?}]}. Exit 0 pass; 1 a job did not pass (JSON printed); 2 a
 *   usage, config or git error (no JSON) — an error, never a pass. No job gets a deadline here
 *   beyond a drift check's timeout_ms; the caller's background-job timeout is the bound.
 * Processes: every command runs in its own process group. A timeout, and the end of every
 *   command, SIGKILLs the whole group, so no suite process outlives its run. SIGTERM, SIGINT
 *   and SIGHUP kill the running groups and remove the scratch worktree. A marker file in each
 *   scratch dir (in the log dir while `run`'s branch check runs; in one owner dir in the temp
 *   directory for a whole `gate`) records this pid and the live group ids; the next run sweeps
 *   the dirs of a dead owner (kills its groups, removes them). `gate`'s --out-dir is never swept.
 * Suites never inherit a declared `skip_env` variable, so a suite cannot skip itself here, nor
 *   a hook selection input (HOOK_SELECTION_INPUTS: SF_PG_GATE_SUITES), so a run is never narrowed.
 * Pass receipts: a passing `run --set suites` branch run writes the pre-push hook's pass receipt
 *   (.githooks/README.md, "Pass receipts") when the installed hook has a version and a
 *   `run_gate_arm --arm=<suite name>` call (today `pg-writer-gate`), no tracked entry is marked
 *   assume-unchanged or skip-worktree, and neither the tracked content nor the installed hook
 *   changed during the run, so a push of the same content skips that arm. The record is the
 *   hook's: `sf-pass-receipt v1` / arm <suite name> / tree / hook / hookblob / selection (argv
 *   joined, an element naming a file under the worktree root suffixed @<blob>, the blob taken
 *   from the snapshot tree when the file is tracked), stored under <git-common-dir>/sf-pass-receipts
 *   by the hash of its text. The hook version and blob come from one read taken before the run. A
 *   receipt problem is a warning.
 *   Build, smoke, lint and ac jobs write nothing: no hook arm runs their commands.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, loadRepoConfigAt } from './sf-config.mjs';

export const DEFAULT_SUITE_TIMEOUT_MS = 1_200_000;
const SETS = ['suites', 'manifest-drift'];
const MARKER = 'sf-gates-owner.json';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Hook inputs that narrow what a hook arm runs; a sf-gates suite run is always the full one. */
export const HOOK_SELECTION_INPUTS = ['SF_PG_GATE_SUITES'];
const PASS_RECEIPT_DIR = 'sf-pass-receipts';
const PASS_RECEIPT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const HELP = `sf-gates — repo-declared gate suites (skills/shared/repo-config.md)

  sf-gates baseline --cwd <dir> --base <branch> [--remote origin] --out <json>
      Run push_gates.suites against <remote>/<base> in a scratch worktree. Writes
      {base, base_sha, declared, linked_deps, suites:[{name, skip_env, pass, exit, duration_ms, log}],
      preexisting_failures}. Exit 0 ran (even with failures), 1 setup failed, 2 usage/config/git error.
  sf-gates run --set manifest-drift --cwd <dir> --base <branch> [--remote origin]
      Run the manifest_drift check declared at <remote>/<base> in <dir>.
  sf-gates run --set suites|manifest-drift --only <name> --cwd <dir> --base <branch> [--remote origin]
      Run that one check in <dir> and in a scratch tree at <remote>/<base>: {…, branch, base}.
      run: stdout JSON is the result; exit = the branch check's exit; undeclared → 0, {declared:false};
      no JSON (exit 2) is an error.
  sf-gates gate --mode full|smoke|layer --cwd <dir> --base <branch> --baseline <sha> --out-dir <dir>
      [--remote origin] [--runstate <json>] [--ship-mode worktree|inline] [--changed-files <file>]
      [--ac <json file>] [--relaunch yes]
      Run a gate job set and print one JSON line (also <out-dir>/result.json): {mode, tip, baseline,
      pass, next, bucket1, out_dir, jobs:[{name, verdict, exit, signal, wall_ms, log, attempts,
      resilience, held_for_build, checks?, lint?}]}. full: build, drift, lint, ac-<id> (needs
      --ship-mode and --changed-files; --ac is [{id, sh, reads_build?}]). smoke: the scoped
      type-check. layer: smoke, tests, manifest drift. verdict: pass | fail | preexisting | error |
      not-run. next (full): build-failed | ac-failed | fix-pass | pass; (smoke): smoke-finding | pass;
      (layer): epic-layer-build-failed | pass. Exit 0 pass, 1 a job did not pass, 2 error (no JSON).
  sf-gates push-env --runstate <runstate.json>
      Print NAME=1 per approved skip in the runstate's push_gate_skips. Missing or corrupt
      runstate → nothing printed, a warning, exit 0.

  A passing \`run --set suites\` branch run also writes the pre-push hook's pass receipt when the repo
  has an installed hook (.githooks/README.md, "Pass receipts"); a receipt problem is a warning.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { flags._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'help') { flags.help = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`--${key} needs a value`);
    flags[key] = v;
    i += 1;
  }
  return flags;
}

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const warn = (msg) => process.stderr.write(`sf-gates: warning: ${msg}\n`);
const safeName = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');

// ---- process groups and scratch trees -------------------------------------------------------

const live = { groups: new Set(), scratch: new Set(), markers: new Set(), receipts: new Set(), cwd: null, handlers: false };

function killGroup(pgid) {
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* group already gone */ }
}

function writeMarker(scratchRoot) {
  try { writeFileSync(join(scratchRoot, MARKER), JSON.stringify({ pid: process.pid, pgids: [...live.groups] })); } catch { /* scratch removed */ }
}

function removeScratch(cwd, scratchRoot) {
  try { git(cwd, ['worktree', 'remove', '--force', join(scratchRoot, 'base')]); } catch { /* not added, or already gone */ }
  rmSync(scratchRoot, { recursive: true, force: true });
  try { git(cwd, ['worktree', 'prune']); } catch { /* best effort */ }
}

function onSignal(sig, code) {
  for (const g of live.groups) killGroup(g);
  for (const s of live.scratch) removeScratch(live.cwd, s);
  for (const m of live.markers) rmSync(join(m, MARKER), { force: true });
  for (const r of live.receipts) rmSync(r, { recursive: true, force: true });
  process.stderr.write(`sf-gates: ${sig} — suites killed, scratch worktree removed\n`);
  process.exit(code);
}

function installHandlers(cwd) {
  live.cwd = cwd;
  if (live.handlers) return;
  live.handlers = true;
  process.on('SIGTERM', () => onSignal('SIGTERM', 143));
  process.on('SIGINT', () => onSignal('SIGINT', 130));
  process.on('SIGHUP', () => onSignal('SIGHUP', 129));
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Kill the groups and remove the dirs (scratch trees, branch log dirs) of sf-gates runs whose owner died without cleaning up (SIGKILL). */
export function sweepStale(cwd) {
  let entries = [];
  try { entries = readdirSync(tmpdir()); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith('sf-')) continue;
    const root = join(tmpdir(), name);
    let owner;
    try { owner = JSON.parse(readFileSync(join(root, MARKER), 'utf8')); } catch { continue; }
    if (!Number.isInteger(owner.pid) || pidAlive(owner.pid)) continue;
    for (const g of Array.isArray(owner.pgids) ? owner.pgids : []) if (Number.isInteger(g) && g > 1) killGroup(g);
    removeScratch(cwd, root);
  }
}

/** Run one argv command in its own process group, output captured to `logPath`. No `timeoutMs` → no deadline. */
function runCommand(argv, { cwd, env, timeoutMs, logPath, scratchRoot }) {
  const fd = openSync(logPath, 'w');
  const started = Date.now();
  return new Promise((done) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', fd, fd], detached: true });
    const finish = (status, error, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child.pid) { killGroup(child.pid); live.groups.delete(child.pid); }
      if (scratchRoot) writeMarker(scratchRoot);
      closeSync(fd);
      const out = { pass: !error && !timedOut && status === 0, exit: status, duration_ms: Date.now() - started, log: logPath };
      if (timedOut) out.timed_out = true;
      else if (error) out.error = error.message;
      else if (signal) out.signal = signal;
      done(out);
    };
    if (child.pid) {
      live.groups.add(child.pid);
      if (scratchRoot) writeMarker(scratchRoot);
      if (timeoutMs) timer = setTimeout(() => { timedOut = true; killGroup(child.pid); }, timeoutMs);
    }
    child.on('error', (e) => finish(null, e));
    child.on('close', (status, signal) => finish(status, null, signal));
  });
}

async function withScratch(cwd, sha, fn) {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'sf-'));
  const scratch = join(scratchRoot, 'base');
  live.scratch.add(scratchRoot);
  writeMarker(scratchRoot);
  try {
    git(cwd, ['worktree', 'add', '--detach', '-q', scratch, sha]);
    return await fn(scratch, scratchRoot);
  } finally {
    removeScratch(cwd, scratchRoot);
    live.scratch.delete(scratchRoot);
  }
}

// ---- config ---------------------------------------------------------------------------------

/** The base's config, plus a warning when the run's worktree carries a different copy. */
function baseConfig(cwd, ref) {
  let loaded;
  try { loaded = loadRepoConfigAt(cwd, ref); } catch (e) { throw new UsageError(e.message); }
  for (const w of loaded.warnings) warn(w);
  let wtText = null;
  try { wtText = readFileSync(join(git(cwd, ['rev-parse', '--show-toplevel']), CONFIG_FILE), 'utf8'); } catch { /* absent */ }
  if (wtText !== (loaded.text ?? null)) warn(`the worktree's ${CONFIG_FILE} differs from ${ref}'s; gates use ${ref}'s`);
  return loaded;
}

function suiteEnv(config, extra = {}) {
  const env = { ...process.env, ...extra };
  for (const s of config.push_gates?.suites ?? []) if (s.skip_env) delete env[s.skip_env];
  for (const name of HOOK_SELECTION_INPUTS) delete env[name];
  return env;
}

// ---- pass receipts (the pre-push hook's `run_gate_arm` is the other writer) -----------------

const gitIndexed = (cwd, index, args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_INDEX_FILE: index },
}).trim();

/** The hook's `hook_version_of`: the first version line, leading zeros stripped, clamped to 9 digits; 0 when absent. */
function hookVersionOf(text) {
  const v = (/^# hook-version: *([0-9]+)/m.exec(text)?.[1] ?? '').replace(/^0+/, '');
  if (!v) return 0;
  return v.length > 9 ? 999999999 : Number(v);
}

/**
 * The installed pre-push hook, read once: its version, blob and the arm names its
 * `run_gate_arm --arm=<name>` calls spell literally. Null when absent or carrying no version.
 */
function installedHook(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const common = resolve(top, git(top, ['rev-parse', '--git-common-dir']));
  const path = join(common, 'hooks', 'pre-push');
  let bytes;
  try { bytes = readFileSync(path); } catch { return null; }
  const text = bytes.toString('utf8');
  const version = hookVersionOf(text);
  if (!version) return null;
  // --no-filters on both writers: the key is the bytes, whatever the attributes of the path.
  const blob = execFileSync('git', ['-C', top, 'hash-object', '--no-filters', '--stdin'], { input: bytes, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  const arms = new Set([...text.matchAll(/run_gate_arm --arm=([A-Za-z0-9._-]+)/g)].map((m) => m[1]));
  return { path, common, version, blob, arms };
}

/**
 * git compares index stat data in whole seconds (unless built with USE_NSEC), and an entry whose
 * file changed in the second the index was written is "racily clean": git compares its content
 * instead, so an edit reverted during the run would read as unchanged. Waiting for the next second
 * (plus 50 ms for a filesystem clock that trails ours) and rewriting the index leaves none racy.
 */
function settleIndex(cwd, index) {
  const now = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(now / 1000) * 1000 + 1050 - now);
  try { gitIndexed(cwd, index, ['update-index', '-q', '--refresh', '--force-write-index']); } catch { /* exits 1 when an entry needs updating */ }
}

/**
 * The tracked working content of `cwd` as a tree, from a private copy of its index (`git add -u`,
 * `write-tree`, then a settled refresh), plus the installed hook read once. Returns
 * {tree, index, hook, done} or null: no installed hook declaring `arm`, an entry whose content
 * `add -u` skips, or a failure. `done()` removes the copy; a signal removes it too.
 */
export function passReceiptSnapshot(cwd, arm) {
  let dir = null;
  try {
    const hook = installedHook(cwd);
    if (!hook || !hook.arms.has(arm)) return null;
    const flags = execFileSync('git', ['-C', cwd, 'ls-files', '-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 512 * 1024 * 1024 });
    if (/^[a-zS] /m.test(flags)) {
      warn('pass receipt: some tracked files are marked assume-unchanged or skip-worktree; no receipt is written');
      return null;
    }
    const liveIndex = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'index']));
    if (!existsSync(liveIndex)) return null;
    dir = mkdtempSync(join(tmpdir(), 'sf-receipt-'));
    live.receipts.add(dir);
    const index = join(dir, 'index');
    copyFileSync(liveIndex, index);
    gitIndexed(cwd, index, ['add', '-u']);
    const tree = gitIndexed(cwd, index, ['write-tree']);
    settleIndex(cwd, index);
    const owned = dir;
    return { tree, index, hook, done: () => { rmSync(owned, { recursive: true, force: true }); live.receipts.delete(owned); } };
  } catch (e) {
    if (dir) { rmSync(dir, { recursive: true, force: true }); live.receipts.delete(dir); }
    warn(`pass receipt: cannot snapshot the tracked content (${e.message.split('\n')[0]}); no receipt is written`);
    return null;
  }
}

/** True when the tracked content still matches the snapshot, by stat, with no refresh. */
function passReceiptUnchanged(cwd, snapshot) {
  try { gitIndexed(cwd, snapshot.index, ['diff-files', '--quiet']); return true; } catch { return false; }
}

/** The blob of tracked file `rel` in `tree`, or null when the tree does not carry it. */
function treeBlob(top, tree, rel) {
  try { return git(top, ['rev-parse', '--verify', '-q', `${tree}:${rel.split(sep).join('/')}`]); } catch { return null; }
}

/**
 * Write the hook's pass receipt for `arm` after a pass of `argv` on `snapshot` (passReceiptSnapshot).
 * Returns the path written, or null (the installed hook changed since the snapshot, any failure —
 * warned, never thrown).
 */
export function writePassReceipt({ cwd, arm, argv, snapshot }) {
  try {
    const { tree, hook } = snapshot;
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    let now = null;
    try { now = git(top, ['hash-object', '--no-filters', hook.path]); } catch { /* removed */ }
    if (now !== hook.blob) throw new Error('the installed hook changed during the run');
    const words = argv.map((word) => {
      const abs = resolve(top, word);
      const rel = relative(top, abs);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return word;
      let file = false;
      try { file = statSync(abs).isFile(); } catch { /* not a path */ }
      if (!file) return word;
      return `${word}@${treeBlob(top, tree, rel) ?? git(top, ['hash-object', '--no-filters', abs])}`;
    });
    const selection = words.join(' ');
    if (/[\r\n]/.test(`${arm}${selection}`)) throw new Error('arm or selection spans lines');
    const record = `sf-pass-receipt v1\narm ${arm}\ntree ${tree}\nhook ${hook.version}\nhookblob ${hook.blob}\nselection ${selection}\n`;
    const name = execFileSync('git', ['-C', top, 'hash-object', '--stdin'], { input: record, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    const dir = join(hook.common, PASS_RECEIPT_DIR);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.write.${process.pid}.${Date.now()}`);
    writeFileSync(tmp, record);
    renameSync(tmp, join(dir, name));
    const cutoff = Date.now() - PASS_RECEIPT_MAX_AGE_MS;
    for (const f of readdirSync(dir)) {
      try { if (statSync(join(dir, f)).mtimeMs < cutoff) rmSync(join(dir, f), { force: true }); } catch { /* raced */ }
    }
    return join(dir, name);
  } catch (e) {
    warn(`pass receipt for ${arm}: not written (${String(e.message).split('\n')[0]}); the next push runs that arm again`);
    return null;
  }
}

// ---- verbs ----------------------------------------------------------------------------------

export async function baseline({ cwd, base, remote = 'origin', out }) {
  if (!cwd || !existsSync(cwd)) throw new UsageError(`--cwd ${cwd} does not exist`);
  if (!base) throw new UsageError('--base <branch> is required');
  if (!out) throw new UsageError('--out <json> is required');
  const ref = `${remote}/${base}`;
  const { config, sha } = baseConfig(cwd, ref);
  const suites = config.push_gates?.suites ?? [];
  const outPath = resolve(out);
  const result = { base, base_sha: sha, declared: suites.length > 0, linked_deps: false, suites: [], preexisting_failures: [] };
  let code = 0;
  if (result.declared) {
    installHandlers(cwd);
    sweepStale(cwd);
    const logDir = join(dirname(outPath), 'push-gate-logs');
    mkdirSync(logDir, { recursive: true });
    const env = suiteEnv(config, { SF_PARENT_WT: resolve(cwd) });
    await withScratch(cwd, sha, async (scratch, scratchRoot) => {
      if (config.push_gates.setup) {
        result.linked_deps = true;
        const setup = await runCommand(config.push_gates.setup, { cwd: scratch, env, timeoutMs: DEFAULT_SUITE_TIMEOUT_MS, logPath: join(logDir, 'setup.log'), scratchRoot });
        result.setup = setup;
        if (!setup.pass) { code = 1; return; }
      }
      for (const [i, s] of suites.entries()) {
        const r = await runCommand(s.run, { cwd: scratch, env, timeoutMs: s.timeout_ms ?? DEFAULT_SUITE_TIMEOUT_MS, logPath: join(logDir, `${i}-${safeName(s.name)}.log`), scratchRoot });
        result.suites.push({ name: s.name, skip_env: s.skip_env ?? null, ...r });
        if (!r.pass) result.preexisting_failures.push(s.name);
      }
    });
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  return { result, code };
}

export async function runSet({ set, cwd, base, remote = 'origin', only, logDir: givenLogDir, env: extraEnv = {}, ownerDir }) {
  if (!SETS.includes(set)) throw new UsageError(`--set must be one of ${SETS.join(', ')} (got ${JSON.stringify(set)})`);
  if (!cwd || !existsSync(cwd)) throw new UsageError(`--cwd ${cwd} does not exist`);
  if (!base) throw new UsageError('--base <branch> is required (checks are read from the base)');
  if (set === 'suites' && !only) throw new UsageError('--set suites needs --only <name>');
  const ref = `${remote}/${base}`;
  const { config, sha } = baseConfig(cwd, ref);
  const check = set === 'manifest-drift' ? config.manifest_drift : (config.push_gates?.suites ?? []).find((s) => s.name === only);
  if (!check || (only && check.name !== only)) return { result: { set, name: only ?? null, declared: false, base_sha: sha }, code: 0 };

  installHandlers(cwd);
  sweepStale(cwd);
  const timeoutMs = check.timeout_ms ?? DEFAULT_SUITE_TIMEOUT_MS;
  const env = suiteEnv(config, extraEnv);
  const logDir = givenLogDir ?? mkdtempSync(join(tmpdir(), 'sf-'));
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  // The marker lets the next run's sweep kill this group if sf-gates is SIGKILLed mid-branch;
  // it is removed once the branch run ends so a finished run's logs are never swept. A caller's
  // `ownerDir` already carries the marker and stays the caller's to remove.
  if (!ownerDir) live.markers.add(logDir);
  const snapshot = set === 'suites' ? passReceiptSnapshot(top, check.name) : null;
  const branch = await runCommand(check.run, { cwd: top, env, timeoutMs, logPath: join(logDir, `branch-${safeName(check.name)}.log`), scratchRoot: ownerDir ?? logDir });
  if (!ownerDir) {
    rmSync(join(logDir, MARKER), { force: true });
    live.markers.delete(logDir);
  }
  if (snapshot) {
    // No refresh: a stat change during the run means it may have judged other content.
    if (branch.pass && passReceiptUnchanged(top, snapshot)) writePassReceipt({ cwd: top, arm: check.name, argv: check.run, snapshot });
    snapshot.done();
  }
  const result = { set, name: check.name, declared: true, base_sha: sha, ...branch, branch };
  if (only) {
    result.base = await withScratch(cwd, sha, async (scratch, scratchRoot) => {
      const benv = suiteEnv(config, { ...extraEnv, SF_PARENT_WT: resolve(cwd) });
      if (config.push_gates?.setup) {
        const setup = await runCommand(config.push_gates.setup, { cwd: scratch, env: benv, timeoutMs: DEFAULT_SUITE_TIMEOUT_MS, logPath: join(logDir, 'base-setup.log'), scratchRoot });
        if (!setup.pass) return { setup_failed: true, setup };
      }
      return runCommand(check.run, { cwd: scratch, env: benv, timeoutMs, logPath: join(logDir, `base-${safeName(check.name)}.log`), scratchRoot });
    });
  }
  return { result, code: branch.pass ? 0 : (branch.exit || 1) };
}

// ---- gate -----------------------------------------------------------------------------------

const MODES = ['full', 'smoke', 'layer'];
const SHIP_MODES = ['worktree', 'inline'];
const PASSING = ['pass', 'preexisting'];
const OOM_ENV = { NODE_OPTIONS: '--max-old-space-size=8192' };
const OOM_LOG = /\bKilled\b|heap out of memory/;
const LINK_FARM_LOG = /next\/package\.json/;
const STALE_LOG = /module not found|cannot find module|\.next\/types/i;
const STALE_DIRS = ['.next', '.turbo', '.cache'];
const LINT_SCRIPT = 'scripts/lint-ratchet.mjs';
const LINTABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const ANSI = /\u001b\[[0-9;]*m/g;

// The reference turborepo layout the built-in build assumes: the frontend app lives at
// FRONTEND_DIR as workspace FRONTEND_PKG and is left out of the scoped build unless the diff
// reaches it (or a shared package). Retarget both for your repo, or declare your own gates in
// `.shipflow.json` (shared/repo-config.md) and this default never runs.
export const FRONTEND_DIR = 'apps/web/';
export const FRONTEND_PKG = '@acme/web';

// The scoped build of the reference monorepo. CHANGED_FILES is the --changed-files path and
// TURBO_EXTRA carries the out-of-memory retry's flag; an unset value ends the job non-zero and
// never narrows the build.
const BUILD_SH = [
  ': "${REVIEW_BASELINE:?}" "${SHIP_MODE:?}"; [ -r "${CHANGED_FILES:?}" ] || exit 2',
  `NEEDS_NEXT=$(grep -Eq '^(${FRONTEND_DIR}|packages/)' "$CHANGED_FILES" && echo 1 || echo 0)`,
  'if [ "$SHIP_MODE" = worktree ] && [ "$NEEDS_NEXT" = 1 ] && [ ! -f .npm-install-full.done ]; then',
  '  if [ -f .npm-install-full.pid ]; then',
  '    for i in $(seq 1 120); do [ -f .npm-install-full.done ] && break; kill -0 "$(cat .npm-install-full.pid)" 2>/dev/null || break; sleep 5; done',
  '  fi',
  '  [ -f .npm-install-full.done ] || { npm install --no-audit --no-fund > .npm-install-full.log 2>&1 && touch .npm-install-full.done; }',
  '  git checkout -- package-lock.json 2>/dev/null || true',
  'fi',
  'if [ "$NEEDS_NEXT" = 1 ]; then npx turbo run build --force --filter="...[$REVIEW_BASELINE]" $TURBO_EXTRA 2>&1',
  `else npx turbo run build --force --filter="...[$REVIEW_BASELINE]" --filter='!${FRONTEND_PKG}' $TURBO_EXTRA 2>&1; fi`,
].join('\n');
const INSTALL_SH = 'npm install --no-audit --no-fund > .npm-install-full.log 2>&1 && touch .npm-install-full.done; git checkout -- package-lock.json 2>/dev/null || true';

const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

/** Failing test identifiers in a log: vitest `FAIL` / `×` / `✗` lines and node:test `not ok <n> - <name>`, trailing duration removed. */
export function failingIds(text) {
  const ids = new Set();
  for (const raw of text.replace(ANSI, '').split('\n')) {
    const line = raw.trim();
    const m = /^(?:FAIL|×|✗)\s+(.+)$/.exec(line) ?? /^not ok \d+ - (.+)$/.exec(line);
    if (m) ids.add(m[1].replace(/\s+\d+(?:\.\d+)?\s?m?s$/, '').trim());
  }
  return ids;
}

/** A run that ended by its own exit status: a timeout, a signal or a spawn error leaves a partial log that proves nothing. */
const ranToEnd = (r) => !r.timed_out && !r.signal && !r.error && typeof r.exit === 'number';

/**
 * The run-preflight.md predicate for one `run --only` result: pre-existing only when the base also
 * fails and every failing identifier on the branch fails on the base. Both runs must have run to
 * their end: a branch run cut short is `error`, a base run cut short leaves the failure a `fail`.
 */
function judgeCheck(set, res) {
  const out = { name: res.name, set, verdict: 'pass', branch_log: res.branch.log, base_log: res.base?.log ?? null, branch_only_failures: [] };
  if (res.branch.pass) return out;
  if (!ranToEnd(res.branch)) {
    out.verdict = 'error';
    out.error = res.branch.timed_out ? 'the branch run timed out' : res.branch.signal ? `the branch run was killed (${res.branch.signal})` : `the branch run did not start (${res.branch.error})`;
    return out;
  }
  out.verdict = 'fail';
  if (!res.base || res.base.setup_failed) { out.base_log = res.base?.setup?.log ?? null; return out; }
  const branchIds = [...failingIds(readText(res.branch.log))];
  if (res.base.pass || !ranToEnd(res.base)) { out.branch_only_failures = branchIds; return out; }
  const baseIds = failingIds(readText(res.base.log));
  out.branch_only_failures = branchIds.filter((id) => !baseIds.has(id));
  if (branchIds.length > 0 && out.branch_only_failures.length === 0) out.verdict = 'preexisting';
  return out;
}

/** The names in the runstate's push_gate_skips. An unreadable runstate is an error: the gate cannot know which suites the pushes skip. */
function skippedSuites(runstate) {
  if (!runstate) return [];
  let doc;
  try { doc = JSON.parse(readFileSync(runstate, 'utf8')); } catch (e) { throw new UsageError(`--runstate ${runstate} cannot be read (${e.message})`); }
  const skips = doc && typeof doc === 'object' ? doc.push_gate_skips : undefined;
  if (skips === undefined) return [];
  if (!Array.isArray(skips)) throw new UsageError('the runstate\'s push_gate_skips is not an array');
  return skips.map((s) => {
    if (!s || typeof s.name !== 'string' || !s.name) throw new UsageError(`the runstate's push_gate_skips entry ${JSON.stringify(s)} has no name; the gate cannot run the suite that push skips`);
    return s.name;
  });
}

function readAc(path) {
  if (!path) return [];
  let list;
  try { list = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new UsageError(`--ac ${path} cannot be read (${e.message})`); }
  if (!Array.isArray(list)) throw new UsageError('--ac must hold an array of {id, sh, reads_build?}');
  const names = new Set();
  return list.map((e) => {
    const id = e && (typeof e.id === 'string' || typeof e.id === 'number') ? String(e.id) : '';
    if (!id || typeof e.sh !== 'string' || !e.sh.trim()) throw new UsageError(`--ac entry ${JSON.stringify(e)} needs an id and a non-empty sh`);
    if (e.reads_build !== undefined && typeof e.reads_build !== 'boolean') throw new UsageError(`--ac entry ${id}: reads_build must be a boolean`);
    const name = `ac-${safeName(id)}`;
    if (/\.retry-\d+$/.test(name)) throw new UsageError(`--ac entry ${id}: an id cannot end in ".retry-<n>" (its log would take another job's retry log name)`);
    if (names.has(name)) throw new UsageError(`--ac entry ${id} is listed twice`);
    names.add(name);
    return { name, sh: e.sh, held: e.reads_build !== false };
  });
}

function clearArtifacts(dir, depth = 0) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.git') continue;
    const path = join(dir, e.name);
    if (STALE_DIRS.includes(e.name)) rmSync(path, { recursive: true, force: true });
    else if (e.name === 'node_modules') rmSync(join(path, '.cache'), { recursive: true, force: true });
    else if (depth < 2) clearArtifacts(path, depth + 1);
  }
}

/**
 * The lint ratchet's own count against the diff. Producer: the repo's scripts/lint-ratchet.mjs
 * line "ok (N file(s) checked". A count below half the changed, existing, lintable frontend
 * files means the file list did not reach the ratchet.
 */
function lintCounts(top, changedFiles, log) {
  const ok = /ok \((\d+) file\(s\) checked/.exec(log);
  const checked = ok ? Number(ok[1]) : 0;
  const expected = readText(changedFiles).split('\n').map((l) => l.trim())
    .filter((f) => f.startsWith(FRONTEND_DIR) && LINTABLE.test(f) && existsSync(join(top, f))).length;
  return { checked, expected, false_green: checked * 2 < expected };
}

/** The drift job: manifest drift, then (full) each skipped suite, one check after another. */
async function runDrift(ctx, { logPath, env }) {
  const checks = [];
  const raw = [];
  const one = async (set, only, n) => {
    const logDir = join(ctx.outDir, `drift-${n}`);
    mkdirSync(logDir, { recursive: true });
    const args = { set, cwd: ctx.cwd, base: ctx.base, remote: ctx.remote, logDir, env, ownerDir: ctx.ownerDir };
    let res = (await runSet({ ...args, only })).result;
    if (!res.declared) {
      const none = { name: only ?? 'manifest-drift', set, verdict: 'undeclared', branch_log: null, base_log: null, branch_only_failures: [] };
      // A skipped suite the base no longer declares cannot be run here, while the pushes still skip it.
      return set === 'suites' ? { ...none, verdict: 'error', error: `the base declares no suite named ${only}` } : none;
    }
    if (!only) {
      if (res.pass) return { name: res.name, set, verdict: 'pass', branch_log: res.log, base_log: null, branch_only_failures: [] };
      res = (await runSet({ ...args, only: res.name })).result;
    }
    raw.push(res.branch);
    return judgeCheck(set, res);
  };
  const targets = [['manifest-drift', undefined], ...(ctx.mode === 'full' ? ctx.skips.map((name) => ['suites', name]) : [])];
  for (const [n, [set, only]] of targets.entries()) {
    let check;
    // An error is re-run once before it is reported; it never passes.
    for (let attempt = 0; attempt < 2 && !check; attempt += 1) {
      try { check = await one(set, only, n); } catch (e) {
        if (attempt === 1) check = { name: only ?? 'manifest-drift', set, verdict: 'error', branch_log: null, base_log: null, branch_only_failures: [], error: e.message };
      }
    }
    checks.push(check);
  }
  const verdicts = checks.map((c) => c.verdict);
  const verdict = verdicts.includes('fail') ? 'fail' : verdicts.includes('error') ? 'error' : verdicts.includes('preexisting') ? 'preexisting' : 'pass';
  writeFileSync(logPath, checks.map((c) => `${c.set} ${c.name}: ${c.verdict}${c.error ? ` (${c.error})` : ''}\n`).join(''));
  // A branch run killed by a signal has no exit status, so the job is re-run once (the `killed` class).
  const killed = raw.find((b) => !b.pass && !b.timed_out && b.signal);
  return {
    verdict, checks, log: logPath, exit: killed ? null : PASSING.includes(verdict) ? 0 : 1, signal: killed?.signal ?? null,
    oom: raw.some((b) => !b.pass && !b.timed_out && (b.exit === 137 || OOM_LOG.test(readText(b.log)))),
  };
}

/** One command job attempt. `sh` runs under bash with pipefail; `argv` runs as given. */
async function runJobCommand(ctx, job, { logPath, env, oom }) {
  const extra = oom && job.turbo ? ['--concurrency=1'] : [];
  const argv = job.sh ? ['bash', '-c', `set -o pipefail; ${job.sh}`] : [...job.argv, ...extra];
  const r = await runCommand(argv, { cwd: ctx.top, env: { ...process.env, ...job.env, ...env, TURBO_EXTRA: extra.join(' ') }, logPath, scratchRoot: ctx.ownerDir });
  const text = readText(logPath);
  const out = { verdict: r.pass ? 'pass' : r.error || r.signal ? 'error' : 'fail', log: logPath, exit: r.exit, signal: r.signal ?? null, text, oom: r.exit === 137 || OOM_LOG.test(text) };
  if (job.name === 'lint' && r.exit === 0) {
    out.lint = lintCounts(ctx.top, ctx.changedFiles, text);
    if (out.lint.false_green) out.verdict = 'fail';
  } else if (job.name === 'lint') out.lint = { ...lintCounts(ctx.top, ctx.changedFiles, text), false_green: false };
  return out;
}

/** The first resilience class this failure matches that the job has not used yet. */
function resilienceClass(job, r, used) {
  const matches = [
    ['oom', r.oom],
    ['killed', r.exit === null && Boolean(r.signal)],
    ['link-farm', Boolean(job.artifacts) && LINK_FARM_LOG.test(r.text ?? '')],
    ['stale-artifacts', Boolean(job.artifacts) && STALE_LOG.test(r.text ?? '')],
  ];
  return matches.find(([name, hit]) => hit && !used.has(name))?.[0] ?? null;
}

async function runJob(ctx, job) {
  const started = Date.now();
  const used = new Set();
  const attempt = (n) => {
    const opts = { logPath: join(ctx.outDir, n === 1 ? `${job.name}.log` : `${job.name}.retry-${n - 1}.log`), env: used.has('oom') ? OOM_ENV : {}, oom: used.has('oom') };
    return job.drift ? runDrift(ctx, opts) : runJobCommand(ctx, job, opts);
  };
  const first = attempt(1);
  ctx.first.add(first.catch(() => {}));
  let r = await first;
  let attempts = 1;
  let resilience = null;
  for (let cls = resilienceClass(job, r, used); !PASSING.includes(r.verdict) && cls; cls = resilienceClass(job, r, used)) {
    used.add(cls);
    resilience = cls;
    attempts += 1;
    const n = attempts;
    // A retry runs alone: after every job's first attempt has ended, and never beside another retry.
    // It joins the chain only once the jobs held for the build have started (or will never start), so
    // their first attempts are in `ctx.first`; the build's own retry cannot wait for jobs it gates.
    if (job.name !== 'build') await ctx.heldStarted;
    const retry = ctx.chain.then(async () => {
      await Promise.all([...ctx.first]);
      if (cls === 'stale-artifacts') clearArtifacts(ctx.top);
      if (cls === 'link-farm') await runCommand(['bash', '-c', INSTALL_SH], { cwd: ctx.top, env: process.env, logPath: join(ctx.outDir, `${job.name}.install.log`), scratchRoot: ctx.ownerDir });
      return attempt(n);
    });
    ctx.chain = retry.catch(() => {});
    r = await retry;
  }
  const out = { name: job.name, verdict: r.verdict, exit: r.exit, signal: r.signal, wall_ms: Date.now() - started, log: r.log, attempts, resilience, held_for_build: Boolean(job.held) };
  if (r.checks) out.checks = r.checks;
  if (r.lint) out.lint = r.lint;
  return out;
}

const skipped = (job, verdict, log = null) => ({ name: job.name, verdict, exit: null, signal: null, wall_ms: 0, log, attempts: 0, resilience: null, held_for_build: Boolean(job.held) });

/** The "act in this order" mapping from the job verdicts to the caller's next step. */
function nextStep(mode, jobs, relaunch) {
  const bad = (name) => jobs.some((j) => j.name === name && !PASSING.includes(j.verdict));
  const allPass = jobs.every((j) => PASSING.includes(j.verdict));
  if (mode === 'smoke') return allPass ? 'pass' : 'smoke-finding';
  if (mode === 'layer') return allPass ? 'pass' : 'epic-layer-build-failed';
  if (bad('build')) return 'build-failed';
  if (jobs.some((j) => j.name.startsWith('ac-') && !PASSING.includes(j.verdict))) return 'ac-failed';
  if (bad('drift') || bad('lint')) return relaunch ? 'build-failed' : 'fix-pass';
  return 'pass';
}

export async function gate({ mode, cwd, base, remote = 'origin', baseline: baselineRef, outDir, runstate, shipMode, changedFiles, ac, relaunch }) {
  if (!outDir) throw new UsageError('--out-dir <dir> is required');
  const resultPath = join(resolve(outDir), 'result.json');
  // First, ahead of every other argument check: a re-run in the same directory never shows the previous verdict, a usage error included.
  rmSync(resultPath, { force: true });
  if (!MODES.includes(mode)) throw new UsageError(`--mode must be one of ${MODES.join(', ')} (got ${JSON.stringify(mode)})`);
  if (!cwd || !existsSync(cwd)) throw new UsageError(`--cwd ${cwd} does not exist`);
  if (!base) throw new UsageError('--base <branch> is required (checks are read from the base)');
  if (!baselineRef) throw new UsageError('--baseline <sha> is required');
  if (relaunch !== undefined && relaunch !== 'yes') throw new UsageError('--relaunch takes only "yes"');
  let top; let tip; let baselineSha;
  try {
    top = git(cwd, ['rev-parse', '--show-toplevel']);
    tip = git(cwd, ['rev-parse', 'HEAD']);
  } catch (e) { throw new UsageError(`--cwd ${cwd} is not a git worktree with a commit (${e.message.split('\n')[0]})`); }
  try {
    baselineSha = git(cwd, ['rev-parse', '--verify', '--quiet', `${baselineRef}^{commit}`]);
  } catch { throw new UsageError(`--baseline ${baselineRef} does not resolve to a commit in ${cwd}`); }
  const ctx = { mode, cwd, top, base, remote, outDir: resolve(outDir), changedFiles: changedFiles ? resolve(changedFiles) : null, skips: [], first: new Set(), chain: Promise.resolve() };

  const smoke = { name: 'smoke', argv: ['npx', 'turbo', 'run', 'type-check', '--force', `--filter=...[${baselineSha}]`], turbo: true, artifacts: true };
  let jobs;
  if (mode === 'full') {
    if (!SHIP_MODES.includes(shipMode)) throw new UsageError(`--mode full needs --ship-mode ${SHIP_MODES.join('|')}`);
    if (!ctx.changedFiles || !existsSync(ctx.changedFiles)) throw new UsageError('--mode full needs --changed-files <file> (one path per line)');
    ctx.skips = skippedSuites(runstate);
    baseConfig(cwd, `${remote}/${base}`);
    jobs = [
      { name: 'build', sh: BUILD_SH, turbo: true, artifacts: true, env: { REVIEW_BASELINE: baselineSha, SHIP_MODE: shipMode, CHANGED_FILES: ctx.changedFiles } },
      { name: 'drift', drift: true, held: ctx.skips.length > 0 },
      ...(existsSync(join(top, LINT_SCRIPT)) ? [{ name: 'lint', argv: [process.execPath, LINT_SCRIPT, '--files-from', ctx.changedFiles] }] : []),
      ...readAc(ac),
    ];
  } else if (mode === 'smoke') jobs = [smoke];
  else {
    baseConfig(cwd, `${remote}/${base}`);
    jobs = [smoke, { name: 'tests', argv: ['npx', '--no-install', 'vitest', 'run', '--changed', baselineSha] }, { name: 'drift', drift: true }];
  }

  mkdirSync(ctx.outDir, { recursive: true });
  installHandlers(cwd);
  sweepStale(cwd);
  // One owner directory for the whole gate: its marker names every live job group, so the next
  // run's sweep finds the jobs of a gate that was SIGKILLed. --out-dir is never swept.
  ctx.ownerDir = mkdtempSync(join(tmpdir(), 'sf-'));
  live.scratch.add(ctx.ownerDir);
  writeMarker(ctx.ownerDir);
  try {
    return await runJobs(ctx, jobs, { tip, baselineSha, resultPath, relaunch });
  } finally {
    rmSync(ctx.ownerDir, { recursive: true, force: true });
    live.scratch.delete(ctx.ownerDir);
  }
}

async function runJobs(ctx, jobs, { tip, baselineSha, resultPath, relaunch }) {
  const { mode, top } = ctx;
  let heldStarted;
  ctx.heldStarted = new Promise((r) => { heldStarted = r; });

  // An unresolvable turbo is an error of the environment, never a finding about the code.
  const turboOk = !jobs.some((j) => j.turbo) || spawnSync('npx', ['--no-install', 'turbo', '--version'], { cwd: top, stdio: 'ignore' }).status === 0;
  const start = (job) => {
    if (job.turbo && !turboOk) {
      const log = join(ctx.outDir, `${job.name}.log`);
      writeFileSync(log, `sf-gates: \`npx turbo\` cannot be resolved in ${top}; the ${job.name} job did not run\n`);
      return Promise.resolve(skipped(job, 'error', log));
    }
    return runJob(ctx, job);
  };
  const free = jobs.filter((j) => !j.held).map((j) => [j, start(j)]);
  const held = jobs.filter((j) => j.held);
  const build = free.find(([j]) => j.name === 'build');
  const buildPassed = build ? (await build[1]).verdict === 'pass' : true;
  const done = new Map([...free, ...held.map((j) => [j, buildPassed ? start(j) : Promise.resolve(skipped(j, 'not-run'))])]);
  heldStarted();
  const results = [];
  for (const j of jobs) results.push(await done.get(j));

  const next = nextStep(mode, results, relaunch === 'yes');
  const result = {
    mode, tip, baseline: baselineSha, pass: next === 'pass', next,
    bucket1: results.filter((j) => ['drift', 'lint'].includes(j.name) && !PASSING.includes(j.verdict) && j.verdict !== 'not-run').map((j) => j.name),
    out_dir: ctx.outDir, jobs: results,
  };
  writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
  return { result, code: result.pass ? 0 : 1 };
}

/** NAME=1 lines for the runstate's pinned push_gate_skips; never reads `.shipflow.json`. */
export function pushEnv({ runstate }) {
  if (!runstate) { warn('push-env: --runstate is missing; no suite is skipped'); return []; }
  let doc;
  try { doc = JSON.parse(readFileSync(runstate, 'utf8')); } catch (e) {
    warn(`push-env: cannot read ${runstate} (${e.message}); no suite is skipped`);
    return [];
  }
  const skips = doc && typeof doc === 'object' ? doc.push_gate_skips : undefined;
  if (skips === undefined) return [];
  if (!Array.isArray(skips)) { warn('push-env: push_gate_skips is not an array; no suite is skipped'); return []; }
  const lines = [];
  for (const s of skips) {
    if (s && typeof s.skip_env === 'string' && ENV_NAME.test(s.skip_env)) lines.push(`${s.skip_env}=1`);
    else warn(`push-env: skip ${JSON.stringify(s)} has no usable skip_env; that suite still runs`);
  }
  return lines;
}

async function main(argv) {
  const [verb, ...rest] = argv;
  if (!verb || verb === '--help' || verb === 'help') { process.stdout.write(HELP); return 0; }
  if (verb === 'push-env') {
    let flags = {};
    try { flags = parseArgs(rest); } catch (e) { warn(`push-env: ${e.message}`); }
    const lines = pushEnv({ runstate: flags.runstate });
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
  try {
    const flags = parseArgs(rest);
    if (flags.help) { process.stdout.write(HELP); return 0; }
    if (flags._.length) throw new UsageError(`unexpected argument ${flags._[0]}`);
    let r;
    if (verb === 'baseline') r = await baseline({ cwd: flags.cwd, base: flags.base, remote: flags.remote || 'origin', out: flags.out });
    else if (verb === 'run') r = await runSet({ set: flags.set, cwd: flags.cwd, base: flags.base, remote: flags.remote || 'origin', only: flags.only });
    else if (verb === 'gate') r = await gate({ mode: flags.mode, cwd: flags.cwd, base: flags.base, remote: flags.remote || 'origin', baseline: flags.baseline, outDir: flags['out-dir'], runstate: flags.runstate, shipMode: flags['ship-mode'], changedFiles: flags['changed-files'], ac: flags.ac, relaunch: flags.relaunch });
    else throw new UsageError(`unknown verb ${verb} (baseline | run | gate | push-env)`);
    process.stdout.write(`${JSON.stringify(r.result)}\n`);
    return r.code;
  } catch (e) {
    for (const g of live.groups) killGroup(g);
    process.stderr.write(`sf-gates: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
