// Time helpers. OC_FAKE_NOW=<iso> freezes "now" for tests.
export function now() {
  const f = process.env.OC_FAKE_NOW;
  return f ? new Date(f) : new Date();
}
export function iso(d = now()) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
export function parseTs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (v instanceof Date) return v.getTime();
  const n = Date.parse(String(v).trim());
  return Number.isNaN(n) ? null : n;
}
export function ageMs(ts, ref = now()) { const t = parseTs(ts); return t == null ? null : ref.getTime() - t; }
export function ageMinutes(ts, ref = now()) { const a = ageMs(ts, ref); return a == null ? null : a / 60000; }
export function fmtAge(ms) {
  if (ms == null) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d`;
}
// DeepSeek V4.1 Flash costs 2x in these UTC windows (OpenCode Go pricing page).
export function isDeepseekPeak(d = now()) {
  const wd = d.getUTCDay(), h = d.getUTCHours();
  return wd >= 1 && wd <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}
export function isDeepseekModel(model) { return /deepseek/i.test(String(model || '')); }
