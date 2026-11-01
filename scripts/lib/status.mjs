// Parsers for the markdown the sweep and controller read: STATUS.md headers, QUESTIONS.md, REPORT.md, BRIEF.md.
export const STATUS_STATES = ['not-started', 'running', 'needs-review', 'blocked', 'needs-owner', 'parked', 'done'];
const LOOSE_KEYS = ['task', 'state', 'updated', 'blocker', 'repairs', 'next_action', 'needs_owner', 'needs_orchestrator', 'session', 'phase', 'head', 'pr'];

export function parseStatusHeader(md) {
  const res = { ok: false, loose: false, fields: {}, warnings: [], blocker: null, needsOwner: false };
  if (!md || !md.trim()) { res.warnings.push('empty'); return res; }
  const lines = md.split('\n');
  let i = 0; while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.trim() === '---') {
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '---') { res.ok = true; break; }
      const m = l.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (m) res.fields[m[1].toLowerCase()] = m[2].replace(/\s+#.*$/, '').trim();
    }
    if (!res.ok) res.warnings.push('unterminated header');
  } else {
    const head = lines.slice(0, 20).join('\n');
    for (const k of LOOSE_KEYS) {
      const m = head.match(new RegExp('\\b' + k + '\\s*:\\s*([^|\\n]+?)(?=\\s{2,}|\\s*\\||\\s*$)', 'im'));
      if (m) res.fields[k] = m[1].trim();
    }
    if (Object.keys(res.fields).length) { res.ok = true; res.loose = true; } else res.warnings.push('no header');
  }
  const f = res.fields;
  if (f.state && !STATUS_STATES.includes(f.state)) res.warnings.push(`unknown state ${f.state}`);
  if (f.blocker && !/^(none|-|no|n\/a)?$/i.test(f.blocker)) {
    const identity = f.blocker.replace(/^setup\s+/i, '');
    const b = identity.match(/^([A-Za-z][A-Za-z0-9._-]*)\s*\((\d+)\s*\/\s*(\d+)\)/);
    res.blocker = b ? { id: b[1], n: +b[2], m: +b[3], setup: /setup/i.test(f.blocker) }
                    : { id: identity.split(/\s/)[0], n: null, m: null, setup: /setup/i.test(f.blocker) };
  }
  res.needsOwner = /^(yes|true)$/i.test(f.needs_owner || '');
  return res;
}

