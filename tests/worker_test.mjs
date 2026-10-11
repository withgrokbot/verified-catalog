import { existsSync } from "node:fs";
// Unit tests for worker/src/index.js with a stubbed fetch and a stubbed Analytics Engine binding.
// All data here is synthetic. Run: node tests/worker_test.mjs   (Node 18+; no dependencies)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/index.js";
import { normUrl, receiptIdFor } from "../worker/src/skips.js";
import { RECEIPTS_META } from "../worker/src/receipts-data.js";
import { VERSION, listingFor, pickPayment, termsSha256, applyPayment, paymentObject, _resetCache, isoWeek, ipPrefix, saltPeriod, QuotaCounter, takeFree, quotaKey, PAYMENT_POLICY } from "../worker/src/lib.js";
import { LANDING_EXAMPLES } from "../worker/src/landing.js";

const BASE = "https://data.test/vc/";
const H = 3600000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const svc = (id, price, tasks, extra = {}) => ({
  id, name: id.toUpperCase(), endpoint: `https://${id}.test/api`, category: "web search", description: "synthetic",
  tasks, advertised_price: { amount_usd: price }, sample_request: { method: "GET" },
  latest: { checked_at: iso(now - H), reachable: true, x402_challenge: true, quoted_price_usd: price, price_matches_listing: true },
  page_url: `${BASE}services/${id}.html`, ...extra,
});
const rc = (ageH, quality, payTo = "0x00000000000000000000000000000000000000aa") => ({
  time: iso(now - ageH * H), tx: "0x" + "ab".repeat(32), basescan_url: "https://basescan.org/tx/0x" + "ab".repeat(32),
  charged_usd: "0.01", delivered: quality !== "fail", http_status: 200, quality, quality_reason: "synthetic", pay_to: payTo,
  raw_log_url: BASE + "results/raw/x.json",
});
const CATALOG = {
  generated_at: iso(now), methodology_url: BASE + "methodology.html", contest_url: "https://issues.test/new",
  services: [
    svc("alpha", "0.01", ["web-search"]),
    svc("beta", "0.005", ["web-search"]),
    svc("gamma", "0.002", ["web-search"]),
    svc("delta", "0.05", ["web-search"]),
    svc("broken", "0.01", ["web-search"]),
    svc("weather1", "0.001", ["weather"], { category: "weather", description: "current weather for a city" }),
  ],
};
const MCP_PY = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.py");
const CAT_FILE = join(mkdtempSync(join(tmpdir(), "vc-mcp-")), "catalog.json");
const RECEIPTS = {
  stale_after_hours: 36,
  services: {
    alpha: { quality_test: { input: "q", pass_if: "p", facts_only: false }, receipts: [rc(2, "pass"), rc(26, "pass"), rc(50, "fail"), rc(74, "pass"), rc(98, "pass"), rc(122, "fail")] },
    beta: { quality_test: { input: "q", pass_if: "p", facts_only: false }, receipts: [rc(1, "pass"), rc(25, "fail"), rc(49, null)] },
    gamma: { quality_test: { input: "q", pass_if: "p", facts_only: false }, receipts: [rc(40, "pass")] },
    delta: { receipts: [rc(1, "pass")] },
    broken: { quality_test: { input: "q", pass_if: "p", facts_only: true, facts_only_reason: "HTTP 500 after payment" }, receipts: [rc(3, null)] },
    weather1: { receipts: [] },
  },
};

writeFileSync(CAT_FILE, JSON.stringify(CATALOG));
let serveReceipts = true;
let fetches = 0;
const FAC = "https://facilitator.test";
const facCalls = [];
let facMode = "ok"; // ok | invalid | settle-fail
let facPayer = "0x" + "11".repeat(20);
const TX = "0x" + "cd".repeat(32);
let spotTargetMode = "402"; // 402 | timeout | huge | echo-init
let lastSpotFetchInit = null;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith(FAC)) {
    const body = JSON.parse(init.body || "{}");
    facCalls.push([u.slice(FAC.length), body]);
    if (u.endsWith("/verify"))
      return Response.json(facMode === "invalid" ? { isValid: false, invalidReason: "insufficient_funds" } : { isValid: true, payer: "0x" + "11".repeat(20) });
    if (u.endsWith("/settle"))
      return Response.json(facMode === "settle-fail" ? { success: false, errorReason: "transaction_failed" } : { success: true, transaction: TX, network: "eip155:8453", payer: facPayer });
  }
  // DoH for SSRF resolve (spot-check)
  if (u.startsWith("https://cloudflare-dns.com/dns-query")) {
    const name = new URL(u).searchParams.get("name") || "";
    const type = new URL(u).searchParams.get("type") || "A";
    if (/^(localhost|metadata\.google\.internal)$/i.test(name)) {
      return Response.json({ Answer: [{ type: type === "A" ? 1 : 28, data: name === "localhost" ? "127.0.0.1" : "169.254.169.254" }] });
    }
    // Realistic CNAME + A chain (must ignore type 5)
    if (type === "A") return Response.json({ Answer: [{ type: 5, data: "cdn.example.test." }, { type: 1, data: "93.184.216.34" }] });
    return Response.json({ Answer: [{ type: 5, data: "cdn.example.test." }] });
  }
  // Spot-check probe targets (never expect payment headers)
  if (u.startsWith("https://topagentx402.vercel.app/api/send-token")) {
    // the live 402 seen in our 2026-10-07 crawl: Base mainnet, while the listing says Base Sepolia
    const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xb1f64fc8689a17014Cf0748e8EeaD58C5457Ec74" }];
    return new Response(JSON.stringify({ x402Version: 2, accepts }), { status: 402, headers: { "content-type": "application/json" } });
  }
  if (u.startsWith("https://spot.target.test/") || u.startsWith("https://x402.example.test/")) {
    lastSpotFetchInit = init || {};
    if (spotTargetMode === "timeout") {
      const err = new Error("timeout"); err.name = "AbortError"; throw err;
    }
    if (spotTargetMode === "ok200") return new Response('{"data":1}', { status: 200, headers: { "content-type": "application/json" } });
    if (spotTargetMode === "trial") return new Response('{"data":1}', { status: 200, headers: { "content-type": "application/json", "x-free-trial": "true", "x-free-trial-remaining": "3" } });
    if (spotTargetMode === "trialflag") return new Response('{"data":1}', { status: 200, headers: { "x-free-trial": "true", "x-free-trial-remaining": "n/a" } });
    if (spotTargetMode === "notfound") return new Response("nope", { status: 404 });
    if (spotTargetMode === "huge") {
      return new Response("x".repeat(200000), { status: 200, headers: { "content-type": "text/plain" } });
    }
    const challenge = {
      x402Version: 2,
      error: "Payment required",
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", maxTimeoutSeconds: 300 }],
    };
    const b64c = Buffer.from(JSON.stringify(challenge)).toString("base64");
    return new Response(JSON.stringify({ error: "payment_required", accepts: challenge.accepts, price: "$0.001" }), {
      status: 402,
      headers: { "content-type": "application/json", "payment-required": b64c },
    });
  }
  fetches++;
  if (u === BASE + "catalog.json") return new Response(JSON.stringify(CATALOG), { status: 200 });
  if (u === BASE + "receipts.json") return serveReceipts ? new Response(JSON.stringify(RECEIPTS), { status: 200 }) : new Response("nope", { status: 404 });
  return new Response("not found", { status: 404 });
};

