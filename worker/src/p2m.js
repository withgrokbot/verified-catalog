// 0.63.0: page-to-markdown product. GET|POST /v1/products/page-to-markdown?url=<page> -> clean, LLM-ready Markdown of one
// public page (main content only; see page2md.js, shared with the Apify Actor draft). $0.002 USDC on Base via the existing
// x402 paid path (checkPayload -> fetch + extract -> verifyAndSettle with the settle-pending/idempotency store), after
// P2M_FREE_PER_DAY free pages per network per UTC day (default 3). Nothing is settled and no free page is used unless a page
// was extracted: robots.txt disallow, login walls, paywalls, 401/402/403, non-HTML and fetch errors answer 422 "not charged".
// Every hop is checked by the spot-check SSRF guard (assertSafeUrl). Rate limits use the existing QuotaCounter DO.
// Off switch: P2M=off (route 404s and every discovery surface drops the entries; the machine snapshots run with it off).
import { htmlToMarkdown, parseRobots, P2M_VERSION } from "./page2md.js";
import { assertSafeUrl, API_ORIGIN, CANON_ORIGIN } from "./spotcheck.js";
import { cfg, checkPayload, decodePaymentHeader, verifyAndSettle, paymentRequirements, takeFree, utcDay } from "./lib.js";

export const P2M_PATH = "/v1/products/page-to-markdown";
export const P2M_DEFAULT_PRICE_ATOMIC = "2000"; // $0.002 USDC (6 decimals)
export const P2M_DEFAULT_FREE_PER_DAY = 3;
export const P2M_PER_MIN = 20; // per network (salted IP hash), free and paid
export const P2M_HOST_PER_MIN = 30; // per target host, all callers
export const P2M_MAX_BYTES = 3 * 1024 * 1024;
export const P2M_TIMEOUT_MS = 10000;
export const P2M_UA = "402xAgent-PageToMarkdown/1.0 (+https://api.402xagent.com/v1/products/page-to-markdown/docs)";
const ROBOTS_TOKEN = "402xAgent-PageToMarkdown";
export const p2mOn = (env) => String((env && env.P2M) || "").toLowerCase() !== "off";
export function p2mCfg(env) {
  const c = cfg(env);
  const price = /^[0-9]{1,12}$/.test(String(env.P2M_PRICE_ATOMIC || "")) ? String(env.P2M_PRICE_ATOMIC) : P2M_DEFAULT_PRICE_ATOMIC;
  const free = parseInt(env.P2M_FREE_PER_DAY ?? "", 10);
  return { ...c, priceAtomic: price, priceUsd: (Number(price) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""), freePerDay: Number.isFinite(free) && free >= 0 ? free : P2M_DEFAULT_FREE_PER_DAY };
}
const DESC = (c) => `Page to Markdown: one public web page as clean, LLM-ready Markdown (main content only). ${c.priceUsd} USDC on Base; charged only when a page is returned.`;
export const P2M_MCP_TOOL = {
  name: "page_to_markdown",
  description: "Fetch one public web page and return clean, LLM-ready Markdown of its main content (no nav, footers, ads or cookie banners; absolute links; tables kept) plus title, description, links, word_count and token_estimate. Respects robots.txt; skips login walls, paywalls and 401/403 pages (never charged). 3 free pages per day, then $0.002 USDC on Base via x402: retry with the PAYMENT-SIGNATURE header.",
  inputSchema: { type: "object", properties: { url: { type: "string", description: "http(s) URL of a public page" }, format: { type: "string", enum: ["markdown", "json"], description: "markdown = url/title/markdown only; json (default) = all fields" } }, required: ["url"] },
};
const b64 = (o) => { const bytes = new TextEncoder().encode(JSON.stringify(o)); let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const J = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store", ...extra } });
async function hash(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32); }
function netKey(req, env, salt) { // IPv4 /24 or IPv6 /64, salted + hashed (the raw IP is never stored)
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "";
  const pre = ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip.split(".").slice(0, 3).join(".");
  return hash(`${env.CLIENT_SALT || "unsalted-dev"}|${salt}|${pre}`);
}
export function p2mPaymentRequired(c, resourceUrl, error, freeUsed = null) {
  return {
    x402Version: 2, error,
    resource: { url: resourceUrl, description: DESC(c), mimeType: "application/json", serviceName: "402xAgent Page to Markdown", tags: ["x402", "markdown", "scrape", "llm", "rag"] },
    accepts: [paymentRequirements(c, resourceUrl, 2, { paidPath: true, description: DESC(c) })],
    price_usd: c.priceUsd, asset: "USDC on Base (eip155:8453)", free_per_day: c.freePerDay, ...(freeUsed != null ? { free_used_today: freeUsed } : {}),
    how_to_pay: "Retry the same request with a PAYMENT-SIGNATURE header (x402 v2; X-PAYMENT also accepted). The page is fetched first; the payment is settled only if Markdown is returned.",
  };
}

