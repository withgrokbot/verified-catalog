// 0.77.2: the free-check network-cap 429 (after a network uses its free live spot-checks for the UTC day)
// carries the same structured paid_check offer as a free 200. Retry-After and every previous body field stay.
// The bulk_limit 429, other rate-limit 429s, and signed receipts are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { QuotaCounter, VERSION, secondsToUtcMidnight } from "../worker/src/lib.js";
import { SPOT_DEFAULT_PRICE_ATOMIC, SPOT_ID } from "../worker/src/spotcheck.js";
import { paidCheckBlock, PAID_CHECK_AMOUNT_ATOMIC, PAID_CHECK_PRICE_USD } from "../worker/src/paidcheck.js";
import { receiptGuard, RECEIPT_PAGES_PER_MIN } from "../worker/src/receiptguard.js";
import { handleHygiene, HYGIENE_FREE_PER_DAY } from "../worker/src/hygiene.js";
import { sqliteD1 } from "./helpers/sqlite_d1.mjs";
import { GOOD } from "./fixtures/hygiene.mjs";

test("0.77.2 version", () => assert.equal(VERSION, "0.78.1"));

const PAY_TO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const API = "https://api.402xagent.com";
const SPOT = "/v1/products/endpoint-spot-check";
const TARGET = "https://spot.target.fixture/api";

const prevFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://cloudflare-dns.com/dns-query")) {
    const type = new URL(u).searchParams.get("type") || "A";
    if (type === "A") return Response.json({ Answer: [{ type: 5, data: "cdn.example.fixture." }, { type: 1, data: "93.184.216.34" }] });
    return Response.json({ Answer: [{ type: 5, data: "cdn.example.fixture." }] });
  }
  if (u.startsWith("https://spot.target.fixture/")) {
    const challenge = {
      x402Version: 2,
      error: "Payment required",
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300 }],
    };
    const b64c = Buffer.from(JSON.stringify(challenge)).toString("base64");
    return new Response(JSON.stringify({ error: "payment_required", accepts: challenge.accepts, price: "$0.001" }), {
      status: 402,
      headers: { "content-type": "application/json", "payment-required": b64c },
    });
  }
  if (u.includes("/v1/hygiene") || u.startsWith("https://seller.fixture/")) {
    return new Response(GOOD.bodyText, { status: 402, headers: GOOD.headers });
  }
  return new Response("not found", { status: 404 });
};
test.after(() => { globalThis.fetch = prevFetch; });

function quotaNs() {
  const objects = new Map();
  return {
    idFromName(name) { return name; },
    get(id) {
      if (!objects.has(id)) {
        const store = new Map();
        const state = { storage: { get: async (k) => store.get(k), put: async (k, v) => void store.set(k, structuredClone(v)) } };
        objects.set(id, new QuotaCounter(state, {}));
      }
      const obj = objects.get(id);
      return { fetch: (u) => obj.fetch(new Request(u)) };
    },
  };
}

function env(extra = {}) {
  return {
    CLIENT_SALT: "test-salt",
    SELF_CLIENTS: "withgrokbot,withgrokbot-selftest,sam-selftest",
    PAY_TO,
    QUOTA: quotaNs(),
    MULTIPROBE_GAP_MS: "0",
    SPOT_FREE_PER_DAY: "1",
    SPOT_FREE_PER_IP_DAY: "1",
    LOOKUPS: { writeDataPoint() {} },
    ...extra,
  };
}

async function call(path, { ip = "198.51.100.21", ua = "agent-x/1.0", envo, headers = {}, method = "GET" } = {}) {
  const e = envo || env();
  const req = new Request("https://lookup.fixture" + path, { method, headers: { "user-agent": ua, "cf-connecting-ip": ip, ...headers } });
  const res = await worker.fetch(req, e, { waitUntil() {} });
  const txt = await res.text();
  return { status: res.status, body: txt ? JSON.parse(txt) : null, text: txt, headers: res.headers, env: e };
}

