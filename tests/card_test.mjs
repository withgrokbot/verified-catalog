// 0.67.0 social cards: template escaping, size presets, quota spend/refund, free cache hits,
// SSRF refusal, HMAC-signed GET (good and tampered), and 404 unless RENDER=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { QuotaCounter, openapi } from "../worker/src/lib.js";
import { handleCard, handleRenderSignup, handleRenderVerify, signCardQuery, makeRequestGuard, buildCardHtml, escapeHtml, RENDER_CARD_PATH, RENDER_KEYS_PATH, RENDER_VERIFY_PATH, CARD_SIZES, CARD_CACHE_TTL_S, CARD_FIELD_MAX, RENDER_TIME_MS, RENDER_MAX_HTML_BYTES } from "../worker/src/render.js";
import { sqliteD1 as d1 } from "./helpers/sqlite_d1.mjs";

const PAY_TO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";
const API = "https://api.402xagent.com";
const DNS = { "ok.fixture": "93.184.216.34", "cdn.fixture": "93.184.216.35", "internal.fixture": "10.1.2.3" };
let settles = 0; const usedPay = new Set();
globalThis.fetch = async (u, init = {}) => {
  const s = String(u && u.url ? u.url : u);
  if (s.startsWith("https://cloudflare-dns.com/dns-query")) {
    const q = new URL(s).searchParams; const ip = DNS[q.get("name")] || "";
    const v6 = ip.includes(":");
    return Response.json({ Answer: q.get("type") === "A" && ip && !v6 ? [{ type: 1, data: ip }] : [] });
  }
  if (s.includes("facilitator")) {
    const b = JSON.parse(init.body || "{}"); const n = b.paymentPayload.payload.authorization.nonce;
    if (s.endsWith("/verify")) return Response.json(usedPay.has(n) ? { isValid: false, invalidReason: "nonce_already_used" } : { isValid: true, payer: "0xb1" });
    usedPay.add(n); settles++; return Response.json({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: "0xb1" });
  }
  return new Response("nope", { status: 404 });
};

let launches = 0, lastHtml = "", lastViewport = null, seen = [], failNext = false, outBytes = 80;
const REDIR = { "https://ok.fixture/go": "http://internal.fixture/secret" };
function launch() {
  launches++;
  let handler = null;
  const req = async (u, type = "image") => {
    let res; const p = new Promise((r) => (res = r)); seen.push(u);
    await handler({ url: () => u, resourceType: () => type, continue: async () => res(true), abort: async () => res(false) });
    return p;
  };
  const page = {
    setRequestInterception: async () => {}, on: (ev, fn) => { if (ev === "request") handler = fn; },
    setViewport: async (v) => { lastViewport = v; },
    goto: async () => ({ status: () => 200 }),
    setContent: async (html) => {
      lastHtml = html;
      for (const m of html.matchAll(/src="([^"]+)"/g)) {
        const src = m[1].replace(/&amp;/g, "&");
        if (await req(src)) { const hop = REDIR[src]; if (hop) await req(hop); }
      }
    },
    screenshot: async () => { if (failNext) { failNext = false; throw new Error("boom"); } return new Uint8Array(outBytes).fill(137); },
  };
  return { newPage: async () => page, close: async () => {} };
}
function quotaNs() {
  const objs = new Map();
  return { idFromName: (n) => n, get: (id) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, new QuotaCounter({ storage: { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) } }, {})); } const o = objs.get(id); return { fetch: (u) => o.fetch(new Request(u)) }; } };
}
function memCache() {
  const m = new Map();
  return { async match(req) { const hit = m.get(req.url); return hit ? hit.clone() : undefined; }, async put(req, res) { m.set(req.url, res.clone()); } };
}
let mail = [];
const EMAIL = { send: async (m) => { mail.push(m); return { messageId: "m" + mail.length }; } };
const env = (x = {}) => ({ RENDER: "1", BROWSER: {}, RENDER_EMAIL: EMAIL, RENDER_EMAIL_FROM: "keys@402xagent.example", PAY_TO, FACILITATOR_URL: "https://facilitator.fixture", CLIENT_SALT: "t", QUOTA: quotaNs(), RECEIPTS_DB: d1(), ...x });
let ipN = 0; const freshIp = () => `198.51.${(++ipN >> 8) & 255}.${ipN & 255}`;
const call = (e, body, headers = {}, o = {}) => {
  const url = new URL(API + RENDER_CARD_PATH);
  const req = new Request(url, { method: o.method || "POST", headers: { "content-type": "application/json", "cf-connecting-ip": o.ip || freshIp(), ...headers }, body: o.method === "GET" ? undefined : JSON.stringify(body) });
  return handleCard(req, e, {}, o.url || url, { launch, cache: o.cache, ...o });
};
const pay = (n) => btoa(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", amount: "2000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO },
  payload: { signature: "0xsig", authorization: { from: "0x00000000000000000000000000000000000000b1", to: PAY_TO, value: "2000", nonce: "0x" + n.repeat(32), validBefore: "9999999999" } } }));
