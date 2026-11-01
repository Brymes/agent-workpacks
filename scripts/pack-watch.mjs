#!/usr/bin/env node
// Bind one Codex senior thread to one pack and wake it only when the no-model sweep finds new work (attach/tick).
// `wait` is the Claude-senior equivalent: a blocking no-model waiter whose exit wakes the session that started it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  CODEX_BIN, NODE_BIN, SCRIPTS_DIR, appendLine, atomicWriteJson, clip, die, ensureDir,
  homeDir, isPack, packPaths, parseArgs, readJson, readText, sha1, sha256, sleepMs, withLock,
  STABLE_NODE_BIN,
} from './lib/paths.mjs';
import { iso } from './lib/time.mjs';

const argv = process.argv.slice(2);
const command = argv[0];
const args = parseArgs(argv.slice(1));
const json = !!args.json;
const pack = args.pack || args._[0];
const USAGE = `usage: pack-watch.mjs <attach|tick|status|disable|wait|run> --pack <dir> [options]
  attach  [--host codex|claude|opencode] [--session <id>] [--thread <id>] [--takeover] [--no-install]      bind one lead
  tick                                                     bind one lead (run by the LaunchAgent)
  status
  disable [--no-install]
  wait    [--interval-sec 180] [--timeout-min 60] [--also-watch <file> ...] [--notify]
          Claude/OpenCode lead: no model, no codex. Prints one JSON line and exits 10 (unacknowledged
          sweep items), 11 (an --also-watch file changed), 0 (heartbeat at the timeout) or 2 (error).

attach defaults to CODEX_THREAD_ID. Replacing an existing senior requires --takeover.`;

if (!command || args.help) { console.log(USAGE); process.exit(command ? 0 : 1); }
if (!pack || !isPack(pack)) {
  const message = `not a durable pack: ${pack || '(missing --pack)'}`;
  if (command === 'wait') { console.log(JSON.stringify({ event: 'error', error: message })); process.exit(2); }
  die(pack ? 2 : 1, message, json);
}
const pp = packPaths(pack);

const defaultState = () => ({
  version: 2,
  host: 'codex',
  session_id: null,
  waiter_pid: null,
  runner_pid: null,
  thread_id: null,
  attached_at: null,
  previous_threads: [],
  event_queue_enabled: true,
  last_queued_fingerprint: null,
  last_queued_at: null,
  last_queue_result: null,
  heartbeat_minutes: 30,
  heartbeat_automation_id: null,
  disabled_at: null,
});
const state = () => { const saved = readJson(pp.senior, {}); return { ...defaultState(), ...saved, session_id: saved.session_id || saved.thread_id || null }; };
const save = (value) => atomicWriteJson(pp.senior, value);
const print = (value, human) => json ? console.log(JSON.stringify(value, null, 2)) : console.log(human);

function labelForPack() {
  const slug = pp.name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 45) || 'pack';
  return `dev.brymes.agent-workpacks.${slug}.${sha1(pp.root).slice(0, 8)}`;
}
function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function launchAgentPath() { return path.join(homeDir(), 'Library', 'LaunchAgents', `${labelForPack()}.plist`); }
function logPath(suffix) { return path.join(homeDir(), 'Library', 'Logs', `${labelForPack()}.${suffix}.log`); }

