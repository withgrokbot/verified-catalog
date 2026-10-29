// 0.59.3: real SQLite (node:sqlite) with every worker migration behind a tiny D1 adapter, for LOCAL tests only.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
const MIGDIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "worker", "migrations");
export function sqliteD1({ skip = [] } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGDIR).filter((x) => x.endsWith(".sql") && !skip.includes(x)).sort()) db.exec(readFileSync(join(MIGDIR, f), "utf8"));
  const norm = (a) => a.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x));
  const mk = (sql, args = []) => ({ bind: (...a) => mk(sql, norm(a)), first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }), _run: () => db.prepare(sql).run(...args) });
  return { raw: db, prepare: (sql) => mk(sql), batch: async (st) => { const out = []; for (const s of st) out.push({ meta: { changes: Number(s._run().changes) } }); return out; } };
}
