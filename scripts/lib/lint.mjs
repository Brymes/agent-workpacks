// Brief and pack lint. Returns findings; the CLI maps them to exit codes (0 pass, 3 warnings, 4 failures).
import fs from 'node:fs';
import path from 'node:path';
import { parseBrief, findPlaceholders } from './status.mjs';
import { normalizeOwn, isNewMarked, RESERVED_DIRS, ownsOverlap } from './permission.mjs';
import { readText } from './paths.mjs';

const SECRET_PATTERNS = [
  /\b(sk|pk|ghp|gho|xox[abp]|AKIA)[-_][A-Za-z0-9_-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /\b(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)\s*[=:]\s*['"]?[A-Za-z0-9+\/=_-]{12,}/i,
  /https?:\/\/[^\/\s:@]+:[^@\s]+@/,
  /\b[1-9A-HJ-NP-Za-km-z]{64,88}\b/,
];
const KNOWN_TOP = new Set(['START-HERE.md', 'GOAL.md', 'RULES.md', 'PLAN.md', 'CONTEXT.md', 'DECISIONS.md', 'ACCEPTANCE.md', 'REVIEW-CHECKLIST.md', 'QUESTIONS.md', 'LEDGER.md', 'tasks', 'control', 'evidence', 'review', '.DS_Store']);
const COMMAND_RE = /`[^`]*\b(npx|npm|pnpm|yarn|node|jest|tsc|vitest|pytest|go test|make|cargo|docker|bash|sh|git)\b[^`]*`|\b(npx|npm|pnpm|yarn|jest|tsc|pytest|make)\s/;

export function lintBrief(md, { root, checkout, planIds, taskId } = {}) {
  const failures = [], warnings = [];
  const b = parseBrief(md);
  if (!b.id) failures.push('line 1 must be "# <ID> — <title>"');
  else if (taskId && b.id !== taskId) failures.push(`brief id ${b.id} does not match task folder ${taskId}`);
  if (b.lineCount > 120) failures.push(`${b.lineCount} lines (limit 120; aim for 80)`);
  else if (b.lineCount > 80) warnings.push(`${b.lineCount} lines (aim for 80)`);
  if (!b.header.binding) failures.push('missing BINDING line (line 2)');
  for (const [k, label] of [['outOfScope', 'OUT OF SCOPE'], ['stop', 'STOP CONDITION'], ['lock', 'Lock']]) if (!b.header[k]) failures.push(`missing header field ${label}`);
  if (!b.header.size) failures.push('missing Size: S|M'); else if (!['S', 'M'].includes(b.header.size)) failures.push(`Size ${b.header.size}: split the task (S or M only)`);
  if (!b.header.role) failures.push('missing Role: coder|researcher|verifier|docs');
  else if (!['coder', 'researcher', 'verifier', 'docs'].includes(b.header.role)) failures.push(`unknown Role ${b.header.role}`);
  for (const [k, label] of [['owns', 'Owns'], ['tasks', 'Tasks'], ['tests', 'Tests'], ['handBack', 'Hand back'], ['askFirst', 'Ask first if']]) if (!b.sections[k]) failures.push(`missing section ## ${label}`);
  if (b.owns.rows.length === 0) failures.push('Owns table has no row (repo | worktree | branch (base) | files)');
  if (b.owns.rows.length > 1) failures.push(`Owns table has ${b.owns.rows.length} rows: one task = one checkout; split by repo`);
  if (b.owns.rows.length === 1 && !b.owns.branch) failures.push('Owns table names no branch');
  if (b.owns.rows.length >= 1 && b.owns.files.length === 0) failures.push('Owns lists no files');
  const tasksText = (b.sections.tasks || []).join('\n');
  if (b.sections.tasks && !/^\s*\d+\./m.test(tasksText)) failures.push('Tasks has no numbered item');
  const n = (tasksText.match(/^\s*\d+\./gm) || []).length; if (n > 7) warnings.push(`${n} tasks (aim for ≤7)`);
  const testsText = (b.sections.tests || []).join('\n');
  if (b.sections.tests && !COMMAND_RE.test(testsText) && !/\bnone\b/i.test(testsText)) failures.push('Tests names no command (or say "none to run" for research)');
  if (b.hasToolCommand) failures.push('tool-specific command line (claude/codex/opencode); briefs are tool-neutral, launch lines live in START-HERE');
  const ph = findPlaceholders(md); if (ph.length) failures.push(`placeholders left: ${ph.slice(0, 4).map((p) => `${p.text} (line ${p.line})`).join(', ')}${ph.length > 4 ? ` +${ph.length - 4}` : ''}`);
  md.split('\n').forEach((l, i) => { for (const re of SECRET_PATTERNS) if (re.test(l)) { failures.push(`secret-looking string on line ${i + 1}`); break; } });
  if (/\b(TODO|TBD|\?\?\?)\b/.test(md)) warnings.push('contains TODO/TBD/???');
  if (planIds && planIds.size && b.header.needsFirst.length) for (const d of b.header.needsFirst) if (!planIds.has(d)) failures.push(`Needs first ${d} is not in PLAN`);
  // Owns path checks
  const co = checkout || (root && b.owns.worktree && !/^\(/.test(b.owns.repo || '') ? path.resolve(root, b.owns.worktree) : null);
  const repoDir = root && b.owns.repo && !/^\(/.test(b.owns.repo) ? path.resolve(root, b.owns.repo) : null;
  const base = co && fs.existsSync(co) ? co : (repoDir && fs.existsSync(repoDir) ? repoDir : null);
  if (co && !fs.existsSync(co)) warnings.push(`worktree ${b.owns.worktree} does not exist yet (pack-worker start creates it)`);
  for (const raw of b.owns.files) {
    const o = normalizeOwn(raw);
    if (!o) continue;
    const norm = path.normalize(o);
    if (norm.startsWith('..') || path.isAbsolute(norm)) { failures.push(`Owns entry escapes the checkout: ${raw}`); continue; }
    if (norm.split('/').some((s) => RESERVED_DIRS.includes(s))) { failures.push(`Owns entry in a reserved dir: ${raw}`); continue; }
    const packTask = /^\(/.test(b.owns.repo || '');
    const ownFolder = taskId ? `tasks/${taskId}` : null;
    if (/^control(\/|$)/.test(norm) || (packTask && !(ownFolder ? norm === ownFolder || norm.startsWith(ownFolder + '/') : /^tasks\/[^/]+\//.test(norm)))) { failures.push(`a research/docs task may write only inside tasks/${taskId || '<ID>'}/: ${raw}`); continue; }
    if (base) {
      const hasGlob = /[*?]/.test(norm);
      const target = path.resolve(base, hasGlob ? norm.split(/[*?]/)[0].replace(/\/[^/]*$/, '') || '.' : norm);
      if (hasGlob || isNewMarked(raw)) { if (!fs.existsSync(path.dirname(target)) && !fs.existsSync(target)) warnings.push(`parent of ${raw} does not exist in ${path.basename(base)}`); }
      else if (!fs.existsSync(target)) failures.push(`Owns file not found in ${path.basename(base)}: ${raw} (mark new files with "(new)")`);
    }
  }
  return { pass: failures.length === 0, failures, warnings, brief: b };
}

export function planIdsFrom(planMd) {
  const ids = new Set();
  for (const l of (planMd || '').split('\n')) {
    if (!/^\s*\|/.test(l)) continue;
    const c = l.split('|').slice(1, -1).map((s) => s.trim());
    if (c[0] && /^[A-Z][A-Z0-9-]{0,9}$/.test(c[0]) && c[0] !== 'ID') ids.add(c[0]);
  }
  return ids;
}

export function lintPack(pp, cfg) {
  const results = { briefs: {}, failures: [], warnings: [] };
  const planIds = planIdsFrom(readText(path.join(pp.root, 'PLAN.md'), ''));
  const taskDirs = fs.existsSync(pp.tasks) ? fs.readdirSync(pp.tasks).filter((d) => !d.startsWith('_') && !d.startsWith('.') && fs.statSync(path.join(pp.tasks, d)).isDirectory()) : [];
  const idsJson = JSON.parse(readText(pp.ids, '{}'));
  const seenFiles = new Map();
  const byTask = {};
  for (const id of taskDirs) {
    const bp = path.join(pp.tasks, id, 'BRIEF.md');
    if (!fs.existsSync(bp)) { results.warnings.push(`${id}: no BRIEF.md`); continue; }
    const r = lintBrief(fs.readFileSync(bp, 'utf8'), { root: cfg.root, planIds, taskId: id });
    results.briefs[id] = r; byTask[id] = r.brief;
    for (const f of r.brief.owns.files) {
      const key = `${r.brief.owns.repo}:${normalizeOwn(f)}`;
      if (seenFiles.has(key) && seenFiles.get(key) !== id) results.failures.push(`${id} and ${seenFiles.get(key)} both own ${key}`);
      seenFiles.set(key, id);
    }
  }
  const ids = Object.keys(byTask);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = byTask[ids[i]], b = byTask[ids[j]];
    const related = a.header.needsFirst.includes(ids[j]) || b.header.needsFirst.includes(ids[i]);
    if (!related && a.owns.worktree && a.owns.worktree === b.owns.worktree) results.warnings.push(`${ids[i]} and ${ids[j]} share worktree ${a.owns.worktree} and may run at the same time`);
    // overlapping ownership in the same repo: a directory or glob in one task covering a file of the other
    if (a.owns.repo && a.owns.repo === b.owns.repo) {
      for (const fa of a.owns.files) for (const fb of b.owns.files) {
        const na = normalizeOwn(fa), nb = normalizeOwn(fb);
        if (na === nb) continue; // identical entries are reported above
        if (ownsOverlap(na, nb))
          results.failures.push(`${ids[i]} (${fa}) and ${ids[j]} (${fb}) overlap in ${a.owns.repo}: one writer per file`);
      }
    }
  }
  if (!planIds.size) results.warnings.push('PLAN board has no task rows yet (fill the Board table)');
  for (const id of planIds) if (!taskDirs.includes(id)) results.warnings.push(`PLAN lists ${id} but tasks/${id}/ is missing`);
  for (const id of taskDirs) if (planIds.size && !planIds.has(id)) results.warnings.push(`tasks/${id} is not on the PLAN board`);
  for (const id of taskDirs) if (Array.isArray(idsJson.tasks) && idsJson.tasks.length && !idsJson.tasks.includes(id)) results.warnings.push(`${id} was not allocated by pack-next-id (control/ids.json)`);
  for (const f of fs.readdirSync(pp.root)) if (!KNOWN_TOP.has(f)) results.warnings.push(`unknown top-level entry ${f} (packs have ten files and four folders)`);
  for (const f of fs.readdirSync(pp.root).filter((x) => x.endsWith('.md') && !['RULES.md', 'START-HERE.md'].includes(x))) {
    if (/\b(this file wins|overrides? (every|all|the) )/i.test(readText(path.join(pp.root, f), ''))) results.warnings.push(`${f} claims to override other files; use a dated RULES §A amendment instead`);
  }
  for (const f of ['START-HERE.md', 'GOAL.md', 'PLAN.md', 'RULES.md']) {
    if (!fs.existsSync(path.join(pp.root, f))) continue;
    const ph = findPlaceholders(readText(path.join(pp.root, f), ''));
    if (ph.length) results.warnings.push(`${f}: ${ph.length} placeholder(s) left, first ${ph[0].text} (line ${ph[0].line})`);
  }
  return results;
}
