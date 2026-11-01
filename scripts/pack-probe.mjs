#!/usr/bin/env node
// Live probe per model through the real launcher path (pack-supervise + detached opencode): proves launch, JSON
// stream, session capture and exit handling, and classifies provider failures. Costs a few tokens.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { packPaths, isPack, readJson, atomicWriteText, atomicWriteJson, ensureDir, parseArgs, die, modelSlug, clip, NODE_BIN, SCRIPTS_DIR, OC_BIN, pidAlive } from './lib/paths.mjs';
import { iso, now, isDeepseekPeak } from './lib/time.mjs';
import { readEvents, summarize, rawLines, classifyProviderError, redact } from './lib/events.mjs';
import { loadConfig } from './lib/roster.mjs';

const args = parseArgs(process.argv.slice(2));
const json = !!args.json;
const pack = args.pack || args._[0];
if (!pack || !isPack(pack)) die(2, 'usage: pack-probe.mjs --pack <dir> (--model <provider/model> | --all) [--timeout 180] [--variant high] [--stats] [--json]', json);
const pp = packPaths(pack);
const cfg = loadConfig(pp);
const timeoutS = Number(args.timeout || 180);
const variant = args.variant || cfg.default_variant;
const models = args.all ? Array.from(new Set(Object.values(cfg.models))) : [].concat(args.model || []);
if (!models.length) die(2, 'give --model <id> or --all', json);
let probeSeq = 0;
const EXIT = { ok: 0, auth: 20, credits: 21, 'bad-model': 22, connect: 23, timeout: 24, unknown: 25 };

function probeOne(model) {
  return new Promise((resolve) => {
    const slug = modelSlug(model);
    const dir = path.join(pp.probeDir, slug, `${iso().replace(/[:]/g, '')}-${process.pid}-${++probeSeq}`);
    ensureDir(dir);
    atomicWriteText(path.join(dir, 'PROMPT.txt'), 'Reply with OK and no more.\n');
    const t0 = Date.now();
    const supLog = fs.openSync(path.join(dir, 'supervisor.log'), 'a');
    const sup = spawn(NODE_BIN, [path.join(SCRIPTS_DIR, 'pack-supervise.mjs'), '--pack', pp.root, '--task', `PROBE-${slug}`, '--no-roster', '--kind', 'probe', '--model', model, '--variant', variant, '--agent', 'none', '--cwd', cfg.root, '--task-dir', dir, '--title', `probe ${slug}`, '--prompt-file', path.join(dir, 'PROMPT.txt'), '--max-minutes', String(timeoutS / 60)], { cwd: cfg.root, stdio: ['ignore', supLog, supLog], env: { ...process.env, OPENCODE_PERMISSION: JSON.stringify({ edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' }) } });
    fs.closeSync(supLog);
    let timedOut = false;
    const backstop = setTimeout(() => { timedOut = true; try { process.kill(sup.pid, 'SIGTERM'); } catch {} }, (timeoutS + 25) * 1000);
    sup.on('exit', () => {
      clearTimeout(backstop);
      const exitInfo = readJson(path.join(dir, 'exit.json'), null);
      const events = readEvents(path.join(dir, 'run.jsonl'), 262144);
      const s = summarize(events);
      const tail = rawLines(path.join(dir, 'run.jsonl'), 32768).concat(rawLines(path.join(dir, 'launch.log'), 32768)).join('\n');
      const firstText = events.find((e) => e.kind === 'text' && e.text)?.text || '';
      let result;
      if (/^\W*OK\b/i.test(firstText.trim()) || /\bOK\b/.test(firstText.slice(0, 20))) result = 'ok';
      else result = classifyProviderError(s.errors.join('\n')) || classifyProviderError(tail) || ((timedOut || /^(max-minutes|killed)/.test(exitInfo?.reason || '')) ? 'timeout' : 'unknown');
      if (result === 'context-overflow') result = 'unknown';
      const rec = { model, checked_at: iso(), result, exit_code: EXIT[result] ?? 25, latency_ms: Date.now() - t0, utc_hour: now().getUTCHours(), deepseek_peak: isDeepseekPeak(), session_id: s.sessionID || exitInfo?.session_id || null, events: s.count, process_exit: exitInfo ? { code: exitInfo.code, signal: exitInfo.signal, reason: exitInfo.reason } : null, excerpt: redact(clip(result === 'ok' ? firstText : (s.errors.slice(-1)[0] || tail.split('\n').filter((l) => /error|Error|denied|request/i.test(l)).slice(-3).join('\n') || tail.slice(-300)), 300)), dir };
      atomicWriteJson(pp.probeJson(slug), rec);
      resolve(rec);
    });
  });
}

const results = [];
for (const m of models) results.push(await probeOne(m));
let stats = null;
if (args.stats) { const r = spawnSync(OC_BIN, ['stats', '--models', '--days', '1'], { encoding: 'utf8', timeout: 20000 }); stats = (r.stdout || r.stderr || '').trim(); }
const worst = Math.max(...results.map((r) => r.exit_code));
if (json) console.log(JSON.stringify({ ok: worst === 0, utc_hour: now().getUTCHours(), deepseek_peak: isDeepseekPeak(), results, stats }, null, 2));
else {
  for (const r of results) console.log(`${r.result.padEnd(9)} ${r.model}  ${r.latency_ms} ms  events=${r.events}  session=${r.session_id || '-'}  → ${path.relative(pp.root, pp.probeJson(modelSlug(r.model)))}${r.result !== 'ok' ? `\n          ${r.excerpt.split('\n').join('\n          ')}` : ''}`);
  console.log(`utc_hour=${now().getUTCHours()} deepseek_peak=${isDeepseekPeak()} (2x cost Mon–Fri 01–04 and 06–10 UTC)`);
  if (stats) console.log(stats);
}
process.exit(worst);
