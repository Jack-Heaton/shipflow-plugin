/**
 * @file fake-app-server.cjs
 * @description Stdio fake of `codex app-server --stdio` for sf-codex.test.mjs. Speaks the JSON-RPC
 *   wire format verified in protocol-notes.md (initialize / thread/start / turn/start + the
 *   item/* , thread/tokenUsage/updated, thread/compacted, turn/completed notifications and the
 *   turn/steer / turn/interrupt requests). One scenario per FAKE_AS_SCENARIO drives the writer
 *   lifecycle: happy, slow-then-steer, steer-then-stale, interrupt-then-stale, hang,
 *   hang-quiet-report, hang-then-crash-report, busy-forever, crash, rate-limit-then-complete,
 *   server-request. Records every request it receives to FAKE_AS_LOG (one {method,params}
 *   JSON line) and each turn/start prompt to FAKE_CODEX_PROMPTS. Node built-ins only.
 *   Hardening knobs (SEC-L1/SEC-L2 coverage): FAKE_AS_THREAD_ID overrides the thread id returned by
 *   thread/start (an unsafe `/`- or `..`-bearing id exercises safeThreadId rejection);
 *   FAKE_AS_GIANT_NOLINE writes that many bytes of no-newline junk before the work turn's frames
 *   (the 8 MiB stdout buffer drop + resync); FAKE_AS_GIANT_CMD_OUT sets the work turn command's
 *   aggregatedOutput length (capAggregatedOutput).
 * @domain workflow-review-backend
 */
'use strict';
const fs = require('fs');

const SCENARIO = process.env.FAKE_AS_SCENARIO || 'happy';
const TICK = Number(process.env.FAKE_AS_TICK_MS || 50);
const COMPACTIONS = Number(process.env.FAKE_AS_COMPACTIONS || 0);
const HANG_AFTER_CMD = process.env.FAKE_AS_HANG_AFTER_CMD === '1';
const RATE_LIMIT = process.env.FAKE_AS_RATE_LIMIT === '1';
// A `/`- or `..`-bearing id must be rejected as a filename by sf-codex (safeThreadId); default safe.
const TID = process.env.FAKE_AS_THREAD_ID || 't-as-1';
const GIANT_NOLINE = Number(process.env.FAKE_AS_GIANT_NOLINE || 0);
const GIANT_CMD_OUT = Number(process.env.FAKE_AS_GIANT_CMD_OUT || 0);

// Which launch of the app-server this process is (the rate-limit scenario fails the first and
// succeeds the second; sf-codex spawns a fresh process per attempt, like `codex exec` relaunches).
let launchNum = 1;
if (RATE_LIMIT) {
  const f = process.env.FAKE_AS_LAUNCH || `${process.env.FAKE_AS_LOG}.launch`;
  try { launchNum = Number(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 0) + 1; } catch { launchNum = 1; }
  try { fs.writeFileSync(f, String(launchNum)); } catch { /* ignore */ }
}

let replies = [];
try { replies = fs.readFileSync(process.env.FAKE_CODEX_REPLY, 'utf8').split('\n').filter(Boolean); } catch { replies = []; }
let replyIdx = 0;
const nextReply = () => (replies.length ? replies[Math.min(replyIdx++, replies.length - 1)] : '{}');

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const logReq = (method, params) => { try { fs.appendFileSync(process.env.FAKE_AS_LOG, `${JSON.stringify({ method, params })}\n`); } catch { /* ignore */ } };
const recordPrompt = (params) => {
  const text = params && Array.isArray(params.input) && params.input[0] ? params.input[0].text : '';
  try { fs.appendFileSync(process.env.FAKE_CODEX_PROMPTS, `=====\n${text}\n`); } catch { /* ignore */ }
};

const turnStarted = (id) => ({ method: 'turn/started', params: { threadId: TID, turn: { id, status: 'inProgress' } } });
const cmdItem = (turnId, exit, command = 'git diff') => ({ method: 'item/completed', params: { threadId: TID, turnId, item: { type: 'commandExecution', command, exitCode: exit, status: exit ? 'failed' : 'completed', aggregatedOutput: exit ? 'bwrap: No permissions' : 'diff --git a/a.ts' } } });
const startedCmd = (turnId) => ({ method: 'item/started', params: { threadId: TID, turnId, item: { type: 'commandExecution', command: 'sleep 999', status: 'inProgress' }, startedAtMs: Date.now() } });
const msgItem = (turnId, text) => ({ method: 'item/completed', params: { threadId: TID, turnId, item: { type: 'agentMessage', text, phase: 'final_answer' } } });
const tokenUsage = (turnId, i, c, o, r) => ({ method: 'thread/tokenUsage/updated', params: { threadId: TID, turnId, tokenUsage: { total: { totalTokens: i + o, inputTokens: i, cachedInputTokens: c, outputTokens: o, reasoningOutputTokens: r }, last: {}, modelContextWindow: 258400 } } });
const turnCompleted = (id, status, text) => ({ method: 'turn/completed', params: { threadId: TID, turn: { id, status, error: status === 'failed' ? { message: 'turn failed' } : null, items: text ? [{ type: 'agentMessage', text, phase: 'final_answer' }] : [] } } });

