// 0.62.0: receipt-scrape protection for /v1/receipts* (JSON and the HTML receipt pages). Receipts stay public.
// 1) Edge cache: one receipt by id is cached with the Cache API (caches.default) and served with Cache-Control, so a
//    repeat read never reaches D1. Live / side receipts (sc-, ps-, er-, eb-) are immutable once stored; crawl receipts
//    (10 hex) carry a read-time freshness block (terms age), so they get a 1 h TTL instead of immutable.
// 2) Per-client rate limit on everything that misses the cache: RECEIPT_RATE_PER_MIN per client IP per UTC minute on the
//    existing QuotaCounter Durable Object (takeFree + quotaKey, same primitive as the facilitator check; no KV).
//    Over it: 429 + Retry-After. Fails open (a counter error never blocks a read).
// RECEIPT_GUARD=off (wrangler var) turns both off.
// payscout.dev traffic (host, Origin or Referer) is never limited: the old host and its redirect path keep working.
import { takeFree, quotaKey, utcMinute, VERSION } from "./lib.js";

export const RECEIPT_RATE_PER_MIN = 120;
export const RECEIPT_RATE_COUNTER = "rcpt";
export const RECEIPT_IMMUTABLE_CC = "public, max-age=31536000, immutable";
export const RECEIPT_CRAWL_CC = "public, max-age=3600";
const IMMUTABLE_ID = /^\/v1\/receipts\/(sc|ps|er|eb)-[0-9a-f]{16}$/;
const CRAWL_ID = /^\/v1\/receipts\/[0-9a-f]{10}$/;
const PAYSCOUT = /(^|\.)payscout\.dev$/i;

const hostOf = (v) => { try { return new URL(v).hostname; } catch (_) { return ""; } };
/** True for payscout.dev / *.payscout.dev by request host, Origin or Referer. */
export function isPayscoutRequest(req, url) {
  return PAYSCOUT.test(url.hostname) || PAYSCOUT.test(hostOf(req.headers.get("origin") || "")) || PAYSCOUT.test(hostOf(req.headers.get("referer") || ""));
}
/** Cache-Control for a cacheable single-receipt path, else null. */
export function receiptCacheControl(path) {
  return IMMUTABLE_ID.test(path) ? RECEIPT_IMMUTABLE_CC : CRAWL_ID.test(path) ? RECEIPT_CRAWL_CC : null;
}
const variantOf = (req, url) => {
  const html = /text\/html/i.test(req.headers.get("accept") || "") && !url.searchParams.has("raw");
  return html ? (url.searchParams.get("format") === "json" ? "jsonhtml" : "html") : url.searchParams.get("format") === "json" || url.searchParams.has("raw") ? "json" : "json0";
};
/** Cache key: path + representation (HTML page, styled JSON, plain JSON) + VERSION, so a deploy never serves an old page. */
export function receiptCacheKey(req, url) {
  return "https://receipt-cache.internal" + url.pathname + "?v=" + encodeURIComponent(VERSION) + "&r=" + variantOf(req, url);
}

export async function receiptGuard(req, env, ctx, url, path, inner, { now = new Date(), cache = (globalThis.caches && globalThis.caches.default) || null } = {}) {
  if (env && env.RECEIPT_GUARD === "off") return inner(); // kill switch (var), also used by the pre-0.62.0 snapshot fixtures
  const get = req.method === "GET" || req.method === "HEAD";
  const cc = get && ![...url.searchParams.keys()].some((k) => k !== "format" && k !== "raw") ? receiptCacheControl(path) : null;
  const key = cc && cache ? receiptCacheKey(req, url) : null;
  if (key) {
    try { const hit = await cache.match(key); if (hit) { const h = new Response(req.method === "HEAD" ? null : hit.body, hit); h.headers.set("x-receipt-cache", "hit"); return h; } } catch (_) {}
  }
  if (!isPayscoutRequest(req, url)) {
    const t = await takeFree(env, "rcpt:" + (await quotaKey(req, {}, env, now)), RECEIPT_RATE_PER_MIN, now, "take", RECEIPT_RATE_COUNTER, utcMinute(now));
    if (!t.error && !t.free) {
      const ra = String(60 - now.getUTCSeconds());
      return new Response(JSON.stringify({ error: "rate limited", code: "rate_limited", limit: `${RECEIPT_RATE_PER_MIN} receipt reads per minute per client (cached receipts excluded)`, retry_after_seconds: Number(ra) }), { status: 429, headers: { "content-type": "application/json; charset=utf-8", "retry-after": ra, "cache-control": "no-store", "access-control-allow-origin": "*" } });
    }
  }
  const res = await inner();
  if (!cc || !res || res.status !== 200) return res;
  const out = new Response(res.body, res);
  out.headers.set("cache-control", cc);
  if (key && req.method === "GET") {
    const p = cache.put(key, out.clone()).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
  }
  out.headers.set("x-receipt-cache", "miss");
  return out;
}
