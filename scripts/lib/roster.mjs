// Pack config and roster: single-writer-per-field JSON under a mkdir lock, written atomically.
import { readJson, atomicWriteJson, withLock, DEFAULT_ROOT } from './paths.mjs';
import { iso } from './time.mjs';

export const TASK_STATES = ['queued', 'running', 'exited', 'stopped', 'launch-failed', 'blocked', 'needs-review', 'needs-owner', 'done'];
export const ROLES = ['coder', 'researcher', 'verifier', 'docs', 'probe'];

export const DEFAULT_CONFIG = {
  version: 1,
  root: DEFAULT_ROOT,
  pack: null,
  pfx: 'DP',
  git_mode: 'commit-only',
  merge_target: 'main',
  limits: {
    max_workers: 10, memory_gate_min_free_pct: 25, stale_minutes: 20, status_stale_minutes: 90,
    banner_timeout_s: 60, doom_identical_calls: 3, doom_text_run: 5, probe_max_age_minutes: 60,
    sweep_interval_minutes: 15, max_review_rounds: 3, max_repairs_per_blocker: 2,
  },
  protected_branches: ['main', 'master'],
  default_tool: 'opencode',
  project_policy: { type: 'none' },
  runtime_defaults: { claude: {}, codex: {} },
  models: {
    coder: 'opencode-go/deepseek-v4.1-flash', researcher: 'opencode-go/glm-5.3-flash',
    verifier: 'opencode-go/deepseek-v4.1-flash', docs: 'opencode-go/glm-5.3-flash',
  },
  agents: {},
  default_variant: 'high',
  notify: { osascript: true, title: 'agent-workpacks' },
};

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
}
export function loadConfig(pp) {
  const saved = readJson(pp.config);
  if (!saved || Array.isArray(saved) || typeof saved !== 'object' || typeof saved.root !== 'string' || !saved.root.trim()) throw new Error('pack configuration must be an object with an explicit project root');
  const c = deepMerge(DEFAULT_CONFIG, saved);
  // Packs from the original controller required DDD approval for code. Missing new configuration must not weaken it.
  if (!Object.hasOwn(saved, 'project_policy')) c.project_policy = { type: 'ddd' };
  if (!c.pack) c.pack = pp.root;
  return c;
}

export function emptyRoster(pp, pfx) { return { version: 1, pack: pp.root, pfx: pfx || null, updated_at: iso(), tasks: [] }; }
export function loadRoster(pp) {
  const roster = readJson(pp.roster);
  if (!roster || Array.isArray(roster) || typeof roster !== 'object' || !Array.isArray(roster.tasks)) throw new Error('pack roster must contain a tasks array; restore the saved state before continuing');
  return roster;
}
export function saveRoster(pp, r) { r.updated_at = iso(); atomicWriteJson(pp.roster, r); }
export function updateRoster(pp, fn) {
  return withLock(pp.rosterLock, () => { const r = loadRoster(pp); const res = fn(r); saveRoster(pp, r); return res; });
}
export function findTask(r, id) { return r.tasks.find((t) => t.id === id) || null; }

export function newTaskRow(fields) {
  return {
    id: null, title: null, role: 'coder', tool: 'opencode', model: null, variant: 'high', agent: null,
    checkout: null, branch: null, base: null, owns: [], needs_first: [],
    brief_path: null, brief_sha256: null, task_dir: null,
    session_id: null, previous_sessions: [], pid: null, supervisor_pid: null,
    started_at: null, last_event_at: null, last_tool_at: null, exit_code: null, exited_at: null,
    attempts: 0, repair_attempts: 0, review_round: 0,
    state: 'queued', last_sweep_class: null, flags: [], pending_instruction: false,
    report_path: null, pr: null, head: null, needs_senior: false, escalation_id: null,
    history: [],
    ...fields,
  };
}
