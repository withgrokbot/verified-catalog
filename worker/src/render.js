// Render API (0.65.0, OFF by default: RENDER must be "1", else every route 404s).
//   POST /v1/render/pdf         {url | html, format?: "A4"|"Letter", landscape?}             -> application/pdf
//   POST /v1/render/screenshot  {url | html, width?, height?, fullPage?, format?: png|jpeg}  -> image/png | image/jpeg
//   POST /v1/render/card        {template, fields | html, size?, format?}                    -> image/png | image/jpeg (0.67.0)
//   GET  /v1/render/card?t=&sig=  HMAC-signed card, for og:image (0.67.0)
//   POST /v1/render/keys        {email}                                                      -> a free API key (shown once)
// Rendering runs in Cloudflare Browser Rendering (wrangler binding "BROWSER", @cloudflare/puppeteer). No binding = 503,
// nothing charged and no quota used.
// Two ways to pay:
//   1. No key: x402 per call, $0.002 USDC on Base (RENDER_PRICE_ATOMIC, default 2000). 402 quote -> paid retry -> render ->
//      settle ONLY if the render succeeded (otherwise "not charged").
//   2. API key (x-api-key or Authorization: Bearer rk_...): monthly quota per plan (free 500, starter 5,000 at $10,
//      pro 25,000 at $29). The quota is a HARD CAP: at quota the call answers 429 with an upgrade note; nothing is ever billed
//      as overage. A failed render gives its unit back. Key signup needs an email; disposable domains are refused.
// Abuse controls: http/https only; every URL (the first one, every redirect hop and every subresource the page asks for) is
// DNS-resolved and refused when it points at a private, loopback, link-local, metadata or otherwise reserved address;
// 15 s browser time per call; 2 MB input HTML; 10 MB output; per-network and per-key per-minute limits; a key that bursts to
// RENDER_SPIKE_FACTOR x its per-minute limit inside one minute is suspended automatically.
import { assertSafeUrl, isBlockedIp, API_ORIGIN } from "./spotcheck.js";
import { cfg, checkPayload, decodePaymentHeader, verifyAndSettle, paymentRequirements, takeFree } from "./lib.js";
import { disposableDomains } from "./disposable-domains.js";
import { billingOn, billingDocs, applyPlanEnd, hmacHex, timingSafeEqual } from "./billing.js";

export const RENDER_PDF_PATH = "/v1/render/pdf";
export const RENDER_SHOT_PATH = "/v1/render/screenshot";
export const RENDER_CARD_PATH = "/v1/render/card";
export const RENDER_KEYS_PATH = "/v1/render/keys";
export const RENDER_DEFAULT_PRICE_ATOMIC = "2000"; // $0.002 per render
export const RENDER_TIME_MS = 15000; // browser time per call
export const RENDER_MAX_HTML_BYTES = 2 * 1024 * 1024;
export const RENDER_MAX_BODY_BYTES = 3 * 1024 * 1024; // JSON-escaped HTML can be longer than the HTML itself
export const RENDER_MAX_OUT_BYTES = 10 * 1024 * 1024;
export const RENDER_PER_IP_MIN = 20; // per network (/24, /64) per minute, both paths
export const RENDER_SIGNUPS_PER_IP_DAY = 3;
export const RENDER_SPIKE_FACTOR = 5;
export const RENDER_PLANS = {
  free: { quota: 500, perMin: 10, priceUsd: 0 },
  starter: { quota: 5000, perMin: 60, priceUsd: 10 },
  pro: { quota: 25000, perMin: 120, priceUsd: 29 },
};
export const renderOn = (env) => String((env && env.RENDER) || "") === "1";
export function renderCfg(env) {
  const c = cfg(env);
  const unit = /^[0-9]{1,12}$/.test(String(env.RENDER_PRICE_ATOMIC || "")) ? String(env.RENDER_PRICE_ATOMIC) : RENDER_DEFAULT_PRICE_ATOMIC;
  return { ...c, priceAtomic: unit, priceUsd: usd(unit) };
}
const usd = (atomic) => (Number(atomic) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
const UPGRADE = "Monthly quota reached. This is a hard cap: nothing is billed beyond your plan. Upgrade (starter $10/mo = 5,000 renders, pro $29/mo = 25,000) or pay per render with x402 and no key ($0.002 each). Plans: " + API_ORIGIN + "/v1/render/docs";

const b64 = (o) => { const bytes = new TextEncoder().encode(JSON.stringify(o)); let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const J = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, X-QUOTA-LIMIT, X-QUOTA-REMAINING", "cache-control": "no-store", ...extra } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", typeof s === "string" ? new TextEncoder().encode(s) : s));
const pepper = (env) => env.RENDER_KEY_PEPPER || env.CLIENT_SALT || "";
async function netKey(req, env) {
  const ip = req.headers.get("cf-connecting-ip") || "";
  const pre = ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip.split(".").slice(0, 3).join(".");
  return (await sha(`${env.CLIENT_SALT || "unsalted-dev"}|render|${pre}`)).slice(0, 32);
}

// ---------- email check (free-key signup) ----------
/** {ok:true, email} or {ok:false, reason}. Refuses malformed addresses and disposable domains (incl. their subdomains). */
export function checkEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) return { ok: false, reason: "invalid_email" };
  const parts = email.split("@")[1].split(".");
  const set = disposableDomains();
  for (let i = 0; i < parts.length - 1; i++) if (set.has(parts.slice(i).join("."))) return { ok: false, reason: "disposable_email" };
  return { ok: true, email };
}

// ---------- input ----------
async function readBody(req, max) {
  if (Number(req.headers.get("content-length") || 0) > max) return { error: "too_large" };
  if (!req.body) return { text: "" };
  const rd = req.body.getReader(); const chunks = []; let n = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.byteLength; if (n > max) { try { rd.cancel(); } catch (_) {} return { error: "too_large" }; } chunks.push(value); }
  const u8 = new Uint8Array(n); let o = 0; for (const c of chunks) { u8.set(c, o); o += c.length; }
  return { text: new TextDecoder().decode(u8) };
}
const clampInt = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
/** Parse + validate the request. {input} or {status, body}. Never charges. */
export async function parseRenderInput(req, kind, opts = {}) {
  const raw = await readBody(req, RENDER_MAX_BODY_BYTES);
  if (raw.error) return { status: 413, body: { error: `request body over ${RENDER_MAX_BODY_BYTES} bytes`, charged: false } };
  let b; try { b = raw.text ? JSON.parse(raw.text) : {}; } catch (_) { return { status: 400, body: { error: "body must be JSON", charged: false } }; }
  if (!b || typeof b !== "object") return { status: 400, body: { error: "body must be a JSON object", charged: false } };
  const hasUrl = typeof b.url === "string" && b.url !== "", hasHtml = typeof b.html === "string" && b.html !== "";
  if (hasUrl === hasHtml) return { status: 400, body: { error: "send exactly one of url or html", charged: false, docs: API_ORIGIN + "/v1/render/docs" } };
  if (hasHtml && new TextEncoder().encode(b.html).length > RENDER_MAX_HTML_BYTES) return { status: 413, body: { error: `html over ${RENDER_MAX_HTML_BYTES} bytes (2 MB)`, charged: false } };
  const input = { kind };
  if (hasUrl) {
    const safe = await assertSafeUrl(b.url, opts.resolveHostFn ? { resolveHostFn: opts.resolveHostFn } : {});
    if (!safe.ok) return { status: 400, body: { error: "url not allowed: " + safe.reason, reason: "ssrf_blocked", charged: false } };
    input.url = safe.url.href;
  } else input.html = b.html;
  if (kind === "pdf") {
    input.format = ["A4", "Letter"].includes(b.format) ? b.format : "A4";
    if (b.format !== undefined && !["A4", "Letter"].includes(b.format)) return { status: 400, body: { error: "format must be A4 or Letter", charged: false } };
    input.landscape = b.landscape === true;
  } else {
    const f = b.format === undefined ? "png" : b.format;
    if (!["png", "jpeg"].includes(f)) return { status: 400, body: { error: "format must be png or jpeg", charged: false } };
    input.format = f; input.width = clampInt(b.width, 320, 1920, 1280); input.height = clampInt(b.height, 240, 4000, 800); input.fullPage = b.fullPage === true;
  }
  input.bind = await sha(JSON.stringify({ ...input, html: input.html ? await sha(input.html) : undefined }));
  return { input };
}