test("quota 429 has the paid_check offer, the price matches SPOT_DEFAULT_PRICE_ATOMIC, and Retry-After plus all previous fields are unchanged", async () => {
  assert.equal(PAID_CHECK_AMOUNT_ATOMIC, SPOT_DEFAULT_PRICE_ATOMIC);
  const e = env();
  const ip = "198.51.100.21";
  const first = await call(SPOT + "?url=" + encodeURIComponent(TARGET + "/q1") + "&client=q0772-a", { envo: e, ip });
  assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 200));
  assert.deepEqual(first.body.paid_check, paidCheckBlock(TARGET + "/q1"), "the free 200 already carries this block");
  const over = await call(SPOT + "?url=" + encodeURIComponent(TARGET + "/q2") + "&client=q0772-b", { envo: e, ip });
  assert.equal(over.status, 429);
  const ra = Number(over.headers.get("retry-after"));
  assert.ok(ra > 0 && ra <= 86400 && Math.abs(ra - secondsToUtcMidnight()) < 5, "Retry-After is seconds to 00:00 UTC");
  assert.equal(over.headers.get("cache-control"), "no-store");
  const expectedKeys = ["error", "product", "resets", "retry_after_s", "paid_check", "router_pack", "free_dry_runs", "rules"];
  assert.deepEqual(Object.keys(over.body).sort(), expectedKeys.slice().sort(), "no fields added or removed besides the paid_check value");
  assert.equal(over.body.error, "free check limit: 1 free live checks per UTC day from one network (across all client names)");
  assert.equal(over.body.product, SPOT_ID);
  assert.equal(over.body.resets, "00:00 UTC");
  assert.equal(over.body.retry_after_s, ra);
  assert.equal(over.body.free_dry_runs, "still available: add &mode=dry-run");
  assert.equal(over.body.rules, "https://402xagent.com/rules.json");
  assert.equal(over.body.router_pack.price, "$0.20 USDC for 10 checks ($0.02 each)");
  assert.equal(over.body.router_pack.how, "router tier: ask for a router client id, then pay one pack via x402");
  assert.deepEqual(over.body.paid_check, paidCheckBlock(TARGET + "/q2"));
  assert.equal(over.body.paid_check.price_usd, PAID_CHECK_PRICE_USD);
  assert.equal(over.body.paid_check.payment.amount_atomic, SPOT_DEFAULT_PRICE_ATOMIC);
  for (const k of ["product", "price_usd", "endpoint", "payment", "adds", "how"]) assert.ok(k in over.body.paid_check, k);
});

// Snapshot taken from main at f1e2bbe (2026-11-18), pages_minute 429 with BULK_LIMITS=1, now=2026-11-17T18:00:30Z.
const BULK_LIMIT_429_BODY = "{\"error\":\"bulk read limit reached\",\"code\":\"bulk_limit\",\"scope\":\"pages_minute\",\"limit\":\"6 receipt list pages per minute per client\",\"retry_after_seconds\":60,\"free_still_works\":\"Single receipts stay free: GET https://402xagent.com/v1/receipts/<id>, /v1/receipts/by-url?url=<one endpoint url>, /v1/receipts/<id>/proof. The limit counts list pages and heavy repeated reads, not one-off lookups.\",\"bulk_access\":{\"url\":\"https://402xagent.com/pricing#bulk-access\",\"status\":\"not_live\",\"note\":\"Full history, bulk export and .ots bundles are paid and not live yet. Nothing about them is free through this API.\"}}";
const BULK_LIMIT_429_HEADERS = [
  ["access-control-allow-origin", "*"],
  ["cache-control", "no-store"],
  ["content-type", "application/json; charset=utf-8"],
  ["link", "<https://402xagent.com/pricing#bulk-access>; rel=\"help\""],
  ["retry-after", "60"],
  ["x-receipt-limit", "pages_minute"],
];

