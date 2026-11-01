#!/usr/bin/env node
// Brief and pack lint. Exit 0 pass · 3 warnings only · 4 failures · 2 usage/io.
import fs from 'node:fs';
import path from 'node:path';
import { packPaths, isPack, parseArgs, die, readText } from './lib/paths.mjs';
import { loadConfig } from './lib/roster.mjs';
import { lintBrief, lintPack, planIdsFrom } from './lib/lint.mjs';

const args = parseArgs(process.argv.slice(2));
const json = !!args.json;
const target = args.pack || args._[0];
if (!target && !args.brief) die(2, 'usage: pack-lint.mjs <pack> [--task <ID>] [--json]   |   pack-lint.mjs --brief <file> [--root <dir>] [--checkout <dir>]', json);

function report(name, r) {
  const level = r.failures.length ? 'FAIL' : r.warnings.length ? 'WARN' : 'PASS';
  if (!json) { console.log(`${level} ${name}`); for (const f of r.failures) console.log(`  ✗ ${f}`); for (const w of r.warnings) console.log(`  ! ${w}`); }
  return level;
}
let worst = 0;
if (args.brief) {
  const md = fs.readFileSync(args.brief, 'utf8');
  const r = lintBrief(md, { root: args.root, checkout: args.checkout, taskId: args.task });
  const level = report(args.brief, r);
  if (json) console.log(JSON.stringify({ ok: r.pass, level, ...r, brief: undefined }, null, 2));
  process.exit(r.failures.length ? 4 : r.warnings.length ? 3 : 0);
}
if (!isPack(target)) die(2, `not a pack: ${target}`, json);
const pp = packPaths(target), cfg = loadConfig(pp);
if (args.task) {
  const bp = path.join(pp.taskDir(args.task), 'BRIEF.md');
  if (!fs.existsSync(bp)) die(2, `no brief at ${bp}`, json);
  const r = lintBrief(fs.readFileSync(bp, 'utf8'), { root: cfg.root, planIds: planIdsFrom(readText(path.join(pp.root, 'PLAN.md'), '')), taskId: args.task });
  const level = report(`${args.task}/BRIEF.md`, r);
  if (json) console.log(JSON.stringify({ ok: r.pass, level, failures: r.failures, warnings: r.warnings }, null, 2));
  process.exit(r.failures.length ? 4 : r.warnings.length ? 3 : 0);
}
const res = lintPack(pp, cfg);
const out = { ok: true, briefs: {}, pack: { failures: res.failures, warnings: res.warnings } };
for (const [id, r] of Object.entries(res.briefs)) { const level = report(`tasks/${id}/BRIEF.md`, r); out.briefs[id] = { level, failures: r.failures, warnings: r.warnings }; worst = Math.max(worst, r.failures.length ? 4 : r.warnings.length ? 3 : 0); }
const level = report(`pack ${pp.name}`, res);
worst = Math.max(worst, res.failures.length ? 4 : res.warnings.length ? 3 : 0);
out.ok = worst < 4; out.exit = worst;
if (json) console.log(JSON.stringify(out, null, 2));
else console.log(worst === 0 ? 'PASS' : worst === 3 ? 'PASS with warnings' : 'FAIL');
process.exit(worst);
