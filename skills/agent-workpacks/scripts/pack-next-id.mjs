#!/usr/bin/env node
// Central ID allocation: Q-/D-/E-/OA- counters, R- per task, task ids, reserved migration numbers.
import fs from 'node:fs';
import path from 'node:path';
import { packPaths, isPack, parseArgs, die, readJson, readText, atomicWriteJson, withLock } from './lib/paths.mjs';
import { loadConfig } from './lib/roster.mjs';

const args = parseArgs(process.argv.slice(2));
const json = !!args.json;
const pack = args.pack || args._[0];
const kind = args.kind;
if (!pack || !isPack(pack) || !kind) die(1, 'usage: pack-next-id.mjs <pack> --kind q|d|e|oa|r|task|migration [--task <ID>] [--id <ID>] [--hint <slug>] [--repo <r> --max-on-base 0053] [--json]', json);
const pp = packPaths(pack), cfg = loadConfig(pp);
const pad = (n) => String(n).padStart(3, '0');
const id = withLock(pp.rosterLock, () => {
  const ids = readJson(pp.ids, { version: 1, q: 0, d: 0, e: 0, oa: 0, r: {}, tasks: [], migrations: {} });
  let out;
  switch (kind) {
    case 'q': ids.q += 1; out = `Q-${cfg.pfx}-${pad(ids.q)}`; break;
    case 'd': ids.d += 1; out = `D-${cfg.pfx}-${pad(ids.d)}`; break;
    case 'e': ids.e += 1; out = `E-${cfg.pfx}-${pad(ids.e)}`; break;
    case 'oa': ids.oa += 1; out = `OA-${cfg.pfx}-${ids.oa}`; break;
    case 'r': { if (!args.task) die(1, 'r needs --task <ID>', json); ids.r[args.task] = (ids.r[args.task] || 0) + 1; out = `R-${args.task}-${pad(ids.r[args.task])}`; break; }
    case 'task': {
      let t = args.id ? String(args.id).toUpperCase() : null;
      if (!t && args.hint) { const letters = String(args.hint).split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 4); t = letters.length >= 2 ? letters : null; }
      if (!t) { let n = 1; while (ids.tasks.includes(`T${n}`)) n++; t = `T${n}`; }
      if (!/^[A-Z][A-Z0-9-]{0,9}$/.test(t)) die(1, `task id ${t} must match ^[A-Z][A-Z0-9-]{0,9}$`, json);
      if (ids.tasks.includes(t)) die(3, `task id ${t} already allocated`, json);
      ids.tasks.push(t); out = t;
      // create the task folder with a BRIEF to fill in (never overwrite an existing brief)
      const dir = pp.taskDir(t); fs.mkdirSync(dir, { recursive: true });
      const bp = path.join(dir, 'BRIEF.md');
      if (!fs.existsSync(bp)) { const tpl = readText(path.join(pp.tasks, '_templates', 'BRIEF.md'), ''); if (tpl) fs.writeFileSync(bp, tpl.replace(/<ID>/g, t).replace(/<PFX>/g, cfg.pfx).replace(/<pfx>/g, cfg.pfx.toLowerCase()).replace(/<id>/g, t.toLowerCase()).replace(/<target>/g, cfg.merge_target)); }
      break;
    }
    case 'migration': {
      if (!args.repo) die(1, 'migration needs --repo <r> (and --max-on-base NNNN the first time)', json);
      const m = ids.migrations[args.repo] || { max_on_base: null, reserved: {} };
      if (args['max-on-base']) m.max_on_base = String(args['max-on-base']);
      if (!m.max_on_base) die(1, `no max_on_base for ${args.repo}; pass --max-on-base NNNN (the highest migration number on the base branch)`, json);
      const used = [Number(m.max_on_base), ...Object.keys(m.reserved).map(Number)];
      const next = String(Math.max(...used) + 1).padStart(m.max_on_base.length, '0');
      m.reserved[next] = args.task || 'unassigned'; ids.migrations[args.repo] = m; out = next; break;
    }
    default: die(1, `unknown kind ${kind}`, json);
  }
  atomicWriteJson(pp.ids, ids);
  return out;
});
if (json) console.log(JSON.stringify({ ok: true, kind, id })); else console.log(id);
