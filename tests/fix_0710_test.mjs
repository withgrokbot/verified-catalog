// 0.71.0 "fix the asking": every 400/422 JSON body (API routes, x402 products, MCP tool input errors, JSON-RPC parse errors)
// carries one `fix` object {expected, endpoint, example, docs}; two default 404s for known wrong URLs carry it too.
// Status codes and every existing field stay as they were; the fix is static, so nothing the caller sent is echoed.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { QuotaCounter, VERSION, MCP_TOOLS } from "../worker/src/lib.js";
import { FIX_ROUTES, fixFor, fixFor404, toolFix, routeFor } from "../worker/src/fix.js";
import { sqliteD1 as d1 } from "./helpers/sqlite_d1.mjs";

const API = "https://api.402xagent.com";
const PAY_TO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";
globalThis.fetch = async (u) => {
  const s = String(u && u.url ? u.url : u);
  if (s.startsWith("https://cloudflare-dns.com/dns-query")) { const t = new URL(s).searchParams.get("type"); return Response.json({ Answer: t === "A" ? [{ type: 1, data: "93.184.216.34" }] : [] }); }
  if (s === "https://data.fixture/vc/catalog.json") return Response.json({ generated_at: "2026-10-28T11:00:00Z", services: [] });
  if (s === "https://data.fixture/vc/receipts.json") return Response.json({ stale_after_hours: 36, services: {} });
  if (s.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /private\n", { headers: { "content-type": "text/plain" } });
  return new Response("nope", { status: 404 });
};
function quotaNs() {
  const objs = new Map();
  return { idFromName: (n) => n, get: (id) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, new QuotaCounter({ storage: { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) } }, {})); } const o = objs.get(id); return { fetch: (u, i) => o.fetch(u instanceof Request ? u : new Request(u, i)) }; } };
}
const env = (x = {}) => ({ PAY_TO, FACILITATOR_URL: "https://facilitator.fixture", CLIENT_SALT: "t", DATA_BASE_URL: "https://data.fixture/vc/", QUOTA: quotaNs(), RECEIPTS_DB: d1(), RENDER: "1", BROWSER: {}, RENDER_EMAIL: { send: async () => ({ messageId: "m" }) }, RENDER_EMAIL_FROM: "keys@402xagent.example", PDF_TABLES: "1", APIFY_TOKEN: "x", ENDPOINT_REPORT: "1", ...x });
const send = async (path, { method = "GET", body, headers = {}, e = env() } = {}) => {
  const r = await worker.fetch(new Request(API + path, { method, headers: { "cf-connecting-ip": "198.51.100.7", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body }), e, { waitUntil() {} });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, body: j, text: t, headers: r.headers };
};
const rpc = (m, e = env()) => send("/mcp", { method: "POST", body: JSON.stringify(m), headers: { accept: "application/json, text/event-stream" }, e });
const SHAPE = (f, path, method) => {
  assert.deepEqual(Object.keys(f).filter((k) => ["expected", "endpoint", "example", "docs"].includes(k)).sort(), ["docs", "endpoint", "example", "expected"], "fix keys " + path);
  assert.ok(f.expected && typeof f.expected === "object" && f.expected.required && f.expected.optional, "expected.required/optional " + path);
  assert.match(f.endpoint.method, /^(GET|POST)$/); assert.ok(f.endpoint.url.startsWith(API + "/") || f.endpoint.url.startsWith("https://402xagent.com/"), f.endpoint.url);
  assert.match(f.example.method, /^(GET|POST)$/); assert.ok(f.example.url.startsWith(API + "/"), f.example.url);
  if (f.example.method === "POST") assert.ok(f.example.body && f.example.headers["content-type"] === "application/json", "POST example has a JSON body " + path);
  assert.match(f.docs, /^https:\/\/(api\.)?402xagent\.com\//);
  assert.ok(JSON.stringify(f).length < 2600, "fix stays small: " + JSON.stringify(f).length);
};

test("0.71.0 version", () => assert.equal(VERSION, "0.79.0"));

test("fix table: every route family has a complete, static fix; unknown routes fall back to the free check", () => {
  const ids = new Set();
  for (const r of FIX_ROUTES) {
    assert.ok(!ids.has(r.id), "unique id " + r.id); ids.add(r.id);
    const path = r.endpoint.url.replace(/^https:\/\/api\.402xagent\.com/, "").replace("{host}", "api.402rates.com").replace("{id}", "x").replace(".svg", "").replace(/\?.*$/, "");
    assert.equal(routeFor(path)?.id, r.id, "route matches its own endpoint path: " + r.id);
    SHAPE(fixFor(path, r.endpoint.method, 400), path, r.endpoint.method);
  }
  const f = fixFor("/v1/never-heard-of-it", "GET", 400); SHAPE(f, "fallback"); assert.equal(f.endpoint.url, API + "/v1/products/endpoint-spot-check");
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // the public USDC contract on Base, the one wallet-like string in the table
  assert.ok(!/0x[0-9a-f]{16,}|sk_|rk_|whsec_|Bearer /i.test(JSON.stringify(FIX_ROUTES.map((r) => [r.expected, r.example, r.endpoint])).split(USDC_BASE).join("")), "no secret-looking text in the table");
});

test("400s across routes keep status and old fields, and gain fix pointing at the right route", async () => {
  const cases = [
    ["/v1/products/endpoint-spot-check?url=notaurl", "GET", undefined, "/v1/products/endpoint-spot-check"],
    ["/v1/products/endpoint-spot-check", "POST", "nope", "/v1/products/endpoint-spot-check"],
    ["/v1/lookup?task=web-search&max_price=abc", "GET", undefined, "/v1/lookup"],
    ["/v1/receipts?type=nope", "GET", undefined, "/v1/receipts"],
    ["/v1/receipts/by-url", "GET", undefined, "/v1/receipts/by-url"],
    ["/v1/products/page-to-markdown", "GET", undefined, "/v1/products/page-to-markdown"],
    ["/v1/products/page-to-markdown?url=http://127.0.0.1/", "GET", undefined, "/v1/products/page-to-markdown"],
    ["/v1/products/pdf-tables?ocr=maybe", "GET", undefined, "/v1/products/pdf-tables"],
    ["/v1/render/card", "POST", JSON.stringify({ template: "nope" }), "/v1/render/card"],
    ["/v1/render/pdf", "POST", JSON.stringify({ url: "https://a.fixture/", html: "<p>x</p>" }), "/v1/render/pdf"],
    ["/v1/render/screenshot", "POST", "{not json", "/v1/render/screenshot"],
    ["/v1/render/keys", "POST", JSON.stringify({ email: "nope" }), "/v1/render/keys"],
    ["/v1/facilitator/check", "POST", JSON.stringify({}), "/v1/facilitator/check"],
    ["/reputation/%7Bhost%7D", "GET", undefined, "/reputation/{host}"], // unfilled template, a 400 before routing
  ];
  for (const [path, method, body, endpointPath] of cases) {
    const r = await send(path, { method, body });
    assert.equal(r.status, 400, path + " " + r.text.slice(0, 200));
    assert.ok(r.body.error !== undefined || r.body.input_error !== undefined || r.body.message !== undefined, "old error field kept " + path);
    SHAPE(r.body.fix, path, method);
    assert.equal(r.body.fix.endpoint.url, API + endpointPath, path);
    assert.equal(r.body.openapi, "https://api.402xagent.com/openapi.json", "0.48.0 fields still added " + path);
    assert.ok("field" in r.body && "expected" in r.body && "received" in r.body, "0.48.0 field/expected/received kept " + path);
  }
});

test("POST routes with a JSON body get a POST example; GET routes get a GET one", async () => {
  const post = await send("/v1/products/endpoint-spot-check", { method: "POST", body: "nope" });
  assert.equal(post.body.fix.example.method, "POST"); assert.deepEqual(post.body.fix.example.body, { url: "https://api.402rates.com/v1/ping" });
  const get = await send("/v1/products/endpoint-spot-check?url=notaurl");
  assert.equal(get.body.fix.example.method, "GET"); assert.equal(get.body.fix.example.url, API + "/v1/products/endpoint-spot-check?url=https://api.402rates.com/v1/ping");
});

test("the fix never echoes the caller's input (secret-looking, huge, markup) and the old received field stays capped", async () => {
  const canary = "0x" + "ab".repeat(20), big = "Z".repeat(3000), tag = "<script>alert(1)</script>";
  for (const v of [canary, big, tag, ["sk", "live", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_")]) {
    for (const path of ["/v1/products/endpoint-spot-check?link=", "/v1/lookup?max_price=", "/v1/products/pdf-tables?ocr=", "/v1/receipts?type="]) {
      const r = await send(path + encodeURIComponent(v));
      assert.equal(r.status, 400, path);
      const fixText = JSON.stringify(r.body.fix);
      assert.ok(!fixText.includes(v.slice(0, 12)) && !fixText.includes("alert("), "fix is static: " + path);
      assert.ok(r.text.length < 6000, "whole body bounded " + r.text.length);
      assert.ok(!r.text.includes(big.slice(0, 200)) && !r.text.includes(canary), "input still not echoed raw " + path);
    }
  }
});

test("422 keeps its body and status and only gains fix (with the reason table where the route has one)", async () => {
  const r = await send("/v1/products/page-to-markdown?url=" + encodeURIComponent("https://ok.fixture/private/x"));
  assert.equal(r.status, 422); assert.equal(r.body.reason, "robots_txt_disallow"); assert.equal(r.body.charged, false);
  assert.ok(!("field" in r.body) && !("received" in r.body), "422 body is not rewritten");
  SHAPE(r.body.fix, "422", "GET"); assert.equal(r.body.fix.endpoint.url, API + "/v1/products/page-to-markdown");
  assert.match(r.body.fix.reasons.robots_txt_disallow, /forbids/);
});

test("paid routes: an unpaid bad request is still the 402 (no fix, price unchanged); with a payment header it is the strict 400 plus fix", async () => {
  const unpaid = await send("/v1/products/endpoint-report", { method: "POST", body: JSON.stringify({ url: "nope" }) });
  assert.equal(unpaid.status, 402); assert.ok(!("fix" in unpaid.body));
  const hdr = btoa(JSON.stringify({ x402Version: 2, payload: { authorization: {} } }));
  const paid = await send("/v1/products/endpoint-report", { method: "POST", body: JSON.stringify({ url: "nope" }), headers: { "payment-signature": hdr } });
  assert.equal(paid.status, 400); SHAPE(paid.body.fix, "er", "POST"); assert.equal(paid.body.fix.endpoint.url, API + "/v1/products/endpoint-report");
  assert.equal(paid.body.example.method, "POST", "the route's own example field is untouched");
});

test("MCP: tool input errors keep content[0] and gain a second text block + structuredContent.fix built from the tool's schema; search_catalog and get_service stay pinned", async () => {
  for (const [name, args] of [["endpoint_spot_check", {}], ["x402_hygiene", {}], ["get_receipt", {}], ["payment_status", {}]]) {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const res = r.body.result;
    assert.equal(r.status, 200); assert.equal(res.isError, true, name);
    assert.equal(res.content.length, 2, name); assert.ok(res.content[0].text && !res.content[0].text.startsWith("{"), "content[0] is still the plain message");
    assert.deepEqual(JSON.parse(res.content[1].text), { fix: res.structuredContent.fix });
    const f = res.structuredContent.fix; SHAPE(f, name, "POST");
    assert.equal(f.endpoint.url, API + "/mcp"); assert.equal(f.example.body.params.name, name);
    assert.equal(f.example.body.method, "tools/call");
  }
  const spot = toolFix("endpoint_spot_check", MCP_TOOLS);
  assert.ok("url" in spot.expected.required && "claimed_price" in spot.expected.optional, "expected comes from the tool inputSchema");
  const pinned = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_catalog", arguments: { max_price_usd: "abc" } } });
  assert.equal(pinned.body.result.isError, true); assert.equal(pinned.body.result.content.length, 1); assert.ok(!("structuredContent" in pinned.body.result));
});

test("JSON-RPC parse error (HTTP 400) carries fix inside error.data", async () => {
  const r = await send("/mcp", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, -32700);
  SHAPE(r.body.error.data.fix, "mcp", "POST"); assert.equal(r.body.error.data.fix.endpoint.url, API + "/mcp");
});

test("render/card: GET without t and sig (the common mix-up) is still 401 and now says to POST; a signed-link failure is unchanged", async () => {
  const r = await send("/v1/render/card?template=basic&title=Hi");
  assert.equal(r.status, 401); assert.equal(r.body.reason !== undefined, true); assert.equal(r.body.charged, false);
  SHAPE(r.body.fix, "card", "POST"); assert.equal(r.body.fix.endpoint.method, "POST"); assert.equal(r.body.fix.endpoint.url, API + "/v1/render/card");
  assert.ok(r.body.fix.expected.rules.some((x) => /GET \/v1\/render\/card only serves a signed link/.test(x)));
  const bad = await send("/v1/render/card?t=abc&sig=def");
  assert.equal(bad.status, 401); assert.ok(!("fix" in bad.body), "a real (bad) signed link is not the mix-up");
});

test("404 for known wrong URLs (render/card, render keys by GET, MCP paths) names the right route; status and other fields unchanged; unknown paths unchanged", async () => {
  const keysGet = await send("/v1/render/keys");
  assert.equal(keysGet.status, 404); assert.equal(keysGet.body.error, "not found"); assert.ok(keysGet.body.usage && keysGet.body.docs);
  assert.equal(keysGet.body.fix.endpoint.method, "POST"); assert.equal(keysGet.body.fix.endpoint.url, API + "/v1/render/keys"); assert.match(keysGet.body.fix.note, /takes POST, not GET/);
  for (const p of ["/v1/cards", "/v1/render/cards", "/v1/og", "/render/card"]) { const r = await send(p); assert.equal(r.status, 404, p); assert.equal(r.body.fix.endpoint.url, API + "/v1/render/card", p); }
  for (const p of ["/render", "/docs/render", "/v1/render"]) { const r = await send(p); assert.equal(r.status, 404, p); assert.equal(r.body.fix.endpoint.url, API + "/v1/render/docs", p); }
  const mcp = await send("/mcp/mcp", { method: "POST", body: "{}" });
  assert.equal(mcp.status, 404); assert.equal(mcp.body.fix.endpoint.url, API + "/mcp"); assert.equal(mcp.body.error, "not found"); assert.ok(mcp.body.openapi && mcp.body.skill);
  const sse = await send("/sse"); assert.equal(sse.status, 404); assert.equal(sse.body.fix.endpoint.url, API + "/mcp");
  const unknown = await send("/wp-admin/install.php"); assert.equal(unknown.status, 404); assert.ok(!("fix" in unknown.body));
  const off = await send("/v1/render/keys", { e: env({ RENDER: undefined }) }); assert.equal(off.status, 404); assert.ok(!("fix" in off.body), "render off: no hint for a route that is not live");
  assert.equal(fixFor404("/v1/nope", "GET", { render: true }), null);
});

test("existing 405 and 200 answers are untouched", async () => {
  const r = await send("/v1/lookup", { method: "PUT", body: "{}" });
  assert.equal(r.status, 405); assert.ok(!("fix" in r.body));
  const ok = await send("/v1/tasks"); assert.equal(ok.status, 200); assert.ok(!("fix" in (ok.body || {})));
});