/** Fetch with the SSRF guard on every redirect hop, a byte cap and a timeout. Returns {status, url, headers, text} or {error}. */
export async function guardedGet(raw, { fetchImpl = fetch, resolveHostFn, accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", maxBytes = P2M_MAX_BYTES, timeoutMs = P2M_TIMEOUT_MS } = {}) {
  let cur = raw; const deadline = Date.now() + timeoutMs;
  for (let hop = 0; hop < 6; hop++) {
    const safe = await assertSafeUrl(cur, resolveHostFn ? { resolveHostFn, fetchImpl } : { fetchImpl });
    if (!safe.ok) return { error: "ssrf_blocked", detail: safe.reason, url: cur };
    let r;
    try { r = await fetchImpl(safe.url.href, { method: "GET", redirect: "manual", headers: { "user-agent": P2M_UA, accept }, signal: AbortSignal.timeout(Math.max(500, deadline - Date.now())) }); }
    catch (e) { return { error: /timeout|abort/i.test(String(e && (e.name || e.message))) ? "timeout" : "fetch_failed", url: cur }; }
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { cur = new URL(r.headers.get("location"), safe.url).href; continue; }
    const len = Number(r.headers.get("content-length") || 0);
    if (len > maxBytes) return { error: "too_large", status: r.status, url: safe.url.href };
    let text = "";
    if (r.body && r.body.getReader) {
      const rd = r.body.getReader(); const dec = new TextDecoder(); let n = 0;
      for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.byteLength; if (n > maxBytes) { try { rd.cancel(); } catch (_) {} return { error: "too_large", status: r.status, url: safe.url.href }; } text += dec.decode(value, { stream: true }); }
    } else text = await r.text();
    return { status: r.status, url: safe.url.href, headers: r.headers, text };
  }
  return { error: "too_many_redirects", url: cur };
}
/** robots.txt for the page's origin: 4xx = allow all, 5xx/unreachable = disallow (RFC 9309 2.3.1). */
export async function robotsAllows(pageUrl, opts = {}) {
  const u = new URL(pageUrl);
  const r = await guardedGet(u.origin + "/robots.txt", { ...opts, accept: "text/plain,*/*", maxBytes: 512 * 1024, timeoutMs: 5000 });
  if (r.error) return r.error === "ssrf_blocked" ? false : r.error === "too_large" ? true : false;
  if (r.status >= 500) return false;
  if (r.status >= 400) return true;
  return parseRobots(r.text, ROBOTS_TOKEN).isAllowed(u.pathname + u.search);
}
/** Fetch + extract one page. {ok:true, page} or {ok:false, status, reason}. */
export async function convertPage(target, opts = {}) {
  if (!(await robotsAllows(target, opts))) return { ok: false, status: 422, reason: "robots_txt_disallow" };
  const r = await guardedGet(target, opts);
  if (r.error) return { ok: false, status: r.error === "ssrf_blocked" ? 400 : 422, reason: r.error, ...(r.detail ? { detail: r.detail } : {}) };
  if (r.status === 401 || r.status === 403) return { ok: false, status: 422, reason: "auth_required_http_" + r.status };
  if (r.status === 402) return { ok: false, status: 422, reason: "paywall_http_402" };
  if (r.status >= 400) return { ok: false, status: 422, reason: "http_" + r.status };
  const ct = String(r.headers.get("content-type") || "");
  if (ct && !/html|xml/i.test(ct)) return { ok: false, status: 422, reason: "not_html" };
  const page = htmlToMarkdown(r.text, r.url);
  if (page.blocked) return { ok: false, status: 422, reason: page.blocked };
  return { ok: true, page };
}

