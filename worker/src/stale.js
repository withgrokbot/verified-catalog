// 0.27.0: recheck stale receipts. On cron steps where /bazaar has nothing to do, re-run our free check on up to
// STALE_BATCH URLs whose latest receipt is older than STALE_AFTER_H (first seen within STALE_WINDOW_D days), at most
// STALE_PER_DAY a UTC day. Same exempt self-test client (check_type self-checked, never counted as outside, never in
// recent_checks), ref "stale-recheck", stored with access_tier "auto" so the receipt stays redacted.
// Cost per working step: 2 D1 reads + ~3 subrequests per URL (DNS A/AAAA + probe), so ~15 of the 50 allowed.
import { publicUrl } from "./recent.js";

export const STALE_REF = "stale-recheck";
export const STALE_CLIENT = "withgrokbot-selftest";
export const STALE_AFTER_H = 72;
export const STALE_WINDOW_D = 30;
export const STALE_BATCH = 5;
export const STALE_PER_DAY = 60;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export function staleCheckUrl(origin, row) {
  const qp = new URLSearchParams({ url: row.url, client: STALE_CLIENT, ref: STALE_REF });
  const method = String(row.method || "GET").toUpperCase();
  if (method === "POST") qp.set("method", "POST");
  let exp = null;
  try { exp = row.expected ? JSON.parse(row.expected) : null; } catch (_) { exp = null; }
  if (exp && exp.source === "request") {
    if (exp.claimed_price_usd != null) qp.set("claimed_price", String(exp.claimed_price_usd));
    if (exp.pay_to) qp.set("pay_to", exp.pay_to);
    if (exp.network) qp.set("network", exp.network);
  }
  return origin + "/v1/products/endpoint-spot-check?" + qp.toString();
}

export async function staleStep(env, { now = new Date(), runCheck, origin }) {
  const db = env.RECEIPTS_DB;
  if (!db) return { did: "no-db" };
  const t = now.getTime();
  const dayStart = now.toISOString().slice(0, 10) + "T00:00:00Z";
  let done = 0, rows = [];
  try {
    const c = await db.prepare("SELECT COUNT(*) AS n FROM spot_receipts WHERE check_type = 'self-checked' AND ref = ? AND created_at >= ?").bind(STALE_REF, dayStart).first();
    done = Number((c && c.n) || 0);
    if (done >= STALE_PER_DAY) return { did: "cap" };
    const r = await db.prepare(
      "SELECT url, MAX(created_at) AS last, MIN(created_at) AS first, json_extract(body, '$.method') AS method, json_extract(body, '$.expected') AS expected FROM spot_receipts GROUP BY url HAVING last < ? AND first > ? ORDER BY last ASC LIMIT 25"
    ).bind(iso(t - STALE_AFTER_H * 3600e3), iso(t - STALE_WINDOW_D * 86400e3)).all();
    rows = (r && r.results) || [];
  } catch (_) {
    return { did: "db-error" };
  }
  const pick = rows.filter((x) => publicUrl(x.url)).slice(0, Math.min(STALE_BATCH, STALE_PER_DAY - done));
  let n = 0;
  for (const row of pick) {
    try { const res = await runCheck(staleCheckUrl(origin, row)); await res.text(); n++; } catch (_) {}
  }
  return { did: pick.length ? "rechecked" : "idle", n };
}