// In-memory Durable Object namespace that runs the real QuotaCounter class.
function fakeQuotaNamespace({ broken = false } = {}) {
  const objects = new Map();
  const names = [];
  return {
    names,
    idFromName(name) {
      names.push(name);
      return name;
    },
    get(id) {
      if (broken) return { fetch: async () => { throw new Error("DO down"); } };
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

function mkEnv(opts = {}) {
  const points = [];
  return {
    points,
    env: {
      DATA_BASE_URL: BASE, CLIENT_SALT: "test-salt", SELF_CLIENTS: "withgrokbot,withgrokbot-selftest,sam-selftest",
      LOOKUPS: { writeDataPoint: (p) => { if (opts.throwing) throw new Error("AE down"); points.push(p); } },
      ...(opts.quota ? { QUOTA: opts.quota, FACILITATOR_URL: FAC, FREE_PER_DAY: "5", PRICE_ATOMIC: "20000",
                         PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674" } : {}),
    },
  };
}
async function call(path, { ua = "agent-x/1.0", ip = "203.0.113.7", envo, headers = {} } = {}) {
  const e = envo || mkEnv();
  const req = new Request("https://lookup.test" + path, { headers: { "user-agent": ua, "cf-connecting-ip": ip, ...headers } });
  const res = await worker.fetch(req, e.env, { waitUntil() {} });
  return { status: res.status, body: res.status === 204 ? null : await res.json(), points: e.points, headers: res.headers };
}

const T = [];
const test = (name, fn) => T.push([name, fn]);

test("lookup filters by task and max_price, sorts by pass rate then price, separates facts-only", async () => {
  const r = await call("/v1/lookup?task=web-search&max_price=0.01&n=5");
  assert.equal(r.status, 200);
  // alpha last 5: pass,pass,fail,pass,pass = 0.8; beta last 5 graded: pass,fail = 0.5; gamma 1/1 = 1.0; delta over price
  assert.deepEqual(r.body.results.map((x) => [x.id, x.pass_rate]), [["gamma", 1], ["alpha", 0.8], ["beta", 0.5]]);
  assert.deepEqual(r.body.facts_only.map((x) => x.id), ["broken"]);
  assert.equal(r.body.facts_only[0].pass_rate, undefined, "facts-only services carry no pass rate");
  assert.match(r.body.facts_only[0].facts_only_reason, /HTTP 500/);
  const a = r.body.results[1];
  assert.equal(a.receipts.length, 5);
  for (const k of ["time", "tx", "basescan_url", "charged_usd", "delivered", "quality"]) assert.ok(k in a.receipts[0], k);
  assert.equal(a.stale, false);
  assert.equal(r.body.results[0].stale, true, "gamma's newest receipt is 40 h old");
  assert.ok(a.last_check_at && a.endpoint && a.price_usd === "0.01");
});

test("n limits receipts per service and pass rate uses only those; ties sort by price", async () => {
  const r = await call("/v1/lookup?task=web-search&max_price=0.01&n=1");
  assert.deepEqual(r.body.results.map((x) => [x.id, x.pass_rate, x.receipts.length]), [["gamma", 1, 1], ["beta", 1, 1], ["alpha", 1, 1]]);
});

test("endpoint lookup by id or URL, and unknown task falls back to text match", async () => {
  let r = await call("/v1/lookup?endpoint=alpha");
  assert.deepEqual(r.body.results.map((x) => x.id), ["alpha"]);
  r = await call("/v1/lookup?endpoint=" + encodeURIComponent("https://beta.test/api"));
  assert.deepEqual(r.body.results.map((x) => x.id), ["beta"]);
  r = await call("/v1/lookup?task=web-search&max_price=1&limit=20");
  assert.ok(!r.body.results.some((x) => x.id === "weather1"), "known task names match exactly");
  r = await call("/v1/lookup?task=weather&max_price=1");
  assert.deepEqual(r.body.results.map((x) => x.id), ["weather1"], "description text does not widen a known task");
  r = await call("/v1/lookup?task=city%20weather&max_price=1");
  assert.deepEqual(r.body.results.map((x) => x.id), ["weather1"]);
  assert.equal(r.body.results[0].pass_rate, null);
  assert.equal(r.body.results[0].stale, true, "no receipts means stale");
});

test("qualifying lookup is counted once with a hashed client id and no raw IP", async () => {
  const r = await call("/v1/lookup?task=web-search&max_price=0.02", { ip: "198.51.100.23" });
  assert.equal(r.points.length, 1);
  const p = r.points[0];
  assert.equal(p.doubles[0], 1, "qualifying");
  assert.equal(p.blobs[5], "");
  assert.match(p.blobs[0], /^h:[0-9a-f]{20}$/);
  assert.equal(p.indexes[0], p.blobs[0]);
  assert.ok(!JSON.stringify(p).includes("198.51.100"), "raw IP must never be stored");
  assert.ok(p.blobs[7].includes("0x00000000000000000000000000000000000000aa"), "returned vendor pay_to recorded");
});

test("ref is recorded for attribution and never changes the client id", async () => {
  const a = (await call("/v1/lookup?task=web-search&max_price=0.01", { ip: "198.51.100.23" })).points[0];
  const b = (await call("/v1/lookup?task=web-search&max_price=0.01&ref=via-README", { ip: "198.51.100.23" })).points[0];
  assert.equal(b.blobs[0], a.blobs[0], "same client id with or without ref");
  assert.equal(b.blobs[10], "via-readme");
  assert.equal(b.doubles[0], 1, "still qualifying");
  const bad = (await call("/v1/lookup?task=web-search&max_price=0.01&ref=a%20b", { ip: "198.51.100.23" })).points[0];
  assert.equal(bad.blobs[10], "", "invalid ref ignored, not an error");
});

test("client id: same /24 + UA -> same id; other /24, other UA, or client param -> different", async () => {
  const id = async (o, q = "") => (await call("/v1/lookup?task=web-search&max_price=0.01" + q, o)).points[0].blobs[0];
  const a = await id({ ip: "198.51.100.23" });
  assert.equal(await id({ ip: "198.51.100.99" }), a);
  assert.notEqual(await id({ ip: "198.51.101.23" }), a);
  assert.notEqual(await id({ ip: "198.51.100.23", ua: "other/2" }), a);
  assert.equal(await id({}, "&client=My-Agent"), "c:my-agent");
  assert.equal(ipPrefix("2001:db8:abcd:12::1"), "2001:db8:abcd::/48");
  assert.equal(ipPrefix("2001:db8::1"), "2001:db8:0::/48");
  assert.equal(isoWeek(new Date(Date.UTC(2026, 8, 30))), "2026-W40");
  const ep = { WEEK_EPOCH: "2026-10-05" };
  assert.equal(saltPeriod(new Date(Date.UTC(2026, 9, 5, 0, 0, 1)), ep), "w0", "test day 1");
  assert.equal(saltPeriod(new Date(Date.UTC(2026, 9, 11, 23, 59)), ep), "w0", "test day 7");
  assert.equal(saltPeriod(new Date(Date.UTC(2026, 9, 12, 0, 1)), ep), "w1", "test day 8");
  assert.equal(saltPeriod(new Date(Date.UTC(2026, 9, 18, 23, 59)), ep), "w1", "test day 14");
});

test("not qualifying: self, crawler, uptime bot, missing price, no candidates, bad params", async () => {
  const q = async (path, o) => (await call(path, o)).points[0];
  let p = await q("/v1/lookup?task=web-search&max_price=0.01&client=withgrokbot-selftest");
  assert.deepEqual([p.doubles[0], p.blobs[5]], [0, "self"]);
  p = await q("/v1/lookup?task=web-search&max_price=0.01", { ua: "Mozilla/5.0 (compatible; Googlebot/2.1)" });
  assert.deepEqual([p.doubles[0], p.blobs[5]], [0, "crawler"]);
  p = await q("/v1/lookup?task=web-search&max_price=0.01", { ua: "UptimeRobot/2.0" });
  assert.deepEqual([p.doubles[0], p.blobs[5]], [0, "uptime"]);
  p = await q("/v1/lookup?task=web-search");
  assert.deepEqual([p.doubles[0], p.blobs[5]], [0, "missing-task-or-price"]);
  p = await q("/v1/lookup?task=web-search&max_price=0.0001");
  assert.deepEqual([p.doubles[0], p.blobs[5]], [0, "no-candidates"]);
  const r = await call("/v1/lookup?task=web-search&max_price=abc&payer=0x12");
  assert.equal(r.status, 400);
  assert.match(r.body.error, /max_price/);
  assert.match(r.body.error, /payer/);
  assert.deepEqual([r.points[0].doubles[0], r.points[0].blobs[5]], [0, "bad-params"]);
  const r2 = await call("/v1/lookup");
  assert.equal(r2.status, 400);
  assert.ok(r2.body.tasks.includes("web-search"));
  assert.ok(r2.body.try_free_lookup.url.includes("ref=via-402-hint"));
  assert.match(r2.body.also_available.url, /\/v1\/products\/overnight-cos-pack$/);
  p = await q("/v1/lookup?task=web-search&max_price=0.02", { ua: "curl/8.5.0" });
  assert.equal(p.doubles[0], 1, "an agent with a generic UA still counts");
});

test("payer is stored lower-case for the later on-chain check", async () => {
  const p = (await call("/v1/lookup?task=web-search&max_price=0.01&payer=0xABCDEFabcdef0123456789012345678901234567")).points[0];
  assert.equal(p.blobs[6], "0xabcdefabcdef0123456789012345678901234567");
});

test("tasks, openapi, health, help, 404 and CORS; counting failure never breaks an answer", async () => {
  let r = await call("/v1/tasks");
  assert.deepEqual(r.body.tasks["web-search"].length, 5);
  assert.equal(r.points.length, 0, "only lookups are counted");
  r = await call("/openapi.json");
  assert.equal(r.body.openapi, "3.1.0");
  assert.ok(r.body.paths["/v1/lookup"]);
  r = await call("/health");
  assert.equal(r.body.ok, true);
  r = await call("/");
  assert.match(r.body.usage, /\/v1\/lookup\?task=/);
  r = await call("/nope");
  assert.equal(r.status, 404);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  r = await call("/v1/lookup?task=web-search&max_price=0.01", { envo: mkEnv({ throwing: true }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.results.length, 3);
});

test("data is cached between requests; missing receipts.json still answers", async () => {
  _resetCache();
  fetches = 0;
  await call("/v1/lookup?task=web-search&max_price=0.01");
  await call("/v1/lookup?task=web-search&max_price=0.01");
  assert.equal(fetches, 2, "catalog + receipts fetched once, then served from cache");
  _resetCache();
  serveReceipts = false;
  const r = await call("/v1/lookup?task=web-search&max_price=0.01");
  serveReceipts = true;
  _resetCache();
  assert.equal(r.status, 200);
  assert.ok(r.body.results.every((x) => x.pass_rate === null && x.stale === true));
});

// ------------------------------------------------------------------ quota and x402
const PAY_TO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const meteredEnv = (o = {}) => mkEnv({ quota: fakeQuotaNamespace(o) });
const LQ = "/v1/lookup?task=web-search&max_price=0.01";
const v2Payment = (over = {}) => b64({
  x402Version: 2,
  resource: { url: "https://lookup.test" + LQ },
  accepted: { scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over },
  payload: { signature: "0x" + "ee".repeat(65), authorization: { from: "0x" + "11".repeat(20), to: PAY_TO, value: over.amount || "20000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "22".repeat(32) } },
});

test("quota: 5 free lookups per client per UTC day, then 402; other clients and other days are separate", async () => {
  const e = meteredEnv();
  for (let i = 1; i <= 5; i++) {
    const r = await call(LQ + "&client=agent-a", { envo: e });
    assert.equal(r.status, 200, "call " + i);
    assert.equal(r.body.access.tier, "free");
    assert.equal(r.body.access.free_used_today, i);
    assert.equal(r.body.access.free_remaining_today, 5 - i);
  }
  const r6 = await call(LQ + "&client=agent-a", { envo: e });
  assert.equal(r6.status, 402);
  assert.equal((await call(LQ + "&client=agent-b", { envo: e })).status, 200, "a different client has its own quota");
  // bad parameters never use the quota
  assert.equal((await call("/v1/lookup?task=web-search&max_price=abc&client=agent-c", { envo: e })).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await call(LQ + "&client=agent-c", { envo: e })).status, 200);
  // the counter resets on the next UTC day
  const ns = fakeQuotaNamespace();
  const env2 = { QUOTA: ns };
  const d1 = new Date(Date.UTC(2026, 9, 3, 23, 59)), d2 = new Date(Date.UTC(2026, 9, 4, 0, 1));
  for (let i = 0; i < 5; i++) assert.equal((await takeFree(env2, "c:x", 5, d1)).free, true);
  assert.equal((await takeFree(env2, "c:x", 5, d1)).free, false);
  assert.deepEqual(await takeFree(env2, "c:x", 5, d2), { free: true, used: 1, limit: 5 });
  // points: free calls are qualifying and record access=free; the 402 is not qualifying
  const freeP = e.points.find((p) => p.blobs[0] === "c:agent-a" && p.blobs[12] === "free");
  assert.equal(freeP.doubles[0], 1);
  const p402 = e.points.filter((p) => p.blobs[0] === "c:agent-a").pop();
  assert.deepEqual([p402.blobs[12], p402.blobs[5], p402.doubles[0], p402.doubles[2]], ["payment-required", "payment-required", 0, 402]);
});

test("quota without a client value: keyed by a salted hash of the IP (not the User-Agent); raw IP never stored", async () => {
  const ns = fakeQuotaNamespace();
  const e = mkEnv({ quota: ns });
  for (let i = 0; i < 5; i++) assert.equal((await call(LQ, { envo: e, ip: "198.51.100.23", ua: "ua-" + i })).status, 200);
  assert.equal((await call(LQ, { envo: e, ip: "198.51.100.23", ua: "another-ua" })).status, 402, "changing the UA does not reset the quota");
  assert.equal((await call(LQ, { envo: e, ip: "198.51.100.24" })).status, 200, "another IP has its own quota");
  assert.ok(ns.names.every((n) => /^ip:[0-9a-f]{24}$/.test(n)), ns.names.join(","));
  assert.ok(!JSON.stringify(ns.names).includes("198.51.100"));
  const req = new Request("https://x.test/", { headers: { "cf-connecting-ip": "203.0.113.9" } });
  assert.equal(await quotaKey(req, { client: "bob" }, {}), "c:bob");
});

test("402 shape: x402 v2 PAYMENT-REQUIRED header and body, $0.02 USDC on Base to our wallet, payment policy stated", async () => {
  const e = meteredEnv();
  for (let i = 0; i < 5; i++) await call(LQ + "&client=shape", { envo: e });
  const r = await call(LQ + "&client=shape", { envo: e });
  assert.equal(r.status, 402);
  const hdr = unb64(r.headers.get("payment-required"));
  assert.deepEqual(hdr, r.body, "header and body carry the same requirement");
  assert.equal(hdr.x402Version, 2);
  assert.match(hdr.error, /Free lookups used up/);
  assert.equal(hdr.resource.url, "https://lookup.test" + LQ + "&client=shape");
  assert.equal(hdr.resource.mimeType, "application/json");
  assert.deepEqual(hdr.accepts, [{ scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }]);
  assert.equal(hdr.price_usd, "0.02");
  assert.equal(hdr.free_per_day, 5);
  assert.equal(hdr.free_used_today, 5);
  assert.equal(hdr.payment_policy, PAYMENT_POLICY);
  assert.match(PAYMENT_POLICY, /never changes results, sort order, listings/);
  assert.ok(!("results" in r.body), "a 402 carries no results");
  assert.ok(r.body.try_free_lookup.url.includes("ref=via-402-hint"));
  assert.match(r.body.also_available.url, /\/v1\/products\/overnight-cos-pack$/);
  assert.match(r.body.also_available_spot_check.url, /\/v1\/products\/endpoint-spot-check/);
  assert.equal(r.body.also_available_spot_check.price_usdc, "0.01-0.25");
  assert.match(r.headers.get("access-control-expose-headers"), /PAYMENT-REQUIRED/);
  // OpenAPI and the help page document the 402 and the policy
  const oa = (await call("/openapi.json", { envo: e })).body;
  assert.match(oa.paths["/v1/lookup"].get.responses["402"].description, /0\.02 USDC on Base/);
  assert.match(oa.info.description, /never changes results, sort order/);
  const help = (await call("/", { envo: e })).body;
  assert.equal(help.pricing.free_per_day, 5);
  assert.equal(help.payment_policy, PAYMENT_POLICY);
  const pre = await worker.fetch(new Request("https://lookup.test/v1/lookup", { method: "OPTIONS" }), e.env, {});
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers"), /PAYMENT-SIGNATURE/);
});

test("self clients are exempt by client value only; a self User-Agent alone is metered", async () => {
  const e = meteredEnv();
  for (const cl of ["withgrokbot", "withgrokbot-selftest", "sam-selftest"])
    for (let i = 0; i < 7; i++) {
      const r = await call(LQ + "&client=" + cl, { envo: e });
      assert.equal(r.status, 200);
      assert.equal(r.body.access.tier, "exempt");
    }
  assert.ok(e.points.every((p) => p.blobs[12] === "exempt" && p.blobs[5] === "self"));
  for (let i = 0; i < 5; i++) await call(LQ, { envo: e, ua: "WithGrokBot-test/1" });
  assert.equal((await call(LQ, { envo: e, ua: "WithGrokBot-test/1" })).status, 402);
});

test("paid lookup: verify + settle through the facilitator, identical results, PAYMENT-RESPONSE, logged with amount, tx and ref", async () => {
  const e = meteredEnv();
  facCalls.length = 0;
  facMode = "ok";
  const free = await call(LQ + "&client=payer1&ref=via-readme", { envo: e });
  for (let i = 0; i < 4; i++) await call(LQ + "&client=payer1&ref=via-readme", { envo: e });
  assert.equal(facCalls.length, 0);
  const r = await call(LQ + "&client=payer1&ref=via-readme", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, free.body.results, "payment never changes results or sort order");
  assert.deepEqual(r.body.facts_only, free.body.facts_only, "payment never changes listings");
  assert.equal(r.body.matched, free.body.matched);
  assert.deepEqual(r.body.access, { tier: "paid", charged_usd: "0.02", asset: "USDC on Base", tx: TX, basescan_url: "https://basescan.org/tx/" + TX, payer: "0x" + "11".repeat(20) });
  assert.equal(r.body.payment_policy, PAYMENT_POLICY);
  assert.deepEqual(unb64(r.headers.get("payment-response")), { success: true, transaction: TX, network: "eip155:8453", payer: "0x" + "11".repeat(20) });
  assert.deepEqual(facCalls.map((x) => x[0]), ["/verify", "/settle"]);
  const req = facCalls[0][1];
  assert.equal(req.x402Version, 2);
  assert.deepEqual(req.paymentRequirements, { scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } });
  const p = e.points.pop();
  assert.deepEqual([p.blobs[12], p.blobs[13], p.blobs[14], p.blobs[10], p.doubles[4], p.doubles[2]], ["paid", TX, "0x" + "11".repeat(20), "via-readme", 0.02, 200]);
  assert.equal(p.doubles[0], 1, "an outside paid lookup is qualifying");
  // X-PAYMENT carrying a v2 payload is accepted too
  const r2 = await call(LQ + "&client=payer1", { envo: e, headers: { "x-payment": v2Payment() } });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.access.tier, "paid");
});

test("payment rejected: wrong amount or payTo (facilitator not called), invalid, settle failure, garbage header", async () => {
  const e = meteredEnv();
  for (let i = 0; i < 5; i++) await call(LQ + "&client=rej", { envo: e });
  facCalls.length = 0;
  facMode = "ok";
  let r = await call(LQ + "&client=rej", { envo: e, headers: { "payment-signature": v2Payment({ amount: "10000" }) } });
  assert.equal(r.status, 402);
  assert.match(r.body.error, /amount does not match/);
  r = await call(LQ + "&client=rej", { envo: e, headers: { "payment-signature": v2Payment({ payTo: "0x" + "33".repeat(20) }) } });
  assert.match(r.body.error, /payTo does not match/);
  r = await call(LQ + "&client=rej", { envo: e, headers: { "payment-signature": v2Payment({ network: "eip155:84532" }) } });
  assert.match(r.body.error, /scheme or network/);
  assert.equal(facCalls.length, 0);
  r = await call(LQ + "&client=rej", { envo: e, headers: { "payment-signature": "not base64 json" } });
  assert.equal(r.status, 402);
  facMode = "invalid";
  r = await call(LQ + "&client=rej", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(r.status, 402);
  assert.match(r.body.error, /insufficient_funds/);
  assert.deepEqual(facCalls.map((x) => x[0]), ["/verify"], "no settle after a failed verify");
  facMode = "settle-fail";
  r = await call(LQ + "&client=rej", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(r.status, 402);
  assert.match(r.body.error, /settlement failed: transaction_failed/);
  assert.ok(r.headers.get("payment-required"));
  facMode = "ok";
  const p = e.points.pop();
  assert.deepEqual([p.blobs[12], p.doubles[0], p.doubles[4]], ["payment-failed", 0, 0]);
});

test("free calls left: a payment header is ignored (nothing settled); counter outage fails open", async () => {
  const e = meteredEnv();
  facCalls.length = 0;
  const r = await call(LQ + "&client=early", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(r.status, 200);
  assert.equal(r.body.access.tier, "free");
  assert.equal(facCalls.length, 0);
  const broken = mkEnv({ quota: fakeQuotaNamespace({ broken: true }) });
  for (let i = 0; i < 7; i++) assert.equal((await call(LQ + "&client=x", { envo: broken })).status, 200);
});

// ---------------------------------------------------------------- 0.4.0: always-paid path with Bazaar metadata
const PQ = "/v1/lookup/paid?task=web-search&max_price=0.01";
async function send(path, { method = "GET", body, headers = {}, envo, ua = "agent-x/1.0", ip = "203.0.113.7" } = {}) {
  const e = envo || meteredEnv();
  const req = new Request("https://lookup.test" + path, { method, body, headers: { "user-agent": ua, "cf-connecting-ip": ip, ...headers } });
  const res = await worker.fetch(req, e.env, { waitUntil() {} });
  const txt = await res.text();
  return { status: res.status, body: txt ? JSON.parse(txt) : null, headers: res.headers, points: e.points };
}

test("paid path: every unpaid call (no params, GET or POST, first call of the day) gets a 402 with Bazaar discovery metadata", async () => {
  const e = meteredEnv();
  for (const [path, method] of [["/v1/lookup/paid", "GET"], ["/v1/lookup/paid", "POST"], [PQ, "GET"], ["/v1/lookup/paid/", "GET"]]) {
    const r = await send(path, { method, envo: e });
    assert.equal(r.status, 402, path + " " + method);
    assert.deepEqual(unb64(r.headers.get("payment-required")), r.body);
  }
  const b = (await send(PQ, { envo: e })).body;
  assert.equal(b.x402Version, 2);
  assert.equal(b.resource.url, "https://lookup.test/v1/lookup/paid", "resource is the path without the query");
  assert.equal(b.resource.serviceName, "Verified Catalog Lookup");
  assert.ok(b.resource.serviceName.length <= 32 && b.resource.tags.length <= 5);
  assert.deepEqual(b.accepts, [{ scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }]);
  const bz = b.extensions.bazaar;
  assert.deepEqual(bz.info.input, { type: "http", method: "GET", queryParams: { task: "web-search", max_price: "0.01", n: "5" } });
  assert.equal(bz.info.output.type, "json");
  assert.equal(bz.schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(bz.schema.required, ["input"]);
  assert.equal(bz.schema.properties.input.properties.type.const, "http");
  assert.deepEqual(bz.schema.properties.input.required, ["type", "method"]);
  // info validates against its schema (input keys allowed, queryParams keys declared, no external refs)
  const ip = bz.schema.properties.input;
  assert.ok(Object.keys(bz.info.input).every((k) => k in ip.properties));
  assert.ok(Object.keys(bz.info.input.queryParams).every((k) => k in ip.properties.queryParams.properties));
  assert.ok(!JSON.stringify(bz.schema).includes('"$ref"'));
  assert.equal(b.payment_policy, PAYMENT_POLICY);
  assert.ok(b.try_free_lookup.url.includes("ref=via-402-hint"), "402 try_free_lookup must carry via-402-hint");
  assert.equal(b.try_free_lookup.ref, "via-402-hint");
  assert.match(b.also_available.url, /\/v1\/products\/overnight-cos-pack$/);
  assert.equal(b.also_available.product, "overnight-cos-pack");
  assert.equal(b.also_available.price_usdc, 9);
  assert.ok(!("results" in b));
  assert.ok(e.points.every((p) => p.blobs[12] === "payment-required" && p.doubles[2] === 402 && p.doubles[0] === 0));
  // discovery documents
  const wk = (await send("/.well-known/x402", { envo: e })).body;
  assert.deepEqual(wk.resources, ["https://api.402xagent.com/v1/lookup/paid", "https://api.402xagent.com/v1/products/overnight-cos-pack", "https://api.402xagent.com/v1/products/endpoint-spot-check"]);
  assert.equal(wk.version, 1);
  // 0.18.0: service-wide payment block + per-resource accepts so indexes learn the network without a settled payment
  assert.deepEqual(wk.payment.x402.networks, ["eip155:8453"]);
  assert.equal(wk.payment.x402.payTo, PAY_TO);
  assert.equal(wk.payment.x402.asset, USDC);
  assert.deepEqual(wk.resourceCatalog.map((r) => r.url), wk.resources);
  for (const r of wk.resourceCatalog) assert.deepEqual([r.accepts[0].network, r.accepts[0].asset, r.accepts[0].payTo], ["eip155:8453", USDC, PAY_TO]);
  assert.equal(wk.resourceCatalog[0].accepts[0].amount, "20000");
  const oa = (await send("/openapi.json", { envo: e })).body;
  const op = oa.paths["/v1/lookup/paid"].get;
  assert.deepEqual(op["x-payment-info"].protocols, [{ x402: { scheme: "exact", network: "eip155:8453", asset: USDC, payTo: PAY_TO } }]);
  assert.deepEqual(oa.paths["/v1/lookup"].get.security, [], "free-first routes are explicitly public");
  assert.deepEqual(op["x-payment-info"].price, { mode: "fixed", currency: "USD", amount: "0.02" });
  assert.ok(op.responses["402"]);
  assert.ok(oa.paths["/mcp"].post);
  assert.ok(!("x-payment-info" in oa.paths["/v1/lookup"].get), "/v1/lookup is free first, so it is not declared paid");
});

test("paid path: paid call returns the identical lookup result; bad params with a payment get a 400 and nothing is settled", async () => {
  const e = meteredEnv();
  facCalls.length = 0;
  facMode = "ok";
  const free = await send(LQ + "&client=pp", { envo: e });
  assert.equal(free.status, 200);
  const r = await send(PQ + "&client=pp&ref=via-x402scan", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, free.body.results, "payment never changes results");
  assert.deepEqual(r.body.facts_only, free.body.facts_only);
  assert.equal(r.body.matched, free.body.matched);
  assert.deepEqual(r.body.query, free.body.query);
  assert.equal(r.body.access.tier, "paid");
  assert.equal(r.body.access.tx, TX);
  assert.equal(unb64(r.headers.get("payment-response")).transaction, TX);
  assert.deepEqual(facCalls.map((x) => x[0]), ["/verify", "/settle"]);
  assert.equal(facCalls[0][1].paymentRequirements.amount, "20000");
  const p = e.points.pop();
  assert.deepEqual([p.blobs[12], p.blobs[13], p.blobs[10], p.doubles[4], p.doubles[2], p.doubles[0]], ["paid", TX, "via-x402scan", 0.02, 200, 1]);
  // the free quota is untouched by the paid path (1 used above)
  const f2 = await send(LQ + "&client=pp", { envo: e });
  assert.equal(f2.body.access.free_used_today, 2);
  facCalls.length = 0;
  let bad = await send("/v1/lookup/paid", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /task or endpoint is required.*nothing was charged/);
  assert.ok(bad.body.try_free_lookup.url.includes("ref=via-402-hint"));
  assert.match(bad.body.also_available.url, /\/v1\/products\/overnight-cos-pack$/);
  bad = await send("/v1/lookup/paid?task=web-search&max_price=abc", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(bad.status, 400);
  assert.equal(facCalls.length, 0, "no verify or settle for bad parameters");
  const wrong = await send(PQ, { envo: e, headers: { "payment-signature": v2Payment({ amount: "10000" }) } });
  assert.equal(wrong.status, 402);
  assert.match(wrong.body.error, /amount does not match/);
  assert.ok(wrong.body.extensions.bazaar);
  facMode = "invalid";
  const inv = await send(PQ, { envo: e, headers: { "x-payment": v2Payment() } });
  assert.equal(inv.status, 402);
  assert.match(inv.body.error, /insufficient_funds/);
  facMode = "ok";
});

// ---------------------------------------------------------------- 0.4.0: remote MCP at /mcp
const rpc = (m, o = {}) => send("/mcp", { method: "POST", body: JSON.stringify(m), headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, ...o });

test("MCP /mcp: initialize, tools/list (catalog tools + products), ping, notifications, errors", async () => {
  const e = meteredEnv();
  let r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { envo: e });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /application\/json/);
  assert.deepEqual(r.body, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "402xagent", title: "402xAgent + verified x402 catalog", version: VERSION } } });
  assert.equal(r.headers.get("mcp-session-id"), null, "stateless: no session");
  r = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { envo: e });
  assert.equal(r.status, 202);
  assert.equal(r.body, null);
  r = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { envo: e });
  const py = spawnSync("python3", [MCP_PY, "--catalog", CAT_FILE], { input: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n", env: { ...process.env, VC_LOOKUP_URL: "off" }, encoding: "utf8" });
  const pyTools = JSON.parse(py.stdout).result.tools;
  const workerTools = r.body.result.tools;
  assert.deepEqual(workerTools.slice(0, 3), pyTools, "first 3 tools match mcp/server.py");
  assert.deepEqual(workerTools.map((t) => t.name), ["search_catalog", "get_service", "lookup", "get_overnight_cos_pack", "get_receipt", "endpoint_spot_check"]);
  assert.deepEqual((await rpc({ jsonrpc: "2.0", id: 3, method: "ping" }, { envo: e })).body, { jsonrpc: "2.0", id: 3, result: {} });
  assert.equal((await rpc({ jsonrpc: "2.0", id: 4, method: "nope" }, { envo: e })).body.error.code, -32601);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } }, { envo: e })).body.error.message, "unknown tool 'nope'");
  r = await send("/mcp", { method: "POST", body: "{not json", envo: e });
  assert.equal(r.body.error.code, -32700);
  assert.equal((await send("/mcp", { envo: e })).status, 405, "GET: no SSE stream on a stateless server");
  const batch = await rpc([{ jsonrpc: "2.0", id: 6, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }], { envo: e });
  assert.deepEqual(batch.body, [{ jsonrpc: "2.0", id: 6, result: {} }]);
  const pre = await worker.fetch(new Request("https://lookup.test/mcp", { method: "OPTIONS" }), e.env, {});
  assert.match(pre.headers.get("access-control-allow-methods"), /POST/);
});

test("MCP /mcp tools/call: search_catalog and get_service give results identical to mcp/server.py", async () => {
  const e = meteredEnv();
  const cases = [
    ["search_catalog", {}],
    ["search_catalog", { query: "synthetic", max_price_usd: 0.005, limit: 2 }],
    ["search_catalog", { category: "weather", reachable_only: true }],
    ["search_catalog", { max_price_usd: "abc" }],
    ["get_service", { id: "beta" }],
    ["get_service", { id: "missing" }],
  ];
  const msgs = cases.map(([name, args], i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } }));
  const py = spawnSync("python3", [MCP_PY, "--catalog", CAT_FILE], { input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", env: { ...process.env, VC_LOOKUP_URL: "off" }, encoding: "utf8" });
  const pyOut = py.stdout.trim().split("\n").map((l) => JSON.parse(l));
  for (let i = 0; i < msgs.length; i++) {
    const r = await rpc(msgs[i], { envo: e });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, pyOut[i], "identical to mcp/server.py for " + JSON.stringify(cases[i]));
  }
  assert.equal(pyOut[1].result.structuredContent.count, 2);
  assert.equal(pyOut[3].result.isError, true);
  assert.equal(pyOut[5].result.isError, true);
});

