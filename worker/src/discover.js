// 0.43.0: free discovery. GET /v1/discover?q=&verdict=&limit= and the MCP tool `discover`.
// 0.45.0: reads compressed d: blobs from D1 crawl_store (the 0010 table is unused and empty). No KV reads or writes.
// Freshness rules (from the shared crawl `meta` date): a result older than 36 h is stale:true; older than 7 days a "pay" is returned as "recheck"
// (original_verdict keeps what the crawl said). Skips are included by default with their reason.
import { signObject } from "./sign.js";
import { crawlStoreGet } from "./skips.js";

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

const isoS = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// 0.45.0: the index is compressed, sharded blobs in D1 crawl_store (no per-row table; 0010 stays empty).
// Keys: d:<verdict>:<hex0-f> (48 shards, by verdict and first id char) + d:meta. Value = base64(gzip(JSON)), stored in
// <= 90 KB parts with a sha256 over the joined value, exactly like the crawl pages (a torn/partial key is never used).
// Shard JSON: {v:1, dict:{r:[reasons], n:[networks], a:[assets], s:[source lists]}, rows:[[id,url,also,ri,price,ni,ai,method,si,checked_at]]}
// Freshness uses the shared crawl `meta` date (crawled_at). Search runs in memory; parsed shards are cached per isolate.
export const SHARD_HEX = "0123456789abcdef";
export const shardKeys = (verdict) => (verdict ? [verdict] : VERDICTS).flatMap((v) => [...SHARD_HEX].map((h) => `d:${v}:${h}`));
const cache = new Map(); // key -> {sha, rows (objects)}
let listAt = 0, listing = null; // key -> sha (part 0), refreshed every 5 min
const LIST_TTL = 300000;
const hex = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function decodeBlob(b64) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const text = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  return JSON.parse(text);
}
export function expandShard(verdict, j, run = null) {
  const d = j.dict || {};
  return (j.rows || []).map((r) => ({ id: r[0], url: r[1], also: r[2] || [], verdict, reason: d.r[r[3]] ?? "", price_usd: r[4] ?? null, network: d.n[r[5]] ?? null, asset: d.a[r[6]] ?? null, method: r[7] || null, source_list: d.s[r[8]] ?? null, checked_at: r[9], crawl_run: run }));
}
export function _clearDiscoverCache() { cache.clear(); listing = null; listAt = 0; }
async function listShas(db, now) {
  if (listing && now - listAt < LIST_TTL) return listing;
  const r = await db.prepare("SELECT key, parts, sha256 FROM crawl_store WHERE key >= 'd:' AND key < 'd;' AND part = 0").all();
  listing = new Map(((r && r.results) || []).map((x) => [x.key, x.sha256])); listAt = now;
  listing.run = null;
  if (listing.has("d:meta")) {
    const m = await db.prepare("SELECT value FROM crawl_store WHERE key = 'd:meta' AND part = 0").all().catch(() => null);
    try { listing.run = JSON.parse(m.results[0].value).crawl_run || null; } catch (_) {}
  }
  return listing;
}
/** Loads (and caches) the shards for a verdict filter. Returns {rows, missing}. Throws if D1 is unavailable. */
export async function loadShards(db, verdict, now = Date.now()) {
  const shas = await listShas(db, now);
  const keys = shardKeys(verdict).filter((k) => shas.has(k));
  const need = keys.filter((k) => !cache.has(k) || cache.get(k).sha !== shas.get(k));
  if (need.length) {
    const ph = need.map(() => "?").join(",");
    const r = await db.prepare(`SELECT key, part, parts, sha256, value FROM crawl_store WHERE key IN (${ph}) ORDER BY key, part`).bind(...need).all();
    const by = new Map();
    for (const x of (r && r.results) || []) (by.get(x.key) || by.set(x.key, []).get(x.key)).push(x);
    await Promise.all(need.map(async (k) => {
      const rows = by.get(k) || [];
      if (!rows.length || rows.length !== rows[0].parts || rows.some((x, i) => x.part !== i || x.sha256 !== rows[0].sha256)) return;
      const text = rows.map((x) => x.value).join("");
      if ((await hex(text)) !== rows[0].sha256) return; // torn or partial write: never serve it
      cache.set(k, { sha: rows[0].sha256, rows: expandShard(k.split(":")[1], await decodeBlob(text), shas.run) });
    }));
  }
  const out = [], missing = [];
  for (const k of shardKeys(verdict)) { const c = cache.get(k); if (c && c.sha === shas.get(k)) out.push(c.rows); else missing.push(k); }
  return { rows: out.flat(), missing, loaded: out.length };
}
/** In-memory filter on the EFFECTIVE verdict (a pay older than 7 days, by the crawl date, counts as recheck). */
export function searchRows(rows, p, crawledMs, now = Date.now()) {
  const expired = !(now - crawledMs <= PAY_EXPIRES_DAYS * 86400000);
  const hit = (r) => p.words.every((w) => r.url.toLowerCase().includes(w) || (r.source_list || "").toLowerCase().includes(w) || (r.also || []).some((x) => x.toLowerCase().includes(w)));
  let out = rows.filter(hit);
  if (p.verdict === "pay") out = expired ? [] : out.filter((r) => r.verdict === "pay");
  else if (p.verdict === "skip") out = out.filter((r) => r.verdict === "skip");
  else if (p.verdict === "recheck") out = out.filter((r) => r.verdict === "recheck" || (r.verdict === "pay" && expired));
  out.sort((a, b) => (a.checked_at < b.checked_at ? 1 : a.checked_at > b.checked_at ? -1 : a.id < b.id ? -1 : 1));
  return out.slice(0, p.limit);
}

/** One D1 row -> one public result (freshness applied), plus a signed receipt when signing is configured. */
export async function shapeResult(env, row, origin, now = Date.now(), crawledAt = row.checked_at) {
  const t = Date.parse(crawledAt);
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
  const db = env && env.RECEIPTS_DB;
  if (!db) return { status: 503, body: { error: "discovery index unavailable" } };
  let got, meta = null;
  try {
    [got, meta] = await Promise.all([loadShards(db, p.verdict, now), crawlStoreGet(env, "meta").catch(() => null)]);
  } catch (_) { return { status: 503, body: { error: "discovery index unavailable" } }; }
  if (!got.loaded) return { status: 503, body: { error: "discovery index unavailable" } };
  const crawled = (meta && meta.crawled_at) || got.rows.map((r) => r.checked_at).sort().pop() || null;
  const crawledMs = crawled ? Date.parse(crawled) : -Infinity;
  const rows = searchRows(got.rows, p, crawledMs, now);
  const results = await Promise.all(rows.map((r) => shapeResult(env, r, origin, now, crawled)));
  const ageH = crawled ? (now - crawledMs) / 3600000 : null;
  return {
    status: 200,
    body: {
      query: { q: p.q || null, verdict: p.verdict, limit: p.limit },
      count: results.length,
      index_last_crawled: crawled,
      index_stale: ageH === null ? true : ageH > STALE_HOURS,
      ...(got.missing.length ? { index_partial: true, missing_shards: got.missing.length } : {}),
      rules: `stale = last crawl older than ${STALE_HOURS} h; a pay older than ${PAY_EXPIRES_DAYS} days is returned as recheck. Skips are included by default (filter with verdict=pay|skip|recheck). Facts from our unpaid crawl probe, not endorsements; run the free check right before paying.`,
      results,
    },
  };
}
