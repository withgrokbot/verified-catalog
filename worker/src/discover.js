// 0.43.0: free discovery. GET /v1/discover?q=&verdict=&limit= and the MCP tool `discover`.
// Reads the D1 table discover_index (migration 0010, seeded from the weekly crawl). No KV reads or writes.
// Freshness rules: a result older than 36 h is stale:true; older than 7 days a "pay" is returned as "recheck"
// (original_verdict keeps what the crawl said). Skips are included by default with their reason.
import { signObject } from "./sign.js";

export const DISCOVER_MAX = 20;
export const DISCOVER_DEFAULT = 10;
export const DISCOVER_PER_MIN = 60; // per client (IP /24 + UA hash) per UTC minute
export const STALE_HOURS = 36;
export const PAY_EXPIRES_DAYS = 7;
const VERDICTS = ["pay", "skip", "recheck"];
const Q_RE = /^[A-Za-z0-9 ._:\/\-]{2,100}$/;

export class DiscoverInputError extends Error {}

/** Validates and normalizes the inputs. Throws DiscoverInputError with a caller-facing message. */
export function parseDiscover(input) {
  const g = (k) => (input[k] === undefined || input[k] === null ? "" : String(input[k]).trim());
  const q = g("q");
  if (q && !Q_RE.test(q)) throw new DiscoverInputError("q must be 2-100 characters: letters, digits, space and . _ : / -");
  const verdict = g("verdict").toLowerCase();
  if (verdict && !VERDICTS.includes(verdict)) throw new DiscoverInputError("verdict must be pay, skip or recheck");
  const ls = g("limit");
  let limit = DISCOVER_DEFAULT;
  if (ls) {
    if (!/^\d{1,3}$/.test(ls)) throw new DiscoverInputError(`limit must be an integer 1-${DISCOVER_MAX}`);
    limit = Math.max(1, Math.min(DISCOVER_MAX, parseInt(ls, 10)));
  }
  return { q: q.toLowerCase(), words: q ? q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5) : [], verdict: verdict || null, limit };
}

const likeEsc = (s) => "%" + s.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
const isoS = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** SQL + binds. Filters on the EFFECTIVE verdict (a pay older than 7 days counts as recheck). */
export function discoverSql(p, now = Date.now()) {
  const cutoff = isoS(now - PAY_EXPIRES_DAYS * 86400000);
  const where = [], binds = [];
  for (const w of p.words) { where.push("search LIKE ? ESCAPE '\\'"); binds.push(likeEsc(w)); }
  if (p.verdict === "pay") { where.push("verdict = 'pay' AND checked_at >= ?"); binds.push(cutoff); }
  else if (p.verdict === "skip") where.push("verdict = 'skip'");
  else if (p.verdict === "recheck") { where.push("(verdict = 'recheck' OR (verdict = 'pay' AND checked_at < ?))"); binds.push(cutoff); }
  const sql = "SELECT id, url, verdict, reason, price_usd, network, asset, method, source_list, checked_at, crawl_run FROM discover_index" +
    (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY checked_at DESC, id LIMIT ?";
  binds.push(p.limit);
  return { sql, binds };
}

/** One D1 row -> one public result (freshness applied), plus a signed receipt when signing is configured. */
export async function shapeResult(env, row, origin, now = Date.now()) {
  const t = Date.parse(row.checked_at);
  const ageH = Number.isFinite(t) ? (now - t) / 3600000 : Infinity;
  const expired = row.verdict === "pay" && ageH > PAY_EXPIRES_DAYS * 24;
  const verdict = expired ? "recheck" : row.verdict;
  const result = {
    endpoint: row.url,
    method: row.method || null,
    verified_price_usd: row.price_usd ?? null,
    network: row.network || null,
    asset: row.asset || null,
    last_checked: row.checked_at,
    age_hours: Number.isFinite(ageH) ? Math.round(ageH * 10) / 10 : null,
    stale: ageH > STALE_HOURS,
    verdict,
    reason: expired ? `last pay check is older than ${PAY_EXPIRES_DAYS} days; run the free check before paying` : row.reason,
    ...(expired ? { original_verdict: "pay", original_reason: row.reason } : {}),
    source_list: row.source_list || null,
    receipt_url: origin + "/v1/receipts/" + row.id,
    check_url: "https://api.402xagent.com/v1/products/endpoint-spot-check?url=" + encodeURIComponent(row.url),
  };
  const body = { type: "discover-result", issuer: "402xAgent", receipt_id: row.id, crawl_run: row.crawl_run || null, issued_at: isoS(now),
    endpoint: result.endpoint, verified_price_usd: result.verified_price_usd, network: result.network, last_checked: result.last_checked, verdict, reason: result.reason, stale: result.stale };
  const signed = await signObject(env, body);
  result.receipt = signed || { ...body, signature: null, note: "unsigned: signing key not configured on this host" };
  return result;
}

/** Core query used by both the HTTP route and the MCP tool. Returns {status, body}. */
export async function discover(env, input, origin, now = Date.now()) {
  let p;
  try { p = parseDiscover(input); } catch (e) {
    if (e instanceof DiscoverInputError) return { status: 400, body: { error: e.message, usage: origin + "/v1/discover?q=weather&verdict=pay&limit=10" } };
    throw e;
  }
  if (!env.RECEIPTS_DB) return { status: 503, body: { error: "discovery index unavailable" } };
  const { sql, binds } = discoverSql(p, now);
  let rows;
  try { rows = (await env.RECEIPTS_DB.prepare(sql).bind(...binds).all()).results || []; }
  catch (_) { return { status: 503, body: { error: "discovery index unavailable" } }; }
  let newest = null;
  try { newest = (await env.RECEIPTS_DB.prepare("SELECT MAX(checked_at) AS t FROM discover_index").first())?.t || null; } catch (_) {}
  const results = await Promise.all(rows.map((r) => shapeResult(env, r, origin, now)));
  const newestAgeH = newest ? (now - Date.parse(newest)) / 3600000 : null;
  return {
    status: 200,
    body: {
      query: { q: p.q || null, verdict: p.verdict, limit: p.limit },
      count: results.length,
      index_last_crawled: newest,
      index_stale: newestAgeH === null ? true : newestAgeH > STALE_HOURS,
      rules: `stale = last check older than ${STALE_HOURS} h; a pay older than ${PAY_EXPIRES_DAYS} days is returned as recheck. Skips are included by default (filter with verdict=pay|skip|recheck). Facts from our unpaid crawl probe, not endorsements; run the free check right before paying.`,
      results,
    },
  };
}
