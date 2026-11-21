#!/usr/bin/env node
/**
 * @file tracker.mjs
 * @description The tracker adapter for the shipflow skills — the ONE file that knows which
 *   project-management system holds a task's state. Every tracker read/write the skills make
 *   goes through this CLI, so porting shipflow to another PM platform (ClickUp, Linear, Jira,
 *   Asana, …) means re-implementing these verbs against that platform's API and nothing else.
 *   The skills, scripts and agents only ever see the JSON contract documented below.
 *
 *   This implementation backs the contract with **GitHub Issues** through the `gh` CLI:
 *     task        → issue (id = issue number)
 *     status      → exactly one `status:<slug>` label (e.g. `status:in-development`);
 *                   the terminal statuses `shipped` / `cancelled` also close the issue
 *     tag         → label
 *     subtask     → GitHub sub-issue (parent ↔ child via the sub-issues REST API)
 *     list        → the repository (`owner/repo`) — GitHub has no list level
 *     PR / branch → one sticky "Links" comment on the issue, edited in place
 *
 * Verbs (JSON on stdout, errors on stderr with a non-zero exit):
 *   whoami
 *   lists                                         → { repo, statuses }
 *   tag ensure <name> [--color hex]               → { name, created }
 *   task view <id> [--subtasks]                   → { id, name, url, status, parent, list, tags, markdown, subtasks? }
 *   task list [--status s]… [--updated-since d] [--json]
 *   task create --title t [--body-file f] [--status s] [--parent id] [--tag t]… [--list ignored]
 *   task edit <id> [--title t] [--body-file f]     (body is a full replacement)
 *   task status <id> "<status>"
 *   task comment <id> --body-file f
 *   task comments <id> [--all]                    → { id, comments:[{ id, body, author, created_at }] }
 *   task pr <id> --url <pr url>
 *   task branch <id> --url <branch url>
 *
 * Repository: `--repo owner/name`, else $SF_TRACKER_REPO, else the repo `gh` resolves from cwd.
 * Auth: whatever `gh auth status` has. On an auth error the skills tell the operator to run
 *   `gh auth login`; they never repair credentials themselves.
 * Attribution: every comment posts as the token's user, so agent comments open with a bold
 *   bracketed signature line — `**[<skill> · <context>]**` — to keep history attributable.
 *
 * Requires Node >= 18 and the GitHub CLI (`gh`) on PATH. Zero npm dependencies.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ---- The status lifecycle (shared vocabulary; see skills/ship-task §Status lifecycle) ----
export const STATUSES = [
  'backlog',
  'to do',
  'planning',
  'ready for development',
  'in development',
  'remediating',
  'development complete',
  'ready for testing',
  'testing',
  'shipped',
  'blocked',
  'cancelled',
];
const TERMINAL = { shipped: 'completed', cancelled: 'not planned' };
const STATUS_PREFIX = 'status:';
const LINKS_MARKER = '<!-- shipflow:links -->';

export const slug = (s) => String(s).trim().toLowerCase().replace(/\s+/g, '-');
export const statusLabel = (s) => `${STATUS_PREFIX}${slug(s)}`;
export function statusFromLabels(labels) {
  const hit = labels.find((l) => l.startsWith(STATUS_PREFIX));
  if (!hit) return null;
  const s = hit.slice(STATUS_PREFIX.length);
  return STATUSES.find((x) => slug(x) === s) ?? s.replace(/-/g, ' ');
}

function die(msg, code = 1) {
  process.stderr.write(`tracker: ${msg}\n`);
  process.exit(code);
}

// ---- Flags (supports repeated --tag / --status) --------------------------------
function parseFlags(args, { repeatable = [] } = {}) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true;
      if (repeatable.includes(key)) (flags[key] ||= []).push(val);
      else flags[key] = val;
    } else positional.push(a);
  }
  return { flags, positional };
}

const out = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

// ---- gh plumbing ------------------------------------------------------------------
let REPO = process.env.SF_TRACKER_REPO || null;

function gh(args, { json = false, input } = {}) {
  let text;
  try {
    text = execFileSync('gh', args, {
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    const detail = (e.stderr || e.message || '').toString().trim();
    if (/auth|login|401/i.test(detail)) die(`gh is not authenticated (${detail}) — run \`gh auth login\``);
    die(`gh ${args.slice(0, 3).join(' ')} … failed: ${detail}`);
  }
  if (!json) return text;
  return text.trim() ? JSON.parse(text) : {};
}

function repo() {
  if (!REPO) REPO = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
  return REPO;
}

const R = () => ['--repo', repo()];
const api = (path, extra = []) => gh(['api', ...extra, `repos/${repo()}/${path}`], { json: true });

function idOf(raw) {
  const m = String(raw ?? '').match(/(?:issues\/)?#?(\d+)$/);
  if (!m) die(`not an issue number or URL: ${raw}`);
  return m[1];
}

function issue(id) {
  return gh(
    ['issue', 'view', id, ...R(), '--json', 'number,title,url,state,body,labels'],
    { json: true },
  );
}

function parentOf(id) {
  try {
    const p = gh(['api', `repos/${repo()}/issues/${id}/parent`], { json: true });
    return p?.number ? String(p.number) : null;
  } catch {
    return null;
  }
}

function subIssues(id) {
  const rows = gh(['api', '--paginate', `repos/${repo()}/issues/${id}/sub_issues`], { json: true });
  return (Array.isArray(rows) ? rows : []).map((s) => {
    const labels = (s.labels || []).map((l) => l.name);
    return { id: String(s.number), name: s.title, status: statusFromLabels(labels) ?? (s.state === 'closed' ? 'shipped' : null), url: s.html_url };
  });
}

function ensureLabel(name, color = '656f7d') {
  const existing = gh(['label', 'list', ...R(), '--search', name, '--json', 'name', '--limit', '200'], { json: true });
  if ((existing || []).some((l) => l.name.toLowerCase() === name.toLowerCase())) return false;
  gh(['label', 'create', name, ...R(), '--color', color]);
  return true;
}

// ---- Verbs ------------------------------------------------------------------------
function cmdWhoami() {
  out({ login: gh(['api', 'user', '-q', '.login']).trim(), repo: repo() });
}

function cmdLists() {
  out({ repo: repo(), statuses: STATUSES, status_labels: STATUSES.map(statusLabel) });
}

function cmdTag(sub, rest) {
  const { flags, positional } = parseFlags(rest);
  if (sub !== 'ensure') die(`unknown tag subcommand: ${sub ?? '(none)'} — ensure`);
  const name = positional[0];
  if (!name) die('tag ensure <name> [--color hex] required');
  out({ name, created: ensureLabel(name, typeof flags.color === 'string' ? flags.color : undefined) });
}

function cmdTaskView(rest) {
  const { flags, positional } = parseFlags(rest);
  const id = idOf(positional[0]);
  const i = issue(id);
  const labels = (i.labels || []).map((l) => l.name);
  const view = {
    id: String(i.number),
    name: i.title,
    url: i.url,
    status: statusFromLabels(labels) ?? (i.state === 'CLOSED' ? 'shipped' : null),
    state: i.state,
    parent: parentOf(id),
    list: { id: repo(), name: repo() },
    tags: labels.filter((l) => !l.startsWith(STATUS_PREFIX)),
    markdown: i.body ?? '',
  };
  if (flags.subtasks) view.subtasks = subIssues(id);
  out(view);
}

function cmdTaskList(rest) {
  const { flags } = parseFlags(rest, { repeatable: ['status'] });
  const args = ['issue', 'list', ...R(), '--state', 'open', '--limit', '500', '--json', 'number,title,url,labels,updatedAt'];
  let rows = gh(args, { json: true }).map((i) => ({
    id: String(i.number),
    name: i.title,
    status: statusFromLabels(i.labels.map((l) => l.name)),
    url: i.url,
    date_updated: i.updatedAt,
  }));
  if (flags.status) {
    const want = new Set(flags.status.map(slug));
    rows = rows.filter((r) => r.status && want.has(slug(r.status)));
  }
  if (flags['updated-since'] !== undefined) {
    const days = Number(flags['updated-since']);
    if (!Number.isFinite(days) || days <= 0) die('task list: --updated-since must be a positive number of days');
    const cutoff = Date.now() - days * 86_400_000;
    rows = rows.filter((r) => Date.parse(r.date_updated) >= cutoff);
  }
  if (flags.json) return process.stdout.write(`${JSON.stringify(rows)}\n`);
  for (const r of rows) process.stdout.write(`#${r.id}\t${r.status ?? ''}\t${r.date_updated.slice(0, 10)}\t${r.name}\n`);
}

function setStatus(id, status) {
  if (!STATUSES.includes(status)) die(`unknown status "${status}" — one of: ${STATUSES.join(', ')}`);
  ensureLabel(statusLabel(status), '0e8a16');
  const i = issue(id);
  const stale = (i.labels || []).map((l) => l.name).filter((l) => l.startsWith(STATUS_PREFIX) && l !== statusLabel(status));
  const args = ['issue', 'edit', id, ...R(), '--add-label', statusLabel(status)];
  for (const l of stale) args.push('--remove-label', l);
  gh(args);
  if (TERMINAL[status] && i.state !== 'CLOSED') gh(['issue', 'close', id, ...R(), '--reason', TERMINAL[status]]);
  if (!TERMINAL[status] && i.state === 'CLOSED') gh(['issue', 'reopen', id, ...R()]);
}

function cmdTaskCreate(rest) {
  const { flags } = parseFlags(rest, { repeatable: ['tag'] });
  if (typeof flags.title !== 'string') die('task create: --title <t> required');
  const body = flags['body-file'] ? readFileSync(flags['body-file'], 'utf8') : '';
  for (const t of flags.tag || []) ensureLabel(t);
  const args = ['issue', 'create', ...R(), '--title', flags.title, '--body-file', '-'];
  for (const t of flags.tag || []) args.push('--label', t);
  const url = gh(args, { input: body }).trim().split('\n').pop();
  const id = idOf(url);
  if (typeof flags.status === 'string') setStatus(id, flags.status);
  if (typeof flags.parent === 'string') {
    const child = api(`issues/${id}`);
    gh(['api', '-X', 'POST', `repos/${repo()}/issues/${idOf(flags.parent)}/sub_issues`, '-F', `sub_issue_id=${child.id}`]);
  }
  out({ id, url, name: flags.title, status: typeof flags.status === 'string' ? flags.status : null });
}

function cmdTaskEdit(rest) {
  const { flags, positional } = parseFlags(rest);
  const id = idOf(positional[0]);
  const args = ['issue', 'edit', id, ...R()];
  let input;
  if (typeof flags.title === 'string') args.push('--title', flags.title);
  if (flags['body-file']) {
    args.push('--body-file', '-');
    input = readFileSync(flags['body-file'], 'utf8');
  }
  const hasStatus = typeof flags.status === 'string';
  const hasEdit = typeof flags.title === 'string' || input !== undefined;
  if (!hasStatus && !hasEdit) die('task edit: nothing to change — pass --title, --body-file and/or --status');
  if (hasEdit) gh(args, { input });
  if (hasStatus) setStatus(id, flags.status);
  out({ id, ...(typeof flags.title === 'string' ? { name: flags.title } : {}), ...(hasStatus ? { status: flags.status } : {}) });
}

function cmdTaskStatus(rest) {
  const { positional } = parseFlags(rest);
  const [raw, status] = positional;
  if (!raw || !status) die('task status <id> "<status>" required');
  const id = idOf(raw);
  setStatus(id, status);
  out({ id, status });
}

function cmdTaskComment(rest) {
  const { flags, positional } = parseFlags(rest);
  const id = idOf(positional[0]);
  if (!flags['body-file']) die('task comment: --body-file <f> required');
  const url = gh(['issue', 'comment', id, ...R(), '--body-file', '-'], { input: readFileSync(flags['body-file'], 'utf8') }).trim();
  out({ id, comment_url: url });
}

function comments(id, all) {
  const rows = gh(['api', ...(all ? ['--paginate'] : []), `repos/${repo()}/issues/${id}/comments?per_page=100`], { json: true });
  return (Array.isArray(rows) ? rows : []).map((c) => ({ id: String(c.id), body: c.body ?? '', author: c.user?.login ?? null, created_at: c.created_at }));
}

function cmdTaskComments(rest) {
  const { flags, positional } = parseFlags(rest);
  const id = idOf(positional[0]);
  out({ id, comments: comments(id, Boolean(flags.all)) });
}

// PR and branch link-back: one sticky comment per issue, rewritten in place, so a task
// carries first-class links to its branch and PR however many times a run re-submits.
function upsertLink(id, key, url) {
  const sticky = comments(id, true).find((c) => c.body.startsWith(LINKS_MARKER));
  const lines = new Map();
  if (sticky) {
    for (const m of sticky.body.matchAll(/^- \*\*(.+?):\*\* (\S+)$/gm)) lines.set(m[1], m[2]);
  }
  lines.set(key, url);
  const body = [LINKS_MARKER, '**[shipflow · links]**', '', ...[...lines].map(([k, v]) => `- **${k}:** ${v}`)].join('\n');
  if (sticky) gh(['api', '-X', 'PATCH', `repos/${repo()}/issues/comments/${sticky.id}`, '-f', `body=${body}`]);
  else gh(['issue', 'comment', id, ...R(), '--body-file', '-'], { input: body });
  return { id, field: key, value: url };
}

function cmdTaskLink(key, rest) {
  const { flags, positional } = parseFlags(rest);
  const id = idOf(positional[0]);
  if (typeof flags.url !== 'string') die(`task ${key === 'GitHub PR' ? 'pr' : 'branch'} <id> --url <url> required`);
  out(upsertLink(id, key, flags.url));
}

// ---- Dispatch ---------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf('--repo');
  if (ri >= 0) {
    REPO = argv[ri + 1];
    argv.splice(ri, 2);
  }
  const [verb, sub, ...rest] = argv;
  switch (verb) {
    case 'whoami':
      return cmdWhoami();
    case 'lists':
      return cmdLists();
    case 'tag':
      return cmdTag(sub, rest);
    case 'task':
      switch (sub) {
        case 'view':
          return cmdTaskView(rest);
        case 'list':
          return cmdTaskList(rest);
        case 'create':
          return cmdTaskCreate(rest);
        case 'edit':
          return cmdTaskEdit(rest);
        case 'status':
          return cmdTaskStatus(rest);
        case 'comment':
          return cmdTaskComment(rest);
        case 'comments':
          return cmdTaskComments(rest);
        case 'pr':
          return cmdTaskLink('GitHub PR', rest);
        case 'branch':
          return cmdTaskLink('GitHub Branch', rest);
        default:
          return die(`unknown task subcommand: ${sub ?? '(none)'}`);
      }
    default:
      return die(`unknown verb: ${verb ?? '(none)'} — whoami|lists|tag|task`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
