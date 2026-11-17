// 0.62.0: receipt-scrape protection for /v1/receipts* (JSON and the HTML receipt pages). Receipts stay public.
// 1) Edge cache: one receipt by id is cached with the Cache API (caches.default) and served with Cache-Control, so a
//    repeat read never reaches D1. Live / side receipts (sc-, ps-, er-, eb-) are immutable once stored; crawl receipts
//    (10 hex) carry a read-time freshness block (terms age), so they get a 1 h TTL instead of immutable.
// 2) Per-client rate limit on everything that misses the cache: RECEIPT_RATE_PER_MIN per client IP per UTC minute on the
//    existing QuotaCounter Durable Object (takeFree + quotaKey, same primitive as the facilitator check; no KV).
//    Over it: 429 + Retry-After. Fails open (a counter error never blocks a read).
// 0.73.0 bulk limits (PR C). Single reads stay free. What is limited is walking the pile:
//  - paging: GET /v1/receipts with any query (type=, page=, cursor=, ref=, limit=, ...) is a "page", and so is /v1/skips(.json)?page=N for N > 1 (same budget). Per client (IP) a few per
//    minute and a daily cap, plus a larger daily cap per group (ASN + User-Agent) so many IPs on one cloud with one UA share a budget.
//  - uncached single reads (ids that missed the edge cache, /by-url, /proof): the existing per-minute limit, plus a per-client
//    daily cap. A verified search bot (Cloudflare verified-bot flag, or its own UA from its operator's ASN) is exempt from the
//    daily single cap, never from the paging caps (see isVerifiedBot below: self-declared search-engine UAs count; AI crawler UAs never do). The single-read path still makes ONE Durable Object call (minute + day counters
//    in the same call); only a client already past RECEIPT_GROUP_PROBE reads that day pays a second call for the group counter.
//  Over a limit: 429 + Retry-After + JSON that points to the bulk-access note (/pricing#bulk-access, not live). No D1, no KV.
//  Defaults below; every one is a wrangler var (RECEIPT_PAGES_PER_MIN, RECEIPT_PAGES_PER_DAY, RECEIPT_PAGES_PER_DAY_GROUP,
//  RECEIPT_SINGLE_PER_DAY, RECEIPT_SINGLE_PER_DAY_GROUP, RECEIPT_GROUP_PROBE, RECEIPT_RATE_PER_MIN). Off unless BULK_LIMITS = "1" (then the caps, the /pricing#bulk-access note and the OpenAPI 429 appear; unset = the 0.62.0 guard exactly).
// RECEIPT_GUARD=off (wrangler var) turns both off.
// payscout.dev traffic (host, Origin or Referer) is never limited: the old host and its redirect path keep working.
import { takeFree, quotaKey, utcMinute, utcDay, ipQuotaPrefix, VERSION } from "./lib.js";

export const RECEIPT_RATE_PER_MIN = 120;
export const RECEIPT_RATE_COUNTER = "rcpt";
export const RECEIPT_IMMUTABLE_CC = "public, max-age=31536000, immutable";
export const RECEIPT_CRAWL_CC = "public, max-age=3600";
export const RECEIPT_PAGES_PER_MIN = 6;
export const RECEIPT_PAGES_PER_DAY = 40;
export const RECEIPT_PAGES_PER_DAY_GROUP = 400;
export const RECEIPT_SINGLE_PER_DAY = 300;
export const RECEIPT_SINGLE_PER_DAY_GROUP = 3000;
export const RECEIPT_GROUP_PROBE = 25;
export const BULK_ACCESS_URL = "https://402xagent.com/pricing#bulk-access";
const posInt = (v, d) => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) && n > 0 ? n : d; };
/** 0.73.0 flag: the bulk caps, the /pricing#bulk-access note and the OpenAPI 429 exist only when BULK_LIMITS = "1" (unset = exactly the 0.62.0 guard). */
export const bulkLimitsOn = (env) => !!env && env.BULK_LIMITS === "1";
/** The limits in force: wrangler vars over the defaults above. */
export function receiptCaps(env = {}) {
  return {
    perMin: posInt(env.RECEIPT_RATE_PER_MIN, RECEIPT_RATE_PER_MIN),
    pagesPerMin: posInt(env.RECEIPT_PAGES_PER_MIN, RECEIPT_PAGES_PER_MIN),
    pagesPerDay: posInt(env.RECEIPT_PAGES_PER_DAY, RECEIPT_PAGES_PER_DAY),
    pagesPerDayGroup: posInt(env.RECEIPT_PAGES_PER_DAY_GROUP, RECEIPT_PAGES_PER_DAY_GROUP),
    singlePerDay: posInt(env.RECEIPT_SINGLE_PER_DAY, RECEIPT_SINGLE_PER_DAY),
    singlePerDayGroup: posInt(env.RECEIPT_SINGLE_PER_DAY_GROUP, RECEIPT_SINGLE_PER_DAY_GROUP),
    groupProbe: posInt(env.RECEIPT_GROUP_PROBE, RECEIPT_GROUP_PROBE),
    on: bulkLimitsOn(env),
  };
}
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