const tokenOf = (m) => new URL(/https:\/\/\S+/.exec(m.text)[0]).searchParams.get("token");
async function newKey(e, email = "dev@example.com") {
  mail = [];
  const url = new URL(API + RENDER_KEYS_PATH);
  const r = await handleRenderSignup(new Request(url, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() }, body: JSON.stringify({ email }) }), e, {}, url);
  assert.equal(r.status, 202);
  const vurl = new URL(API + RENDER_VERIFY_PATH);
  const v = await handleRenderVerify(new Request(vurl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ token: tokenOf(mail[0]) }) }), e, {}, vurl);
  assert.equal(v.status, 201);
  return (await v.json()).api_key;
}
const cardUsage = (e) => e.RECEIPTS_DB.prepare("SELECT COALESCE(SUM(renders), 0) AS renders FROM api_key_usage").first();

test("404 unless RENDER=1, including through the worker", async () => {
  assert.equal((await call(env({ RENDER: undefined }), { template: "basic", fields: { title: "Hi" } })).status, 404);
  const off = await worker.fetch(new Request(API + RENDER_CARD_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ template: "basic", fields: { title: "Hi" } }) }), { CLIENT_SALT: "t" }, { waitUntil() {} });
  assert.equal(off.status, 404);
  const on = await worker.fetch(new Request(API + RENDER_CARD_PATH, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ template: "basic", fields: { title: "Hi" } }) }), { RENDER: "1", CLIENT_SALT: "t" }, { waitUntil() {} });
  assert.equal(on.status, 503, "the route is wired; no browser binding means 503, not 404");
  assert.equal((await on.json()).reason, "browser_not_configured");
});