// ---------- browser ----------
/** Request guard for every browser request. data/blob/about pass; websocket and service-worker requests are aborted outright;
 * every http(s) request is DNS-resolved again AT REQUEST TIME (no per-host cache) and must pass assertSafeUrl; anything else
 * is aborted. Responses are checked too: if the browser actually connected to a blocked IP (DNS rebinding between our
 * lookup and the browser's), the render fails and nothing is returned or charged. */
export const BLOCKED_RESOURCE_TYPES = new Set(["websocket", "eventsource-ws", "serviceworker", "service_worker"]);
export function makeRequestGuard(opts = {}) {
  const blocked = []; const rebound = [];
  const allow = opts.allowUrls ? new Set(opts.allowUrls) : null;
  const check = async (u) => {
    let p; try { p = new URL(u); } catch (_) { return false; }
    if (["data:", "blob:", "about:"].includes(p.protocol)) return true;
    if (p.protocol !== "http:" && p.protocol !== "https:") return false; // ws:, wss:, file:, chrome:, ftp: ...
    // Template cards: no network except the image URLs that already passed assertSafeUrl (checked again here).
    if (opts.templateMode && (!allow || !allow.has(p.href))) return false;
    const s = await assertSafeUrl(u, opts.resolveHostFn ? { resolveHostFn: opts.resolveHostFn } : {});
    return !!s.ok;
  };
  const onRequest = async (r) => {
    let ok = false;
    try {
      const type = typeof r.resourceType === "function" ? String(r.resourceType() || "").toLowerCase() : "";
      const sw = typeof r.isServiceWorker === "function" ? r.isServiceWorker() : false; // not in every puppeteer build
      ok = !BLOCKED_RESOURCE_TYPES.has(type) && !sw && (await check(r.url()));
    } catch (_) { ok = false; }
    if (ok) { try { await r.continue(); } catch (_) {} } else { blocked.push(r.url()); try { await r.abort("blockedbyclient"); } catch (_) {} }
  };
  const onResponse = (resp) => {
    try {
      const ip = resp && typeof resp.remoteAddress === "function" ? (resp.remoteAddress() || {}).ip : null;
      const bare = ip ? String(ip).replace(/^\[|\]$/g, "") : "";
      // Cloudflare Browser Rendering reports its local proxy (::1 / 127.0.0.1) as the remote address of EVERY response
      // (seen in a real run, 2026-11-04), so loopback here says nothing about the target and is ignored. Any other
      // private, link-local or metadata address still fails the render. A full DNS-rebinding fix is a follow-up.
      if (bare && !/^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/i.test(bare) && isBlockedIp(bare)) rebound.push(resp.url());
    } catch (_) {}
  };
  return { check, onRequest, onResponse, blocked, rebound };
}
/** In-page hardening, before any page script runs: no WebSocket, WebTransport or service workers. */
export const PAGE_HARDEN_JS = `(() => { const no = function () { throw new Error("blocked by render sandbox"); };
  try { Object.defineProperty(window, "WebSocket", { value: no, configurable: false, writable: false }); } catch (_) {}
  try { Object.defineProperty(window, "WebTransport", { value: no, configurable: false, writable: false }); } catch (_) {}
  try { if (navigator.serviceWorker) Object.defineProperty(navigator, "serviceWorker", { get: () => undefined, configurable: false }); } catch (_) {} })();`;
export async function hardenPage(page) {
  const done = [];
  try { if (page.setBypassServiceWorker) { await page.setBypassServiceWorker(true); done.push("bypass_service_worker"); } } catch (_) {}
  try { if (page.evaluateOnNewDocument) { await page.evaluateOnNewDocument(PAGE_HARDEN_JS); done.push("no_websocket_no_sw_js"); } } catch (_) {}
  try { // CDP: block ws/wss at the network layer (request interception does not see WebSocket handshakes)
    const cdp = page.createCDPSession ? await page.createCDPSession() : (page.target && page.target().createCDPSession ? await page.target().createCDPSession() : null);
    if (cdp) { await cdp.send("Network.enable"); await cdp.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] }); done.push("cdp_block_ws"); }
  } catch (_) {}
  return done;
}

/** Run one render. {ok, bytes, contentType, blocked} or {ok:false, reason, status}. */
export async function runRender(env, input, opts = {}) {
  const launch = opts.launch || (env.BROWSER ? async (b) => (await import("@cloudflare/puppeteer")).default.launch(b) : null);
  if (!launch) return { ok: false, reason: "browser_not_configured", status: 503 };
  const timeMs = opts.timeMs || RENDER_TIME_MS;
  const guard = makeRequestGuard({ ...opts, templateMode: !!input.templateMode, allowUrls: input.allowUrls || null });
  let browser = null, timer, done = false, hardened = [];
  const work = (async () => {
    browser = await launch(env.BROWSER);
    if (done) { try { await browser.close(); } catch (_) {} return { ok: false, reason: "render_timeout", status: 504 }; }
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    hardened = await hardenPage(page);
    page.on("request", guard.onRequest); // every navigation, redirect hop and subresource
    if (page.on) page.on("response", guard.onResponse);
    if (input.kind === "screenshot" || input.kind === "card") await page.setViewport({ width: input.width, height: input.height });
    if (input.url) {
      const resp = await page.goto(input.url, { waitUntil: "load", timeout: timeMs });
      if (!resp) return { ok: false, reason: guard.blocked.length ? "ssrf_blocked" : "navigation_failed", status: guard.blocked.length ? 400 : 422 };
      if (resp.status() >= 400) return { ok: false, reason: "http_" + resp.status(), status: 422 };
    } else await page.setContent(input.html, { waitUntil: "load", timeout: timeMs });
    if (input.templateMode && guard.blocked.length) return { ok: false, reason: "ssrf_blocked", status: 400 };
    const out = input.kind === "pdf"
      ? await page.pdf({ format: input.format, landscape: input.landscape, printBackground: true, timeout: timeMs })
      : await page.screenshot({ type: input.format === "jpeg" ? "jpeg" : "png", fullPage: input.fullPage, ...(input.format === "jpeg" ? { quality: 80 } : {}) });
    if (guard.rebound.length) return { ok: false, reason: "ssrf_blocked", detail: "the browser connected to a private address (DNS rebinding?)", status: 400 };
    const bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
    if (bytes.byteLength > RENDER_MAX_OUT_BYTES) return { ok: false, reason: "output_too_large", status: 413 };
    const imageType = input.format === "jpeg" ? "jpeg" : "png";
    return { ok: true, bytes, contentType: input.kind === "pdf" ? "application/pdf" : "image/" + imageType };
  })();
  const timeout = new Promise((res) => { timer = setTimeout(() => res({ ok: false, reason: "render_timeout", status: 504 }), timeMs); });
  let r;
  try { r = await Promise.race([work, timeout]); }
  catch (e) {
    const m = String((e && (e.message || e.name)) || e);
    r = guard.blocked.length && /ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(m) ? { ok: false, reason: "ssrf_blocked", status: 400 }
      : /timeout/i.test(m) ? { ok: false, reason: "render_timeout", status: 504 }
      : /429|rate limit|too many/i.test(m) ? { ok: false, reason: "browser_busy", status: 503 } : { ok: false, reason: "render_failed", status: 502 };
  } finally { done = true; clearTimeout(timer); work.catch(() => {}); if (browser) { try { await browser.close(); } catch (_) {} } }
  return { ...r, blocked: guard.blocked.length, hardened };
}