let turnCount = 0;
let busyTimer = null;
let pendingServerReq = null; // server-request scenario: resolved when sf-codex rejects id 99
const after = (fn) => setTimeout(fn, TICK);

// A command whose aggregatedOutput is larger than capAggregatedOutput's 4096-char head: the seat
// must still deliver (the cap is applied on ingest; the huge string is never retained whole).
const bigCmdItem = (turnId) => ({ method: 'item/completed', params: { threadId: TID, turnId, item: { type: 'commandExecution', command: 'git diff', exitCode: 0, status: 'completed', aggregatedOutput: 'y'.repeat(GIANT_CMD_OUT) } } });
// A pathological partial line with NO newline, written straight to stdout ahead of the real
// frames: once it passes the 8 MiB ceiling sf-codex drops it and resyncs on the terminating
// newline, so the work turn's frames that follow still parse.
function emitGiantNoLine() {
  if (!GIANT_NOLINE) return;
  process.stdout.write('x'.repeat(GIANT_NOLINE));
  process.stdout.write('\n'); // terminate the junk so the frames after it are clean lines
}

/** The notification tail shared by the "happy" completion of any turn. */
function finishHappy(turnId, { withCmd = true, compactions = 0, gitCmd = false, bigCmd = false } = {}) {
  if (withCmd) send(bigCmd ? bigCmdItem(turnId) : cmdItem(turnId, 0));
  if (gitCmd) send(cmdItem(turnId, 0, 'git log --oneline'));
  send(tokenUsage(turnId, 100, 40, 10, 5));
  send(tokenUsage(turnId, 200, 80, 20, 10));
  for (let i = 0; i < compactions; i++) send({ method: 'thread/compacted', params: { threadId: TID, turnId } });
  const reply = nextReply();
  send(msgItem(turnId, reply));
  send(turnCompleted(turnId, 'completed', reply));
}

function startBusy(turnId) {
  busyTimer = setInterval(() => send(cmdItem(turnId, 0)), TICK);
  if (busyTimer.unref) busyTimer.unref();
}
function stopBusy() { if (busyTimer) { clearInterval(busyTimer); busyTimer = null; } }

function onTurnStart(n, id) {
  // happy always, plus the report/re-ask turns of every scenario, complete normally.
  if (SCENARIO === 'happy' || n >= 2) {
    if (RATE_LIMIT && launchNum === 1 && n === 1) {
      after(() => {
        send(turnStarted(id));
        send(tokenUsage(id, 100, 40, 10, 5));
        send({ method: 'error', params: { threadId: TID, turnId: id, error: { message: 'usage limit reached (429)' }, willRetry: false } });
        send(turnCompleted(id, 'failed'));
      });
      return;
    }
    if (SCENARIO === 'hang' && n === 2) {
      // The report turn: a STRAY item from the interrupted turn-1 arrives first (its completion
      // was in flight across the interrupt), then the report turn's own git command + reply.
      after(() => {
        send(turnStarted(id));
        send(cmdItem('turn-1', 0, 'git status'));   // stray, OLD turn id
        send(cmdItem(id, 0, 'git log --oneline'));
        const reply = nextReply();
        send(msgItem(id, reply));
        send(turnCompleted(id, 'completed', reply));
      });
      return;
    }
    if (SCENARIO === 'hang-then-crash-report' && n === 2) {
      // The report turn crashes: the app-server exits mid-report (ARCH-L1). sf-codex must record
      // crashed:true and a detail naming the report turn, not the default crashed:false.
      after(() => { send(turnStarted(id)); process.exit(1); });
      return;
    }
    if (SCENARIO === 'hang-quiet-report' && n === 2) {
      // The report turn answers the git-report prompt from context: a reply with NO command, so
      // the seat's derived stats.ok stays 0 — exercises the interrupted-reported blind exemption.
      after(() => {
        send(turnStarted(id));
        const reply = nextReply();
        send(msgItem(id, reply));
        send(turnCompleted(id, 'completed', reply));
      });
      return;
    }
    // A report turn (n ≥ 2 of an interrupted scenario) runs a git-log command; a happy re-ask turn
    // behaves exactly like turn 1 (one command), so commands_run counts only real work. The giant
    // knobs apply to the work turn (n === 1) only.
    after(() => {
      if (n === 1) emitGiantNoLine();
      send(turnStarted(id));
      finishHappy(id, { compactions: n === 1 ? COMPACTIONS : 0, gitCmd: n >= 2 && SCENARIO !== 'happy', bigCmd: n === 1 && GIANT_CMD_OUT > 0 });
    });
    return;
  }
  // Work turn (n === 1) of a lifecycle scenario.
  if (SCENARIO === 'crash') { after(() => { send(turnStarted(id)); process.exit(1); }); return; }
  if (SCENARIO === 'hang' || SCENARIO === 'hang-quiet-report' || SCENARIO === 'hang-then-crash-report') {
    after(() => { send(turnStarted(id)); if (HANG_AFTER_CMD) send(cmdItem(id, 0)); send(startedCmd(id)); /* never completes → idle interrupt */ });
    return;
  }
  if (SCENARIO === 'rate-limit-then-complete') {
    // A 429 error notification (willRetry:false) that is FOLLOWED by a completed turn: the seat
    // delivered, so session.rateLimited is true but outcome is 'ok' — the retry must NOT fire.
    after(() => {
      send(turnStarted(id));
      send(cmdItem(id, 0));
      send(tokenUsage(id, 100, 40, 10, 5));
      send(tokenUsage(id, 200, 80, 20, 10));
      send({ method: 'error', params: { threadId: TID, turnId: id, error: { message: 'usage limit reached (429)' }, willRetry: false } });
      const reply = nextReply();
      send(msgItem(id, reply));
      send(turnCompleted(id, 'completed', reply));
    });
    return;
  }
  if (SCENARIO === 'server-request') {
    after(() => {
      send(turnStarted(id));
      send(cmdItem(id, 0));
      send(tokenUsage(id, 100, 40, 10, 5));
      send(tokenUsage(id, 200, 80, 20, 10));
      pendingServerReq = () => { const reply = nextReply(); send(msgItem(id, reply)); send(turnCompleted(id, 'completed', reply)); };
      send({ id: 99, method: 'item/commandExecution/requestApproval', params: {} });
    });
    return;
  }
  // slow-then-steer / steer-then-stale / interrupt-then-stale / busy-forever: keep running.
  after(() => { send(turnStarted(id)); startBusy(id); });
}