test("MCP /mcp lookup: same /v1/lookup result, client=vc-mcp with its 5 free calls, then the 402 is reported (never paid)", async () => {
  const e = meteredEnv();
  facCalls.length = 0;
  const direct = await send(LQ + "&n=3&client=withgrokbot", { envo: e });
  const call1 = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lookup", arguments: { task: "web-search", max_price_usd: 0.01, n: 3 } } };
  for (let i = 1; i <= 5; i++) {
    const r = await rpc(call1, { envo: e });
    const sc = r.body.result.structuredContent;
    assert.deepEqual(sc.results, direct.body.results, "identical results");
    assert.deepEqual(sc.facts_only, direct.body.facts_only);
    assert.deepEqual(sc.access, { tier: "free", free_per_day: 5, free_used_today: i, free_remaining_today: 5 - i, then: "$0.02 USDC on Base per lookup via x402 (HTTP 402)" });
    assert.deepEqual(JSON.parse(r.body.result.content[0].text), sc);
  }
  const p = e.points[e.points.length - 1];
  assert.equal(p.blobs[0], "c:vc-mcp");
  const r6 = await rpc(call1, { envo: e });
  assert.equal(r6.body.result.isError, true);
  assert.match(r6.body.result.content[0].text, /^lookup returned HTTP 402: Free lookups used up for today.*payment never changes results\.$/);
  assert.equal(facCalls.length, 0);
  const none = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lookup", arguments: {} } }, { envo: e });
  assert.equal(none.body.result.content[0].text, "give a task (e.g. web-search) or an endpoint (service id or URL)");
  // the remote MCP lookup and the stdio server share one quota key: client=vc-mcp
  assert.ok(e.env.QUOTA.names.filter((n) => n === "c:vc-mcp").length >= 6);
});


