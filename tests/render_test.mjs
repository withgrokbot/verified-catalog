// 0.65.0 render API: off by default, SSRF guard (first URL, redirect hops, subresources), caps (2 MB HTML, 10 MB output,
// 15 s browser time), API-key quota hard cap, spike suspend, disposable-email signup block, x402 per render (settle only on
// success), and the discovery entries. No network and no real browser: DoH, the facilitator and the browser are stubbed;
// D1 is in-memory SQLite with every migration (local only).
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { QuotaCounter, openapi } from "../worker/src/lib.js";
import { handleRender, handleRenderSignup, checkEmail, runRender, RENDER_PDF_PATH, RENDER_SHOT_PATH, RENDER_KEYS_PATH, RENDER_MAX_HTML_BYTES, RENDER_MAX_OUT_BYTES, RENDER_PLANS } from "../worker/src/render.js";
import { sqliteD1 as d1 } from "./helpers/sqlite_d1.mjs";

const PAY_TO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";
const API = "https://api.402xagent.com";
const DNS = { "ok.fixture": "93.184.216.34", "cdn.fixture": "93.184.216.35", "internal.fixture": "10.1.2.3", "loop.fixture": "127.0.0.1", "meta.fixture": "169.254.169.254", "v6loop.fixture": "::1" };
let settles = 0; const used = new Set();
globalThis.fetch = async (u, init = {}) => {
  const s = String(u && u.url ? u.url : u);
  if (s.startsWith("https://cloudflare-dns.com/dns-query")) {
    const q = new URL(s).searchParams; const ip = DNS[q.get("name")] || "93.184.216.34"; const v6 = ip.includes(":");
    return Response.json({ Answer: q.get("type") === "A" && !v6 ? [{ type: 1, data: ip }] : q.get("type") === "AAAA" && v6 ? [{ type: 28, data: ip }] : [] });
  }
  if (s.includes("facilitator")) {
    const b = JSON.parse(init.body || "{}"); const n = b.paymentPayload.payload.authorization.nonce;
    if (s.endsWith("/verify")) return Response.json(used.has(n) ? { isValid: false, invalidReason: "nonce_already_used" } : { isValid: true, payer: "0xb1" });
    used.add(n); settles++; return Response.json({ success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer: "0xb1" });
  }
  return new Response("nope", { status: 404 });
};

// ---- fake Browser Rendering: goto() issues the navigation request, then each redirect hop, then each subresource;
// every request goes through the page's "request" handler (the guard), like puppeteer request interception.
const SITE = {
  "https://ok.fixture/": { subs: ["https://cdn.fixture/app.css"] },
  "https://ok.fixture/hop": { redirect: "http://internal.fixture/admin" },
  "https://ok.fixture/meta-img": { subs: ["http://meta.fixture/latest/meta-data/", "https://cdn.fixture/ok.png"] },
};
let launches = 0, seen = [], outBytes = 1000, hang = false, failNext = false;
function launch() {
  launches++;
  let handler = null; const reqs = [];
  const req = async (u) => { let res; const p = new Promise((r) => (res = r)); seen.push(u); await handler({ url: () => u, continue: async () => res(true), abort: async () => res(false) }); return p; };
  const page = {
    setRequestInterception: async () => {}, on: (ev, fn) => { if (ev === "request") handler = fn; }, setViewport: async () => {},
    goto: async (u) => {
      if (hang) await new Promise(() => {});
      let cur = u;
      for (;;) {
        if (!(await req(cur))) throw new Error("net::ERR_BLOCKED_BY_CLIENT at " + cur);
        const s = SITE[cur] || {};
        if (s.redirect) { cur = s.redirect; continue; }
        for (const sub of s.subs || []) reqs.push(await req(sub));
        return { status: () => 200 };
      }
    },
    setContent: async (html) => { for (const m of html.matchAll(/src="([^"]+)"/g)) reqs.push(await req(m[1])); },
    pdf: async () => { if (failNext) { failNext = false; throw new Error("boom"); } return new Uint8Array(outBytes).fill(37); },
    screenshot: async () => new Uint8Array(outBytes).fill(137),
  };
  return Promise.resolve({ newPage: async () => page, close: async () => {} });
}
function quotaNs() {
  const objs = new Map();
  return { idFromName: (n) => n, get: (id) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, new QuotaCounter({ storage: { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) } }, {})); } const o = objs.get(id); return { fetch: (u) => o.fetch(new Request(u)) }; } };
}
const env = (x = {}) => ({ RENDER: "1", BROWSER: {}, PAY_TO, FACILITATOR_URL: "https://facilitator.fixture", CLIENT_SALT: "t", QUOTA: quotaNs(), RECEIPTS_DB: d1(), ...x });
let ipN = 0; const freshIp = () => `10${(++ipN >> 8) & 7}.${ipN & 255}.7.1`; // a new /24 each call (the per-network limit keys on /24)
const call = (e, path, body, headers = {}, o = {}) => {
  const url = new URL(API + path);
  const req = new Request(url, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": o.ip || freshIp(), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return path === RENDER_KEYS_PATH ? handleRenderSignup(req, e, {}, url, o) : handleRender(req, e, {}, url, path === RENDER_PDF_PATH ? "pdf" : "screenshot", { launch, ...o });
};
const pay = (n, amount = "2000") => btoa(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", amount, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO },
  payload: { signature: "0xsig", authorization: { from: "0x00000000000000000000000000000000000000b1", to: PAY_TO, value: amount, nonce: "0x" + n.repeat(32), validBefore: "9999999999" } } }));
