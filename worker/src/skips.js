// Public self-checked receipts: /v1/skips (HTML; ?format=json or /v1/skips.json for JSON; ?page=N), /v1/receipts, /v1/receipts/<id>.
// 0.11.0: the weekly crawl covers every listed endpoint. Page 1 of skips is bundled (receipts-data.js); every receipt
// and every other skip page lives in D1 crawl_store (0.44.0; KV CRAWL_KV fallback) as c:<id[0:2]> shards, s:<n> pages.
import { RECEIPTS, RECEIPTS_META } from "./receipts-data.js";
import { freshnessFor, termsMaxAgeHours } from "./freshness.js"; // 0.54.0
import { recentChecks, RECENT_MAX } from "./recent.js";
import { CANON_ORIGIN, API_ORIGIN, SPOT_SERVICE_NAME, FREE_CHECK_URL, FREE_CHECK_EXAMPLE_URL, FREE_CHECK_EXAMPLE } from "./spotcheck.js";
import { skipsHtml } from "./skips-html.js"; // 0.58.7
import { DOCS_CSP as HOME_CSP } from "./tryit.js"; // = home.js HOME_CSP (strict: script-src 'self' + Cloudflare Web Analytics)

const hdrs = (type) => ({ "content-type": type, "access-control-allow-origin": "*", "cache-control": "public, max-age=300", vary: "accept" });
const j = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: hdrs("application/json; charset=utf-8") });