// ---------------------------------------------------------------- 0.5.0: Overnight CoS Setup Pack ($9, always paid)
const PACK = "/v1/products/overnight-cos-pack";
const packPayment = (over = {}) => b64({
  x402Version: 2,
  resource: { url: "https://lookup.test" + PACK },
  accepted: { scheme: "exact", network: "eip155:8453", amount: "9000000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over },
  payload: { signature: "0x" + "ee".repeat(65), authorization: { from: "0x" + "11".repeat(20), to: PAY_TO, value: over.amount || "9000000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "22".repeat(32) } },
});
function packEnv(extra = {}) {
  const e = meteredEnv();
  e.env.PACK_PRICE_ATOMIC = "9000000";
  e.env.PACK_BLOBS = {
    get: async (key, type) => {
      if (key !== "overnight-cos-pack/guide.pdf") return null;
      const bytes = new TextEncoder().encode("%PDF-1.4 fake-guide");
      return type === "arrayBuffer" ? bytes.buffer : bytes;
    },
  };
  Object.assign(e.env, extra);
  return e;
}

test("overnight-cos-pack: unpaid GET/POST return 402 with amount 9000000, payTo, bazaar extension", async () => {
  const e = packEnv();
  for (const [path, method] of [[PACK, "GET"], [PACK, "POST"], [PACK + "/", "GET"]]) {
    const r = await send(path, { method, envo: e });
    assert.equal(r.status, 402, path + " " + method);
    assert.deepEqual(unb64(r.headers.get("payment-required")), r.body);
  }
  const b = (await send(PACK, { envo: e })).body;
  assert.equal(b.x402Version, 2);
  assert.equal(b.resource.url, "https://lookup.test" + PACK);
  assert.equal(b.resource.serviceName, "Overnight CoS Setup Pack");
  assert.ok(b.resource.serviceName.length <= 32);
  assert.equal(b.resource.tags.length, 5);
  assert.deepEqual(b.accepts, [{ scheme: "exact", network: "eip155:8453", amount: "9000000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }]);
  assert.equal(b.price_usd, "9");
  assert.equal(b.product, "overnight-cos-pack");
  assert.ok(b.extensions.bazaar);
  assert.equal(b.extensions.bazaar.info.input.type, "http");
  assert.equal(b.extensions.bazaar.info.output.type, "json");
  assert.ok(b.extensions.bazaar.info.output.example.files.guide);
  // SELF_CLIENTS do not get the pack free
  const self = await send(PACK + "?client=withgrokbot", { envo: e });
  assert.equal(self.status, 402);
  // discovery docs
  const wk = (await send("/.well-known/x402", { envo: e })).body;
  assert.ok(wk.resources.includes("https://api.402xagent.com" + PACK), "discovery lists the canonical API host");
  const oa = (await send("/openapi.json", { envo: e })).body;
  assert.equal(oa.info.version, VERSION);
  const op = oa.paths[PACK].get;
  assert.deepEqual(op["x-payment-info"].price, { mode: "fixed", currency: "USD", amount: "9" });
  assert.equal(op["x-payment-info"].protocols[0].x402.payTo, PAY_TO);
  assert.ok(oa.paths[PACK].post);
  const health = (await send("/health", { envo: e })).body;
  assert.equal(health.version, VERSION);
});

test("overnight-cos-pack: paid path with mocked facilitator returns prompts+template+guide; wrong amount rejected", async () => {
  const e = packEnv();
  facCalls.length = 0;
  facMode = "ok";
  const wrong = await send(PACK, { envo: e, headers: { "payment-signature": packPayment({ amount: "20000" }) } });
  assert.equal(wrong.status, 402);
  assert.match(wrong.body.error, /amount does not match/);
  assert.equal(facCalls.length, 0);
  const r = await send(PACK, { envo: e, headers: { "payment-signature": packPayment() } });
  assert.equal(r.status, 200);
  assert.equal(r.body.product, "overnight-cos-pack");
  assert.equal(r.body.title, "Overnight Chief of Staff: Multi-Bot Setup Pack");
  assert.equal(r.body.price_usdc, 9);
  assert.ok(r.body.files.prompts["00_overnight_cos_combiner.txt"].length > 100);
  assert.ok(r.body.files.prompts["01_inbox_bot.txt"]);
  assert.ok(r.body.files.templates["morning_briefing_template.html"].includes("html"));
  assert.equal(r.body.files.guide.filename, "Overnight_Chief_of_Staff_Setup_Guide.pdf");
  assert.equal(r.body.files.guide.encoding, "base64");
  assert.ok(r.body.files.guide.data.length > 10);
  assert.equal(r.body.access.tier, "paid");
  assert.equal(r.body.access.charged_usd, "9");
  assert.equal(r.body.access.tx, TX);
  assert.equal(unb64(r.headers.get("payment-response")).transaction, TX);
  assert.deepEqual(facCalls.map((x) => x[0]), ["/verify", "/settle"]);
  assert.equal(facCalls[0][1].paymentRequirements.amount, "9000000");
  // dry structure check without settling: PACK_PREVIEW stub
  const preview = packEnv({ PACK_PREVIEW: "1" });
  const stub = await send(PACK, { envo: preview });
  assert.equal(stub.status, 200);
  assert.equal(stub.body.access.tier, "preview");
  assert.ok(stub.body.files.prompts["00_overnight_cos_combiner.txt"]);
});

test("MCP get_overnight_cos_pack: unpaid returns payment instructions; paid header forwards to product handler", async () => {
  const e = packEnv();
  facCalls.length = 0;
  facMode = "ok";
  const unpaid = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_overnight_cos_pack", arguments: {} } }, { envo: e });
  assert.equal(unpaid.body.result.isError, true);
  assert.match(unpaid.body.result.content[0].text, /Payment required: \$9 USDC/);
  assert.match(unpaid.body.result.content[0].text, /overnight-cos-pack/);
  assert.match(unpaid.body.result.content[0].text, /9000000/);
  const paid = await send("/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_overnight_cos_pack", arguments: {} } }),
    headers: { "content-type": "application/json", "payment-signature": packPayment() },
    envo: e,
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.result.isError, undefined);
  const sc = paid.body.result.structuredContent;
  assert.equal(sc.product, "overnight-cos-pack");
  assert.ok(sc.files.prompts["04_cos_writer_bot.txt"]);
  assert.equal(sc.access.tier, "paid");
});


// ---------------------------------------------------------------- 0.6.0: Endpoint Spot-Check ($0.25, 1 free/day)
const SPOT = "/v1/products/endpoint-spot-check";
const spotPayment = (over = {}) => b64({
  x402Version: 2,
  resource: { url: "https://lookup.test" + SPOT },
  accepted: { scheme: "exact", network: "eip155:8453", amount: "250000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over },
  payload: { signature: "0x" + "ee".repeat(65), authorization: { from: "0x" + "11".repeat(20), to: PAY_TO, value: over.amount || "250000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "22".repeat(32) } },
});
function spotEnv(extra = {}) {
  const e = meteredEnv();
  e.env.SPOT_PRICE_ATOMIC = "250000";
  e.env.SPOT_FREE_PER_DAY = "1";
  e.env.SPOT_PAID_PER_HOUR = "30";
  Object.assign(e.env, extra);
  return e;
}

test("spot-check SSRF: localhost, 127.0.0.1, 169.254.169.254, 10.x → 400 skip/ssrf_blocked, no outbound fetch", async () => {
  const e = spotEnv();
  lastSpotFetchInit = null;
  const blocked = [
    "http://localhost/admin",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/secret",
    "http://192.168.1.1/",
    "http://[::1]/",
  ];
  for (const u of blocked) {
    const r = await send(SPOT + "?url=" + encodeURIComponent(u) + "&client=ssrf-a", { envo: e });
    assert.equal(r.status, 400, u);
    assert.equal(r.body.verdict, "skip", u);
    assert.equal(r.body.reason, "ssrf_blocked", u);
    assert.equal(r.body.quoted_price_usd, null, u);
    assert.ok(!("ssrf_blocked" in r.body) || r.body.ssrf_blocked === undefined, "slim body only");
  }
  assert.equal(lastSpotFetchInit, null, "must not fetch blocked targets");
});

test("spot-check free path: first call/day succeeds without payment (mock outbound 402)", async () => {
  const e = spotEnv();
  spotTargetMode = "402";
  lastSpotFetchInit = null;
  const r = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=0.001&client=spot-free-1", { envo: e });
  assert.equal(r.status, 200);
  assert.equal(r.body.access.tier, "free");
  assert.equal(r.body.verdict, "pay");
  assert.equal(r.body.reason, "listed $0.001, payment request matches, details locked");
  // free tier: verdict + plain reason + access only (quoted/claimed price, pay_to, network, asset are paid)
  assert.deepEqual(Object.keys(r.body).sort(), ["access", "payment_terms_sha256", "reason", "receipt_id", "receipt_url", "verdict"]);
  assert.match(r.body.payment_terms_sha256, /^[0-9a-f]{64}$/);
  assert.ok(lastSpotFetchInit);
  const h = lastSpotFetchInit.headers || {};
  const hdrObj = h instanceof Headers ? Object.fromEntries(h.entries()) : h;
  const keys = Object.keys(hdrObj).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("payment-signature") && !keys.includes("x-payment"), "never send payment headers outbound");
  // second call same day → 402 priced at 1/10 of the $0.001 quote, floored at $0.01
  const r2 = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=spot-free-1", { envo: e });
  assert.equal(r2.status, 402);
  assert.equal(r2.body.accepts[0].amount, "10000");
  assert.equal(r2.body.price_usd, "0.01");
  assert.equal(r2.body.product, "endpoint-spot-check");
});

test("spot-check unpaid after free exhausted → 402 amount 10000 (1/10 of quote, min $0.01); paid path works; never pays target", async () => {
  const e = spotEnv();
  facCalls.length = 0;
  facMode = "ok";
  spotTargetMode = "402";
  await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=spot-pay-1", { envo: e });
  const unpaid = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=spot-pay-1", { envo: e });
  assert.equal(unpaid.status, 402);
  assert.equal(unpaid.body.accepts[0].amount, "10000");
  lastSpotFetchInit = null;
  const paid = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=spot-pay-1", {
    envo: e,
    headers: { "payment-signature": spotPayment({ amount: "10000" }) },
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.access.tier, "paid");
  assert.equal(paid.body.access.charged_usd, "0.01");
  assert.equal(paid.body.pay_to, PAY_TO);
  assert.equal(paid.body.network, "eip155:8453");
  assert.equal(paid.body.asset, USDC);
  assert.equal(paid.body.verdict, "pay");
  assert.equal(paid.body.reason, "price_ok");
  assert.equal(paid.body.quoted_price_usd, 0.001);
  assert.equal(paid.body.claimed_price_usd, null);
  assert.deepEqual(facCalls.map((x) => x[0]), ["/verify", "/settle"]);
  const h = lastSpotFetchInit.headers || {};
  const hdrObj = h instanceof Headers ? Object.fromEntries(h.entries()) : h;
  assert.ok(!Object.keys(hdrObj).some((k) => /payment/i.test(k)), "outbound must not carry payment headers");
});

test("spot-check timeout and oversized body handled safely", async () => {
  const e = spotEnv();
  spotTargetMode = "timeout";
  const t = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/slow") + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(t.status, 200);
  assert.equal(t.body.access.tier, "exempt");
  assert.equal(t.body.verdict, "recheck"); // transient (0.14.0)
  assert.equal(t.body.reason, "timeout");
  assert.equal(t.body.quoted_price_usd, null);
  spotTargetMode = "huge";
  const h = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/huge") + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(h.status, 200);
  assert.equal(h.body.verdict, "skip"); // 200 with no terms, no trial headers (0.14.0)
  assert.equal(h.body.reason, "no_paywall");
  spotTargetMode = "402";
});

test("no 402 terms is skip/no_paywall; trial headers are recheck/free_trial_active (+remaining) (0.14.0)", async () => {
  const e = spotEnv();
  const go = (path, q = "") => send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test" + path) + "&client=withgrokbot-selftest" + q, { envo: e });
  spotTargetMode = "ok200";
  let r = await go("/a", "&claimed_price=0.01");
  assert.deepEqual([r.body.verdict, r.body.reason, r.body.payment, r.body.payment_terms_sha256], ["skip", "no_paywall", null, null]);
  assert.ok(!("free_trial_remaining" in r.body));
  spotTargetMode = "trial";
  r = await go("/b");
  assert.deepEqual([r.body.verdict, r.body.reason, r.body.free_trial_remaining, r.body.payment], ["recheck", "free_trial_active", 3, null]);
  spotTargetMode = "trialflag";
  r = await go("/c");
  assert.deepEqual([r.body.verdict, r.body.reason, r.body.free_trial_remaining], ["recheck", "free_trial_active", null]);
  spotTargetMode = "notfound";
  r = await go("/d");
  assert.deepEqual([r.body.verdict, r.body.reason], ["skip", "no_paywall"]);
  // free tier words + the remaining count
  spotTargetMode = "trial";
  const f = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/e") + "&claimed_price=0.05&client=trial-free-1", { envo: e });
  assert.equal(f.body.verdict, "recheck");
  assert.equal(f.body.reason, "listed $0.05, seller reports a free trial in use, no payment terms yet, check again (3 trial calls left), details locked");
  spotTargetMode = "402";
});

test("verdict table (0.14.0): recheck only for transient + trial; trial recheck still skips on a listing mismatch", async () => {
  const { applyNoTermsListing } = await import("../worker/src/lib.js");
  const { decideVerdict, freeTrialSignal } = await import("../worker/src/spotcheck.js");
  const probe = { reachable: true, http_status: 200, x402_challenge: false, accepts: [], free_trial: null };
  assert.deepEqual(decideVerdict(probe, null), { verdict: "skip", reason: "no_paywall" });
  assert.deepEqual(decideVerdict({ ...probe, http_status: 503 }, null), { verdict: "recheck", reason: "server_error" });
  assert.deepEqual(decideVerdict({ ...probe, reachable: false, error: "fetch failed" }, null), { verdict: "recheck", reason: "unreachable" });
  assert.deepEqual(decideVerdict({ ...probe, reachable: false, error: "timeout after 5000ms" }, null), { verdict: "recheck", reason: "timeout" });
  assert.deepEqual(decideVerdict({ ...probe, http_status: 402, x402_challenge: true, known_answer: false }, null), { verdict: "skip", reason: "bad_challenge" });
  const d = decideVerdict({ ...probe, free_trial: { active: true, remaining: null } }, null);
  assert.deepEqual(d, { verdict: "recheck", reason: "free_trial_active" });
  const listing = { claimed_price_usd: 0.01, listed_pay_to: "0x" + "11".repeat(20), listed_network: "eip155:8453", pay_to: null, network: null, quoted_price_usd: null };
  const q0 = { claimed_price: null, pay_to: null, network: null };
  assert.deepEqual(applyNoTermsListing(d, probe, q0, null), d);
  assert.deepEqual(applyNoTermsListing(d, probe, q0, listing), d);
  assert.deepEqual(applyNoTermsListing(d, probe, { ...q0, claimed_price: 0.01 }, listing), d);
  assert.deepEqual(applyNoTermsListing(d, probe, { ...q0, claimed_price: 0.5 }, listing), { verdict: "skip", reason: "price_mismatch" });
  assert.deepEqual(applyNoTermsListing(d, probe, { ...q0, network: "eip155:84532" }, listing), { verdict: "skip", reason: "network_mismatch" });
  assert.deepEqual(applyNoTermsListing(d, probe, { ...q0, pay_to: "0x" + "22".repeat(20) }, listing), { verdict: "skip", reason: "pay_to_mismatch" });
  assert.deepEqual(applyNoTermsListing(d, probe, q0, { ...listing, pay_to: "0x" + "33".repeat(20) }), { verdict: "skip", reason: "pay_to_mismatch" });
  assert.deepEqual(applyNoTermsListing(d, probe, q0, { ...listing, quoted_price_usd: 0.2 }), { verdict: "skip", reason: "price_mismatch" });
  // a real skip or a pay is untouched
  assert.deepEqual(applyNoTermsListing({ verdict: "skip", reason: "no_paywall" }, probe, { ...q0, claimed_price: 9 }, listing), { verdict: "skip", reason: "no_paywall" });
  // header parsing
  const H = (o) => new Headers(o);
  assert.equal(freeTrialSignal(H({})), null);
  assert.deepEqual(freeTrialSignal(H({ "x-free-trial": "true", "x-free-trial-remaining": "0" })), { active: true, remaining: 0 });
  assert.deepEqual(freeTrialSignal(H({ "x-free-trial-remaining": "7" })), { active: true, remaining: 7 });
  assert.deepEqual(freeTrialSignal(H({ "x-free-trial": "false" })), { active: false, remaining: null });
  assert.deepEqual(decideVerdict({ ...probe, http_status: 404, free_trial: { active: true, remaining: 1 } }, null), { verdict: "recheck", reason: "free_trial_active" });
  assert.deepEqual(decideVerdict({ ...probe, free_trial: { active: false, remaining: null } }, null), { verdict: "skip", reason: "no_paywall" });
});

test("MCP endpoint_spot_check listed; unpaid after free returns pay instructions", async () => {
  const e = spotEnv();
  const listed = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { envo: e });
  const tool = listed.body.result.tools.find((t) => t.name === "endpoint_spot_check");
  assert.ok(tool);
  assert.match(tool.description, /verdict/);
  spotTargetMode = "402";
  const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "endpoint_spot_check", arguments: { url: "https://spot.target.test/api", claimed_price: 0.001 } } };
  const free = await rpc(call, { envo: e });
  assert.equal(free.body.result.isError, undefined);
  assert.equal(free.body.result.structuredContent.verdict, "pay");
  assert.match(free.body.result.structuredContent.reason, /details locked/);
  assert.equal(free.body.result.structuredContent.quoted_price_usd, undefined);
  const paidNeed = await rpc(call, { envo: e });
  assert.equal(paidNeed.body.result.isError, true);
  assert.match(paidNeed.body.result.content[0].text, /Payment required: \$0\.01 to \$0\.25 USDC/);
  const health = (await send("/health", { envo: e })).body;
  assert.equal(health.version, VERSION);
  const oa = (await send("/openapi.json", { envo: e })).body;
  assert.ok(oa.paths[SPOT]);
  assert.match(oa.paths[SPOT].get.responses[200].description, /verdict/);
});

test("spot-check price_mismatch → skip; no claimed → pay when challenge ok", async () => {
  const e = spotEnv();
  spotTargetMode = "402";
  const mismatch = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=9.99&client=withgrokbot-selftest", { envo: e });
  assert.equal(mismatch.status, 200);
  assert.equal(mismatch.body.verdict, "skip");
  assert.equal(mismatch.body.reason, "price_mismatch");
  assert.equal(mismatch.body.quoted_price_usd, 0.001);
  assert.equal(mismatch.body.claimed_price_usd, 9.99);
  const noclaim = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(noclaim.status, 200);
  assert.equal(noclaim.body.verdict, "pay");
  assert.equal(noclaim.body.reason, "price_ok");
  assert.equal(noclaim.body.claimed_price_usd, null);
});

test("spot-check aliases: endpoint= and claimed_price_usd= accepted (0.6.3); /v1/skips + /v1/receipts serve", async () => {
  const e = spotEnv();
  spotTargetMode = "402";
  const a = await send(SPOT + "?endpoint=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price_usd=9.99&client=withgrokbot-selftest", { envo: e });
  assert.equal(a.status, 200);
  assert.equal(a.body.verdict, "skip");
  assert.equal(a.body.claimed_price_usd, 9.99);
  const none = await send(SPOT + "?client=withgrokbot-selftest", { envo: e });
  assert.equal(none.status, 400);
  assert.deepEqual(Object.keys(none.body), ["error", "field", "example"]);
  assert.equal(none.body.field, "url");
  assert.ok(none.body.error.startsWith('Missing "url". Example: ') && !none.body.error.includes("\n"));
  const wrong = await send(SPOT + "?link=https://a.test/x", { envo: e });
  assert.equal(wrong.status, 400);
  assert.ok(wrong.body.error.includes('unknown param "link"'));
  const bad = await send(SPOT + "?url=notaurl", { envo: e });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, "url");
  assert.ok(bad.body.error.startsWith('Invalid "url"'));
  const badBody = await send(SPOT, { method: "POST", body: "nope", envo: e });
  assert.equal(badBody.status, 400);
  assert.equal(badBody.body.field, "body");
  const put = await send(SPOT, { method: "PUT", envo: e });
  assert.equal(put.status, 400);
  assert.equal(put.body.field, "method");
  const sk = await send("/v1/skips?format=json", { envo: e });
  assert.equal(sk.status, 200);
  assert.ok(sk.body.total_receipts > 0 && sk.body.skips.every((r) => r.verdict === "skip"));
  const one = await send("/v1/receipts/" + sk.body.featured_mismatch.split("/").pop(), { envo: e });
  assert.equal(one.status, 200);
  assert.equal(one.body.verdict, "skip");
});

