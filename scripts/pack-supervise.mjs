#!/usr/bin/env node
// Detached per-task supervisor. Spawns `opencode run` with stdin ignored and stdout/stderr on files, watches the
// JSON stream, relaunches once on a banner-only exit, writes exit.json, releases the checkout lock. Pure plumbing.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { packPaths, readJson, atomicWriteJson, parseArgs, OC_BIN, appendLine, ensureDir, clip } from './lib/paths.mjs';
import { iso } from './lib/time.mjs';
import { summarize, attemptMarkerLine, attemptDiagnostics } from './lib/events.mjs';
import { loadConfig, loadRoster, updateRoster, findTask } from './lib/roster.mjs';
import { buildInvocation } from './lib/runtimes.mjs';

const args = parseArgs(process.argv.slice(2));
const pack = args.pack, id = args.task;
if (!pack || !id) { console.error('usage: pack-supervise.mjs --pack <dir> --task <ID> [--attempt n] [--kind start|instruct|probe] [--session ses] [--prompt-file f] [--max-minutes n] [--no-roster --model m --cwd dir --task-dir dir --title t]'); process.exit(1); }
const pp = packPaths(pack);
const cfg = loadConfig(pp);
const kind = args.kind || 'start';
const noRoster = !!args['no-roster'];
const row = noRoster ? null : findTask(loadRoster(pp), id);
if (!noRoster && !row) { console.error(`task ${id} not in roster`); process.exit(5); }
const backend = args.backend || row?.tool || 'opencode';

const root = args.root || cfg.root;
const model = args.model || row?.model;
const variant = args.variant || row?.variant || cfg.default_variant;
const agent = args.agent !== undefined ? (args.agent === 'none' ? null : args.agent) : (row?.agent ?? null);
const checkout = args.cwd || row?.checkout || root;
const taskDir = args['task-dir'] || row?.task_dir || pp.taskDir(id);
const title = args.title || row?.title || `${pp.name}/${id}`;
const session0 = args.session || null;
const promptFile = args['prompt-file'] || path.join(taskDir, 'PROMPT.txt');
const maxMinutes = Number(args['max-minutes'] || 0);
const lockPath = args.lock || null;
const bannerTimeoutMs = (cfg.limits.banner_timeout_s || 60) * 1000;
ensureDir(taskDir);
const runFile = path.join(taskDir, 'run.jsonl');
const launchLog = path.join(taskDir, 'launch.log');
const supLog = path.join(taskDir, 'supervisor.log');
const log = (m) => appendLine(supLog, `${iso()} [${id}] ${m}`);
const prompt = fs.readFileSync(promptFile, 'utf8');

function roster(fn) { if (!noRoster) { try { updateRoster(pp, (r) => { const t = findTask(r, id); if (t) fn(t); }); } catch (e) { log(`roster update failed: ${e.message}`); } } }
function lockSet(patch) { if (!lockPath) return; try { const o = readJson(lockPath, {}); if (o.task === id || !o.task) atomicWriteJson(lockPath, { ...o, ...patch }); } catch {} }
function lockRelease() { if (!lockPath) return; try { const o = readJson(lockPath, {}); if (o.task === id) fs.unlinkSync(lockPath); } catch {} }
function killGroup(pid, sig) { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} } }


