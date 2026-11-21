#!/usr/bin/env node
/**
 * @file sf-base-branch.mjs
 * @description The one base-branch resolver for every sf-* skill and agent: which branch new work
 *   is cut from, synced from, reviewed against and PR'd into. Applies the precedence below,
 *   verifies every override exists as an origin ref, and prints the branch or exits non-zero.
 *   shipflow skills/shared/base-branch.md is the contract; this is its executable form. Zero
 *   dependencies. Byte-identical copies live in shipflow, shipflow and shipflow
 *   `scripts/` (pinned by shipflow scripts/__tests__/sf-base-branch.test.mjs); edit shipflow's and
 *   copy it.
 * @domain workflow-base-branch
 *
 * Usage:
 *   sf-base-branch [--cwd <dir>] [--runstate <path>] [--task-base <branch>] [--head <branch>]
 *                  [--allow-current]
 *   sf-base-branch --integration [--cwd <dir>]
 *   sf-base-branch --settings [--cwd <dir>]
 *
 * Precedence (default mode), first hit wins:
 *   1. `base_branch` in an existing --runstate file (a resume keeps the base it started on);
 *   2. --task-base (the tracker issue body's `## Base branch`);
 *   3. a non-empty SF_BASE_BRANCH;
 *   4. `target=` in `<toplevel of --cwd>/.sf-developer`;
 *   5. auto-detect: origin `development`/`develop` → origin/HEAD → origin `main`/`master`/`trunk`
 *      → (only with --allow-current) the current branch.
 *   An override (1–4) equal to --head is skipped. An empty --task-base or --head counts as absent.
 *   --integration runs level 5 only (without the current-branch rung). --settings prints
 *   {"developer":…,"target":…} for the .sf-developer at the toplevel of --cwd, null when absent.
 *
 * "On origin" means refs/remotes/origin/<branch> resolves. The resolver never fetches: callers run
 * their own `git fetch origin` first.
 *
 * `.sf-developer` grammar (the monorepo's developerStack.cjs `readDeveloperFile` parses the same
 * format; a parity test pins the two):
 *   - Line 1, trimmed, is the developer name when it contains no `=`; an empty line 1 means no name.
 *     A line 1 containing `=` is a key=value line.
 *   - Every later line is blank or `key=value`, split at the first `=`, both sides trimmed.
 *   - The only key is `target`. A duplicate key, an unknown key, or a bare line after line 1 is
 *     rejected.
 *   - A value (from the file, --task-base, SF_BASE_BRANCH or the runstate) must match
 *     ^[A-Za-z0-9._/-]+$ and not start with `-`, so it is safe as a shell word and never an option.
 *   - Writers emit the name line first, then `target=<branch>`.
 *
 * Output: the branch plus a newline on stdout, exit 0. Exit 1 (stderr only, nothing on stdout)
 * when an override is not on origin, the grammar or a value is invalid, the runstate is not a JSON
 * object or its base_branch is not a string, or auto-detect finds nothing. Exit 2 on a usage
 * error. A missing runstate file is not an error. File contents are never printed.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEVELOPER_FILE = '.sf-developer';
const KEYS = new Set(['target']);
const VALUE_RULE = 'must use only letters, digits, `.`, `_`, `/` and `-`, and must not start with `-`';

const HELP = `sf-base-branch — resolve the base branch for sf-* skills (shipflow skills/shared/base-branch.md)

  sf-base-branch [--cwd <dir>] [--runstate <path>] [--task-base <branch>] [--head <branch>] [--allow-current]
  sf-base-branch --integration [--cwd <dir>]
  sf-base-branch --settings [--cwd <dir>]

  Precedence: runstate base_branch → --task-base → SF_BASE_BRANCH → .sf-developer target= →
  auto-detect (development/develop → origin/HEAD → main/master/trunk [→ current with --allow-current]).
  An override equal to --head is skipped; an override missing on origin is an error, never a fallback.
  Prints the branch (or, with --settings, {"developer","target"} JSON). Exit 0 ok, 1 error, 2 usage.
`;

class ResolveError extends Error {}

function usage(msg) {
  process.stderr.write(`sf-base-branch: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const flags = {};
  const bools = new Set(['integration', 'settings', 'allow-current', 'help']);
  const valued = new Set(['cwd', 'runstate', 'task-base', 'head']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) usage(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (bools.has(key)) { flags[key] = true; continue; }
    if (!valued.has(key)) usage(`unknown flag --${key}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) usage(`--${key} needs a value`);
    flags[key] = v;
    i += 1;
  }
  if (flags.settings && flags.integration) usage('--settings and --integration are exclusive');
  return flags;
}

function gitOut(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}
const onOrigin = (cwd, branch) => gitOut(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]) !== null;

function toplevel(cwd) {
  const top = gitOut(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) throw new ResolveError(`${cwd} is not inside a git repository`);
  return top;
}

const validValue = (v) => typeof v === 'string' && /^[A-Za-z0-9._/-]+$/.test(v) && !v.startsWith('-');

/**
 * Parse `.sf-developer` text. Returns {developer, target}, each a string or undefined. Throws on a
 * grammar error with a message naming the line number; an unknown key or a value is never quoted.
 */
