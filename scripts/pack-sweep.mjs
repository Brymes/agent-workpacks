#!/usr/bin/env node
// No-LLM monitor: classifies every task, renders SWEEP.md / ESCALATIONS.md, updates CURRENT.md's machine lines.
// Exit 0 = nothing to do, 10 = open items that need someone (with --changed-only: only items nobody has
// acknowledged with `pack-worker ack`), 2 = error.
import fs from 'node:fs';
import path from 'node:path';
import { packPaths, isPack, readJson, readText, atomicWriteJson, atomicWriteText, appendLine, pidAlive, parseArgs, withLockAsync, sha1, modelSlug, clip } from './lib/paths.mjs';
import { iso, now, parseTs, ageMinutes, fmtAge, isDeepseekPeak } from './lib/time.mjs';
import { readEvents, summarize, rawLines, redact, classifyProviderError, attemptDiagnostics } from './lib/events.mjs';
import { parseStatusHeader, parseQuestions, checkReport, parseBrief } from './lib/status.mjs';
import { outsideOwns } from './lib/permission.mjs';
import { gitInfo } from './lib/gitinfo.mjs';
import { loadConfig, loadRoster, updateRoster, findTask } from './lib/roster.mjs';
import { lastActivity } from './lib/ocdb.mjs';

const args = parseArgs(process.argv.slice(2));
const json = !!args.json, quiet = !!args.quiet;
const pack = args.pack || args._[0];
if (!pack || !isPack(pack)) { console.error(`usage: pack-sweep.mjs --pack <dir> [--stale-minutes 20] [--changed-only] [--quiet] [--json] [--no-db] [--no-git]`); process.exit(pack ? 2 : 1); }
const pp = packPaths(pack);
const cfg = loadConfig(pp);
const staleMin = Number(args['stale-minutes'] || cfg.limits.stale_minutes);
const T0 = Date.now();

const ROUTE_TEMPLATES = {
  'probe-failed': (c) => ({
    credits: [`OpenCode Go quota or credits are exhausted for ${c.model}.`, ['wait for the 5-hour window and probe again', 'enable "Use balance" in the OpenCode console (owner)', 'move low-stakes docs/research tasks to a free Zen model for now']],
    auth: [`opencode authentication failed for ${c.model}; no worker can run.`, ['owner runs `opencode auth login` for the provider', 'pause all launches until the probe passes']],
    connect: [`The provider for ${c.model} is unreachable.`, ['retry `pack-probe` in 10 minutes; no launches until it passes', 'check network/DNS on this Mac']],
    'bad-model': [`The model id ${c.model} was rejected by the provider.`, ['check `opencode models opencode-go` and fix config.json models', 'use the other Flash model for this task']],
    timeout: [`The probe for ${c.model} timed out.`, ['retry once', 'check the provider status page']],
    unknown: [`The probe for ${c.model} failed for an unclassified reason.`, ['read control/probe-*.json excerpt', 'retry once']],
  }[c.kind] || [`Probe failed for ${c.model}.`, ['retry']]),
  'launch-failed': (c) => [`${c.id} exited twice right after the banner (no step started).`, ['run `pack-probe` for the model, then `pack-worker start --task ' + c.id + '`', 'check stdin handling and the model id in launch.log', 'reassign the task to the other Flash model']],
  blocked: (c) => [`Blocker ${c.blocker} has failed its two repairs on ${c.id}.`, ['treat it as a product defect: name the owning service and the fix', 'the brief expects the wrong behaviour: issue a new brief version', `park ${c.id} and reassign`]],
  'needs-senior': (c) => [`${c.id} is waiting on: ${c.qs.join('; ')}.`, ['answer in the task QUESTIONS.md, then `pack-worker instruct --task ' + c.id + ' "answer is in QUESTIONS.md; continue"`', 'if it needs the owner, put it under "Decisions I need from you" in CURRENT.md']],
  'out-of-scope-writes': (c) => [`${c.id} changed files outside its Owns: ${c.outside.join(', ')}.`, [`stop ${c.id} and reassign the files to their owner`, 'extend Owns with a new brief version if the change is right', 'revert the out-of-scope files']],
  'doom-loop': (c) => [`${c.id} is looping (${c.loop}).`, [`\`pack-worker stop --task ${c.id}\` then instruct with a narrower next step (same session)`, 'relaunch once with a smaller brief', 'reassign to the other Flash model after one failed relaunch']],
  'running-stale': (c) => [`${c.id} is alive but has produced nothing for ${c.age}.`, [`\`pack-worker tail --task ${c.id}\` and read the last events`, `\`pack-worker instruct --task ${c.id} "write STATUS and continue"\` (queued to INBOX)`, `\`pack-worker stop --task ${c.id}\` and relaunch from STATUS`]],
  'exited-no-report': (c) => [`${c.id} exited (${c.reason}) without a REPORT at needs-review.`, [`check \`git status\` in the checkout, then \`pack-worker instruct --task ${c.id} "resume from STATUS next_action"\` (same session)`, 'relaunch fresh if the session overflowed (ContextOverflowError)']],
  'review-exhausted': (c) => [`${c.id} failed ${cfg.limits.max_review_rounds} review rounds.`, ['give the owner 2–3 options with a recommendation', `park ${c.id}`]],
  'exited-ok-needs-review': (c) => [`${c.id} handed back and is waiting for review.`, [`run REVIEW-CHECKLIST: \`pack-worker scope --task ${c.id}\`, re-run its tests, then \`pack-worker review --task ${c.id} --result pass|changes\``, 'if changes: write R- items in its QUESTIONS.md and `pack-worker instruct` (same session)', `then \`pack-worker ack --escalation <E-id>\` while the review is in progress`]],
  'ready-to-start': (c) => [`${c.id} is ready to start${c.deps?.length ? ` (${c.deps.join(', ')} done)` : ''}.`, [`\`pack-worker start --task ${c.id}\``, 'run `pack-probe` first only when diagnosing a provider problem', `\`pack-worker ack --escalation <E-id>\` if it must wait (say why in CURRENT.md)`]],
};

