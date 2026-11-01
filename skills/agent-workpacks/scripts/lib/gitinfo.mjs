// Read-only git probes with short timeouts. Never throws.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export function git(cwd, args, timeout = 1500) {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout });
    return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
  } catch (e) { return { ok: false, out: '', err: String(e), status: null }; }
}
export function isRepo(cwd) { return !!cwd && fs.existsSync(cwd) && git(cwd, ['rev-parse', '--is-inside-work-tree']).out === 'true'; }

export function gitInfo(cwd) {
  if (!isRepo(cwd)) return { available: false, dirty: false, changedFiles: [] };
  const head = git(cwd, ['rev-parse', '--short', 'HEAD']).out || null;
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out || null;
  // porcelain lines are fixed-width ("XY path"); parse each line untrimmed so a leading space is not lost
  const stRaw = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', timeout: 1500 });
  const changedFiles = (stRaw.stdout || '').split('\n').filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/\r$/, '').replace(/^"|"$/g, ''))
    .map((l) => (l.includes(' -> ') ? l.split(' -> ')[1] : l)).filter(Boolean);
  const lc = git(cwd, ['log', '-1', '--format=%ct']).out;
  return { available: true, head, branch, dirty: changedFiles.length > 0, changedFiles, lastCommitAt: lc ? Number(lc) * 1000 : null };
}

export function diffFiles(cwd, base, head = 'HEAD') {
  if (!isRepo(cwd)) return { ok: false, files: [], err: 'not a git checkout' };
  let r = git(cwd, ['diff', '--name-only', `${base}...${head}`], 5000);
  if (!r.ok) r = git(cwd, ['diff', '--name-only', base, head], 5000);
  return { ok: r.ok, files: r.out ? r.out.split('\n').filter(Boolean) : [], err: r.err };
}
export function diffStat(cwd) { return git(cwd, ['diff', '--stat'], 3000).out; }