/** "page" = a list request that walks the pile (/v1/receipts with any query beyond format/raw); "list" = the bare first page; "single" = anything under /v1/receipts/ . */
export function receiptRequestClass(url, path) {
  if (path === "/v1/receipts") return [...url.searchParams.keys()].some((k) => k !== "format" && k !== "raw") ? "page" : "list";
  return "single";
}
// Search bots keep single pages (SEO); AI crawlers never get that carve-out.
//  - A self-declared search-engine UA (Googlebot, Bingbot, Applebot, Yandex, Baidu) counts as verified for SINGLE reads even with no
//    Cloudflare flag and no ASN match. Spoofing it only buys relief from the daily single-read cap: paging is capped for everyone, and the
//    existing per-minute limit still applies.
//  - An AI crawler UA (GPTBot, ClaudeBot, CCBot, PerplexityBot, Bytespider, Amazonbot, Google-Extended, meta-externalagent, ...) gets the normal
//    caps even when Cloudflare marks it verified (flag or an "AI ..." verified-bot category).
//  - Any other client Cloudflare marks verified (request.cf.botManagement.verifiedBot or request.cf.verifiedBotCategory) counts as verified.
const AI_CRAWLER_RE = /(gptbot|oai-searchbot|chatgpt-user|openai|claudebot|claude-web|claude-searchbot|claude-user|anthropic|ccbot|perplexity|bytespider|bytedance|amazonbot|google-extended|googleother|google-cloudvertexbot|meta-external|facebookbot|applebot-extended|cohere|diffbot|youbot|ai2bot|petalbot|timpibot|omgili|imagesiftbot|duckassistbot|mistralai)/i;
const SEARCH_BOT_RE = /(googlebot|google-inspectiontool|storebot-google|adsbot-google|bingbot|bingpreview|msnbot|applebot|yandex(bot|images|metrika)?|baiduspider)/i;
export const isAiCrawler = (ua) => AI_CRAWLER_RE.test(String(ua || ""));
export const isSearchEngineUa = (ua) => !isAiCrawler(ua) && SEARCH_BOT_RE.test(String(ua || ""));
export function isVerifiedBot(req) {
  try {
    const ua = req.headers.get("user-agent") || "";
    if (isAiCrawler(ua)) return false; // even if Cloudflare marks it verified
    if (SEARCH_BOT_RE.test(ua)) return true;
    const cf = req.cf || {};
    if (/^ai\b/i.test(String(cf.verifiedBotCategory || ""))) return false;
    if (cf.botManagement && cf.botManagement.verifiedBot === true) return true;
    return !!cf.verifiedBotCategory;
  } catch (_) { return false; }
}
async function sha(s) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
/** Group key: ASN + User-Agent, salted and per UTC day (no raw IP, ASN or UA is stored). */
export async function groupKey(req, env, now) {
  const asn = String((req.cf && req.cf.asn) || "") || "x:" + ipQuotaPrefix(req.headers.get("cf-connecting-ip") || "").split(".").slice(0, 2).join(".");
  return "g:" + (await sha(`${env.CLIENT_SALT || "unsalted-dev"}|rgrp|${utcDay(now)}|${asn}|${req.headers.get("user-agent") || ""}`)).slice(0, 24);
}
/** One Durable Object call that takes one unit from every counter, or none if any is spent. Fails open. */
export async function takeMulti(env, key, specs, now) {
  try {
    if (!env.QUOTA || typeof env.QUOTA.idFromName !== "function") return { free: true, error: "no-quota-binding" };
    const q = specs.map((s, i) => `c${i}=${encodeURIComponent(s.counter)}&p${i}=${encodeURIComponent(s.period)}&l${i}=${s.limit}`).join("&");
    const r = await env.QUOTA.get(env.QUOTA.idFromName(key)).fetch("https://quota.internal/multi?" + q);
    const j = await r.json();
    return { free: !!j.free, blocked: j.blocked ?? -1, used: j.used || [] };
  } catch (_) { return { free: true, error: "quota-error" }; }
}
const secsToNextUtcDay = (now) => 86400 - (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds());
function limited(scope, now, caps, extra = {}) {
  const day = scope !== "minute" && scope !== "pages_minute";
  const ra = day ? secsToNextUtcDay(now) : 60 - now.getUTCSeconds();
  const limitText = {
    minute: `${caps.perMin} receipt reads per minute per client (cached receipts excluded)`,
    pages_minute: `${caps.pagesPerMin} receipt list pages per minute per client`,
    pages_day: `${caps.pagesPerDay} receipt list pages per UTC day per client`,
    pages_group: `${caps.pagesPerDayGroup} receipt list pages per UTC day per network and user agent`,
    single_day: `${caps.singlePerDay} uncached single-receipt reads per UTC day per client (verified search bots excepted)`,
    single_group: `${caps.singlePerDayGroup} heavy-client single-receipt reads per UTC day per network and user agent`,
  }[scope];
  const bulk = scope === "minute";
  const body = {
    error: bulk ? "rate limited" : "bulk read limit reached", code: bulk ? "rate_limited" : "bulk_limit", scope, limit: limitText, retry_after_seconds: ra, ...extra,
    free_still_works: "Single receipts stay free: GET " + CANON_ID_EXAMPLE + ", /v1/receipts/by-url?url=<one endpoint url>, /v1/receipts/<id>/proof. The limit counts list pages and heavy repeated reads, not one-off lookups.",
    bulk_access: { url: BULK_ACCESS_URL, status: "not_live", note: "Full history, bulk export and .ots bundles are paid and not live yet. Nothing about them is free through this API." },
  };
  return new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json; charset=utf-8", "retry-after": String(ra), "cache-control": "no-store", "access-control-allow-origin": "*", "x-receipt-limit": scope, link: `<${BULK_ACCESS_URL}>; rel="help"` } });
}
const CANON_ID_EXAMPLE = "https://402xagent.com/v1/receipts/<id>";

