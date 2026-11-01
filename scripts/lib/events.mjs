// Tolerant parser for `opencode run --format json` output (one JSON object per line; banners and ANSI ignored).
import fs from 'node:fs';
import { clip } from './paths.mjs';

const KIND_BY_PART = { 'step-start': 'step_start', 'step-finish': 'step_finish', tool: 'tool_use', text: 'text', reasoning: 'reasoning' };

export function parseLine(line) {
  const s = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
  if (!s.startsWith('{')) return null;
  let ev; try { ev = JSON.parse(s); } catch { return null; }
  const base = { kind: null, ts: Date.now(), sessionID: ev.session_id || ev.thread_id || null, tool: null, input: null, status: null, output: null, text: null, reason: null, error: null };
  if (ev.type === 'thread.started') return { ...base, kind: 'step_start' };
  if (ev.type === 'turn.started') return { ...base, kind: 'step_start' };
  if (ev.type === 'turn.completed') return { ...base, kind: 'step_finish', reason: 'stop' };
  if (ev.type === 'turn.failed') return { ...base, kind: 'error', error: ev.error };
  if (/^item\./.test(ev.type || '')) {
    const item = ev.item || {};
    if (item.type === 'agent_message') return { ...base, kind: 'text', text: item.text };
    if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(item.type)) return { ...base, kind: 'tool_use', tool: item.type, input: item.command || item.arguments || item.changes, status: item.status || ev.type, output: item.aggregated_output || item.error };
    return { ...base, kind: 'reasoning' };
  }
  if (ev.type === 'system' && ev.session_id) return { ...base, kind: ev.subtype === 'init' ? 'step_start' : 'system' };
  if (ev.type === 'result' && ev.session_id) return { ...base, kind: ev.is_error ? 'error' : 'step_finish', reason: ev.is_error ? ev.subtype : 'stop', text: ev.result, error: ev.is_error ? (ev.errors || ev.result || ev.subtype) : null };
  if (['assistant', 'user'].includes(ev.type) && ev.message) {
    const content = Array.isArray(ev.message.content) ? ev.message.content : [];
    const tool = content.find((p) => p.type === 'tool_use' || p.type === 'tool_result');
    if (tool) return { ...base, kind: 'tool_use', tool: tool.name || tool.tool_use_id, input: tool.input || null, output: tool.content || null, status: tool.is_error ? 'error' : tool.type };
    return { ...base, kind: 'text', text: content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') };
  }
  if ((ev.type || '').startsWith('session.')) {
    const data = ev.data || ev.properties || ev;
    const map = { 'session.step.started': 'step_start', 'session.step.ended': 'step_finish', 'session.execution.succeeded': 'step_finish', 'session.execution.failed': 'error', 'session.tool.called': 'tool_use', 'session.tool.success': 'tool_use', 'session.tool.failed': 'tool_use', 'session.text.delta': 'text', 'session.text.ended': 'text' };
    return { ...base, kind: map[ev.type] || 'system', sessionID: data.sessionID || data.session_id || null, tool: data.tool || data.name || null, input: data.input || null, output: data.output || data.error || null, text: data.text || data.delta || null, reason: /(?:ended|succeeded)$/.test(ev.type) ? 'stop' : null, error: data.error || null };
  }
  const part = ev.part ?? ev;
  const kind = ev.type ?? KIND_BY_PART[part?.type];
  if (!kind) return null;
  if (kind === 'dp_attempt') return { kind, ts: ev.timestamp ?? null, sessionID: ev.sessionID ?? null, attempt: ev.attempt ?? null, tool: null, input: null, status: null, output: null, text: null, reason: null, error: null };
  const ts = ev.timestamp ?? part?.time?.start ?? part?.time?.end ?? null;
  return {
    kind,
    ts: typeof ts === 'number' ? ts : (ts ? Date.parse(ts) || null : null),
    sessionID: ev.sessionID ?? part?.sessionID ?? null,
    tool: part?.tool ?? null,
    input: part?.state?.input ?? null,
    status: part?.state?.status ?? null,
    output: part?.state?.output ?? part?.state?.error ?? null,
    text: part?.text ?? null,
    reason: part?.reason ?? part?.finishReason ?? null,
    error: kind === 'error' ? (ev.error ?? part?.error ?? part) : null,
  };
}

export function readTail(file, maxBytes = 262144, minStart = 0) {
  let fd;
  try {
    const st = fs.statSync(file);
    if (st.size === 0) return '';
    fd = fs.openSync(file, 'r');
    const start = Math.min(st.size, Math.max(0, minStart, st.size - maxBytes));
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > minStart) { const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : ''; }
    return text;
  } catch { return ''; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function readEvents(file, maxBytes = 262144) {
  return readTail(file, maxBytes).split('\n').map(parseLine).filter(Boolean);
}

// The supervisor writes {"type":"dp_attempt","attempt":n,...} at every launch. Health checks (doom loops, stale,
// errors) look only at the current attempt; session capture may look at the whole log.
export function attemptMarkerLine(attempt, kind, sessionID) {
  return JSON.stringify({ type: 'dp_attempt', attempt, kind, timestamp: Date.now(), sessionID: sessionID || null });
}
export function latestAttempt(events) {
  let idx = -1;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === 'dp_attempt') { idx = i; break; }
  return idx >= 0 ? events.slice(idx + 1) : events;
}

