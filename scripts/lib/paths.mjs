// Shared path, IO and lock helpers for agent-workpacks scripts. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');
export const NODE_BIN = process.env.DP_NODE_BIN || process.execPath;
export function findBinary(name, override) {
  const selected = override || name;
  if (path.isAbsolute(selected) || selected.includes(path.sep)) return path.resolve(selected);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, selected);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return selected;
}
export const OC_BIN = findBinary('opencode', process.env.OC_BIN);
export const CODEX_BIN = findBinary('codex', process.env.CODEX_BIN);
export const CLAUDE_BIN = findBinary('claude', process.env.CLAUDE_BIN);
export const STABLE_NODE_BIN = NODE_BIN;
export const DEFAULT_ROOT = process.cwd();

export function packPaths(pack) {
  const root = path.resolve(pack);
  const control = path.join(root, 'control');
  return {
    root, control, name: path.basename(root),
    tasks: path.join(root, 'tasks'),
    locks: path.join(control, 'locks'),
    rosterLock: path.join(control, 'locks', 'roster.lock'),
    sweepLock: path.join(control, 'locks', 'sweep.lock'),
    watcherLock: path.join(control, 'locks', 'watcher.lock'),
    config: path.join(control, 'config.json'),
    roster: path.join(control, 'roster.json'),
    ids: path.join(control, 'ids.json'),
    blockers: path.join(control, 'blockers.json'),
    escalations: path.join(control, 'escalations.json'),
    escalationsMd: path.join(control, 'ESCALATIONS.md'),
    sweepMd: path.join(control, 'SWEEP.md'),
    current: path.join(control, 'CURRENT.md'),
    sweepLog: path.join(control, 'sweep-log.jsonl'),
    senior: path.join(control, 'senior.json'),
    probeDir: path.join(control, 'probe'),
    taskDir: (id) => path.join(root, 'tasks', id),
    probeJson: (modelSlug) => path.join(control, `probe-${modelSlug}.json`),
  };
}

export function isPack(pack) {
  const pp = packPaths(pack);
  return fs.existsSync(pp.config) && fs.existsSync(pp.roster);
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}
export function readText(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}
export function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

export function atomicWriteText(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
export function atomicWriteJson(file, obj) { atomicWriteText(file, JSON.stringify(obj, null, 2) + '\n'); }
export function appendLine(file, line) { ensureDir(path.dirname(file)); fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n'); }

export function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

// mkdir-based lock (macOS has no flock). Stale if the owner pid is dead.
export function withLock(dir, fn, { timeoutMs = 5000 } = {}) {
  const owner = path.join(dir, 'owner.json');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir, { recursive: false });
      fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') { ensureDir(path.dirname(dir)); continue; }
      const o = readJson(owner, {});
      if (o.pid && !pidAlive(o.pid)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} continue; }
      if (Date.now() > deadline) throw new Error(`lock busy: ${dir}`);
      sleepMs(50);
    }
  }
  try { return fn(); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

export async function withLockAsync(dir, fn, { timeoutMs = 5000 } = {}) {
  const owner = path.join(dir, 'owner.json');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir, { recursive: false });
      fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') { ensureDir(path.dirname(dir)); continue; }
      const o = readJson(owner, {});
      if (o.pid && !pidAlive(o.pid)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} continue; }
      if (Date.now() > deadline) throw new Error(`lock busy: ${dir}`);
      sleepMs(50);
    }
  }
  try { return await fn(); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export function sha256File(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

// --key value | --key=value | --flag ; repeated keys become arrays; positionals in `_`.
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { out._.push(a); continue; }
    let key = a.slice(2), val;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { val = argv[++i]; }
    else val = true;
    if (key in out && key !== '_') out[key] = [].concat(out[key], val);
    else out[key] = val;
  }
  return out;
}

export function clip(s, n = 400) {
  if (s == null) return '';
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function die(code, msg, json) {
  if (json) console.log(JSON.stringify({ ok: false, exit: code, error: msg }));
  else console.error(msg);
  process.exit(code);
}

export function homeDir() { return process.env.HOME || os.homedir(); }
export function modelSlug(model) { return String(model).replace(/[^a-z0-9.]+/gi, '-').toLowerCase(); }