export function parseDeveloperFile(text) {
  const lines = String(text).split(/\r?\n/);
  const out = { developer: undefined, target: undefined };
  const seen = new Set();
  lines.forEach((raw, idx) => {
    const n = idx + 1;
    const line = raw.trim();
    if (line === '') return;
    const eq = line.indexOf('=');
    if (eq < 0) {
      if (n === 1) { out.developer = line; return; }
      throw new Error(`line ${n}: expected key=value (only line 1 may be a bare developer name)`);
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!KEYS.has(key)) throw new Error(`line ${n}: unknown key (the only key is \`target\`)`);
    if (seen.has(key)) throw new Error(`line ${n}: duplicate key \`${key}\``);
    seen.add(key);
    if (!validValue(value)) throw new Error(`line ${n}: key \`${key}\` value ${VALUE_RULE}`);
    out[key] = value;
  });
  return out;
}

/** Read and parse `<toplevel of cwd>/.sf-developer`. A missing file yields undefined keys; a bad one throws ResolveError. */
export function readDeveloperSettings(cwd = process.cwd()) {
  const file = join(toplevel(resolve(cwd)), DEVELOPER_FILE);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { file, developer: undefined, target: undefined };
    throw new ResolveError(`cannot read ${file}: ${e.code || e.message}`);
  }
  try {
    return { file, ...parseDeveloperFile(text) };
  } catch (e) {
    throw new ResolveError(`${file} ${e.message}. Fix or delete that line.`);
  }
}

function readRunstateBase(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw new ResolveError(`cannot read runstate ${path}: ${e.code || e.message}`);
  }
  let obj;
  try { obj = JSON.parse(text); } catch { throw new ResolveError(`runstate ${path} is not valid JSON`); }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new ResolveError(`runstate ${path} is not a JSON object`);
  if (!Object.prototype.hasOwnProperty.call(obj, 'base_branch')) return undefined;
  if (typeof obj.base_branch !== 'string') throw new ResolveError(`runstate ${path} base_branch is not a string`);
  return obj.base_branch;
}

function autoDetect(cwd, allowCurrent) {
  for (const b of ['development', 'develop']) if (onOrigin(cwd, b)) return b;
  const head = gitOut(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head && head.startsWith('refs/remotes/origin/')) return head.slice('refs/remotes/origin/'.length);
  for (const b of ['main', 'master', 'trunk']) if (onOrigin(cwd, b)) return b;
  if (allowCurrent) {
    const cur = gitOut(cwd, ['branch', '--show-current']);
    if (cur) return cur;
  }
  return null;
}

/**
 * Resolve the base branch. Returns {branch, source: "runstate"|"task"|"env"|"file"|"auto"}; throws
 * (ResolveError) on every exit-1 condition in the header.
 */
export function resolveBaseBranch({ cwd = process.cwd(), env = process.env, runstate, taskBase, head, integration = false, allowCurrent = false } = {}) {
  const dir = resolve(cwd);
  const top = toplevel(dir);
  const skipHead = head ? head : null;

  if (!integration) {
    const levels = [
      ['runstate', () => {
        if (!runstate) return undefined;
        const path = resolve(runstate);
        const v = readRunstateBase(path);
        return v === undefined ? undefined : { value: v, from: `runstate ${path} (base_branch)` };
      }],
      ['task', () => (taskBase ? { value: taskBase, from: "the task body's `## Base branch`" } : undefined)],
      ['env', () => (env.SF_BASE_BRANCH ? { value: env.SF_BASE_BRANCH, from: 'SF_BASE_BRANCH' } : undefined)],
      ['file', () => {
        const s = readDeveloperSettings(top);
        return s.target === undefined ? undefined : { value: s.target, from: `${s.file} (target=)` };
      }],
    ];
    for (const [source, get] of levels) {
      const hit = get();
      if (!hit) continue;
      if (!validValue(hit.value)) throw new ResolveError(`base branch from ${hit.from} is invalid: the value ${VALUE_RULE}`);
      if (skipHead && hit.value === skipHead) continue;
      if (!onOrigin(top, hit.value)) {
        throw new ResolveError(
          `base branch \`${hit.value}\` (from ${hit.from}) is not on origin (no refs/remotes/origin/${hit.value}). ` +
          'Push that branch or correct the setting, then run `git fetch origin`.',
        );
      }
      return { branch: hit.value, source };
    }
  }

  const auto = autoDetect(top, !integration && allowCurrent);
  if (!auto) {
    throw new ResolveError(
      'no base branch found: origin has no development/develop, no origin/HEAD and no main/master/trunk. ' +
      'Run `git fetch origin` (and `git remote set-head origin -a`), or set SF_BASE_BRANCH or `target=` in .sf-developer.',
    );
  }
  return { branch: auto, source: 'auto' };
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { process.stdout.write(HELP); return 0; }
  const cwd = flags.cwd ? resolve(flags.cwd) : process.cwd();
  try {
    if (flags.settings) {
      const s = readDeveloperSettings(cwd);
      process.stdout.write(`${JSON.stringify({ developer: s.developer ?? null, target: s.target ?? null })}\n`);
      return 0;
    }
    const { branch } = resolveBaseBranch({
      cwd, env: process.env, runstate: flags.runstate, taskBase: flags['task-base'], head: flags.head,
      integration: !!flags.integration, allowCurrent: !!flags['allow-current'],
    });
    process.stdout.write(`${branch}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof ResolveError)) throw e;
    process.stderr.write(`sf-base-branch: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
