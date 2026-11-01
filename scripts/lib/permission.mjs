// Owns list -> OPENCODE_PERMISSION JSON, plus the deny baseline. OpenCode 1.18.x uses the first matching rule, so
// narrow overrides must precede broad defaults. Keep this ordering explicit: it protects destructive shell commands
// and secret reads while allowing only the task's declared write paths.
import path from 'node:path';

export const DESTRUCTIVE_BASH = [
  'git push --force*', 'git push -f*', 'git push --mirror*', 'git push --all*', 'git push * +*',
  'rm -rf *', 'rm -fr *', 'rm -r *', 'sudo *', 'launchctl *',
  'docker * prune*', 'docker * --volumes*', 'docker rm -v*', 'docker volume rm*',
  'git checkout -- .', 'git checkout .', 'git restore .', 'git reset --hard*', 'git clean -fd*', 'git clean -fdx*', 'git stash*',
  'gh pr merge*', 'gh api *refs/heads*',
];
// Workers commit locally only; the senior integrates, pushes and opens pull requests. These denies apply to every
// worker role and precede any extra allow, so no task-level allow can re-enable them. `gh api` is denied whole: gh
// switches to POST as soon as a field (-f/-F/--input) is given and accepts -XPOST, --method=POST and combined short
// flags (-iX POST), so a GET-only allowance cannot be expressed safely as a first-match glob.
export const WORKER_REMOTE_DENY = ['git push*', 'gh pr *', 'gh release *', 'gh repo *', 'gh api *', 'gh workflow *', 'gh run *', 'gh secret *', 'gh variable *', 'git -C * push*'];
export const RESERVED_DIRS = ['.opencode', '.claude', '.agents', '.codex'];
// Inside a task folder the worker owns STATUS.md, QUESTIONS.md (its questions), REPORT.md, HANDOFF.md and scratch
// output; these are the orchestrator's or the scripts' and stay read-only for the worker.
export const TASK_READ_ONLY_FILES = ['BRIEF.md', 'REVIEW.md', 'INBOX.md', 'PROMPT.txt', 'run.jsonl', 'launch.log', 'supervisor.log', 'exit.json', 'attempts/**', 'brief-versions/**', 'runtime/**'];

export function protectedBranchDenies(branches) {
  const out = [];
  for (const b of branches) out.push(`git push * ${b}*`, `git push * *:${b}*`, `git push * HEAD:${b}*`);
  return out;
}

export function normalizeOwn(entry) {
  let o = String(entry).replace(/\s*\(new\)\s*$/i, '').replace(/`/g, '').trim();
  if (o.endsWith('/')) o += '**';
  return o;
}
export function isNewMarked(entry) { return /\(new\)\s*$/i.test(String(entry)); }

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

// Returns the Owns entry that covers relFile (relative to the checkout), or null.
export function fileMatchesOwns(relFile, owns) {
  const f = relFile.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const raw of owns) {
    const o = normalizeOwn(raw).replace(/^\.\//, '');
    if (!o) continue;
    if (/[*?]/.test(o)) { if (globToRegExp(o).test(f)) return raw; continue; }
    if (f === o || f.startsWith(o.replace(/\/$/, '') + '/')) return raw;
  }
  return null;
}

export function outsideOwns(files, owns) { return files.filter((f) => !fileMatchesOwns(f, owns)); }

export function permissionObject({ root, checkout, owns, taskDir, protectedBranches = [], webfetch = 'deny', extraAllowBash = [] }) {
  const bash = {};
  for (const p of WORKER_REMOTE_DENY) bash[p] = 'deny';
  for (const p of extraAllowBash) if (!(p in bash)) bash[p] = 'allow';
  for (const p of protectedBranchDenies(protectedBranches)) bash[p] = 'deny';
  for (const p of DESTRUCTIVE_BASH) bash[p] = 'deny';
  bash['*'] = 'allow';
  const edit = {};
  const allow = (g) => { edit[g] = 'allow'; };
  const rootAbs = path.resolve(root), coAbs = path.resolve(checkout);
  let td, tdRel;
  if (taskDir) {
    td = path.resolve(taskDir); tdRel = path.relative(rootAbs, td);
    // These exact/narrow denies must be evaluated before the task-folder allow below.
    for (const f of TASK_READ_ONLY_FILES) { edit[path.join(td, f)] = 'deny'; edit[path.join(tdRel, f)] = 'deny'; }
  }
  for (const raw of owns) {
    const o = normalizeOwn(raw);
    if (!o) continue;
    const abs = path.resolve(coAbs, o);
    const rel = path.relative(rootAbs, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Owns entry outside the workspace root: ${raw}`);
    const relCo0 = path.relative(coAbs, abs);
    if (relCo0.startsWith('..') || path.isAbsolute(relCo0)) throw new Error(`Owns entry outside the task's checkout: ${raw}`);
    const first = rel.split('/').find(Boolean);
    const segs = path.relative(coAbs, abs).split('/');
    if (RESERVED_DIRS.includes(first) || segs.some((s) => RESERVED_DIRS.includes(s))) throw new Error(`Owns entry in a reserved directory: ${raw}`);
    allow(abs); allow(rel);
    const relCo = path.relative(coAbs, abs); if (relCo && !relCo.startsWith('..')) allow(relCo);
  }
  if (taskDir) {
    // The worker may write its own outputs in the task folder, not the brief, the review, the inbox or the runtime
    // artefacts. Narrow read-only denies were inserted first for OpenCode's first-match evaluation.
    allow(path.join(td, '**')); allow(path.join(tdRel, '**'));
  }
  edit['*'] = 'deny';
  return {
    edit, bash,
    read: { '**/.env': 'deny', '**/.env.*': 'deny', '**/*.env': 'deny', '~/project-sandbox-private/**': 'deny', '**/id_rsa*': 'deny', '**/*.pem': 'deny', '*': 'allow' },
    external_directory: 'deny',
    doom_loop: 'deny',
    webfetch,
  };
}
export function permissionJson(opts) { return JSON.stringify(permissionObject(opts)); }

// Offline model of OpenCode's bash rule check, used by tests to prove the map: `*` matches any run of characters
// (spaces and slashes included), `?` one character, a trailing " *" also matches the bare command, and the first
// matching rule wins (OpenCode 1.18.x, see the header). It judges one simple command, not a shell pipeline.
export function bashPatternMatches(pattern, command) {
  let re = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (re.endsWith(' .*')) re = re.slice(0, -3) + '( .*)?';
  return new RegExp('^' + re + '$', 's').test(command);
}
export function bashDecision(bash, command) {
  for (const [pattern, action] of Object.entries(bash)) if (bashPatternMatches(pattern, command)) return action;
  return 'ask';
}

// Conservative intersection: exact candidates are tested directly; ambiguous globs conflict.
export function ownsOverlap(a, b) {
  a = normalizeOwn(a).replace(/^\.\//, ''); b = normalizeOwn(b).replace(/^\.\//, '');
  if (a === b || fileMatchesOwns(a, [b]) || fileMatchesOwns(b, [a])) return true;
  const ga = /[*?]/.test(a), gb = /[*?]/.test(b);
  if (!ga && !gb) return false;
  const prefix = (s) => s.split(/[*?]/)[0];
  const pa = prefix(a), pb = prefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}
