#!/usr/bin/env node
// Fixture-driven tests for the agent-workpacks scripts. A fake `opencode` (fixtures/bin/opencode) stands in for the real
// one, so nothing here calls a model. Prints PASS/FAIL per case; exit 1 if any case failed. `--only <substr>` filters.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sleepMs, pidAlive, parseArgs, readJson, sha1, sha256 } from '../../skills/agent-workpacks/scripts/lib/paths.mjs';
import { permissionObject, fileMatchesOwns, outsideOwns, WORKER_REMOTE_DENY, bashDecision, bashPatternMatches } from '../../skills/agent-workpacks/scripts/lib/permission.mjs';
import { parseStatusHeader, parseQuestions, parseBrief, findPlaceholders, checkReport } from '../../skills/agent-workpacks/scripts/lib/status.mjs';
import { parseLine, summarize, redact, classifyProviderError, attemptDiagnostics, attemptMarkerLine } from '../../skills/agent-workpacks/scripts/lib/events.mjs';
import { isDeepseekPeak } from '../../skills/agent-workpacks/scripts/lib/time.mjs';
import { gitInfo } from '../../skills/agent-workpacks/scripts/lib/gitinfo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SC = path.resolve(here, '../../skills/agent-workpacks/scripts');
const FX = path.join(here, 'fixtures');
const STUB = path.join(FX, 'bin', 'opencode');
const NODE = process.execPath;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workpacks-tests-'));
const args = parseArgs(process.argv.slice(2));
const only = args.only;
const baseEnv = { ...process.env, OC_BIN: STUB, DP_NO_DB: '1', OC_FAKE_MEM_FREE: '50', OC_STUB_SLEEP: '1' };
delete baseEnv.OC_FAKE_NOW; delete baseEnv.OC_STUB_MODE; delete baseEnv.OPENCODE_PERMISSION;
const results = [];
const lockFiles = () => { try { return fs.readdirSync(path.join(TMP, '.agent-workpacks', 'locks')).filter((f) => !f.startsWith('.')); } catch { return []; } };