function installLaunchAgent() {
  if (args['no-install'] || process.env.DP_WATCH_NO_INSTALL === '1') return { installed: false, skipped: true };
  if (process.platform !== 'darwin') {
    const existing = state();
    if (existing.runner_pid) { try { process.kill(existing.runner_pid, 0); return { installed: true, label: 'portable watcher', pid: existing.runner_pid }; } catch {} }
    const log = fs.openSync(path.join(pp.control, 'watcher.log'), 'a');
    const child = spawn(NODE_BIN, [path.join(SCRIPTS_DIR, 'pack-watch.mjs'), 'run', '--pack', pp.root], { detached: true, stdio: ['ignore', log, log], env: process.env });
    child.unref(); fs.closeSync(log); save({ ...state(), runner_pid: child.pid });
    return { installed: true, label: 'portable watcher', pid: child.pid };
  }
  const plist = launchAgentPath();
  ensureDir(path.dirname(plist));
  ensureDir(path.dirname(logPath('out')));
  const watcher = path.join(SCRIPTS_DIR, 'pack-watch.mjs');
  const home = homeDir();
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(labelForPack())}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(fs.existsSync(STABLE_NODE_BIN) ? STABLE_NODE_BIN : NODE_BIN)}</string><string>${xml(watcher)}</string><string>tick</string><string>--pack</string><string>${xml(pp.root)}</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${xml(logPath('out'))}</string>
  <key>StandardErrorPath</key><string>${xml(logPath('err'))}</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${xml(home)}</string>
    <key>PATH</key><string>${xml(process.env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')}</string>
  </dict>
</dict></plist>
`;
  fs.writeFileSync(plist, body, { mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  spawnSync('/bin/launchctl', ['bootout', domain, plist], { encoding: 'utf8' });
  const result = spawnSync('/bin/launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`launchctl bootstrap failed: ${clip(result.stderr || result.stdout, 500)}`);
  return { installed: true, label: labelForPack(), plist };
}

function removeLaunchAgent() {
  if (args['no-install'] || process.env.DP_WATCH_NO_INSTALL === '1') return { removed: false, skipped: true };
  if (process.platform !== 'darwin') { const current = state(); if (current.runner_pid) { try { process.kill(current.runner_pid, 'SIGTERM'); } catch {} } save({ ...current, runner_pid: null }); return { removed: true }; }
  const plist = launchAgentPath();
  const domain = `gui/${process.getuid()}`;
  const result = spawnSync('/bin/launchctl', ['bootout', domain, plist], { encoding: 'utf8' });
  try { fs.unlinkSync(plist); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { removed: result.status === 0 || result.status === 3, label: labelForPack(), plist };
}

function notify(body, title = 'agent-workpacks') {
  if (process.env.DP_NO_NOTIFY === '1' || process.platform !== 'darwin') return;
  const clean = (value) => String(value).replace(/[\\"]/g, '').replace(/[\r\n]+/g, ' ').slice(0, 220);
  spawnSync(process.env.DP_OSASCRIPT_BIN || '/usr/bin/osascript', ['-e', `display notification "${clean(body)}" with title "${clean(title)}"`], { encoding: 'utf8', timeout: 5000 });
}

function lastSweep() {
  const lines = readText(pp.sweepLog, '').trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  try { return JSON.parse(lines.at(-1)); } catch { return null; }
}

function queuePrompt() {
  return `A agent-workpacks watcher found unacknowledged work in ${pp.root}. This thread is the pack's only senior controller. Read control/CURRENT.md and control/ESCALATIONS.md, then only the affected task BRIEF.md, STATUS.md, REPORT.md, QUESTIONS.md and bounded source diffs. You may review completed work, answer questions, send corrections with pack-worker instruct to the saved worker session, start dependency-ready tasks when capacity and memory permit, acknowledge handled sweep items, and update CURRENT.md. Do not edit product code, change scope or ownership, merge, deploy, make owner-level business decisions, or launch another senior controller. Pack files are authoritative; run the changed-only sweep before acting.`;
}

function parseSweep(result) {
  const text = String(result.stdout || '').trim();
  try { return JSON.parse(text); }
  catch { throw new Error(`sweep returned invalid JSON (exit ${result.status}): ${clip(text || result.stderr, 500)}`); }
}

function actionFingerprint(payload) {
  const items = (payload.escalations || [])
    .filter((item) => !item.acked)
    .map((item) => [item.id, item.task, item.class, item.to, item.kind])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return items.length ? sha256(JSON.stringify(items)) : null;
}

function cmdAttach() {
  const host = args.host || 'codex';
  if (!['codex', 'claude', 'opencode'].includes(host)) die(3, 'host must be codex, claude or opencode', json);
  const threadId = String(args.session || args.thread || (host === 'codex' ? process.env.CODEX_THREAD_ID : host === 'claude' ? process.env.CLAUDE_SESSION_ID : process.env.OPENCODE_SESSION_ID) || '').trim();
  if (!threadId) die(3, 'attach needs --session <native-session-id> (Codex also accepts --thread or CODEX_THREAD_ID)', json);
  const result = withLock(pp.watcherLock, () => {
    const current = state();
    const replacing = current.session_id && (current.session_id !== threadId || current.host !== host);
    if (replacing && !args.takeover) throw new Error(`pack is already bound to ${current.thread_id}; pass --takeover to replace it`);
    if (replacing) current.previous_threads.push({ host: current.host, session_id: current.session_id, thread_id: current.thread_id, attached_at: current.attached_at, replaced_at: iso(), heartbeat_automation_id: current.heartbeat_automation_id || null });
    if (replacing) for (const pid of [current.waiter_pid, current.runner_pid]) if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    current.host = host; current.session_id = threadId;
    if (replacing) { current.waiter_pid = null; current.runner_pid = null; }
    current.thread_id = host === 'codex' ? threadId : null;
    current.attached_at = iso();
    current.event_queue_enabled = true;
    current.disabled_at = null;
    if (replacing) {
      current.last_queued_fingerprint = null;
      current.last_queued_at = null;
      current.last_queue_result = null;
      current.heartbeat_automation_id = null;
    }
    save(current);
    const launchAgent = host === 'codex' ? installLaunchAgent() : { installed: false, native_background: true };
    appendLine(path.join(pp.root, 'LEDGER.md'), `- ${iso()} — pack-watch — ${replacing ? 'senior takeover' : 'senior attached'} ${threadId}; watcher ${launchAgent.installed ? 'enabled' : 'not installed'}`);
    return { current, replacing, launchAgent };
  });
  print({ ok: true, pack: pp.root, ...result }, `attached senior ${threadId}${result.replacing ? ' (takeover)' : ''}; ${result.launchAgent.installed ? `watcher ${result.launchAgent.label} runs every 15 minutes` : 'LaunchAgent installation skipped'}`);
}

function cmdTick({ exit = true } = {}) {
  const result = withLock(pp.watcherLock, () => {
    const current = state();
    if (current.host !== 'codex') return { ok: true, action: 'native-background', state: current };
    if (current.disabled_at || !current.event_queue_enabled) return { ok: true, action: 'disabled', state: current };
    const sweep = spawnSync(NODE_BIN, [path.join(SCRIPTS_DIR, 'pack-sweep.mjs'), '--pack', pp.root, '--changed-only', '--json'], { encoding: 'utf8', timeout: 120000 });
    if (![0, 10].includes(sweep.status)) {
      current.last_queue_result = { at: iso(), ok: false, stage: 'sweep', exit: sweep.status, error: clip(sweep.stderr || sweep.stdout, 800) };
      save(current);
      notify(`${pp.name}: local sweep failed; see ${pp.sweepLog}`);
      return { ok: false, action: 'sweep-failed', state: current };
    }
    const payload = parseSweep(sweep);
    const fingerprint = actionFingerprint(payload);
    if (!fingerprint) return { ok: true, action: 'quiet', sweep: payload, state: current };
    if (fingerprint === current.last_queued_fingerprint) return { ok: true, action: 'already-queued', fingerprint, sweep: payload, state: current };
    if (!current.thread_id) {
      current.last_queue_result = { at: iso(), ok: false, stage: 'queue', error: 'no senior thread attached' };
      save(current);
      notify(`${pp.name}: action found but no Codex senior is attached`);
      return { ok: false, action: 'unattached', fingerprint, sweep: payload, state: current };
    }
    const queued = spawnSync(CODEX_BIN, ['queue', '--thread', current.thread_id, '--message', queuePrompt()], { encoding: 'utf8', timeout: 30000 });
    const queueResult = { at: iso(), ok: queued.status === 0, stage: 'queue', exit: queued.status, output: clip(queued.stdout || queued.stderr, 800) };
    current.last_queue_result = queueResult;
    if (queueResult.ok) {
      current.last_queued_fingerprint = fingerprint;
      current.last_queued_at = queueResult.at;
    }
    save(current);
    notify(`${pp.name}: senior wakeup ${queueResult.ok ? 'queued' : 'failed and will retry'}`);
    appendLine(path.join(pp.root, 'LEDGER.md'), `- ${iso()} — pack-watch — event ${fingerprint.slice(0, 12)} ${queueResult.ok ? `queued to ${current.thread_id}` : 'delivery failed; retry eligible'}`);
    return { ok: queueResult.ok, action: queueResult.ok ? 'queued' : 'queue-failed', fingerprint, sweep: payload, state: current };
  });
  print(result, `${result.action}${result.fingerprint ? ` ${result.fingerprint.slice(0, 12)}` : ''}${result.state?.last_queue_result?.error ? `: ${result.state.last_queue_result.error}` : ''}`);
  if (exit) process.exit(result.ok ? 0 : 2);
  return result;
}

function cmdStatus() {
  const current = state();
  const sweep = lastSweep();
  const launchAgent = launchAgentPath();
  const payload = { ok: true, pack: pp.root, host: current.host, session_id: current.session_id, waiter_pid: current.waiter_pid, runner_pid: current.runner_pid, thread_id: current.thread_id, attached_at: current.attached_at, previous_threads: current.previous_threads, last_local_sweep: sweep?.ts || null, last_queued_at: current.last_queued_at, last_queued_fingerprint: current.last_queued_fingerprint, last_queue_result: current.last_queue_result, event_queue_enabled: current.event_queue_enabled, heartbeat_minutes: current.heartbeat_minutes, heartbeat_automation_id: current.heartbeat_automation_id, disabled_at: current.disabled_at, launch_agent: { label: labelForPack(), plist: launchAgent, installed: fs.existsSync(launchAgent) } };
  print(payload, [`pack: ${pp.root}`, `senior: ${current.thread_id || '(none)'}`, `last local sweep: ${sweep?.ts || 'never'}`, `last queued event: ${current.last_queued_at || 'never'}`, `queue result: ${current.last_queue_result ? (current.last_queue_result.ok ? 'ok' : `failed (${current.last_queue_result.error || current.last_queue_result.output || 'unknown'})`) : 'none'}`, `watcher: ${current.disabled_at ? `disabled ${current.disabled_at}` : fs.existsSync(launchAgent) ? 'active' : 'not installed'}`, `heartbeat: ${current.heartbeat_automation_id || `not recorded (${current.heartbeat_minutes} minute fallback)`}`].join('\n'));
}

function cmdDisable() {
  const result = withLock(pp.watcherLock, () => {
    const current = state();
    if (current.waiter_pid) { try { process.kill(current.waiter_pid, 'SIGTERM'); } catch {} current.waiter_pid = null; }
    current.event_queue_enabled = false;
    current.disabled_at = iso();
    save(current);
    const launchAgent = removeLaunchAgent();
    appendLine(path.join(pp.root, 'LEDGER.md'), `- ${iso()} — pack-watch — monitoring disabled${current.heartbeat_automation_id ? `; heartbeat ${current.heartbeat_automation_id} must be paused in Codex` : ''}`);
    return { ok: true, state: current, launchAgent };
  });
  print(result, `monitoring disabled${result.state.heartbeat_automation_id ? `; pause heartbeat automation ${result.state.heartbeat_automation_id}` : ''}`);
}

// ---- Claude senior waiter. Level-triggered: any open, unacknowledged sweep item ends the wait, so the senior acks
// what it handles before re-arming. It calls no model and no codex, holds no lock between sweeps and writes nothing
// itself (the sweep it spawns updates the pack's machine state as usual).
function positiveNumber(name, fallback) {
  const raw = args[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (Array.isArray(raw) || raw === true || !Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be one positive number`);
  return value;
}

function fileStamp(file) {
  try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 'missing'; throw e; }
}

function unackedSweepItems() {
  const sweep = spawnSync(NODE_BIN, [path.join(SCRIPTS_DIR, 'pack-sweep.mjs'), '--pack', pp.root, '--changed-only', '--json'], { encoding: 'utf8', timeout: 120000 });
  if (sweep.error) throw new Error(`sweep did not run: ${sweep.error.message}`);
  // Exit 0 is quiet; it is also what a sweep prints when another sweep holds the lock, and open items persist.
  if (sweep.status === 0) return [];
  if (sweep.status !== 10) throw new Error(`sweep failed (exit ${sweep.status ?? sweep.signal}): ${clip(sweep.stderr || sweep.stdout, 500)}`);
  return (parseSweep(sweep).escalations || []).filter((item) => !item.acked)
    .map((item) => ({ id: item.id, task: item.task, class: item.class, kind: item.kind, to: item.to }));
}

async function cmdWait() {
  let claimed = false;
  const release = () => { if (!claimed) return; withLock(pp.watcherLock, () => { const current = state(); if (current.waiter_pid === process.pid) save({ ...current, waiter_pid: null }); }); claimed = false; };
  process.on('SIGTERM', () => { release(); process.exit(143); });
  const finish = (event, code) => {
    release();
    if (args.notify && event.event !== 'heartbeat') notify(`${pp.name}: ${event.event === 'action' ? `${event.items.length} item(s) for the senior` : event.event === 'file' ? `${path.basename(event.path)} changed` : 'waiter error'}`);
    console.log(JSON.stringify(event));
    process.exit(code);
  };
  try {
    const intervalMs = positiveNumber('interval-sec', 180) * 1000;
    const timeoutMs = positiveNumber('timeout-min', 60) * 60000;
    const watched = [].concat(args['also-watch'] ?? []).map((f) => {
      if (typeof f !== 'string' || !f) throw new Error('--also-watch needs a file path');
      return path.resolve(f);
    });
    const sweepWritten = new Set([pp.sweepLog, pp.current, pp.sweepMd, pp.escalationsMd, pp.escalations, pp.roster]);
    const selfTrigger = watched.find((f) => sweepWritten.has(f));
    if (selfTrigger) throw new Error(`--also-watch ${selfTrigger} is rewritten by every sweep; watch a file that workers or a lane runner write`);
    withLock(pp.watcherLock, () => {
      const current = state();
      if (current.session_id && current.host === 'codex' && !current.disabled_at) throw new Error('Codex lead owns this pack; use explicit takeover before arming a native waiter');
      if (args.host && current.session_id && current.host !== args.host) throw new Error('waiter host differs from the recorded lead');
      if (current.waiter_pid) { try { process.kill(current.waiter_pid, 0); throw new Error('a waiter is already active for this pack'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      save({ ...current, waiter_pid: process.pid }); claimed = true;
    });
    const baseline = new Map(watched.map((f) => [f, fileStamp(f)]));
    const deadline = Date.now() + timeoutMs;
    let nextSweep = Date.now();
    for (;;) {
      if (Date.now() >= nextSweep) {
        const items = unackedSweepItems();
        if (items.length) finish({ event: 'action', items }, 10);
        nextSweep = Date.now() + intervalMs;
      }
      for (const f of watched) if (fileStamp(f) !== baseline.get(f)) finish({ event: 'file', path: f }, 11);
      const now = Date.now();
      if (now >= deadline) finish({ event: 'heartbeat' }, 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(1000, nextSweep - now, deadline - now))));
    }
  } catch (error) {
    finish({ event: 'error', error: clip(error.message, 800) }, 2);
  }
}

async function cmdRun() {
  const interval = positiveNumber('interval-sec', 900) * 1000;
  withLock(pp.watcherLock, () => {
    const current = state();
    if (current.runner_pid && current.runner_pid !== process.pid) {
      try { process.kill(current.runner_pid, 0); throw new Error('a portable watcher is already active'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    save({ ...current, runner_pid: process.pid });
  });
  const release = () => withLock(pp.watcherLock, () => { const current = state(); if (current.runner_pid === process.pid) save({ ...current, runner_pid: null }); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
  for (;;) {
    const current = state();
    if (current.disabled_at || current.host !== 'codex' || (current.runner_pid && current.runner_pid !== process.pid)) { release(); return; }
    cmdTick({ exit: false });
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

const commands = { run: cmdRun, attach: cmdAttach, tick: cmdTick, status: cmdStatus, disable: cmdDisable, wait: cmdWait };
if (!commands[command]) { console.error(`unknown command ${command}\n${USAGE}`); process.exit(1); }
try { await commands[command](); } catch (error) { die(2, error.stack || error.message, json); }
