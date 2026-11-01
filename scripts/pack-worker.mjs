#!/usr/bin/env node
// Controller for agent-workpacks workers: start | instruct | status | list | tail | stop | repair | review | done | scope | doctor
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { packPaths, isPack, readJson, readText, atomicWriteJson, atomicWriteText, appendLine, ensureDir, pidAlive, sleepMs, parseArgs, die, sha1, sha256, SKILL_DIR, SCRIPTS_DIR, NODE_BIN, OC_BIN, clip, modelSlug, withLock } from './lib/paths.mjs';
import { iso, now, isDeepseekPeak, isDeepseekModel, ageMs, fmtAge } from './lib/time.mjs';
import { readEvents, summarize, renderEvent, rawLines, redact, attemptDiagnostics } from './lib/events.mjs';
import { parseBrief, parseStatusHeader, checkReport } from './lib/status.mjs';
import { permissionJson, outsideOwns } from './lib/permission.mjs';
import { gitInfo, diffFiles, diffStat, git, isRepo } from './lib/gitinfo.mjs';
import { loadConfig, loadRoster, updateRoster, findTask, newTaskRow } from './lib/roster.mjs';
import { lintBrief, planIdsFrom } from './lib/lint.mjs';
import { launchContract, validateLock } from './lib/launch-contract.mjs';
import { RUNTIMES, requireRuntime, runtimeBinary } from './lib/runtimes.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = parseArgs(argv.slice(1));
const json = !!args.json;
const USAGE = `usage: pack-worker.mjs <start|instruct|status|list|tail|stop|repair|review|done|scope|doctor> --pack <dir> [--task <ID>] [options] [--json]
  start    --task ID [--tool opencode|claude|codex] [--brief f] [--model m] [--agent a|none] [--variant v] [--cwd dir] [--role r] [--max-minutes n] [--respect-peak] [--force] [--reclaim] [--no-worktree] [--dry-run]
  instruct --task ID "<text>" [--fresh] [--allow-dirty] [--max-minutes n]
  status   [--task ID]        list        tail --task ID [-n 30] [--raw]
  stop     --task ID [--grace 15] [--reason "…"]
  repair   --task ID --blocker <BLK-ID> --result fail|pass [--note "…"]
  review   --task ID --result pass|changes [--note "…"]      done --task ID
  scope    --task ID [--base ref] [--head ref]              doctor [--pack dir]
  ack      --escalation E-ID [--note "…"]   (acknowledge a sweep item you are handling; --changed-only sweeps go quiet)
  instruct --accept-brief-change  accepts a deliberately changed brief; --force --reason text overrides only capacity/memory; policy gates cannot be bypassed
exit codes: 0 ok · 1 usage · 2 internal · 3 refused · 4 launch failed · 5 not found`;
if (!cmd || args.help) { console.log(USAGE); process.exit(cmd ? 0 : 1); }