async function newKey(e, email = "dev@example.com") { const r = await call(e, RENDER_KEYS_PATH, { email }); assert.equal(r.status, 201); return (await r.json()).api_key; }

test("off by default: every render route 404s without RENDER=1, and the worker does not route them", async () => {
  for (const p of [RENDER_PDF_PATH, RENDER_SHOT_PATH, RENDER_KEYS_PATH]) assert.equal((await call(env({ RENDER: undefined }), p, { url: "https://ok.fixture/" })).status, 404);
  const r = await worker.fetch(new Request(API + RENDER_PDF_PATH, { method: "POST", body: "{}" }), { ...env(), RENDER: undefined }, { waitUntil() {} });
  assert.notEqual(r.status, 402); assert.notEqual(r.status, 200);
});
test("fails closed without the browser binding: 503, nothing quoted", async () => {
  const url = new URL(API + RENDER_PDF_PATH);
  const r = await handleRender(new Request(url, { method: "POST", body: JSON.stringify({ url: "https://ok.fixture/" }) }), env({ BROWSER: undefined }), {}, url, "pdf");
  assert.equal(r.status, 503); assert.equal((await r.json()).reason, "browser_not_configured");
});

test("SSRF: non-http schemes, private, loopback, link-local, metadata and v6 loopback targets are refused before any browser launch", async () => {
  launches = 0;
  for (const u of ["file:///etc/passwd", "ftp://ok.fixture/x", "javascript:alert(1)", "http://127.0.0.1/", "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
    "http://localhost/", "http://metadata.google.internal/", "http://internal.fixture/", "http://loop.fixture/", "http://meta.fixture/", "http://v6loop.fixture/", "http://user:pw@ok.fixture/"]) {
    const r = await call(env(), RENDER_SHOT_PATH, { url: u }, { "payment-signature": pay("a1") });
    assert.equal(r.status, 400, u); const b = await r.json(); assert.equal(b.charged, false, u);
  }
  assert.equal(launches, 0);
});
test("SSRF: a redirect hop to a private address is blocked in the browser (400, not charged, quota given back)", async () => {
  const e = env(); const k = await newKey(e); seen = []; settles = 0;
  const r = await call(e, RENDER_PDF_PATH, { url: "https://ok.fixture/hop" }, { "x-api-key": k });
  assert.equal(r.status, 400); assert.equal((await r.json()).reason, "ssrf_blocked");
  assert.deepEqual(seen, ["https://ok.fixture/hop", "http://internal.fixture/admin"]);
  const u = await e.RECEIPTS_DB.prepare("SELECT renders FROM api_key_usage").first(); assert.equal(u.renders, 0);
  const p = await call(e, RENDER_PDF_PATH, { url: "https://ok.fixture/hop" }, { "payment-signature": pay("a2") });
  assert.equal(p.status, 400); assert.equal(settles, 0);
});
test("SSRF: subresources (from a URL or from user HTML) to metadata/private hosts are aborted; public ones load", async () => {
  const r = await runRender({ BROWSER: {} }, { kind: "pdf", url: "https://ok.fixture/meta-img", format: "A4" }, { launch });
  assert.equal(r.ok, true); assert.equal(r.blocked, 1);
  const h = await runRender({ BROWSER: {} }, { kind: "pdf", html: '<img src="http://169.254.169.254/x"><img src="http://10.0.0.8/y"><img src="file:///etc/passwd"><img src="https://cdn.fixture/a.png"><img src="data:image/png;base64,AA==">', format: "A4" }, { launch });
  assert.equal(h.ok, true); assert.equal(h.blocked, 3);
});

