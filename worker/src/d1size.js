// 0.53.1 D1 size guard for growth-only writers (feed observations + feed snapshots). Once the database is over
// D1_SIZE_MAX_MB (default 400), those writers stop and log one warning per cache period; every answer keeps working
// (reads are untouched, and the watch's own state update still runs).
// Size source: D1Result.meta.size_after, which D1 returns on every query (run/batch) with the database size in bytes.
// Cached per isolate for SIZE_TTL_MS; refreshed for free from any batch result we already have (noteD1Size), else by
// one `SELECT 1` .run() at most once per TTL. No KV, no extra table. Size unknown (e.g. a local stub) = writes allowed.
export const D1_SIZE_MAX_MB_DEFAULT = 400;
export const SIZE_TTL_MS = 10 * 60 * 1000;
let cache = { bytes: null, at: 0, warnedAt: 0 };
export const _resetD1Size = () => { cache = { bytes: null, at: 0, warnedAt: 0 }; };
export function d1MaxBytes(env) {
  const n = Number((env && env.D1_SIZE_MAX_MB) ?? "");
  return (Number.isFinite(n) && n > 0 ? n : D1_SIZE_MAX_MB_DEFAULT) * 1e6;
}
/** Record size_after from a D1Result or an array of them (batch). Never throws. */
export function noteD1Size(res, now = Date.now()) {
  try {
    const list = Array.isArray(res) ? res : [res];
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i] && list[i].meta && list[i].meta.size_after;
      if (Number.isFinite(s) && s > 0) { cache.bytes = s; cache.at = now; return s; }
    }
  } catch (_) {}
  return null;
}
/** Database size in bytes (cached), or null when D1 does not report it. Never throws. */
export async function d1Size(db, now = Date.now()) {
  if (cache.bytes != null && now - cache.at < SIZE_TTL_MS) return cache.bytes;
  try { if (noteD1Size(await db.prepare("SELECT 1").run(), now) != null) return cache.bytes; } catch (_) {}
  cache.at = now; // unknown: do not re-ask on every call
  return cache.bytes;
}
/** true if a growth-only writer may write. Logs {d1_size_guard:"over"} once per TTL while over the limit. */
export async function d1WriteAllowed(env, db, what, now = Date.now()) {
  if (!db) return false;
  const size = await d1Size(db, now);
  if (size == null || size <= d1MaxBytes(env)) return true;
  if (now - cache.warnedAt >= SIZE_TTL_MS) {
    cache.warnedAt = now;
    console.log(JSON.stringify({ d1_size_guard: "over", writer: what, size_mb: Math.round(size / 1e5) / 10, max_mb: d1MaxBytes(env) / 1e6 }));
  }
  return false;
}