test("template text is HTML-escaped and capped at 300 characters", async () => {
  const nasty = `<script>alert("x")</script> & 'it'`;
  assert.equal(escapeHtml(nasty), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;it&#39;");
  const e = env(); const k = await newKey(e); launches = 0; seen = []; lastHtml = "";
  const r = await call(e, { template: "basic", fields: { title: nasty, eyebrow: "<img src=\"http://127.0.0.1/x\">" } }, { "x-api-key": k }, { cache: memCache() });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(launches, 1);
  assert.ok(lastHtml.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;it&#39;"));
  assert.ok(!lastHtml.includes("<script>"), "no raw tag from the title");
  assert.ok(lastHtml.includes("&lt;img src=&quot;http://127.0.0.1/x&quot;&gt;"));
  assert.equal([...lastHtml.matchAll(/\ssrc="[^"]+"/g)].length, 0, "escaped text is not an image request");
  assert.deepEqual(seen, []);
  const long = "A".repeat(CARD_FIELD_MAX + 40);
  lastHtml = "";
  const r2 = await call(e, { template: "article", fields: { title: long, author: "Ada" } }, { "x-api-key": k }, { cache: memCache() });
  assert.equal(r2.status, 200);
  assert.ok(lastHtml.includes("A".repeat(CARD_FIELD_MAX)));
  assert.ok(!lastHtml.includes("A".repeat(CARD_FIELD_MAX + 1)));
  assert.equal(CARD_FIELD_MAX, 300);
  const built = buildCardHtml({ template: "product", width: 200, height: 200, fields: { title: "<b>", price: "9" } }, "");
  assert.ok(built.includes("&lt;b&gt;") && built.includes("9"));
});

test("size presets and format", async () => {
  const e = env(); const k = await newKey(e);
  const cases = [
    [{ template: "basic", fields: { title: "Og" } }, CARD_SIZES.og, "image/png"],
    [{ template: "basic", fields: { title: "Tw" }, size: "twitter" }, CARD_SIZES.twitter, "image/png"],
    [{ template: "product", fields: { title: "Sq" }, size: "square", format: "jpeg" }, CARD_SIZES.square, "image/jpeg"],
    [{ template: "article", fields: { title: "Cu" }, size: "custom", width: 800, height: 400 }, { width: 800, height: 400 }, "image/png"],
    [{ template: "basic", fields: { title: "Max" }, size: "custom", width: 2400, height: 1 }, { width: 2400, height: 1 }, "image/png"],
  ];
  for (const [body, vp, ct] of cases) {
    lastViewport = null;
    const r = await call(e, body, { "x-api-key": k }, { cache: memCache() });
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(r.headers.get("content-type"), ct);
    assert.deepEqual(lastViewport, vp);
  }
  assert.equal((await call(e, { template: "basic", fields: { title: "X" }, size: "custom", width: 2401, height: 10 }, { "x-api-key": k })).status, 400);
  assert.equal((await call(e, { template: "basic", fields: { title: "X" }, format: "gif" }, { "x-api-key": k })).status, 400);
  assert.equal((await call(e, { template: "nope", fields: {} }, { "x-api-key": k })).status, 400);
  assert.equal((await call(e, { template: "basic", html: "<p>both</p>" }, { "x-api-key": k })).status, 400);
  assert.equal(RENDER_TIME_MS, 15000);
  assert.equal(RENDER_MAX_HTML_BYTES, 2 * 1024 * 1024);
});

test("quota spend and refund, and a cache hit is free", async () => {
  const e = env(); const k = await newKey(e); const cache = memCache(); failNext = false; launches = 0;
  const body = { template: "basic", fields: { title: "Quota" }, size: "og" };
  const a = await call(e, body, { "x-api-key": k }, { cache });
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("x-card-cache"), "miss");
  assert.match(a.headers.get("etag") || "", /^"[0-9a-f]{64}"$/);
  assert.equal(a.headers.get("cache-control"), `public, max-age=${CARD_CACHE_TTL_S}`);
  assert.equal(CARD_CACHE_TTL_S, 7 * 24 * 60 * 60);
  const row = await e.RECEIPTS_DB.prepare("SELECT kind, renders FROM api_key_usage").first();
  assert.equal(row.kind, "card"); assert.equal(row.renders, 1);
  assert.equal(launches, 1);
  const b = await call(e, body, { "x-api-key": k }, { cache });
  assert.equal(b.status, 200);
  assert.equal(b.headers.get("x-card-cache"), "hit");
  assert.equal(launches, 1, "a cache hit does not launch the browser");
  assert.equal((await cardUsage(e)).renders, 1, "a cache hit does not spend a render");
  const etag = a.headers.get("etag");
  const c = await call(e, body, { "x-api-key": k, "if-none-match": etag }, { cache });
  assert.equal(c.status, 304);
  assert.equal((await cardUsage(e)).renders, 1);
  failNext = true;
  const d = await call(e, { template: "basic", fields: { title: "Fails" } }, { "x-api-key": k }, { cache });
  assert.equal(d.status, 502);
  assert.equal((await d.json()).charged, false);
  assert.equal((await cardUsage(e)).renders, 1, "a failed render gives its unit back");
  await e.RECEIPTS_DB.prepare("UPDATE api_keys SET monthly_quota = 1").run();
  const over = await call(e, { template: "product", fields: { title: "Over" } }, { "x-api-key": k }, { cache: memCache() });
  assert.equal(over.status, 429);
  assert.equal((await over.json()).reason, "quota_exceeded");
  assert.equal((await cardUsage(e)).renders, 1);
});

test("SSRF: private image URLs are refused, and template mode blocks every other request", async () => {
  const e = env(); const k = await newKey(e); launches = 0;
  for (const image of ["http://127.0.0.1/x", "http://169.254.169.254/latest/meta-data/", "http://internal.fixture/a", "file:///etc/passwd", "http://localhost/"]) {
    const r = await call(e, { template: "basic", fields: { title: "No", image } }, { "x-api-key": k }, { cache: memCache() });
    assert.equal(r.status, 400, image);
    assert.equal((await r.json()).reason, "ssrf_blocked");
  }
  assert.equal(launches, 0);
  assert.equal((await cardUsage(e)).renders, 0);
  seen = [];
  const hop = await call(e, { template: "article", fields: { title: "Hop", image: "https://ok.fixture/go" } }, { "x-api-key": k }, { cache: memCache() });
  assert.equal(hop.status, 400);
  assert.equal((await hop.json()).reason, "ssrf_blocked");
  assert.deepEqual(seen, ["https://ok.fixture/go", "http://internal.fixture/secret"]);
  assert.equal((await cardUsage(e)).renders, 0, "a blocked render is refunded");
  const g = makeRequestGuard({ templateMode: true, allowUrls: ["https://cdn.fixture/a.png"] });
  assert.equal(await g.check("https://cdn.fixture/a.png"), true);
  assert.equal(await g.check("https://cdn.fixture/other.png"), false);
  assert.equal(await g.check("http://10.0.0.8/x"), false);
  assert.equal(await g.check("ws://cdn.fixture/sock"), false);
  seen = [];
  const raw = await call(e, { html: '<img src="http://169.254.169.254/x"><img src="https://cdn.fixture/ok.png">', format: "png" }, { "x-api-key": k }, { cache: memCache() });
  assert.equal(raw.status, 200);
  assert.ok(seen.includes("http://169.254.169.254/x") && seen.includes("https://cdn.fixture/ok.png"));
});

test("signed GET: a good signature returns the card, a tampered one does not", async () => {
  const e = env(); const k = await newKey(e); const cache = memCache(); launches = 0;
  const post = await call(e, { template: "basic", fields: { title: "Share" }, size: "twitter" }, { "x-api-key": k }, { cache });
  assert.equal(post.status, 200);
  const link = post.headers.get("x-card-url");
  assert.match(link, /^https:\/\/api\.402xagent\.com\/v1\/render\/card\?t=.+&sig=[0-9a-f]{64}$/);
  const goodUrl = new URL(link);
  const good = await handleCard(new Request(goodUrl, { headers: { "cf-connecting-ip": freshIp() } }), e, {}, goodUrl, { launch, cache });
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("content-type"), "image/png");
  assert.equal(good.headers.get("x-card-cache"), "hit");
  assert.equal((await good.arrayBuffer()).byteLength, outBytes);
  assert.equal((await cardUsage(e)).renders, 1, "the signed fetch of a cached card is free");
  assert.equal(launches, 1);
  const bad = new URL(link);
  const sig = bad.searchParams.get("sig");
  bad.searchParams.set("sig", sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"));
  const tampered = await handleCard(new Request(bad, { headers: { "cf-connecting-ip": freshIp() } }), e, {}, bad, { launch, cache });
  assert.equal(tampered.status, 401);
  assert.equal((await tampered.json()).reason, "bad_signature");
  const flipped = new URL(link);
  const t = flipped.searchParams.get("t");
  flipped.searchParams.set("t", t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"));
  const tamperedBody = await handleCard(new Request(flipped, { headers: { "cf-connecting-ip": freshIp() } }), e, {}, flipped, { launch, cache });
  assert.equal(tamperedBody.status, 401);
  assert.equal(launches, 1);
  assert.equal((await cardUsage(e)).renders, 1);
  const row = await e.RECEIPTS_DB.prepare("SELECT id, key_hash FROM api_keys").first();
  const fresh = memCache();
  const signed = await signCardQuery(e, row, { template: "product", fields: { title: "Direct", price: "$4" }, size: "square", format: "jpeg" });
  const direct = new URL(API + RENDER_CARD_PATH + "?t=" + encodeURIComponent(signed.t) + "&sig=" + signed.sig);
  const got = await handleCard(new Request(direct, { headers: { "cf-connecting-ip": freshIp() } }), e, {}, direct, { launch, cache: fresh });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/jpeg");
  assert.equal(got.headers.get("x-card-cache"), "miss");
  assert.deepEqual(lastViewport, CARD_SIZES.square);
  assert.equal((await cardUsage(e)).renders, 2, "a signed cache miss spends one render");
  assert.equal(launches, 2);
});

test("discovery lists the card when RENDER=1", async () => {
  assert.ok(!(RENDER_CARD_PATH in openapi(API, {}).paths));
  const op = openapi(API, { RENDER: "1" }).paths[RENDER_CARD_PATH];
  assert.equal(op.post["x-payment-info"].price.amount, "0.002");
  assert.ok(op.get.parameters.some((p) => p.name === "sig"));
  const llms = await (await worker.fetch(new Request("https://402xagent.com/llms.txt"), { RENDER: "1", CLIENT_SALT: "t" }, { waitUntil() {} })).text();
  assert.match(llms, /Social card: POST https:\/\/api\.402xagent\.com\/v1\/render\/card/);
  assert.match(llms, /one render on the same quota/);
  const docs = await (await worker.fetch(new Request(API + "/v1/render/docs"), { RENDER: "1", CLIENT_SALT: "t" }, { waitUntil() {} })).json();
  assert.equal(docs.routes.card.method, "POST");
  assert.equal(docs.cache.ttl_seconds, CARD_CACHE_TTL_S);
  assert.equal(docs.price.card.includes("one card = one render"), true);
});

test("x402 pays for one card and a reused payment is refused", async () => {
  const e = env(); settles = 0; const cache = memCache();
  const quote = await call(e, { template: "basic", fields: { title: "Pay" } }, {}, { cache });
  assert.equal(quote.status, 402);
  assert.equal((await quote.json()).price_usd, "0.002");
  const sig = pay("c1");
  const ok = await call(e, { template: "basic", fields: { title: "Pay" } }, { "payment-signature": sig }, { cache });
  assert.equal(ok.status, 200);
  assert.equal(settles, 1);
  const again = await call(e, { template: "basic", fields: { title: "Pay" } }, { "payment-signature": sig }, { cache: memCache() });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).reason, "payment_reused");
});