function launch(attempt, sessionId) {
  const outFd = fs.openSync(runFile, 'a');
  const errFd = fs.openSync(launchLog, 'a');
  const offsets = { stdout_start: fs.fstatSync(outFd).size, stderr_start: fs.fstatSync(errFd).size };
  fs.writeSync(errFd, `\n===== LAUNCH ${iso()} ${title} attempt=${attempt} kind=${kind} model=${model} agent=${agent || '-'} session=${sessionId || '-'} =====\n`);
  fs.writeSync(outFd, attemptMarkerLine(attempt, kind, sessionId) + '\n');   // health checks look only at events after this marker
  let command;
  try { command = buildInvocation({ row: { ...row, id, tool: backend, model, variant, agent, checkout, task_dir: taskDir, title, owns: row?.owns || [], role: row?.role || 'probe' }, cfg, session: sessionId, prompt, permission: process.env.OPENCODE_PERMISSION ? JSON.parse(process.env.OPENCODE_PERMISSION) : {} }); }
  catch (e) { fs.closeSync(outFd); fs.closeSync(errFd); finish(attempt, null, null, 'spawn-error', e.message, sessionId); return; }
  const a = command.args;
  log(`spawn attempt=${attempt} kind=${kind} model=${model} agent=${agent || '-'} cwd=${checkout} session=${sessionId || '-'} runtime=${backend} permission=${process.env.OPENCODE_PERMISSION ? 'set' : 'unset'}`);
  let child;
  try {
    child = spawn(command.binary, a, { cwd: checkout, detached: true, stdio: ['ignore', outFd, errFd], env: command.env });
  } catch (e) {
    fs.closeSync(outFd); fs.closeSync(errFd);
    finish(attempt, null, null, 'spawn-error', String(e.message || e), sessionId); return;
  }
  fs.closeSync(outFd); fs.closeSync(errFd);
  const t0 = Date.now();
  let killedByTimer = false, sessionId2 = sessionId, firstStep = 0;
  roster((t) => {
    t.pid = child.pid; t.supervisor_pid = process.pid; t.state = 'running'; t.attempts = attempt; t.pending_instruction = false; t.exited_at = null; t.exit_code = null;
    t.history = t.history || []; t.history.push({ n: attempt, kind, started_at: iso(), pid: child.pid, ended_at: null, exit_code: null, reason: null, ...offsets });
  });
  lockSet({ pid: child.pid, supervisor_pid: process.pid });
  // A launch without --session is a new session: it replaces the roster's session id (the old one is kept in
  // previous_sessions) so later follow-ups continue the session that actually did the work.
  if (!sessionId) roster((t) => { if (t.session_id) t.previous_sessions = [...new Set([...(t.previous_sessions || []), t.session_id])]; t.session_id = null; });
  const recordSession = (sid) => roster((t) => { if (sessionId) { t.session_id = t.session_id || sid; return; } if (t.session_id && t.session_id !== sid) { t.previous_sessions = [...(t.previous_sessions || []), t.session_id]; } t.session_id = sid; });
  const poll = setInterval(() => {
    const s = summarize(attemptDiagnostics(taskDir, offsets, 65536).events);
    if (s.firstStepAt && !firstStep) firstStep = s.firstStepAt;
    if (s.sessionID && !sessionId2) { sessionId2 = s.sessionID; recordSession(sessionId2); log(`session ${sessionId2}`); }
  }, 2000);
  let timer = null;
  if (maxMinutes > 0) {
    timer = setTimeout(() => { killedByTimer = true; log('max-minutes reached; SIGTERM'); killGroup(child.pid, 'SIGTERM'); setTimeout(() => killGroup(child.pid, 'SIGKILL'), 15000).unref(); }, maxMinutes * 60000);
  }
  child.on('error', (e) => { clearInterval(poll); if (timer) clearTimeout(timer); finish(attempt, null, null, 'spawn-error', String(e.message || e), sessionId2); });
  child.on('exit', (code, signal) => {
    clearInterval(poll); if (timer) clearTimeout(timer);
    const s = summarize(attemptDiagnostics(taskDir, offsets).events);
    const durMs = Date.now() - t0;
    const bannerOnly = code === 0 && !signal && !killedByTimer && !s.firstStepAt && !firstStep && s.count === 0 && durMs < bannerTimeoutMs;
    const reason = bannerOnly ? 'banner-only' : killedByTimer ? 'max-minutes' : signal ? `killed:${signal}` : 'exited';
    if (!sessionId2 && s.sessionID) { sessionId2 = s.sessionID; recordSession(sessionId2); }
    atomicWriteJson(path.join(taskDir, 'exit.json'), { attempt, kind, pid: child.pid, code, signal, ended_at: iso(), duration_ms: durMs, events: s.count, tool_calls: s.toolCalls, first_step_at: firstStep || s.firstStepAt || null, last_finish_reason: s.lastFinishReason, session_id: sessionId2, reason });
    log(`exit code=${code} signal=${signal} events=${s.count} reason=${reason}`);
    if (backend === 'opencode' && bannerOnly && attempt === 1 && !sessionId && kind === 'start') { log('banner-only exit; relaunching once'); launch(2, null); return; }
    finish(attempt, code, signal, reason, null, sessionId2);
  });
}

function finish(attempt, code, signal, reason, error, sessionId2) {
  const state = reason === 'banner-only' || reason === 'spawn-error' ? 'launch-failed' : 'exited';
  if (reason === 'spawn-error') atomicWriteJson(path.join(taskDir, 'exit.json'), { attempt, kind, pid: null, code: null, signal: null, ended_at: iso(), events: 0, reason, error });
  roster((t) => {
    t.pid = null; t.exit_code = code; t.exited_at = iso(); if (t.state !== 'stopped') t.state = state;
    if (sessionId2 && !t.session_id) t.session_id = sessionId2;
    const h = (t.history || []).slice(-1)[0]; if (h) { h.ended_at = iso(); h.exit_code = code; h.reason = reason; }
  });
  lockRelease();
  log(`done state=${state}`);
  process.exit(0);
}

process.on('SIGTERM', () => { log('supervisor got SIGTERM'); });
launch(Number(args.attempt || 1), session0);
