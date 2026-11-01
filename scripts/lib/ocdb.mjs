// Optional read-only peek into opencode's sqlite database for liveness when the JSON stream is silent.
import { homeDir } from './paths.mjs';

export async function lastActivity(sessionID) {
  if (!sessionID || process.env.DP_NO_DB) return null;
  const origEmit = process.emitWarning;
  process.emitWarning = (w, ...rest) => { if (/sqlite/i.test(String(w)) || rest[0] === 'ExperimentalWarning') return; return origEmit.call(process, w, ...rest); };
  try {
    const mod = await import('node:sqlite');
    const dbPath = process.env.OPENCODE_DB || `${homeDir()}/.local/share/opencode/opencode.db`;
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare(
        `select s.time_updated as time_updated,
                (select max(p.time_updated) from part p where p.session_id = s.id) as last_part,
                (select count(*) from part p where p.session_id = s.id and json_extract(p.data,'$.type') = 'tool') as tools
           from session s where s.id = ?`).get(sessionID);
      return row || null;
    } finally { db.close(); }
  } catch { return null; }
  finally { process.emitWarning = origEmit; }
}