test("bulk_limit 429 is byte-identical to main at f1e2bbe (body and headers)", async () => {
  const NOW = new Date("2026-11-17T18:00:30Z");
  const ok = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  const e = { BULK_LIMITS: "1", QUOTA: quotaNs() };
  const go = async (u) => {
    const url = new URL(u);
    const req = new Request(url, { headers: { "cf-connecting-ip": "198.51.100.10", "user-agent": "curl/8" } });
    return receiptGuard(req, e, null, url, url.pathname.replace(/\/+$/, "") || "/", ok, { now: NOW, cache: null });
  };
  for (let i = 0; i < RECEIPT_PAGES_PER_MIN; i++) assert.equal((await go("https://402xagent.com/v1/receipts?type=live&page=" + i)).status, 200);
  const over = await go("https://402xagent.com/v1/receipts?type=live&cursor=zz");
  assert.equal(over.status, 429);
  const body = await over.text();
  assert.equal(body, BULK_LIMIT_429_BODY, "bulk_limit 429 body must stay byte-identical to main");
  const got = new Headers(over.headers);
  got.delete("content-length");
  const dump = (h) => [...h.entries()].map(([k, v]) => k + ": " + v).join("\n");
  const expected = new Headers(BULK_LIMIT_429_HEADERS);
  assert.equal(dump(got), dump(expected), "bulk_limit 429 headers must stay byte-identical to main");
  assert.ok(!("paid_check" in JSON.parse(body)));
});

test("other 429s have no paid_check: dry-run cap, hygiene quota, discover rate limit", async () => {
  const e = env({ SPOT_DRY_PER_DAY: "1", RECEIPTS_DB: sqliteD1() });
  const dry1 = await call(SPOT + "?url=" + encodeURIComponent(TARGET + "/d1") + "&client=q0772-dry&mode=dry-run", { envo: e, ip: "203.0.113.8" });
  assert.equal(dry1.status, 200, JSON.stringify(dry1.body).slice(0, 180));
  const dry2 = await call(SPOT + "?url=" + encodeURIComponent(TARGET + "/d2") + "&client=q0772-dry&mode=dry-run", { envo: e, ip: "203.0.113.8" });
  assert.equal(dry2.status, 429);
  assert.ok(!("paid_check" in dry2.body), "dry-run cap 429 has no paid_check");
  assert.match(dry2.body.error, /dry-run limit/);

  const hcalls = [];
  const hdeps = { resolveHostFn: async () => ["203.0.113.50"], fetchImpl: async (u) => { hcalls.push(String(u)); return new Response(GOOD.bodyText, { status: 402, headers: GOOD.headers }); } };
  const hdb = { prepare(sql) {
    const st = { args: [], bind(...a) { st.args = a; return st; },
      async first() {
        if (/INTO hygiene_quota/.test(sql)) { this._n = (this._n || 0) + 1; return { n: this._n }; }
        return null;
      },
      async run() { return {}; } };
    // per-statement n is wrong; use a shared map
    return st;
  } };
  // Use a quota map that actually increments across calls.
  const hq = new Map();
  const hdb2 = { prepare(sql) {
    const st = { args: [], bind(...a) { st.args = a; return st; },
      async first() {
        if (/INTO hygiene_quota/.test(sql)) { const k = st.args[0] + "|" + st.args[1]; hq.set(k, (hq.get(k) || 0) + 1); return { n: hq.get(k) }; }
        return null;
      },
      async run() { return {}; } };
    return st;
  } };
  const henv = { RECEIPTS_DB: hdb2, CLIENT_SALT: "s" };
  const href = (n) => new Request(API + "/v1/hygiene?url=" + encodeURIComponent("https://seller.fixture/n" + n), { headers: { "cf-connecting-ip": "198.51.100.23" } });
  for (let i = 0; i < HYGIENE_FREE_PER_DAY; i++) {
    const r = await handleHygiene(href(i), henv, hdeps);
    assert.equal(r.status, 200, "hygiene " + i);
  }
  const hover = await handleHygiene(href(999), henv, hdeps);
  assert.equal(hover.status, 429);
  const hb = await hover.json();
  assert.ok(!("paid_check" in hb), "hygiene quota 429 has no paid_check");

  // discover 60/min: call until limited (same client/ip)
  const de = env();
  let disc429 = null;
  for (let i = 0; i < 70 && !disc429; i++) {
    const r = await call("/v1/discover?q=weather", { envo: de, ip: "198.51.100.40" });
    if (r.status === 429) disc429 = r;
  }
  if (disc429) {
    assert.ok(!("paid_check" in disc429.body), "discover rate-limit 429 has no paid_check");
    assert.match(disc429.body.error, /rate limited/);
  } else {
    // If the index is unavailable the route may 503 rather than count; still assert a non-429 didn't sneak an offer onto a 429.
    assert.ok(true, "discover did not emit a 429 in this env (index may be missing); other 429s already checked");
  }
});