const Q_HEADING = /^#{2,}\s+(Q-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3})\b\s*(.*)$/;
export function parseQuestions(md) {
  const out = [];
  if (!md) return out;
  const lines = md.split('\n');
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = l.match(Q_HEADING);
    if (h) {
      const tagM = h[2].match(/\[(owner|senior|orchestrator)\]/i);
      cur = { id: h[1], title: h[2].replace(/\[(owner|senior|orchestrator)\]/i, '').trim(), tag: tagM ? tagM[1].toLowerCase() : 'senior', answered: false, line: i + 1, body: [] };
      out.push(cur); continue;
    }
    if (/^#{1,6}\s/.test(l)) { cur = null; continue; }
    if (cur) { cur.body.push(l); if (/^\s*\*\*(A\s*\(|ANSWER)/i.test(l)) cur.answered = true; }
  }
  return out;
}

export function checkReport(md) {
  if (!md || !md.trim()) return { present: false };
  const lines = md.split('\n');
  const head = lines.slice(0, 12).filter((l) => l.trim() && !/^#/.test(l));
  const testsIdx = lines.findIndex((l) => /^##\s*Tests/i.test(l));
  let testsBlock = '';
  if (testsIdx >= 0) { let j = testsIdx + 1; while (j < lines.length && !/^##\s/.test(lines[j])) testsBlock += lines[j++] + '\n'; }
  return {
    present: true,
    threeLineSummary: head.length >= 3,
    hasTestsSection: testsIdx >= 0,
    hasPastedOutput: /```/.test(testsBlock) || /\b(PASS|FAIL|passed|failed|Tests:|✓|✗)\b/.test(testsBlock),
  };
}

const SECTION_RE = { owns: /^##\s*Owns/i, tasks: /^##\s*Tasks/i, tests: /^##\s*Tests/i, handBack: /^##\s*Hand back/i, askFirst: /^##\s*Ask first if/i };

export function parseBrief(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const b = {
    id: null, title: null,
    header: { binding: false, outOfScope: null, boundaries: null, stop: null, lock: null, needsFirst: [], size: null, role: null },
    owns: { rows: [], repo: null, worktree: null, branch: null, base: null, files: [] },
    sections: {}, lineCount: lines.filter((l, i, a) => !(i === a.length - 1 && l === '')).length, hasToolCommand: false,
  };
  const t = lines[0]?.match(/^#\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[—–:-]+\s*(.*))?$/);
  if (t) { b.id = t[1]; b.title = (t[2] || '').trim(); }
  const headerZone = lines.slice(0, 15).join('\n');
  b.header.binding = /\bBINDING\b/.test(headerZone);
  const grab = (k) => { const m = headerZone.match(new RegExp('^\\s*' + k + '\\s*:\\s*(.+)$', 'im')); return m ? m[1].trim() : null; };
  b.header.outOfScope = grab('OUT OF SCOPE');
  b.header.boundaries = grab('BOUNDARIES TOUCHED');
  b.header.stop = grab('STOP CONDITION');
  b.header.lock = grab('Lock');
  const nf = headerZone.match(/Needs first\s*:\s*(.*?)(?=\s{2,}|\s+Size\s*:|\s+Role\s*:|$)/im);
  if (nf) b.header.needsFirst = nf[1].split(/[,\s]+/).map((s) => s.trim()).filter((s) => s && !/^none$/i.test(s));
  const sz = headerZone.match(/\bSize\s*:\s*([A-Za-z]+)/); if (sz) b.header.size = sz[1].toUpperCase();
  const rl = headerZone.match(/\bRole\s*:\s*([A-Za-z]+)/); if (rl) b.header.role = rl[1].toLowerCase();
  let cur = null;
  for (const l of lines) {
    if (/^##\s/.test(l)) { cur = Object.keys(SECTION_RE).find((k) => SECTION_RE[k].test(l)) || `other:${l.trim()}`; b.sections[cur] = b.sections[cur] || []; continue; }
    if (cur) b.sections[cur].push(l);
  }
  const extraFiles = [];
  for (const l of b.sections.owns || []) {
    if (!/^\s*\|/.test(l)) { const bl = l.match(/^\s*[-*]\s+(.+)$/); if (bl) extraFiles.push(bl[1].trim().replace(/^`|`$/g, '')); continue; }
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    if (/^repo$/i.test(cells[0]) || /^:?-+:?$/.test(cells[0])) continue;
    const br = cells[2].replace(/`/g, '').match(/^([^\s(]+)\s*(?:\(([^)]*)\))?/);
    b.owns.rows.push({
      repo: cells[0].replace(/`/g, ''), worktree: cells[1].replace(/`/g, ''),
      branch: br ? br[1] : null, base: br && br[2] ? br[2].trim() : null,
      files: cells[3].split(/,\s*/).map((s) => s.trim().replace(/`/g, '')).filter(Boolean),
    });
  }
  if (b.owns.rows[0]) {
    const r = b.owns.rows[0];
    Object.assign(b.owns, { repo: r.repo, worktree: r.worktree, branch: r.branch, base: r.base, files: [...r.files, ...extraFiles] });
  } else b.owns.files = extraFiles;
  b.hasToolCommand = lines.some((l) => /^\s*(?:\$\s*)?`?(claude|codex|opencode)\s+(--|run|exec|-p\b|--bg|resume)/.test(l));
  return b;
}

// Placeholders left in a brief or pack file: <angle text> or {{token}} outside fenced blocks and inline code.
export function findPlaceholders(md) {
  const out = [];
  let fenced = false;
  md.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { fenced = !fenced; return; }
    if (fenced) return;
    const l = raw.replace(/`[^`]*`/g, '');
    const m = l.match(/<[A-Za-z][^<>\n]{0,60}>|\{\{[^}\n]{1,40}\}\}/);
    if (m) out.push({ line: i + 1, text: m[0] });
  });
  return out;
}
