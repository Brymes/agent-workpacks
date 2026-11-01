// Native CLI adapters. Credentials remain in each CLI's own authentication store.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { OC_BIN, CLAUDE_BIN, CODEX_BIN, NODE_BIN, ensureDir, atomicWriteJson, atomicWriteText, findBinary } from './paths.mjs';
import { WORKER_REMOTE_DENY, DESTRUCTIVE_BASH, TASK_READ_ONLY_FILES } from './permission.mjs';

export const RUNTIMES = ['opencode', 'claude', 'codex'];
export function requireRuntime(tool) {
  if (!RUNTIMES.includes(tool)) throw new Error(`unsupported worker runtime ${tool}; choose ${RUNTIMES.join(', ')}`);
  return tool;
}
export function runtimeBinary(tool) { return { opencode: OC_BIN, claude: CLAUDE_BIN, codex: CODEX_BIN }[requireRuntime(tool)]; }

function guardPath(taskDir) {
  const dir = ensureDir(path.join(taskDir, 'runtime', 'bin'));
  // Common command guardrails supplement native permissions; they are not an OS sandbox.
  for (const command of ['git', 'gh']) {
    const binary = findBinary(command);
    const source = `#!${NODE_BIN}\nimport {spawnSync} from 'node:child_process';\nconst a=process.argv.slice(2);\nconst denied=${JSON.stringify(command)}==='git'?a.includes('push'):a.some(x=>['pr','release','repo','api','workflow','run','secret','variable'].includes(x));\nif(denied){console.error('agent-workpacks: worker remote operation denied');process.exit(126);}\nconst r=spawnSync(${JSON.stringify(binary)},a,{stdio:'inherit'});process.exit(r.status??1);\n`;
    const file = path.join(dir, command); atomicWriteText(file, source); fs.chmodSync(file, 0o755);
  }
  return dir;
}

function claudeSettings(row) {
  const patterns = row.owns.map((raw) => raw.replace(/\s*\(new\)\s*$/i, '').replace(/`/g, '').trim());
  const allow = ['Read', 'Glob', 'Grep', 'Bash'];
  for (const p of patterns) {
    const abs = path.resolve(row.checkout, p).replace(/\/$/, '/**');
    allow.push(`Edit(/${abs})`);
  }
  allow.push(`Edit(/${row.task_dir}/**)`);
  const deny = [...WORKER_REMOTE_DENY, ...DESTRUCTIVE_BASH].map((p) => `Bash(${p})`);
  deny.push('Agent', 'Task', 'Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/id_rsa*)');
  for (const f of TASK_READ_ONLY_FILES) deny.push(`Edit(/${row.task_dir}/${f})`);
  if (['researcher', 'docs'].includes(row.role)) allow.push('WebFetch', 'WebSearch');
  return { permissions: { allow, deny } };
}

function openCodeV2Permissions(permission, cfg) {
  // V1 maps were first-match; V2 is an ordered last-match array with different action names.
  const names = { bash: 'shell', task: 'subagent' };
  const rules = [];
  for (const [action, values] of Object.entries(permission)) {
    if (['doom_loop', 'lsp'].includes(action)) continue;
    const entries = typeof values === 'string' ? [['*', values]] : Object.entries(values).reverse();
    for (const [resource, effect] of entries) rules.push({ action: names[action] || action, resource, effect });
  }
  rules.push({ action: 'subagent', resource: '*', effect: 'deny' });
  // Briefs, reports and acceptance scripts can live outside the assigned Git worktree.
  // Their edit permissions remain independently bounded by Owns.
  rules.push({ action: 'external_directory', resource: path.join(cfg.root, '*'), effect: 'allow' });
  return rules;
}

export function buildInvocation({ row, cfg, session, prompt, permission }) {
  const tool = requireRuntime(row.tool || 'opencode');
  const binary = runtimeBinary(tool);
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.error || version.status !== 0) throw new Error(`${tool} executable unavailable: ${version.error?.message || version.stderr || 'version check failed'}`);
  const env = { ...process.env, AWP_TASK_ID: row.id, AWP_TASK_DIR: row.task_dir };
  env.PATH = guardPath(row.task_dir) + path.delimiter + (process.env.PATH || '');
  const dir = ensureDir(path.join(row.task_dir, 'runtime'));
  if (tool !== 'opencode') { delete env.OPENCODE_PERMISSION; delete env.OPENCODE_CONFIG_CONTENT; }
  if (tool === 'opencode') {
    const major = Number(String(version.stdout || '').match(/(?:^|\s)v?(\d+)\./)?.[1] || 0);
    const args = ['run'];
    // A shared daemon does not inherit a later client's task-specific environment.
    if (major >= 2) args.push('--standalone');
    if (major < 2) args.push('--dir', cfg.root);
    let model = row.model;
    if (major >= 2 && row.variant && model && !model.includes('#')) model += `#${row.variant}`;
    if (model) args.push('--model', model);
    if (major < 2 && row.variant) args.push('--variant', row.variant);
    args.push('--title', row.title || row.id, '--format', 'json', '--auto');
    const agent = major >= 2 ? (row.agent || 'awp-worker') : row.agent;
    if (agent) args.push('--agent', agent);
    if (session) args.push('--session', session);
    args.push(prompt);
    if (major >= 2) {
      delete env.OPENCODE_PERMISSION;
      const previous = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
      const rules = openCodeV2Permissions(permission, cfg);
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        ...previous,
        permissions: [...(previous.permissions || []), ...rules],
        agents: { ...(previous.agents || {}), [agent]: { ...(previous.agents?.[agent] || {}), mode: 'primary', description: 'One bounded Agent Workpacks assignment', permissions: rules } },
      });
    } else env.OPENCODE_PERMISSION = JSON.stringify(permission);
    return { binary, args, env, session: session || null };
  }
  if (tool === 'claude') {
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.CLAUDE_SESSION_ID;
    const settings = path.join(dir, 'claude-settings.json'); atomicWriteJson(settings, claudeSettings(row));
    const id = session || crypto.randomUUID();
    const args = ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--settings', settings, '--add-dir', row.task_dir];
    args.push(session ? '--resume' : '--session-id', id);
    if (row.model) args.push('--model', row.model);
    if (row.variant) args.push('--effort', row.variant);
    args.push(prompt);
    return { binary, args, env, session: id };
  }
  const args = ['exec'];
  if (session) args.push('resume', session);
  args.push('--json', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=false', '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([row.task_dir])}`);
  if (!session) args.push('--sandbox', 'workspace-write');
  if (row.model) args.push('--model', row.model);
  if (row.variant) args.push('-c', `model_reasoning_effort=${JSON.stringify(row.variant)}`);
  args.push(prompt);
  return { binary, args, env, session: session || null };
}