test("spot-check Bazaar/402 examples match the real paid and free response shapes (0.6.4)", async () => {
  const e = spotEnv();
  spotTargetMode = "402";
  facMode = "ok";
  const target = "/v1/products/endpoint-spot-check?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=0.001&client=shape-1";
  const free = await send(target, { envo: e });
  const unpaid = await send(target, { envo: e });
  const paid = await send(target, { envo: e, headers: { "payment-signature": spotPayment({ amount: "10000" }) } });
  assert.equal(free.body.access.tier, "free");
  assert.equal(unpaid.status, 402);
  assert.equal(paid.body.access.tier, "paid");
  const bz = unpaid.body.extensions.bazaar;
  const keys = (o) => Object.keys(o).sort();
  assert.deepEqual(keys(bz.info.output.example), keys(paid.body), "bazaar example = real paid shape");
  assert.deepEqual(keys(bz.info.output.example.access).filter((k) => k in paid.body.access), keys(bz.info.output.example.access));
  assert.equal(bz.info.output.example.access.tier, "paid");
  assert.deepEqual(keys(bz.info.output.free_example), keys(free.body), "free example = real free shape");
  assert.ok(!("quoted_price_usd" in bz.info.output.free_example), "free example must not show quoted_price");
  assert.deepEqual(keys(unpaid.body.paid_example), keys(paid.body));
  assert.deepEqual(keys(unpaid.body.free_example), keys(free.body));
  for (const f of unpaid.body.paid_fields) assert.ok(f in paid.body && !(f in free.body), f);
  for (const k of bz.schema.properties.output.properties.example.required) assert.ok(k in paid.body, k);
  for (const k of bz.schema.properties.output.properties.free_example.required) assert.ok(k in free.body, k);
  const oa = (await send("/openapi.json", { envo: e })).body;
  const ex = oa.paths[SPOT].get.responses[200].content["application/json"].examples;
  assert.deepEqual(keys(ex.free.value), keys(free.body));
  assert.deepEqual(keys(ex.paid.value), keys(paid.body));
});

test("spot-check paid by our own wallet (payer = payTo) is recorded as self, not outside", async () => {
  const e = spotEnv();
  spotTargetMode = "402";
  facMode = "ok";
  const target = "/v1/products/endpoint-spot-check?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=selfpay-1";
  await send(target, { envo: e });
  facPayer = PAY_TO;
  try {
    const paid = await send(target, { envo: e, headers: { "payment-signature": spotPayment({ amount: "10000" }) } });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.access.self_test, true);
    const pt = e.points.filter((p) => p.blobs[12] === "paid").pop();
    assert.equal(pt.blobs[5], "self");
    assert.equal(pt.doubles[0], 0);
  } finally {
    facPayer = "0x" + "11".repeat(20);
  }
  const outside = await send(target.replace("selfpay-1", "selfpay-2"), { envo: e });
  const paid2 = await send(target.replace("selfpay-1", "selfpay-2"), { envo: e, headers: { "payment-signature": spotPayment({ amount: "10000" }) } });
  assert.equal(outside.status, 200);
  assert.equal(paid2.status, 200);
  assert.equal(paid2.body.access.self_test, undefined);
  assert.equal(e.points.filter((p) => p.blobs[12] === "paid").pop().blobs[5], "");
});

test("first-router pool: allowlisted client gets N free full checks (config-driven), then normal daily free + 402", async () => {
  const e = spotEnv({ SPOT_PARTNER_CLIENTS: "router-abc123:3, bad id:5, other.router:2" });
  spotTargetMode = "402";
  const t = SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=0.001&client=Router-ABC123";
  for (let i = 1; i <= 3; i++) {
    const r = await send(t, { envo: e });
    assert.equal(r.status, 200);
    assert.equal(r.body.access.tier, "partner");
    assert.equal(r.body.access.partner_free_total, 3);
    assert.equal(r.body.access.partner_used, i);
    assert.equal(r.body.access.partner_remaining, 3 - i);
    assert.equal(r.body.quoted_price_usd, 0.001, "partner checks are full checks");
    assert.equal(r.body.pay_to, PAY_TO);
    assert.equal(r.body.reason, "price_ok");
  }
  assert.equal(e.points.filter((p) => p.blobs[12] === "partner").length, 3);
  const daily = await send(t, { envo: e });
  assert.equal(daily.body.access.tier, "free", "pool used up: back to the normal 1 free/day");
  const after = await send(t, { envo: e });
  assert.equal(after.status, 402);
  // pools are per id; unlisted ids and malformed entries get nothing
  assert.equal((await send(t.replace("Router-ABC123", "other.router"), { envo: e })).body.access.tier, "partner");
  assert.equal((await send(t.replace("Router-ABC123", "router-abc124"), { envo: e })).body.access.tier, "free");
  const none = spotEnv();
  assert.equal((await send(t, { envo: none })).body.access.tier, "free", "no config, no pool");
});

test("spot-check method=POST probes the target with POST and an empty JSON body; bad method is a 400", async () => {
  const e = spotEnv();
  spotTargetMode = "402";
  lastSpotFetchInit = null;
  const r = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&method=post&client=withgrokbot-selftest", { envo: e });
  assert.equal(r.status, 200);
  assert.equal(lastSpotFetchInit.method, "POST");
  assert.equal(lastSpotFetchInit.body, "{}");
  assert.ok(!Object.keys(lastSpotFetchInit.headers).some((k) => /payment/i.test(k)));
  await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(lastSpotFetchInit.method, "GET");
  const bad = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&method=DELETE", { envo: e });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, "method");
});

test("spot-check expected pay_to / network: mismatches are skip; our crawl's listing is the default expectation", async () => {
  const e = spotEnv();
  spotTargetMode = "402";
  const base = SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=withgrokbot-selftest";
  const ok = await send(base + "&pay_to=" + PAY_TO.toLowerCase() + "&network=eip155:8453", { envo: e });
  assert.equal(ok.body.verdict, "pay");
  assert.equal(ok.body.expected_pay_to, PAY_TO.toLowerCase());
  assert.equal(ok.body.expected_source, "request");
  const wallet = await send(base + "&pay_to=0x" + "ab".repeat(20), { envo: e });
  assert.deepEqual([wallet.body.verdict, wallet.body.reason], ["skip", "pay_to_mismatch"]);
  const net = await send(base + "&network=eip155:84532", { envo: e });
  assert.deepEqual([net.body.verdict, net.body.reason], ["skip", "network_mismatch"]);
  const bad = await send(base + "&pay_to=not%20a%20wallet", { envo: e });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, "pay_to");
  // Real /v1/skips case b5e13e8271: listed on Base Sepolia, live 402 asks for Base mainnet USDC.
  // (Only while the weekly crawl still has this listing; the request-side checks above always run.)
  if (!listingFor("https://topagentx402.vercel.app/api/send-token")) return;
  const real = await send(SPOT + "?url=" + encodeURIComponent("https://topagentx402.vercel.app/api/send-token") + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(real.body.verdict, "skip");
  assert.equal(real.body.reason, "network_mismatch");
  assert.equal(real.body.expected_network, "eip155:84532");
  assert.equal(real.body.expected_source, "listing");
  assert.equal(real.body.claimed_price_usd, 0.001);
  // free tier states it in plain words
  const free = await send(SPOT + "?url=" + encodeURIComponent("https://topagentx402.vercel.app/api/send-token") + "&client=free-real-1", { envo: e });
  assert.equal(free.body.access.tier, "free");
  assert.equal(free.body.reason, "listed $0.001, asks for a different network than expected, details locked");
});