/** The list-paging cap, shared by every paged list (receipts, skips): per client per minute and per day, then per ASN+UA group per day. Returns a 429 or null. */
export async function pageLimit(req, env, now, caps = receiptCaps(env), id = null) {
  const minute = utcMinute(now), day = utcDay(now);
  id = id || (await quotaKey(req, {}, env, now));
  const t = await takeMulti(env, "rcptp:" + id, [{ counter: "rcpt-pmin", period: minute, limit: caps.pagesPerMin }, { counter: "rcpt-pday", period: day, limit: caps.pagesPerDay }], now);
  if (!t.free) return limited(t.blocked === 0 ? "pages_minute" : "pages_day", now, caps);
  const g = await takeFree(env, "rcptg:" + (await groupKey(req, env, now)), caps.pagesPerDayGroup, now, "take", "rcpt-gpage", day);
  if (!g.error && !g.free) return limited("pages_group", now, caps);
  return null;
}
/** /v1/skips and /v1/skips.json: ?page=N with N > 1 is a list page under the same cap as receipt list pages (page 1 and the bare page stay free). Flag off or payscout.dev: null. */
export async function skipsPageGuard(req, env, url, now = new Date()) {
  const caps = receiptCaps(env);
  if (!caps.on || isPayscoutRequest(req, url) || !(parseInt(url.searchParams.get("page") || "1", 10) > 1)) return null;
  return pageLimit(req, env, now, caps);
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
    const caps = receiptCaps(env), klass = receiptRequestClass(url, path), minute = utcMinute(now), day = utcDay(now);
    const id = await quotaKey(req, {}, env, now);
    if (klass === "page" && caps.on) {
      const lim = await pageLimit(req, env, now, caps, id);
      if (lim) return lim;
    } else {
      const capSingle = caps.on && klass === "single" && !isVerifiedBot(req);
      const specs = [{ counter: RECEIPT_RATE_COUNTER, period: minute, limit: caps.perMin }];
      if (capSingle) specs.push({ counter: "rcpt-sday", period: day, limit: caps.singlePerDay });
      // Flag off: the 0.62.0 call exactly (takeFree on the minute counter). Flag on: one combined call for minute + day.
      const t = caps.on ? await takeMulti(env, "rcpt:" + id, specs, now) : await takeFree(env, "rcpt:" + id, caps.perMin, now, "take", RECEIPT_RATE_COUNTER, minute);
      if (!t.error && !t.free) return limited(!caps.on || t.blocked === 0 ? "minute" : "single_day", now, caps);
      // Only a client already past the probe that day pays a second call; ordinary readers never do.
      if (capSingle && !t.error && Number((t.used || [])[1]) > caps.groupProbe) {
        const g = await takeFree(env, "rcptg:" + (await groupKey(req, env, now)), caps.singlePerDayGroup, now, "take", "rcpt-gsingle", day);
        if (!g.error && !g.free) return limited("single_group", now, caps);
      }
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