const run = (script, a, env = {}, timeout = 40000) => { const r = spawnSync(NODE, [path.join(SC, script), ...a], { encoding: 'utf8', env: { ...baseEnv, ...env }, timeout }); return { status: r.status, out: r.stdout || '', err: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') }; };
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const read = (f, d = '') => { try { return fs.readFileSync(f, 'utf8'); } catch { return d; } };
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const PLAN = 'Fixture ownership only.\n';
const DIGEST = sha256(PLAN);
write(path.join(TMP, '.ddd-guard/fixture/OWNERSHIP-PLAN.md'), PLAN);
write(path.join(TMP, '.ddd-guard/fixture/SCOPE-LOCK.txt'), `plan: .ddd-guard/fixture/OWNERSHIP-PLAN.md\ndigest: ${DIGEST}\napproved: YES\n`);
function seedProbes(pack, checked_at = new Date().toISOString()) {
  for (const model of ['opencode-go/deepseek-v4.1-flash','opencode-go/glm-5.3-flash']) write(path.join(pack, 'control', 'probe-' + model.replace(/[^a-zA-Z0-9._-]/g, '-') + '.json'), JSON.stringify({model, checked_at, result:'ok'}));
}
let packN = 0;
function mkPack(extra = []) { const name = `tp${++packN}`; const r = run('pack-init.mjs', [name, '--pfx', 'TS', '--root', TMP, '--parent', TMP, ...extra]); assert(r.status === 0, `pack-init failed: ${r.all}`); const pack = path.join(TMP, `${name}-pack-v1`); const cf = path.join(pack, 'control/config.json'); const cfg = readJson(cf); cfg.project_policy = { type: 'ddd' }; cfg.protected_branches.push('staging'); write(cf, JSON.stringify(cfg)); seedProbes(pack); return pack; }
function mkRepo(name) { const d = path.join(TMP, name); fs.mkdirSync(path.join(d, 'src'), { recursive: true }); const g = (a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' }); g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']); write(path.join(d, 'src', 'a.ts'), 'export const a = 1;\n'); write(path.join(d, 'src', 'b.ts'), 'export const b = 1;\n'); g(['add', '.']); g(['commit', '-q', '-m', 'init']); return d; }
const git = (d, a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
function brief(id, { repo, worktree, branch = 'ts/x', base = 'main', files, role = 'coder', needs = 'none', tests = '- `npm test` on base and candidate; 0 new failures; paste the output', extraLines = [] }) {
  return ['# ' + id + ' — test task ' + id, 'Read RULES.md §C first. BINDING: the numbered Tasks and Tests below. Everything else is context, not work.', 'OUT OF SCOPE: anything else', 'BOUNDARIES TOUCHED: none', 'STOP CONDITION: hand back once at needs-review; stop and ask when any "Ask first if" item is true', (['researcher','docs','verifier'].includes(role) ? 'Lock: none (read-only or documentation)' : `Lock: .ddd-guard/fixture digest ${DIGEST} approved YES`), `Needs first: ${needs}    Size: S    Role: ${role}`, '', '## Owns (writes only; one writer per file)', '| Repo | Worktree | Branch (from base) | Files / dirs |', '|---|---|---|---|', `| ${repo} | ${worktree} | ${branch} (${base}) | ${files} |`, '', '## Tasks', '1. Do the one thing.', '', '## Tests', tests, '', '## Hand back', `- Commit on the local branch, tasks/${id}/REPORT.md with a 3-line summary first, STATUS state needs-review; stop.`, '', '## Ask first if', '- anything is unclear', ...extraLines, ''].join('\n');
}
function addTask(pack, id, md) { const r = run('pack-next-id.mjs', [pack, '--kind', 'task', '--id', id]); assert(r.status === 0 || r.status === 3, `next-id failed: ${r.all}`); write(path.join(pack, 'tasks', id, 'BRIEF.md'), md); }
const roster = (pack) => readJson(path.join(pack, 'control', 'roster.json'));
const task = (pack, id) => roster(pack).tasks.find((t) => t.id === id);
function waitFor(fn, ms = 10000, step = 200) { const until = Date.now() + ms; while (Date.now() < until) { if (fn()) return true; sleepMs(step); } return !!fn(); }
const waitExit = (pack, id, ms = 15000) => waitFor(() => { const t = task(pack, id); return t && !['running', 'queued'].includes(t.state) && !pidAlive(t.pid); }, ms);
const waitRunning = (pack, id, ms = 6000) => waitFor(() => { const t = task(pack, id); return t && t.pid && pidAlive(t.pid); }, ms);
function stopTask(pack, id) { const t = task(pack, id); if (t?.pid && pidAlive(t.pid)) run('pack-worker.mjs', ['stop', '--pack', pack, '--task', id, '--grace', '1']); }
function start(pack, id, mode, extra = [], env = {}) { return run('pack-worker.mjs', ['start', '--pack', pack, '--task', id, ...extra], { OC_STUB_MODE: mode, OC_STUB_ARGS_FILE: path.join(pack, 'control', 'stub-args.log'), ...env }); }
const sweepJson = (pack, extra = [], env = {}) => { const r = run('pack-sweep.mjs', ['--pack', pack, '--json', ...extra], env); let j = null; try { j = JSON.parse(r.out); } catch {} return { ...r, j }; };
const setStatus = (pack, id, fields) => write(path.join(pack, 'tasks', id, 'STATUS.md'), '---\n' + Object.entries({ task: id, state: 'running', updated: new Date().toISOString(), blocker: 'none', next_action: 'continue', needs_owner: 'no', ...fields }).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n## Log\n- created\n');
const goodReport = (id) => `# ${id} report\n\n1. did it\n2. tested it\n3. nothing left\n\n## Files\n| File | Owns entry |\n|---|---|\n\n## Tests\n| Suite | Base | Candidate | New failures |\n|---|---|---|---|\n\`\`\`\nTests: 3 passed, 3 total\n\`\`\`\n\nStopped at needs-review.\n`;
function test(name, fn) { if (only && !name.includes(only)) return; try { fn(); results.push([name, true]); console.log(`PASS ${name}`); } catch (e) { results.push([name, false]); console.log(`FAIL ${name} :: ${e.message.split('\n').slice(0, 6).join(' | ')}`); } }

// ------------------------------------------------------------------ pure library
test('events: parseLine tolerates banners and summarises loops', () => {
  const lines = ['\x1b[0m', '> build · x', '{"type":"step_start","timestamp":1000,"sessionID":"ses_a","part":{"type":"step-start"}}',
    '{"type":"tool_use","timestamp":2000,"sessionID":"ses_a","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"ls"},"output":"a"}}}',
    '{"type":"tool_use","timestamp":3000,"sessionID":"ses_a","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"ls"},"output":"a"}}}',
    '{"type":"tool_use","timestamp":4000,"sessionID":"ses_a","part":{"type":"tool","tool":"bash","state":{"status":"error","input":{"command":"ls"},"output":"boom"}}}',
    '{"type":"text","timestamp":5000,"sessionID":"ses_a","part":{"type":"text","text":"a"}}', '{"type":"text","timestamp":6000,"sessionID":"ses_a","part":{"type":"text","text":"b"}}', 'garbage'];
  const ev = lines.map(parseLine).filter(Boolean); eq(ev.length, 6, 'parsed events');
  const s = summarize(ev); eq(s.sessionID, 'ses_a', 'session'); eq(s.maxIdentical, 3, 'identical run'); eq(s.maxTextRun, 2, 'text run'); eq(s.toolCalls, 3, 'tool calls'); eq(s.errors.length, 1, 'errors'); eq(s.firstStepAt, 1000, 'first step');
});
test('events: redact hides keys, tokens and credentials in URLs', () => {
  const r = redact('API_KEY=abc123def456 https://u:pw@host/x sk-abcdefghijklmnopqrstuvwxyz1234 token: zzz');
  assert(!r.includes('abc123def456'), 'key leaked'); assert(!r.includes('u:pw@'), 'url cred leaked'); assert(r.includes('<redacted>'), 'no marker'); assert(!/sk-abcdef/.test(r), 'token leaked');
  eq(classifyProviderError('APIError: You have run out of credits'), 'credits', 'credits'); eq(classifyProviderError('Bad Request: {"model":"x"}'), 'bad-model', 'bad-model'); eq(classifyProviderError('Cannot connect to API'), 'connect', 'connect');
});
test('permission: Owns map, deny baseline, reserved dirs', () => {
  const p = permissionObject({ root: '/r', checkout: '/r/repo', owns: ['src/a.ts', 'docs/ (new)', 'tests/unit/*.spec.ts'], taskDir: '/r/pack/tasks/T1', protectedBranches: ['staging', 'master'] });
  eq(p.edit['*'], 'deny', 'edit default'); eq(p.edit['/r/repo/src/a.ts'], 'allow', 'abs allow'); eq(p.edit['repo/src/a.ts'], 'allow', 'root-rel allow'); eq(p.edit['src/a.ts'], 'allow', 'checkout-rel allow'); eq(p.edit['/r/repo/docs/**'], 'allow', 'dir glob'); eq(p.edit['/r/pack/tasks/T1/**'], 'allow', 'task dir');
  eq(p.edit['/r/pack/tasks/T1/BRIEF.md'], 'deny', 'brief read-only'); eq(p.edit['/r/pack/tasks/T1/REVIEW.md'], 'deny', 'review read-only');
  eq(p.bash['*'], 'allow', 'bash default'); eq(p.bash['git push * staging*'], 'deny', 'protected'); eq(p.bash['git push * HEAD:master*'], 'deny', 'protected head'); eq(p.bash['rm -rf *'], 'deny', 'rm'); eq(p.bash['git checkout -- .'], 'deny', 'checkout dot'); eq(p.doom_loop, 'deny', 'doom'); eq(p.external_directory, 'deny', 'ext'); eq(p.read['**/.env'], 'deny', 'env read');
  eq(Object.keys(p.edit)[0], '/r/pack/tasks/T1/BRIEF.md', 'narrow task deny first'); eq(Object.keys(p.edit).at(-1), '*', 'edit default last');
  eq(Object.keys(p.bash).at(-1), '*', 'bash default last'); eq(Object.keys(p.read).at(-1), '*', 'read default last');
  let threw = false; try { permissionObject({ root: '/r', checkout: '/r/repo', owns: ['../x'], taskDir: '/r/p/t' }); } catch { threw = true; } assert(threw, 'escape not refused');
  threw = false; try { permissionObject({ root: '/r', checkout: '/r/repo', owns: ['.opencode/agent/x.md'], taskDir: '/r/p/t' }); } catch { threw = true; } assert(threw, 'reserved not refused');
  eq(fileMatchesOwns('src/a.ts', ['src/a.ts']), 'src/a.ts', 'exact'); eq(fileMatchesOwns('src/dir/x.ts', ['src/dir/']), 'src/dir/', 'dir'); eq(fileMatchesOwns('tests/unit/x.spec.ts', ['tests/unit/*.spec.ts']), 'tests/unit/*.spec.ts', 'glob'); eq(fileMatchesOwns('other.ts', ['src/a.ts']), null, 'no match');
  eq(outsideOwns(['src/a.ts', 'zz.ts'], ['src/a.ts']).join(), 'zz.ts', 'outside');
});
test('permission: every worker role denies push, PR, release, repo and api; commit stays allowed', () => {
  // The inputs pack-worker builds per role: code roles own checkout files; research and docs own only their task folder.
  const code = { root: '/r', checkout: '/r/repo', owns: ['src/a.ts'], taskDir: '/r/pack/tasks/T1', protectedBranches: ['staging', 'master'] };
  const folder = { root: '/r', checkout: '/r/pack/tasks/R1', owns: [], taskDir: '/r/pack/tasks/R1', protectedBranches: ['staging'], webfetch: 'allow' };
  const roles = { coder: permissionObject(code), verifier: permissionObject({ ...code, taskDir: '/r/pack/tasks/V1' }), researcher: permissionObject(folder), docs: permissionObject({ ...folder, checkout: '/r/pack/tasks/D1', taskDir: '/r/pack/tasks/D1' }) };
  // Older OpenCode releases let the longest matching pattern win; the decisions below must hold under both rules.
  const longest = (bash, cmd) => { let best = null; for (const [p, a] of Object.entries(bash)) if (bashPatternMatches(p, cmd) && (!best || p.length > best[0].length)) best = [p, a]; return best ? best[1] : 'ask'; };
  const denied = ['git push', 'git push origin ts/x', 'git push -u origin HEAD', 'gh pr create --draft --base staging', 'gh pr view 12', 'gh release create v1.0.0', 'gh repo clone org/x', 'gh api repos/org/x/pulls', 'gh api -X PATCH repos/org/x', 'gh api graphql -f query=x', 'git push --force origin ts/x', 'git stash', 'git reset --hard HEAD~1', 'rm -rf build'];
  const allowed = ['git commit -m "feat: push notification channel"', 'git commit -am "wip(T1): step 1"', 'git add src/a.ts', 'git status', 'git log --oneline -5', 'git fetch origin', 'git diff --stat', 'npm test'];
  for (const [role, p] of Object.entries(roles)) {
    const keys = Object.keys(p.bash);
    for (const pat of WORKER_REMOTE_DENY) { eq(p.bash[pat], 'deny', `${role} ${pat}`); assert(keys.indexOf(pat) < keys.indexOf('*'), `${role}: ${pat} must precede the * default`); }
    eq(p.bash['git stash*'], 'deny', `${role} keeps the existing denies`); eq(keys.at(-1), '*', `${role} default last`);
    for (const c of denied) { eq(bashDecision(p.bash, c), 'deny', `${role} first-match ${c}`); eq(longest(p.bash, c), 'deny', `${role} longest-match ${c}`); }
    for (const c of allowed) { eq(bashDecision(p.bash, c), 'allow', `${role} first-match ${c}`); eq(longest(p.bash, c), 'allow', `${role} longest-match ${c}`); }
  }
  const extra = permissionObject({ ...code, extraAllowBash: ['git push origin ts/*', 'git push*', 'npm run lint*'] });
  eq(bashDecision(extra.bash, 'git push origin ts/x'), 'deny', 'an extra allow cannot re-enable push'); eq(extra.bash['git push*'], 'deny', 'same-key extra allow ignored'); eq(bashDecision(extra.bash, 'npm run lint'), 'allow', 'other extra allows still apply');
});
test('status: header strict and loose, blocker, questions, report', () => {
  const s = parseStatusHeader('---\ntask: T1\nstate: blocked\nupdated: 2026-10-05T10:00:00Z\nblocker: B1 (2/2)\nneeds_owner: no\n---\n## Log\n');
  eq(s.ok, true, 'ok'); eq(s.loose, false, 'strict'); eq(s.fields.state, 'blocked', 'state'); eq(s.blocker.id, 'B1', 'blocker id'); eq(s.blocker.n, 2, 'n'); eq(s.blocker.setup, false, 'setup');
  const l = parseStatusHeader('# T1\nstate: running  updated: 2026-10-05T10:00:00Z  blocker: setup NM (2/2)\n'); eq(l.loose, true, 'loose'); eq(l.fields.state, 'running', 'loose state'); eq(l.blocker.setup, true, 'setup flag'); eq(l.blocker.id, 'NM', 'stable setup identity'); eq(l.blocker.n, 2, 'setup count');
  const u = parseStatusHeader('nothing here\n'); eq(u.ok, false, 'unparsable');
  const q = parseQuestions('# Qs\n## Q-TS-T1-001 Which DTO? [owner]\n- why\n## Q-TS-T1-002 Other\n- why\n**A (consultant x, 10:00):** use X\n## R-T1-001 fix\n');
  eq(q.length, 2, 'two questions'); eq(q[0].answered, false, 'q1 open'); eq(q[0].tag, 'owner', 'tag'); eq(q[1].answered, true, 'q2 answered'); eq(q[1].tag, 'senior', 'default tag');
  const r = checkReport(goodReport('T1')); eq(r.present && r.threeLineSummary && r.hasTestsSection && r.hasPastedOutput, true, 'good report'); eq(checkReport('# x\n## Tests\nall good\n').hasPastedOutput, false, 'no output');
});
test('status: parseBrief and placeholders', () => {
  const b = parseBrief(brief('T9', { repo: 'repo-a', worktree: 'repo-a', files: 'src/a.ts, src/new.ts (new)', needs: 'T1, T2' }));
  eq(b.id, 'T9', 'id'); eq(b.header.binding, true, 'binding'); eq(b.header.size, 'S', 'size'); eq(b.header.role, 'coder', 'role'); eq(b.header.needsFirst.join(), 'T1,T2', 'needs'); eq(b.owns.repo, 'repo-a', 'repo'); eq(b.owns.branch, 'ts/x', 'branch'); eq(b.owns.base, 'main', 'base'); eq(b.owns.files.length, 2, 'files'); eq(b.hasToolCommand, false, 'tool cmd');
  eq(findPlaceholders('a <fill: x> b\n`<code>` ok\n```\n<fenced>\n```\n{{PFX}}').length, 2, 'placeholders');
});
test('time: DeepSeek peak windows (UTC, Mon–Fri)', () => {
  eq(isDeepseekPeak(new Date('2026-10-06T02:00:00Z')), true, 'Tue 02Z'); eq(isDeepseekPeak(new Date('2026-10-06T05:00:00Z')), false, 'Tue 05Z'); eq(isDeepseekPeak(new Date('2026-10-06T09:59:00Z')), true, 'Tue 09:59Z'); eq(isDeepseekPeak(new Date('2026-10-10T02:00:00Z')), false, 'Sat 02Z');
});

// ------------------------------------------------------------------ init / next-id / lint
const P = mkPack(); const A = mkRepo('repo-a'); const B = mkRepo('repo-b');
test('init: tree, substitution, refuse re-run', () => {
  for (const f of ['START-HERE.md', 'RULES.md', 'PLAN.md', 'control/config.json', 'control/roster.json', 'control/ids.json', 'tasks/_templates/BRIEF.md', 'control/CURRENT.md']) assert(fs.existsSync(path.join(P, f)), `missing ${f}`);
  assert(!read(path.join(P, 'START-HERE.md')).includes('{{'), 'placeholders left in START-HERE'); assert(!read(path.join(P, 'RULES.md')).includes('{{'), 'placeholders left in RULES'); assert(read(path.join(P, 'RULES.md')).includes('You are the worker for task ID'), 'preamble not rendered into RULES §C');
  eq(readJson(path.join(P, 'control', 'config.json')).pfx, 'TS', 'pfx'); const again = run('pack-init.mjs', ['tp1', '--root', TMP, '--parent', TMP]); eq(again.status, 3, 'refuse re-run');
});
test('next-id: counters, per-task review ids, migrations, duplicates', () => {
  const P = mkPack();
  eq(run('pack-next-id.mjs', [P, '--kind', 'q']).out.trim(), 'Q-TS-001', 'q1'); eq(run('pack-next-id.mjs', [P, '--kind', 'q']).out.trim(), 'Q-TS-002', 'q2'); eq(run('pack-next-id.mjs', [P, '--kind', 'd']).out.trim(), 'D-TS-001', 'd1');
  eq(run('pack-next-id.mjs', [P, '--kind', 'r', '--task', 'T1']).out.trim(), 'R-T1-001', 'r1'); eq(run('pack-next-id.mjs', [P, '--kind', 'migration', '--repo', 'exchange', '--max-on-base', '0053', '--task', 'T1']).out.trim(), '0054', 'mig1'); eq(run('pack-next-id.mjs', [P, '--kind', 'migration', '--repo', 'exchange']).out.trim(), '0055', 'mig2');
  eq(run('pack-next-id.mjs', [P, '--kind', 'task', '--id', 'ZZ']).status, 0, 'alloc ZZ'); eq(run('pack-next-id.mjs', [P, '--kind', 'task', '--id', 'ZZ']).status, 3, 'dup ZZ'); eq(run('pack-next-id.mjs', [P, '--kind', 'task']).out.trim(), 'T1', 'auto T1');
});
test('lint: brief fixtures pass / warn / fail', () => {
  const fx = path.join(TMP, 'brief-fixtures');
  const base = { repo: 'repo-a', worktree: 'repo-a', files: 'src/a.ts, src/new.ts (new)' };
  write(path.join(fx, 'pass.md'), brief('T1', base));
  write(path.join(fx, 'warn-long.md'), brief('T1', { ...base, extraLines: Array.from({ length: 70 }, (_, i) => `- note ${i}`) }));
  write(path.join(fx, 'fail-too-long.md'), brief('T1', { ...base, extraLines: Array.from({ length: 100 }, (_, i) => `- note ${i}`) }));
  write(path.join(fx, 'fail-missing-owns.md'), brief('T1', base).replace('## Owns (writes only; one writer per file)', '## Stuff'));
  write(path.join(fx, 'fail-placeholder.md'), brief('T1', base).replace('anything else', '<fill: scope>'));
  write(path.join(fx, 'fail-secret.md'), brief('T1', { ...base, extraLines: ['- use key sk-abcdefghijklmnopqrstuvwxyz123456'] }));
  write(path.join(fx, 'fail-owns-outside.md'), brief('T1', { ...base, files: '../repo-b/src/a.ts' }));
  write(path.join(fx, 'fail-tool-command.md'), brief('T1', { ...base, extraLines: ['', 'claude --bg -n x "do it"'] }));
  write(path.join(fx, 'fail-missing-file.md'), brief('T1', { ...base, files: 'src/does-not-exist.ts' }));
  write(path.join(fx, 'fail-two-rows.md'), brief('T1', base).replace('| repo-a | repo-a | ts/x (main) | src/a.ts, src/new.ts (new) |', '| repo-a | repo-a | ts/x (main) | src/a.ts |\n| repo-b | repo-b | ts/y (main) | src/b.ts |'));
  const expect = { 'pass.md': 0, 'warn-long.md': 3, 'fail-too-long.md': 4, 'fail-missing-owns.md': 4, 'fail-placeholder.md': 4, 'fail-secret.md': 4, 'fail-owns-outside.md': 4, 'fail-tool-command.md': 4, 'fail-missing-file.md': 4, 'fail-two-rows.md': 4 };
  for (const [f, code] of Object.entries(expect)) { const r = run('pack-lint.mjs', ['--brief', path.join(fx, f), '--root', TMP, '--task', 'T1']); eq(r.status, code, `${f}: ${r.all.split('\n').slice(0, 3).join(' | ')}`); }
});
test('lint: pack-level duplicate ownership fails, PLAN mismatch warns', () => {
  const Q = mkPack();
  addTask(Q, 'T1', brief('T1', { repo: 'repo-a', worktree: 'repo-a', files: 'src/a.ts' }));
  addTask(Q, 'T2', brief('T2', { repo: 'repo-a', worktree: 'repo-a', files: 'src/a.ts', branch: 'ts/y' }));
  const r = run('pack-lint.mjs', [Q]); eq(r.status, 4, `expected duplicate-ownership failure: ${r.all.split('\n').slice(-6).join(' | ')}`); assert(/both own/.test(r.out), 'no both-own message');
  write(path.join(Q, 'tasks', 'T2', 'BRIEF.md'), brief('T2', { repo: 'repo-a', worktree: 'repo-a', files: 'src/b.ts', branch: 'ts/y', needs: 'T1' }));
  const r2 = run('pack-lint.mjs', [Q]); assert(r2.status < 4, `expected pass/warn: ${r2.all}`); assert(/PLAN/.test(r2.out), 'expected a PLAN warning');
  write(path.join(Q, 'tasks', 'T2', 'BRIEF.md'), brief('T2', { repo: 'repo-a', worktree: 'repo-a', files: 'src/', branch: 'ts/y' }));
  const r3 = run('pack-lint.mjs', [Q]); eq(r3.status, 4, `overlap (src/ vs src/a.ts) must fail: ${r3.all.split('\n').slice(-5).join(' | ')}`); assert(/overlap/.test(r3.out), 'no overlap message');
});
test('gitinfo: a modified tracked file keeps its full path (leading-space porcelain line)', () => {
  const d = mkRepo('repo-git'); write(path.join(d, 'src', 'a.ts'), 'changed\n');
  const gi = gitInfo(d); assert(gi.changedFiles.includes('src/a.ts'), `parsed ${JSON.stringify(gi.changedFiles)}`); assert(!gi.changedFiles.includes('rc/a.ts'), 'leading space was trimmed away');
});

// ------------------------------------------------------------------ controller
addTask(P, 'T1', brief('T1', { repo: 'repo-a', worktree: 'repo-a', files: 'src/a.ts' }));
addTask(P, 'T2', brief('T2', { repo: 'repo-b', worktree: 'repo-b', files: 'src/a.ts', branch: 'ts/t2' }));
addTask(P, 'T3', brief('T3', { repo: 'repo-b', worktree: 'repo-b', files: 'src/b.ts', branch: 'ts/t3' }));
addTask(P, 'R1', brief('R1', { repo: '(pack)', worktree: 'tasks/R1', branch: 'none', base: 'none', files: 'tasks/R1/REPORT.md (new)', role: 'researcher', tests: '- none to run; cite file:line' }));
const argsLog = path.join(P, 'control', 'stub-args.log');
test('start: ok run → roster, session, permission, lock released, ledger', () => {
  const r = start(P, 'T1', 'ok'); eq(r.status, 0, `start failed: ${r.all}`); assert(/started T1/.test(r.out), 'no started line');
  assert(waitExit(P, 'T1'), 'T1 did not exit'); const t = task(P, 'T1');
  eq(t.state, 'exited', 'state'); eq(t.exit_code, 0, 'exit code'); assert(/^ses_stub/.test(t.session_id || ''), `session not captured: ${t.session_id}`); eq(t.history.length, 1, 'history'); eq(t.history[0].reason, 'exited', 'reason'); eq(t.model, 'opencode-go/deepseek-v4.1-flash', 'coder model'); eq(t.checkout, A, 'checkout');
  const ex = readJson(path.join(P, 'tasks', 'T1', 'exit.json')); eq(ex.reason, 'exited', 'exit.json reason'); assert(ex.events >= 3, 'events counted');
  const log = read(argsLog); assert(/\[--format\] \[json\]/.test(log), 'no --format json'); assert(log.includes(`[--dir] [${TMP}]`), 'wrong --dir'); assert(/You are the worker for task T1/.test(log), 'preamble missing from prompt'); assert(/\[--variant\] \[high\]/.test(log), 'variant');
  const perm = JSON.parse(log.split('PERMISSION: ')[1].split('\n')[0]); eq(perm.edit['*'], 'deny', 'edit default'); assert(Object.keys(perm.edit).some((k) => k.endsWith('src/a.ts') && perm.edit[k] === 'allow'), 'owns not allowed'); eq(perm.bash['git push * staging*'], 'deny', 'protected branch deny');
  for (const p of WORKER_REMOTE_DENY) eq(perm.bash[p], 'deny', `coder env JSON denies ${p}`);
  eq(bashDecision(perm.bash, 'git push -u origin ts/x'), 'deny', 'coder env push'); eq(bashDecision(perm.bash, 'gh pr create --draft --base staging'), 'deny', 'coder env PR'); eq(bashDecision(perm.bash, 'git commit -m "wip(T1): step"'), 'allow', 'coder env commit');
  assert(lockFiles().length === 0, 'lock not released');
  assert(/started T1/.test(read(path.join(P, 'LEDGER.md'))), 'ledger line'); assert(fs.existsSync(path.join(P, 'tasks', 'T1', 'STATUS.md')), 'STATUS template not created');
});
test('start: research task uses GLM, task-folder checkout, webfetch allowed', () => {
  const r = start(P, 'R1', 'ok', ['--dry-run']); eq(r.status, 0, `dry run failed: ${r.all}`); assert(/glm-5.3-flash/.test(r.out), 'researcher model'); assert(r.out.includes(path.join(P, 'tasks', 'R1')), 'checkout should be the task folder');
  const r2 = start(P, 'R1', 'ok'); eq(r2.status, 0, r2.all); assert(waitExit(P, 'R1'), 'R1 exit'); const perm = JSON.parse(read(argsLog).split('PERMISSION: ').pop().split('\n')[0]); eq(perm.webfetch, 'allow', 'webfetch'); assert(Object.keys(perm.edit).some((k) => k.includes('tasks/R1')), 'task dir allowed');
  for (const p of WORKER_REMOTE_DENY) eq(perm.bash[p], 'deny', `researcher env JSON denies ${p}`);
});
test('start: refuses a running task and a locked checkout; stop kills the group', () => {
  const r = start(P, 'T2', 'hang', [], { OC_STUB_SLEEP: '300' }); eq(r.status, 0, r.all); assert(waitRunning(P, 'T2'), 'T2 not running');
  const again = start(P, 'T2', 'hang'); eq(again.status, 3, `expected 3: ${again.all}`); assert(/already running/.test(again.all), 'msg');
  const other = start(P, 'T3', 'hang'); eq(other.status, 3, `expected lock refusal: ${other.all}`); assert(/locked by task T2/.test(other.all), 'lock msg');
  const pid = task(P, 'T2').pid; const s = run('pack-worker.mjs', ['stop', '--pack', P, '--task', 'T2', '--grace', '1']); eq(s.status, 0, s.all);
  assert(waitFor(() => !pidAlive(pid), 5000), 'stub still alive'); const t = task(P, 'T2'); eq(t.state, 'stopped', 'state'); assert(waitFor(() => fs.existsSync(path.join(P, 'tasks', 'T2', 'exit.json')), 5000), 'exit.json'); assert(/killed/.test(readJson(path.join(P, 'tasks', 'T2', 'exit.json')).reason), 'exit reason');
  assert(lockFiles().length === 0, 'lock not released after stop');
});
test('start: memory gate and peak-hour refusal', () => {
  const r = start(P, 'T3', 'ok', [], { OC_FAKE_MEM_FREE: '10' }); eq(r.status, 3, `memory gate: ${r.all}`);
  seedProbes(P, '2026-10-06T02:00:00Z');
  const p = start(P, 'T3', 'ok', ['--respect-peak'], { OC_FAKE_NOW: '2026-10-06T02:00:00Z' }); eq(p.status, 3, `peak: ${p.all}`); assert(/peak/.test(p.all), 'peak msg');
  const ok = start(P, 'T3', 'ok', [], { OC_FAKE_NOW: '2026-10-06T02:00:00Z' }); eq(ok.status, 0, ok.all); assert(/peak/.test(ok.out), 'peak note'); assert(waitExit(P, 'T3'), 'T3 exit'); seedProbes(P);
});
test('start: banner-only exit relaunches once then launch-failed', () => {
  const Q = mkPack(); addTask(Q, 'T1', brief('T1', { repo: 'repo-a', worktree: 'repo-a', files: 'src/a.ts' }));
  const r = start(Q, 'T1', 'banner-only'); eq(r.status, 4, `expected 4: ${r.all}`);
  assert(waitFor(() => task(Q, 'T1').state === 'launch-failed', 5000), 'state'); const t = task(Q, 'T1'); eq(t.attempts, 2, 'attempts'); eq(readJson(path.join(Q, 'tasks', 'T1', 'exit.json')).reason, 'banner-only', 'reason');
  assert(lockFiles().length === 0, 'lock');
});
test('instruct: queued while running, same session after exit, resume clause on dirty tree', () => {
  const r = start(P, 'T2', 'hang', [], { OC_STUB_SLEEP: '300' }); eq(r.status, 0, r.all); assert(waitRunning(P, 'T2'), 'running');
  const q = run('pack-worker.mjs', ['instruct', '--pack', P, '--task', 'T2', 'hello there']); eq(q.status, 0, q.all); assert(/queued/.test(q.out), 'queued msg'); assert(/hello there/.test(read(path.join(P, 'tasks', 'T2', 'INBOX.md'))), 'inbox'); eq(task(P, 'T2').pending_instruction, true, 'pending');
  stopTask(P, 'T2'); assert(waitExit(P, 'T2'), 'T2 exit');
  const i = run('pack-worker.mjs', ['instruct', '--pack', P, '--task', 'T1', 'again please'], { OC_STUB_MODE: 'ok', OC_STUB_ARGS_FILE: argsLog }); eq(i.status, 0, i.all); assert(/session ses_stub/.test(i.out), 'same-session msg'); assert(waitExit(P, 'T1'), 'T1 exit 2');
  const last = read(argsLog).split('ARGV:').pop(); assert(/\[--session\] \[ses_stub/.test(last), `no --session: ${last.slice(0, 200)}`);
  const resumed = JSON.parse(last.split('PERMISSION: ')[1].split('\n')[0]); eq(bashDecision(resumed.bash, 'git push origin ts/x'), 'deny', 'resumed session push'); eq(bashDecision(resumed.bash, 'gh api repos/o/r/pulls'), 'deny', 'resumed session gh api'); eq(bashDecision(resumed.bash, 'git commit -m x'), 'allow', 'resumed session commit'); eq(task(P, 'T1').attempts, 2, 'attempts'); eq(task(P, 'T1').history[1].kind, 'instruct', 'history kind');
  write(path.join(B, 'src', 'c.ts'), 'dirty\n');
  const d = run('pack-worker.mjs', ['instruct', '--pack', P, '--task', 'T2', 'carry on', '--fresh', '--allow-dirty'], { OC_STUB_MODE: 'ok', OC_STUB_ARGS_FILE: argsLog }); eq(d.status, 0, d.all); assert(/resume clause/.test(d.out), 'resume clause note'); const att = task(P, 'T2').attempts; assert(/git status/.test(read(path.join(P, 'tasks', 'T2', 'attempts', String(att), 'PROMPT.txt'))), 'prompt lacks git status'); assert(waitExit(P, 'T2'), 'T2 exit 2');
  const f = run('pack-worker.mjs', ['instruct', '--pack', P, '--task', 'T2', 'fresh', '--fresh']); eq(f.status, 3, `fresh on dirty should refuse: ${f.all}`); fs.unlinkSync(path.join(B, 'src', 'c.ts'));
  const oldSession = task(P, 'T2').session_id; assert(/^ses_stub/.test(oldSession || ''), 'T2 has a session after the ok run');
  const g = run('pack-worker.mjs', ['instruct', '--pack', P, '--task', 'T2', 'start over', '--fresh'], { OC_STUB_MODE: 'ok', OC_STUB_ARGS_FILE: argsLog }); eq(g.status, 0, g.all); assert(waitExit(P, 'T2'), 'T2 exit 3');
  const t2 = task(P, 'T2'); assert(t2.session_id && t2.session_id !== oldSession, `fresh session must replace the roster id (${oldSession} → ${t2.session_id})`); assert((t2.previous_sessions || []).includes(oldSession), 'old session kept in previous_sessions');
  assert(!/\[--session\]/.test(read(argsLog).split('ARGV:').pop()), 'fresh launch must not pass --session');
});
test('repair: cumulative per blocker, stop at 2; review: exhausted at 3', () => {
  const r1 = run('pack-worker.mjs', ['repair', '--pack', P, '--task', 'T1', '--blocker', 'B1', '--result', 'fail']); eq(r1.status, 0, r1.all); assert(/1\/2/.test(r1.out), 'count 1');
  const r2 = run('pack-worker.mjs', ['repair', '--pack', P, '--task', 'T2', '--blocker', 'B1', '--result', 'fail']); assert(/2\/2/.test(r2.out) && /STOP/.test(r2.out), `stop expected: ${r2.out}`); eq(readJson(path.join(P, 'control', 'blockers.json')).B1.stopped, true, 'stopped'); eq(task(P, 'T2').state, 'blocked', 'blocked');
  const r3 = run('pack-worker.mjs', ['repair', '--pack', P, '--task', 'T2', '--blocker', 'B1', '--result', 'pass']); eq(readJson(path.join(P, 'control', 'blockers.json')).B1.failed_repairs, 2, 'never decremented');
  const relaunch = run('pack-worker.mjs', ['instruct', '--pack', P, '--task', 'T2', 'try again'], { OC_STUB_MODE: 'ok' }); eq(relaunch.status, 3, `a blocked task must not be relaunched by instruct: ${relaunch.all}`); assert(/blocked/.test(relaunch.all), 'blocked message');
  for (let i = 0; i < 2; i++) run('pack-worker.mjs', ['review', '--pack', P, '--task', 'T1', '--result', 'changes']);
  const v = run('pack-worker.mjs', ['review', '--pack', P, '--task', 'T1', '--result', 'changes']); assert(/STOP/.test(v.out), 'review exhausted'); eq(task(P, 'T1').state, 'needs-owner', 'needs-owner'); eq(task(P, 'T1').review_round, 3, 'round');
});
test('start: launch gates refuse an unfinished dependency, a failed probe and an unapproved lock', () => {
  const Q = mkPack(); addTask(Q, 'T1', brief('T1', { repo: 'repo-a', worktree: 'repo-a', files: 'src/a.ts' })); addTask(Q, 'T2', brief('T2', { repo: 'repo-b', worktree: 'repo-b', files: 'src/a.ts', branch: 'ts/t2', needs: 'T1' }));
  eq(start(Q, 'T1', 'ok').status, 0, 'T1 start'); assert(waitExit(Q, 'T1'), 'T1 exit');
  const dep = start(Q, 'T2', 'ok'); eq(dep.status, 3, `dependency gate: ${dep.all}`); assert(/dependency T1 is not done/.test(dep.all), 'dep message');
  run('pack-worker.mjs', ['done', '--pack', Q, '--task', 'T1']);
  write(path.join(Q, 'control', 'probe-opencode-go-deepseek-v4.1-flash.json'), JSON.stringify({ model: 'opencode-go/deepseek-v4.1-flash', checked_at: new Date().toISOString(), result: 'credits' }));
  const pr = start(Q, 'T2', 'ok'); eq(pr.status, 3, `probe gate: ${pr.all}`); assert(/probe/.test(pr.all), 'probe message');
  seedProbes(Q);
  write(path.join(Q, 'tasks', 'T2', 'BRIEF.md'), brief('T2', { repo: 'repo-b', worktree: 'repo-b', files: 'src/a.ts', branch: 'ts/t2', needs: 'T1' }).replace(/^Lock:.*$/m, `Lock: .ddd-guard/ts-lock digest ${DIGEST} approved YES`));
  const lk = start(Q, 'T2', 'ok'); eq(lk.status, 3, `lock gate: ${lk.all}`); assert(/ddd-guard lock not approved/.test(lk.all), 'lock message');
  fs.mkdirSync(path.join(TMP, '.ddd-guard', 'ts-lock'), { recursive: true }); write(path.join(TMP, '.ddd-guard', 'ts-lock', 'SCOPE-LOCK.txt'), `plan: .ddd-guard/ts-lock/OWNERSHIP-PLAN.md\ndigest: ${DIGEST}\napproved: YES\n`);
  write(path.join(TMP, '.ddd-guard/ts-lock/OWNERSHIP-PLAN.md'), PLAN);
  const ok = start(Q, 'T2', 'ok'); eq(ok.status, 0, `all gates pass: ${ok.all}`); assert(waitExit(Q, 'T2'), 'T2 exit');
});
test('tail: redacts secrets; status/list run', () => {
  const Q = mkPack(); addTask(Q, 'T1', brief('T1', { repo: 'repo-a', worktree: 'repo-a', files: 'src/a.ts' }));
  eq(start(Q, 'T1', 'secret').status, 0, 'start'); assert(waitExit(Q, 'T1'), 'exit');
  const t = run('pack-worker.mjs', ['tail', '--pack', Q, '--task', 'T1']); assert(/<redacted>/.test(t.out), 'no redaction'); assert(!/abc123def456ghi789/.test(t.out), 'secret leaked');
  eq(run('pack-worker.mjs', ['status', '--pack', Q]).status, 0, 'status'); eq(run('pack-worker.mjs', ['list', '--pack', Q, '--json']).status, 0, 'list');
});
test('scope: changed files ⊆ Owns passes, stray file fails', () => {
  git(A, ['checkout', '-q', '-b', 'ts/x']); write(path.join(A, 'src', 'a.ts'), 'export const a = 2;\n'); git(A, ['commit', '-qam', 'change a']);
  const ok = run('pack-worker.mjs', ['scope', '--pack', P, '--task', 'T1']); eq(ok.status, 0, `scope pass: ${ok.all}`);
  write(path.join(A, 'src', 'zzz.ts'), 'x\n'); const bad = run('pack-worker.mjs', ['scope', '--pack', P, '--task', 'T1']); eq(bad.status, 3, 'scope fail'); assert(/src\/zzz\.ts/.test(bad.out), 'lists stray file'); fs.unlinkSync(path.join(A, 'src', 'zzz.ts'));
});
test('detach: the worker survives the parent shell exiting', () => {
  const Q = mkPack(); addTask(Q, 'T1', brief('T1', { repo: 'repo-a', worktree: 'repo-a', files: 'src/a.ts' }));
  const r = spawnSync('/bin/sh', ['-c', `"${NODE}" "${path.join(SC, 'pack-worker.mjs')}" start --pack "${Q}" --task T1 >/dev/null 2>&1; exit 0`], { encoding: 'utf8', env: { ...baseEnv, OC_STUB_MODE: 'hang', OC_STUB_SLEEP: '300' }, timeout: 20000 });
  eq(r.status, 0, 'shell'); assert(waitRunning(Q, 'T1'), 'not running'); sleepMs(1500); assert(pidAlive(task(Q, 'T1').pid), 'worker died with the parent'); stopTask(Q, 'T1');
});
test('doctor runs', () => { const r = run('pack-worker.mjs', ['doctor', '--pack', P, '--tool', 'opencode', '--json']); eq(r.status, 0, r.all); assert(JSON.parse(r.out).checks.some((c) => c.check === 'opencode' && c.ok), r.all); });

// ------------------------------------------------------------------ sweep
function sweepPack(mode, opts = {}) { const Q = mkPack(); const repo = mkRepo(`r${packN}`); addTask(Q, 'T1', brief('T1', { repo: path.basename(repo), worktree: path.basename(repo), files: 'src/a.ts' })); if (mode) { const r = start(Q, 'T1', mode, [], opts.env || {}); assert(r.status === (opts.expectStart ?? 0), `start: ${r.all}`); if (opts.waitExit) assert(waitExit(Q, 'T1'), 'exit'); if (opts.waitRunning) assert(waitRunning(Q, 'T1'), 'running'); } return { Q, repo }; }
test('sweep: empty pack is quiet and stamps CURRENT.md', () => {
  const Q = mkPack(); const r = sweepJson(Q); eq(r.status, 0, r.all); assert(/last_sweep: 2/.test(read(path.join(Q, 'control', 'CURRENT.md'))), 'no last_sweep line'); eq(read(path.join(Q, 'control', 'sweep-log.jsonl')).trim().split('\n').length, 1, 'log line');
});
test('sweep: running-healthy, then running-stale with a stable escalation id and --changed-only', () => {
  const { Q } = sweepPack('hang', { env: { OC_STUB_SLEEP: '300' }, waitRunning: true });
  let r = sweepJson(Q); eq(r.status, 0, r.all); eq(r.j.tasks[0].class, 'running-healthy', 'healthy');
  const old = new Date(Date.now() - 30 * 60000); fs.utimesSync(path.join(Q, 'tasks', 'T1', 'run.jsonl'), old, old);
  const ro = roster(Q); ro.tasks[0].started_at = old.toISOString(); fs.writeFileSync(path.join(Q, 'control', 'roster.json'), JSON.stringify(ro));
  r = sweepJson(Q); eq(r.status, 10, `stale → 10: ${r.all}`); eq(r.j.tasks[0].class, 'running-stale', 'stale'); eq(r.j.escalations[0].to, 'orchestrator', 'route'); eq(r.j.escalations[0].id, 'E-TS-001', 'id');
  const md = read(path.join(Q, 'control', 'ESCALATIONS.md')); assert(/E-TS-001 · T1 · running-stale · to: orchestrator/.test(md), 'packet header'); assert(/Answer here/.test(md), 'answer line');
  const r2 = sweepJson(Q); eq(r2.j.escalations[0].id, 'E-TS-001', 'stable id'); eq(r2.status, 10, 'still 10 without --changed-only');
  eq(sweepJson(Q, ['--changed-only']).status, 10, 'changed-only stays 10 while unacknowledged'); run('pack-worker.mjs', ['ack', '--pack', Q, '--escalation', 'E-TS-001']); const r3 = sweepJson(Q, ['--changed-only']); eq(r3.status, 0, 'changed-only quiet once acknowledged'); const t = task(Q, 'T1'); eq(t.escalation_id, 'E-TS-001', 'roster escalation id'); eq(t.last_sweep_class, 'running-stale', 'roster class');
  stopTask(Q, 'T1');
});
test('sweep: exited with report → needs-review (no packet); missing output flagged; no report → escalation', () => {
  const { Q } = sweepPack('ok', { waitExit: true });
  let r = sweepJson(Q); eq(r.status, 10, 'no report → 10'); eq(r.j.tasks[0].class, 'exited-no-report', 'class'); eq(r.j.escalations[0].to, 'orchestrator', 'route');
  setStatus(Q, 'T1', { state: 'needs-review' }); write(path.join(Q, 'tasks', 'T1', 'REPORT.md'), '# T1 report\n\n1. a\n2. b\n3. c\n\n## Tests\nall fine\n');
  r = sweepJson(Q); eq(r.status, 10, `needs-review is routine work, exit 10: ${r.all}`); eq(r.j.tasks[0].class, 'exited-ok-needs-review', 'class'); assert(r.j.tasks[0].flags.includes('report-missing-test-output'), 'flag');
  const act = r.j.escalations.find((e) => e.class === 'exited-ok-needs-review'); assert(act && act.kind === 'action' && act.to === 'orchestrator', `action item: ${JSON.stringify(r.j.escalations)}`); assert(/Needs routine action/.test(read(path.join(Q, 'control', 'ESCALATIONS.md'))), 'action section');
  eq(readJson(path.join(Q, 'control', 'escalations.json')).items.find((e) => e.class === 'exited-no-report').status, 'resolved', 'no-report item resolved');
  write(path.join(Q, 'tasks', 'T1', 'REPORT.md'), goodReport('T1')); r = sweepJson(Q); assert(!r.j.tasks[0].flags.includes('report-missing-test-output'), 'flag cleared');
  const co = sweepJson(Q, ['--changed-only']); eq(co.status, 10, 'unacknowledged item keeps --changed-only at 10');
  const ack = run('pack-worker.mjs', ['ack', '--pack', Q, '--escalation', act.id, '--note', 'reviewing']); eq(ack.status, 0, ack.all);
  const co2 = sweepJson(Q, ['--changed-only']); eq(co2.status, 0, 'acknowledged item makes --changed-only quiet'); eq(sweepJson(Q).status, 10, 'plain sweep still reports the open item');
  run('pack-worker.mjs', ['review', '--pack', Q, '--task', 'T1', '--result', 'pass']); r = sweepJson(Q); eq(r.j.tasks[0].class, 'done', 'done after review pass'); eq(r.status, 0, 'quiet when done');
});
test('sweep: a never-started task is ready-to-start once its dependencies are done', () => {
  const Q = mkPack(); addTask(Q, 'T1', brief('T1', { repo: 'repo-a', worktree: 'repo-a', files: 'src/a.ts' })); addTask(Q, 'T2', brief('T2', { repo: 'repo-b', worktree: 'repo-b', files: 'src/a.ts', branch: 'ts/t2', needs: 'T1' }));
  let r = sweepJson(Q); eq(r.status, 10, r.all); const t1 = r.j.tasks.find((t) => t.id === 'T1'), t2 = r.j.tasks.find((t) => t.id === 'T2');
  eq(t1.class, 'ready-to-start', 'T1 ready'); eq(t1.kind, 'action', 'action kind'); eq(t2.class, 'queued', 'T2 waits for T1');
  eq(start(Q, 'T1', 'ok').status, 0, 'start T1'); assert(waitExit(Q, 'T1'), 'exit'); run('pack-worker.mjs', ['done', '--pack', Q, '--task', 'T1']);
  r = sweepJson(Q); eq(r.j.tasks.find((t) => t.id === 'T2').class, 'ready-to-start', 'T2 ready after T1 done'); eq(r.j.tasks.find((t) => t.id === 'T1').class, 'done', 'T1 done');
});
test('sweep: blocked routes to senior, setup blocker to orchestrator', () => {
  const { Q } = sweepPack('ok', { waitExit: true });
  setStatus(Q, 'T1', { state: 'blocked', blocker: 'B9 (2/2)' }); let r = sweepJson(Q); eq(r.j.tasks[0].class, 'blocked', 'class'); eq(r.j.escalations[0].to, 'senior', 'senior');
  setStatus(Q, 'T1', { state: 'blocked', blocker: 'setup NM (2/2)' }); r = sweepJson(Q); eq(r.j.tasks[0].class, 'blocked', 'class'); eq(r.j.escalations[0].to, 'orchestrator', 'setup → orchestrator');
});
test('sweep: open question → needs-senior; [owner] tag → owner; answered question resolves', () => {
  const { Q } = sweepPack('ok', { waitExit: true }); setStatus(Q, 'T1', { state: 'needs-review' }); write(path.join(Q, 'tasks', 'T1', 'REPORT.md'), goodReport('T1'));
  write(path.join(Q, 'tasks', 'T1', 'QUESTIONS.md'), '# T1 questions\n## Q-TS-T1-001 Which DTO shape?\n- why: two exist\n- options: (a) old (b) new\n- recommendation: (b)\n- blocks: step 2\n');
  let r = sweepJson(Q); eq(r.status, 10, 'escalate'); eq(r.j.tasks[0].class, 'needs-senior', 'class'); eq(r.j.escalations[0].to, 'senior', 'senior'); assert(/Q-TS-T1-001/.test(read(path.join(Q, 'control', 'ESCALATIONS.md'))), 'packet names the question');
  write(path.join(Q, 'tasks', 'T1', 'QUESTIONS.md'), '# T1 questions\n## Q-TS-T1-001 Which DTO shape? [owner]\n- why\n'); r = sweepJson(Q); eq(r.j.escalations[0].to, 'owner', 'owner tag');
  fs.appendFileSync(path.join(Q, 'tasks', 'T1', 'QUESTIONS.md'), '**A (consultant test, 10:00):** use the new one\n'); r = sweepJson(Q); eq(r.j.tasks[0].class, 'exited-ok-needs-review', 'back to review'); assert(r.j.escalations.every((e) => e.kind === 'action'), 'only the routine review item stays open');
  const items = readJson(path.join(Q, 'control', 'escalations.json')).items; assert(items.filter((i) => i.class === 'needs-senior').every((i) => i.status === 'resolved'), 'question items resolved'); assert(items.some((i) => i.answer_first_line && /use the new one/.test(i.answer_first_line)), 'answer recorded');
});
test('sweep: out-of-scope writes, doom loops, launch-failed, probe-failed', () => {
  const { Q, repo } = sweepPack('ok', { waitExit: true }); write(path.join(repo, 'src', 'stray.ts'), 'x\n');
  let r = sweepJson(Q); eq(r.j.tasks[0].class, 'out-of-scope-writes', 'scope class'); eq(r.j.escalations[0].to, 'orchestrator', 'route'); assert(/stray\.ts/.test(read(path.join(Q, 'control', 'ESCALATIONS.md'))), 'names the file');
  const d = sweepPack('doomloop', { env: { OC_STUB_SLEEP: '30' }, waitRunning: true }); sleepMs(800); r = sweepJson(d.Q); eq(r.j.tasks[0].class, 'doom-loop', `doom identical: ${JSON.stringify(r.j.tasks[0])}`); stopTask(d.Q, 'T1'); assert(waitExit(d.Q, 'T1'), 'doom stopped');
  const re = run('pack-worker.mjs', ['instruct', '--pack', d.Q, '--task', 'T1', 'try a different approach', '--fresh', '--allow-dirty'], { OC_STUB_MODE: 'hang', OC_STUB_SLEEP: '300' }); eq(re.status, 0, re.all); assert(waitRunning(d.Q, 'T1'), 'restarted'); sleepMs(500);
  r = sweepJson(d.Q); eq(r.j.tasks[0].class, 'running-healthy', `a restarted worker must not inherit the old attempt's loop: ${JSON.stringify(r.j.tasks[0])}`); stopTask(d.Q, 'T1');
  const c = sweepPack('chatloop', { env: { OC_STUB_SLEEP: '30' }, waitRunning: true }); sleepMs(800); r = sweepJson(c.Q); eq(r.j.tasks[0].class, 'doom-loop', 'doom chat'); stopTask(c.Q, 'T1');
  const l = sweepPack('banner-only', { expectStart: 4 }); waitFor(() => task(l.Q, 'T1').state === 'launch-failed', 5000); r = sweepJson(l.Q); eq(r.j.tasks[0].class, 'launch-failed', 'launch-failed'); eq(r.j.escalations[0].to, 'orchestrator', 'route');
  const p = sweepPack('ok', { waitExit: true }); write(path.join(p.Q, 'control', 'probe-opencode-go-deepseek-v4.1-flash.json'), JSON.stringify({ model: 'opencode-go/deepseek-v4.1-flash', checked_at: new Date().toISOString(), result: 'credits', excerpt: 'You have run out of credits' })); r = sweepJson(p.Q); eq(r.j.tasks[0].class, 'probe-failed', 'probe class'); eq(r.j.escalations[0].to, 'owner', 'owner route'); assert(/credits/.test(read(path.join(p.Q, 'control', 'ESCALATIONS.md'))), 'credits question');
});
test('sweep: loose STATUS flag, orphaned lock flag, CURRENT.md prose untouched, coverage gap, speed', () => {
  const { Q, repo } = sweepPack('ok', { waitExit: true });
  write(path.join(Q, 'tasks', 'T1', 'STATUS.md'), `# T1\nstate: needs-review  updated: ${new Date().toISOString()}\n`); write(path.join(Q, 'tasks', 'T1', 'REPORT.md'), goodReport('T1'));
  write(path.join(TMP, '.agent-workpacks', 'locks', sha1(fs.realpathSync(repo)).slice(0, 12)), JSON.stringify({ task: 'T1', pack: Q, pid: 999999, supervisor_pid: 999998 }));
  const cur = path.join(Q, 'control', 'CURRENT.md'); write(cur, read(cur).replace('Phase: planning', 'Phase: prose the owner wrote'));
  fs.appendFileSync(path.join(Q, 'control', 'sweep-log.jsonl'), JSON.stringify({ ts: new Date(Date.now() - 70 * 60000).toISOString(), exit: 0 }) + '\n');
  const before = read(cur); const r = sweepJson(Q); eq(r.status, 10, 'needs-review is an action item'); eq(r.j.tasks[0].class, 'exited-ok-needs-review', 'class'); assert(r.j.tasks[0].flags.includes('status-loose'), 'loose flag'); assert(r.j.tasks[0].flags.includes('lock-orphaned'), 'orphan flag'); eq(r.j.coverage_gap, true, 'coverage gap'); assert(r.j.duration_ms < 2000, `slow sweep ${r.j.duration_ms}ms`);
  const after = read(cur); const strip = (s) => s.replace(/^last_sweep:.*$/m, '').replace(/<!-- tasks:begin -->[\s\S]*?<!-- tasks:end -->/, ''); eq(strip(after), strip(before), 'prose changed'); assert(/Phase: prose the owner wrote/.test(after), 'owner prose lost'); assert(/COVERAGE GAP/.test(after), 'gap not surfaced');
});

// ------------------------------------------------------------------ probe
test('probe: ok / credits / bad-model / connect / timeout exit codes and record', () => {
  const Q = mkPack();
  const probe = (mode, extra = [], env = {}) => run('pack-probe.mjs', ['--pack', Q, '--model', 'opencode-go/deepseek-v4.1-flash', '--json', ...extra], { OC_STUB_MODE: mode, ...env }, 60000);
  let r = probe('ok'); eq(r.status, 0, `ok: ${r.all}`); let j = JSON.parse(r.out); eq(j.results[0].result, 'ok', 'result'); assert(/^ses_stub/.test(j.results[0].session_id || ''), 'session'); eq(readJson(path.join(Q, 'control', 'probe-opencode-go-deepseek-v4.1-flash.json')).result, 'ok', 'record');
  r = probe('credits'); eq(r.status, 21, `credits: ${r.all}`); r = probe('badmodel'); eq(r.status, 22, `badmodel: ${r.all}`); r = probe('error'); eq(r.status, 23, `connect: ${r.all}`);
  r = probe('hang', ['--timeout', '2'], { OC_STUB_SLEEP: '300' }); eq(r.status, 24, `timeout: ${r.all}`);
  r = probe('ok', [], { OC_FAKE_NOW: '2026-10-06T02:00:00Z' }); j = JSON.parse(r.out); eq(j.deepseek_peak, true, 'peak flag');
});

// ------------------------------------------------------------------ reliability regressions / offline lifecycle canary
const probePath = (p) => path.join(p, 'control/probe-opencode-go-deepseek-v4.1-flash.json');
const instruct = (p, id, extra = [], env = {}) => run('pack-worker.mjs', ['instruct', '--pack', p, '--task', id, 'apply the correction', ...extra], { OC_STUB_MODE:'ok', ...env });
const ack = (p, id) => run('pack-worker.mjs', ['ack', '--pack', p, '--escalation', id]);
test('regression: only a matching fresh failed probe blocks a normal start', () => {
  const Q=mkPack(); addTask(Q,'T1',brief('T1',{repo:'repo-a',worktree:'never-create',files:'src/a.ts'}));
  const allowed=[null, '{broken', {}, {model:'other',result:'credits',checked_at:new Date().toISOString()}, {model:'opencode-go/deepseek-v4.1-flash',result:'ok',checked_at:'invalid'}, {model:'opencode-go/deepseek-v4.1-flash',result:'credits',checked_at:'2020-01-01'}];
  for(const record of allowed){ if(record===null) fs.rmSync(probePath(Q),{force:true}); else write(probePath(Q), typeof record==='string'?record:JSON.stringify(record)); const r=start(Q,'T1','ok',['--dry-run']); eq(r.status,0,r.all); assert(!fs.existsSync(path.join(TMP,'never-create')),'dry run created worktree'); assert(!fs.existsSync(path.join(Q,'tasks/T1/PROMPT.txt')),'dry run created launch artifact'); }
  write(probePath(Q),JSON.stringify({model:'opencode-go/deepseek-v4.1-flash',result:'credits',checked_at:new Date().toISOString()}));
  const refused=start(Q,'T1','ok');eq(refused.status,3,refused.all);assert(/probe/.test(refused.all),refused.all);assert(!fs.existsSync(path.join(TMP,'never-create')),'failed probe created worktree');assert(!fs.existsSync(path.join(Q,'tasks/T1/PROMPT.txt')),'failed probe created launch artifact');
});
test('regression: DDD digest and plan changes cannot be forced; resource overrides are logged',()=>{
  const Q=mkPack(); const bp=path.join(Q,'tasks/T1/BRIEF.md'); const md=brief('T1',{repo:'repo-a',worktree:'repo-a',files:'src/a.ts'}); addTask(Q,'T1',md);
  write(bp,md.replace(DIGEST,'0'.repeat(64))); let r=start(Q,'T1','ok',['--force','--reason','test']); eq(r.status,3,r.all); assert(/digests differ/.test(r.all),r.all);
  write(bp,md); const plan=path.join(TMP,'.ddd-guard/fixture/OWNERSHIP-PLAN.md'); write(plan,PLAN+'changed'); r=start(Q,'T1','ok',['--force','--reason','test']); write(plan,PLAN); eq(r.status,3,r.all); assert(/plan hash/.test(r.all),r.all);
  r=start(Q,'T1','ok',['--force'],{OC_FAKE_MEM_FREE:'1'}); eq(r.status,3,r.all);
  r=start(Q,'T1','ok',['--force','--reason','bounded offline canary'],{OC_FAKE_MEM_FREE:'1'}); eq(r.status,0,r.all); assert(waitExit(Q,'T1'),'exit'); assert(/memory gate overridden: bounded offline canary/.test(read(path.join(Q,'LEDGER.md'))),'override missing');
  fs.unlinkSync(probePath(Q)); r=instruct(Q,'T1'); eq(r.status,0,r.all); assert(waitExit(Q,'T1'),'probe-free correction exit');
  const rr=roster(Q); rr.tasks[0].review_round=3; write(path.join(Q,'control/roster.json'),JSON.stringify(rr)); r=instruct(Q,'T1',['--force','--reason','test']); eq(r.status,3,r.all); assert(/exhausted/.test(r.all),r.all);
});
test('regression: force cannot bypass dependencies or repair allowance; capacity override is recorded',()=>{
 const Q=mkPack();const bp=path.join(Q,'tasks/T1/BRIEF.md');const md=brief('T1',{repo:'repo-a',worktree:'repo-a',files:'src/a.ts'});addTask(Q,'T1',md.replace('Needs first: none','Needs first: T2'));
 let r=start(Q,'T1','ok',['--force','--reason','test']);eq(r.status,3,r.all);assert(/dependency/.test(r.all),r.all);write(bp,md);
 const cfgFile=path.join(Q,'control/config.json');const cfg=readJson(cfgFile);cfg.limits.max_workers=1;write(cfgFile,JSON.stringify(cfg));const rr=roster(Q);rr.tasks.push({id:'BUSY',state:'running'});write(path.join(Q,'control/roster.json'),JSON.stringify(rr));
 r=start(Q,'T1','ok');eq(r.status,3,r.all);assert(/worker cap/.test(r.all),r.all);r=start(Q,'T1','ok',['--force','--reason','bounded capacity test']);eq(r.status,0,r.all);assert(waitExit(Q,'T1'),'exit');assert(/worker cap overridden: bounded capacity test/.test(read(path.join(Q,'LEDGER.md'))),'cap reason missing');
 setStatus(Q,'T1',{state:'running',blocker:'setup NM (2/2)'});r=instruct(Q,'T1',['--force','--reason','test']);eq(r.status,3,r.all);assert(/blocked/.test(r.all),r.all);
});
test('regression: brief acceptance archives prose revisions and refuses assignment changes',()=>{
  const Q=mkPack(); const bp=path.join(Q,'tasks/T1/BRIEF.md'); const md=brief('T1',{repo:'repo-a',worktree:'repo-a',files:'src/a.ts'}); addTask(Q,'T1',md); eq(start(Q,'T1','ok').status,0,'start'); assert(waitExit(Q,'T1'),'exit');
  for(const changed of [md.replace('src/a.ts','src/b.ts'),md.replace('Needs first: none','Needs first: T2')]){write(bp,changed); const r=instruct(Q,'T1',['--accept-brief-change']); eq(r.status,3,r.all); assert(/contract/.test(r.all),r.all);}
  write(bp,md.replace('Do the one thing.','<fill: implementation>')); const bad=instruct(Q,'T1',['--accept-brief-change']); eq(bad.status,3,bad.all); assert(/lint/.test(bad.all),bad.all);
  write(bp,''); eq(instruct(Q,'T1').status,3,'empty'); fs.unlinkSync(bp); eq(instruct(Q,'T1').status,3,'missing');
  write(bp,md.replace('Do the one thing.','Do the one thing; include the evidence.')); eq(instruct(Q,'T1').status,3,'unaccepted'); let r=instruct(Q,'T1',['--accept-brief-change']); eq(r.status,0,r.all); assert(waitExit(Q,'T1'),'revision exit'); eq(read(path.join(Q,'tasks/T1/brief-versions',sha256(md)+'.md')),md,'old version archive'); assert(/assignment-neutral brief revision/.test(read(path.join(Q,'LEDGER.md'))),'acceptance ledger');
  const rr=roster(Q); delete rr.tasks[0].launch_contract; delete rr.tasks[0].brief_snapshot; write(path.join(Q,'control/roster.json'),JSON.stringify(rr)); r=instruct(Q,'T1'); eq(r.status,0,r.all); assert(waitExit(Q,'T1'),'legacy unchanged'); fs.appendFileSync(bp,'\nExtra context.\n'); r=instruct(Q,'T1',['--accept-brief-change']); eq(r.status,3,r.all); assert(/legacy/.test(r.all),r.all);
});
test('regression: changed running brief cannot queue instructions',()=>{
  const Q=mkPack();addTask(Q,'T1',brief('T1',{repo:'repo-a',worktree:'repo-a',files:'src/a.ts'})); eq(start(Q,'T1','hang',[],{OC_STUB_SLEEP:'300'}).status,0,'start');
  try {fs.appendFileSync(path.join(Q,'tasks/T1/BRIEF.md'),'\nMore context\n'); const r=instruct(Q,'T1'); eq(r.status,3,r.all); assert(!read(path.join(Q,'tasks/T1/INBOX.md')).includes('apply the correction'),'queued changed brief');} finally{stopTask(Q,'T1');}
});
test('regression: overlapping glob patterns report both entries',()=>{
 const Q=mkPack();for(const [id,files] of [['T1','src/*.ts'],['T2','src/a*']])addTask(Q,id,brief(id,{repo:'repo-a',worktree:'repo-a',files})); const r=run('pack-lint.mjs',[Q]);eq(r.status,4,r.all);assert(r.out.includes('src/*.ts')&&r.out.includes('src/a*'),'conflict entries absent');
});
test('regression: recovery excludes historical provider errors in both streams',()=>{
 for(const mode of ['credits','auth','error']){const Q=mkPack();addTask(Q,'T1',brief('T1',{repo:'repo-a',worktree:'repo-a',files:'src/a.ts'})); start(Q,'T1',mode);assert(waitExit(Q,'T1'),'failed attempt exit');eq(sweepJson(Q).j.tasks[0].class,'probe-failed','failure surfaced');
 const r=instruct(Q,'T1',['--fresh']);eq(r.status,0,r.all);assert(waitExit(Q,'T1'),'recovered exit');setStatus(Q,'T1',{state:'needs-review'});write(path.join(Q,'tasks/T1/REPORT.md'),goodReport('T1'));eq(sweepJson(Q).j.tasks[0].class,'exited-ok-needs-review','historical error leaked');const t=task(Q,'T1');assert(t.history[1].stdout_start>0&&t.history[1].stderr_start>0,'offsets missing');const st=run('pack-worker.mjs',['status','--pack',Q,'--json']);eq(JSON.parse(st.out).tasks[0].tool_calls,1,'status current attempt');assert(readJson(path.join(Q,'control/escalations.json')).items.some(x=>x.class==='probe-failed'&&x.status==='resolved'),'history not resolved');}
});
test('regression: acknowledgment waits for the sweep mutex and preserves its update',()=>{
 const Q=mkPack();addTask(Q,'T1',brief('T1',{repo:'repo-a',worktree:'repo-a',files:'src/a.ts'}));const sw=sweepJson(Q);const id=sw.j.escalations[0].id;
 const lock=path.join(Q,'control/locks/sweep.lock');const file=path.join(Q,'control/escalations.json');const ready=path.join(Q,'control/holder-ready');
 const code=`import fs from 'node:fs';import {withLock,sleepMs,readJson,atomicWriteJson} from ${JSON.stringify(path.join(SC,'lib/paths.mjs'))};withLock(${JSON.stringify(lock)},()=>{const state=readJson(${JSON.stringify(file)});fs.writeFileSync(${JSON.stringify(ready)},'ready');sleepMs(800);state.test_sweep_update=true;atomicWriteJson(${JSON.stringify(file)},state);});`;
 const holder=spawn(NODE,['--input-type=module','-e',code],{stdio:'ignore'});
 try{assert(waitFor(()=>fs.existsSync(ready),4000,20),'holder failed');eq(ack(Q,id).status,0,'ack failed');assert(waitFor(()=>readJson(file).test_sweep_update,4000,20),'sweep update absent');const final=readJson(file);assert(final.items.find(x=>x.id===id).acked_at,'ack lost to concurrent sweep');eq(sweepJson(Q,['--changed-only']).status,0,'ack not retained');}finally{try{holder.kill();}catch{}}
});
test('regression: elapsed age does not reopen acknowledged stale alert',()=>{
 const Q=mkPack();addTask(Q,'T1',brief('T1',{repo:'repo-a',worktree:'repo-a',files:'src/a.ts'}));eq(start(Q,'T1','hang',[],{OC_STUB_SLEEP:'300'}).status,0,'start');
 try {const future=new Date(Date.now()+40*60000);let r=sweepJson(Q,['--changed-only'],{OC_FAKE_NOW:future.toISOString()});eq(r.j.tasks[0].class,'running-stale',r.all);const id=r.j.escalations[0].id;eq(ack(Q,id).status,0,'ack');r=sweepJson(Q,['--changed-only'],{OC_FAKE_NOW:new Date(future.getTime()+60000).toISOString()});eq(r.status,0,r.all);eq(r.j.escalations[0].id,id,'identity changed');}finally{stopTask(Q,'T1');}
});
test('canary: two independent handbacks, same-session correction, dependency and fresh recovery',()=>{
 const Q=mkPack();const repo1=mkRepo('canary-a'),repo2=mkRepo('canary-b');
 for(const [id,repo,files,needs] of [['T1',repo1,'src/a.ts','none'],['T2',repo2,'src/a.ts','none'],['T3',repo1,'src/b.ts','T1, T2']])addTask(Q,id,brief(id,{repo,worktree:repo,files,needs}));
 write(path.join(Q,'PLAN.md'),'# Canary\n| ID | Task |\n|---|---|\n| T1 | First |\n| T2 | Second |\n| T3 | Dependent |\n');
 for(const name of ['START-HERE.md','GOAL.md','PLAN.md','CONTEXT.md','RULES.md']){const f=path.join(Q,name);const md=read(f).replace(/<[^>\n]*>/g,'canary');write(f,md);}
 const lint=run('pack-lint.mjs',[Q]);eq(lint.status,0,lint.all);
 for(const id of ['T1','T2']){let r=start(Q,id,'ok',['--dry-run']);eq(r.status,0,r.all);assert(!task(Q,id),'dry-run wrote roster');r=start(Q,id,'ok',[],{OC_STUB_SLEEP:'2'});eq(r.status,0,r.all);}
 assert(waitRunning(Q,'T1')&&waitRunning(Q,'T2'),'independent workers not concurrent');
 for(const id of ['T1','T2']){assert(waitExit(Q,id),'exit '+id);setStatus(Q,id,{state:'needs-review'});write(path.join(Q,'tasks',id,'REPORT.md'),goodReport(id));}
 let sw=sweepJson(Q,['--changed-only']);eq(sw.status,10,sw.all);const item=sw.j.escalations.find(x=>x.task==='T1');assert(item,'T1 review absent');for(const e of sw.j.escalations)eq(ack(Q,e.id).status,0,'ack');eq(sweepJson(Q,['--changed-only']).status,0,'ack quiet');
 eq(run('pack-worker.mjs',['review','--pack',Q,'--task','T1','--result','changes']).status,0,'review changes');const sid=task(Q,'T1').session_id;const r=instruct(Q,'T1');eq(r.status,0,r.all);assert(waitExit(Q,'T1'),'correction exit');eq(task(Q,'T1').session_id,sid,'session changed');setStatus(Q,'T1',{state:'needs-review'});
 sw=sweepJson(Q,['--changed-only']);eq(sw.status,10,sw.all);const replacement=sw.j.escalations.find(x=>x.task==='T1');assert(replacement.id!==item.id&&!replacement.acked,'new handback silenced');assert(readJson(path.join(Q,'control/escalations.json')).items.some(x=>x.id===item.id&&x.status==='resolved'),'old review lost');
 for(const id of ['T1','T2']){eq(run('pack-worker.mjs',['review','--pack',Q,'--task',id,'--result','pass']).status,0,'review pass');eq(run('pack-worker.mjs',['done','--pack',Q,'--task',id]).status,0,'done');}
 sw=sweepJson(Q,['--changed-only']);eq(sw.j.tasks.find(x=>x.id==='T3').class,'ready-to-start','dependency readiness');eq(start(Q,'T3','ok').status,0,'dependent start');assert(waitExit(Q,'T3'),'dependent exit');const fresh=run('pack-worker.mjs',['status','--pack',Q,'--json']);eq(fresh.status,0,fresh.all);const rows=JSON.parse(fresh.out).tasks;eq(rows.length,3,'fresh recovery task count');eq(rows.find(x=>x.id==='T1').session_id,sid,'fresh recovery session');eq(rows.find(x=>x.id==='T1').attempts,2,'fresh recovery attempts');
});

test('regression: legacy markers exclude historical sessions and stderr errors',()=>{
 const dir=path.join(TMP,'legacy-logs');const event=(sid)=>JSON.stringify({type:'step_start',timestamp:Date.now(),sessionID:sid,part:{type:'step-start'}});
 write(path.join(dir,'run.jsonl'),event('ses_old')+'\n'+attemptMarkerLine(2,'instruct',null)+'\n'+event('ses_new')+'\n');write(path.join(dir,'launch.log'),'Unauthorized 401\n===== LAUNCH current attempt=2 =====\n');
 const d=attemptDiagnostics(dir,{history:[{n:2}]});eq(summarize(d.events).sessionID,'ses_new','legacy session');eq(classifyProviderError(d.raw),null,'legacy stderr');
 const offsets={stdout_start:fs.statSync(path.join(dir,'run.jsonl')).size,stderr_start:fs.statSync(path.join(dir,'launch.log')).size};eq(summarize(attemptDiagnostics(dir,offsets).events).sessionID,null,'new silent attempt inherited a session');
});
// ------------------------------------------------------------------ Claude-senior waiter (pack-watch wait)
// Recorder stubs prove the waiter never runs codex and raises no notification unless --notify is passed.
const recorder = (name) => { const marker = path.join(TMP, `${name}.called`); const bin = path.join(TMP, 'stub-bin', name); write(bin, `#!/bin/sh\necho "$*" >> "${marker}"\nexit 0\n`); fs.chmodSync(bin, 0o755); return { bin, marker }; };
const CODEX_REC = recorder('codex'), OSA_REC = recorder('osascript');
const waitEnv = { CODEX_BIN: CODEX_REC.bin, DP_OSASCRIPT_BIN: OSA_REC.bin, DP_NO_NOTIFY: '', DP_WATCH_NO_INSTALL: '1' };
const waitRun = (pack, extra = [], env = {}) => { const r = run('pack-watch.mjs', ['wait', '--pack', pack, ...extra], { ...waitEnv, ...env }); const lines = r.out.trim().split('\n').filter(Boolean); let ev = null; try { ev = JSON.parse(lines.at(-1)); } catch {} return { ...r, lines, ev }; };
// Runs the waiter while a background shell edits a file one second later; spawnSync returns the waiter's own exit.
const waitWhile = (pack, edit, extra) => { const r = spawnSync('/bin/sh', ['-c', `(sleep 1; ${edit}) >/dev/null 2>&1 & exec "$DP_TEST_NODE" "$DP_TEST_WATCH" wait --pack "$DP_TEST_PACK" ${extra}`], { encoding: 'utf8', timeout: 40000, env: { ...baseEnv, ...waitEnv, DP_TEST_NODE: NODE, DP_TEST_WATCH: path.join(SC, 'pack-watch.mjs'), DP_TEST_PACK: pack } }); let ev = null; try { ev = JSON.parse((r.stdout || '').trim()); } catch {} return { status: r.status, ev, all: (r.stdout || '') + (r.stderr || '') }; };
test('watch wait: unacknowledged item → exit 10 with one JSON line; acked → heartbeat at the timeout; no codex, no notification', () => {
  const Q = mkPack(); addTask(Q, 'T1', brief('T1', { repo: 'repo-a', worktree: 'repo-a', files: 'src/a.ts' }));
  let r = waitRun(Q, ['--interval-sec', '0.2', '--timeout-min', '0.05']);
  eq(r.status, 10, r.all); eq(r.lines.length, 1, 'one compact JSON line'); eq(r.ev.event, 'action', 'event'); eq(r.ev.items.length, 1, 'items');
  eq(r.ev.items[0].task, 'T1', 'task'); eq(r.ev.items[0].class, 'ready-to-start', 'class'); eq(r.ev.items[0].to, 'orchestrator', 'route'); assert(/^E-TS-\d{3}$/.test(r.ev.items[0].id), `escalation id ${r.ev.items[0].id}`);
  eq(waitRun(Q, ['--interval-sec', '0.2', '--timeout-min', '0.05']).status, 10, 're-arming without an ack wakes again');
  eq(ack(Q, r.ev.items[0].id).status, 0, 'ack');
  const sweepsBefore = read(path.join(Q, 'control', 'sweep-log.jsonl')).trim().split('\n').length;
  const t0 = Date.now(); r = waitRun(Q, ['--interval-sec', '0.2', '--timeout-min', '0.02']); const took = Date.now() - t0;
  eq(r.status, 0, r.all); eq(r.out.trim(), '{"event":"heartbeat"}', 'heartbeat line'); assert(took >= 1000 && took < 20000, `timeout honoured (${took} ms)`);
  assert(read(path.join(Q, 'control', 'sweep-log.jsonl')).trim().split('\n').length - sweepsBefore >= 2, 'the waiter swept on its interval');
  assert(!fs.existsSync(CODEX_REC.marker), 'the waiter ran codex'); assert(!fs.existsSync(OSA_REC.marker), 'a notification was raised without --notify');
});
test('watch wait: an --also-watch file that changes or appears → exit 11; a sweep-written file is refused', () => {
  const Q = mkPack(); const lane = path.join(Q, 'control', 'lane-results.jsonl'); write(lane, '{"run":1}\n'); const later = path.join(Q, 'control', 'later.jsonl');
  const t0 = Date.now(); let r = waitWhile(Q, `printf '{"run":2}\\n' >> "${lane}"`, `--interval-sec 0.3 --timeout-min 0.5 --also-watch "${later}" --also-watch "${lane}"`); const took = Date.now() - t0;
  eq(r.status, 11, r.all); eq(r.ev?.event, 'file', 'event'); eq(r.ev.path, lane, 'path'); assert(took < 15000, `file change seen late (${took} ms)`);
  r = waitWhile(Q, `: > "${later}"`, `--interval-sec 0.3 --timeout-min 0.5 --also-watch "${later}"`); eq(r.status, 11, r.all); eq(r.ev?.path, later, 'created file');
  r = waitRun(Q, ['--also-watch', path.join(Q, 'control', 'CURRENT.md')]); eq(r.status, 2, r.all); eq(r.ev?.event, 'error', 'self-trigger refused'); assert(/rewritten by every sweep/.test(r.ev.error), r.ev.error);
});
test('watch wait: errors print one JSON error line and exit 2; --notify is opt-in', () => {
  let r = waitRun(path.join(TMP, 'not-a-pack')); eq(r.status, 2, r.all); eq(r.ev?.event, 'error', 'not a pack'); eq(r.lines.length, 1, 'one line');
  const Q = mkPack(); r = waitRun(Q, ['--interval-sec', 'soon']); eq(r.status, 2, r.all); assert(/interval-sec/.test(r.ev?.error || ''), 'bad interval');
  r = waitRun(Q, ['--interval-sec', '0.2', '--timeout-min', '0.05', '--notify'], { DP_NODE_BIN: '/usr/bin/false' }); eq(r.status, 2, r.all); eq(r.ev?.event, 'error', 'sweep failure'); assert(/sweep failed/.test(r.ev.error), r.ev.error);
  assert(fs.existsSync(OSA_REC.marker), '--notify did not notify'); assert(!fs.existsSync(CODEX_REC.marker), 'the waiter ran codex');
});
// ------------------------------------------------------------------ cleanup
for (const d of fs.readdirSync(TMP)) { const rf = path.join(TMP, d, 'control', 'roster.json'); if (fs.existsSync(rf)) for (const t of readJson(rf, { tasks: [] }).tasks) { for (const pid of [t.pid, t.supervisor_pid]) if (pid && pidAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch {} try { process.kill(pid, 'SIGKILL'); } catch {} } } }
if (!args.keep) fs.rmSync(TMP, { recursive: true, force: true }); else console.log(`kept ${TMP}`);
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