test("PAY STEP: paid pay verdict returns the exact signable payment; hash commits to it; skip approves nothing", async () => {
  const e = spotEnv();
  spotTargetMode = "402";
  const ok = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=0.001&client=withgrokbot-selftest", { envo: e });
  assert.equal(ok.body.verdict, "pay");
  const dl = new Date(Date.parse(ok.body.probe.probed_at) + 300000).toISOString().replace(/\.\d{3}Z$/, "Z");
  assert.deepEqual(ok.body.payment, { network: "eip155:8453", asset: USDC, amount: { atomic: "1000", usd: 0.001 }, pay_to: PAY_TO, deadline: dl, deadline_source: "maxTimeoutSeconds", scheme: "exact", amount_atomic: "1000", amount_usd: 0.001, asset_is_usdc: true });
  assert.equal(ok.body.check_type, "self-checked");
  const h = createHash("sha256").update(["eip155:8453", USDC.toLowerCase(), "1000", PAY_TO.toLowerCase()].join("|")).digest("hex");
  assert.equal(ok.body.payment_terms_sha256, h);
  assert.equal(await termsSha256(ok.body.payment), h);
  const skip = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=9&client=withgrokbot-selftest", { envo: e });
  assert.equal(skip.body.verdict, "skip");
  assert.equal(skip.body.payment, null);
  assert.equal(skip.body.payment_terms_sha256, null);
  // free tier carries the same hash, never the terms
  const free = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=paystep-free", { envo: e });
  assert.equal(free.body.payment_terms_sha256, h);
  assert.equal(free.body.payment, undefined);
});

test("PAY STEP: picks the accept matching the expectation; non-USDC asset is skip/asset_not_usdc; amount vs claimed", async () => {
  const usdc = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: "0x" + "aa".repeat(20), amount_usd: 0.01 };
  const sep = { scheme: "exact", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "10000", payTo: "0x" + "bb".repeat(20), amount_usd: 0.01 };
  assert.equal(pickPayment({ accepts: [usdc, sep] }, { network: "eip155:84532" }).pay_to, sep.payTo);
  const weird = { ...usdc, asset: "0x" + "99".repeat(20) };
  assert.equal(pickPayment({ accepts: [weird, usdc] }, {}).asset, USDC, "prefers the USDC accept when nothing is expected");
  const pm = pickPayment({ accepts: [weird] }, {});
  assert.equal(pm.asset_is_usdc, false);
  assert.equal(pm.amount_usd, null);
  assert.deepEqual(applyPayment({ verdict: "pay", reason: "price_ok" }, pm, {}), { verdict: "skip", reason: "asset_not_usdc" });
  assert.deepEqual(applyPayment({ verdict: "pay", reason: "price_ok" }, pickPayment({ accepts: [usdc] }, {}), { claimed: 0.02 }), { verdict: "skip", reason: "price_mismatch" });
  assert.deepEqual(applyPayment({ verdict: "pay", reason: "price_ok" }, null, {}), { verdict: "skip", reason: "bad_challenge" });
  assert.deepEqual(applyPayment({ verdict: "pay", reason: "price_ok" }, pickPayment({ accepts: [sep] }, {}), {}), { verdict: "skip", reason: "network_unsupported" }, "testnets are not supported mainnets");
  const poly = { scheme: "exact", network: "eip155:137", asset: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", amount: "10000", payTo: "0x" + "cc".repeat(20) }; // bridged USDC.e, not canonical
  assert.deepEqual(applyPayment({ verdict: "pay", reason: "price_ok" }, pickPayment({ accepts: [poly] }, {}), {}), { verdict: "skip", reason: "asset_not_usdc" });
  assert.deepEqual(applyPayment({ verdict: "pay", reason: "price_ok" }, pickPayment({ accepts: [{ ...poly, asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" }] }, {}), {}), { verdict: "pay", reason: "price_ok" });
  // payment object deadline: validBefore wins, else maxTimeoutSeconds, else 60 s
  const pmB = pickPayment({ accepts: [{ ...usdc, validBefore: 1791651600 }] }, {});
  assert.deepEqual([paymentObject(pmB, "2026-10-10T17:00:00Z").deadline, paymentObject(pmB, "2026-10-10T17:00:00Z").deadline_source], [new Date(1791651600000).toISOString().replace(/\.\d{3}Z$/, "Z"), "validBefore"]);
  assert.deepEqual([paymentObject(pickPayment({ accepts: [usdc] }, {}), "2026-10-10T17:00:00Z").deadline, paymentObject(pickPayment({ accepts: [usdc] }, {}), "2026-10-10T17:00:00Z").deadline_source], ["2026-10-10T17:01:00Z", "default_60s"]);
  assert.equal(pickPayment({ accepts: [{ scheme: "upto", network: "eip155:8453", amount: "1", payTo: "0x1" }] }, {}), null);
});

// In-memory D1 stand-in (prepare/bind/run/first) for the receipts table.
function fakeD1() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      return {
        bind(...a) {
          return {
            async run() { if (/^INSERT/.test(sql)) { if (rows.some((r) => r.id === a[0])) throw new Error("UNIQUE"); rows.push({ id: a[0], url: a[1], created_at: a[2], verdict: a[3], reason: a[4], check_type: a[5], ref: a[6], norm_key: a[7], probed_at: a[8], body: a[9] }); } return { success: true }; },
            async all() {
              // SELECT ... WHERE check_type = ? [AND ref = ?] [AND (created_at < ? OR (created_at = ? AND id < ?))] ORDER BY created_at DESC, id DESC LIMIT ?
              let i = 0;
              const type = a[i++];
              const ref = / AND ref = \?/.test(sql) ? a[i++] : null;
              const cur = /created_at < \?/.test(sql) ? [a[i++], a[i++], a[i++]] : null;
              const lim = a[i++];
              let out = rows.filter((r) => r.check_type === type && (ref === null || r.ref === ref));
              if (cur) out = out.filter((r) => r.created_at < cur[0] || (r.created_at === cur[1] && r.id < cur[2]));
              out.sort((x, y) => (x.created_at === y.created_at ? (x.id < y.id ? 1 : -1) : x.created_at < y.created_at ? 1 : -1));
              return { results: out.slice(0, lim) };
            },
            async first() {
              if (/WHERE id = \?/.test(sql)) return rows.find((r) => r.id === a[0]) || null;
              if (/WHERE norm_key = \?/.test(sql)) return rows.filter((r) => r.norm_key === a[0] && r.probed_at >= a[1]).sort((x, y) => (x.probed_at < y.probed_at ? 1 : -1))[0] || null;
              if (/WHERE url = \?/.test(sql)) return rows.filter((r) => r.url === a[0]).sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : 0))[0] || null;
              return null;
            },
          };
        },
      };
    },
  };
}

test("public receipts: every delivered decision is stored; GET by id and by-url are free; no client id stored", async () => {
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db });
  spotTargetMode = "402";
  const t = SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=0.001&client=rcpt-client-1";
  const free = await send(t, { envo: e });
  assert.match(free.body.receipt_id, /^sc-[0-9a-f]{16}$/);
  assert.equal(free.body.receipt_url, "https://402xagent.com/v1/receipts/" + free.body.receipt_id);
  assert.equal(db.rows.length, 1);
  assert.ok(!db.rows[0].body.includes("rcpt-client-1"), "receipts never carry the client id");
  const unpaid = await send(t, { envo: e });
  assert.equal(unpaid.status, 402);
  assert.equal(db.rows.length, 1, "a 402 (no decision delivered) stores nothing");
  const got = await send("/v1/receipts/" + free.body.receipt_id, { envo: e });
  assert.equal(got.status, 200);
  assert.equal(got.body.url, "https://spot.target.test/api");
  assert.equal(got.body.verdict, "pay");
  assert.equal(got.body.reason, "price_ok");
  assert.match(got.body.checked_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(got.body.live_402.accepts[0], { scheme: "exact", network: "eip155:8453", asset: USDC, amount_atomic: "1000", pay_to: PAY_TO });
  assert.equal(got.body.approved_payment.amount_atomic, "1000");
  assert.equal(got.body.payment_terms_sha256, free.body.payment_terms_sha256);
  // a later decision for the same URL becomes the latest
  await new Promise((r) => setTimeout(r, 1100));
  const later = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=9&client=withgrokbot-selftest", { envo: e });
  const by = await send("/v1/receipts/by-url?url=" + encodeURIComponent("https://spot.target.test/api"), { envo: e });
  assert.equal(by.status, 200);
  assert.equal(by.body.latest_live.id, later.body.receipt_id);
  assert.equal(by.body.latest_live.verdict, "skip");
  assert.equal(by.body.latest_crawl, null);
  // crawl-only URL: by-url returns the crawl receipt; unknown: 404 with a check_now link; missing url: 400
  const sk = (await send("/v1/skips?format=json", { envo: e })).body.skips[0];
  const crawl = await send("/v1/receipts/by-url?url=" + encodeURIComponent(sk.url), { envo: e });
  assert.equal(crawl.body.latest_live, null);
  assert.equal(crawl.body.latest_crawl.id, sk.id);
  const none = await send("/v1/receipts/by-url?url=https%3A%2F%2Fnever.test%2Fx", { envo: e });
  assert.equal(none.status, 404);
  assert.match(none.body.check_now, /endpoint-spot-check\?url=/);
  assert.equal((await send("/v1/receipts/by-url", { envo: e })).status, 400);
  assert.equal((await send("/v1/receipts/sc-0000000000000000", { envo: e })).status, 404);
  // old crawl ids still resolve
  assert.equal((await send("/v1/receipts/" + sk.id, { envo: e })).status, 200);
  // SSRF-blocked targets: 400, nothing fetched, nothing stored
  const n = db.rows.length;
  assert.equal((await send(SPOT + "?url=" + encodeURIComponent("http://127.0.0.1/") + "&client=withgrokbot-selftest", { envo: e })).status, 400);
  assert.equal(db.rows.length, n);
  // MCP get_receipt
  const m = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_receipt", arguments: { id: free.body.receipt_id } } }, { envo: e });
  assert.equal(m.body.result.structuredContent.id, free.body.receipt_id);
  const mu = await rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "get_receipt", arguments: { url: "https://spot.target.test/api" } } }, { envo: e });
  assert.equal(mu.body.result.structuredContent.latest_live.id, later.body.receipt_id);
  const oa = (await send("/openapi.json", { envo: e })).body;
  assert.ok(oa.paths["/v1/receipts/by-url"] && oa.paths["/v1/receipts/{id}"]);
});

test("public receipts: store outage never breaks an answer; no DB -> receipt fields null", async () => {
  const broken = { prepare() { return { bind() { return { run: async () => { throw new Error("D1 down"); }, first: async () => { throw new Error("D1 down"); } }; } }; } };
  const e = spotEnv({ RECEIPTS_DB: broken });
  spotTargetMode = "402";
  const r = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(r.status, 200);
  assert.equal((await send("/v1/receipts/sc-0000000000000000", { envo: e })).status, 503);
  const n = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=withgrokbot-selftest", { envo: spotEnv() });
  assert.equal(n.body.receipt_url, null);
});

test("router tier: allowlisted router pays $0.01 for a 10-check pack ($0.001/check), one settlement; credits then spent; others unchanged", async () => {
  const e = spotEnv({ SPOT_ROUTER_CLIENTS: "router-test-1", SPOT_PARTNER_CLIENTS: "router-test-1:1" });
  facCalls.length = 0;
  facMode = "ok";
  spotTargetMode = "402";
  const T = SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=router-test-1";
  assert.equal((await send(T, { envo: e })).body.access.tier, "partner", "partner pool first");
  assert.equal((await send(T, { envo: e })).body.access.tier, "free", "then the daily free check");
  const unpaid = await send(T, { envo: e });
  assert.equal(unpaid.status, 402);
  assert.equal(unpaid.body.accepts[0].amount, "10000");
  assert.match(unpaid.body.error, /buys 10 checks \(\$0\.001\/check\)/);
  assert.match(unpaid.body.pricing, /router tier/);
  const paid = await send(T, { envo: e, headers: { "payment-signature": spotPayment({ amount: "10000" }) } });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.access.tier, "router-pack");
  assert.equal(paid.body.access.credits_added, 9);
  assert.equal(paid.body.access.credits_remaining, 9);
  assert.equal(facCalls.filter((x) => x[0] === "/settle").length, 1);
  for (let i = 8; i >= 0; i--) {
    const r = await send(T, { envo: e });
    assert.equal(r.status, 200);
    assert.equal(r.body.access.tier, "router-prepaid");
    assert.equal(r.body.access.credits_remaining, i);
    assert.equal(r.body.verdict, "pay");
    assert.ok(r.body.payment, "prepaid checks get the full paid shape");
  }
  assert.equal((await send(T, { envo: e })).status, 402, "pack used up -> next pack");
  assert.equal(facCalls.filter((x) => x[0] === "/settle").length, 1, "10 checks, one settlement");
  // a higher signed amount is not accepted on the router tier (exact pack price only)
  assert.equal((await send(T, { envo: e, headers: { "payment-signature": spotPayment({ amount: "20000" }) } })).status, 402);
  // non-router clients keep the 1/10-of-quote price
  await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=not-a-router", { envo: e });
  const other = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=not-a-router", { envo: e });
  assert.match(other.body.pricing, /one tenth/);
});