test("caps: HTML over 2 MB is 413 before launch; output over 10 MB is 413 and not charged; 15 s browser cap -> 504", async () => {
  launches = 0;
  const big = "<p>" + "x".repeat(RENDER_MAX_HTML_BYTES) + "</p>";
  assert.equal((await call(env(), RENDER_PDF_PATH, { html: big }, { "payment-signature": pay("b1") })).status, 413); assert.equal(launches, 0);
  assert.equal((await call(env(), RENDER_PDF_PATH, { url: "https://ok.fixture/", html: "<p>" })).status, 400, "exactly one of url/html");
  assert.equal((await call(env(), RENDER_SHOT_PATH, { url: "https://ok.fixture/", format: "gif" })).status, 400);
  settles = 0; outBytes = RENDER_MAX_OUT_BYTES + 1;
  const r = await call(env(), RENDER_SHOT_PATH, { url: "https://ok.fixture/", fullPage: true }, { "payment-signature": pay("b2") });
  assert.equal(r.status, 413); assert.equal((await r.json()).charged, false); assert.equal(settles, 0); outBytes = 1000;
  hang = true; const t0 = Date.now();
  const t = await call(env(), RENDER_PDF_PATH, { url: "https://ok.fixture/" }, { "payment-signature": pay("b3") }, { timeMs: 60 });
  hang = false; assert.equal(t.status, 504); assert.ok(Date.now() - t0 < 2000); assert.equal(settles, 0);
});

test("x402: 402 quotes $0.002; paid render returns the bytes and settles once; failed render settles nothing", async () => {
  const r = await call(env(), RENDER_PDF_PATH, { url: "https://ok.fixture/" });
  assert.equal(r.status, 402); const b = await r.json(); assert.equal(b.accepts[0].amount, "2000"); assert.equal(b.price_usd, "0.002");
  assert.equal((await call(env(), RENDER_PDF_PATH, { url: "https://ok.fixture/" }, { "payment-signature": pay("c0", "1000") })).status, 402);
  settles = 0;
  const ok = await call(env(), RENDER_SHOT_PATH, { url: "https://ok.fixture/", format: "jpeg", width: 800, height: 600 }, { "payment-signature": pay("c1") });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get("content-type"), "image/jpeg"); assert.equal((await ok.arrayBuffer()).byteLength, 1000); assert.equal(settles, 1); assert.ok(ok.headers.get("payment-response"));
  failNext = true; const f = await call(env(), RENDER_PDF_PATH, { url: "https://ok.fixture/" }, { "payment-signature": pay("c2") });
  assert.equal(f.status, 502); assert.equal((await f.json()).charged, false); assert.equal(settles, 1);
});

test("quota is a hard cap: at quota -> 429 with an upgrade note, no render, no x402 charge, counter stays at quota", async () => {
  const e = env(); const k = await newKey(e); settles = 0;
  await e.RECEIPTS_DB.prepare("UPDATE api_keys SET monthly_quota = 3").run();
  for (let i = 0; i < 3; i++) { const r = await call(e, RENDER_PDF_PATH, { url: "https://ok.fixture/" }, { "x-api-key": k }); assert.equal(r.status, 200); assert.equal(r.headers.get("x-quota-remaining"), String(2 - i)); }
  launches = 0;
  for (let i = 0; i < 2; i++) {
    const r = await call(e, RENDER_PDF_PATH, { url: "https://ok.fixture/" }, { authorization: "Bearer " + k, "payment-signature": pay("d" + i) });
    assert.equal(r.status, 429); const b = await r.json();
    assert.equal(b.reason, "quota_exceeded"); assert.equal(b.charged, false); assert.match(b.upgrade, /hard cap/); assert.match(b.upgrade, /\$10/); assert.match(b.upgrade, /\$29/);
  }
  assert.equal(launches, 0); assert.equal(settles, 0);
  assert.equal((await e.RECEIPTS_DB.prepare("SELECT renders FROM api_key_usage").first()).renders, 3);
  assert.deepEqual([RENDER_PLANS.free.quota, RENDER_PLANS.starter.quota, RENDER_PLANS.pro.quota], [500, 5000, 25000]);
  const fresh = env(); const k2 = await newKey(fresh); failNext = true;
  assert.equal((await call(fresh, RENDER_PDF_PATH, { url: "https://ok.fixture/" }, { "x-api-key": k2 })).status, 502);
  assert.equal((await fresh.RECEIPTS_DB.prepare("SELECT renders FROM api_key_usage").first()).renders, 0, "a failed render gives its unit back");
  assert.equal((await call(fresh, RENDER_PDF_PATH, { url: "https://ok.fixture/" }, { "x-api-key": "rk_nope" })).status, 401);
});

