#!/usr/bin/env node
// Scaffold <parent>/<slug>-pack-v1 from assets/pack-template. Refuses to overwrite.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, die, SKILL_DIR, DEFAULT_ROOT, NODE_BIN, atomicWriteJson, readText, ensureDir } from './lib/paths.mjs';
import { iso } from './lib/time.mjs';
import { DEFAULT_CONFIG } from './lib/roster.mjs';

const args = parseArgs(process.argv.slice(2));
const json = !!args.json;
const slug = args._[0] || args.slug;
if (!slug || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) die(1, 'usage: pack-init.mjs <slug> [--pfx ABC] [--root dir] [--parent dir] [--git-mode push-draft-pr|commit-only] [--merge-target branch] [--max-workers 10] [--date YYYY-MM-DD] [--json]\n  slug: lower-case letters, digits, hyphens', json);
const root = path.resolve(args.root || DEFAULT_ROOT);
const parent = path.resolve(args.parent || root);
const packName = slug.endsWith('-pack-v1') ? slug : `${slug}-pack-v1`;
const dest = path.join(parent, packName);
if (fs.existsSync(dest)) die(3, `refusing: ${dest} already exists`, json);
const tpl = path.join(SKILL_DIR, 'assets', 'pack-template');
if (!fs.existsSync(tpl)) die(2, `template missing: ${tpl}`, json);
let pfx = (args.pfx || slug.replace(/-pack-v1$/, '').split('-').map((w) => w[0]).join('').toUpperCase().slice(0, 4));
if (pfx.length < 2) pfx = slug.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase();
if (!/^[A-Z]{2,4}$/.test(pfx)) die(1, `--pfx must be 2–4 uppercase letters (got ${pfx})`, json);
const date = args.date || iso().slice(0, 10);
const gitMode = args['git-mode'] || DEFAULT_CONFIG.git_mode;
if (!['push-draft-pr', 'commit-only'].includes(gitMode)) die(1, '--git-mode must be push-draft-pr or commit-only', json);
const remoteHead = spawnSync('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' });
const mergeTarget = args['merge-target'] || remoteHead.stdout?.trim().replace(/^origin\//, '') || DEFAULT_CONFIG.merge_target;
const maxWorkers = Number(args['max-workers'] || DEFAULT_CONFIG.limits.max_workers);

const preamble = readText(path.join(SKILL_DIR, 'assets', 'preamble.md'));
const generic = preamble.replace(/\{\{(\w+)\}\}/g, (_, k) => ({ ID: 'ID', PFX: pfx, PACK: dest, BRIEF: 'tasks/ID/BRIEF.md', CHECKOUT: 'the worktree named in your brief', BRANCH: 'the branch named in your brief', OWNS: 'the Owns list in your brief', TASK_DIR: 'tasks/ID', ROOT: root, ROLE_RULES: 'Reliability: coders never run the identical command twice in a row and write within ten reads; researchers and docs workers record findings every 15 minutes and stop at the time box; verifiers run each named command on base and candidate exactly as written and never change code to make it pass. The launcher inserts the rule for your role.' })[k] ?? `{{${k}}}`);
const vars = { PACK: packName, SLUG: slug.replace(/-pack-v1$/, ''), PFX: pfx, PFX_LOWER: pfx.toLowerCase(), DATE: date, ROOT: root, GIT_MODE: gitMode, MERGE_TARGET: mergeTarget, SKILL_DIR, NODE: NODE_BIN, MAX_WORKERS: String(maxWorkers), PREAMBLE_GENERIC: generic.trimEnd() };
const sub = (s) => s.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

function copyDir(src, dst) {
  ensureDir(dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (/\.(md|json|txt)$/.test(e.name)) fs.writeFileSync(d, sub(fs.readFileSync(s, 'utf8')));
    else fs.copyFileSync(s, d);
  }
}
copyDir(tpl, dest);
for (const d of ['control/locks', 'tasks/_templates', 'evidence', 'review', 'control/probe']) ensureDir(path.join(dest, d));
const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
cfg.root = root; cfg.pack = dest; cfg.pfx = pfx; cfg.git_mode = gitMode; cfg.merge_target = mergeTarget; cfg.limits.max_workers = maxWorkers;
if (args['project-policy']) cfg.project_policy = { type: args['project-policy'] };
if (!cfg.protected_branches.includes(mergeTarget)) cfg.protected_branches.push(mergeTarget);
atomicWriteJson(path.join(dest, 'control', 'config.json'), cfg);
atomicWriteJson(path.join(dest, 'control', 'roster.json'), { version: 1, pack: dest, pfx, updated_at: iso(), tasks: [] });
atomicWriteJson(path.join(dest, 'control', 'ids.json'), { version: 1, q: 0, d: 0, e: 0, oa: 0, r: {}, tasks: [], migrations: {} });
atomicWriteJson(path.join(dest, 'control', 'blockers.json'), {});
atomicWriteJson(path.join(dest, 'control', 'escalations.json'), { version: 1, next: 1, items: [] });
fs.writeFileSync(path.join(dest, 'control', 'locks', '.keep'), '');
const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(path.relative(dest, p)); } })(dest);
const quote = (s) => "'" + String(s).replaceAll("'", "'\"'\"'") + "'";
const command = (name, rest) => `${quote(NODE_BIN)} ${quote(path.join(SKILL_DIR, 'scripts', name))} ${rest}`;
const next = [
  command('pack-next-id.mjs', `${quote(dest)} --kind task --id T1`),
  `cp ${quote(path.join(dest, 'tasks/_templates/BRIEF.md'))} ${quote(path.join(dest, 'tasks/T1/BRIEF.md'))}   # then fill it`,
  command('pack-lint.mjs', quote(dest)),
  command('pack-watch.mjs', `attach --pack ${quote(dest)} --host <lead-tool> --session <native-session-id>`),
  command('pack-worker.mjs', `start --pack ${quote(dest)} --task T1 --tool <worker-tool>`),
];
if (json) console.log(JSON.stringify({ ok: true, pack: dest, pfx, files, next }, null, 2));
else { console.log(`created ${dest} (prefix ${pfx}, git mode ${gitMode}, merge target ${mergeTarget})`); for (const f of files.sort()) console.log(`  ${f}`); console.log('\nnext:'); for (const n of next) console.log(`  ${n}`); }