export async function handlePageToMarkdown(req, env, ctx, url, opts = {}) {
  if (!p2mOn(env)) return J({ error: "not found" }, 404);
  const c = p2mCfg(env);
  const resourceUrl = url.origin + P2M_PATH;
  let target = url.searchParams.get("url") || "", format = url.searchParams.get("format") || "json";
  if (req.method === "POST" && !target) { try { const b = await req.clone().json(); target = String(b.url || ""); format = String(b.format || format); } catch (_) {} }
  if (!target) return J({ error: "url is required", usage: API_ORIGIN + P2M_PATH + "?url=https://example.com/article", docs: API_ORIGIN + P2M_PATH + "/docs" }, 400);
  const safe = await assertSafeUrl(target, opts.resolveHostFn ? { resolveHostFn: opts.resolveHostFn, fetchImpl: opts.fetchImpl } : {});
  if (!safe.ok) return J({ error: "url not allowed: " + safe.reason, charged: false }, 400);
  target = safe.url.href;
  const now = new Date();
  const nk = await netKey(req, env, "p2m");
  const minute = now.toISOString().slice(0, 16);
  if (!(await takeFree(env, "p2m-rl:" + nk, P2M_PER_MIN, now, "take", "p2m-rl", minute)).free) return J({ error: `rate limited: ${P2M_PER_MIN} pages per minute per network`, charged: false }, 429, { "retry-after": "60" });
  if (!(await takeFree(env, "p2m-host:" + safe.url.hostname, P2M_HOST_PER_MIN, now, "take", "p2m-host", minute)).free) return J({ error: `rate limited: ${P2M_HOST_PER_MIN} pages per minute per target site`, charged: false }, 429, { "retry-after": "60" });

  const hdr = req.headers.get("payment-signature") || req.headers.get("x-payment") || "";
  let payload = null, freeKey = null;
  if (hdr) {
    payload = decodePaymentHeader(hdr);
    if (!payload) return J(p2mPaymentRequired(c, resourceUrl, "payment header is not valid base64 JSON x402 payload"), 402, { "payment-required": b64(p2mPaymentRequired(c, resourceUrl, "invalid payment header")) });
    const bad = checkPayload(payload, c);
    if (bad) { const body = p2mPaymentRequired(c, resourceUrl, "payment rejected: " + bad); return J(body, 402, { "payment-required": b64(body) }); }
  } else {
    freeKey = "p2m-free:" + nk;
    const peek = await takeFree(env, freeKey, c.freePerDay, now, "peek", "p2m-free", utcDay(now));
    if (!peek.free) { const body = p2mPaymentRequired(c, resourceUrl, `Payment required: ${c.freePerDay} free pages per UTC day used; then ${c.priceUsd} USDC on Base per page via x402.`, peek.used); return J(body, 402, { "payment-required": b64(body) }); }
  }
  const t0 = Date.now();
  const res = await convertPage(target, opts);
  if (!res.ok) return J({ error: "page not converted", reason: res.reason, ...(res.detail ? { detail: res.detail } : {}), url: target, charged: false, note: "Nothing was charged and no free page was used." }, res.status);
  const p = res.page;
  const out = format === "markdown" ? { url: p.url, title: p.title, markdown: p.markdown } : p;
  const meta = { extractor: "page2md/" + P2M_VERSION, fetch_ms: Date.now() - t0 };
  if (!hdr) {
    const took = await takeFree(env, freeKey, c.freePerDay, now, "take", "p2m-free", utcDay(now));
    if (!took.free) { const body = p2mPaymentRequired(c, resourceUrl, "free pages for today were used by a concurrent request", took.used); return J(body, 402, { "payment-required": b64(body) }); }
    return J({ ...out, ...meta, access: { tier: "free", free_per_day: c.freePerDay, ...(took.used != null ? { free_used_today: took.used } : {}), then: `${c.priceUsd} USDC on Base per page via x402` } });
  }
  const r = await verifyAndSettle(c, payload, new URL(resourceUrl), { paidPath: true, description: DESC(c), bind: { target, method: "GET" } });
  if (!r.ok && r.pending) return J({ error: "payment pending", reason: r.reason, ref: r.ref || null, note: "Do not sign a new payment; retry the same request with the same PAYMENT-SIGNATURE." }, 503, { "retry-after": "10" });
  if (!r.ok) { const body = p2mPaymentRequired(c, resourceUrl, "payment rejected: " + r.reason); return J(body, 402, { "payment-required": b64(body) }); }
  const enc = b64(r.settle);
  return J({ ...out, ...meta, access: { tier: "paid", charged_usd: c.priceUsd, asset: "USDC on Base", facilitator: r.facilitator || null, ...(r.recovered ? { replayed: true } : {}) } }, 200, { "payment-response": enc, "x-payment-response": enc });
}

export function p2mDocs(c) {
  return {
    product: "page-to-markdown", version: "1",
    what: "One public web page as clean, LLM-ready Markdown: main content only (Readability-style pick; nav, headers, footers, sidebars, ads, share bars and cookie banners removed), collapsed whitespace, no empty links, absolute URLs, GFM tables and fenced code kept.",
    route: { methods: ["GET", "POST"], url: API_ORIGIN + P2M_PATH + "?url=<page>&format=json|markdown", post_body: { url: "<page>", format: "json" } },
    output: { url: "final URL after redirects", title: "og:title or <title>", description: "meta description", markdown: "the Markdown", links: "absolute links found in the main content", word_count: "words in the Markdown", token_estimate: "characters / 4 (approximate)", extractor: "page2md version", fetch_ms: "fetch + extract time", access: "free or paid" },
    price: { free_per_day: c.freePerDay, then_usd: c.priceUsd, amount_atomic: c.priceAtomic, asset: "USDC on Base (eip155:8453)", protocol: "x402 v2 exact", charged_only_on_success: true },
    not_charged: ["robots_txt_disallow", "login_wall", "paywall", "paywall_http_402", "auth_required_http_401", "auth_required_http_403", "http_<status>", "not_html", "too_large", "timeout", "fetch_failed", "too_many_redirects", "empty_content"],
    limits: { per_minute_per_network: P2M_PER_MIN, per_minute_per_target_site: P2M_HOST_PER_MIN, max_bytes: P2M_MAX_BYTES, timeout_ms: P2M_TIMEOUT_MS, javascript_rendering: false, single_page_only: true },
    safety: "Private, loopback and link-local addresses are refused on every redirect hop (the same guard as the 402xAgent check). robots.txt is read for every page (user-agent token 402xAgent-PageToMarkdown); 5xx or unreachable robots.txt = not fetched.",
    mcp: { url: API_ORIGIN + "/mcp", tool: "page_to_markdown", payment: "forward the PAYMENT-SIGNATURE header on the MCP request" },
  };
}