test("rate limits: per network per minute, per key per minute; a sudden spike suspends the key", async () => {
  const e = env(); let s429 = 0;
  for (let i = 0; i < 22; i++) if ((await call(e, RENDER_PDF_PATH, { url: "https://ok.fixture/" }, {}, { ip: "203.0.113.9" })).status === 429) s429++;
  assert.equal(s429, 2);
  const k = await newKey(e); const codes = [];
  for (let i = 0; i < 52; i++) codes.push((await call(e, RENDER_PDF_PATH, { url: "https://ok.fixture/" }, { "x-api-key": k })).status);
  assert.equal(codes.filter((c) => c === 200).length, 10); assert.equal(codes[10], 429); assert.equal(codes[49], 429); assert.equal(codes[50], 403); assert.equal(codes[51], 403);
  const row = await e.RECEIPTS_DB.prepare("SELECT status, suspended_reason FROM api_keys").first();
  assert.equal(row.status, "suspended"); assert.match(row.suspended_reason, /^spike: 51 calls/);
  assert.equal((await call(e, RENDER_PDF_PATH, { url: "https://ok.fixture/" }, { "x-api-key": k }, { now: new Date(Date.now() + 120000) })).status, 403, "stays suspended");
});

test("signup: email required, disposable domains (and their subdomains) refused, one key per email, only hashes stored", async () => {
  for (const [m, ok] of [["a@gmail.com", true], ["A@Example.ORG", true], ["x@mailinator.com", false], ["x@sub.mailinator.com", false], ["x@yopmail.com", false], ["x@guerrillamail.com", false], ["x@10minutemail.com", false], ["nope", false], ["", false], ["a@b", false]]) assert.equal(checkEmail(m).ok, ok, m);
  assert.equal(checkEmail("x@mailinator.com").reason, "disposable_email");
  const e = env();
  const d = await call(e, RENDER_KEYS_PATH, { email: "throw@mailinator.com" }); assert.equal(d.status, 400); assert.equal((await d.json()).reason, "disposable_email");
  assert.equal((await call(e, RENDER_KEYS_PATH, {})).status, 400);
  const r = await call(e, RENDER_KEYS_PATH, { email: "Dev@Example.com" }); assert.equal(r.status, 201); const b = await r.json();
  assert.match(b.api_key, /^rk_[A-Za-z0-9_-]{32}$/); assert.equal(b.monthly_quota, 500);
  assert.equal((await call(e, RENDER_KEYS_PATH, { email: "dev@example.com" })).status, 409);
  const row = await e.RECEIPTS_DB.prepare("SELECT * FROM api_keys").first();
  assert.ok(!JSON.stringify(row).includes(b.api_key) && !/example\.com/i.test(JSON.stringify(row)));
  let last; for (let i = 0; i < 4; i++) last = await call(e, RENDER_KEYS_PATH, { email: `p${i}@example.net` }, {}, { ip: "203.0.113.50" });
  assert.equal(last.status, 429, "signups per network per day");
});

test("discovery: openapi x-payment-info + llms.txt entry with RENDER=1; absent by default", async () => {
  assert.ok(!(RENDER_PDF_PATH in openapi(API, {}).paths));
  const oa = openapi(API, { RENDER: "1" });
  for (const p of [RENDER_PDF_PATH, RENDER_SHOT_PATH]) {
    const op = oa.paths[p].post; assert.ok(op.responses[402] && op.responses[429]);
    assert.equal(op["x-payment-info"].price.amount, "0.002"); assert.equal(op["x-payment-info"].price.amount_atomic, "2000"); assert.equal(op["x-payment-info"].protocols[0].x402.payTo, PAY_TO);
  }
  const llms = async (ev) => (await worker.fetch(new Request("https://402xagent.com/llms.txt"), ev, { waitUntil() {} })).text();
  assert.match(await llms({ ...env(), RENDER: "1" }), /- Render \(PDF or screenshot.*\$0\.002 USDC per render.*free 500\/month.*hard cap/);
  assert.doesNotMatch(await llms({ ...env(), RENDER: undefined }), /Render \(PDF/);
  const docs = await worker.fetch(new Request(API + "/v1/render/docs"), { ...env(), RENDER: "1" }, { waitUntil() {} });
  assert.equal(docs.status, 200); assert.equal((await docs.json()).price.x402_per_render_usd, "0.002");
});
