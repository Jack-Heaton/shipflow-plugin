#!/usr/bin/env node
/**
 * @file sf-config.mjs
 * @description Loads and validates the repo-declared shipflow settings file
 *   (`<git toplevel>/.shipflow.json`): push-gate suites, the manifest-drift check and migration
 *   directories, the paths whose changes owe a live dev run (`live_check`), the reviewer
 *   seats the panel cap never drops (`review.cap_exempt`), and the verified push command
 *   (`push.verified`). The plugin
 *   serves several repos, so every repo-specific command lives in that file, never in a script.
 *   skills/shared/repo-config.md is the schema; this is its executable form. Zero dependencies.
 * @domain workflow-repo-config
 *
 * Contract: loadRepoConfig(cwd) → { path, config, warnings } (the working-tree copy).
 *   - `cwd` outside a git repo, or no `.shipflow.json` at its toplevel → { path: null, config: {}, warnings: [] }.
 *   - Unknown keys → `warnings` (a newer config read by an older vendored plugin still loads).
 *   - An unreadable file, invalid JSON or a wrong type → throws. tryLoadRepoConfig(cwd) is the
 *     non-throwing form ({ …, error }) for run-path consumers.
 *   loadRepoConfigAt(cwd, ref) → { path, config, warnings, sha, text? }: the copy committed at `ref`
 *     (gate decisions read the base's copy, never the branch's). Absent from the tree →
 *     undeclared; a ref that does not resolve or any other git error → throws.
 *   - Commands are argv arrays (run without a shell). Path patterns are JS regex sources
 *     matched against repo-relative POSIX paths.
 *
 * CLI: `sf-config [--cwd <dir>]` prints the loaded result as JSON (exit 2 on an invalid file).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = '.shipflow.json';

const TOP_KEYS = ['push_gates', 'manifest_drift', 'migrations', 'live_check', 'review', 'push'];

function gitToplevel(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function fail(path, where, what) {
  throw new Error(`${path}: ${where} ${what}`);
}

function checkArgv(path, where, v) {
  if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === 'string' && s.length > 0)) {
    fail(path, where, 'must be a non-empty argv array of non-empty strings (run without a shell)');
  }
}

function checkString(path, where, v) {
  if (typeof v !== 'string' || v.trim() === '') fail(path, where, 'must be a non-empty string');
}

function unknownKeys(obj, known, where, warnings) {
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) warnings.push(`${where}: unknown key "${k}" ignored`);
  }
}

function checkCommand(path, where, v, warnings, extra = []) {
  if (!isObj(v)) fail(path, where, 'must be an object');
  checkString(path, `${where}.name`, v.name);
  checkArgv(path, `${where}.run`, v.run);
  unknownKeys(v, ['name', 'run', ...extra], where, warnings);
}

/** Validate a parsed config in place; returns warnings, throws on a wrong type. */
export function validateRepoConfig(config, path = CONFIG_FILE) {
  const warnings = [];
  if (!isObj(config)) fail(path, 'top level', 'must be a JSON object');
  unknownKeys(config, TOP_KEYS, 'top level', warnings);

  if (config.push_gates !== undefined) {
    const pg = config.push_gates;
    if (!isObj(pg)) fail(path, 'push_gates', 'must be an object');
    unknownKeys(pg, ['setup', 'suites'], 'push_gates', warnings);
    if (pg.setup !== undefined) checkArgv(path, 'push_gates.setup', pg.setup);
    if (pg.suites !== undefined) {
      if (!Array.isArray(pg.suites)) fail(path, 'push_gates.suites', 'must be an array');
      const seen = new Set();
      pg.suites.forEach((s, i) => {
        const where = `push_gates.suites[${i}]`;
        checkCommand(path, where, s, warnings, ['timeout_ms', 'skip_env']);
        if (seen.has(s.name)) fail(path, `${where}.name`, `duplicates suite "${s.name}"`);
        seen.add(s.name);
        if (s.timeout_ms !== undefined && !(Number.isInteger(s.timeout_ms) && s.timeout_ms > 0)) {
          fail(path, `${where}.timeout_ms`, 'must be a positive integer');
        }
        if (s.skip_env !== undefined && !(typeof s.skip_env === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.skip_env))) {
          fail(path, `${where}.skip_env`, 'must be an environment variable name');
        }
      });
    }
  }

  if (config.manifest_drift !== undefined) checkCommand(path, 'manifest_drift', config.manifest_drift, warnings);

  if (config.migrations !== undefined) {
    if (!Array.isArray(config.migrations)) fail(path, 'migrations', 'must be an array');
    config.migrations.forEach((m, i) => {
      const where = `migrations[${i}]`;
      if (!isObj(m)) fail(path, where, 'must be an object');
      checkString(path, `${where}.dir`, m.dir);
      checkString(path, `${where}.pattern`, m.pattern);
      checkString(path, `${where}.renumber`, m.renumber);
      let groups;
      try { groups = new RegExp(`${m.pattern}|`).exec('').length - 1; } catch (e) { fail(path, `${where}.pattern`, `is not a valid regex: ${e.message}`); }
      if (groups < 1) fail(path, `${where}.pattern`, 'must have a capture group for the migration number');
      unknownKeys(m, ['dir', 'pattern', 'renumber'], where, warnings);
    });
  }

  if (config.live_check !== undefined) {
    const lc = config.live_check;
    if (!isObj(lc)) fail(path, 'live_check', 'must be an object');
    if (!Array.isArray(lc.paths) || lc.paths.length === 0) fail(path, 'live_check.paths', 'must be a non-empty array of regex sources');
    lc.paths.forEach((p, i) => {
      const where = `live_check.paths[${i}]`;
      checkString(path, where, p);
      try { new RegExp(p); } catch (e) { fail(path, where, `is not a valid regex: ${e.message}`); }
    });
    checkString(path, 'live_check.instructions', lc.instructions);
    if (lc.dev_probe !== undefined) checkArgv(path, 'live_check.dev_probe', lc.dev_probe);
    unknownKeys(lc, ['paths', 'instructions', 'dev_probe'], 'live_check', warnings);
  }

  if (config.review !== undefined) {
    const rv = config.review;
    if (!isObj(rv)) fail(path, 'review', 'must be an object');
    if (rv.cap_exempt !== undefined) {
      if (!Array.isArray(rv.cap_exempt)) fail(path, 'review.cap_exempt', 'must be an array of reviewer names');
      rv.cap_exempt.forEach((n, i) => checkString(path, `review.cap_exempt[${i}]`, n));
    }
    unknownKeys(rv, ['cap_exempt'], 'review', warnings);
  }

  if (config.push !== undefined) {
    const ps = config.push;
    if (!isObj(ps)) fail(path, 'push', 'must be an object');
    if (ps.verified !== undefined) checkArgv(path, 'push.verified', ps.verified);
    unknownKeys(ps, ['verified'], 'push', warnings);
  }
  return warnings;
}

