// Pure launch-contract construction and read-only approval validation.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readText, sha256 } from './paths.mjs';
import { normalizeOwn } from './permission.mjs';

export function launchContract(cfg, brief, checkout, role = brief.header.role) {
  return {
    version: 1,
    repo: /^\(/.test(brief.owns.repo || '') ? brief.owns.repo : path.resolve(cfg.root, brief.owns.repo || '.'),
    checkout: path.resolve(checkout), branch: brief.owns.branch,
    base: brief.owns.base || `origin/${cfg.merge_target}`,
    owns: [...new Set(brief.owns.files.map(normalizeOwn))].sort(),
    needs_first: [...new Set(brief.header.needsFirst)].sort(), role,
    lock: (brief.header.lock || '').trim().replace(/\s+/g, ' '),
  };
}

export function validateLock(cfg, lockLine, role) {
  const policy = cfg.project_policy || { type: 'none' };
  if (policy.type === 'none') return;
  if (policy.type === 'command') {
    if (!Array.isArray(policy.command) || !policy.command.length || policy.command.some((v) => typeof v !== 'string')) throw new Error('project_policy.command must be a nonempty argv array');
    const r = spawnSync(policy.command[0], [...policy.command.slice(1), '--root', cfg.root, '--role', role, '--lock', lockLine || 'none'], { cwd: cfg.root, encoding: 'utf8', timeout: 30000 });
    if (r.error || r.status !== 0) throw new Error(`project policy refused launch (exit ${r.status ?? 'spawn error'})`);
    return;
  }
  if (policy.type !== 'ddd') throw new Error(`unknown project policy: ${policy.type}`);
  if (!lockLine) throw new Error('brief is missing its Lock binding');
  if (/^none\b/i.test(lockLine)) {
    if (!['researcher', 'docs', 'verifier'].includes(role)) throw new Error('service-code assignments require a hash-bound DDD lock; none is reserved for research, docs or read-only verification');
    return;
  }
  const match = lockLine.match(/\.ddd-guard\/([A-Za-z0-9][A-Za-z0-9._-]*)\s+digest\s+([a-f0-9]{64})\s+approved\s+YES\b/i);
  if (!match) throw new Error('Lock must name .ddd-guard/slug digest <64 hex> approved YES');
  const dir = path.resolve(cfg.root, '.ddd-guard', match[1]);
  const text = readText(path.join(dir, 'SCOPE-LOCK.txt'), '');
  const fields = Object.fromEntries(text.split('\n').map((l) => l.match(/^([\w-]+):\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  if (fields.approved !== 'YES') throw new Error('ddd-guard lock is not approved: YES');
  const expectedPlan = path.join(dir, 'OWNERSHIP-PLAN.md');
  if (!fields.plan || path.resolve(cfg.root, fields.plan) !== expectedPlan) throw new Error('ddd-guard lock must bind its OWNERSHIP-PLAN.md');
  if (!/^[a-f0-9]{64}$/i.test(fields.digest || '') || fields.digest.toLowerCase() !== match[2].toLowerCase()) throw new Error('brief and lock digests differ');
  if (!fs.existsSync(expectedPlan) || sha256(fs.readFileSync(expectedPlan)) !== fields.digest.toLowerCase()) throw new Error('ownership plan hash differs from approved digest');
}