function onSteer(params) {
  const id = params.expectedTurnId;
  if (SCENARIO === 'steer-then-stale') {
    send({ jsonrpc: '2.0', id: lastReqId, error: { code: -32600, message: 'no active turn to steer' } });
    stopBusy();
    const reply = nextReply();
    send(turnCompleted(id, 'completed', reply));
    return;
  }
  send({ jsonrpc: '2.0', id: lastReqId, result: { turnId: id } });
  if (SCENARIO === 'slow-then-steer') {
    stopBusy();
    after(() => { const reply = nextReply(); send(msgItem(id, reply)); send(turnCompleted(id, 'completed', reply)); });
  }
  // interrupt-then-stale / busy-forever ignore the steer and keep running until interrupt.
}

function onInterrupt(params) {
  const id = params.turnId;
  if (SCENARIO === 'interrupt-then-stale') {
    send({ jsonrpc: '2.0', id: lastReqId, error: { code: -32600, message: 'no active turn to interrupt' } });
    stopBusy();
    const reply = nextReply();
    send(turnCompleted(id, 'completed', reply));
    return;
  }
  send({ jsonrpc: '2.0', id: lastReqId, result: {} });
  stopBusy();
  // hang / busy-forever: the turn ends as interrupted; sf-codex then runs the report turn.
  send(turnCompleted(id, 'interrupted'));
}

let lastReqId = null;
function handle(msg) {
  // A response from sf-codex to our server → client request (id, no method).
  if (msg.id !== undefined && !msg.method) { if (msg.id === 99 && pendingServerReq) { const f = pendingServerReq; pendingServerReq = null; f(); } return; }
  lastReqId = msg.id;
  const { method, params = {} } = msg;
  if (method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake-app-server', codexHome: process.env.CODEX_HOME || '', platformFamily: 'linux', platformOs: 'linux' } }); return; }
  if (method === 'initialized') return; // notification
  if (method === 'thread/start') { logReq(method, params); send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: TID }, model: params.model, cwd: params.cwd, sandbox: params.sandbox, approvalPolicy: params.approvalPolicy, serviceTier: params.serviceTier } }); return; }
  if (method === 'turn/start') {
    logReq(method, params);
    recordPrompt(params);
    turnCount += 1;
    const id = `turn-${turnCount}`;
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id, status: 'inProgress', items: [] } } });
    onTurnStart(turnCount, id);
    return;
  }
  if (method === 'turn/steer') { logReq(method, params); onSteer(params); return; }
  if (method === 'turn/interrupt') { logReq(method, params); onInterrupt(params); return; }
  // anything else: ignore (with an id, answer empty so it cannot hang)
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
// sf-codex's close() ends stdin (then SIGTERMs the group); exit cleanly when it does.
process.stdin.on('end', () => process.exit(0));