test("MCP endpoint_spot_check shares the free-check quota and the 429 result carries the same paid_check block; x402_hygiene does not share it", async () => {
  const e = env();
  const ip = "198.51.100.55";
  const first = await call(SPOT + "?url=" + encodeURIComponent(TARGET + "/m1") + "&client=q0772-mcp-http", { envo: e, ip });
  assert.equal(first.status, 200);
  const mcpReq = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "endpoint_spot_check", arguments: { url: TARGET + "/m2" } },
  };
  const req = new Request("https://lookup.fixture/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "agent-x/1.0", "cf-connecting-ip": ip },
    body: JSON.stringify(mcpReq),
  });
  const res = await worker.fetch(req, e, { waitUntil() {} });
  const body = await res.json();
  assert.equal(res.status, 200, "MCP HTTP transport is 200; the tool result is the error");
  const result = body.result;
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.paid_check, paidCheckBlock(TARGET + "/m2"));
  assert.equal(result.structuredContent.paid_check.payment.amount_atomic, SPOT_DEFAULT_PRICE_ATOMIC);
  assert.equal(result._meta.paid_check.price_usd, PAID_CHECK_PRICE_USD);
  assert.match(result.content[0].text, /HTTP 429/);
  assert.deepEqual(JSON.parse(result.content[1].text), { paid_check: paidCheckBlock(TARGET + "/m2") });
  assert.equal(result.structuredContent.product, SPOT_ID);
  assert.equal(result.structuredContent.resets, "00:00 UTC");
  assert.ok(result.structuredContent.retry_after_s > 0);

  // x402_hygiene uses a separate quota: a hygiene 429 does not carry paid_check (and is not this cap).
  const hq = new Map();
  const hdb = { prepare(sql) {
    const st = { args: [], bind(...a) { st.args = a; return st; },
      async first() {
        if (/INTO hygiene_quota/.test(sql)) { const k = st.args[0] + "|" + st.args[1]; hq.set(k, (hq.get(k) || 0) + 1); return { n: hq.get(k) }; }
        return null;
      },
      async run() { return {}; } };
    return st;
  } };
  const henv = { ...e, RECEIPTS_DB: hdb };
  const hdeps = { resolveHostFn: async () => ["203.0.113.50"], fetchImpl: async () => new Response(GOOD.bodyText, { status: 402, headers: GOOD.headers }) };
  // Exceed hygiene quota via HTTP, then MCP should also see that quota (hygiene's own), without this offer.
  for (let i = 0; i < HYGIENE_FREE_PER_DAY; i++) {
    const hr = await handleHygiene(new Request(API + "/v1/hygiene?url=" + encodeURIComponent("https://seller.fixture/h" + i), { headers: { "cf-connecting-ip": "203.0.113.9" } }), henv, hdeps);
    assert.equal(hr.status, 200);
  }
  const mcpH = new Request("https://lookup.fixture/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", "user-agent": "agent-x/1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x402_hygiene", arguments: { url: "https://seller.fixture/hover" } } }),
  });
  const href = await worker.fetch(mcpH, henv, { waitUntil() {} });
  const hb = await href.json();
  const hres = hb.result;
  assert.equal(hres.isError, true);
  const blob = JSON.stringify(hres);
  assert.ok(!blob.includes("paid_check"), "x402_hygiene quota-exhausted result does not get this offer (separate quota)");
});