export function loadRepoConfig(cwd = process.cwd()) {
  const top = gitToplevel(resolve(cwd));
  if (!top) return { path: null, config: {}, warnings: [] };
  const path = join(top, CONFIG_FILE);
  if (!existsSync(path)) return { path: null, config: {}, warnings: [] };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`${path}: cannot read: ${e.message}`);
  }
  return parseRepoConfig(text, path);
}

function parseRepoConfig(text, path) {
  let config;
  try {
    config = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: invalid JSON: ${e.message}`);
  }
  const warnings = validateRepoConfig(config, path);
  return { path, config, warnings };
}

/** Non-throwing loadRepoConfig: a read or validation failure comes back as `error`. */
export function tryLoadRepoConfig(cwd = process.cwd()) {
  try {
    return { ...loadRepoConfig(cwd), error: null };
  } catch (e) {
    return { path: null, config: {}, warnings: [], error: e.message };
  }
}

const gitOut = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The `.shipflow.json` committed at `ref` (for example `origin/development`). */
export function loadRepoConfigAt(cwd, ref) {
  let sha;
  try { sha = gitOut(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim(); } catch { sha = ''; }
  if (!sha) throw new Error(`${ref} does not resolve in ${cwd} (fetch it first)`);
  const where = `${ref}:${CONFIG_FILE}`;
  let listed;
  try { listed = gitOut(cwd, ['ls-tree', '--full-tree', '--name-only', sha, '--', CONFIG_FILE]).trim(); } catch (e) {
    throw new Error(`${where}: git ls-tree failed: ${(e.stderr || e.message).toString().trim()}`);
  }
  if (!listed) return { path: null, config: {}, warnings: [], sha };
  let text;
  try { text = gitOut(cwd, ['show', `${sha}:${CONFIG_FILE}`]); } catch (e) {
    throw new Error(`${where}: git show failed: ${(e.stderr || e.message).toString().trim()}`);
  }
  return { ...parseRepoConfig(text, where), sha, text };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--cwd');
  const cwd = i > 0 && process.argv[i + 1] ? process.argv[i + 1] : process.cwd();
  try {
    process.stdout.write(`${JSON.stringify(loadRepoConfig(cwd))}\n`);
  } catch (e) {
    process.stderr.write(`sf-config: ${e.message}\n`);
    process.exit(2);
  }
}