test("weekly crawl coverage (0.11.0): normUrl matches crawl_probe.py; KV-backed receipts, skip pages, by-url and spot-check listing", async () => {
  const urls = ["HTTPS://Api.X.com:443/a/b/?z=1&a=2#f", "http://x.com", "https://x.com/", "https://u:p@x.com:8443/a//", "https://x.com/a?b", "https://h.test/p?x=%2F&&a=1", "not a url"];
  const py = spawnSync("python3", ["-c", "import sys,json;sys.path.insert(0,sys.argv[1]);from crawl_probe import norm_url;print(json.dumps([norm_url(u) for u in json.loads(sys.argv[2])]))", [new URL("../../receipts/scripts", import.meta.url).pathname, new URL("../scripts/weekly-crawl", import.meta.url).pathname].find((d) => existsSync(d + "/crawl_probe.py")), JSON.stringify(urls)], { encoding: "utf8" });
  assert.deepEqual(urls.map(normUrl), JSON.parse(py.stdout), "JS and Python normalizers agree");
  const ext = "https://spot.target.test/kv-thing";
  const id = await receiptIdFor(ext + "/");
  assert.equal(id, await receiptIdFor("HTTPS://SPOT.target.test:443/kv-thing"));
  const rec = { id, url: ext, verdict: "skip", reason: "payTo differs from listing (0x" + "11".repeat(20) + " listed, 0x" + "22".repeat(20) + " in 402)", listed_pay_to: "0x" + "11".repeat(20), listed_network: "eip155:8453", claimed_price_usd: 0.002, source_list: "agent-tools-cloud", also_listed_in: ["payapi-market"], timestamp: "2026-10-09T20:00:00Z" };
  const store = new Map([["c:" + id.slice(0, 2), JSON.stringify({ [id]: rec })], ["s:2", JSON.stringify([rec])]]);
  const kv = { async get(k, o) { const v = store.get(k); return v == null ? null : o && o.type === "json" ? JSON.parse(v) : v; } };
  const e = spotEnv({ CRAWL_KV: kv });
  const r = await send("/v1/receipts/" + id, { envo: e });
  assert.equal(r.status, 200);
  assert.equal(r.body.url, ext);
  const by = await send("/v1/receipts/by-url?url=" + encodeURIComponent(ext + "/"), { envo: e });
  assert.equal(by.status, 200);
  assert.equal(by.body.latest_crawl.id, id);
  const sk = await send("/v1/skips.json", { envo: e });
  assert.equal(sk.body.endpoints_covered, RECEIPTS_META.endpoints_covered ?? RECEIPTS_META.total);
  assert.ok("new_this_week" in sk.body);
  assert.equal(sk.body.page, 1);
  if ((RECEIPTS_META.skip_pages || 1) >= 2) {
    const p2 = await send("/v1/skips.json?page=2", { envo: e });
    assert.equal(p2.body.page, 2);
    assert.equal(p2.body.skips[0].id, id);
  }
  const hres = await worker.fetch(new Request("https://lookup.test/v1/skips", { headers: { accept: "text/html" } }), e.env, { waitUntil() {} });
  const html = await hres.text();
  assert.match(html, /endpoints covered/);
  assert.match(html, /new this week/);
  // the spot-check uses the KV listing as the expectation (pay_to/network) for URLs not in the bundle
  const sc = await send(SPOT + "?url=" + encodeURIComponent(ext) + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(sc.body.expected_source, "listing");
  assert.equal(sc.body.expected_pay_to, rec.listed_pay_to);
  // KV missing or down: no crash
  assert.equal((await send("/v1/receipts/" + id, { envo: spotEnv() })).status, 404);
  const broken = spotEnv({ CRAWL_KV: { get: async () => { throw new Error("kv down"); } } });
  assert.equal((await send("/v1/receipts/" + id, { envo: broken })).status, 404);
});

test("bot tags (0.11.0): scanner, example-param, indexer on lookup + spot; views on pack/skips/receipts/docs are counted", async () => {
  const pts = async (path, o = {}) => {
    const e = spotEnv();
    const req = new Request("https://lookup.test" + path, { method: o.method || "GET", headers: { "user-agent": o.ua || "node", "cf-connecting-ip": "203.0.113.9", ...(o.headers || {}) } });
    const waits = [];
    const res = await worker.fetch(req, e.env, { waitUntil(p) { waits.push(p); } });
    await Promise.all(waits);
    return { status: res.status, points: e.points };
  };
  const reason = (r) => r.points.map((p) => p.blobs[5]);
  assert.deepEqual(reason(await pts("/v1/lookup")), ["scanner"]);
  assert.deepEqual(reason(await pts("/v1/lookup/paid")), ["scanner"]);
  assert.deepEqual(reason(await pts(SPOT)), ["scanner"]);
  assert.deepEqual(reason(await pts(SPOT + "?url=" + encodeURIComponent("https://example.com/api/paid"))), ["example-param"]);
  assert.deepEqual(reason(await pts("/v1/lookup?task=web-search&max_price=0.01")), ["example-param"]);
  assert.deepEqual(reason(await pts("/v1/lookup?task=web-search&max_price=0.01&ref=via-cdp")), [""], "an attributed caller is never auto-tagged");
  assert.deepEqual(reason(await pts("/v1/lookup?task=web-search&max_price=0.02", { ua: "PayAI-Bazaar/1.0" })), ["indexer"]);
  assert.deepEqual(reason(await pts(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api"), { ua: "x402-observer/2" })), ["indexer"]);
  assert.deepEqual(reason(await pts(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api"), { ua: "Googlebot/2.1" })), ["crawler"], "spot route now runs the crawler filter");
  const real = await pts(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&ref=via-x402-spotcheck");
  assert.deepEqual(reason(real), [""]);
  assert.equal(real.points[0].blobs[10], "via-x402-spotcheck", "spot ref " + JSON.stringify(real.points[0].blobs));
  for (const [path, access] of [["/v1/skips", "view-skips"], ["/v1/skips.json?page=1", "view-skips"], ["/v1/receipts", "view-receipts"], ["/openapi.json", "view-docs-openapi"], ["/llms.txt", "view-docs-llms"], ["/.well-known/x402", "view-docs-wellknown"], ["/", "view-docs-home"], ["/v1/products/overnight-cos-pack", "view-pack-402"]]) {
    const r = await pts(path);
    assert.equal(r.points.length, 1, path);
    assert.equal(r.points[0].blobs[12], access, path + " " + JSON.stringify(r.points[0].blobs));
  }
  const v = await pts("/v1/skips?ref=via-x402scan", { ua: "Mozilla/5.0" });
  assert.equal(v.points[0].blobs[10], "via-x402scan", JSON.stringify(v.points[0].blobs));
  assert.equal(v.points[0].blobs[5], "");
});

test("guessed Spot-Check paths 308 to /v1/products/endpoint-spot-check with the query; 404 names the spot-check route (0.12.1)", async () => {
  const e = spotEnv();
  for (const p of ["/endpoint-spot-check", "/v1/endpoint-spot-check", "/spot-check", "/v1/spot-check"]) {
    const r = await send(p + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=withgrokbot-selftest", { envo: e });
    assert.equal(r.status, 308, p);
    assert.equal(r.headers.get("location"), "https://lookup.test/v1/products/endpoint-spot-check?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=withgrokbot-selftest", p);
    assert.equal(r.body.moved_to, r.headers.get("location"));
  }
  const nf = await send("/nope", { envo: e });
  assert.equal(nf.status, 404);
  assert.match(nf.body.spot_check, /\/v1\/products\/endpoint-spot-check\?url=/);
});

test("dry run (0.13.0): free, never signed or paid, always stored; free-tier shape with no approval hash; listable; capped; tagged", async () => {
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db, SPOT_DRY_PER_DAY: "3", SPOT_DRY_PER_IP_DAY: "4" });
  facCalls.length = 0;
  spotTargetMode = "402";
  lastSpotFetchInit = null;
  const u = SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=0.001";
  const r = await send(u + "&mode=dry-run&ref=via-agentkit&client=dry-client-1", { envo: e, headers: { "payment-signature": spotPayment({ amount: "10000" }) } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["access", "check_type", "mode", "payment_terms_sha256", "reason", "receipt_id", "receipt_url", "verdict"]);
  assert.equal(r.body.mode, "dry-run");
  assert.equal(r.body.verdict, "pay");
  assert.equal(r.body.reason, "listed $0.001, payment request matches");
  assert.equal(r.body.payment_terms_sha256, null, "a dry run never approves terms");
  assert.equal(r.body.access.tier, "dry-run");
  assert.deepEqual([r.body.access.dry_runs_per_day, r.body.access.dry_runs_used_today, r.body.access.dry_runs_remaining_today], [3, 1, 2]);
  assert.equal(facCalls.length, 0, "nothing verified or settled, even with a payment header");
  const h = lastSpotFetchInit.headers || {};
  assert.ok(!Object.keys(h instanceof Headers ? Object.fromEntries(h.entries()) : h).some((k) => /payment/i.test(k)), "probe carries no payment headers");
  // stored receipt
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].check_type, "dry-run");
  assert.equal(db.rows[0].ref, "via-agentkit");
  const rec = (await send("/v1/receipts/" + r.body.receipt_id, { envo: e })).body;
  assert.equal(rec.check_type, "dry-run");
  assert.equal(rec.url, "https://spot.target.test/api");
  assert.deepEqual(rec.listing, { claimed_price_usd: 0.001, pay_to: null, network: null, source: "request" });
  assert.deepEqual(rec.live_demand, { http_status: 402, x402_challenge: true, schemes: ["exact"], terms: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount_atomic: "1000", pay_to: PAY_TO }] });
  assert.deepEqual([rec.verdict, rec.reason, rec.ref, rec.caller, rec.approved_payment, rec.payment_terms_sha256], ["pay", "price_ok", "via-agentkit", "via-agentkit", null, null]);
  assert.match(rec.checked_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(!db.rows[0].body.includes("dry-client-1") && !db.rows[0].body.includes("203.0.113"), "no client id or IP in the receipt");
  // ref=dry-run-<caller> alias; a 200-with-trial target records what it returned
  await new Promise((res) => setTimeout(res, 1100)); // receipts sort by second-resolution checked_at
  spotTargetMode = "trial";
  const a = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/t") + "&ref=dry-run-bot-a", { envo: e });
  assert.deepEqual([a.body.mode, a.body.verdict], ["dry-run", "recheck"]);
  const ra = (await send("/v1/receipts/" + a.body.receipt_id, { envo: e })).body;
  assert.deepEqual(ra.live_demand, { http_status: 200, x402_challenge: false, free_trial: { active: true, remaining: 3 }, error: null });
  assert.deepEqual([ra.ref, ra.caller, ra.listing], ["dry-run-bot-a", "bot-a", null]);
  // exempt self-test client: check_type self-checked
  spotTargetMode = "402";
  const live = await send(u + "&client=withgrokbot-selftest&ref=via-cdp", { envo: e });
  assert.equal(live.body.access.tier, "exempt");
  assert.equal((await send("/v1/receipts/" + live.body.receipt_id, { envo: e })).body.check_type, "self-checked");
  // listing + filter + cursor
  const l1 = await send("/v1/receipts?type=dry-run&limit=1", { envo: e });
  assert.equal(l1.status, 200);
  assert.equal(l1.body.count, 1);
  assert.equal(l1.body.receipts[0].id, a.body.receipt_id, "newest first");
  assert.ok(l1.body.next_cursor);
  const l2 = await send("/v1/receipts?type=dry-run&limit=1&cursor=" + l1.body.next_cursor, { envo: e });
  assert.deepEqual([l2.body.receipts[0].id, l2.body.next_cursor], [r.body.receipt_id, null]);
  assert.deepEqual((await send("/v1/receipts?type=dry-run&ref=dry-run-bot-a", { envo: e })).body.receipts.map((x) => x.id), [a.body.receipt_id]);
  assert.deepEqual((await send("/v1/receipts?type=self-checked", { envo: e })).body.receipts.map((x) => x.id), [live.body.receipt_id]);
  assert.equal((await send("/v1/receipts?type=bogus", { envo: e })).status, 400);
  assert.equal((await send("/v1/receipts?type=dry-run&cursor=zzz", { envo: e })).status, 400);
  assert.ok((await send("/v1/receipts", { envo: e })).body.receipts, "plain /v1/receipts is still the crawl listing");
  // cap: 3 per caller (ref), then 429 without probing or storing
  await send(u + "&mode=dry-run&ref=via-agentkit", { envo: e });
  await send(u + "&mode=dry-run&ref=via-agentkit", { envo: e });
  const n = db.rows.length;
  lastSpotFetchInit = null;
  const capped = await send(u + "&mode=dry-run&ref=via-agentkit", { envo: e });
  assert.equal(capped.status, 429);
  assert.match(capped.body.error, /3 per caller/);
  assert.equal(lastSpotFetchInit, null, "capped dry run does not probe");
  assert.equal(db.rows.length, n);
  // per-IP cap across refs (4 per IP: r, bot-a and two more ran from this IP)
  const other = await send(u + "&mode=dry-run&ref=dry-run-rotating-1", { envo: e });
  assert.equal(other.status, 429);
  assert.match(other.body.error, /4 per UTC day from one network/);
  assert.equal((await send(u + "&mode=dry-run&ref=dry-run-rotating-2", { envo: e, ip: "198.51.100.9" })).status, 200, "another network is not capped");
  // bad mode is a 400; no DB -> 503 (dry runs are always stored)
  assert.equal((await send(u + "&mode=fast", { envo: e })).status, 400);
  assert.equal((await send(u + "&mode=dry-run&ref=x1", { envo: spotEnv() })).status, 503);
  // analytics: blob6 + blob13 = dry-run, never qualifying
  const pts = e.points.filter((p) => p.blobs[12].startsWith("dry-run"));
  assert.ok(pts.length >= 5);
  for (const p of pts) { assert.equal(p.blobs[5], "dry-run"); assert.equal(p.doubles[0], 0); }
  assert.ok(e.points.some((p) => p.blobs[12] === "dry-run-capped"));
  // MCP: mode passes through
  const m = await rpc({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "endpoint_spot_check", arguments: { url: "https://spot.target.test/api", mode: "dry-run", ref: "dry-run-mcp-1" } } }, { envo: e, ip: "192.0.2.44" });
  assert.equal(m.body.result.structuredContent.mode, "dry-run");
  // pre-0.13.0 rows read as check_type live
  db.rows.push({ id: "sc-00000000000000aa", url: "https://old.test/x", created_at: "2026-10-01T00:00:00Z", verdict: "pay", reason: "price_ok", check_type: "live", ref: null, body: JSON.stringify({ id: "sc-00000000000000aa", check_type: "live spot-check (unpaid probe of the target; never pays it)" }) });
  const old = (await send("/v1/receipts/sc-00000000000000aa", { envo: e })).body;
  assert.deepEqual([old.check_type, old.check_note], ["live", "live spot-check (unpaid probe of the target; never pays it)"]);
  const oa = (await send("/openapi.json", { envo: e })).body;
  assert.ok(oa.paths[SPOT].get.parameters.some((x) => x.name === "mode"));
  assert.ok(oa.paths["/v1/receipts"].get.parameters.some((x) => x.name === "type"));
});

test("determinism (0.14.0): one probe per normalized URL + method for 5 min; consecutive calls agree; every call stored and labelled", async () => {
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db });
  spotTargetMode = "402";
  const t = "https://spot.target.test/det";
  const first = await send(SPOT + "?url=" + encodeURIComponent(t) + "&client=withgrokbot-selftest", { envo: e });
  spotTargetMode = "trial"; // the target flips (e.g. per-caller trial) ...
  const second = await send(SPOT + "?url=" + encodeURIComponent("HTTPS://SPOT.target.test/det/") + "&client=withgrokbot-selftest", { envo: e });
  assert.deepEqual([first.body.verdict, second.body.verdict], ["pay", "pay"], "... but the cached probe keeps the verdict");
  assert.deepEqual([first.body.probe.cached, second.body.probe.cached], [false, true]);
  assert.equal(second.body.probe.probed_at, first.body.probe.probed_at);
  assert.deepEqual(second.body.payment, first.body.payment);
  assert.notEqual(second.body.receipt_id, first.body.receipt_id, "each call gets its own receipt");
  // POST is a different key; an outside caller is labelled dry-run, our self-test client self-checked
  const post = await send(SPOT + "?url=" + encodeURIComponent(t) + "&method=POST&client=outside-1", { envo: e });
  assert.equal(post.body.verdict, "recheck");
  assert.equal(post.body.access.tier, "free");
  const labels = db.rows.map((r) => [r.check_type, JSON.parse(r.body).mode]);
  assert.deepEqual(labels, [["self-checked", "live"], ["self-checked", "live"], ["dry-run", "live"]]);
  // cache window over -> a fresh probe
  const e2 = spotEnv({ RECEIPTS_DB: db, SPOT_PROBE_CACHE_S: "0" });
  const fresh = await send(SPOT + "?url=" + encodeURIComponent(t) + "&client=withgrokbot-selftest", { envo: e2 });
  assert.deepEqual([fresh.body.verdict, fresh.body.reason, fresh.body.probe.cached], ["recheck", "free_trial_active", false]);
  spotTargetMode = "402";
});

test("402xAgent rebrand (0.17.0): every host serves the same API; 402 resource follows the host; links canonical; no old brand", async () => {
  const e = spotEnv({ RECEIPTS_DB: fakeD1() });
  const hosts = ["https://402xagent.com", "https://api.402xagent.com", "https://payscout.dev", "https://api.payscout.dev", "https://verified-catalog-lookup.withgrokbot.workers.dev"];
  for (const h of hosts) {
    const get = async (p, init = {}) => worker.fetch(new Request(h + p, { headers: { "user-agent": "agent-x/1.0", "cf-connecting-ip": "203.0.113.7", ...(init.headers || {}) }, method: init.method || "GET", body: init.body }), e.env, { waitUntil() {} });
    assert.equal((await (await get("/health")).json()).version, VERSION, h);
    const oaT = await (await get("/openapi.json")).text();
    const oa = JSON.parse(oaT);
    assert.match(oa.info.title, /^402xAgent: /);
    assert.deepEqual(oa.servers.map((s) => s.url), ["https://api.402xagent.com", "https://402xagent.com", "https://verified-catalog-lookup.withgrokbot.workers.dev"], h);
    const pack = await get("/v1/products/overnight-cos-pack", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(pack.status, 402, "POST still gets the 402 on " + h);
    const pr = JSON.parse(Buffer.from(pack.headers.get("payment-required"), "base64").toString());
    assert.equal(pr.resource.url, h + "/v1/products/overnight-cos-pack", "402 resource is the host the client called (signed requirements match there)");
    const sp = await get("/v1/products/endpoint-spot-check?url=" + encodeURIComponent("https://seller.example/api/x") + "&client=rb-" + hosts.indexOf(h));
    const spT = await sp.text();
    assert.equal(sp.status, 200, h);
    assert.match(String(JSON.parse(spT).receipt_url), /^https:\/\/402xagent\.com\/v1\/receipts\/sc-/, "receipt links are canonical: " + spT.slice(0, 300));
    const llms = await (await get("/llms.txt")).text();
    assert.match(llms, /^# 402xAgent \+ x402 Verified Catalog/);
    const root = await (await get("/", { headers: { accept: "application/json" } })).json();
    assert.equal(root.hosts.home, "https://402xagent.com");
    assert.equal(root.products["endpoint-spot-check"].url, "https://402xagent.com/v1/products/endpoint-spot-check", "route paths unchanged");
    const wk = await (await get("/.well-known/x402")).json();
    assert.ok(wk.resources.every((u) => u.startsWith("https://api.402xagent.com/")));
    assert.match(await (await get("/robots.txt")).text(), /Sitemap: https:\/\/402xagent\.com\/sitemap\.xml/);
    const pubs = [oaT, spT, llms, JSON.stringify(root), JSON.stringify(pr).split(h + "/v1/products/overnight-cos-pack").join("<resource>"), JSON.stringify(wk), await (await get("/v1/skips.json")).text(), await (await get("/v1/receipts")).text()];
    pubs.push(await (await get("/v1/skips")).text(), await (await get("/", { headers: { accept: "text/html" } })).text());
    for (const t of pubs) assert.doesNotMatch(t, /payscout/i, "old brand gone from public copy on " + h + ": " + (t.match(/.{60}payscout.{60}/is) || [""])[0]);
    // 0.18.0: no Spot-Check name in public copy (route path /v1/products/endpoint-spot-check and tool name endpoint_spot_check stay)
    for (const t of pubs) { const c = t.split("endpoint-spot-check").join(""); assert.doesNotMatch(c, /spot[- ]check|formerly/i, "no Spot-Check copy on " + h + ": " + (c.match(/.{60}(spot[- ]check|formerly).{60}/is) || [""])[0]); }
  }
  const m = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { envo: e });
  const names = m.body.result.tools.map((t) => t.name);
  for (const n of ["endpoint_spot_check", "get_receipt", "lookup", "search_catalog", "get_service"]) assert.ok(names.includes(n), "tool name kept: " + n);
  assert.doesNotMatch(JSON.stringify(m.body), /payscout/i);
  assert.doesNotMatch(JSON.stringify(m.body).split("endpoint-spot-check").join(""), /spot[- ]check|formerly/i, "MCP tool copy");
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { envo: e });
  assert.equal(init.body.result.serverInfo.title, "402xAgent + verified x402 catalog");
  const sk = await worker.fetch(new Request("https://402xagent.com/v1/skips"), e.env, { waitUntil() {} });
  const skT = await sk.text();
  assert.match(skT, /<title>402xAgent skips/);
  assert.doesNotMatch(skT, /payscout/i);
});

test("receipts stored under an earlier brand are served with the 402xAgent name and a canonical permalink", async () => {
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db });
  const body = { service: "PayScout (formerly Spot-Check)", id: "sc-00000000000000aa", url: "https://x.test/a", check_type: "dry-run", verdict: "pay", reason: "price_ok", permalink: "https://payscout.dev/v1/receipts/sc-00000000000000aa" };
  await db.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, ref, norm_key, probed_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(body.id, body.url, "2026-10-10T18:00:00Z", "pay", "price_ok", "dry-run", null, null, null, JSON.stringify(body)).run();
  const r = await worker.fetch(new Request("https://api.402xagent.com/v1/receipts/sc-00000000000000aa"), e.env, { waitUntil() {} });
  const t = await r.text();
  assert.equal(r.status, 200);
  assert.doesNotMatch(t, /payscout|formerly|Spot-Check/i);
  assert.equal(JSON.parse(t).service, "402xAgent");
  assert.equal(JSON.parse(t).permalink, "https://402xagent.com/v1/receipts/sc-00000000000000aa");
});