function out(obj, human) { if (json) console.log(JSON.stringify(obj, null, 2)); else if (human) console.log(human); }
function needPack() {
  const pack = args.pack || args._[0];
  if (!pack) die(1, 'missing --pack <dir>', json);
  if (!isPack(pack)) die(5, `not a pack (no control/config.json + roster.json): ${pack}`, json);
  const pp = packPaths(pack);
  return { pp, cfg: loadConfig(pp) };
}
function needTask(pp, id) {
  if (!id) die(1, 'missing --task <ID>', json);
  const t = findTask(loadRoster(pp), id);
  return t;
}
function memoryFreePct() {
  if (process.env.OC_FAKE_MEM_FREE) return Number(process.env.OC_FAKE_MEM_FREE);
  if (process.platform === 'linux') {
    try { const text = fs.readFileSync('/proc/meminfo', 'utf8'); return Number(text.match(/^MemAvailable:\s*(\d+)/m)?.[1]) / Number(text.match(/^MemTotal:\s*(\d+)/m)?.[1]) * 100; } catch { return os.freemem() / os.totalmem() * 100; }
  }
  try { const r = spawnSync('memory_pressure', [], { encoding: 'utf8', timeout: 3000 }); const m = (r.stdout || '').match(/free percentage:\s*(\d+)%/i); return m ? Number(m[1]) : null; }
  catch { return null; }
}
function taskRunning(t) {
  if (!t) return false;
  return t.state === 'running' || pidAlive(t.pid) || pidAlive(t.supervisor_pid);
}
function requireOpenCodeTask(t) {
  try { requireRuntime(t?.tool || 'opencode'); } catch (e) { die(3, e.message, json); }
}
// Checkout locks live at the workspace level so two packs pointing at the same physical checkout share one lock.
function locksDir(cfg) { return path.join(cfg.root, '.agent-workpacks', 'locks'); }
function lockPathFor(cfg, checkout) { return path.join(locksDir(cfg), sha1(safeReal(checkout)).slice(0, 12)); }
function safeReal(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
function acquireLock(pp, cfg, checkout, id, { reclaim }) {
  ensureDir(locksDir(cfg));
  const lp = lockPathFor(cfg, checkout);
  if (fs.existsSync(lp)) {
    const o = readJson(lp, {});
    const alive = pidAlive(o.pid) || pidAlive(o.supervisor_pid);
    if (alive) die(3, `checkout ${checkout} is locked by task ${o.task} of pack ${o.pack || '?'} (pid ${o.pid || o.supervisor_pid}); one writer per checkout`, json);
    if (!reclaim) die(3, `orphaned lock from task ${o.task} of pack ${o.pack || '?'} (started ${o.started_at}); re-run with --reclaim after checking git status in ${checkout}`, json);
    fs.unlinkSync(lp);
  }
  fs.writeFileSync(lp, JSON.stringify({ task: id, pack: pp.root, pid: null, supervisor_pid: null, started_at: iso(), checkout }), { flag: 'wx' });
  return lp;
}
function launchGates({ pp, cfg, roster, id, model, needsFirst, lockLine, state, role, force, checkProbe = true }) {
  const warnings = [];
  const task = findTask(roster, id);
  if (force && (typeof args.reason !== 'string' || !args.reason.trim())) die(3, '--force requires --reason; only capacity and memory may be overridden', json);
  const status = task ? parseStatusHeader(readText(path.join(task.task_dir, 'STATUS.md'), '')) : null;
  const blockers = readJson(pp.blockers, {});
  const blockerIds = [...(task?.blocker_ids || []), ...(status?.blocker ? [status.blocker.id] : [])];
  if (['blocked', 'needs-owner'].includes(state) || ['blocked', 'needs-owner'].includes(status?.fields.state) || (task?.review_round || 0) >= cfg.limits.max_review_rounds || blockerIds.some((b) => blockers[b]?.stopped) || (status?.blocker?.n != null && status.blocker.m != null && status.blocker.n >= status.blocker.m))
    die(3, `task ${id} is blocked or review-exhausted; --force cannot reopen its policy allowance`, json);
  for (const dep of needsFirst || []) {
    if (findTask(roster, dep)?.state !== 'done') die(3, `dependency ${dep} is not done; --force cannot bypass prerequisites`, json);
  }
  try { validateLock(cfg, lockLine, role); } catch (e) { die(3, `ddd-guard lock not approved: ${e.message}`, json); }
  const probe = checkProbe ? readJson(pp.probeJson(modelSlug(model)), null) : null;
  const age = probe && typeof probe.checked_at === 'string' ? ageMs(probe.checked_at) : null;
  const freshFailedProbe = probe && probe.model === model && probe.result && probe.result !== 'ok' && age != null && age >= 0 && age <= cfg.limits.probe_max_age_minutes * 60000;
  if (freshFailedProbe) die(3, `the latest fresh probe for ${model} failed (${probe.result}); resolve it and run pack-probe again`, json);
  const running = roster.tasks.filter((t) => t.id !== id && taskRunning(t)).length;
  if (running >= cfg.limits.max_workers) {
    if (!force) die(3, `worker cap: ${running} running ≥ max_workers ${cfg.limits.max_workers}`, json);
    warnings.push(`worker cap overridden: ${args.reason.trim()}`);
  }
  const free = memoryFreePct();
  if (free != null && free < cfg.limits.memory_gate_min_free_pct) {
    if (!force) die(3, `memory gate: ${free}% free < ${cfg.limits.memory_gate_min_free_pct}%`, json);
    warnings.push(`memory gate overridden: ${args.reason.trim()}`);
  }
  if (isDeepseekModel(model) && isDeepseekPeak()) {
    if (args['respect-peak']) die(3, 'DeepSeek peak hours; use a GLM-eligible task or drop --respect-peak', json);
    warnings.push('DeepSeek peak hours (2x cost)');
  }
  return warnings;
}
function recordOverrides(pp, id, warnings) {
  for (const warning of warnings.filter((w) => w.includes('overridden:'))) appendLine(path.join(pp.root, 'LEDGER.md'), `- ${iso()} — pack-worker — ${id}: ${warning}`);
}
function checkBrief(pp, cfg, t, id) {
  const briefPath = t.brief_path || path.join(t.task_dir, 'BRIEF.md');
  const md = readText(briefPath, '');
  if (!md.trim()) die(3, 'missing or empty brief; restore the approved assignment before continuing', json);
  const changed = !t.brief_sha256 || sha256(md) !== t.brief_sha256;
  const parsed = parseBrief(md);
  if (changed) {
    if (!args['accept-brief-change']) die(3, 'the brief changed; explicit --accept-brief-change is required', json);
    if (!t.launch_contract || !t.brief_snapshot) die(3, 'legacy task has no assignment snapshot; establish a new validated assignment', json);
    const lint = lintBrief(md, { root: cfg.root, taskId: id, planIds: planIdsFrom(readText(path.join(pp.root, 'PLAN.md'), '')) });
    if (!lint.pass) die(3, `revised brief lint failed: ${lint.failures.join('; ')}`, json);
    const newCheckout = /^\(/.test(parsed.owns.repo || '') ? t.task_dir : path.resolve(cfg.root, parsed.owns.worktree || '.');
    const contract = launchContract(cfg, parsed, newCheckout);
    if (JSON.stringify(contract) !== JSON.stringify(t.launch_contract)) die(3, 'brief changes the launch contract; ownership, dependencies, checkout, role and lock changes require a new assignment', json);
  }
  return { md, parsed, changed };
}
function acceptBrief(pp, t, checked) {
  if (!checked.changed) return;
  const file = path.join(t.task_dir, 'brief-versions', `${t.brief_sha256}.md`);
  if (!fs.existsSync(file)) atomicWriteText(file, t.brief_snapshot);
  updateRoster(pp, (r) => { const x = findTask(r, t.id); x.brief_sha256 = sha256(checked.md); x.brief_snapshot = checked.md; });
  appendLine(path.join(pp.root, 'LEDGER.md'), `- ${iso()} — pack-worker — ${t.id} accepted assignment-neutral brief revision ${sha256(checked.md)}; previous version ${file}`);
}
function liveness(t) {
  const alive = pidAlive(t.pid);
  const ev = t.task_dir ? summarize(attemptDiagnostics(t.task_dir, t, 131072).events) : summarize([]);
  const exitInfo = t.task_dir ? readJson(path.join(t.task_dir, 'exit.json'), null) : null;
  const st = t.task_dir ? parseStatusHeader(readText(path.join(t.task_dir, 'STATUS.md'), '')) : parseStatusHeader('');
  const rep = t.task_dir ? checkReport(readText(path.join(t.task_dir, 'REPORT.md'), '')) : { present: false };
  let lastAt = Math.max(ev.lastEventAt || 0, ev.lastToolAt || 0);
  if (!lastAt && t.task_dir) { try { lastAt = fs.statSync(path.join(t.task_dir, 'run.jsonl')).mtimeMs; } catch {} }
  return { alive, ev, exitInfo, st, rep, lastAt: lastAt || null };
}
function renderPreamble(cfg, pp, { id, briefPath, checkout, branch, owns, taskDir, role = 'coder', packRoot = pp.root }) {
  const tpl = readText(path.join(SKILL_DIR, 'assets', 'preamble.md'));
  const ROLE_RULES = {
    coder: `Reliability (coder): never run the identical command twice in a row; at most ten reads or searches before your first edit, then write; commit WIP early (\`wip(${id}): …\`); if interrupted, start with \`git status\` and keep what survived.`,
    researcher: `Reliability (researcher): never edit product code or commit; read as widely as the brief needs, but record findings in REPORT.md as you go (every 15 minutes at least) so an interruption loses nothing; stop when the brief's time box is reached and report what is covered and what is not.`,
    docs: `Reliability (docs): draft the deliverable early and refine it; record progress in STATUS.md every 15 minutes; stop at the time box with a usable document.`,
    verifier: `Reliability (verifier): run each named command on base and on the candidate exactly as written (the same command twice, against different refs, is expected); never change code or tests to make them pass or commit; record every command and its exit code in REPORT.md as you go.`,
  };
  const m = { ID: id, PFX: cfg.pfx, PACK: packRoot, BRIEF: briefPath, CHECKOUT: checkout, BRANCH: branch || '(no branch: docs or research task)', OWNS: owns.join(', ') || '(your task folder only)', TASK_DIR: taskDir, ROOT: cfg.root, ROLE_RULES: ROLE_RULES[role] || ROLE_RULES.coder };
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in m ? m[k] : `{{${k}}}`));
}
function spawnSupervisor(pp, cfg, extra, env) {
  ensureDir(pp.taskDir(extra.task));
  const supLog = fs.openSync(path.join(extra.taskDir || pp.taskDir(extra.task), 'supervisor.log'), 'a');
  const a = [path.join(SCRIPTS_DIR, 'pack-supervise.mjs'), '--pack', pp.root, '--task', extra.task, '--attempt', String(extra.attempt), '--kind', extra.kind];
  if (extra.session) a.push('--session', extra.session);
  if (extra.promptFile) a.push('--prompt-file', extra.promptFile);
  if (extra.lock) a.push('--lock', extra.lock);
  if (extra.maxMinutes) a.push('--max-minutes', String(extra.maxMinutes));
  const child = spawn(NODE_BIN, a, { cwd: cfg.root, detached: true, stdio: ['ignore', supLog, supLog], env: { ...process.env, ...env } });
  child.unref();
  fs.closeSync(supLog);
  return child.pid;
}
function waitForPid(pp, id, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const t = findTask(loadRoster(pp), id);
    if (t && (t.state === 'launch-failed' || t.pid)) return t;
    sleepMs(250);
  }
  return findTask(loadRoster(pp), id);
}
function ensureWorktree(cfg, brief, { json }) {
  const repo = brief.owns.repo, wt = brief.owns.worktree;
  if (!repo || !wt || /^\(/.test(repo)) return null;
  const wtAbs = path.isAbsolute(wt) ? wt : path.resolve(cfg.root, wt);
  if (fs.existsSync(wtAbs)) return wtAbs;
  const repoDir = path.resolve(cfg.root, repo);
  if (!isRepo(repoDir)) die(5, `cannot create worktree: ${repoDir} is not a git checkout`, json);
  const base = brief.owns.base || `origin/${cfg.merge_target}`;
  const branch = brief.owns.branch;
  if (!branch) die(3, 'brief names no branch; cannot create the worktree', json);
  const remote = base.split('/')[0];
  if (/^origin\//.test(base)) { const f = git(repoDir, ['fetch', remote, '--quiet'], 120000); if (!f.ok) console.error(`warning: git fetch failed: ${clip(f.err, 200)}`); }
  const exists = git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  const r = exists ? git(repoDir, ['worktree', 'add', wtAbs, branch], 60000) : git(repoDir, ['worktree', 'add', '-b', branch, wtAbs, base], 60000);
  if (!r.ok) die(2, `git worktree add failed: ${clip(r.err, 300)}`, json);
  const nm = path.join(repoDir, 'node_modules');
  if (fs.existsSync(nm) && !fs.existsSync(path.join(wtAbs, 'node_modules'))) {
    try { fs.cpSync(nm, path.join(wtAbs, 'node_modules'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE }); }
    catch (e) { console.error(`warning: node_modules copy failed: ${clip(e.message, 200)}`); }
  }
  return wtAbs;
}

// ---------------------------------------------------------------- start
function cmdStart() {
  const { pp, cfg } = needPack();
  const id = args.task; if (!id) die(1, 'missing --task <ID>', json);
  const existing = findTask(loadRoster(pp), id);
  if (existing) requireOpenCodeTask(existing);
  let backend;
  try { backend = requireRuntime(args.tool || existing?.tool || cfg.default_tool || 'opencode'); } catch (e) { die(3, e.message, json); }
  if (existing && (existing.tool || 'opencode') !== backend) die(3, 'runtime changes require a new assignment', json);
  if (existing && taskRunning(existing)) die(3, `task ${id} is already running (pid ${existing.pid || existing.supervisor_pid || '?'})`, json);
  const briefSrc = args.brief ? path.resolve(args.brief) : path.join(pp.taskDir(id), 'BRIEF.md');
  if (!fs.existsSync(briefSrc)) die(5, `brief not found: ${briefSrc}`, json);
  const briefMd = fs.readFileSync(briefSrc, 'utf8');
  const taskDir = pp.taskDir(id);
  const briefDst = path.join(taskDir, 'BRIEF.md');
  const planIds = planIdsFrom(readText(path.join(pp.root, 'PLAN.md'), ''));
  const lint = lintBrief(briefMd, { root: cfg.root, planIds, taskId: id });
  if (!lint.pass) die(3, `brief lint failed:\n  - ${lint.failures.join('\n  - ')}`, json);
  const brief = lint.brief;
  const role = brief.header.role || 'coder';
  if (args.role && args.role !== role) die(3, '--role must match the validated brief assignment', json);
  const defaults = cfg.runtime_defaults?.[backend] || {};
  const model = args.model || (backend === 'opencode' ? cfg.models[role] || cfg.models.coder : defaults.model) || null;
  const variant = args.variant || (backend === 'opencode' ? cfg.default_variant : defaults.variant) || null;
  let agent = null;
  if (backend === 'opencode') {
    if (args.agent !== undefined) agent = args.agent === 'none' ? null : args.agent;
    else { const name = cfg.agents[role]; if (name && ['agent', 'agents'].some((d) => fs.existsSync(path.join(cfg.root, '.opencode', d, `${name}.md`)))) agent = name; }
  }
  let checkout = args.cwd ? path.resolve(args.cwd) : null;
  if (!checkout) {
    if (brief.owns.repo && /^\(/.test(brief.owns.repo)) checkout = taskDir;          // "(pack)": research/docs task writes only into its folder
    else if (brief.owns.worktree) checkout = path.resolve(cfg.root, brief.owns.worktree);
  }
  if (!checkout) die(3, 'no checkout: the Owns table names no worktree and no --cwd was given', json);
  const assignedCheckout = /^\(/.test(brief.owns.repo || '') ? taskDir : path.resolve(cfg.root, brief.owns.worktree || '.');
  if (checkout !== assignedCheckout) die(3, '--cwd must match the checkout in the validated brief', json);
  const gateWarnings = launchGates({ pp, cfg, roster: loadRoster(pp), id, model, needsFirst: brief.header.needsFirst, lockLine: brief.header.lock, state: existing?.state, role, force: !!args.force });
  if (existing) {
    checkBrief(pp, cfg, existing, id);
    if (path.resolve(existing.checkout) !== checkout || existing.role !== role) die(3, 'launch assignment changed; create a new validated assignment', json);
  }
  const contract = launchContract(cfg, brief, checkout, role);
  if (existing?.launch_contract && JSON.stringify(contract) !== JSON.stringify(existing.launch_contract)) die(3, 'launch contract changed; create a new validated assignment', json);
  // Validate permission construction before creating a checkout or writing launch artifacts.
  const peak = isDeepseekModel(model) && isDeepseekPeak();
  const owns = brief.owns.files;
  const permission = permissionJson({ root: cfg.root, checkout, owns: checkout === taskDir ? [] : owns, taskDir, protectedBranches: cfg.protected_branches, webfetch: role === 'researcher' || role === 'docs' ? 'allow' : 'deny' });
  const prompt = renderPreamble(cfg, pp, { id, briefPath: briefDst, checkout, branch: brief.owns.branch, owns, taskDir, role, packRoot: pp.root }) + `\nYour brief: ${briefDst}\nStart in ${checkout} now.\n`;
  if (!args['dry-run']) {
    ensureDir(taskDir);
  if (path.resolve(briefSrc) !== briefDst) {
    if (fs.existsSync(briefDst) && sha256(fs.readFileSync(briefDst, 'utf8')) !== sha256(briefMd)) die(3, `tasks/${id}/BRIEF.md exists and differs from ${briefSrc}; briefs are never overwritten`, json);
    if (!fs.existsSync(briefDst)) fs.copyFileSync(briefSrc, briefDst);
  }
    if (!fs.existsSync(checkout) && !args['no-worktree'] && !/^\(/.test(brief.owns.repo || '')) ensureWorktree(cfg, brief, { json });
    if (!fs.existsSync(checkout)) die(5, `checkout does not exist: ${checkout}`, json);
    if (existing) acceptBrief(pp, existing, checkBrief(pp, cfg, existing, id));
    recordOverrides(pp, id, gateWarnings);
    atomicWriteText(path.join(taskDir, 'PROMPT.txt'), prompt);
  }
  for (const f of ['STATUS.md', 'QUESTIONS.md']) {
    const dst = path.join(taskDir, f);
    if (!args['dry-run'] && !fs.existsSync(dst)) {
      const tpl = readText(path.join(pp.tasks, '_templates', f), readText(path.join(SKILL_DIR, 'assets', 'pack-template', 'tasks', '_templates', f), ''));
      atomicWriteText(dst, tpl.replace(/<ID>/g, id).replace(/<iso>/g, iso()).replace(/<tool agent model>/g, `${backend} ${agent || '-'} ${model}`).replace(/<PFX>/g, cfg.pfx).replace(/origin\/<target>@<sha>/g, brief.owns.base || `origin/${cfg.merge_target}`));
    }
  }
  const attempt = ((existing && existing.attempts) || 0) + 1;
  const row = newTaskRow({
    ...(existing || {}), id, title: `${pp.name}/${id}${brief.title ? ' ' + brief.title : ''}`, role, tool: backend, model, variant, agent,
    checkout, branch: brief.owns.branch, base: brief.owns.base || `origin/${cfg.merge_target}`, owns, needs_first: brief.header.needsFirst,
    brief_path: briefDst, brief_sha256: sha256(briefMd), brief_snapshot: briefMd, launch_contract: contract, task_dir: taskDir, state: 'queued', pid: null, exit_code: null, exited_at: null, started_at: iso(), pending_instruction: false,
    session_id: null,
    previous_sessions: [...((existing && existing.previous_sessions) || []), ...(existing && existing.session_id ? [existing.session_id] : [])],
  });
  if (args['dry-run']) {
    out({ ok: true, dry_run: true, task: id, backend, model, variant, agent, checkout, owns, permission: JSON.parse(permission), prompt_file: path.join(taskDir, 'PROMPT.txt'), peak_hours: peak, warnings: gateWarnings },
        `dry run: task ${id} backend ${backend} model ${model} variant ${variant} agent ${agent || '-'}\n  checkout ${checkout}\n  owns ${owns.join(', ') || '(task folder)'}\n  prompt ${path.join(taskDir, 'PROMPT.txt')}\n  peak hours: ${peak}${gateWarnings.length ? '\n  warnings: ' + gateWarnings.join('; ') : ''}`);
    return;
  }
  const lock = acquireLock(pp, cfg, checkout, id, { reclaim: !!args.reclaim });
  updateRoster(pp, (r) => { const i = r.tasks.findIndex((t) => t.id === id); if (i >= 0) r.tasks[i] = row; else r.tasks.push(row); });
  appendLine(path.join(pp.root, 'LEDGER.md'), `- ${iso()} — pack-worker — started ${id} (${backend}, ${model}, ${agent || 'no agent'}) in ${path.relative(cfg.root, checkout)}`);
  spawnSupervisor(pp, cfg, { task: id, attempt, kind: 'start', lock, maxMinutes: args['max-minutes'], taskDir }, { OPENCODE_PERMISSION: permission });
  const t = waitForPid(pp, id);
  if (t?.state === 'launch-failed') die(4, `launch failed for ${id}: see ${path.join(taskDir, 'exit.json')}`, json);
  out({ ok: true, task: id, backend, pid: t?.pid ?? null, session_id: t?.session_id ?? null, model, agent, checkout, log: path.join(taskDir, 'run.jsonl'), peak_hours: peak, warnings: gateWarnings },
      `started ${id} backend=${backend} pid=${t?.pid ?? '?'} model=${model} agent=${agent || '-'} checkout=${checkout}${gateWarnings.map((w) => `\n  note: ${w}`).join('')}\n  log: ${path.join(taskDir, 'run.jsonl')}`);
}

// ---------------------------------------------------------------- instruct
function cmdInstruct() {
  const { pp, cfg } = needPack();
  const id = args.task; const t = needTask(pp, id);
  if (!t) die(5, `task ${id} not in roster`, json);
  requireOpenCodeTask(t);
  const backend = t.tool || 'opencode';
  if (args.tool && args.tool !== backend) die(3, 'runtime changes require a new assignment', json);
  const text = args._.filter((x) => x !== (args.pack || '')).join(' ').trim() || args.message;
  if (!text) die(1, 'missing instruction text', json);
  const checked = checkBrief(pp, cfg, t, id);
  const inbox = path.join(t.task_dir, 'INBOX.md');
  if (pidAlive(t.pid)) {
    if (checked.changed) die(3, 'cannot accept a revised brief while the worker is running; stop it first', json);
    appendLine(inbox, `\n## ${iso()} instruction\n${text}\n`);
    updateRoster(pp, (r) => { const x = findTask(r, id); if (x) x.pending_instruction = true; });
    out({ ok: true, task: id, queued: true, inbox }, `queued in ${inbox}; the worker re-reads INBOX at step boundaries (pid ${t.pid} is alive)`);
    return;
  }
  // Corrections keep the policy, dependency, capacity, memory and lock gates, but never require another provider probe.
  const gateWarnings = launchGates({ pp, cfg, roster: loadRoster(pp), id, model: t.model, needsFirst: t.needs_first, lockLine: checked.parsed.header.lock, state: t.state, role: t.role, force: !!args.force, checkProbe: false });
  const n = (t.attempts || 0) + 1;
  const attDir = path.join(t.task_dir, 'attempts', String(n));
  const gi = gitInfo(t.checkout);
  const exitInfo = readJson(path.join(t.task_dir, 'exit.json'), {});
  const ambiguous = /^(killed|max-minutes)/.test(exitInfo.reason || '') || (exitInfo.last_finish_reason && exitInfo.last_finish_reason !== 'stop');
  let body = text;
  if (gi.available && gi.dirty && ambiguous) body = `First run \`git status\` in ${t.checkout}: the previous attempt ended without a clean stop and left changes. ${t.role === 'coder' ? 'Commit sound changes as WIP; ' : 'Record the surviving evidence in REPORT.md; '}do not recreate files that already exist, then continue from STATUS.md next_action.\n\n${text}`;
  if (args.fresh && gi.dirty && !args['allow-dirty']) die(3, `tree is dirty (${gi.changedFiles.length} files); a fresh session would lose context. Use --allow-dirty or continue the session`, json);
  const session = !args.fresh ? t.session_id : null;
  if (!session && !args.fresh) die(3, 'no session id recorded; inspect the failed attempt and use --fresh explicitly to start a replacement', json);
  ensureDir(attDir);
  if (gi.available) { atomicWriteText(path.join(attDir, 'git-status.txt'), gi.changedFiles.join('\n') + '\n'); atomicWriteText(path.join(attDir, 'git-diff-stat.txt'), diffStat(t.checkout) + '\n'); }
  acceptBrief(pp, t, checked);
  recordOverrides(pp, id, gateWarnings);
  const pf = path.join(attDir, 'PROMPT.txt');
  atomicWriteText(pf, (session ? '' : renderPreamble(cfg, pp, { id, briefPath: t.brief_path, checkout: t.checkout, branch: t.branch, owns: t.owns, taskDir: t.task_dir, role: t.role, packRoot: pp.root }) + `\nStart in ${t.checkout}.\n`) + body + '\n');
  const lock = acquireLock(pp, cfg, t.checkout, id, { reclaim: !!args.reclaim });
  const permission = permissionJson({ root: cfg.root, checkout: t.checkout, owns: t.checkout === t.task_dir ? [] : t.owns, taskDir: t.task_dir, protectedBranches: cfg.protected_branches, webfetch: ['researcher', 'docs'].includes(t.role) ? 'allow' : 'deny' });
  updateRoster(pp, (r) => { const x = findTask(r, id); if (x) { x.state = 'queued'; x.pending_instruction = false; } });
  appendLine(path.join(pp.root, 'LEDGER.md'), `- ${iso()} — pack-worker — instruct ${id} (${session ? 'same session' : 'fresh session'}, ${backend}): ${clip(text, 120)}`);
  spawnSupervisor(pp, cfg, { task: id, attempt: n, kind: 'instruct', session, promptFile: pf, lock, maxMinutes: args['max-minutes'], taskDir: t.task_dir }, { OPENCODE_PERMISSION: permission });
  const t2 = waitForPid(pp, id);
  if (t2?.state === 'launch-failed') die(4, `relaunch failed for ${id}`, json);
  const resumed = !!session;
  out({ ok: true, task: id, backend, pid: t2?.pid ?? null, session_id: t2?.session_id ?? session, resumed, resume_clause: body !== text }, `instructed ${id} backend=${backend} pid=${t2?.pid ?? '?'} ${session ? `session ${session}` : 'fresh session'} (${resumed ? 'context kept' : 'fresh context'})${body !== text ? '\n  note: resume clause prepended (dirty tree after an ambiguous exit)' : ''}`);
}

// ---------------------------------------------------------------- status / list / tail
function rowStatus(t) {
  const L = liveness(t);
  return {
    id: t.id, tool: t.tool || 'opencode', state: t.state, status_state: L.st.fields.state || null, alive: L.alive, pid: t.pid, session_id: t.session_id, model: t.model, agent: t.agent,
    attempts: t.attempts, repair_attempts: t.repair_attempts, review_round: t.review_round, exit_code: t.exit_code, exit_reason: L.exitInfo?.reason || null,
    last_event_age: fmtAge(ageMs(L.lastAt)), last_event_at: L.lastAt ? new Date(L.lastAt).toISOString() : null, tool_calls: L.ev.toolCalls, report: L.rep.present, blocker: L.st.fields.blocker || null, next_action: L.st.fields.next_action || null,
  };
}
function cmdStatus() {
  const { pp } = needPack();
  const r = loadRoster(pp);
  const rows = (args.task ? r.tasks.filter((t) => t.id === args.task) : r.tasks).map(rowStatus);
  if (json) return console.log(JSON.stringify({ ok: true, pack: pp.root, tasks: rows }, null, 2));
  if (!rows.length) return console.log('no tasks');
  console.log(['ID', 'backend', 'state', 'STATUS', 'alive', 'pid', 'session', 'attempts', 'repairs', 'review', 'last event', 'tools', 'report'].join('\t'));
  for (const x of rows) console.log([x.id, x.tool, x.state, x.status_state || '-', x.alive ? 'yes' : 'no', x.pid || '-', x.session_id || '-', x.attempts, x.repair_attempts, x.review_round, x.last_event_age, x.tool_calls, x.report ? 'yes' : 'no'].join('\t'));
}
function cmdList() { const { pp } = needPack(); const r = loadRoster(pp); out({ ok: true, tasks: r.tasks.map((t) => ({ id: t.id, tool: t.tool || 'opencode', state: t.state, model: t.model, checkout: t.checkout, pid: t.pid, session_id: t.session_id })) }, r.tasks.map((t) => `${t.id}\t${t.tool || 'opencode'}\t${t.state}\t${t.model}\t${t.checkout}`).join('\n') || 'no tasks'); }
function cmdTail() {
  const { pp } = needPack();
  const t = needTask(pp, args.task); if (!t) die(5, `task ${args.task} not in roster`, json);
  requireOpenCodeTask(t);
  const n = Number(args.n || 30);
  const file = path.join(t.task_dir, 'run.jsonl');
  const events = readEvents(file, 524288);
  if (args.raw) { for (const l of rawLines(file, 262144).slice(-n)) console.log(redact(l)); return; }
  if (!events.length) { console.log(`(no JSON events in ${file}; last launch.log lines follow)`); for (const l of rawLines(path.join(t.task_dir, 'launch.log'), 65536).slice(-n)) console.log(redact(l)); return; }
  for (const e of events.slice(-n)) console.log(renderEvent(e));
}

// ---------------------------------------------------------------- stop / repair / review / done
function cmdAck() {
  const { pp } = needPack();
  const id = args.escalation || args.item || args._[0];
  if (!id || !/^E-/.test(id)) die(1, 'ack needs --escalation <E-id> (the orchestrator acknowledges a sweep item it is handling)', json);
  return withLock(pp.sweepLock, () => {
  const esc = readJson(pp.escalations, { version: 1, next: 1, items: [] });
  const item = esc.items.find((e) => e.id === id && e.status === 'open');
  if (!item) die(5, `${id} is not an open item`, json);
  item.acked_at = iso(); item.acked_note = args.note || null;
  atomicWriteJson(pp.escalations, esc);
  appendLine(path.join(pp.root, 'LEDGER.md'), `- ${iso()} — orchestrator — acknowledged ${id} (${item.task}, ${item.class})${args.note ? ': ' + args.note : ''}`);
  out({ ok: true, id, task: item.task, class: item.class }, `acknowledged ${id} (${item.task}, ${item.class}); it stays listed until the condition clears`);
  });
}
function cmdStop() {
  const { pp, cfg } = needPack();
  const t = needTask(pp, args.task); if (!t) die(5, `task ${args.task} not in roster`, json);
  requireOpenCodeTask(t);
  if (!t.pid || !pidAlive(t.pid)) { updateRoster(pp, (r) => { const x = findTask(r, args.task); if (x && x.state === 'running') x.state = 'exited'; }); die(5, `task ${args.task} has no live process`, json); }
  const grace = Number(args.grace || 15) * 1000;
  const kill = (sig) => { try { process.kill(-t.pid, sig); } catch { try { process.kill(t.pid, sig); } catch {} } };
  kill('SIGTERM');
  const until = Date.now() + grace; while (Date.now() < until && pidAlive(t.pid)) sleepMs(500);
  if (pidAlive(t.pid)) { kill('SIGKILL'); sleepMs(500); }
  const until2 = Date.now() + 5000; while (Date.now() < until2 && !fs.existsSync(path.join(t.task_dir, 'exit.json'))) sleepMs(250);
  updateRoster(pp, (r) => { const x = findTask(r, args.task); if (x) { x.state = 'stopped'; x.pid = null; x.exited_at = iso(); const h = (x.history || []).slice(-1)[0]; if (h) h.reason = `stopped:${args.reason || 'operator'}`; } });
  const lp = lockPathFor(cfg, t.checkout); try { if (readJson(lp, {}).task === t.id) fs.unlinkSync(lp); } catch {}
  appendLine(path.join(pp.root, 'LEDGER.md'), `- ${iso()} — pack-worker — stopped ${t.id}: ${args.reason || 'operator'}`);
  out({ ok: true, task: t.id, stopped: true }, `stopped ${t.id}`);
}
function cmdRepair() {
  const { pp, cfg } = needPack();
  const id = args.task, blocker = args.blocker, result = args.result;
  if (!id || !blocker || !['fail', 'pass'].includes(result)) die(1, 'repair needs --task --blocker <ID> --result fail|pass', json);
  const t = needTask(pp, id); if (!t) die(5, `task ${id} not in roster`, json);
  const blockers = readJson(pp.blockers, {});
  const b = blockers[blocker] || { failed_repairs: 0, passed_repairs: 0, stopped: false, history: [] };
  if (result === 'fail') b.failed_repairs += 1; else b.passed_repairs += 1;
  b.history.push({ at: iso(), task: id, result, note: args.note || null });
  const max = cfg.limits.max_repairs_per_blocker;
  if (b.failed_repairs >= max) b.stopped = true;
  blockers[blocker] = b; atomicWriteJson(pp.blockers, blockers);
  updateRoster(pp, (r) => { const x = findTask(r, id); if (x) { x.blocker_ids = [...new Set([...(x.blocker_ids || []), blocker])]; x.repair_attempts = (x.repair_attempts || 0) + (result === 'fail' ? 1 : 0); if (b.stopped) x.state = 'blocked'; } });
  appendLine(path.join(pp.root, 'LEDGER.md'), `- ${iso()} — pack-worker — repair ${result} on ${blocker} by ${id} (${b.failed_repairs}/${max})${b.stopped ? ' — allowance exhausted: stop and ask' : ''}`);
  out({ ok: true, blocker, failed_repairs: b.failed_repairs, stopped: b.stopped }, `${blocker}: ${b.failed_repairs}/${max} failed repairs${b.stopped ? ' — STOP and ask (cumulative; a new task, dir, model or timeout does not reset it)' : ''}`);
}
function cmdReview() {
  const { pp, cfg } = needPack();
  const id = args.task, result = args.result;
  if (!id || !['pass', 'changes'].includes(result)) die(1, 'review needs --task --result pass|changes', json);
  const t = needTask(pp, id); if (!t) die(5, `task ${id} not in roster`, json);
  let round = 0, exhausted = false;
  updateRoster(pp, (r) => { const x = findTask(r, id); if (!x) return; if (result === 'changes') { x.review_round = (x.review_round || 0) + 1; round = x.review_round; if (round >= cfg.limits.max_review_rounds) { x.state = 'needs-owner'; exhausted = true; } } else { round = x.review_round; x.state = 'done'; } });
  appendLine(path.join(pp.root, 'LEDGER.md'), `- ${iso()} — pack-worker — review ${result} ${id} (round ${round})${exhausted ? ' — review rounds exhausted (OA-2): owner options needed' : ''}`);
  out({ ok: true, task: id, result, review_round: round, exhausted }, `${id}: review ${result}, round ${round}${exhausted ? ' — STOP: give the owner 2–3 options with a recommendation' : ''}`);
}
function cmdDone() { const { pp } = needPack(); const id = args.task; const t = needTask(pp, id); if (!t) die(5, `task ${id} not in roster`, json); updateRoster(pp, (r) => { const x = findTask(r, id); if (x) x.state = 'done'; }); appendLine(path.join(pp.root, 'LEDGER.md'), `- ${iso()} — pack-worker — ${id} marked done`); out({ ok: true, task: id, state: 'done' }, `${id} done`); }

// ---------------------------------------------------------------- scope / doctor
function cmdScope() {
  const { pp } = needPack();
  const t = needTask(pp, args.task); if (!t) die(5, `task ${args.task} not in roster`, json);
  const base = args.base || t.base, head = args.head || 'HEAD';
  const d = diffFiles(t.checkout, base, head);
  if (!d.ok) die(2, `git diff failed: ${d.err}`, json);
  const gi = gitInfo(t.checkout);
  const all = Array.from(new Set([...d.files, ...gi.changedFiles]));
  const outside = outsideOwns(all, t.owns);
  const pass = outside.length === 0;
  out({ ok: true, task: t.id, pass, base, head, files: all, outside }, `${pass ? 'PASS' : 'FAIL'}: ${all.length} changed file(s) vs ${base}...${head}${outside.length ? `\n  outside Owns:\n  - ${outside.join('\n  - ')}` : ''}`);
  process.exit(pass ? 0 : 3);
}
function cmdDoctor() {
  const checks = [];
  checks.push({ check: 'Node.js 24+', value: process.version, ok: Number(process.versions.node.split('.')[0]) >= 24 });
  const tools = args.tool ? [args.tool] : RUNTIMES;
  for (const tool of tools) {
    let binary; try { binary = runtimeBinary(tool); } catch (error) { die(3, error.message, json); }
    const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 });
    const help = spawnSync(binary, tool === 'codex' ? ['exec', '--help'] : tool === 'opencode' ? ['run', '--help'] : ['--help'], { encoding: 'utf8', timeout: 10000 });
    const flags = tool === 'codex' ? ['--json'] : tool === 'claude' ? ['--output-format', '--resume', '--session-id', '--permission-mode'] : ['--session', '--format'];
    checks.push({ check: tool, binary, value: (version.stdout || version.stderr || version.error?.message || '').trim().split('\n')[0], ok: version.status === 0 && help.status === 0 && flags.every((flag) => help.stdout.includes(flag)) });
  }
  const free = memoryFreePct();
  checks.push({ check: 'memory free percentage', value: free, ok: free == null || free >= 25 });
  const ok = checks.every((c) => c.ok);
  out({ ok, checks, platform: process.platform }, checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.check}: ${c.value}`).join('\n'));
  process.exitCode = ok ? 0 : 3;
}

const commands = { start: cmdStart, instruct: cmdInstruct, status: cmdStatus, list: cmdList, tail: cmdTail, stop: cmdStop, repair: cmdRepair, review: cmdReview, done: cmdDone, scope: cmdScope, ack: cmdAck, doctor: cmdDoctor };
if (!commands[cmd]) { console.error(`unknown command ${cmd}\n${USAGE}`); process.exit(1); }
try { commands[cmd](); } catch (e) { die(2, `error: ${e.message}`, json); }