async function classify(t, probes, blockers, roster) {
  const flags = [];
  const nowMs = now().getTime();
  const dir = t.task_dir || pp.taskDir(t.id);
  const alive = pidAlive(t.pid);
  const runFile = path.join(dir, 'run.jsonl');
  const diagnostics = attemptDiagnostics(dir, t);
  const ev = summarize(diagnostics.events);
  const sessionFromLog = ev.sessionID;
  let kind = 'escalation';
  const tail = diagnostics.raw;
  const st = parseStatusHeader(readText(path.join(dir, 'STATUS.md'), ''));
  const qs = parseQuestions(readText(path.join(dir, 'QUESTIONS.md'), ''));
  const rep = checkReport(readText(path.join(dir, 'REPORT.md'), ''));
  const exitInfo = readJson(path.join(dir, 'exit.json'), null);
  const gi = args['no-git'] || !t.checkout || t.checkout === dir ? { available: false, changedFiles: [] } : gitInfo(t.checkout);
  let lastAt = Math.max(ev.lastEventAt || 0, ev.lastToolAt || 0);
  try { lastAt = Math.max(lastAt, fs.statSync(runFile).mtimeMs); } catch {}
  if (!args['no-db'] && (!t.tool || t.tool === 'opencode') && t.session_id) { const db = await lastActivity(t.session_id); const dbTs = db ? parseTs(db.last_part || db.time_updated) : null; if (dbTs) lastAt = Math.max(lastAt, dbTs); }
  if (!lastAt && t.started_at) lastAt = parseTs(t.started_at) || 0;
  const silentMs = lastAt ? nowMs - lastAt : null;
  if (st.loose) flags.push('status-loose');
  if (!st.ok && fs.existsSync(path.join(dir, 'STATUS.md'))) flags.push('status-unparsable');
  if (t.pending_instruction && alive) flags.push('pending-instruction');
  const stAge = ageMinutes(st.fields.updated);
  if (alive && stAge != null && stAge > cfg.limits.status_stale_minutes) flags.push('status-stale');
  const outside = gi.available && (t.owns || []).length ? outsideOwns(gi.changedFiles, t.owns).filter((f) => !/^node_modules\//.test(f)) : [];
  const provErr = classifyProviderError(ev.errors.join('\n')) || classifyProviderError(tail);
  const probe = probes[modelSlug(t.model)];
  const probeFresh = probe && ageMinutes(probe.checked_at) != null && ageMinutes(probe.checked_at) <= cfg.limits.probe_max_age_minutes;
  const openQs = qs.filter((q) => !q.answered);
  const blk = st.blocker;
  const blockerHit = (blk && blk.n != null && blk.m != null && blk.n >= blk.m ) || (blk && blockers[blk.id]?.stopped) || st.fields.state === 'blocked' || t.state === 'blocked';
  const terminal = ['done', 'stopped'].includes(t.state) || st.fields.state === 'parked';
  let cls = null, to = null, question = null, options = [], failure = null;
  const ctx = { id: t.id, model: t.model };
  if (!terminal && ((probe && probeFresh && probe.result !== 'ok') || (!alive && provErr && ['credits', 'auth', 'connect'].includes(provErr) && t.state !== 'done'))) {
    cls = 'probe-failed'; ctx.kind = probe && probeFresh && probe.result !== 'ok' ? probe.result : provErr;
    to = ctx.kind === 'connect' ? 'orchestrator' : 'owner'; failure = probe?.excerpt || ev.errors.slice(-1)[0] || clip(tail.split('\n').filter((l) => /error|Error/.test(l)).slice(-3).join('\n'), 800);
  } else if (!terminal && t.state === 'launch-failed') { cls = 'launch-failed'; to = 'orchestrator'; failure = exitInfo ? `${exitInfo.reason} (events ${exitInfo.events}, code ${exitInfo.code})` : 'banner-only exits'; }
  else if (!terminal && blockerHit) { cls = 'blocked'; ctx.blocker = blk?.id || 'unknown'; to = blk?.setup ? 'orchestrator' : 'senior'; failure = `${st.fields.blocker || t.state}; ${clip(ev.errors.slice(-1)[0] || '', 400)}`; }
  else if (!terminal && (openQs.length || st.needsOwner || st.fields.state === 'needs-owner' || t.state === 'needs-owner')) {
    cls = 'needs-senior'; ctx.qs = openQs.map((q) => `${q.id} ${q.title}`);
    const tags = new Set(openQs.map((q) => q.tag));
    to = st.needsOwner || st.fields.state === 'needs-owner' || t.state === 'needs-owner' || tags.has('owner') ? 'owner' : tags.size === 1 && tags.has('orchestrator') ? 'orchestrator' : 'senior';
    if (!openQs.length) ctx.qs = [st.fields.next_action || 'needs the owner'];
    failure = openQs.map((q) => `${q.id}: ${q.title}\n${clip(q.body.join('\n').trim(), 300)}`).join('\n\n') || st.fields.next_action;
  } else if (!terminal && outside.length) { cls = 'out-of-scope-writes'; ctx.outside = outside.slice(0, 8); to = 'orchestrator'; failure = outside.join('\n'); }
  else if (alive && (ev.maxIdentical >= cfg.limits.doom_identical_calls || ev.maxTextRun >= cfg.limits.doom_text_run)) { cls = 'doom-loop'; ctx.loop = ev.maxIdentical >= cfg.limits.doom_identical_calls ? `${ev.maxIdentical} identical tool calls` : `${ev.maxTextRun} text turns with no tool call`; to = 'orchestrator'; failure = ev.lastTexts.join('\n') || ctx.loop; }
  else if (alive && silentMs != null && silentMs >= staleMin * 60000) { cls = 'running-stale'; ctx.age = fmtAge(silentMs); to = 'orchestrator'; failure = `last event ${ctx.age} ago; last texts: ${ev.lastTexts.join(' | ')}`; }
  else if (alive) cls = 'running-healthy';
  else if (terminal) cls = t.state === 'done' ? 'done' : st.fields.state === 'parked' ? 'parked' : 'stopped';
  else if (t.state === 'queued' && !t.pid && !exitInfo) {
    const deps = t.needs_first || [];
    const ready = deps.every((d) => findTask(roster, d)?.state === 'done');
    if (ready) { cls = 'ready-to-start'; kind = 'action'; to = 'orchestrator'; ctx.deps = deps; failure = deps.length ? `dependencies done: ${deps.join(', ')}` : 'no dependencies'; }
    else { cls = 'queued'; ctx.waiting = deps.filter((d) => findTask(roster, d)?.state !== 'done'); }
  }
  else if (rep.present && ['needs-review', 'done'].includes(st.fields.state)) {
    cls = 'exited-ok-needs-review';
    if (!rep.hasPastedOutput) flags.push('report-missing-test-output');
    if ((t.review_round || 0) >= cfg.limits.max_review_rounds) { flags.push('review-exhausted'); to = 'owner'; failure = `review rounds ${t.review_round}/${cfg.limits.max_review_rounds}`; }
    else { kind = 'action'; to = 'orchestrator'; failure = `REPORT.md present${rep.hasPastedOutput ? '' : ' (no pasted test output)'}; STATUS ${st.fields.state}`; }
  } else { cls = 'exited-no-report'; ctx.reason = exitInfo?.reason || t.state; to = 'orchestrator'; failure = `${ctx.reason}; STATUS state ${st.fields.state || 'none'}; exit code ${exitInfo?.code ?? t.exit_code}; ${clip(ev.errors.slice(-1)[0] || ev.lastTexts.slice(-1)[0] || '', 400)}`; }
  if (to) { const tpl = ROUTE_TEMPLATES[flags.includes('review-exhausted') ? 'review-exhausted' : cls]; if (tpl) [question, options] = tpl(ctx); }
  const lockPath = path.join(cfg.root, '.agent-workpacks', 'locks', sha1(safeReal(t.checkout || dir)).slice(0, 12));
  if (fs.existsSync(lockPath)) { const o = readJson(lockPath, {}); if (o.task === t.id && !alive && !pidAlive(o.pid) && !pidAlive(o.supervisor_pid)) flags.push('lock-orphaned'); }
  return { id: t.id, cls, kind, to, flags, silentMs, lastAt: lastAt || null, alive, failure: failure ? redact(clip(failure, 1500)) : null, question, options, ev, sessionFromLog, st, rep, exitInfo, openQs, outside, ctx };
}

// Tasks that have a folder and a brief but were never started are queued work the orchestrator must see.
function syntheticQueuedRows(roster) {
  const rows = [];
  if (!fs.existsSync(pp.tasks)) return rows;
  for (const id of fs.readdirSync(pp.tasks)) {
    if (id.startsWith('_') || id.startsWith('.') || findTask(roster, id)) continue;
    const bp = path.join(pp.tasks, id, 'BRIEF.md');
    if (!fs.existsSync(bp)) continue;
    const b = parseBrief(readText(bp, ''));
    const role = b.header.role || 'coder';
    rows.push({ id, state: 'queued', task_dir: pp.taskDir(id), brief_path: bp, needs_first: b.header.needsFirst, model: cfg.models[role] || cfg.models.coder, role, owns: b.owns.files, checkout: null, pid: null, synthetic: true });
  }
  return rows;
}
function safeReal(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

function acceptanceExcerpt(t) {
  const md = readText(t.brief_path || path.join(t.task_dir || pp.taskDir(t.id), 'BRIEF.md'), '');
  const lines = md.split('\n'); const i = lines.findIndex((l) => /^##\s*Tests/i.test(l));
  if (i < 0) return '(no Tests section)';
  const out = []; for (let j = i + 1; j < lines.length && out.length < 5 && !/^##\s/.test(lines[j]); j++) if (lines[j].trim()) out.push(lines[j]);
  return out.join('\n');
}

function renderPacket(e, t) {
  const rel = (p) => (p ? path.relative(pp.root, p) : '-');
  return [
    `## ${e.id} · ${e.task} · ${e.class} · to: ${e.to} · opened ${e.opened_at}${e.acked_at ? ` · acknowledged ${e.acked_at}` : ''}`,
    `- **Task:** ${t?.title || e.task} — brief \`${rel(t?.brief_path)}\`, checkout \`${t?.checkout ? path.relative(cfg.root, t.checkout) : '-'}\` @ \`${t?.branch || '-'}\``,
    `- **Acceptance (excerpt):**`, ...acceptanceExcerpt(t || { id: e.task }).split('\n').map((l) => `  ${l}`),
    `- **Exact failure:**`, '  ```', ...String(e.failure || '(none recorded)').split('\n').slice(0, 20).map((l) => `  ${l}`), '  ```',
    `- **Attempts so far:** ${e.attempts}`,
    `- **Worker hypothesis (last text events):** ${e.hypothesis.length ? e.hypothesis.map((h) => `"${h}"`).join(' / ') : '(none)'}`,
    `- **Question:** ${e.question}`,
    `- **Options:** ${e.options.map((o, i) => `(${String.fromCharCode(97 + i)}) ${o}`).join(' ')}`,
    `- **Files:** \`${rel(path.join(t?.task_dir || pp.taskDir(e.task), 'STATUS.md'))}\`, \`${rel(path.join(t?.task_dir || pp.taskDir(e.task), 'run.jsonl'))}\`${t?.checkout && t.checkout !== t.task_dir ? `, \`git -C ${path.relative(cfg.root, t.checkout)} diff --stat\`` : ''}`,
    `- **Answer here:** \`${rel(path.join(t?.task_dir || pp.taskDir(e.task), 'QUESTIONS.md'))}\` under the Q heading as \`**A (${e.to === 'owner' ? 'owner' : 'consultant <model>'}, <HH:MM>):**\`, then \`pack-worker instruct --pack ${pp.root} --task ${e.task} "answer is in QUESTIONS.md; continue from next_action"\``,
    '',
  ].join('\n');
}

async function sweep() {
  const roster = loadRoster(pp);
  const blockers = readJson(pp.blockers, {});
  const probes = {};
  if (fs.existsSync(pp.control)) for (const f of fs.readdirSync(pp.control)) { const m = f.match(/^probe-(.+)\.json$/); if (m) probes[m[1]] = readJson(path.join(pp.control, f), null); }
  const results = [];
  const rows = [...roster.tasks, ...syntheticQueuedRows(roster)];
  for (const t of rows) results.push(await classify(t, probes, blockers, roster));
  // items: escalations (need a decision) and actions (routine work for the orchestrator); both stay listed until
  // the condition clears, and `ack` marks them as being handled so --changed-only sweeps go quiet
  const esc = readJson(pp.escalations, { version: 1, next: 1, items: [] });
  const openNow = new Set();
  for (const r of results) {
    if (!r.to) continue;
    const t = rows.find((t) => t.id === r.id);
    // Identity describes the condition, never its changing age or diagnostic prose.
    const generation = [t?.attempts || 0, t?.history?.at(-1)?.started_at || t?.started_at || 'queued'];
    const condition = r.cls === 'needs-senior' ? r.openQs.map((q) => [q.id, q.tag]).sort()
      : r.cls === 'blocked' ? r.st.blocker?.id || 'blocked'
      : r.cls === 'out-of-scope-writes' ? [...r.outside].sort()
      : r.cls === 'probe-failed' ? r.ctx.kind
      : r.cls === 'ready-to-start' ? sha1(readText(t?.brief_path, '')) : null;
    const fp = sha1(JSON.stringify([2, r.id, generation, r.cls, r.to, condition]));
    let item = esc.items.find((e) => e.fingerprint === fp && e.status === 'open');
    if (!item) {
      item = { id: `E-${roster.pfx || cfg.pfx}-${String(esc.next++).padStart(3, '0')}`, fingerprint: fp, kind: r.kind, task: r.id, class: r.cls, to: r.to, opened_at: iso(), status: 'open', resolved_at: null, acked_at: null, acked_note: null, question: r.question, options: r.options, failure: r.failure, attempts: '', hypothesis: r.ev.lastTexts.map((x) => redact(x)), files: [], answered_at: null, answer_first_line: null, last_seen: iso() };
      esc.items.push(item);
    }
    item.failure = r.failure; item.last_seen = iso(); item.to = r.to; item.question = r.question; item.options = r.options;
    item.attempts = `launches ${t?.attempts ?? 0} · repairs ${t?.repair_attempts ?? 0}/${cfg.limits.max_repairs_per_blocker} · review rounds ${t?.review_round ?? 0}`;
    item.hypothesis = r.ev.lastTexts.map((x) => redact(x));
    openNow.add(item.id); r.escalationId = item.id;
  }
  for (const e of esc.items) if (e.status === 'open' && !openNow.has(e.id)) { e.status = 'resolved'; e.resolved_at = iso(); const r = results.find((x) => x.id === e.task); const q = r?.openQs?.length === 0 ? parseQuestions(readText(path.join(findTask(roster, e.task)?.task_dir || pp.taskDir(e.task), 'QUESTIONS.md'), '')).filter((x) => x.answered).slice(-1)[0] : null; if (q) { e.answered_at = iso(); e.answer_first_line = clip((q.body.find((l) => /^\s*\*\*(A\s*\(|ANSWER)/i.test(l)) || '').trim(), 200); } }
  atomicWriteJson(pp.escalations, esc);
  const openItems = esc.items.filter((e) => e.status === 'open').sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1));
  // roster: sweep-owned fields only
  updateRoster(pp, (r) => { for (const res of results) { const t = findTask(r, res.id); if (!t) continue; t.last_event_at = res.lastAt ? new Date(res.lastAt).toISOString() : t.last_event_at; t.last_tool_at = res.ev.lastToolAt ? new Date(res.ev.lastToolAt).toISOString() : t.last_tool_at; t.last_sweep_class = res.cls; t.flags = res.flags; t.needs_senior = res.to === 'senior'; t.escalation_id = res.escalationId || null; t.sweep_updated_at = iso(); if (!t.session_id && res.sessionFromLog) t.session_id = res.sessionFromLog; if (res.rep.present && !t.report_path) t.report_path = path.join(t.task_dir || pp.taskDir(t.id), 'REPORT.md'); } });
  // coverage gap
  const prev = (readText(pp.sweepLog, '').trim().split('\n').filter(Boolean).slice(-1)[0]) || null;
  let coverageGap = false;
  if (prev) { try { const p = JSON.parse(prev); const gap = ageMinutes(p.ts); if (gap != null && gap > 2 * cfg.limits.sweep_interval_minutes) coverageGap = true; } catch {} }
  const running = results.filter((r) => r.cls === 'running-healthy' || r.cls === 'running-stale' || r.cls === 'doom-loop').length;
  const needsReview = results.filter((r) => r.cls === 'exited-ok-needs-review').length;
  const escalations = openItems.filter((e) => e.kind !== 'action');
  const actions = openItems.filter((e) => e.kind === 'action');
  const unacked = openItems.filter((e) => !e.acked_at);
  const classHash = sha1(JSON.stringify(results.map((r) => [r.id, r.cls, [...r.flags].sort(), r.to, r.escalationId || null])) + (coverageGap ? '|gap' : ''));
  const prevHash = readText(path.join(pp.control, '.sweep-hash'), '').trim();
  const changed = classHash !== prevHash;
  const openHash = sha1(openItems.map((e) => `${e.id}:${e.acked_at ? 'a' : 'u'}`).sort().join(','));
  const prevOpenHash = readText(path.join(pp.control, '.escalations-hash'), '').trim();
  const escChanged = openHash !== prevOpenHash;
  // Exit 10 means "someone must act". Without --changed-only every open item counts; with it only items nobody has
  // acknowledged with `pack-worker ack`, so a scheduled model is woken once per new item, not once per tick.
  const exit = args['changed-only'] ? (unacked.length ? 10 : 0) : (openItems.length ? 10 : 0);
  const stamp = iso();
  const summaryLine = `last_sweep: ${stamp} · ${running} running · ${needsReview} needs-review · ${escalations.length} escalations · ${actions.length} actions · ${unacked.length} unacknowledged · exit ${exit}${coverageGap ? ' · COVERAGE GAP' : ''}${isDeepseekPeak() ? ' · DeepSeek peak hours' : ''}`;
  const table = ['| ID | state | class | worker | last event | silent for | PR / head | next action (who) |', '|---|---|---|---|---|---|---|---|',
    ...results.map((r) => { const t = findTask(roster, r.id) || {}; return `| ${r.id} | ${t.state || 'queued'} | ${r.cls}${r.flags.length ? ' (' + r.flags.join(', ') + ')' : ''} | ${(t.model || '').replace('opencode-go/', '') || '-'}${t.pid && r.alive ? ` pid ${t.pid}` : ''} | ${r.lastAt ? new Date(r.lastAt).toISOString().slice(11, 16) + 'Z' : '-'} | ${fmtAge(r.silentMs)} | ${t.pr || t.head || '-'} | ${r.escalationId ? `${r.escalationId} → ${r.to}` : r.cls === 'queued' ? `waiting for ${(r.ctx.waiting || []).join(', ')}` : r.st.fields.next_action ? clip(r.st.fields.next_action, 60) + ' (worker)' : '-'} |`; })];
  if (changed || escChanged || !fs.existsSync(pp.sweepMd)) {
    const summary = [`${running} task(s) running${results.some((r) => r.cls === 'running-stale') ? ', some silent' : ' fine'}; ${needsReview} finished and waiting for review.`, `${escalations.length} escalation(s) need a decision and ${actions.length} routine action(s) wait for the orchestrator; ${unacked.length} not yet acknowledged${openItems.length ? ': ' + openItems.map((e) => `${e.id} (${e.task}, ${e.class}, ${e.to}${e.acked_at ? ', acked' : ''})`).join(', ') : ''}.`, `${results.filter((r) => r.cls === 'queued').length} queued behind dependencies, ${results.filter((r) => ['done', 'stopped', 'parked'].includes(r.cls)).length} finished or parked${coverageGap ? '; the sweep itself missed at least one interval (coverage gap)' : ''}.`];
    atomicWriteText(pp.sweepMd, `# Sweep — ${pp.name} — ${stamp}\n\n${table.join('\n')}\n\n**Summary**\n1. ${summary[0]}\n2. ${summary[1]}\n3. ${summary[2]}\n`);
    const section = (title, items) => `## ${title} (${items.length})\n\n${items.map((e) => renderPacket(e, findTask(roster, e.task))).join('\n') || '_none_\n'}`;
    atomicWriteText(pp.escalationsMd, `# Escalations — ${pp.name} — ${openItems.length} open, ${unacked.length} unacknowledged (updated ${stamp})\n\nAcknowledge an item you are handling with \`pack-worker ack --pack ${pp.root} --escalation <E-id>\`; it stays listed until the condition clears.\n\n${section('Needs a decision', escalations)}\n${section('Needs routine action', actions)}`);
    atomicWriteText(path.join(pp.control, '.sweep-hash'), classHash + '\n');
    atomicWriteText(path.join(pp.control, '.escalations-hash'), openHash + '\n');
  }
  // CURRENT.md: last_sweep line + tasks block only
  let cur = readText(pp.current, `# Current state — ${pp.name}\nupdated: ${stamp} · by: sweep\nlast_sweep: never\n## Tasks\n<!-- tasks:begin -->\n<!-- tasks:end -->\n## Next action and who does it\n- \n`);
  if (/^last_sweep:.*$/m.test(cur)) cur = cur.replace(/^last_sweep:.*$/m, summaryLine); else cur = cur.replace(/^(# .*\n)/, `$1${summaryLine}\n`);
  if (/<!-- tasks:begin -->[\s\S]*?<!-- tasks:end -->/.test(cur)) cur = cur.replace(/<!-- tasks:begin -->[\s\S]*?<!-- tasks:end -->/, `<!-- tasks:begin -->\n${table.join('\n')}\n<!-- tasks:end -->`);
  atomicWriteText(pp.current, cur);
  appendLine(pp.sweepLog, JSON.stringify({ ts: stamp, exit, running, needs_review: needsReview, escalations_open: escalations.length, actions_open: actions.length, unacked: unacked.length, classes: Object.fromEntries(results.map((r) => [r.id, r.cls])), changed, coverage_gap: coverageGap, duration_ms: Date.now() - T0 }));
  const payload = { ok: true, exit, changed, escalations_changed: escChanged, running, needs_review: needsReview, unacked: unacked.length, escalations: openItems.map((e) => ({ id: e.id, kind: e.kind, task: e.task, class: e.class, to: e.to, acked: !!e.acked_at })), tasks: results.map((r) => ({ id: r.id, class: r.cls, kind: r.to ? r.kind : null, to: r.to, flags: r.flags, silent: fmtAge(r.silentMs), alive: r.alive })), coverage_gap: coverageGap, duration_ms: Date.now() - T0 };
  if (json) console.log(JSON.stringify(payload, null, 2));
  else if (quiet) console.log(summaryLine);
  else { console.log(summaryLine); for (const r of results) console.log(`  ${r.id}\t${r.cls}${r.flags.length ? ' [' + r.flags.join(',') + ']' : ''}${r.escalationId ? `\t${r.escalationId} → ${r.to}` : ''}`); if (openItems.length) console.log(`  see ${path.relative(process.cwd(), pp.escalationsMd)}`); }
  return exit;
}

try {
  const code = await withLockAsync(pp.sweepLock, () => sweep(), { timeoutMs: 1500 });
  process.exit(code);
} catch (e) {
  if (/lock busy/.test(e.message)) { if (!quiet) console.log('another sweep is running'); process.exit(0); }
  console.error(`sweep error: ${e.stack || e.message}`); process.exit(2);
}
