#!/usr/bin/env node
// Packaging and syntax checks only; never starts a provider or worker.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const self = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(self), '..');
const skillRoot = path.join(root, 'skills', 'agent-workpacks');
const errors = [];
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'runs', '.agent-workpacks'].includes(e.name) || e.name.endsWith('-pack-v1')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else files.push(p);
  }
}
walk(root);
for (const p of files) {
  const relative = path.relative(root, p);
  if (p.endsWith('.mjs')) {
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    if (r.status !== 0) errors.push(`${relative}: ${r.stderr}`);
  }
  if (!/\.(md|mjs|json|yaml|sh|tmpl)$/.test(p) || p === self) continue;
  const text = fs.readFileSync(p, 'utf8');
  if (/\/Users\/user\b|Documents\/Risevest|\bab-node\b|\bassetbase\b|\brisevest\b/i.test(text)) errors.push(`${relative}: private workspace reference`);
  if (p.endsWith('.md')) for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const target = match[1].replace(/#.*$/, '');
    if (!target || /^[a-z]+:/.test(target) || target.includes('<')) continue;
    if (!fs.existsSync(path.resolve(path.dirname(p), target))) errors.push(`${relative}: missing link ${target}`);
  }
}
const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
if (!/^---\nname: agent-workpacks\ndescription: .+\n/m.test(skill)) errors.push('SKILL.md: missing portable frontmatter');
for (const required of ['LICENSE', 'README.md']) {
  if (!fs.existsSync(path.join(root, required))) errors.push(`missing repository resource ${required}`);
}
for (const required of ['LICENSE', 'agents/openai.yaml', 'assets/pack-template/tasks/_templates/BRIEF.md']) {
  if (!fs.existsSync(path.join(skillRoot, required))) errors.push(`missing skill resource ${required}`);
}
if (fs.readFileSync(path.join(root, 'LICENSE'), 'utf8') !== fs.readFileSync(path.join(skillRoot, 'LICENSE'), 'utf8')) errors.push('distributed licence differs from repository licence');
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`PASS: ${files.length} repository files, ${files.filter((p) => p.startsWith(skillRoot + path.sep)).length} installable skill files; JavaScript syntax, local links, metadata, and portable references`);