// Same as norm_url() in receipts/scripts/crawl_probe.py. Keep the two in sync (tested).
const URL_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/;
export function normUrl(u) {
  u = String(u ?? "").trim();
  const m = URL_RE.exec(u);
  if (!m) return u;
  const scheme = m[1].toLowerCase();
  let host = m[2].split("@").pop().toLowerCase();
  if ((scheme === "http" && host.endsWith(":80")) || (scheme === "https" && host.endsWith(":443"))) host = host.slice(0, host.lastIndexOf(":"));
  host = host.replace(/\.+$/, "");
  let path = m[3] || "/";
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  const q = m[4] || "";
  const parts = q ? q.slice(1).split("&").filter(Boolean).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : [];
  return `${scheme}://${host}${path}` + (parts.length ? "?" + parts.join("&") : "");
}
export async function receiptIdFor(u) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(normUrl(u)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

// 0.44.0: crawl data is read from D1 (crawl_store, migration 0011) first; KV only for keys not (fully) migrated yet.
const d1Hit = new Map(); // per-isolate cache: key -> { at, v } (same 300 s as the KV cacheTtl)
export async function crawlStoreGet(env, key) {
  const db = env && env.RECEIPTS_DB;
  if (!db) return undefined;
  const c = d1Hit.get(key);
  if (c && Date.now() - c.at < 300000) return c.v;
  try {
    const r = await db.prepare("SELECT part, parts, sha256, value FROM crawl_store WHERE key = ? ORDER BY part").bind(key).all();
    const rows = (r && r.results) || [];
    if (!rows.length || rows.length !== rows[0].parts || rows.some((x, i) => x.part !== i || x.parts !== rows[0].parts || x.sha256 !== rows[0].sha256)) return undefined;
    const text = rows.map((x) => x.value).join("");
    const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (h !== rows[0].sha256) return undefined; // torn or partial write: never serve it
    const v = JSON.parse(text);
    if (d1Hit.size > 64) d1Hit.clear();
    d1Hit.set(key, { at: Date.now(), v });
    return v;
  } catch (_) {
    return undefined; // table missing (migration not applied) or store error -> KV fallback
  }
}
export function _clearCrawlStoreCache() { d1Hit.clear(); }
async function kvJson(env, key) {
  const d = await crawlStoreGet(env, key);
  if (d !== undefined) return d;
  if (!env || !env.CRAWL_KV) return null;
  try {
    return await env.CRAWL_KV.get(key, { type: "json", cacheTtl: 300 });
  } catch (_) {
    return null;
  }
}
/** 0.38.0: "Updated weekly (last crawl Oct 27, next crawl Nov 3)." from the crawl timestamp. 0.53.4: the crawl routine runs
 * weekly on Tuesdays (6:30 AM PT): next = the first Tuesday after the last crawl's UTC date (= last + 7 days when it ran on its Tuesday). */
export function crawlSchedule(crawledAt) {
  const t = Date.parse(String(crawledAt || ""));
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const next = new Date(last.getTime() + (((9 - last.getUTCDay()) % 7) || 7) * 86400000);
  const fmt = (x) => x.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return { last: fmt(last), next: fmt(next), last_iso: last.toISOString().slice(0, 10), next_iso: next.toISOString().slice(0, 10) };
}
export function crawlScheduleText(crawledAt) {
  const s = crawlSchedule(crawledAt);
  return s ? `Updated weekly (last crawl ${s.last}, next crawl ${s.next}).` : "Updated weekly.";
}
/** One crawl receipt by id: bundled page 1 first, then the KV shard. */
export async function crawlReceipt(env, id) {
  if (!/^[0-9a-f]{10}$/.test(String(id || ""))) return null;
  const b = RECEIPTS.find((x) => x.id === id);
  if (b) return b;
  const shard = await kvJson(env, "c:" + id.slice(0, 2));
  return (shard && shard[id]) || null;
}
/** Latest crawl receipt for a URL (normalized). */
export async function crawlReceiptForUrl(env, u) {
  const r = await crawlReceipt(env, await receiptIdFor(u));
  return r && normUrl(r.url) === normUrl(u) ? r : null;
}

export function spotHowTo(origin) {
  return `Free check first: GET ${FREE_CHECK_URL} (optional &claimed_price=0.01; or POST JSON {"url":"<endpoint>"}) returns verdict pay|skip|recheck. 5 free/day (25 per network) plus free dry runs (&mode=dry-run); after that, the paid check is $0.02 USDC via x402 on Base. Never pays the target.`;
}

export function coverage() {
  const m = RECEIPTS_META;
  return { endpoints_covered: m.endpoints_covered ?? m.total, new_this_week: m.new_this_week ?? null, previous_run: m.previous_run ?? null, crawled_at: m.crawled_at };
}

export function skipsSummary(origin, env = {}, now = Date.now()) {
  const m = RECEIPTS_META;
  // 0.54.0: the crawl's pay counts carry the age of their terms; stale past TERMS_MAX_AGE_HOURS (production 168 h = 7 days)
  const f = freshnessFor("pay", m.crawled_at, termsMaxAgeHours(env), now);
  return {
    free_check: { url: FREE_CHECK_URL, example: FREE_CHECK_EXAMPLE_URL, example_response: FREE_CHECK_EXAMPLE, then: "the paid check (HTTP 402) for the full payment terms" },
    ...coverage(),
    total_receipts: m.total, skip: m.skip, pay: m.pay, recheck: m.recheck, check_type: m.check_type,
    terms_freshness: { terms_checked_at: f.terms_checked_at, terms_age_hours: f.terms_age_hours, terms_max_age_hours: f.terms_max_age_hours, terms_stale: f.terms_stale, pay_effective_verdict: f.effective_verdict, note: "crawl pays older than terms_max_age_hours are recheck until the live check re-reads the 402" },
    lists: m.lists, listed_in: m.listed_in, sources: m.sources, dedupe: m.dedupe, method: m.method, spot_check: spotHowTo(origin),
    featured_mismatch: origin + "/v1/receipts/" + m.featured_id,
    skip_pages: m.skip_pages || 1, page_size: m.page_size || RECEIPTS.length,
    receipts: origin + "/v1/receipts", skips_html: origin + "/v1/skips", skips_json: origin + "/v1/skips.json",
    receipt_by_url: origin + "/v1/receipts/by-url?url=<endpoint>",
  };
}

// 0.58.5: also read by the browser receipts page (lib.js receiptListView)
export async function skipsPageRows(env, n) { return skipsPage(env, n); }
async function skipsPage(env, n) {
  if (n === 1) return RECEIPTS;
  return (await kvJson(env, "s:" + n)) || null;
}

export async function handleSkips(req, url, env = {}, fp = {}) {
  const origin = CANON_ORIGIN;
  const m = RECEIPTS_META;
  const pages = m.skip_pages || 1;
  const page = Math.max(1, Math.min(pages, parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const skips = (await skipsPage(env, page)) || [];
  const path = url.pathname.replace(/\/+$/, "");
  const accept = req.headers.get("accept") || "";
  const nav = (p) => origin + (path === "/v1/skips.json" ? "/v1/skips.json" : "/v1/skips") + "?page=" + p + (path !== "/v1/skips.json" && url.searchParams.get("format") === "json" ? "&format=json" : "");
  // 0.22.0: HTML only for browsers (Accept names text/html). Everything else (application/json, curl's */*, no Accept,
  // ?format=json, /v1/skips.json) gets the JSON counts and data.
  const wantsHtml = /text\/html/i.test(accept) && url.searchParams.get("format") !== "json" && path !== "/v1/skips.json";
  if (!wantsHtml)
    return j({
      ...skipsSummary(origin, env),
      page, pages, next: page < pages ? nav(page + 1) : null, prev: page > 1 ? nav(page - 1) : null,
      skips: skips.map((r) => ({ ...r, permalink: origin + "/v1/receipts/" + r.id })),
      // 0.25.0: latest outside free checks, newest first: url (scheme://host/path only), verdict, short reason (no
      // price), checked_at (UTC), receipt_url (redacted view), caller. Same on every page.
      recent_checks_note: `latest ${RECENT_MAX} outside free checks with a clear verdict; one per endpoint per UTC day; query strings removed`,
      recent_checks: await recentChecks(env, origin),
    });
  // 0.58.7: the human page (skips-html.js): shared chrome, plain reasons, cards on phones, method text in <details>, no
  // featured callout, no script. Same rows, same ?page=N paging. The JSON above is unchanged byte for byte
  // (tests/skips_page_test.mjs, tests/fixtures/machine_0.58.6/skips.json).
  const html = skipsHtml(origin, { meta: m, skips, page, pages, now: Date.now(), freeCheck: { url: FREE_CHECK_URL, exampleUrl: FREE_CHECK_EXAMPLE_URL, example: FREE_CHECK_EXAMPLE }, spotHowTo: spotHowTo(origin), scheduleText: crawlScheduleText(m.crawled_at) }, fp);
  return new Response(html, { status: 200, headers: { ...hdrs("text/html; charset=utf-8"), "content-security-policy": HOME_CSP, "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" } });
}

export async function handleReceipts(url, env = {}) {
  const path = url.pathname.replace(/\/+$/, "");
  const id = path.slice("/v1/receipts".length).replace(/^\//, "");
  if (!id) return j({ ...skipsSummary(CANON_ORIGIN, env), note: "Every receipt: /v1/receipts/<id> or /v1/receipts/by-url?url=. Skips page by page: /v1/skips.json?page=N. Page 1:", receipts: RECEIPTS });
  let r = await crawlReceipt(env, id);
  if (!r) return j({ error: "receipt not found", receipts: CANON_ORIGIN + "/v1/receipts" }, 404);
  // 0.35.0: ?view=redacted (used by /saves): no wallets, and the reason without the wallets it quotes. Default unchanged.
  if (url.searchParams.get("view") === "redacted") {
    const { pay_to, listed_pay_to, ...rest } = r;
    r = { ...rest, reason: String(r.reason || "").replace(/0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/g, "<wallet>"), redacted: "wallets removed; the full crawl receipt is at the same URL without ?view=redacted" };
  }
  // 0.54.0: read-time freshness next to the stored receipt (the receipt fields themselves are unchanged)
  return j({ service: SPOT_SERVICE_NAME, ...r, permalink: CANON_ORIGIN + "/v1/receipts/" + r.id, on_page: r.verdict === "skip" ? CANON_ORIGIN + "/v1/skips" : null, spot_check: spotHowTo(CANON_ORIGIN), freshness: freshnessFor(r.verdict, r.timestamp, termsMaxAgeHours(env)) });
}