test("old hosts (0.17.0): browser page views 301 to 402xagent.com; API, x402, MCP, POST and payment retries keep answering", async () => {
  const e = spotEnv();
  const H = "text/html,application/xhtml+xml,*/*;q=0.8";
  const go = (u, init = {}) => worker.fetch(new Request(u, { method: init.method || "GET", headers: init.headers || {}, body: init.body }), e.env, { waitUntil() {} });
  for (const h of ["https://payscout.dev", "https://api.payscout.dev", "https://verified-catalog-lookup.withgrokbot.workers.dev"]) {
    for (const p of ["/", "/v1/skips?page=1", "/llms.txt", "/openapi.json", "/v1/receipts/b5e13e8271"]) {
      const r = await go(h + p, { headers: { accept: H } });
      assert.equal(r.status, 301, h + p);
      assert.equal(r.headers.get("location"), "https://402xagent.com" + p);
    }
    // not redirected: JSON / default Accept, API + x402 + MCP paths, POST, payment retries
    assert.equal((await go(h + "/", { headers: { accept: "application/json" } })).status, 200);
    assert.equal((await go(h + "/v1/skips.json")).status, 200);
    assert.equal((await go(h + "/llms.txt", { headers: { accept: "*/*" } })).status, 200);
    assert.equal((await go(h + "/v1/products/overnight-cos-pack", { headers: { accept: H } })).status, 402);
    assert.equal((await go(h + "/v1/lookup/paid?task=web-search", { headers: { accept: H } })).status, 402);
    assert.equal((await go(h + "/v1/products/endpoint-spot-check?url=" + encodeURIComponent("https://seller.example/api/x") + "&client=oh-" + h.length, { headers: { accept: H } })).status, 200);
    assert.notEqual((await go(h + "/v1/skips", { headers: { accept: H, "x-payment": "e30=" } })).status, 301);
    const mcp = await go(h + "/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream, text/html", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(mcp.status, 200);
  }
  // the new hosts never redirect
  for (const h of ["https://402xagent.com", "https://api.402xagent.com"]) assert.notEqual((await go(h + "/v1/skips", { headers: { accept: H } })).status, 301);
});

test("landing page (0.17.0): HTML to browsers on 402xagent.com only, real counts, no client ids, JSON elsewhere", async () => {
  const e = spotEnv();
  const go = (h, accept) => worker.fetch(new Request(h + "/?cb=1", { headers: accept ? { accept } : {} }), e.env, { waitUntil() {} });
  const html = await go("https://402xagent.com", "text/html,application/xhtml+xml,*/*;q=0.8");
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type"), /text\/html/);
  const t = await html.text();
  for (const re of [/<h1>Check before your <span class="grad">agent pays<\/span><\/h1>/, /og:title" content="402xAgent/, /rel="canonical" href="https:\/\/402xagent.com\/"/, /og:url" content="https:\/\/402xagent.com\/"/, /id="try"/, /wrapFetchWithPayment\(spotCheckFetch\(fetch\), client\)/, /wrapAxiosWithPayment\(spotCheckAxios\(axios.create\(\)\), client\)/, /class="bigprice">Free to try, paid checks from \$0\.01<\/h2>/, /1\/10 of the target's price<\/b>, \$0\.01 min to \$0\.25 max/, /\$0\.001\/check<\/b> in packs of 10/, /<details class="sample" id="resp">\s*<summary>Show response<\/summary>/, /Stops your agent paying dead, mispriced or wrong-network endpoints/, /First router integration gets 1,000 free checks/, /withgrokbot\/x402-spotcheck\/issues\/new/, /href="\/mcp"/, /href="\/llms.txt"/, /href="\/openapi.json"/, /href="\/v1\/skips"/, /curl &quot;https:\/\/api\.402xagent\.com\/v1\/products\/endpoint-spot-check/])
    assert.match(t, re);
  assert.ok(t.includes(`>${RECEIPTS_META.skip}</div><div class="l">skip`), "skip count is the real crawl number");
  assert.ok(t.includes(`>${RECEIPTS_META.pay}</div><div class="l">pay`));
  assert.doesNotMatch(t, /payscout|router-ab|client=router|<script src=|<link rel="stylesheet"|fonts\.googleapis/i, "no old brand, client ids, personal names or external assets");
  assert.ok(LANDING_EXAMPLES.length >= 3 && LANDING_EXAMPLES.every((x) => t.includes(x.url)));
  // 0.18.0: light theme around the logo; own assets only
  assert.match(t, /--bg:#ffffff;--bg2:#f8fafc;--fg:#0b0b0f/);
  assert.match(t, /<meta name="color-scheme" content="light">/);
  assert.match(t, /class="hero-logo" src="\/brand\/logo-light\.png\?v=\d+"/);
  assert.match(t, /og:image" content="https:\/\/402xagent\.com\/og\.png/);
  assert.match(t, /twitter:card" content="summary_large_image"/);
  assert.match(t, /rel="apple-touch-icon"/);
  assert.doesNotMatch(t.split("endpoint-spot-check").join(""), /spot[- ]check|formerly/i);
  for (const [p, ct] of [["/brand/logo-light.png", "image/png"], ["/brand/logo-dark.png", "image/png"], ["/brand/mark-402.png", "image/png"], ["/og.png", "image/png"], ["/favicon.ico", "image/x-icon"], ["/apple-touch-icon.png", "image/png"], ["/brand/favicon-32.png", "image/png"]]) {
    for (const h of ["https://402xagent.com", "https://verified-catalog-lookup.withgrokbot.workers.dev"]) {
      const r = await worker.fetch(new Request(h + p, { headers: { accept: "image/avif,image/webp,*/*" } }), e.env, { waitUntil() {} });
      assert.equal(r.status, 200, h + p);
      assert.equal(r.headers.get("content-type"), ct);
      const b = new Uint8Array(await r.arrayBuffer());
      assert.ok(b.length > 200, p);
      if (ct === "image/png") assert.deepEqual([...b.slice(1, 4)], [80, 78, 71], p + " is a PNG");
    }
  }
  for (const [h, a] of [["https://402xagent.com", "application/json"], ["https://402xagent.com", null], ["https://api.402xagent.com", "text/html,*/*"]]) {
    const r = await go(h, a);
    assert.match(r.headers.get("content-type"), /application\/json/, h + " " + a);
    assert.equal((await r.json()).version, VERSION);
  }
});

let passed = 0;
for (const [name, fn] of T) {
  try {
    await fn();
    passed++;
    console.log("PASS " + name);
  } catch (e) {
    console.log("FAIL " + name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 12).join("\n  ") : e));
  }
}
console.log(`${passed}/${T.length} worker tests passed`);
process.exit(passed === T.length ? 0 : 1);
