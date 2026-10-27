// Public self-checked receipts: /v1/skips (HTML; ?format=json or /v1/skips.json for JSON; ?page=N), /v1/receipts, /v1/receipts/<id>.
// 0.11.0: the weekly crawl covers every listed endpoint. Page 1 of skips is bundled (receipts-data.js); every receipt
// and every other skip page lives in D1 crawl_store (0.44.0; KV CRAWL_KV fallback) as c:<id[0:2]> shards, s:<n> pages.
import { RECEIPTS, RECEIPTS_META } from "./receipts-data.js";
import { freshnessFor, termsMaxAgeHours } from "./freshness.js"; // 0.54.0
import { recentChecks, RECENT_MAX } from "./recent.js";
import { CANON_ORIGIN, API_ORIGIN, SPOT_SERVICE_NAME, FREE_CHECK_URL, FREE_CHECK_EXAMPLE_URL, FREE_CHECK_EXAMPLE } from "./spotcheck.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (v) => (v === null || v === undefined ? "—" : "$" + Number(v).toString());
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
  // 0.54.0: the crawl's pay counts carry the age of their terms; stale past TERMS_MAX_AGE_HOURS (default 24 h)
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

async function skipsPage(env, n) {
  if (n === 1) return RECEIPTS;
  return (await kvJson(env, "s:" + n)) || null;
}

export async function handleSkips(req, url, env = {}) {
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
  const rows = skips
    .map((r) => {
      const f = r.id === m.featured_id;
      return `<tr id="${esc(r.id)}"${f ? ' class="featured"' : ""}><td><a href="/v1/receipts/${esc(r.id)}">${esc(r.id)}</a>${f ? " ★" : ""}</td><td class="u">${esc(r.method)} ${esc(r.url)}</td><td>${esc(usd(r.claimed_price_usd))}${r.listed_network ? "<br><small>" + esc(r.listed_network) + "</small>" : ""}</td><td>${esc(usd(r.quoted_price_usd))}${r.network ? "<br><small>" + esc(r.network) + "</small>" : ""}</td><td class="u">${esc(r.pay_to || "—")}</td><td>${esc(r.reason)}</td><td>${esc([r.source_list, ...(r.also_listed_in || [])].join(", "))}</td><td>${esc(r.timestamp)}</td></tr>`;
    })
    .join("\n");
  const fr = page === 1 ? RECEIPTS.find((r) => r.id === m.featured_id) : null;
  const cov = coverage();
  const pager = pages > 1 ? `<p>Page ${page} of ${pages} (${m.page_size} skips per page, clearest mismatches first) · ${page > 1 ? `<a href="/v1/skips?page=${page - 1}">← prev</a>` : ""} ${page < pages ? `<a href="/v1/skips?page=${page + 1}">next →</a>` : ""}</p>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>402xAgent skips: self-checked x402 receipts</title>
<link rel="icon" href="/favicon.ico?v=18" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=18">
<link rel="canonical" href="${CANON_ORIGIN}/v1/skips${page > 1 ? "?page=" + page : ""}">
<style>body{font:14px/1.45 system-ui,sans-serif;margin:1.5rem;max-width:1200px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:4px 6px;vertical-align:top;text-align:left}.u{word-break:break-all;font-family:ui-monospace,monospace;font-size:12px}tr:target,.featured{background:#fff6d5}header p{margin:.3rem 0}code{background:#f3f3f3;padding:1px 4px}.cov{font-size:16px}</style></head><body>
<header><p><a href="/">402xAgent</a> · <a href="/pricing">Pricing</a> · <a href="/docs">Docs</a> · <a href="/blog">Blog</a></p><h1>402xAgent skips: self-checked x402 receipts</h1>
<div class="free" style="border:1px solid #fde2c4;background:#fffaf3;border-radius:8px;padding:10px 12px;margin:0 0 12px"><b>Check your endpoint free first:</b> <code class="u">GET ${esc(FREE_CHECK_URL)}</code><br><small>Real example: <a class="u" href="${esc(FREE_CHECK_EXAMPLE_URL)}">${esc(FREE_CHECK_EXAMPLE_URL)}</a> → <code class="u">${esc(JSON.stringify(FREE_CHECK_EXAMPLE))}</code>. 5 free per day (25 per network), free dry runs with &amp;mode=dry-run. Then, only for the full payment terms, the paid check (HTTP 402).</small></div>
<p><small>402xAgent · <a href="${CANON_ORIGIN}">402xagent.com</a></small></p>
<p class="cov"><b>${cov.endpoints_covered}</b> endpoints covered · <b>${cov.new_this_week ?? "—"}</b> new this week${cov.previous_run ? "" : " (first full crawl)"} · ${esc(crawlScheduleText(m.crawled_at))}</p>
<p><b>${m.skip}</b> skip · ${m.pay} pay · ${m.recheck} recheck · lists: ${esc(Object.entries(m.listed_in || m.lists).map(([k, v]) => k + " " + v).join(", "))}</p>
<p>${esc(spotHowTo(origin))}</p>
<p><small>Self-checked: ${esc(m.method)} Deduped by ${esc(m.dedupe || "URL")}. Skip = no paywall (no 402), a malformed 402, price mismatch, wrong or unsupported network, a token other than canonical USDC, or a payTo that differs from the listing. Recheck = transient (timeout, network error, 5xx) or a free trial in use. JSON: <a href="/v1/skips.json">/v1/skips.json</a> · one receipt: /v1/receipts/&lt;id&gt; · by URL: /v1/receipts/by-url?url=&lt;endpoint&gt;. Facts only, not endorsements.</small></p>
${fr ? `<p>★ Featured mismatch <a href="#${esc(fr.id)}">#${esc(fr.id)}</a> (<a href="/v1/receipts/${esc(fr.id)}">permalink</a>): listed ${esc(usd(fr.claimed_price_usd))} on ${esc(fr.listed_network)}, 402 asks ${esc(usd(fr.quoted_price_usd))} on ${esc(fr.network)} → skip.</p>` : ""}
${pager}
</header>
<table><thead><tr><th>id</th><th>endpoint</th><th>claimed (listing)</th><th>402 price</th><th>402 payTo</th><th>reason</th><th>lists</th><th>checked (UTC)</th></tr></thead><tbody>
${rows}
</tbody></table>${pager}</body></html>`;
  return new Response(html, { status: 200, headers: hdrs("text/html; charset=utf-8") });
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