// ---------- API keys ----------
const month = (now) => now.toISOString().slice(0, 7);
const minute = (now) => now.toISOString().slice(0, 16);
export async function paymentKey(payload) {
  const p = (payload && payload.payload) || {};
  return sha("render-pay|" + String(p.signature || "") + "|" + String((p.authorization && p.authorization.nonce) || "").toLowerCase());
}
export const hashKey = async (env, raw) => sha(pepper(env) + "|key|" + raw);
function newKey() { const b = new Uint8Array(24); crypto.getRandomValues(b); return "rk_" + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
export function keyFromReq(req) {
  const x = req.headers.get("x-api-key"); if (x) return x.trim();
  const a = req.headers.get("authorization") || ""; const m = /^Bearer\s+(rk_[A-Za-z0-9_-]+)$/.exec(a.trim());
  return m ? m[1] : "";
}
export async function loadKey(env, raw, now = new Date()) {
  const h = await hashKey(env, raw);
  if (!billingOn(env)) return env.RECEIPTS_DB.prepare("SELECT id, key_hash, plan, monthly_quota, status FROM api_keys WHERE key_hash = ?").bind(h).first();
  // BILLING=1 (needs migrations 0027 + 0028): a paid plan past its end date drops to free here, before quota and rate limits
  return applyPlanEnd(env, await env.RECEIPTS_DB.prepare("SELECT id, key_hash, plan, monthly_quota, status, plan_ends_at, grace_ends_at FROM api_keys WHERE key_hash = ?").bind(h).first(), now);
}
/** Same row as loadKey, by the internal id carried in a signed card URL. */
export async function loadKeyById(env, id, now = new Date()) {
  if (!env.RECEIPTS_DB || !/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
  if (!billingOn(env)) return env.RECEIPTS_DB.prepare("SELECT id, key_hash, plan, monthly_quota, status FROM api_keys WHERE id = ?").bind(id).first();
  return applyPlanEnd(env, await env.RECEIPTS_DB.prepare("SELECT id, key_hash, plan, monthly_quota, status, plan_ends_at, grace_ends_at FROM api_keys WHERE id = ?").bind(id).first(), now);
}
/** Count one call in the key's minute bucket. {limited, suspended} — a burst over perMin x SPIKE_FACTOR suspends the key. */
export async function keyMinute(env, key, now = new Date()) {
  const plan = RENDER_PLANS[key.plan] || RENDER_PLANS.free; const m = minute(now); const db = env.RECEIPTS_DB;
  await db.prepare("INSERT INTO api_key_minute (key_id, minute, n) VALUES (?, ?, 1) ON CONFLICT(key_id, minute) DO UPDATE SET n = n + 1").bind(key.id, m).run();
  const row = await db.prepare("SELECT n FROM api_key_minute WHERE key_id = ? AND minute = ?").bind(key.id, m).first();
  const n = row ? row.n : 1;
  if (n === 1) await db.prepare("DELETE FROM api_key_minute WHERE minute < ?").bind(minute(new Date(now.getTime() - 10 * 60000))).run();
  if (n > plan.perMin * RENDER_SPIKE_FACTOR) {
    await db.prepare("UPDATE api_keys SET status = 'suspended', suspended_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'").bind(`spike: ${n} calls in one minute (limit ${plan.perMin})`, Math.floor(now.getTime() / 1000), key.id).run();
    return { limited: true, suspended: true, n };
  }
  return { limited: n > plan.perMin, suspended: false, n, perMin: plan.perMin };
}
/** pdf | shot | card. A screenshot is stored as shot. Anything else counts as pdf. */
export function usageKind(kind) {
  if (kind === "screenshot" || kind === "shot") return "shot";
  if (kind === "card") return "card";
  return "pdf";
}
/** Reserve one unit of the month's quota. Hard cap: {ok:false} at quota, nothing is ever billed past it.
 * The cap is the sum of pdf + shot + card for the month (one card = one render). */
export async function reserveQuota(env, key, now = new Date(), kind = "pdf") {
  const db = env.RECEIPTS_DB; const mo = month(now); const t = Math.floor(now.getTime() / 1000); const knd = usageKind(kind);
  await db.prepare("INSERT OR IGNORE INTO api_key_usage (key_id, month, kind, renders, updated_at) VALUES (?, ?, ?, 0, ?)").bind(key.id, mo, knd, t).run();
  const r = await db.prepare("UPDATE api_key_usage SET renders = renders + 1, updated_at = ? WHERE key_id = ? AND month = ? AND kind = ? AND (SELECT COALESCE(SUM(renders), 0) FROM api_key_usage WHERE key_id = ? AND month = ?) < ?").bind(t, key.id, mo, knd, key.id, mo, key.monthly_quota).run();
  const row = await db.prepare("SELECT COALESCE(SUM(renders), 0) AS renders FROM api_key_usage WHERE key_id = ? AND month = ?").bind(key.id, mo).first();
  const used = row ? Number(row.renders) : 0;
  return { ok: !!(r.meta && r.meta.changes), used, remaining: Math.max(0, key.monthly_quota - used), limit: key.monthly_quota };
}
export async function releaseQuota(env, key, now = new Date(), kind = "pdf") {
  await env.RECEIPTS_DB.prepare("UPDATE api_key_usage SET renders = renders - 1 WHERE key_id = ? AND month = ? AND kind = ? AND renders > 0").bind(key.id, month(now), usageKind(kind)).run();
}

export const RENDER_VERIFY_PATH = "/v1/render/keys/verify";
export const RENDER_UNSUB_PATH = "/v1/render/keys/unsubscribe";
export const RENDER_EMAIL_SUBJECT = "Confirm your 402xAgent API key";
/** The one signup email: plain text only (the link is shown as-is), short plain subject, and a List-Unsubscribe that
 * cancels this pending signup. It is the only mail we send to the address; we keep no address to mail again. */
export function signupEmail(to, from, link, unsubLink) {
  return {
    to, from: { email: from, name: "402xAgent" }, subject: RENDER_EMAIL_SUBJECT,
    text: `Someone (hopefully you) asked for a free 402xAgent Render API key for this address.\n\nTo confirm, open this link within 30 minutes and press the button:\n${link}\n\nIf you didn't ask for this, ignore this email. No key is created unless the link is opened, and we won't email you again.\n\n402xAgent - https://402xagent.com`,
    headers: { "List-Unsubscribe": `<${unsubLink}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
/** List-Unsubscribe target: cancels the pending signup for that token (one-click POST or GET page). Always 200. */
export async function handleRenderUnsubscribe(req, env, ctx, url) {
  if (!renderOn(env)) return J({ error: "not found" }, 404);
  const token = url.searchParams.get("token") || "";
  if (req.method === "POST" && env.RECEIPTS_DB && pepper(env) && /^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    try { await env.RECEIPTS_DB.prepare("DELETE FROM render_signups WHERE token_hash = ?").bind(await tokenHash(env, token)).run(); } catch (_) {}
  }
  if (req.method === "POST") return J({ ok: true, note: "Signup cancelled. We send no other email to this address." });
  return H(`<h1>Unsubscribe</h1><p>That email was a one-time confirmation link. We don't send any other email and keep no address to mail again.</p><form method="post" action="${RENDER_UNSUB_PATH}?token=${esc(encodeURIComponent(token))}"><button type="submit">Cancel this signup</button></form>`);
}
export const RENDER_VERIFY_TTL_S = 30 * 60; // a verify link works for 30 minutes, once
export const emailOn = (env) => !!(env.RENDER_EMAIL && typeof env.RENDER_EMAIL.send === "function" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(env.RENDER_EMAIL_FROM || "")));
const SENT = { status: "check_your_email", note: "If this address can get a free key, a one-time link is on its way. It expires in 30 minutes. The key is issued only when you open the link." };
function newToken() { const b = new Uint8Array(32); crypto.getRandomValues(b); return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
const tokenHash = (env, t) => sha(pepper(env) + "|verify|" + t);
const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const H = (body, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>402xAgent Render key</title><body style="font:16px system-ui;max-width:640px;margin:3em auto">${body}</body>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" } });

/** Step 1: POST {email}. Stores a PENDING row (email hash + token hash, 30 min) and mails a one-time link. No key yet.
 * The answer is the same whether or not a key already exists for the address (no account probing). */
export async function handleRenderSignup(req, env, ctx, url, opts = {}) {
  if (!renderOn(env)) return J({ error: "not found" }, 404);
  if (!env.RECEIPTS_DB || !pepper(env) || !emailOn(env)) return J({ error: "key signup is not configured on this deployment", reason: "signup_not_configured" }, 503);
  const raw = await readBody(req, 4096);
  let b = {}; try { b = raw.text ? JSON.parse(raw.text) : {}; } catch (_) {}
  const e = checkEmail(b && b.email);
  if (!e.ok) return J({ error: e.reason === "disposable_email" ? "disposable email addresses can't get a free key; use a permanent address" : "a valid email is required", reason: e.reason }, 400);
  const now = opts.now || new Date();
  if (!(await takeFree(env, "render-signup:" + (await netKey(req, env)), RENDER_SIGNUPS_PER_IP_DAY, now, "take", "render-signup")).free) return J({ error: `at most ${RENDER_SIGNUPS_PER_IP_DAY} key signups per network per day` }, 429, { "retry-after": "3600" });
  const emailHash = await sha(pepper(env) + "|email|" + e.email);
  if (await env.RECEIPTS_DB.prepare("SELECT 1 AS x FROM api_keys WHERE email_hash = ?").bind(emailHash).first()) return J(SENT, 202);
  const t = Math.floor(now.getTime() / 1000); const token = newToken();
  await env.RECEIPTS_DB.prepare("DELETE FROM render_signups WHERE email_hash = ? OR expires_at <= ?").bind(emailHash, t).run(); // one live link per address
  await env.RECEIPTS_DB.prepare("INSERT INTO render_signups (token_hash, email_hash, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await tokenHash(env, token), emailHash, t, t + RENDER_VERIFY_TTL_S).run();
  const link = url.origin + RENDER_VERIFY_PATH + "?token=" + encodeURIComponent(token);
  try {
    await env.RENDER_EMAIL.send(signupEmail(e.email, String(env.RENDER_EMAIL_FROM), link, url.origin + RENDER_UNSUB_PATH + "?token=" + encodeURIComponent(token)));
  } catch (err) {
    await env.RECEIPTS_DB.prepare("DELETE FROM render_signups WHERE email_hash = ?").bind(emailHash).run();
    return J({ error: "could not send the verification email, try again later", reason: "email_send_failed" }, 502);
  }
  return J(SENT, 202);
}

/** Step 2: GET shows a confirm button (so mail scanners that prefetch links don't use the token); POST redeems the token
 * once, before it expires, and issues the key (shown once). */
export async function handleRenderVerify(req, env, ctx, url, opts = {}) {
  if (!renderOn(env)) return J({ error: "not found" }, 404);
  if (!env.RECEIPTS_DB || !pepper(env)) return J({ error: "key signup is not configured on this deployment" }, 503);
  let token = url.searchParams.get("token") || "";
  if (req.method === "GET" || req.method === "HEAD") {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return H("<p>This link is not valid.</p>", 400);
    return H(`<h1>Get your free Render API key</h1><form method="post" action="${RENDER_VERIFY_PATH}"><input type="hidden" name="token" value="${esc(token)}"><button type="submit">Confirm my email and show my key</button></form>`);
  }
  if (req.method !== "POST") return J({ error: "method not allowed" }, 405, { allow: "GET, POST" });
  const raw = await readBody(req, 4096);
  if (!token) { const ct = req.headers.get("content-type") || ""; try { token = ct.includes("json") ? String(JSON.parse(raw.text).token || "") : new URLSearchParams(raw.text).get("token") || ""; } catch (_) { token = ""; } }
  const wantJson = /json/.test(req.headers.get("accept") || "") || /json/.test(req.headers.get("content-type") || "");
  const bad = (msg) => wantJson ? J({ error: msg, reason: "invalid_or_expired_token" }, 400) : H(`<p>${esc(msg)}</p>`, 400);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return bad("This link is not valid.");
  const now = opts.now || new Date(); const t = Math.floor(now.getTime() / 1000);
  const th = await tokenHash(env, token);
  const used = await env.RECEIPTS_DB.prepare("UPDATE render_signups SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(t, th, t).run();
  if (!(used.meta && used.meta.changes)) return bad("This link has expired or was already used. Ask for a new one.");
  const row = await env.RECEIPTS_DB.prepare("SELECT email_hash FROM render_signups WHERE token_hash = ?").bind(th).first();
  await env.RECEIPTS_DB.prepare("DELETE FROM render_signups WHERE token_hash = ?").bind(th).run();
  if (await env.RECEIPTS_DB.prepare("SELECT 1 AS x FROM api_keys WHERE email_hash = ?").bind(row.email_hash).first()) return bad("A key already exists for this email.");
  const key = newKey();
  await env.RECEIPTS_DB.prepare("INSERT INTO api_keys (id, key_hash, email_hash, plan, monthly_quota, status, created_at, updated_at) VALUES (?, ?, ?, 'free', ?, 'active', ?, ?)")
    .bind(crypto.randomUUID(), await hashKey(env, key), row.email_hash, RENDER_PLANS.free.quota, t, t).run();
  const note = "Shown once; we store only a hash. Send it as x-api-key. The quota is a hard cap (429 at quota, never billed extra).";
  if (wantJson) return J({ api_key: key, plan: "free", monthly_quota: RENDER_PLANS.free.quota, note }, 201);
  return H(`<h1>Your Render API key</h1><p><code style="font-size:1.1em;user-select:all">${esc(key)}</code></p><p>${esc(note)}</p>`, 201);
}

// ---------- social cards (0.67.0) ----------
// One card spends one render (same keys, same x402 price, same hard cap, same grace). A failed render gives the unit
// back. A cache hit (Cloudflare Cache API, 7 days, ETag = sha256 of template + fields + size + format) spends nothing.
export const CARD_TEMPLATES = ["basic", "article", "product"];
export const CARD_SIZES = { og: { width: 1200, height: 630 }, twitter: { width: 1200, height: 675 }, square: { width: 1080, height: 1080 } };
export const CARD_MAX_EDGE = 2400;
export const CARD_FIELD_MAX = 300;
export const CARD_CACHE_TTL_S = 7 * 24 * 60 * 60;
export const CARD_TEXT_FIELDS = {
  basic: ["eyebrow", "title", "subtitle", "footer"],
  article: ["kicker", "title", "author", "date", "excerpt", "site"],
  product: ["badge", "title", "price", "description"],
};
const cardCacheRequest = (sum) => new Request("https://card-cache.internal/" + sum);
const b64uStr = (str) => { const bytes = new TextEncoder().encode(str); let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
function b64uDecode(s) {
  const p = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = p + "=".repeat((4 - (p.length % 4)) % 4);
  const bin = atob(pad); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const sortedFields = (fields) => { const o = {}; for (const k of Object.keys(fields).sort()) o[k] = fields[k]; return o; };
/** Stable cache material: template (or raw html) + fields + size + format. */
export function cardCacheMaterial(spec) {
  const template = spec.html ? String(spec.html) : String(spec.template || "");
  let fields = "";
  if (!spec.html && spec.fields && typeof spec.fields === "object") {
    const keys = Object.keys(spec.fields);
    if (keys.length) fields = JSON.stringify(sortedFields(spec.fields));
  }
  return template + "\n" + fields + "\n" + String(spec.size || "") + "\n" + String(spec.format || "");
}
function wholeEdge(v) {
  if (typeof v === "boolean" || v === null || v === undefined) return null;
  if (typeof v === "string" && !/^\d{1,4}$/.test(v)) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > CARD_MAX_EDGE) return null;
  return n;
}
function customSize(width, height) {
  const w = wholeEdge(width), h = wholeEdge(height);
  if (w === null || h === null) return { error: `custom size needs width and height as integers from 1 to ${CARD_MAX_EDGE}` };
  return { sizeName: "custom", size: w + "x" + h, width: w, height: h };
}
/** {sizeName, size, width, height} or {error}. size is the cache/signature token: og, twitter, square, or WxH. */
export function parseCardSize(b) {
  const s = b && b.size;
  if (s && typeof s === "object") return customSize(s.width, s.height);
  if (s === undefined && b && (b.width !== undefined || b.height !== undefined)) return customSize(b.width, b.height);
  if (s === undefined || s === "og" || s === "twitter" || s === "square") {
    const name = s || "og";
    return { sizeName: name, size: name, ...CARD_SIZES[name] };
  }
  if (s === "custom") return customSize(b.width, b.height);
  return { error: "size must be og, twitter, square, or custom (width and height, each 1 to 2400)" };
}
export function escapeHtml(x) {
  return String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function capField(v) {
  const s = String(v).trim();
  return [...s].slice(0, CARD_FIELD_MAX).join("");
}
/** HTML for a template card. Text fields are escaped. Image src is the already-checked href, attribute-escaped. */
export function buildCardHtml(spec, imageHref) {
  const f = spec.fields || {};
  const t = (k) => (f[k] ? escapeHtml(f[k]) : "");
  const w = spec.width, h = spec.height;
  const img = imageHref ? `<img alt="" src="${escapeHtml(imageHref)}">` : "";
  const pad = Math.round(w * 0.06);
  const titleSize = Math.max(28, Math.round(w * 0.046));
  const bodySize = Math.max(16, Math.round(w * 0.022));
  let bg = "#0f172a", fg = "#f8fafc", muted = "#cbd5e1", accent = "#38bdf8";
  let inner = "";
  if (spec.template === "article") {
    bg = "#f8f5f0"; fg = "#1c1917"; muted = "#57534e"; accent = "#9a3412";
    inner = `<p class="kicker">${t("kicker")}</p><h1>${t("title")}</h1><p class="by">${t("author")}${f.author && f.date ? " · " : ""}${t("date")}</p><p class="excerpt">${t("excerpt")}</p>${img}<p class="site">${t("site")}</p>`;
  } else if (spec.template === "product") {
    bg = "#f4f4f5"; fg = "#18181b"; muted = "#3f3f46"; accent = "#b45309";
    inner = `<p class="badge">${t("badge")}</p>${img}<h1>${t("title")}</h1><p class="price">${t("price")}</p><p class="excerpt">${t("description")}</p>`;
  } else {
    inner = `<p class="kicker">${t("eyebrow")}</p><h1>${t("title")}</h1><p class="excerpt">${t("subtitle")}</p>${img}<p class="site">${t("footer")}</p>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${bg};color:${fg}}
    body{font-family:system-ui,sans-serif}
    .wrap{box-sizing:border-box;width:100%;height:100%;padding:${pad}px;display:flex;flex-direction:column;justify-content:space-between}
    h1{font-size:${titleSize}px;line-height:1.12;margin:0 0 .35em;letter-spacing:-.02em}
    p{margin:0;font-size:${bodySize}px;line-height:1.4;color:${muted}}
    .kicker,.badge,.price{color:${accent};font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-bottom:.4em}
    .price{font-size:${Math.round(titleSize * 0.7)}px;text-transform:none;letter-spacing:0}
    img{width:100%;max-height:${Math.round(h * 0.42)}px;object-fit:cover;border-radius:16px;margin:.6em 0}
    .site{margin-top:auto;padding-top:.6em}
  </style></head><body><div class="wrap">${inner}</div></body></html>`;
}
async function cardSig(env, keyHash, t) {
  const secret = await hmacHex(pepper(env), "card|" + keyHash);
  return hmacHex(secret, t);
}
function canonicalPayload(kid, spec) {
  const o = { v: 1, kid };
  if (spec.template) o.template = spec.template;
  if (!spec.html && spec.fields && Object.keys(spec.fields).length) o.fields = sortedFields(spec.fields);
  if (spec.html) o.html = spec.html;
  o.size = spec.size;
  o.format = spec.format;
  return o;
}
/** {t, sig} for GET /v1/render/card. The HMAC key is derived from the server pepper and this key's hash. */
export async function signCardQuery(env, key, spec) {
  const t = b64uStr(JSON.stringify(canonicalPayload(key.id, spec)));
  const sig = await cardSig(env, key.key_hash, t);
  return { t, sig };
}
export async function verifyCardQuery(env, t, sig, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{8,}$/.test(t) || !/^[0-9a-f]{64}$/.test(String(sig || ""))) return { ok: false, reason: "bad_signature", status: 401 };
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64uDecode(t))); } catch (_) { return { ok: false, reason: "bad_signature", status: 401 }; }
  if (!payload || payload.v !== 1 || typeof payload.kid !== "string") return { ok: false, reason: "bad_signature", status: 401 };
  const key = await loadKeyById(env, payload.kid, now);
  if (!key || key.status === "revoked" || !key.key_hash) return { ok: false, reason: "unknown_key", status: 401 };
  if (key.status !== "active") return { ok: false, reason: "suspended", status: 403 };
  const want = await cardSig(env, key.key_hash, t);
  if (!timingSafeEqual(want, sig)) return { ok: false, reason: "bad_signature", status: 401 };
  return { ok: true, key, payload };
}
function cardFormat(v) {
  if (v === undefined || v === "png") return "png";
  if (v === "jpeg") return "jpeg";
  return null;
}
/** Parse a card body. {input} or {status, body}. Never charges. */
export async function parseCardBody(req, opts = {}) {
  const raw = await readBody(req, RENDER_MAX_BODY_BYTES);
  if (raw.error) return { status: 413, body: { error: `request body over ${RENDER_MAX_BODY_BYTES} bytes`, charged: false } };
  let b; try { b = raw.text ? JSON.parse(raw.text) : {}; } catch (_) { return { status: 400, body: { error: "body must be JSON", charged: false } }; }
  if (!b || typeof b !== "object" || Array.isArray(b)) return { status: 400, body: { error: "body must be a JSON object", charged: false } };
  return finishCardSpec(b, opts);
}
async function finishCardSpec(b, opts = {}) {
  const hasHtml = typeof b.html === "string" && b.html !== "";
  const hasTemplate = b.template !== undefined && b.template !== null && b.template !== "";
  if (hasHtml === hasTemplate) return { status: 400, body: { error: "send {template, fields} or {html}, plus size and format", charged: false, docs: API_ORIGIN + "/v1/render/docs" } };
  const format = cardFormat(b.format);
  if (!format) return { status: 400, body: { error: "format must be png or jpeg", charged: false } };
  const size = parseCardSize(b);
  if (size.error) return { status: 400, body: { error: size.error, charged: false } };
  const spec = { format, size: size.size, width: size.width, height: size.height };
  if (hasHtml) {
    if (new TextEncoder().encode(b.html).length > RENDER_MAX_HTML_BYTES) return { status: 413, body: { error: `html over ${RENDER_MAX_HTML_BYTES} bytes (2 MB)`, charged: false } };
    spec.html = b.html;
    spec.templateMode = false;
    spec.pageHtml = b.html;
    spec.allowUrls = [];
  } else {
    if (!CARD_TEMPLATES.includes(b.template)) return { status: 400, body: { error: "template must be basic, article, or product", charged: false } };
    if (b.fields !== undefined && (typeof b.fields !== "object" || b.fields === null || Array.isArray(b.fields))) return { status: 400, body: { error: "fields must be an object", charged: false } };
    const src = b.fields || {};
    const fields = {};
    for (const name of CARD_TEXT_FIELDS[b.template]) {
      if (src[name] === undefined || src[name] === "") continue;
      if (typeof src[name] !== "string") return { status: 400, body: { error: `fields.${name} must be a string`, charged: false } };
      const capped = capField(src[name]);
      if (capped) fields[name] = capped;
    }
    let imageHref = "";
    if (src.image !== undefined && src.image !== "") {
      if (typeof src.image !== "string") return { status: 400, body: { error: "fields.image must be an http(s) URL", charged: false } };
      const safe = await assertSafeUrl(src.image, opts.resolveHostFn ? { resolveHostFn: opts.resolveHostFn } : {});
      if (!safe.ok) return { status: 400, body: { error: "image url not allowed: " + safe.reason, reason: "ssrf_blocked", charged: false } };
      imageHref = safe.url.href;
      fields.image = imageHref;
    }
    spec.template = b.template;
    spec.fields = fields;
    spec.templateMode = true;
    spec.allowUrls = imageHref ? [imageHref] : [];
    spec.pageHtml = buildCardHtml({ ...spec, fields }, imageHref);
  }
  spec.sum = await sha(cardCacheMaterial(spec));
  spec.render = {
    kind: "card", html: spec.pageHtml, width: spec.width, height: spec.height, format: spec.format,
    templateMode: spec.templateMode, allowUrls: spec.allowUrls,
    bind: await sha(spec.sum),
  };
  return { input: spec };
}
function inputFromPayload(payload) {
  const format = cardFormat(payload.format);
  if (!format) return null;
  const size = parseCardSize(payload.size && /^\d+x\d+$/.test(payload.size) ? { size: "custom", width: Number(payload.size.split("x")[0]), height: Number(payload.size.split("x")[1]) } : { size: payload.size });
  if (size.error) return null;
  const b = { format, size: payload.size };
  if (payload.html) b.html = payload.html;
  else if (payload.template) { b.template = payload.template; b.fields = payload.fields || {}; }
  else return null;
  if (payload.size && /^\d+x\d+$/.test(payload.size)) { b.size = "custom"; b.width = size.width; b.height = size.height; }
  return b;
}
async function readCardCache(cache, sum) {
  if (!cache || typeof cache.match !== "function") return null;
  try {
    const hit = await cache.match(cardCacheRequest(sum));
    if (!hit) return null;
    const bytes = new Uint8Array(await hit.arrayBuffer());
    return { bytes, contentType: hit.headers.get("content-type") || "image/png" };
  } catch (_) { return null; }
}
async function writeCardCache(cache, sum, bytes, contentType, ctx) {
  if (!cache || typeof cache.put !== "function") return;
  const res = new Response(bytes, { headers: { "content-type": contentType, "cache-control": `public, max-age=${CARD_CACHE_TTL_S}`, etag: `"${sum}"` } });
  try {
    const p = Promise.resolve(cache.put(cardCacheRequest(sum), res));
    if (ctx && ctx.waitUntil) ctx.waitUntil(p.catch(() => {})); else await p;
  } catch (_) {}
}
function cardCacheOf(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, "cache")) return opts.cache;
  try { return (globalThis.caches && globalThis.caches.default) || null; } catch (_) { return null; }
}
const cardHeaders = (sum, cacheState, extra = {}) => ({ "cache-control": `public, max-age=${CARD_CACHE_TTL_S}`, etag: `"${sum}"`, "x-card-cache": cacheState, ...extra });
function etagHit(req, sum) {
  const h = req.headers.get("if-none-match") || "";
  return h.split(",").some((p) => { const s = p.trim().replace(/^W\//, "").replace(/^"|"$/g, ""); return s === "*" || s === sum; });
}

async function serveCard(req, env, ctx, url, spec, opts, auth) {
  const now = opts.now || new Date();
  const cache = cardCacheOf(opts);
  if (!(await takeFree(env, "render-rl:" + (await netKey(req, env)), RENDER_PER_IP_MIN, now, "take", "render-rl", minute(now))).free) return J({ error: `rate limited: ${RENDER_PER_IP_MIN} renders per minute per network`, charged: false }, 429, { "retry-after": "60" });
  const c = renderCfg(env);
  const resourceUrl = url.origin + RENDER_CARD_PATH;
  let key = auth.key || null;
  if (!auth.signed) {
    const rawKey = keyFromReq(req);
    if (rawKey) {
      if (!env.RECEIPTS_DB) return J({ error: "api keys are not configured on this deployment" }, 503);
      key = await loadKey(env, rawKey, now);
      if (!key || key.status === "revoked") return J({ error: "unknown api key" }, 401);
      if (key.status !== "active") return J({ error: "api key suspended", reason: "suspended", note: "This key was suspended (for example after a sudden spike in calls). Nothing was charged." }, 403);
    }
  }
  const signedUrl = key && key.key_hash ? await (async () => { const s = await signCardQuery(env, key, spec); return resourceUrl + "?t=" + encodeURIComponent(s.t) + "&sig=" + s.sig; })() : "";
  const extraUrl = signedUrl ? { "x-card-url": signedUrl } : {};
  const cached = await readCardCache(cache, spec.sum);
  if (cached) {
    const headers = { "content-type": cached.contentType, "content-length": String(cached.bytes.byteLength), "access-control-allow-origin": "*", ...cardHeaders(spec.sum, "hit", extraUrl) };
    if (req.method === "HEAD" || etagHit(req, spec.sum)) return new Response(null, { status: etagHit(req, spec.sum) ? 304 : 200, headers });
    return ok({ bytes: cached.bytes, contentType: cached.contentType }, cardHeaders(spec.sum, "hit", extraUrl));
  }
  if (!env.BROWSER && !opts.launch) return J({ error: "render is not configured on this deployment", reason: "browser_not_configured", charged: false }, 503);
  if (key) {
    const m = await keyMinute(env, key, now);
    if (m.suspended) return J({ error: "api key suspended after a sudden spike in calls", reason: "suspended", charged: false }, 403);
    if (m.limited) return J({ error: `rate limited: ${m.perMin} renders per minute for this key`, charged: false }, 429, { "retry-after": "60" });
    const q = await reserveQuota(env, key, now, "card");
    const qh = { "x-quota-limit": String(q.limit), "x-quota-remaining": String(q.remaining), ...extraUrl };
    if (!q.ok) return J({ error: "quota exceeded", reason: "quota_exceeded", plan: key.plan, monthly_quota: key.monthly_quota, used: q.used, charged: false, upgrade: UPGRADE }, 429, qh);
    const r = await runRender(env, spec.render, opts);
    if (!r.ok) { await releaseQuota(env, key, now, "card"); return fail(r); }
    await writeCardCache(cache, spec.sum, r.bytes, r.contentType, ctx);
    if (req.method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": r.contentType, "content-length": String(r.bytes.byteLength), "access-control-allow-origin": "*", ...cardHeaders(spec.sum, "miss", qh) } });
    return ok(r, cardHeaders(spec.sum, "miss", qh));
  }
  const hdr = req.headers.get("payment-signature") || req.headers.get("x-payment") || "";
  const need = (msg) => { const body = paymentRequired(c, resourceUrl, "card", msg); return J(body, 402, { "payment-required": b64(body) }); };
  if (!hdr) return need("Payment required");
  const payload = decodePaymentHeader(hdr);
  if (!payload) return need("payment header is not valid base64 JSON x402 payload");
  const bad = checkPayload(payload, c);
  if (bad) return need("payment rejected: " + bad);
  if (!env.RECEIPTS_DB) return J({ error: "payments are not configured on this deployment", charged: false }, 503);
  const pk = await paymentKey(payload);
  try { await env.RECEIPTS_DB.prepare("INSERT INTO render_payments (pay_key, bind, created_at) VALUES (?, ?, ?)").bind(pk, spec.render.bind, Math.floor(now.getTime() / 1000)).run(); }
  catch (_) { return J({ error: "this payment was already used", reason: "payment_reused", charged: false, note: "Each payment pays for one render. Sign a new payment for a new render." }, 409); }
  const forget = () => env.RECEIPTS_DB.prepare("DELETE FROM render_payments WHERE pay_key = ?").bind(pk).run().catch(() => {});
  const r = await runRender(env, spec.render, opts);
  if (!r.ok) { await forget(); return fail(r); }
  const s = await verifyAndSettle(c, payload, new URL(resourceUrl), { paidPath: true, description: "render card", bind: { target: "render:card#" + spec.render.bind, method: "POST" } });
  if (!s.ok && s.pending) return J({ error: "payment pending", reason: s.reason, ref: s.ref || null, note: "Do not sign a new payment; retry the same request with the same PAYMENT-SIGNATURE." }, 503, { "retry-after": "10" });
  if (!s.ok) { await forget(); return need("payment rejected: " + s.reason); }
  await writeCardCache(cache, spec.sum, r.bytes, r.contentType, ctx);
  const enc = b64(s.settle);
  return ok(r, cardHeaders(spec.sum, "miss", { "payment-response": enc, "x-payment-response": enc }));
}

export async function handleCard(req, env, ctx, url, opts = {}) {
  if (!renderOn(env)) return J({ error: "not found" }, 404);
  const now = opts.now || new Date();
  if (req.method === "GET" || req.method === "HEAD") {
    const v = await verifyCardQuery(env, url.searchParams.get("t") || "", (url.searchParams.get("sig") || "").toLowerCase(), now);
    if (!v.ok) return J({ error: v.reason === "suspended" ? "api key suspended" : "bad signature", reason: v.reason, charged: false }, v.status || 401);
    const raw = inputFromPayload(v.payload);
    if (!raw) return J({ error: "bad signature", reason: "bad_signature", charged: false }, 401);
    const built = await finishCardSpec(raw, opts);
    if (!built.input) return J({ error: "bad signature", reason: "bad_signature", charged: false }, 401);
    return serveCard(req, env, ctx, url, built.input, { ...opts, now }, { signed: true, key: v.key });
  }
  if (req.method !== "POST") return J({ error: "use POST {template, fields} or {html}, or GET ?t=&sig=" }, 405, { allow: "GET, HEAD, POST" });
  const p = await parseCardBody(req, opts);
  if (!p.input) return J(p.body, p.status);
  return serveCard(req, env, ctx, url, p.input, { ...opts, now }, { signed: false });
}

// ---------- render handler ----------
function paymentRequired(c, resourceUrl, kind, error) {
  const what = kind === "pdf" ? "a PDF" : kind === "card" ? "a social card" : "a screenshot";
  const desc = `Render ${what}: $${c.priceUsd} USDC on Base per render; charged only if the render succeeds.`;
  return {
    x402Version: 2, error,
    resource: { url: resourceUrl, description: desc, mimeType: kind === "pdf" ? "application/pdf" : "image/png", serviceName: "402xAgent Render", tags: ["x402", "render", kind, "headless-browser"] },
    accepts: [paymentRequirements(c, resourceUrl, 2, { paidPath: true, description: desc })],
    price_usd: c.priceUsd, asset: "USDC on Base (eip155:8453)",
    how_to_pay: "Retry the same request (same body) with a PAYMENT-SIGNATURE header. Settled only if the render succeeds. Or use an API key (x-api-key): " + API_ORIGIN + RENDER_KEYS_PATH,
  };
}
const ok = (r, extra = {}) => new Response(r.bytes, { status: 200, headers: { "content-type": r.contentType, "content-length": String(r.bytes.byteLength), "access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, X-QUOTA-LIMIT, X-QUOTA-REMAINING, ETAG, X-CARD-URL, X-CARD-CACHE", "cache-control": "no-store", ...extra } });
const fail = (r) => J({ error: "render failed", reason: r.reason, charged: false, note: "Nothing was charged." }, r.status || 502);

export async function handleRender(req, env, ctx, url, kind, opts = {}) {
  if (!renderOn(env)) return J({ error: "not found" }, 404);
  if (req.method !== "POST") return J({ error: "use POST with a JSON body {url} or {html}" }, 405, { allow: "POST" });
  if (!env.BROWSER && !opts.launch) return J({ error: "render is not configured on this deployment", reason: "browser_not_configured", charged: false }, 503);
  const now = opts.now || new Date();
  const c = renderCfg(env);
  const resourceUrl = url.origin + (kind === "pdf" ? RENDER_PDF_PATH : RENDER_SHOT_PATH);
  const p = await parseRenderInput(req, kind, opts);
  if (!p.input) return J(p.body, p.status);
  const input = p.input;
  if (!(await takeFree(env, "render-rl:" + (await netKey(req, env)), RENDER_PER_IP_MIN, now, "take", "render-rl", minute(now))).free) return J({ error: `rate limited: ${RENDER_PER_IP_MIN} renders per minute per network`, charged: false }, 429, { "retry-after": "60" });

  const rawKey = keyFromReq(req);
  if (rawKey) { // API-key path: quota, never x402
    if (!env.RECEIPTS_DB) return J({ error: "api keys are not configured on this deployment" }, 503);
    const key = await loadKey(env, rawKey, now);
    if (!key || key.status === "revoked") return J({ error: "unknown api key" }, 401);
    if (key.status !== "active") return J({ error: "api key suspended", reason: "suspended", note: "This key was suspended (for example after a sudden spike in calls). Nothing was charged." }, 403);
    const m = await keyMinute(env, key, now);
    if (m.suspended) return J({ error: "api key suspended after a sudden spike in calls", reason: "suspended", charged: false }, 403);
    if (m.limited) return J({ error: `rate limited: ${m.perMin} renders per minute for this key`, charged: false }, 429, { "retry-after": "60" });
    const q = await reserveQuota(env, key, now, kind);
    const qh = { "x-quota-limit": String(q.limit), "x-quota-remaining": String(q.remaining) };
    if (!q.ok) return J({ error: "quota exceeded", reason: "quota_exceeded", plan: key.plan, monthly_quota: key.monthly_quota, used: q.used, charged: false, upgrade: UPGRADE }, 429, qh);
    const r = await runRender(env, input, opts);
    if (!r.ok) { await releaseQuota(env, key, now, kind); return fail(r); }
    return ok(r, qh);
  }

  // x402 path
  const hdr = req.headers.get("payment-signature") || req.headers.get("x-payment") || "";
  const need = (msg) => { const body = paymentRequired(c, resourceUrl, kind, msg); return J(body, 402, { "payment-required": b64(body) }); };
  if (!hdr) return need("Payment required");
  const payload = decodePaymentHeader(hdr);
  if (!payload) return need("payment header is not valid base64 JSON x402 payload");
  const bad = checkPayload(payload, c);
  if (bad) return need("payment rejected: " + bad);
  // one render per payment: record the payment (hash of signature + nonce) BEFORE rendering; a reused payment is refused
  if (!env.RECEIPTS_DB) return J({ error: "payments are not configured on this deployment", charged: false }, 503);
  const pk = await paymentKey(payload);
  try { await env.RECEIPTS_DB.prepare("INSERT INTO render_payments (pay_key, bind, created_at) VALUES (?, ?, ?)").bind(pk, input.bind, Math.floor(now.getTime() / 1000)).run(); }
  catch (_) { return J({ error: "this payment was already used", reason: "payment_reused", charged: false, note: "Each payment pays for one render. Sign a new payment for a new render." }, 409); }
  const forget = () => env.RECEIPTS_DB.prepare("DELETE FROM render_payments WHERE pay_key = ?").bind(pk).run().catch(() => {});
  const r = await runRender(env, input, opts);
  if (!r.ok) { await forget(); return fail(r); } // nothing settled, so the same payment may be retried
  const s = await verifyAndSettle(c, payload, new URL(resourceUrl), { paidPath: true, description: "render " + kind, bind: { target: "render:" + kind + "#" + input.bind, method: "POST" } });
  if (!s.ok && s.pending) return J({ error: "payment pending", reason: s.reason, ref: s.ref || null, note: "Do not sign a new payment; retry the same request with the same PAYMENT-SIGNATURE." }, 503, { "retry-after": "10" });
  if (!s.ok) { await forget(); return need("payment rejected: " + s.reason); }
  const enc = b64(s.settle);
  return ok(r, { "payment-response": enc, "x-payment-response": enc });
}

export function renderDocs(c, env = {}) {
  return {
    product: "render", version: "0.67.0",
    what: "Render a public web page or your own HTML to a PDF or a screenshot, or a social card from a template, in a real headless browser (Cloudflare Browser Rendering).",
    routes: {
      pdf: { method: "POST", url: API_ORIGIN + RENDER_PDF_PATH, body: { url: "https://... (or html)", html: "<html>... (max 2 MB)", format: "A4|Letter", landscape: false } },
      screenshot: { method: "POST", url: API_ORIGIN + RENDER_SHOT_PATH, body: { url: "https://... (or html)", width: "320-1920 (1280)", height: "240-4000 (800)", fullPage: false, format: "png|jpeg" } },
      card: {
        method: "POST", url: API_ORIGIN + RENDER_CARD_PATH,
        body: { template: "basic|article|product", fields: "text fields (HTML-escaped, 300 chars) and an optional image URL", html: "<html>... instead of template (max 2 MB)", size: "og (1200x630, default) | twitter (1200x675) | square (1080x1080) | custom (width and height, each 1 to 2400)", format: "png (default) | jpeg" },
        signed_get: API_ORIGIN + RENDER_CARD_PATH + "?t=<base64url>&sig=<hex HMAC-SHA256>",
        signed_get_note: "The signature uses a secret derived from the API key, so an og:image tag can point at the URL. A cache hit does not spend a render.",
      },
      signup: { method: "POST", url: API_ORIGIN + RENDER_KEYS_PATH, body: { email: "you@example.com (no disposable domains)" }, then: "open the one-time link we email you (30 min); the key is issued only then" },
    },
    price: { x402_per_render_usd: c.priceUsd, protocol: "x402 v2 exact, USDC on Base; charged only if the render succeeds",
      plans: Object.fromEntries(Object.entries(RENDER_PLANS).map(([k, v]) => [k, { monthly_renders: v.quota, usd_per_month: v.priceUsd, per_minute: v.perMin }])),
      overage: "none: the monthly quota is a hard cap (429 with an upgrade note), never billed extra",
      card: "one card = one render against the same quota. A failed render is refunded. A cache hit is free." },
    cache: { key: "sha256(template + fields + size + format)", ttl_seconds: CARD_CACHE_TTL_S, store: "Cloudflare cache", etag: "the cache key" },
    limits: { browser_time_ms: RENDER_TIME_MS, max_html_bytes: RENDER_MAX_HTML_BYTES, max_output_bytes: RENDER_MAX_OUT_BYTES, card_field_chars: CARD_FIELD_MAX, card_max_edge: CARD_MAX_EDGE, per_minute_per_network: RENDER_PER_IP_MIN, spike_suspend: `a key over ${RENDER_SPIKE_FACTOR}x its per-minute limit in one minute is suspended` },
    ...(billingOn(env) ? { billing: billingDocs(env) } : {}),
    payments: "one render per x402 payment: a reused payment is refused (409) before rendering",
    safety: "http/https only. WebSocket, WebTransport and service workers are blocked. Every request is DNS-checked again when the browser makes it, and a response from a private address fails the render. The first URL, every redirect and every subresource is DNS-checked; private, loopback, link-local and metadata addresses are refused. Template card text is HTML-escaped. A template card allows network access only for image URLs that pass that check. Raw HTML cards check every subresource and redirect.",
  };
}