export function rawLines(file, maxBytes = 65536) {
  return readTail(file, maxBytes).split('\n').map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).filter((l) => l.trim());
}

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export function summarize(events) {
  let lastEventAt = 0, lastToolAt = 0, firstStepAt = 0, sessionID = null;
  const errors = [], lastTexts = [];
  let identicalRun = 0, maxIdentical = 0, textRun = 0, maxTextRun = 0, prevKey = null, toolCalls = 0, lastFinishReason = null;
  for (const e of events) {
    if (e.ts) lastEventAt = Math.max(lastEventAt, e.ts);
    if (e.sessionID && !sessionID) sessionID = e.sessionID;
    if (e.kind === 'step_start' && !firstStepAt) firstStepAt = e.ts || Date.now();
    if (e.kind === 'step_finish') lastFinishReason = e.reason || lastFinishReason;
    if (e.kind === 'tool_use') {
      toolCalls++; textRun = 0;
      if (e.ts) lastToolAt = Math.max(lastToolAt, e.ts);
      const key = `${e.tool}\u0000${stableStringify(e.input)}`;
      identicalRun = key === prevKey ? identicalRun + 1 : 1;
      prevKey = key;
      maxIdentical = Math.max(maxIdentical, identicalRun);
      if (e.status === 'error') errors.push(clip(e.output, 400));
    }
    if (e.kind === 'text') {
      textRun++; maxTextRun = Math.max(maxTextRun, textRun);
      if (e.text) { lastTexts.push(clip(e.text, 400)); if (lastTexts.length > 3) lastTexts.shift(); }
    }
    if (e.kind === 'error') errors.push(clip(e.error && typeof e.error === 'object' && e.error.message ? `${e.error.name || 'Error'}: ${e.error.message}` : e.error, 400));
  }
  return { count: events.length, toolCalls, lastEventAt, lastToolAt, firstStepAt, sessionID, errors: errors.slice(-5), lastTexts, maxIdentical, maxTextRun, lastFinishReason };
}

export const PROVIDER_ERROR_PATTERNS = [
  ['credits', /run out of credits|spending-limit|insufficient_quota|402 Payment Required|(?:status|statusCode|HTTP\/[\d.]+|code)[\"' :=]+402\b|quota exceeded/i],
  ['bad-model', /Bad Request: \{\\?"model|model not found|unknown model/i],
  ['auth', /ProviderAuthError|Unauthorized|(?:status|statusCode|HTTP\/[\d.]+|code)[\"' :=]+401\b|invalid_grant|token refresh failed|not logged in|invalid api key/i],
  ['connect', /Cannot connect to API|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|SSE read timed out|Streaming response failed|fetch failed/i],
  ['context-overflow', /ContextOverflowError|context length|maximum context/i],
];
export function classifyProviderError(text) {
  for (const [k, re] of PROVIDER_ERROR_PATTERNS) if (re.test(text || '')) return k;
  return null;
}

export function redact(s) {
  if (s == null) return '';
  return String(s)
    .replace(/([A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE)[A-Z0-9_]*\s*[=:]\s*)\S+/gi, '$1<redacted>')
    .replace(/(https?:\/\/)[^\/\s:@]+:[^@\s]+@/g, '$1<redacted>@')
    .replace(/(https?:\/\/[^\s\/]+\/)[^\s]*(api[-_]?key|apikey|token)=[^\s&]+/gi, '$1…<redacted>')
    .replace(/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, '<redacted-token>')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{64,88}\b/g, '<redacted-key>');
}

export function renderEvent(e) {
  const t = e.ts ? new Date(e.ts).toISOString().slice(11, 19) : '--:--:--';
  if (e.kind === 'tool_use') return `${t} tool ${e.tool} ${redact(clip(e.input, 120))} → ${e.status}${e.output ? ' ' + redact(clip(e.output, e.status === 'error' ? 160 : 120)) : ''}`;
  if (e.kind === 'text') return `${t} text ${redact(clip(e.text, 300))}`;
  if (e.kind === 'error') return `${t} ERROR ${redact(clip(e.error, 300))}`;
  if (e.kind === 'step_finish') return `${t} step_finish reason=${e.reason ?? '?'}`;
  return `${t} ${e.kind}`;
}

// Read current stdout AND stderr; byte offsets exclude all previous attempts even when no JSON event arrived.
// Legacy supervisors supplied delimiters instead of offsets. Only marker-free legacy logs use the full tail.
export function attemptDiagnostics(taskDir, task = {}, maxBytes = 262144) {
  const h = (task.history || []).at(-1) || task;
  const read = (name, offset, marker) => {
    let raw = readTail(`${taskDir}/${name}`, maxBytes, Number.isInteger(offset) ? offset : 0);
    if (!Number.isInteger(offset)) {
      const lines = raw.split('\n');
      let i = -1;
      for (let j = lines.length - 1; j >= 0; j--) if (marker(lines[j])) { i = j; break; }
      if (i >= 0) raw = lines.slice(i + 1).join('\n');
    }
    return raw;
  };
  const stdout = read('run.jsonl', h.stdout_start, (l) => parseLine(l)?.kind === 'dp_attempt');
  const stderr = read('launch.log', h.stderr_start, (l) => /^===== LAUNCH /.test(l));
  return { events: latestAttempt(stdout.split('\n').map(parseLine).filter(Boolean)), raw: stdout + '\n' + stderr };
}
