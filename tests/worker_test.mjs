import { existsSync } from "node:fs";
// Unit tests for worker/src/index.js with a stubbed fetch and a stubbed Analytics Engine binding.
// All data here is synthetic. Run: node tests/worker_test.mjs   (Node 18+; no dependencies)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  if (u.startsWith("https://sol.target.test/")) {
    // 0.23.0 Solana fixtures (x402 v2 SVM shape: CAIP-2 network, mint as asset, extra.feePayer)
    const k = new URL(u).pathname.split("/")[1];
    const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", DEV = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
    const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", DEVMINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    const PT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", FP = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
    const one = (o) => ({ scheme: "exact", network: SOL, amount: "10000", asset: MINT, payTo: PT, maxTimeoutSeconds: 60, extra: { feePayer: FP }, ...o });
    const acc = {
      good: [one({})],
      v1: null,
      wrongmint: [one({ asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" })],
      lowermint: [one({ asset: MINT.toLowerCase() })],
      devnet: [one({ network: DEV, asset: DEVMINT })],
      upto: [one({ scheme: "upto", amount: "50000" })],
    }[k];
    if (k === "v1") return new Response(JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "solana", maxAmountRequired: "10000", asset: MINT, payTo: PT, resource: u, maxTimeoutSeconds: 60, extra: { feePayer: FP } }] }), { status: 402, headers: { "content-type": "application/json" } });
    const body = { x402Version: 2, error: "Payment required", resource: { url: u }, accepts: acc || [one({})] };
    return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", "payment-required": btoa(JSON.stringify(body)) } });
  }
  if (u.startsWith("https://spot.target.test/") || u.startsWith("https://x402.example.test/") || u.startsWith("https://api.realx402.dev/") || u.startsWith("https://other.realx402.dev/") || u.startsWith("https://example.com/") || u.startsWith("https://httpbin.org/")) {
    lastSpotFetchInit = init || {};
    if (spotTargetMode === "timeout") {
      const err = new Error("timeout"); err.name = "AbortError"; throw err;
    }
    if (spotTargetMode === "postonly" && String(init.method || "GET").toUpperCase() !== "POST") return new Response('{"error":"method not allowed"}', { status: 405, headers: { "content-type": "application/json" } });
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
    if (spotTargetMode === "upto") challenge.accepts[0].scheme = "upto"; // 0.23.1 Base regression fixture
    if (spotTargetMode === "expired") challenge.accepts[0].extra = { validBefore: Math.floor(Date.now() / 1000) - 600 }; // 0.42.0
    if (spotTargetMode === "expiring") challenge.accepts[0].extra = { validBefore: Math.floor(Date.now() / 1000) + 120 }; // 0.42.0
    if (spotTargetMode === "future") challenge.accepts[0].extra = { validBefore: Math.floor(Date.now() / 1000) + 3600 }; // 0.42.0
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
  assert.equal(r.body.also_available_spot_check.price_usdc, "0.02");
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
  // 0.19.0: a failed signed payment records the signer, the product and why it failed (almost-paid analysis)
  assert.deepEqual([p.blobs[14], p.blobs[15]], ["0x" + "11".repeat(20), "lookup"]);
  assert.match(p.blobs[16], /settlement failed: transaction_failed/);
  const garbage = e.points.find((x) => x.blobs[12] === "payment-failed" && /not valid base64/.test(x.blobs[16]));
  assert.deepEqual([garbage.blobs[14], garbage.blobs[15]], ["", "lookup"], "undecodable header: no payer");
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
  assert.deepEqual(wk.resources, ["https://api.402xagent.com/v1/lookup/paid", "https://api.402xagent.com/v1/products/overnight-cos-pack", "https://api.402xagent.com/v1/products/endpoint-spot-check", "https://api.402xagent.com/v1/products/payment-status"]);
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
  assert.deepEqual(workerTools.map((t) => t.name), ["search_catalog", "get_service", "lookup", "get_overnight_cos_pack", "get_receipt", "endpoint_spot_check", "payment_status", "discover"]);
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
  assert.equal(r.body.reason, "listed $0.001, payment request matches the listed price");
  // free tier: verdict + plain reason + access only (quoted/claimed price, pay_to, network, asset are paid)
  assert.deepEqual(Object.keys(r.body).sort(), ["access", "confidence", "history", "pay_to_changed", "payment_terms_sha256", "prior_checks", "quality", "reason", "reason_code", "receipt_id", "receipt_url", "reputation", "upsell", "verdict"]);
  assert.equal(r.body.upsell, "Full 402 details (exact payment terms, pay_to, deadline) for this endpoint for $0.02");
  assert.equal(r.body.prior_checks, "https://402xagent.com/v1/skips");
  assert.match(r.body.payment_terms_sha256, /^[0-9a-f]{64}$/);
  assert.ok(lastSpotFetchInit);
  const h = lastSpotFetchInit.headers || {};
  const hdrObj = h instanceof Headers ? Object.fromEntries(h.entries()) : h;
  const keys = Object.keys(hdrObj).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("payment-signature") && !keys.includes("x-payment"), "never send payment headers outbound");
  // second call same day → 402 at the flat $0.02 (0.38.0)
  const r2 = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=spot-free-1", { envo: e });
  assert.equal(r2.status, 402);
  assert.equal(r2.body.accepts[0].amount, "20000");
  assert.equal(r2.body.price_usd, "0.02");
  assert.equal(r2.body.product, "endpoint-spot-check");
});

test("spot-check unpaid after free exhausted → 402 amount 20000 (flat $0.02, 0.38.0); paid path works; never pays target", async () => {
  const e = spotEnv();
  facCalls.length = 0;
  facMode = "ok";
  spotTargetMode = "402";
  await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=spot-pay-1", { envo: e });
  const unpaid = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=spot-pay-1", { envo: e });
  assert.equal(unpaid.status, 402);
  assert.equal(unpaid.body.accepts[0].amount, "20000");
  // 0.19.0 analytics: the free answer and the 402 carry client id, target URL, UA family, ref and product "spot"
  const sp = e.points.filter((x) => x.blobs[15] === "spot").slice(-2);
  assert.deepEqual(sp.map((x) => x.blobs[12]), ["free", "payment-required"]);
  for (const x of sp) assert.deepEqual([x.blobs[0], x.blobs[3]], [sp[0].blobs[0], "https://spot.target.test/api"]);
  assert.ok(sp[1].blobs[0] && "blob9 UA family" && typeof sp[1].blobs[8] === "string" && typeof sp[1].blobs[10] === "string");
  facMode = "invalid";
  const failed = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=spot-pay-1", { envo: e, headers: { "payment-signature": spotPayment({ amount: "20000" }) } });
  assert.equal(failed.status, 402);
  const fp = e.points[e.points.length - 1];
  assert.deepEqual([fp.blobs[12], fp.blobs[15], fp.blobs[3]], ["payment-failed", "spot", "https://spot.target.test/api"]);
  assert.match(fp.blobs[14], /^0x[0-9a-f]{40}$/, "signer recorded");
  assert.match(fp.blobs[16], /payment not valid/);
  facMode = "ok";
  facCalls.length = 0;
  lastSpotFetchInit = null;
  const paid = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=spot-pay-1", {
    envo: e,
    headers: { "payment-signature": spotPayment({ amount: "20000" }) },
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.access.tier, "paid");
  assert.equal(paid.body.access.charged_usd, "0.02");
  assert.equal(paid.body.pay_to, PAY_TO);
  assert.equal(paid.body.network, "eip155:8453");
  assert.equal(paid.body.asset, USDC);
  assert.equal(paid.body.verdict, "pay");
  assert.equal(paid.body.reason, "price_ok");
  assert.equal(paid.body.quoted_price_usd, 0.001);
  { // 0.40.1: the stored (signed) receipt of a paid check records the payment
    const db = fakeD1(), fc = facCalls.length;
    const p2 = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api2") + "&client=spot-pay-1", { envo: { ...e, env: { ...e.env, RECEIPTS_DB: db } }, headers: { "payment-signature": spotPayment({ amount: "20000" }) } });
    assert.equal(p2.body.access && p2.body.access.tier, "paid", JSON.stringify(p2.body).slice(0, 300));
    assert.ok(db.rows.length, "rows: " + JSON.stringify(Object.keys(p2.body)) + JSON.stringify(p2.body.receipt_id || null));
    const row = db.rows.find((x) => x.id === p2.body.receipt_id || x.id === (p2.body.receipt && p2.body.receipt.id)) || db.rows[db.rows.length - 1];
    assert.deepEqual(JSON.parse(row.body).payment_received, { tier: "paid", payer: "0x" + "11".repeat(20), amount_atomic: "20000", amount_usd: "0.02", asset: USDC, network: "eip155:8453", settle_tx: TX, basescan_url: "https://basescan.org/tx/" + TX });
    facCalls.length = fc;
  }
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
  assert.equal(f.body.reason, "listed $0.05, seller says a free trial is active, so there is no price to check yet, try again later (3 trial calls left)");
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
  assert.match(free.body.result.structuredContent.reason, /^listed \$/);
  assert.equal(free.body.result.structuredContent.quoted_price_usd, undefined);
  const paidNeed = await rpc(call, { envo: e });
  assert.equal(paidNeed.body.result.isError, true);
  assert.match(paidNeed.body.result.content[0].text, /Payment required: \$0\.02 USDC/);
  const health = (await send("/health", { envo: e })).body;
  assert.equal(health.version, VERSION);
  const oa = (await send("/openapi.json", { envo: e })).body;
  assert.ok(oa.paths[SPOT]);
  assert.match(oa.paths[SPOT].get.responses[200].description, /verdict/);
});

test("spot-check price_mismatch → skip; no claimed → pay when challenge ok", async () => {
  const e = spotEnv();
  spotTargetMode = "402";
  const mismatch = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=0.0001&client=withgrokbot-selftest", { envo: e });
  assert.equal(mismatch.status, 200);
  assert.equal(mismatch.body.verdict, "skip");
  assert.equal(mismatch.body.reason, "price_mismatch");
  assert.equal(mismatch.body.quoted_price_usd, 0.001);
  assert.equal(mismatch.body.claimed_price_usd, 0.0001);
  const noclaim = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(noclaim.status, 200);
  assert.equal(noclaim.body.verdict, "pay");
  assert.equal(noclaim.body.reason, "price_ok");
  assert.equal(noclaim.body.claimed_price_usd, null);
});

test("spot-check aliases: endpoint= and claimed_price_usd= accepted (0.6.3); /v1/skips + /v1/receipts serve", async () => {
  const e = spotEnv();
  spotTargetMode = "402";
  const a = await send(SPOT + "?endpoint=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price_usd=0.0001&client=withgrokbot-selftest", { envo: e });
  assert.equal(a.status, 200);
  assert.equal(a.body.verdict, "skip");
  assert.equal(a.body.claimed_price_usd, 0.0001);
  const none = await send(SPOT + "?client=withgrokbot-selftest", { envo: e, headers: { "x-payment": "x" } });
  assert.equal(none.status, 200, "0.26.1: GET with no url (payment header present) = usage/help, HTTP 200");
  assert.deepEqual(Object.keys(none.body), ["error", "field", "example", "mistake", "hint", "fixed_example", "docs"]);
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
  const paid = await send(target, { envo: e, headers: { "payment-signature": spotPayment({ amount: "20000" }) } });
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
    const paid = await send(target, { envo: e, headers: { "payment-signature": spotPayment({ amount: "20000" }) } });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.access.self_test, true);
    const pt = e.points.filter((p) => p.blobs[12] === "paid").pop();
    assert.equal(pt.blobs[5], "self");
    assert.equal(pt.doubles[0], 0);
  } finally {
    facPayer = "0x" + "11".repeat(20);
  }
  const outside = await send(target.replace("selfpay-1", "selfpay-2"), { envo: e });
  const paid2 = await send(target.replace("selfpay-1", "selfpay-2"), { envo: e, headers: { "payment-signature": spotPayment({ amount: "20000" }) } });
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
  assert.equal(free.body.reason, "listed $0.001, asks for payment on a different network than listed");
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
  const skip = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=0.0001&client=withgrokbot-selftest", { envo: e });
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
  // 0.27.0 fix: listing names only Base Sepolia, the same seller's 402 also offers Base mainnet USDC -> judge the mainnet offer
  const sepSame = { ...sep, payTo: usdc.payTo };
  for (const exp of [{ network: "eip155:84532" }, { network: "eip155:84532", pay_to: usdc.payTo }]) {
    const pmx = pickPayment({ accepts: [sepSame, usdc] }, exp);
    assert.equal(pmx.network, "eip155:8453");
    assert.deepEqual(applyPayment({ verdict: "pay", reason: "price_ok" }, pmx, { claimed: 0.01 }), { verdict: "pay", reason: "price_ok" });
  }
  assert.equal(pickPayment({ accepts: [sepSame] }, { network: "eip155:84532" }).network, "eip155:84532", "testnet-only 402 unchanged");
  // 0.27.0 fix: within 1% of the listed price is a match (dynamic pricing drift); further is still a mismatch
  assert.deepEqual(applyPayment({ verdict: "pay", reason: "price_ok" }, pickPayment({ accepts: [{ ...usdc, amount: "1869" }] }, {}), { claimed: 0.001866 }), { verdict: "pay", reason: "price_ok" });
  assert.deepEqual(applyPayment({ verdict: "pay", reason: "price_ok" }, pickPayment({ accepts: [{ ...usdc, amount: "1890" }] }, {}), { claimed: 0.001866 }), { verdict: "skip", reason: "price_mismatch" });
  const weird = { ...usdc, asset: "0x" + "99".repeat(20) };
  assert.equal(pickPayment({ accepts: [weird, usdc] }, {}).asset, USDC, "prefers the USDC accept when nothing is expected");
  const pm = pickPayment({ accepts: [weird] }, {});
  assert.equal(pm.asset_is_usdc, false);
  assert.equal(pm.amount_usd, null);
  assert.deepEqual(applyPayment({ verdict: "pay", reason: "price_ok" }, pm, {}), { verdict: "skip", reason: "asset_not_usdc" });
  assert.deepEqual(applyPayment({ verdict: "pay", reason: "price_ok" }, pickPayment({ accepts: [usdc] }, {}), { claimed: 0.005 }), { verdict: "skip", reason: "price_mismatch" });
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
  const hist = [];
  const qual = []; // 0.37.0 endpoint_quality
  return {
    rows,
    hist,
    qual,
    prepare(sql) {
      return {
        bind(...a) {
          return {
            async run() {
              if (/^INSERT INTO endpoint_history/.test(sql)) { const k = ["hkey", "observed_at", "http_status", "amount_atomic", "price_usd", "network", "asset", "pay_to", "verdict"]; hist.push(Object.fromEntries(k.map((x, i) => [x, a[i]]))); return { success: true }; }
              if (/^INSERT INTO endpoint_quality/.test(sql)) { const k = ["hkey", "host", "observed_at", "http_status", "content_type", "body_bytes", "schema_declared", "schema_match", "code"]; qual.push(Object.fromEntries(k.map((x, i) => [x, a[i]]))); return { success: true }; }
              if (/^DELETE FROM endpoint_quality/.test(sql)) { const mine = qual.filter((q) => q.hkey === a[0]).sort((x, y) => (x.observed_at < y.observed_at ? 1 : -1)); for (const q of mine.slice(a[2])) qual.splice(qual.indexOf(q), 1); return { success: true }; }
              if (/^DELETE FROM endpoint_history/.test(sql)) { for (let i = hist.length - 1; i >= 0; i--) if (hist[i].hkey === a[0] && hist[i].observed_at < a[1]) hist.splice(i, 1); return { success: true }; }
              if (/^UPDATE spot_receipts SET pub_url/.test(sql)) {
                const r = rows.find((x) => x.id === a[2] && !x.pub_url);
                if (rows.some((x) => x.pub_day === a[1] && x.pub_url === a[0])) throw new Error("UNIQUE pub");
                if (r) Object.assign(r, { pub_url: a[0], pub_day: a[1] });
                return { success: true };
              }
              if (/^INSERT/.test(sql)) { if (rows.some((r) => r.id === a[0])) throw new Error("UNIQUE"); rows.push({ id: a[0], url: a[1], created_at: a[2], verdict: a[3], reason: a[4], check_type: a[5], ref: a[6], norm_key: a[7], probed_at: a[8], body: a[9] }); } return { success: true }; },
            async all() {
              if (/SELECT id, url, created_at, verdict, body FROM spot_receipts WHERE/.test(sql)) {
                const m = /url >= \?/.test(sql) ? (r) => (r.url >= a[0] && r.url < a[1]) || (r.url >= a[2] && r.url < a[3]) : (r) => r.url === a[0] || r.url === a[1];
                return { results: rows.filter(m).sort((x, y) => (x.created_at < y.created_at ? 1 : -1)).slice(0, 25) };
              }
              // 0.37.0 reputation reads
              if (/SELECT url, created_at, verdict FROM spot_receipts WHERE/.test(sql)) return { results: rows.filter((r) => (r.url >= a[0] && r.url < a[1]) || (r.url >= a[2] && r.url < a[3])).sort((x, y) => (x.created_at < y.created_at ? 1 : -1)).slice(0, 500).map(({ url, created_at, verdict }) => ({ url, created_at, verdict })) };
              if (/FROM endpoint_history WHERE hkey IN/.test(sql)) return { results: hist.filter((h) => a.includes(h.hkey)).sort((x, y) => (x.observed_at < y.observed_at ? 1 : -1)).slice(0, 300) };
              if (/FROM endpoint_quality WHERE host = \?/.test(sql)) return { results: qual.filter((q) => q.host === a[0]).sort((x, y) => (x.observed_at < y.observed_at ? 1 : -1)).slice(0, 100) };
              if (/FROM endpoint_history/.test(sql)) return { results: hist.filter((h) => h.hkey === a[0]).sort((x, y) => (x.observed_at < y.observed_at ? 1 : -1)).slice(0, a[1]).map(({ hkey, ...r }) => r) };
              if (/WHERE pub_url IS NOT NULL ORDER BY/.test(sql)) {
                const out = rows.filter((r) => r.pub_url).sort((x, y) => (x.created_at === y.created_at ? (x.id < y.id ? 1 : -1) : x.created_at < y.created_at ? 1 : -1));
                return { results: out.slice(0, a[0]) };
              }
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
              if (/MIN\(created_at\) AS first_seen/.test(sql)) { const m = rows.filter((r) => (r.url >= a[0] && r.url < a[1]) || (r.url >= a[2] && r.url < a[3])).map((r) => r.created_at).sort()[0]; return { first_seen: m || null }; }
              if (/COUNT\(\*\) AS n/.test(sql)) {
                const d = rows.filter((r) => r.pub_day === a[2] && r.pub_url);
                const pre = a[1].slice(0, -1);
                return { n: d.length, same: d.filter((r) => r.pub_url === a[0]).length, host: d.filter((r) => r.pub_url.startsWith(pre)).length };
              }
              if (/WHERE id = \?/.test(sql)) return rows.find((r) => r.id === a[0]) || null;
              if (/WHERE norm_key = \?/.test(sql)) return rows.filter((r) => r.norm_key === a[0] && r.probed_at >= a[1]).sort((x, y) => (x.probed_at < y.probed_at ? 1 : -1))[0] || null;
              if (/WHERE url = \?/.test(sql)) return rows.map((r, i) => [r, i]).filter(([r]) => r.url === a[0]).sort(([x, i], [y, j]) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : /rowid DESC/.test(sql) ? j - i : 0)).map(([r]) => r)[0] || null;
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
  assert.equal(JSON.parse(db.rows[0].body).client, "rcpt-client-1", "the explicit client param is stored (0.42.3); an IP-derived id never is");
  const unpaid = await send(t, { envo: e });
  assert.equal(unpaid.status, 402);
  assert.equal(db.rows.length, 1, "a 402 (no decision delivered) stores nothing");
  const got = await send("/v1/receipts/" + free.body.receipt_id, { envo: e });
  assert.equal(got.status, 200);
  assert.ok(!("client" in got.body) && !JSON.stringify(got.body).includes("rcpt-client-1"), "receipts never expose the client id publicly");
  assert.equal(got.body.url, "https://spot.target.test/api");
  assert.equal(got.body.verdict, "pay");
  assert.equal(got.body.reason, "price_ok");
  assert.match(got.body.checked_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  // 0.24.0: an outside free receipt is redacted (terms + approved payment are the paid check); D1 keeps the full body
  assert.deepEqual(got.body.live_402, { http_status: 402, x402_challenge: true, accepts_count: 1, error: null, free_trial: null });
  assert.equal(got.body.approved_payment, null);
  assert.equal(got.body.access_tier, "free");
  assert.ok(!JSON.stringify(got.body).includes(PAY_TO) && !JSON.stringify(got.body).includes("probe_snapshot"));
  assert.ok(db.rows[0].body.includes(PAY_TO), "stored body stays full (cache + paid view)");
  assert.equal(got.body.payment_terms_sha256, free.body.payment_terms_sha256);
  // a later decision for the same URL becomes the latest
  await new Promise((r) => setTimeout(r, 1100));
  const later = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=0.0001&client=withgrokbot-selftest", { envo: e });
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

test("router tier: allowlisted router pays $0.20 for a 10-check pack ($0.02/check, 0.38.0), one settlement; credits then spent; others unchanged", async () => {
  const e = spotEnv({ SPOT_ROUTER_CLIENTS: "router-test-1", SPOT_PARTNER_CLIENTS: "router-test-1:1" });
  facCalls.length = 0;
  facMode = "ok";
  spotTargetMode = "402";
  const T = SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=router-test-1";
  assert.equal((await send(T, { envo: e })).body.access.tier, "partner", "partner pool first");
  assert.equal((await send(T, { envo: e })).body.access.tier, "free", "then the daily free check");
  const unpaid = await send(T, { envo: e });
  assert.equal(unpaid.status, 402);
  assert.equal(unpaid.body.accepts[0].amount, "200000");
  assert.match(unpaid.body.error, /buys 10 checks \(\$0\.02\/check\)/);
  assert.match(unpaid.body.pricing, /router tier/);
  const paid = await send(T, { envo: e, headers: { "payment-signature": spotPayment({ amount: "200000" }) } });
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
  assert.equal((await send(T, { envo: e, headers: { "payment-signature": spotPayment({ amount: "250000" }) } })).status, 402);
  // non-router clients pay the flat $0.02
  await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=not-a-router", { envo: e });
  const other = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=not-a-router", { envo: e });
  assert.match(other.body.pricing, /flat \$0\.02/);
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
  const r = await send(u + "&mode=dry-run&ref=via-agentkit&client=dry-client-1", { envo: e, headers: { "payment-signature": spotPayment({ amount: "20000" }) } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["access", "check_type", "confidence", "history", "mode", "payment_terms_sha256", "prior_checks", "quality", "reason", "reason_code", "receipt_id", "receipt_url", "reputation", "verdict"]);
  assert.equal(r.body.prior_checks, "https://402xagent.com/v1/skips");
  assert.equal(r.body.mode, "dry-run");
  assert.equal(r.body.verdict, "pay");
  assert.equal(r.body.reason, "listed $0.001, payment request matches the listed price");
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
  assert.deepEqual(rec.listing, { source: "request" }); // 0.24.0: outside dry runs are redacted
  assert.deepEqual(rec.live_demand, { http_status: 402, x402_challenge: true, schemes: ["exact"] });
  assert.deepEqual([rec.verdict, rec.reason, rec.ref, rec.caller, rec.approved_payment, rec.payment_terms_sha256], ["pay", "price_ok", "via-agentkit", "via-agentkit", null, null]);
  assert.match(rec.checked_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(!db.rows[0].body.includes("203.0.113"), "no IP in the receipt"); assert.equal(JSON.parse(db.rows[0].body).client, "dry-client-1", "0.42.3: explicit client recorded");
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
  assert.deepEqual(labels, [["self-checked", "live"], ["self-checked", "live"], ["live", "live"]]); // 0.42.3: a live outside check is labelled live
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
  const sk = await worker.fetch(new Request("https://402xagent.com/v1/skips", { headers: { accept: "text/html" } }), e.env, { waitUntil() {} });
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
  for (const re of [/<h1>Check before your <span class="grad">agent pays<\/span><\/h1>/, /og:title" content="402xAgent/, /rel="canonical" href="https:\/\/402xagent.com\/"/, /og:url" content="https:\/\/402xagent.com\/"/, /id="try"/, /wrapFetchWithPayment\(spotCheckFetch\(fetch\), client\)/, /wrapAxiosWithPayment\(spotCheckAxios\(axios.create\(\)\), client\)/, /class="bigprice">5 free checks a day, from \$0\.02<\/h2>/, /\$0\.02 a check<\/b>, any target price/, /\$0\.02\/check<\/b> in packs of 10, billed as one \$0\.20/, /<details class="sample" id="resp">\s*<summary>Show response<\/summary>/, /Stops your agent paying dead, mispriced or wrong-network endpoints/, /href="\/mcp"/, /href="\/llms.txt"/, /href="\/openapi.json"/, /href="\/v1\/skips"/, /curl &quot;https:\/\/api\.402xagent\.com\/v1\/products\/endpoint-spot-check/])
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

test("free check is the front door (0.20.0): 402s point to it, free answers carry prior_checks, docs lead with it", async () => {
  const e = spotEnv({ RECEIPTS_DB: fakeD1() });
  const FC = "https://api.402xagent.com/v1/products/endpoint-spot-check?url=<endpoint>";
  const get = (u, init = {}) => worker.fetch(new Request(u, { method: init.method || "GET", headers: { "user-agent": "agent-y/1.0", "cf-connecting-ip": "203.0.113.9", ...(init.headers || {}) }, body: init.body }), e.env, { waitUntil() {} });
  const decode = (r) => JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString());
  for (const [u, init] of [["https://api.402xagent.com/v1/lookup/paid?task=web-search&max_price=0.05"], ["https://api.402xagent.com/v1/products/overnight-cos-pack"], ["https://api.402xagent.com/v1/products/overnight-cos-pack", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }]]) {
    const r = await get(u, init);
    assert.equal(r.status, 402, u);
    const b = await r.json(), h = decode(r);
    assert.equal(b.x402Version, 2); assert.ok(Array.isArray(b.accepts) && b.accepts[0].payTo && b.resource.url, "still valid x402 v2");
    assert.equal(b.free_check.url, FC, u);
    assert.ok(b.error.includes("Free check first: " + FC), "error text: " + b.error);
    assert.ok(h.error.includes(FC), "PAYMENT-REQUIRED error text");
    assert.deepEqual(h.accepts, b.accepts);
  }
  // check route after the free quota: 402 names the free check, this endpoint's URL and a dry run that works now
  const T = "https://seller.real/api/x";
  const first = await get("https://api.402xagent.com/v1/products/endpoint-spot-check?url=" + encodeURIComponent(T) + "&client=fd-1");
  assert.equal(first.status, 200);
  const fb = await first.json();
  assert.equal(fb.prior_checks, "https://402xagent.com/v1/skips");
  const second = await get("https://api.402xagent.com/v1/products/endpoint-spot-check?url=" + encodeURIComponent(T) + "&client=fd-1");
  assert.equal(second.status, 402);
  const sb = await second.json();
  assert.ok(sb.error.includes(FC) && /dry-run/.test(sb.error), sb.error);
  assert.equal(sb.free_check.this_endpoint, "https://api.402xagent.com/v1/products/endpoint-spot-check?url=" + encodeURIComponent(T));
  assert.equal(sb.free_check.dry_run_now, sb.free_check.this_endpoint + "&mode=dry-run");
  assert.ok(decode(second).error.includes(FC));
  // free lookup carries prior_checks; paid/exempt shapes untouched
  const fl = await (await get("https://api.402xagent.com/v1/lookup?task=web-search&max_price=0.05&client=fd-2")).json();
  assert.equal(fl.access.tier, "free"); assert.equal(fl.prior_checks, "https://402xagent.com/v1/skips");
  const ex = await (await get("https://api.402xagent.com/v1/lookup?task=web-search&max_price=0.05&client=withgrokbot")).json();
  assert.ok(!("prior_checks" in ex), "exempt answer unchanged");
  // docs lead with the free check
  const llms = await (await get("https://api.402xagent.com/llms.txt")).text();
  assert.ok(llms.split("\n").slice(0, 6).join("\n").includes("Start with the free check: GET " + FC), llms.slice(0, 300));
  assert.ok(llms.indexOf(FC) < llms.indexOf("paid check"));
  const oa = await (await get("https://api.402xagent.com/openapi.json")).json();
  assert.ok(oa.info.description.startsWith("Start free: GET " + FC));
  const wk = await (await get("https://api.402xagent.com/.well-known/x402")).json();
  assert.equal(wk.free_check.url, FC);
  assert.ok(wk.resources.every((x) => typeof x === "string") && wk.payment.x402.networks[0] === "eip155:8453", "parsers' fields unchanged");
  const sj = await (await get("https://api.402xagent.com/v1/skips.json")).json();
  assert.equal(Object.keys(sj)[0], "free_check"); assert.equal(sj.free_check.url, FC);
  const sh = await (await get("https://402xagent.com/v1/skips", { headers: { accept: "text/html" } })).text();
  assert.ok(sh.indexOf("Check your endpoint free first") > 0 && sh.indexOf("Check your endpoint free first") < sh.indexOf("endpoints covered"));
  const home = await (await get("https://402xagent.com/", { headers: { accept: "text/html" } })).text();
  const hero = home.slice(home.indexOf('<div class="hero">'), home.indexOf('id="try"'));
  assert.ok(hero.includes("GET " + FC.replace("<", "&lt;").replace(">", "&gt;")) && hero.includes("&quot;verdict&quot;:&quot;pay&quot;"), "hero shows the free URL + example");
  assert.ok(hero.indexOf("endpoint-spot-check?url=") < hero.indexOf("paid check"));
});

test("agent-tools.cloud ownership token: per-host config only; unset serves nothing; never redirected", async () => {
  const H = "https://verified-catalog-lookup.withgrokbot.workers.dev";
  const go = (e, u, accept = "text/html,*/*") => worker.fetch(new Request(u, { headers: { accept } }), e.env, { waitUntil() {} });
  const off = spotEnv();
  assert.equal((await go(off, H + "/.well-known/agent-tools-verify.txt")).status, 404);
  assert.ok(!("agentToolsVerify" in (await (await go(off, H + "/.well-known/x402")).json())));
  const tok = "atc_R7xK2mQ9pL4vB8nT6wZ3yF5c";
  const on = spotEnv({ AGENT_TOOLS_VERIFY: JSON.stringify({ "verified-catalog-lookup.withgrokbot.workers.dev": tok }) });
  const f = await go(on, H + "/.well-known/agent-tools-verify.txt");
  assert.equal(f.status, 200);
  assert.equal(await f.text(), tok + "\n");
  const wk = await (await go(on, H + "/.well-known/x402")).json();
  assert.equal(wk.agentToolsVerify, tok);
  assert.ok(Array.isArray(wk.resources) && wk.payment.x402.networks.length === 1, "x402 descriptor otherwise unchanged");
  assert.equal((await go(on, "https://api.402xagent.com/.well-known/agent-tools-verify.txt")).status, 404, "other hosts need their own token");
  assert.ok(!("agentToolsVerify" in (await (await go(on, "https://api.402xagent.com/.well-known/x402")).json())));
  // the real tokens from wrangler.toml: top-level, each only on its own host
  const toml = (await import("node:fs")).readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
  const map = JSON.parse(toml.match(/^AGENT_TOOLS_VERIFY = '(.*)'$/m)[1]);
  const real = spotEnv({ AGENT_TOOLS_VERIFY: JSON.stringify(map) });
  assert.deepEqual(Object.keys(map).sort(), ["api.402xagent.com", "verified-catalog-lookup.withgrokbot.workers.dev"]);
  for (const [host, t] of Object.entries(map)) {
    const w = await (await go(real, "https://" + host + "/.well-known/x402", "*/*")).json();
    assert.equal(w.agentToolsVerify, t, host);
    assert.equal(await (await go(real, "https://" + host + "/.well-known/agent-tools-verify.txt")).text(), t + "\n");
    for (const other of ["402xagent.com", "payscout.dev", "api.payscout.dev", ...Object.keys(map).filter((h) => h !== host)]) {
      const o = await (await go(real, "https://" + other + "/.well-known/x402", "*/*")).text();
      assert.ok(!o.includes(t), t + " must not show on " + other);
    }
  }
  const bad = spotEnv({ AGENT_TOOLS_VERIFY: "{not json" });
  assert.equal((await go(bad, H + "/.well-known/agent-tools-verify.txt")).status, 404);
});

test("0.22.0: 400s name the mistake + a copy-pasteable fixed free check; /v1/skips JSON unless Accept text/html; verdict/shape/host analytics", async () => {
  const R = "https://api.402xagent.com/v1/products/endpoint-spot-check";
  const ok = (b) => assert.equal(b.docs, "https://api.402xagent.com/openapi.json");
  const e = spotEnv();
  // bare call -> real example
  let r = await send(SPOT, { envo: e, ua: "node", headers: { "x-payment": "x" } });
  assert.equal(r.status, 200); assert.equal(r.body.mistake, "no_params"); ok(r.body); // 0.26.1: usage/health GET
  assert.deepEqual(r.body.fixed_example, { method: "GET", url: R + "?url=https://api.402rates.com/v1/ping" });
  assert.equal(r.points.at(-1).blobs[16], "no_params"); assert.equal(r.points.at(-1).blobs[17], "GET||");
  assert.equal(r.points.at(-1).blobs[19], "lookup.test");
  // cb= alone is not "an unknown param"
  r = await send(SPOT + "?cb=123", { envo: e, headers: { "x-payment": "x" } });
  assert.equal(r.body.mistake, "no_params"); assert.ok(!r.body.error.includes('"cb"'));
  // wrong param name -> their value moved to url=, encoded (query string preserved)
  const tv = "https://api.example.org/v1/quote?sym=ETH&n=2";
  r = await send(SPOT + "?link=" + encodeURIComponent(tv), { envo: e });
  assert.equal(r.body.mistake, "wrong_param_name"); assert.match(r.body.hint, /"link"/);
  assert.equal(r.body.fixed_example.url, R + "?url=" + encodeURIComponent(tv));
  assert.equal(new URL(r.body.fixed_example.url).searchParams.get("url"), tv);
  assert.equal(r.points.at(-1).blobs[17], "GET||link");
  // no scheme -> https:// added
  r = await send(SPOT + "?url=api.example.org/v1/ping", { envo: e });
  assert.equal(r.body.mistake, "url_missing_scheme"); assert.equal(r.body.fixed_example.url, R + "?url=" + encodeURIComponent("https://api.example.org/v1/ping"));
  r = await send(SPOT + "?url=notaurl", { envo: e });
  assert.equal(r.body.mistake, "url_not_http"); assert.equal(r.body.fixed_example.url, R + "?url=https://api.402rates.com/v1/ping");
  // POST JSON wrong field -> right JSON body
  r = await send(SPOT, { envo: e, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target_url: "https://api.example.org/x" }) });
  assert.equal(r.body.mistake, "post_wrong_field");
  assert.deepEqual(r.body.fixed_example, { method: "POST", url: R, headers: { "content-type": "application/json" }, body: { url: "https://api.example.org/x" } });
  assert.equal(r.points.at(-1).blobs[17], "POST|application/json|body:target_url");
  // POST form body -> JSON body with their value
  r = await send(SPOT, { envo: e, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "url=" + encodeURIComponent("https://api.example.org/y") });
  assert.equal(r.body.mistake, "post_form_body"); assert.deepEqual(r.body.fixed_example.body, { url: "https://api.example.org/y" });
  r = await send(SPOT, { envo: e, method: "POST", headers: { "content-type": "application/json", "x-payment": "x" }, body: "{}" });
  assert.equal(r.body.mistake, "no_params"); assert.equal(r.body.fixed_example.method, "POST");
  r = await send(SPOT + "?url=https://a.test/x&claimed_price=abc", { envo: e });
  assert.equal(r.body.mistake, "bad_claimed_price"); assert.equal(r.body.fixed_example.url, R + "?url=" + encodeURIComponent("https://a.test/x"));
  r = await send(SPOT, { envo: e, method: "PUT" });
  assert.equal(r.body.mistake, "http_method");
  // verdict mix + unencoded inner query logged on a 200 (answer unchanged)
  spotTargetMode = "402";
  const e2 = spotEnv({ RECEIPTS_DB: fakeD1() });
  r = await send(SPOT + "?url=https://spot.target.test/api?a=1&b=2&client=withgrokbot-selftest", { envo: e2 });
  assert.equal(r.status, 200);
  const p = r.points.at(-1);
  assert.equal(p.blobs[18], r.body.verdict); assert.ok(["pay", "skip", "recheck"].includes(p.blobs[18]));
  assert.equal(p.blobs[16], "url_query_unencoded"); assert.equal(p.blobs[17], "GET||b,client,url");
  // dry runs carry the verdict too
  r = await send(SPOT + "?mode=dry-run&url=" + encodeURIComponent("https://spot.target.test/api") + "&client=someone", { envo: e2 });
  assert.equal(r.status, 200); assert.equal(e2.points.at(-1).blobs[18], r.body.verdict);
  // host blob on views (funnel)
  const e3 = spotEnv();
  const wu = [];
  await worker.fetch(new Request("https://402xagent.com/", { headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } }), e3.env, { waitUntil(p) { wu.push(p); } });
  await Promise.all(wu);
  assert.equal(e3.points.at(-1).blobs[12], "view-docs-home"); assert.equal(e3.points.at(-1).blobs[19], "402xagent.com");
  // /v1/skips negotiation
  const sk = async (h, q = "") => worker.fetch(new Request("https://402xagent.com/v1/skips" + q, { headers: h }), e3.env, { waitUntil() {} });
  for (const h of [{ accept: "*/*" }, {}, { accept: "application/json" }, { accept: "text/plain" }]) {
    const x = await sk(h);
    assert.match(x.headers.get("content-type"), /application\/json/, JSON.stringify(h));
    const b = await x.json(); assert.ok(Array.isArray(b.skips) && b.free_check, JSON.stringify(h));
  }
  const br = await sk({ accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
  assert.match(br.headers.get("content-type"), /text\/html/); assert.equal(br.headers.get("vary"), "accept");
  assert.match((await sk({ accept: "text/html" }, "?format=json")).headers.get("content-type"), /application\/json/);
});

test("0.23.0 Solana: SVM 402s read like Base (network, mint, pay_to, scheme, price); same skip rules; devnet = testnet rule; cached", async () => {
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", DEV = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", PT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const e = spotEnv({ RECEIPTS_DB: fakeD1() });
  const chk = (k, extra = "", client = "withgrokbot-selftest") => send(SPOT + "?url=" + encodeURIComponent("https://sol.target.test/" + k) + "&client=" + client + extra, { envo: e });
  // good: pay; payment object = network, mint, amount (6 decimals), pay_to, deadline; Solana extras only gained
  const g = await chk("good", "&claimed_price=0.01");
  assert.deepEqual([g.body.verdict, g.body.reason], ["pay", "price_ok"]);
  const dl = new Date(Date.parse(g.body.probe.probed_at) + 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
  assert.deepEqual(g.body.payment, { network: SOL, asset: MINT, amount: { atomic: "10000", usd: 0.01 }, pay_to: PT, deadline: dl, deadline_source: "maxTimeoutSeconds", scheme: "exact", amount_atomic: "10000", amount_usd: 0.01, asset_is_usdc: true, chain: "solana", mint: MINT, decimals: 6, fee_payer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" });
  const rc = (await send("/v1/receipts/" + g.body.receipt_id, { envo: e })).body;
  assert.deepEqual(rc.live_402.accepts[0], { scheme: "exact", network: SOL, asset: MINT, amount_atomic: "10000", pay_to: PT, asset_is_usdc: true, amount_usd: 0.01, chain: "solana", mint: MINT, decimals: 6, fee_payer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" });
  // same URL again: same verdict from the cached probe
  const g2 = await chk("good", "&claimed_price=0.01");
  assert.deepEqual([g2.body.verdict, g2.body.reason, g2.body.probe.cached, g2.body.probe.probed_at], ["pay", "price_ok", true, g.body.probe.probed_at]);
  // v1 name "solana" + maxAmountRequired, listing network given as the CAIP-2 id
  const v1 = await chk("v1", "&network=" + encodeURIComponent(SOL));
  assert.equal(v1.body.verdict, "pay"); assert.equal(v1.body.payment.network, "solana"); assert.equal(v1.body.payment.amount.usd, 0.01);
  // wrong mint (USDT) and a case-changed USDC mint (base58 is case-sensitive)
  assert.deepEqual([(await chk("wrongmint")).body.reason, (await chk("lowermint")).body.reason], ["asset_not_usdc", "asset_not_usdc"]);
  // devnet vs a mainnet listing -> network_mismatch; devnet with no listing -> network_unsupported (same as Base Sepolia)
  assert.deepEqual([(await chk("devnet", "&network=" + encodeURIComponent(SOL))).body.reason], ["network_mismatch"]);
  const dv = await chk("devnet", "&cb=2");
  assert.deepEqual([dv.body.verdict, dv.body.reason], ["skip", "network_unsupported"]);
  const dvr = (await send("/v1/receipts/" + dv.body.receipt_id, { envo: e })).body.live_402.accepts[0];
  assert.deepEqual([dvr.testnet, dvr.asset_is_usdc, dvr.mint], [true, true, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"]);
  // pay_to mismatch vs the listing, incl. a case-only difference
  assert.equal((await chk("good", "&pay_to=" + "So1anaWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX")).body.reason, "pay_to_mismatch");
  assert.equal((await chk("good", "&pay_to=" + PT.toLowerCase())).body.reason, "pay_to_mismatch");
  assert.equal((await chk("good", "&pay_to=" + PT + "&network=solana")).body.verdict, "pay");
  // upto: amount is the maximum; price is checked against it
  const up = await chk("upto", "&claimed_price=0.05");
  assert.deepEqual([up.body.verdict, up.body.payment.scheme, up.body.payment.amount_kind, up.body.payment.amount.usd], ["pay", "upto", "max", 0.05]);
  assert.equal((await chk("upto", "&claimed_price=0.01")).body.reason, "price_mismatch");
  // free tier: still only verdict + short reason + prior_checks + receipt link
  const f = await chk("good", "", "sol-free-1");
  assert.equal(f.body.access.tier, "free"); assert.equal(f.body.payment, undefined); assert.equal(f.body.prior_checks, "https://402xagent.com/v1/skips");
  assert.doesNotMatch(JSON.stringify(f.body), /9xQeWvG8|EPjFWdd5|feePayer|fee_payer/);
  // our own rail stays Base USDC
  const pr = await send(SPOT + "?url=" + encodeURIComponent("https://sol.target.test/good") + "&client=sol-free-1", { envo: e });
  assert.equal(pr.status, 402); assert.ok(pr.body.accepts.every((a) => a.network === "eip155:8453"));
  // constants match the published @x402/svm SDK when it is installed (SVM_SDK_DIR=<dir with node_modules/@x402/svm>)
  const L = await import("../worker/src/lib.js");
  assert.equal(L.USDC_SOLANA_MAINNET, MINT);
  if (process.env.SVM_SDK_DIR) {
    const { createRequire } = await import("node:module");
    const sdk = createRequire(process.env.SVM_SDK_DIR + "/")("@x402/svm");
    assert.deepEqual([L.SOLANA_MAINNET_CAIP2, L.SOLANA_DEVNET_CAIP2, L.USDC_SOLANA_MAINNET, L.USDC_SOLANA_DEVNET], [sdk.SOLANA_MAINNET_CAIP2, sdk.SOLANA_DEVNET_CAIP2, sdk.USDC_MAINNET_ADDRESS, sdk.USDC_DEVNET_ADDRESS]);
    assert.deepEqual([L.caip("solana"), L.caip("solana-devnet")], [sdk.V1_TO_V2_NETWORK_MAP.solana.toLowerCase(), sdk.V1_TO_V2_NETWORK_MAP["solana-devnet"].toLowerCase()]);
    console.log("  (Solana constants pinned against the installed @x402/svm)");
  }
});

test("0.23.1: upto on Solana only (Base upto-only stays skip/bad_challenge); terms hash: Base pinned, Solana base58 case kept", async () => {
  // Base/EVM regression: an upto-only 402 is exactly as before 0.23.0
  const e = spotEnv({ RECEIPTS_DB: fakeD1() });
  spotTargetMode = "upto";
  const b = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/upto-only") + "&client=withgrokbot-selftest", { envo: e });
  spotTargetMode = "402";
  assert.deepEqual([b.body.verdict, b.body.reason, b.body.payment, b.body.payment_terms_sha256], ["skip", "bad_challenge", null, null]);
  const br = (await send("/v1/receipts/" + b.body.receipt_id, { envo: e })).body.live_402.accepts[0];
  assert.deepEqual(Object.keys(br).sort(), ["amount_atomic", "asset", "network", "pay_to", "scheme"], "EVM accept rows gain nothing");
  for (const n of ["eip155:8453", "base", "eip155:1", "eip155:84532", "base-sepolia"])
    assert.equal(pickPayment({ accepts: [{ scheme: "upto", network: n, amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x" + "1".repeat(40) }] }, {}), null, n);
  assert.equal(pickPayment({ accepts: [{ scheme: "upto", network: "solana", amount: "1000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" }] }, {}).amount_kind, "max");
  // v1 names equal the full ids
  const L = await import("../worker/src/lib.js");
  assert.deepEqual([L.caip("solana"), L.caip("solana-devnet"), L.caip("base"), L.caip("base-sepolia")], ["solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp", "solana:etwtrabzayq6imfeykouru166vu2xqa1", "eip155:8453", "eip155:84532"]);
  // Base hash pinned (api.402rates.com/v1/ping, live 2026-10-11 before and after 0.23.1)
  const base = { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount_atomic: "1000", pay_to: "0xf567Cfe0FDb87A1D6Ca330e3f30f0D3DA0F7cb98" };
  assert.equal(await termsSha256(base), "6ddcc14caebdf8cf0f7eb183c0916b2dc2d36500875d99d039c81e4ea5f2844e");
  assert.equal(await termsSha256({ ...base, asset: base.asset.toLowerCase(), pay_to: base.pay_to.toUpperCase().replace("0X", "0x") }), "6ddcc14caebdf8cf0f7eb183c0916b2dc2d36500875d99d039c81e4ea5f2844e", "EVM stays case-insensitive");
  // Solana: mint and pay_to hashed as-is; a case change is a different payment
  const sol = { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount_atomic: "5000", pay_to: "GLu63pRCYrp4BJu5P5ciYKxgeZFW9c8TJ8jWzK3TB9AR" };
  const h = await termsSha256(sol);
  assert.equal(h, createHash("sha256").update("solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp|EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v|5000|GLu63pRCYrp4BJu5P5ciYKxgeZFW9c8TJ8jWzK3TB9AR").digest("hex"));
  assert.notEqual(await termsSha256({ ...sol, asset: sol.asset.toLowerCase() }), h);
  assert.notEqual(await termsSha256({ ...sol, pay_to: sol.pay_to.toLowerCase() }), h);
  // live path: the Solana fixture's free-tier hash is the case-kept one
  const f = await send(SPOT + "?url=" + encodeURIComponent("https://sol.target.test/good") + "&client=sol-hash-1", { envo: e });
  assert.equal(f.body.payment_terms_sha256, await termsSha256({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount_atomic: "10000", pay_to: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" }));
});

test("0.24.0: outside free/dry-run receipts redacted in every view; paid/exempt full; query + fragment never stored or shown", async () => {
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db });
  spotTargetMode = "402";
  const T = "https://spot.target.test/q?api_key=SECRET123&u=me#frag";
  const free = await send(SPOT + "?url=" + encodeURIComponent(T) + "&claimed_price=0.001&client=outside-1", { envo: e });
  assert.equal(free.body.access.tier, "free");
  const row = db.rows.at(-1);
  assert.equal(row.url, "https://spot.target.test/q");
  assert.ok(!row.body.includes("SECRET123") && !row.body.includes("frag"), "no query/fragment stored anywhere");
  assert.match(row.norm_key, /^k:[0-9a-f]{64}$/);
  const hide = (o, why) => { const t = JSON.stringify(o); assert.ok(!t.includes(PAY_TO) && !/amount_atomic|probe_snapshot|norm_key|SECRET123/.test(t), why + ": " + t.slice(0, 300)); };
  const one = (await send("/v1/receipts/" + free.body.receipt_id, { envo: e })).body;
  hide(one, "by id");
  assert.deepEqual([one.verdict, one.reason, one.reason_text, one.approved_payment, one.url], ["pay", "price_ok", "payment request matches the listed price", null, "https://spot.target.test/q"]);
  assert.match(one.redacted, /paid check/);
  hide((await send("/v1/receipts?type=dry-run", { envo: e })).body, "type list");
  const by = (await send("/v1/receipts/by-url?url=" + encodeURIComponent(T), { envo: e })).body;
  assert.equal(by.latest_live.id, free.body.receipt_id, "by-url finds it with the query stripped");
  hide(by.latest_live, "by-url");
  // the cache still works on the hashed key; another query is another key
  const ex = await send(SPOT + "?url=" + encodeURIComponent(T) + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(ex.body.probe.cached, true);
  const ex2 = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/q?api_key=OTHER") + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(ex2.body.probe.cached, false);
  // exempt/self receipt stays full
  const full = (await send("/v1/receipts/" + ex.body.receipt_id, { envo: e })).body;
  assert.equal(full.live_402.accepts[0].pay_to, PAY_TO); assert.equal(full.approved_payment.pay_to, PAY_TO); assert.equal(full.redacted, undefined);
  assert.equal(full.url, "https://spot.target.test/q");
  // paid / router-prepaid full; legacy rows without a tier: full only when self
  const { redactReceipt } = await import("../worker/src/lib.js");
  const body = JSON.parse(db.rows.find((r) => r.id === free.body.receipt_id).body);
  for (const tier of ["paid", "router-prepaid"]) assert.deepEqual(redactReceipt({ ...body, access_tier: tier }), { ...body, access_tier: tier });
  const legacy = { ...body, access_tier: undefined, check_type: "live" };
  assert.equal(redactReceipt(legacy).approved_payment, null);
  assert.equal(redactReceipt({ ...legacy, caller: "self-test" }).approved_payment.pay_to, PAY_TO);
  // MCP receipt reads go through the same view
  const m = await send("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_receipt", arguments: { id: free.body.receipt_id } } }), envo: e });
  if (m.body && m.body.result && !m.body.result.isError) assert.ok(!JSON.stringify(m.body).includes(PAY_TO), "mcp view redacted");
});

test("0.25.0: recent_checks in /v1/skips.json: outside free checks only, URL path only, no price/terms; deduped; capped", async () => {
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db });
  spotTargetMode = "402";
  let n = 0;
  const chk = (u, extra = "", o = {}) => send(SPOT + "?url=" + encodeURIComponent(u) + "&claimed_price=0.001" + (extra.includes("client=") ? "" : "&client=outside-" + ++n) + extra, { envo: e, ...o });
  const R = "https://api.realx402.dev/v1/quote";
  const a = await chk(R + "?api_key=SECRET999#x");
  assert.equal(a.body.upsell, "Full 402 details (exact payment terms, pay_to, deadline) for this endpoint for $0.02");
  await chk(R); // same URL, same UTC day: deduped
  // not published: junk, tests, bots, secrets
  await chk("https://example.com/api/paid");
  await chk("https://httpbin.org/status/402");
  await chk("https://api.realx402.dev/a", "&client=withgrokbot-selftest");
  await chk("https://api.realx402.dev/b", "&client=wgb-test-1");
  await chk("https://api.realx402.dev/b2", "&client=outside-verify-2"); // 0.25.1: our verification clients
  await chk("https://api.realx402.dev/c", "&ref=via-402xagent-site");
  await chk("https://api.realx402.dev/d", "&mode=dry-run");
  await chk("https://api.realx402.dev/e", "", { ua: "PayAI-Bazaar-Indexer/1.0" });
  await chk("https://api.realx402.dev/key/abc", "");
  await chk("https://api.realx402.dev/v1/Zx9Qr7Lm2Kp8Vt4Wn6Yb3Hc5", "");
  await chk("https://user:pw@api.realx402.dev/f", "");
  const sk = (await send("/v1/skips.json", { envo: e })).body;
  assert.ok(Array.isArray(sk.skips) && "endpoints_covered" in sk, "existing structure unchanged");
  assert.equal(sk.recent_checks.length, 1, JSON.stringify(sk.recent_checks));
  const x = sk.recent_checks[0];
  assert.deepEqual(Object.keys(x), ["url", "verdict", "reason", "checked_at", "receipt_url", "caller"]);
  assert.deepEqual([x.url, x.verdict, x.reason, x.caller, x.receipt_url], [R, "pay", "payment request matches the listed price", "outside", "https://402xagent.com/v1/receipts/" + a.body.receipt_id]);
  assert.match(x.checked_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const txt = JSON.stringify(sk.recent_checks);
  assert.ok(!/SECRET999|0\.001|\$|0x[0-9a-fA-F]{40}|sha256|eip155/.test(txt), txt);
  // the linked receipt is the redacted view
  const rc = (await send("/v1/receipts/" + a.body.receipt_id, { envo: e })).body;
  assert.equal(rc.approved_payment, null); assert.ok(rc.redacted);
  // per-host cap: 5 per host per UTC day
  for (let i = 0; i < 7; i++) await chk("https://other.realx402.dev/p" + i);
  const sk2 = (await send("/v1/skips?format=json", { envo: e })).body.recent_checks;
  assert.equal(sk2.filter((r) => r.url.startsWith("https://other.realx402.dev/")).length, 5);
  // recheck verdicts count too; the free answer is otherwise unchanged
  spotTargetMode = "timeout";
  const t = await chk("https://api.realx402.dev/slow");
  spotTargetMode = "402";
  assert.equal(t.body.verdict, "recheck");
  assert.ok((await send("/v1/skips.json", { envo: e })).body.recent_checks.some((r) => r.url === "https://api.realx402.dev/slow" && r.verdict === "recheck"));
  // 0.25.1: a row retagged self-checked stays listed with caller "self-checked"
  const row = db.rows.find((r) => r.id === a.body.receipt_id); row.check_type = "self-checked";
  assert.equal((await send("/v1/skips.json", { envo: e })).body.recent_checks.find((r) => r.receipt_url.endsWith(a.body.receipt_id)).caller, "self-checked");
  row.check_type = "dry-run";
  // unit: URL privacy rules
  const { publicUrl, secretLike } = await import("../worker/src/recent.js");
  assert.equal(publicUrl("https://API.Real.dev:8443/a/b/?q=1#f"), "https://api.real.dev:8443/a/b");
  for (const bad of ["https://u@x.dev/a", "http://10.0.0.1/a", "https://x.dev/t/eyJhbGciOiJIUzI1NiJ9.e30.x", "https://x.dev/sk_live_abcdef123456", "https://x.dev/" + "a1".repeat(20), "https://x.dev/token/abc", "https://localhost/a", "https://foo.example.org/a"])
    assert.equal(publicUrl(bad), null, bad);
  assert.equal(secretLike("v1"), false); assert.equal(secretLike("polymarket-positions"), false);
});

test("0.26.0: /bazaar: daily cron checks Bazaar results as self-checked, redacted receipts, no query strings, off switch", async () => {
  const db = fakeD1();
  const store = new Map();
  const kv = { get: async (k, t) => (store.has(k) ? (t === "json" ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => { store.set(k, v); } };
  const e = spotEnv({ RECEIPTS_DB: db, CRAWL_KV: kv });
  spotTargetMode = "402";
  const empty = await send("/bazaar.json", { envo: e });
  assert.equal(empty.status, 200); assert.equal(empty.body.rows.length, 0);
  const orig = globalThis.fetch; let searches = 0, other = 0;
  globalThis.fetch = async (u, init) => {
    if (String(u).startsWith("https://api.cdp.coinbase.com/platform/v2/x402/discovery/search")) {
      searches++;
      const q = new URL(String(u)).searchParams.get("query");
      const res = Array.from({ length: 14 }, (_, i) => ({ resource: `https://api.realx402.dev/${q.split(" ")[0]}/${i}?key=SECRET1`, serviceName: "S" + i, extensions: { bazaar: { info: { input: { method: i === 1 ? "POST" : "GET" } } } }, accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000", payTo: "0x" + "aa".repeat(20) }] }));
      res.push({ resource: "https://example.com/x" }, { resource: "https://api.realx402.dev/p/:address" }, { resource: "https://api.realx402.dev/p/{id}" }, { resource: "https://api.realx402.dev/weather/0" });
      return Response.json({ resources: res });
    }
    other++;
    return orig(u, init);
  };
  try {
    const ctx = { waitUntil() {} };
    let steps = 0;
    do { await worker.scheduled({ scheduledTime: Date.now() }, e.env, ctx); steps++; } while (JSON.parse(store.get("bazaar:v1")).build && steps < 20);
    assert.equal(searches, 3);
    assert.ok(steps <= 6, "steps " + steps);
    other = 0; await worker.scheduled({ scheduledTime: Date.now() }, e.env, ctx);
    assert.equal(searches, 3); assert.equal(other, 0, "idle step makes no subrequests");
  } finally { globalThis.fetch = orig; }
  const j = (await send("/bazaar.json", { envo: e })).body;
  assert.equal(j.rows.length, 42);
  assert.deepEqual(j.queries, ["weather forecast", "crypto token price", "web search"]);
  assert.equal(j.counts.pay + j.counts.skip + j.counts.recheck, 42);
  assert.ok(!JSON.stringify(j).includes("SECRET1") && !JSON.stringify(j).includes("?"), "no query strings");
  assert.ok(j.rows.every((r) => r.receipt_url && r.reason_text && ["pay", "skip", "recheck"].includes(r.verdict)));
  assert.equal(j.rows.find((r) => r.rank === 2).method, "POST");
  // receipts: self-checked, stored as bazaar tier, shown redacted
  const row = db.rows.find((r) => j.rows[0].receipt_url.endsWith(r.id));
  assert.equal(row.check_type, "self-checked"); assert.equal(JSON.parse(row.body).access_tier, "bazaar");
  const rec = (await send("/v1/receipts/" + row.id, { envo: e })).body;
  assert.equal(JSON.stringify(rec).includes("aaaaaaaaaa"), false, "receipt redacted: no pay_to");
  // never in recent_checks
  assert.equal(((await send("/v1/skips.json", { envo: e })).body.recent_checks || []).length, 0);
  // HTML only for browsers
  const html = await worker.fetch(new Request("https://402xagent.com/bazaar", { headers: { accept: "text/html" } }), e.env, { waitUntil() {} });
  assert.match(html.headers.get("content-type"), /text\/html/); assert.match(await html.text(), /Bazaar check/);
  // off switch: route gone, cron does nothing
  const off = spotEnv({ CRAWL_KV: kv, BAZAAR_PAGE: "off" });
  assert.equal((await send("/bazaar.json", { envo: off })).status, 404);
});

test("0.27.0: stale receipts are rechecked on idle cron steps (capped, self-checked, redacted), never on Bazaar steps", async () => {
  const { staleStep, staleCheckUrl, STALE_PER_DAY } = await import("../worker/src/stale.js");
  const now = new Date("2026-10-20T12:00:00Z");
  const old = (d) => new Date(now.getTime() - d * 86400e3).toISOString().replace(/\.\d{3}Z$/, "Z");
  const seen = [];
  const mk = (todayCount, rows) => ({ prepare(sql) { return { bind(...a) { seen.push([sql, a]); return {
    async first() { return { n: todayCount }; },
    async all() { return { results: rows }; } }; } }; } });
  const rows = [
    { url: "https://api.realx402.dev/a", last: old(5), first: old(6), method: "POST", expected: JSON.stringify({ source: "request", claimed_price_usd: 0.01, pay_to: "0x" + "ab".repeat(20), network: "eip155:8453" }) },
    { url: "https://example.com/api/paid", last: old(5), first: old(6), method: "GET", expected: null },
    ...Array.from({ length: 8 }, (_, i) => ({ url: "https://api.realx402.dev/s" + i, last: old(4), first: old(4), method: "GET", expected: JSON.stringify({ source: "listing", claimed_price_usd: 1 }) })),
  ];
  const calls = [];
  const runCheck = async (u) => { calls.push(u); return new Response("{}"); };
  const r = await staleStep({ RECEIPTS_DB: mk(0, rows) }, { now, runCheck, origin: "https://api.402xagent.com" });
  assert.deepEqual([r.did, r.n], ["rechecked", 5]);
  assert.ok(calls.every((u) => /client=withgrokbot-selftest/.test(u) && /ref=stale-recheck/.test(u)));
  assert.ok(!calls.some((u) => u.includes("example.com")), "junk hosts are not rechecked");
  assert.match(calls[0], /method=POST/); assert.match(calls[0], /claimed_price=0.01/); assert.match(calls[0], /pay_to=0x/);
  assert.ok(!/claimed_price/.test(calls[1]), "listing expectations are re-read from the listing, not frozen");
  const [, bind] = seen.find(([q]) => /GROUP BY url/.test(q));
  assert.deepEqual(bind, ["2026-10-17T12:00:00Z", "2026-09-20T12:00:00Z"]);
  calls.length = 0;
  assert.equal((await staleStep({ RECEIPTS_DB: mk(STALE_PER_DAY, rows) }, { now, runCheck, origin: "x" })).did, "cap"); assert.equal(calls.length, 0);
  assert.equal((await staleStep({ RECEIPTS_DB: mk(STALE_PER_DAY - 2, rows) }, { now, runCheck, origin: "x" })).n, 2);
  assert.equal(staleCheckUrl("o", { url: "https://a.dev/x?q=1", method: "GET" }), "o/v1/products/endpoint-spot-check?url=https%3A%2F%2Fa.dev%2Fx%3Fq%3D1&client=withgrokbot-selftest&ref=stale-recheck");
  // a stale-recheck receipt is self-checked, stored as tier "auto", and shown redacted
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db });
  spotTargetMode = "402";
  const a = await send(SPOT + "?url=" + encodeURIComponent("https://api.realx402.dev/stale1") + "&claimed_price=0.001&client=withgrokbot-selftest&ref=stale-recheck", { envo: e });
  const row = db.rows.find((x) => x.id === a.body.receipt_id);
  assert.equal(row.check_type, "self-checked"); assert.equal(JSON.parse(row.body).access_tier, "auto");
  const rec = (await send("/v1/receipts/" + row.id, { envo: e })).body;
  assert.equal(rec.approved_payment, undefined === rec.approved_payment ? undefined : null);
  assert.ok(!JSON.stringify(rec.live_402 || {}).includes("pay_to\":\"0x"), "redacted receipt");
});

test("0.27.0: pay_to_changed flags a wallet change since the previous receipt for the URL (verdict unchanged)", async () => {
  const { payToChangedFrom } = await import("../worker/src/lib.js");
  const prev = { live_402: { accepts: [{ network: "eip155:8453", pay_to: "0x" + "aa".repeat(20) }, { network: "eip155:84532", pay_to: "0x" + "cc".repeat(20) }] } };
  assert.equal(payToChangedFrom(prev, { network: "eip155:8453", pay_to: "0x" + "AA".repeat(20) }), false);
  assert.equal(payToChangedFrom(prev, { network: "eip155:8453", pay_to: "0x" + "bb".repeat(20) }), true);
  assert.equal(payToChangedFrom(prev, { network: "eip155:137", pay_to: "0x" + "bb".repeat(20) }), null, "other network: nothing to compare");
  assert.equal(payToChangedFrom(null, { network: "eip155:8453", pay_to: "0x1" }), null);
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db });
  spotTargetMode = "402";
  const U = SPOT + "?url=" + encodeURIComponent("https://api.realx402.dev/ptc") + "&client=withgrokbot-selftest";
  const first = await send(U, { envo: e });
  assert.equal(first.body.pay_to_changed, null);
  const r1 = db.rows.find((x) => x.id === first.body.receipt_id);
  const b = JSON.parse(r1.body); b.live_402.accepts = b.live_402.accepts.map((x) => ({ ...x, pay_to: "0x" + "ee".repeat(20) })); r1.body = JSON.stringify(b);
  r1.norm_key = "stale"; r1.created_at = "2026-01-01T00:00:00Z"; // no probe-cache hit; older than the next receipts
  const second = await send(U, { envo: e });
  assert.equal(second.body.pay_to_changed, true);
  assert.equal(second.body.verdict, first.body.verdict, "flag only");
  assert.equal(JSON.parse(db.rows.find((x) => x.id === second.body.receipt_id).body).previous_receipt_id, r1.id);
  const third = await send(U, { envo: e });
  assert.equal(third.body.pay_to_changed, false);
});

test("0.27.0: a GET that answers 405 is probed once with POST; the 402 from POST is used (false-skip fix)", async () => {
  const e = spotEnv({ RECEIPTS_DB: fakeD1() });
  spotTargetMode = "postonly";
  try {
    const r = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/postonly") + "&claimed_price=0.001&client=withgrokbot-selftest", { envo: e });
    assert.equal(r.body.verdict, "pay", JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.probe.method_used, "POST");
    const plain = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/postonly2") + "&claimed_price=0.001&client=withgrokbot-selftest&method=POST", { envo: e });
    assert.equal(plain.body.probe.method_used, undefined, "explicit POST: no retry marker");
  } finally { spotTargetMode = "402"; }
  const r2 = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/normal") + "&claimed_price=0.001&client=withgrokbot-selftest", { envo: e });
  assert.equal(r2.body.probe.method_used, undefined);
});

test("0.39.1: no url + no payment header (GET/HEAD/POST) -> x402 v2 discovery 402 at 20000, same accepts/Bazaar as the paid challenge, Missing url hint, no free check used, nothing written; malformed/misnamed stay 400", async () => {
  const db = fakeD1(); const e = spotEnv({ RECEIPTS_DB: db });
  spotTargetMode = "402";
  const paid = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/disc") + "&client=disc-a", { envo: e, headers: { "x-payment": "" } });
  const before = { rows: db.rows.length, kv: JSON.stringify([...(e.env.KV && e.env.KV.store ? e.env.KV.store : [])]) };
  const pts0 = e.points ? e.points.length : 0;
  for (const [method, init] of [["GET", {}], ["POST", { headers: { "content-type": "application/json" }, body: "{}" }], ["POST", {}]]) {
    const r = await send(SPOT + "?client=disc-b", { envo: e, method, ...init });
    assert.equal(r.status, 402, method + " bare -> 402");
    assert.equal(r.body.x402Version, 2);
    assert.equal(r.body.accepts[0].amount, "20000");
    assert.equal(r.body.discovery, true); assert.match(r.body.error, /Missing url/); assert.ok(r.body.hint.startsWith('Missing "url"'));
    assert.deepEqual(JSON.parse(atob(r.headers.get("payment-required"))).accepts, r.body.accepts);
    const { amount: _a, ...acc } = r.body.accepts[0];
    for (const k of Object.keys(acc)) if (k !== "resource" && k !== "extra") assert.deepEqual(acc[k], paid.body.accepts ? paid.body.accepts[0][k] : acc[k], "accepts." + k);
    if (paid.body.extensions) assert.deepEqual(Object.keys(r.body.extensions || {}), Object.keys(paid.body.extensions));
  }
  const h = await worker.fetch(new Request("https://lookup.test" + SPOT, { method: "HEAD" }), e.env, { waitUntil() {} });
  assert.equal(h.status, 402);
  assert.equal(db.rows.length, before.rows, "no D1 write");
  // free quota untouched: disc-b still gets its first free check
  const f = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/disc2") + "&client=disc-b", { envo: e });
  assert.equal(f.status, 200); assert.equal(f.body.access.tier, "free"); assert.equal(f.body.access.free_used_today, 1);
  // with a payment header and no url: old usage answer
  assert.equal((await send(SPOT, { envo: e, headers: { "x-payment": "x" } })).status, 200);
  assert.equal((await send(SPOT + "?url=notaurl", { envo: e })).status, 400, "malformed url");
  assert.equal((await send(SPOT + "?url=api.example.org/v1/ping", { envo: e })).status, 400, "no scheme");
  assert.equal((await send(SPOT, { envo: e, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target_url: "https://a.dev/x" }) })).status, 400, "POST wrong field");
  assert.equal((await send(SPOT + "?link=https://a.test/x", { envo: e })).status, 400, "misnamed url param stays 400");
});

test("0.28.0: live price more than 1% BELOW the listing is pay/price_below_listing; above stays skip; stored receipts get a read-time note", async () => {
  const { markPriceRule } = await import("../worker/src/lib.js");
  const e = spotEnv({ RECEIPTS_DB: fakeD1() });
  spotTargetMode = "402";
  const below = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/below") + "&claimed_price=9&client=withgrokbot-selftest", { envo: e });
  assert.deepEqual([below.body.verdict, below.body.reason], ["pay", "price_below_listing"]);
  assert.ok(below.body.payment && below.body.payment.pay_to, "pay approves the live terms");
  const free = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/below2") + "&claimed_price=9&client=below-free", { envo: e });
  assert.equal(free.body.reason, "listed $9, live price lower than listed");
  const above = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/above") + "&claimed_price=0.0001&client=withgrokbot-selftest", { envo: e });
  assert.deepEqual([above.body.verdict, above.body.reason], ["skip", "price_mismatch"]);
  const within = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/within") + "&claimed_price=" + String(above.body.quoted_price_usd * 1.005) + "&client=withgrokbot-selftest", { envo: e });
  assert.deepEqual([within.body.verdict, within.body.reason], ["pay", "price_ok"]);
  const USDCb = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const old = { verdict: "skip", reason: "price_mismatch", expected: { claimed_price_usd: 0.7, network: "eip155:8453" }, live_402: { accepts: [{ network: "eip155:8453", asset: USDCb, amount_atomic: "54000" }] } };
  assert.equal(markPriceRule(old).current_rule.reason, "price_below_listing");
  assert.equal(markPriceRule(old).verdict, "skip", "stored answer kept");
  assert.equal(markPriceRule({ ...old, live_402: { accepts: [{ network: "eip155:8453", asset: USDCb, amount_atomic: "900000" }] } }).current_rule, undefined, "above listing: no note");
});

test("0.28.1: bazaar cron fails open on KV write errors (quota) and skips the KV read once today's snapshot is live", async () => {
  const { bazaarStep, _resetBazaarIdle } = await import("../worker/src/bazaar.js");
  _resetBazaarIdle();
  const now = new Date("2026-10-13T12:00:00Z");
  let reads = 0;
  const failing = { get: async () => { reads++; return null; }, put: async () => { throw new Error("KV put() limit exceeded for the day"); } };
  const fakeFetch = async () => new Response(JSON.stringify({ items: [{ resource: "https://x.test/a", accepts: [] }] }), { headers: { "content-type": "application/json" } });
  const r1 = await bazaarStep({ CRAWL_KV: failing }, { now, fetchImpl: fakeFetch, runCheck: async () => new Response("{}"), origin: "https://o.test" });
  assert.ok(["kv-write-failed", "search-empty"].includes(r1.did), "no throw: " + r1.did);
  const live = { get: async () => { reads++; return { live: { day: "2026-10-13" }, build: null }; }, put: async () => {} };
  reads = 0;
  assert.equal((await bazaarStep({ CRAWL_KV: live }, { now, runCheck: null, origin: "" })).did, "idle");
  assert.equal((await bazaarStep({ CRAWL_KV: live }, { now, runCheck: null, origin: "" })).did, "idle");
  assert.equal(reads, 1, "second idle step reads nothing");
  _resetBazaarIdle();
});

test("0.29.0: endpoint history in D1: summary only (no price/wallet), fresh probes recorded, cached not, pruned to 30, drift/stable rules", async () => {
  const { historySummary, recordHistory, observation, HISTORY_KEEP } = await import("../worker/src/history.js");
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db, SPOT_PROBE_CACHE_S: "0" });
  spotTargetMode = "402";
  const u = SPOT + "?url=" + encodeURIComponent("https://spot.target.test/hist") + "&client=withgrokbot-selftest";
  const a = await send(u, { envo: e });
  assert.equal(a.body.history.observations, 1);
  assert.equal(a.body.history.drift, null);
  const b = await send(u, { envo: e });
  assert.equal(b.body.history.observations, 2);
  assert.equal(b.body.history.drift, false);
  assert.equal(b.body.history.stable_for_days, 0);
  assert.equal(db.hist.length, 2);
  const free = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/hist") + "&client=hist-free-1", { envo: e });
  assert.deepEqual(Object.keys(free.body.history).sort(), ["drift", "last_changed", "observations", "stable_for_days", "stable_since"]);
  const rec = JSON.parse(db.rows.find((r) => r.id === free.body.receipt_id).body);
  assert.deepEqual(rec.history, free.body.history, "receipt carries the same summary");
  // cached probes are not new observations
  const e2 = spotEnv({ RECEIPTS_DB: db });
  const n0 = db.hist.length;
  await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/hist2") + "&client=withgrokbot-selftest", { envo: e2 });
  await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/hist2") + "&client=withgrokbot-selftest", { envo: e2 });
  assert.equal(db.hist.length, n0 + 1);
  // rules
  const T = (d) => new Date(Date.UTC(2026, 9, d)).toISOString();
  const o = (d, amt, to = "0xA", st = 402) => ({ observed_at: T(d), http_status: st, amount_atomic: amt, network: "eip155:8453", asset: "0xU", pay_to: to });
  const now = new Date(Date.UTC(2026, 9, 13, 12));
  assert.deepEqual(historySummary([o(13, "10"), o(12, null, null, 504), o(5, "10"), o(1, "20")], now), { observations: 4, stable_for_days: 8, stable_since: T(5), last_changed: T(5), drift: false });
  assert.equal(historySummary([o(13, "10", "0xB"), o(12, "10")], now).drift, true);
  assert.equal(historySummary([o(13, "10"), o(1, "10")], now).last_changed, null);
  assert.equal(historySummary([o(13, null, null, 404), o(12, "10")], now).stable_for_days, null, "no terms now: no stability claim");
  // prune
  const db2 = fakeD1();
  for (let i = 0; i < HISTORY_KEEP + 5; i++) await recordHistory({ RECEIPTS_DB: db2 }, "h:x", observation({ http_status: 402 }, { amount_atomic: "1", network: "n", pay_to: "p" }, "pay", new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()), true);
  assert.equal(db2.hist.length, HISTORY_KEEP);
  assert.equal(await recordHistory({ RECEIPTS_DB: { prepare() { throw new Error("down"); } } }, "h:x", {}, true), null, "fails open");
});

test("0.30.0: reason_code + confidence on every verdict; /rules + /rules.json published and linked (llms, OpenAPI, well-known, MCP)", async () => {
  const { REASON_CODES, confidenceFor } = await import("../worker/src/rules.js");
  const raw = async (path) => { const e = meteredEnv(); const r = await worker.fetch(new Request("https://lookup.test" + path, { headers: { "user-agent": "agent-x/1.0" } }), e.env, { waitUntil() {} }); return { status: r.status, text: await r.text(), ct: r.headers.get("content-type") }; };
  const rj = await send("/rules.json");
  assert.equal(rj.status, 200);
  const codes = rj.body.reason_codes.map((r) => r.code);
  const oa = (await send("/openapi.json")).body;
  const enumCodes = JSON.stringify(oa).match(/"enum":\["price_ok"[^\]]*\]/)[0].match(/"([a-z_]+)"/g).map((x) => x.slice(1, -1)).filter((x) => x !== "enum");
  for (const c of enumCodes) assert.ok(codes.includes(c), "documented: " + c);
  assert.ok(oa.paths["/rules"] && oa.paths["/rules.json"]);
  const html = await raw("/rules");
  assert.match(html.ct, /text\/html/);
  assert.match(html.text, /price_below_listing/);
  assert.match((await raw("/llms.txt")).text, /\/rules\.json/);
  assert.equal((await send("/.well-known/x402")).body.free_pages.rules, "https://402xagent.com/rules.json");
  const tl = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.match(tl.body.result.tools.find((x) => x.name === "endpoint_spot_check").description, /reason_code.*confidence.*rules\.json/);
  // rules
  assert.equal(confidenceFor({ verdict: "recheck", reason: "timeout" }), "low");
  assert.equal(confidenceFor({ verdict: "pay", reason: "price_ok" }, 0.01), "high");
  assert.equal(confidenceFor({ verdict: "pay", reason: "price_ok" }, null), "medium");
  assert.equal(confidenceFor({ verdict: "pay", reason: "price_ok" }, 0.01, { drift: true }), "medium");
  assert.equal(confidenceFor({ verdict: "skip", reason: "no_paywall" }), "medium");
  assert.equal(confidenceFor({ verdict: "skip", reason: "pay_to_mismatch" }), "high");
  assert.equal(confidenceFor({ verdict: "skip", reason: "something_new" }), "low");
  assert.ok(REASON_CODES.every((r) => ["high", "medium", "low"].includes(r.confidence)));
  // live answers (free, full, dry run) and stored receipts carry them; human reason unchanged
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db });
  spotTargetMode = "402";
  const u = "?url=" + encodeURIComponent("https://spot.target.test/rc") + "&claimed_price=0.001";
  const free = await send(SPOT + u + "&client=rc-free-1", { envo: e });
  assert.equal(free.body.reason_code, "price_ok");
  assert.equal(free.body.confidence, "high");
  assert.match(free.body.reason, /matches/);
  const full = await send(SPOT + u + "&client=withgrokbot-selftest", { envo: e });
  assert.deepEqual([full.body.reason, full.body.reason_code, full.body.confidence], ["price_ok", "price_ok", "high"]);
  const dry = await send(SPOT + u + "&client=rc-dry-1&mode=dry-run", { envo: e });
  assert.equal(dry.body.reason_code, "price_ok");
  const rc = await send("/v1/receipts/" + free.body.receipt_id, { envo: e });
  assert.deepEqual([rc.body.reason_code, rc.body.confidence], ["price_ok", "high"]);
  // a pre-0.30 receipt gets the fields on read
  db.rows.push({ id: "sc-00000000000000aa", url: "https://x.test/a", created_at: "2026-10-01T00:00:00Z", verdict: "skip", reason: "no_paywall", check_type: "dry-run", body: JSON.stringify({ id: "sc-00000000000000aa", url: "https://x.test/a", verdict: "skip", reason: "no_paywall", check_type: "dry-run" }) });
  const old = await send("/v1/receipts/sc-00000000000000aa", { envo: e });
  assert.deepEqual([old.body.reason_code, old.body.confidence], ["no_paywall", "medium"]);
});

test("0.31.0: default free tier is 5 live checks per caller per UTC day, then the 402; dry-run caps unchanged", async () => {
  const e = spotEnv({ RECEIPTS_DB: fakeD1() });
  delete e.env.SPOT_FREE_PER_DAY;
  spotTargetMode = "402";
  const u = (i) => SPOT + "?url=" + encodeURIComponent("https://spot.target.test/f" + i) + "&client=five-free-1";
  for (let i = 1; i <= 5; i++) {
    const r = await send(u(i), { envo: e });
    assert.equal(r.status, 200, "free #" + i);
    assert.deepEqual([r.body.access.tier, r.body.access.free_per_day, r.body.access.free_remaining_today], ["free", 5, 5 - i]);
  }
  const sixth = await send(u(6), { envo: e });
  assert.equal(sixth.status, 402);
  assert.match(sixth.body.error, /\(5 per UTC day\)/);
  const other = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/f7") + "&client=five-free-2", { envo: e });
  assert.equal(other.status, 200, "per caller");
  const { spotCfg } = await import("../worker/src/lib.js");
  const c = spotCfg({});
  assert.equal(c.freePerDay, 5);
  assert.equal(c.dryPerDay, spotCfg({ SPOT_FREE_PER_DAY: "1" }).dryPerDay, "dry-run cap independent of the free tier");
});

test("0.32.0: /badge/<host>.svg shows only real current status (pay+fresh = green; skip/stale/none = grey), escapes input, no fetch/no write, links the receipt", async () => {
  const { badgeState, validBadgeHost, pickBadgeRow, badgeSvg } = await import("../worker/src/badge.js");
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db });
  const now = Date.now();
  const iso = (hAgo) => new Date(now - hAgo * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const add = (id, url, verdict, hAgo, extra = {}) => db.rows.push({ id, url, created_at: iso(hAgo), verdict, reason: "x", check_type: "dry-run", body: JSON.stringify({ id, url, verdict, history: { stable_for_days: 9 }, expected: { source: "listing" }, ...extra }) });
  add("sc-00000000000000b1", "https://good.example.com/api", "pay", 1);
  add("sc-00000000000000b2", "https://old.example.com/api", "pay", 100);
  add("sc-00000000000000b3", "https://bad.example.com/api", "skip", 1);
  add("sc-00000000000000b4", "https://mixed.example.com/a", "pay", 1);
  add("sc-00000000000000b5", "https://mixed.example.com/b", "skip", 2);
  add("sc-00000000000000b6", "https://req.example.com/a", "pay", 1, { expected: { source: "request" } });
  const get = async (p) => { const r = await worker.fetch(new Request("https://lookup.test" + p, { redirect: "manual" }), e.env, { waitUntil() {} }); return { status: r.status, text: await r.text(), h: r.headers }; };
  const g = await get("/badge/good.example.com.svg");
  assert.equal(g.status, 200);
  assert.match(g.h.get("content-type"), /image\/svg\+xml/);
  assert.match(g.h.get("cache-control"), /max-age=300/);
  assert.match(g.text, /pay · stable 9 days/);
  assert.match(g.h.get("link"), /sc-00000000000000b1/);
  assert.match((await get("/badge/old.example.com.svg")).text, />stale</);
  assert.match((await get("/badge/bad.example.com.svg")).text, />not verified</);
  assert.match((await get("/badge/none.example.com.svg")).text, />not verified</);
  assert.match((await get("/badge/mixed.example.com.svg")).text, />not verified</, "a fresh skip elsewhere on the host blocks the pass");
  assert.match((await get("/badge/mixed.example.com.svg?path=%2Fa")).text, /pay · stable/);
  assert.match((await get("/badge/req.example.com.svg")).text, />not verified</, "caller-supplied expectations never earn a badge");
  for (const bad of ["/badge/%3Cscript%3E.svg", "/badge/127.0.0.1.svg", "/badge/localhost.svg", "/badge/x.internal.svg", "/badge/a..b.svg"]) {
    const r = await get(bad);
    assert.equal(r.status, 400, bad);
    assert.ok(!/<script/i.test(r.text));
  }
  assert.equal((await get("/badge/good.example.com.svg?path=%2Fa%3Fq")).status, 400);
  const pg = await get("/badge/good.example.com");
  assert.equal(pg.status, 200);
  assert.match(pg.text, /href="https:\/\/402xagent\.com\/v1\/receipts\/sc-00000000000000b1"/);
  assert.match(pg.text, /\[!\[402xAgent status\]/);
  assert.ok(!(await get("/badge/none.example.com")).text.includes("<script"));
  assert.ok(!badgeSvg("a<b", "c&d", "#fff\"").includes("a<b"));
  assert.equal(validBadgeHost("API.Example.com"), "api.example.com");
  assert.equal(badgeState(null).text, "not verified");
  assert.equal(pickBadgeRow([]), null);
  const rc = await send("/v1/receipts/sc-00000000000000b1", { envo: e });
  assert.equal(rc.body.badge.markdown, "[![402xAgent status](https://402xagent.com/badge/good.example.com.svg?path=%2Fapi)](https://402xagent.com/badge/good.example.com?path=%2Fapi)");
  assert.match(rc.body.badge.html, /^<a href="https:\/\/402xagent\.com\/badge\/good\.example\.com\?path=%2Fapi"><img src=/);
});

test("0.33.0: free live checks capped at 25 per network per UTC day across client names (salted hash), 429 + Retry-After; paid/exempt/dry-run unchanged", async () => {
  const { freeIpKey, secondsToUtcMidnight } = await import("../worker/src/lib.js");
  const e = spotEnv({ RECEIPTS_DB: fakeD1() });
  e.env.CLIENT_SALT = "test-salt";
  e.env.SPOT_FREE_PER_DAY = "5";
  spotTargetMode = "402";
  const ip = "198.51.100.23";
  const go = (cl, i, extra = "") => send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/ip" + i) + "&client=" + cl + extra, { envo: e, ip });
  let n = 0;
  for (let c = 0; c < 5; c++) for (let i = 0; i < 5; i++) { const r = await go("rot-" + c, n++); assert.equal(r.status, 200, "free #" + n); assert.equal(r.body.access.tier, "free"); }
  const over = await go("rot-new", n++);
  assert.equal(over.status, 429, "26th free check from one network is 429 even with a fresh client name");
  assert.match(over.body.error, /25 free live checks per UTC day from one network/);
  assert.match(over.body.router_pack.price, /\$0\.20 USDC for 10 checks \(\$0\.02 each\)/);
  assert.match(over.body.paid_check.url, /endpoint-spot-check\?url=/);
  const ra = Number(over.headers.get("retry-after"));
  assert.ok(ra > 0 && ra <= 86400 && Math.abs(ra - secondsToUtcMidnight()) < 5);
  assert.ok(!JSON.stringify(over.body).includes(ip));
  // other network still fine; exempt + dry-run unaffected
  assert.equal((await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/o") + "&client=rot-x", { envo: e, ip: "203.0.113.99" })).status, 200);
  assert.equal((await go("withgrokbot-selftest", n++)).status, 200, "self-test exempt");
  assert.equal((await go("rot-dry", n++, "&mode=dry-run")).status, 200, "dry run has its own caps");
  // hash only
  const k = await freeIpKey(new Request("https://x/", { headers: { "cf-connecting-ip": ip } }), { CLIENT_SALT: "test-salt" });
  assert.match(k, /^fip:[0-9a-f]{32}$/);
  assert.ok(!k.includes(ip) && !k.includes("198.51"));
  assert.notEqual(k, await freeIpKey(new Request("https://x/", { headers: { "cf-connecting-ip": ip } }), { CLIENT_SALT: "other" }), "salted");
  assert.ok(!e.points.some((p) => JSON.stringify(p).includes(ip)), "raw IP never in analytics points");
});

test("0.34.0: paid/exempt answers carry the full last-30 history_observations; free answers, dry runs and receipts keep only the summary", async () => {
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db, SPOT_PROBE_CACHE_S: "0" });
  spotTargetMode = "402";
  const u = "?url=" + encodeURIComponent("https://spot.target.test/hs");
  await send(SPOT + u + "&client=withgrokbot-selftest", { envo: e });
  const full = await send(SPOT + u + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(full.body.history_observations.length, 2);
  const o = full.body.history_observations[0];
  assert.deepEqual(Object.keys(o).sort(), ["amount_atomic", "asset", "http_status", "network", "observed_at", "pay_to", "price_usd"]);
  assert.equal(o.http_status, 402);
  assert.ok(o.pay_to);
  const free = await send(SPOT + u + "&client=hs-free-1", { envo: e });
  assert.equal(free.body.history_observations, undefined);
  assert.ok(!JSON.stringify(free.body).includes(o.pay_to), "free answer never shows the wallet");
  const dry = await send(SPOT + u + "&client=hs-dry-1&mode=dry-run", { envo: e });
  assert.equal(dry.body.history_observations, undefined);
  for (const r of db.rows) assert.ok(!("history_observations" in JSON.parse(r.body)), "receipts keep the summary only");
  const rc = await send("/v1/receipts/" + free.body.receipt_id, { envo: e });
  assert.ok(rc.body.history && rc.body.history_observations === undefined && !JSON.stringify(rc.body.history).includes(o.pay_to));
});

test("0.35.0: /saves behind SAVES_PAGE (off = 404); real listing differences only, no wallets, no query, no templates, no self tests, 30 days", async () => {
  const { liveSave, savesJson } = await import("../worker/src/saves.js");
  const e = spotEnv({ RECEIPTS_DB: fakeD1() });
  assert.equal((await send("/saves.json", { envo: e })).status, 404, "off by default");
  const now = new Date();
  const iso = (d) => new Date(now.getTime() - d * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const W1 = "0x" + "a1".repeat(20), W2 = "0x" + "b2".repeat(20);
  const base = (o) => ({ verdict: "skip", checked_at: iso(1), id: "sc-00000000000000c1", url: "https://seller.example.com/api?key=secret", expected: { source: "listing", claimed_price_usd: 0.003, network: "eip155:8453", pay_to: W1 }, live_402: { accepts: [{ network: "eip155:8453", amount_atomic: "15000", pay_to: W2 }] }, ...o });
  const p = liveSave(base({ reason: "price_mismatch" }), now);
  assert.deepEqual([p.endpoint, p.kind, p.what], ["https://seller.example.com/api", "price_higher", "asked $0.015, listed $0.003"]);
  const w = liveSave(base({ reason: "pay_to_mismatch" }), now);
  assert.equal(w.what, "pays a different wallet");
  assert.ok(!JSON.stringify(w).includes(W1) && !JSON.stringify(w).includes(W2));
  assert.match(liveSave(base({ reason: "network_mismatch", live_402: { accepts: [{ network: "eip155:137", amount_atomic: "3000" }] } }), now).what, /asks for payment on eip155:137, listed eip155:8453/);
  assert.equal(liveSave(base({ reason: "price_mismatch", live_402: { accepts: [{ network: "eip155:8453", amount_atomic: "1000" }] } }), now), null, "cheaper is not a save");
  assert.equal(liveSave(base({ reason: "pay_to_mismatch", checked_at: iso(31) }), now), null, "older than 30 days");
  assert.equal(liveSave(base({ reason: "pay_to_mismatch", url: "https://seller.example.com/api/{id}" }), now), null, "path template");
  assert.equal(liveSave(base({ reason: "pay_to_mismatch", caller: "self-test" }), now), null, "our own test");
  assert.equal(liveSave(base({ reason: "pay_to_mismatch", url: "https://api.402xagent.com/x" }), now), null, "our own host");
  assert.equal(liveSave(base({ reason: "pay_to_mismatch", expected: { source: "request" } }), now), null, "caller-typed expectations");
  assert.equal(liveSave(base({ reason: "no_paywall" }), now), null);
  assert.equal(liveSave(base({ reason: "pay_to_mismatch", url: "https://seller.example.com/token/0x" + "c3".repeat(20) }), now), null, "address-like path segment");
  assert.equal(liveSave(base({ reason: "network_mismatch", expected: { source: "listing", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }, live_402: { accepts: [{ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }] } }), now).what, "asks for payment on Solana mainnet, listed Solana devnet");
  // on
  e.env.SAVES_PAGE = "on";
  const r = await send("/saves.json", { envo: e });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.saves) && r.body.count === r.body.saves.length);
  for (const s of r.body.saves.slice(0, 200)) { assert.ok(!/[?#]/.test(s.endpoint)); assert.ok(!/0x[0-9a-fA-F]{40}/.test(JSON.stringify(s)), "no wallet"); }
  const cr = r.body.saves.find((x) => x.source === "crawl");
  if (cr) assert.match(cr.receipt, /\?view=redacted$/);
  const html = await worker.fetch(new Request("https://lookup.test/saves"), e.env, { waitUntil() {} });
  assert.match(html.headers.get("content-type"), /text\/html/);
});

test("0.35.2: /saves.json splits live_count and crawl_count; HTML says showing X of Y crawl findings + N live checks", async () => {
  const { savesJson, handleSaves } = await import("../worker/src/saves.js");
  const { SAVES, SAVES_META } = await import("../worker/src/saves-data.js");
  const now = new Date();
  const body = { verdict: "skip", reason: "pay_to_mismatch", checked_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"), id: "sc-00000000000000d1", url: "https://live-only.example.com/api", expected: { source: "listing" }, live_402: { accepts: [] } };
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ body: JSON.stringify(body) }] }) }) }) };
  const j = await savesJson({ RECEIPTS_DB: db }, "https://o.test", now);
  assert.equal(j.live_count, 1);
  assert.equal(j.count, j.live_count + j.crawl_count, "count kept as the total");
  assert.equal(j.count, j.saves.length);
  assert.equal(j.crawl_count, j.saves.filter((x) => x.source === "crawl").length);
  assert.ok(j.crawl_count <= SAVES.length);
  assert.equal(j.crawl_total_before_cap, SAVES_META.total);
  const res = await handleSaves(new Request("https://o.test/saves"), { SAVES_PAGE: "on", RECEIPTS_DB: db }, new URL("https://o.test/saves"), "https://o.test");
  const html = await res.text();
  const n = (x) => Number(x).toLocaleString("en-US");
  if (SAVES_META.total > j.crawl_count) assert.ok(html.includes(`showing ${n(j.crawl_count)} of ${n(SAVES_META.total)} crawl findings + 1 live check `), "capped wording");
  else assert.ok(html.includes(`${n(j.crawl_count)} crawl findings + 1 live check `));
  const j0 = await savesJson({}, "https://o.test", now);
  assert.equal(j0.live_count, 0);
  assert.equal(j0.count, j0.crawl_count);
});

// 0.36.0: daily re-check. A tiny in-memory stand-in for the D1 statements daily.js uses.
function dailyDb({ fresh = {}, throwAll = false } = {}) {
  const runs = new Map(), queue = new Map(), log = [];
  const run = (sql, a) => {
    log.push(sql);
    if (throwAll) throw new Error("no such table");
    if (/^DELETE FROM daily_queue/.test(sql)) { for (const [k, q] of queue) if (q.day < a[0]) queue.delete(k); return {}; }
    if (/INSERT OR IGNORE INTO daily_runs/.test(sql)) { if (!runs.has(a[0])) runs.set(a[0], { day: a[0], started_at: a[1], total: a[2], finished_at: null, done: 0 }); return {}; }
    if (/INSERT OR IGNORE INTO daily_queue/.test(sql)) { const k = a[0] + " " + a[1]; if (!queue.has(k)) queue.set(k, { day: a[0], url: a[1], method: a[2], host: a[3], done_at: null }); return {}; }
    if (/^SELECT url, method, host FROM daily_queue/.test(sql)) return { results: [...queue.values()].filter((q) => q.day === a[0] && !q.done_at).sort((x, y) => (x.host < y.host ? -1 : 1)).slice(0, a[1]) };
    if (/FROM spot_receipts WHERE url = \?/.test(sql)) return fresh[a[0]] || null;
    if (/^UPDATE daily_queue/.test(sql)) { const q = queue.get(a[3] + " " + a[4]); Object.assign(q, { done_at: a[0], verdict: a[1], receipt_id: a[2] }); return {}; }
    if (/^UPDATE daily_runs/.test(sql)) { const r = runs.get(a[2]); r.finished_at = a[0]; r.done = [...queue.values()].filter((q) => q.day === a[1] && q.done_at).length; return {}; }
    if (/MAX\(finished_at\)/.test(sql)) return { t: [...runs.values()].map((r) => r.finished_at).filter(Boolean).sort().pop() || null };
    throw new Error("unexpected sql " + sql);
  };
  const stmt = (sql, a = []) => ({ bind: (...b) => stmt(sql, b), all: async () => run(sql, a), first: async () => run(sql, a), run: async () => run(sql, a), _x: () => run(sql, a) });
  return { runs, queue, log, prepare: (sql) => stmt(sql), batch: async (list) => list.map((x) => x._x()) };
}

test("0.36.0: daily re-check seeds the 26 badge hosts, checks in capped batches as the exempt self-test client (no payment), skips fresh URLs, writes no KV", async () => {
  const { BADGE_HOSTS, DAILY_BATCH, DAILY_CRON, dailySeed, dailyStep, dailyCheckUrl, lastDailyCheck } = await import("../worker/src/daily.js");
  assert.equal(BADGE_HOSTS.length, 26);
  assert.equal(new Set(BADGE_HOSTS.map((x) => x.host)).size, 26);
  assert.ok(BADGE_HOSTS.every((x) => new URL(x.url).hostname === x.host && !x.url.includes("?")));
  assert.match(DAILY_CRON, /^17 10 \* \* \*$/);
  assert.ok(DAILY_BATCH * 3 <= 30, "~3 subrequests per check stays well under 50");
  const db = dailyDb({ fresh: { [BADGE_HOSTS[0].url]: { id: "sc-fresh", verdict: "pay" } } });
  const t = new Date("2026-10-14T10:17:00Z");
  assert.equal((await dailySeed({ RECEIPTS_DB: db }, { now: t })).n, 26);
  await dailySeed({ RECEIPTS_DB: db }, { now: t }); // idempotent
  assert.equal(db.queue.size, 26);
  const calls = [];
  const runCheck = async (u) => { calls.push(u); return new Response(JSON.stringify({ verdict: "pay", receipt_id: "sc-" + calls.length })); };
  let steps = 0, r;
  do { r = await dailyStep({ RECEIPTS_DB: db }, { now: t, runCheck, origin: "https://api.402xagent.com" }); steps++; assert.ok(steps < 10); if (r.did === "checked") assert.ok(r.n + r.skipped <= DAILY_BATCH); } while (r.did === "checked");
  assert.equal(r.did, "drained");
  assert.equal(steps, Math.ceil(26 / DAILY_BATCH) + 1);
  assert.equal(calls.length, 25, "the URL with a receipt under 20 h old is not probed again");
  assert.ok(calls.every((u) => /^https:\/\/api\.402xagent\.com\/v1\/products\/endpoint-spot-check\?/.test(u) && /client=withgrokbot-selftest/.test(u) && /ref=daily-recheck/.test(u) && !/claimed_price|pay_to|network|mode=paid/.test(u)));
  assert.ok([...db.queue.values()].every((q) => q.done_at && q.verdict === "pay"));
  assert.equal(db.runs.get("2026-10-14").done, 26);
  assert.equal(await lastDailyCheck(db), t.toISOString());
  assert.match(dailyCheckUrl("o", { url: "https://a.dev/x", method: "POST" }), /method=POST/);
  // missing tables (migration not applied yet): fail open, nothing thrown
  const bad = dailyDb({ throwAll: true });
  assert.equal((await dailySeed({ RECEIPTS_DB: bad }, { now: t })).did, "db-error");
  assert.equal((await dailyStep({ RECEIPTS_DB: bad }, { now: t, runCheck, origin: "o" })).did, "none");
  assert.equal(await lastDailyCheck(bad), null);
});

test("0.36.0: scheduled routes the daily cron to the daily queue only; the 20-min cron drains it on idle steps before any stale recheck; KV untouched", async () => {
  const { DAILY_CRON } = await import("../worker/src/daily.js");
  const { _resetBazaarIdle } = await import("../worker/src/bazaar.js");
  const db = dailyDb();
  let kvPuts = 0;
  const today = new Date().toISOString().slice(0, 10);
  const kv = { get: async () => ({ live: { day: today, generated_at: new Date().toISOString(), queries: [], counts: {}, rows: [] }, build: null }), put: async () => { kvPuts++; } };
  const env = { RECEIPTS_DB: db, CRAWL_KV: kv, SPOT_PROBE_CACHE_S: "0" };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("no", { status: 404 });
  try {
    _resetBazaarIdle();
    await worker.scheduled({ cron: DAILY_CRON, scheduledTime: Date.now() }, env, { waitUntil() {} });
    assert.equal(db.queue.size, 26);
    assert.ok(!db.log.some((q) => /stale-recheck|GROUP BY url/.test(q)), "daily trigger never runs the stale step");
    const pend = () => [...db.queue.values()].filter((q) => !q.done_at).length;
    const before = pend();
    assert.ok(before <= 26 - 1);
    await worker.scheduled({ cron: "*/20 * * * *", scheduledTime: Date.now() }, env, { waitUntil() {} });
    assert.ok(pend() < before, "20-min idle step drains the daily queue");
    assert.equal(kvPuts, 0, "no KV writes");
    // off switch: the daily trigger does nothing
    const db2 = dailyDb();
    await worker.scheduled({ cron: DAILY_CRON, scheduledTime: Date.now() }, { ...env, RECEIPTS_DB: db2, DAILY_RECHECK: "off" }, { waitUntil() {} });
    assert.equal(db2.log.length, 0);
  } finally { globalThis.fetch = origFetch; _resetBazaarIdle(); }
});

test("0.36.0: Last checked line + last_checked field on /saves, /saves.json, /bazaar, /bazaar.json and the badge page; wrangler has both crons", async () => {
  const { lastCheckedText } = await import("../worker/src/daily.js");
  assert.equal(lastCheckedText("2026-10-14T10:21:33.000Z"), "Last checked: 2026-10-14 10:21 UTC");
  assert.equal(lastCheckedText(null), "Last checked: pending");
  const { savesJson, handleSaves } = await import("../worker/src/saves.js");
  const db = dailyDb(); db.runs.set("2026-10-14", { day: "2026-10-14", finished_at: "2026-10-14T10:40:00.000Z" });
  const sdb = { prepare: (sql) => /MAX\(finished_at\)/.test(sql) ? db.prepare(sql) : { bind: () => ({ all: async () => ({ results: [] }) }) } };
  const j = await savesJson({ RECEIPTS_DB: sdb }, "https://o.test");
  assert.equal(j.last_checked, "2026-10-14T10:40:00.000Z");
  assert.equal((await savesJson({}, "https://o.test")).last_checked, null);
  const html = await (await handleSaves(new Request("https://o.test/saves"), { SAVES_PAGE: "on", RECEIPTS_DB: sdb }, new URL("https://o.test/saves"), "https://o.test")).text();
  assert.ok(html.includes('<p class="last-checked">Last checked: 2026-10-14 10:40 UTC</p>'));
  const { bazaarJson, bazaarHtml } = await import("../worker/src/bazaar.js");
  const bj = bazaarJson({ day: "2026-10-14", generated_at: "2026-10-14T01:40:00.000Z", queries: ["q"], counts: { pay: 0, skip: 0, recheck: 0 }, rows: [] }, "https://o.test");
  assert.equal(bj.last_checked, "2026-10-14T01:40:00.000Z");
  assert.ok(bazaarHtml(bj).includes("Last checked: 2026-10-14 01:40 UTC"));
  assert.equal(bazaarJson(null, "o").last_checked, null);
  assert.ok(bazaarHtml(bazaarJson(null, "o")).includes("Last checked: pending"));
  const { handleBadge } = await import("../worker/src/badge.js");
  const n = new Date("2026-10-14T12:00:00Z");
  const row = { id: "sc-1", url: "https://h.example.com/x", created_at: "2026-10-14T10:18:00Z", verdict: "pay", body: "{}" };
  const bdb = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [row] }) }) }) };
  const page = await (await handleBadge(new Request("https://o.test/badge/h.example.com"), { RECEIPTS_DB: bdb }, new URL("https://o.test/badge/h.example.com"), "https://o.test", n)).text();
  assert.ok(page.includes("Last checked: 2026-10-14 10:18 UTC"));
  const svg = await handleBadge(new Request("https://o.test/badge/h.example.com.svg"), { RECEIPTS_DB: bdb }, new URL("https://o.test/badge/h.example.com.svg"), "https://o.test", n);
  assert.equal(svg.headers.get("x-402xagent-last-checked"), "2026-10-14T10:18:00Z");
  assert.equal(svg.headers.get("x-402xagent-badge"), "pay");
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "wrangler.toml"), "utf8");
  assert.match(toml, /crons = \["\*\/20 \* \* \* \*", "17 10 \* \* \*"\]/);
  assert.equal(VERSION, "0.45.1");
});

// 0.37.0: response quality + seller reputation (additive only; verdicts and reason codes unchanged)
test("0.37.0 quality: codes from 402 metadata only; schema declared + validated from the challenge's own sample; never changes the verdict", async () => {
  const { qualityMeta, qualityFor, validateSchema, outputSchemaCheck, QUALITY_CODES } = await import("../worker/src/quality.js");
  assert.deepEqual(QUALITY_CODES.map((q) => q.code), ["quality_ok", "quality_unverified", "quality_bad_content_type", "quality_schema_mismatch", "quality_bad_status", "quality_unreachable"]);
  assert.equal(validateSchema({ a: 1, b: "x" }, { type: "object", required: ["a"], properties: { a: { type: "integer" }, b: { type: "string" } } }), true);
  assert.equal(validateSchema({ b: "x" }, { type: "object", required: ["a"] }), false);
  assert.equal(validateSchema({ a: "1" }, { type: "object", properties: { a: { type: "number" } } }), false);
  assert.equal(validateSchema({ a: 1, z: 2 }, { type: "object", properties: { a: {} }, additionalProperties: false }), false);
  assert.equal(validateSchema([1, "2"], { type: "array", items: { type: "integer" } }), false);
  assert.equal(validateSchema(null, { type: ["string", "null"] }), true);
  // x402 v2 bazaar extension: info validated against the declared schema
  const bz = (example) => ({ extensions: { bazaar: { info: { input: { type: "http", method: "GET" }, output: { type: "json", example } }, schema: { type: "object", properties: { input: { type: "object", required: ["type"] }, output: { type: "object", required: ["type"], properties: { example: { type: "object", required: ["temp"], properties: { temp: { type: "number" } } } } } } } } } });
  assert.deepEqual(outputSchemaCheck(bz({ temp: 21.5 })), { declared: true, source: "bazaar", match: true });
  assert.deepEqual(outputSchemaCheck(bz({ temp: "warm" })), { declared: true, source: "bazaar", match: false });
  assert.deepEqual(outputSchemaCheck({ accepts: [{ outputSchema: { input: {}, output: { type: "object" } } }] }), { declared: true, source: "outputSchema", match: null });
  assert.deepEqual(outputSchemaCheck({ accepts: [{}] }), { declared: false, source: null, match: null });
  const H = (o) => new Headers(o);
  const ch = (extra) => JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact" }], ...extra });
  const probe = (status, headers, body, x402 = true) => ({ reachable: true, http_status: status, x402_challenge: x402, quality_meta: qualityMeta({ status, headers: H(headers), bodyText: body }) });
  assert.equal(qualityFor(probe(402, { "content-type": "application/json" }, ch(bz({ temp: 1 })))).code, "quality_ok");
  assert.equal(qualityFor(probe(402, { "content-type": "application/json" }, ch(bz({ temp: "x" })))).code, "quality_schema_mismatch");
  assert.equal(qualityFor(probe(402, { "content-type": "application/json; charset=utf-8" }, ch({}))).code, "quality_unverified");
  assert.equal(qualityFor(probe(402, { "content-type": "text/html" }, ch({}))).code, "quality_bad_content_type");
  assert.equal(qualityFor(probe(402, { "content-type": "text/html", "payment-required": btoa(ch({})) }, "<html>")).code, "quality_unverified", "terms in the header: body type does not matter");
  assert.equal(qualityFor(probe(404, { "content-type": "text/html" }, "nope", false)).code, "quality_bad_status");
  assert.equal(qualityFor({ reachable: false, error: "fetch timeout" }).code, "quality_unreachable");
  assert.equal(qualityFor({ reachable: false, ssrf_blocked: true }).code, "quality_unreachable");
  const q = qualityFor(probe(402, { "content-type": "application/json" }, ch({})));
  assert.deepEqual(Object.keys(q.checks).sort(), ["body_bytes", "content_type", "content_type_ok", "http_status", "reachable", "schema_declared", "schema_match", "schema_source", "status_is_402"]);
  assert.equal(q.checks.body_bytes, ch({}).length);
  // live path: same verdict and reason_code as before; metadata stored in D1 (no body, no query); paid gets checks, free gets the code
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db, SPOT_PROBE_CACHE_S: "0" });
  spotTargetMode = "402";
  const u = "?url=" + encodeURIComponent("https://spot.target.test/q?apikey=SECRET123") + "&claimed_price=0.001";
  const full = await send(SPOT + u + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(full.body.verdict, "pay");
  assert.equal(full.body.reason_code, "price_ok");
  assert.equal(full.body.quality.code, "quality_unverified");
  assert.equal(full.body.quality.checks.http_status, 402);
  assert.equal(full.body.quality.checks.content_type, "application/json");
  assert.equal(db.qual.length, 1);
  assert.deepEqual(Object.keys(db.qual[0]).sort(), ["body_bytes", "code", "content_type", "hkey", "host", "http_status", "observed_at", "schema_declared", "schema_match"]);
  assert.equal(db.qual[0].host, "spot.target.test");
  assert.ok(!JSON.stringify(db.qual).includes("SECRET123") && !JSON.stringify(db.qual).includes("/q"), "no URL path or query stored");
  const free = await send(SPOT + u + "&client=q-free-1", { envo: e });
  assert.equal(free.body.verdict, "pay");
  assert.deepEqual(free.body.quality, { code: "quality_unverified", rules: "https://402xagent.com/rules.json" });
  const dry = await send(SPOT + u + "&client=q-dry-1&mode=dry-run", { envo: e });
  assert.deepEqual(Object.keys(dry.body.quality), ["code", "rules"]);
  spotTargetMode = "notfound";
  const nf = await send(SPOT + u + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(nf.body.reason_code, "no_paywall");
  assert.equal(nf.body.quality.code, "quality_bad_status");
  spotTargetMode = "402";
  // cached probe: no second quality row (same observation)
  const e2 = spotEnv({ RECEIPTS_DB: db });
  const n = db.qual.length;
  await send(SPOT + u + "&client=withgrokbot-selftest", { envo: e2 });
  await send(SPOT + u + "&client=withgrokbot-selftest", { envo: e2 });
  assert.equal(db.qual.length, n, "cached probes (within 5 min of the last fresh one) are the same observation: nothing new stored");
});

test("0.37.0 reputation: documented weighted formula; new hosts are insufficient_data (never low); paid full, free/dry-run band only; /reputation/<host>; rules.json; 0 KV writes", async () => {
  const { computeReputation, REPUTATION_WEIGHTS, bandFor } = await import("../worker/src/reputation.js");
  const { rulesJson } = await import("../worker/src/rules.js");
  assert.deepEqual(REPUTATION_WEIGHTS, { stability: 25, drift: 20, verdicts: 30, freshness: 10, quality: 15 });
  assert.deepEqual([bandFor(75), bandFor(74), bandFor(50), bandFor(49), bandFor(null)], ["high", "medium", "medium", "low", "insufficient_data"]);
  const now = new Date("2026-10-15T12:00:00Z");
  const at = (d) => new Date(now.getTime() - d * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const ob = (d, pay_to = "0xa", amount = "1000") => ({ observed_at: at(d), amount_atomic: amount, network: "eip155:8453", asset: "0xusdc", pay_to, verdict: "pay" });
  // steady seller: 10 days of identical terms, all pay, fresh, quality_ok
  const steady = computeReputation({ host: "s.test", now, firstSeen: at(10), receipts: Array.from({ length: 10 }, (_, i) => ({ url: "https://s.test/a", created_at: at(i), verdict: "pay" })), histories: { h1: Array.from({ length: 10 }, (_, i) => ob(i)) }, quality: [{ hkey: "h1", observed_at: at(0), code: "quality_ok" }] });
  assert.equal(steady.score, 100);
  assert.equal(steady.band, "high");
  assert.equal(steady.confidence, "medium");
  assert.deepEqual(steady.breakdown.drift, { value: 1, weight: 20, points: 20 });
  // always-skip seller with perfectly stable (wrong) terms: capped to low
  const sk = computeReputation({ host: "k.test", now, firstSeen: at(10), receipts: Array.from({ length: 10 }, (_, i) => ({ url: "https://k.test/a", created_at: at(i), verdict: "skip" })), histories: { h1: Array.from({ length: 10 }, (_, i) => ob(i)) } });
  assert.equal(sk.breakdown.verdicts.value, 0);
  assert.equal(sk.capped, true);
  assert.equal(sk.score, 49);
  assert.equal(sk.band, "low");
  // wallet hopper: pay_to flips every observation -> drift 0, stability low, skips
  const hop = computeReputation({ host: "h.test", now, firstSeen: at(10), receipts: Array.from({ length: 10 }, (_, i) => ({ url: "https://h.test/a", created_at: at(i), verdict: i % 2 ? "pay" : "skip" })), histories: { h1: Array.from({ length: 10 }, (_, i) => ob(i, i % 2 ? "0xa" : "0xb")) }, quality: [] });
  assert.equal(hop.breakdown.drift.value, 0);
  assert.equal(hop.breakdown.quality.value, null, "no quality data: weight renormalized, not zero");
  assert.equal(hop.inputs.pay_to_changes, 9);
  assert.equal(hop.band, "low");
  assert.ok(hop.score < 50);
  // price-only change counts half
  const pr = computeReputation({ host: "p.test", now, firstSeen: at(10), receipts: [], histories: { h1: [ob(0, "0xa", "2000"), ob(1), ob(2), ob(3), ob(4)] } });
  assert.equal(pr.inputs.price_changes, 1);
  assert.equal(pr.breakdown.drift.value, 0.75); // 1 - 2*0.5/4
  // new host: 2 observations today -> insufficient_data, score null, provisional kept for paid
  const fresh = computeReputation({ host: "n.test", now, firstSeen: at(0), receipts: [{ url: "https://n.test/a", created_at: at(0), verdict: "skip" }, { url: "https://n.test/a", created_at: at(0), verdict: "skip" }], histories: {} });
  assert.equal(fresh.band, "insufficient_data");
  assert.equal(fresh.score, null);
  assert.equal(fresh.low_data, true);
  assert.equal(typeof fresh.provisional_score, "number");
  // rules.json publishes the exact formula, weights and quality codes; existing reason codes untouched
  const rj = rulesJson("https://402xagent.com");
  assert.deepEqual(rj.reputation.weights, REPUTATION_WEIGHTS);
  assert.match(rj.reputation.formula, /sum\(w_i \* c_i\)/);
  assert.equal(rj.reason_codes.length, 16);
  assert.ok(rj.quality_codes.some((q) => q.code === "quality_schema_mismatch"));
  assert.ok(rj.fields.reputation && rj.fields.quality);
  const html = await (await worker.fetch(new Request("https://lookup.test/rules", { headers: { "user-agent": "agent-x/1.0" } }), spotEnv().env, { waitUntil() {} })).text();
  assert.match(html, /Seller reputation/);
  assert.match(html, /quality_unreachable/);
  // live: paid/exempt full object; free + dry-run band only; KV never written
  let kvPuts = 0;
  const kv = { get: async () => null, put: async () => { kvPuts++; } };
  const db = fakeD1();
  const e = spotEnv({ RECEIPTS_DB: db, SPOT_PROBE_CACHE_S: "0", CRAWL_KV: kv });
  spotTargetMode = "402";
  const u = "?url=" + encodeURIComponent("https://spot.target.test/rep") + "&claimed_price=0.001";
  const first = await send(SPOT + u + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(first.body.reputation.host, "spot.target.test");
  assert.equal(first.body.reputation.band, "insufficient_data", "one observation: not scored");
  for (let i = 0; i < 5; i++) await send(SPOT + u + "&client=withgrokbot-selftest", { envo: e });
  const full = await send(SPOT + u + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(full.body.verdict, "pay");
  assert.equal(full.body.reason_code, "price_ok");
  const rep = full.body.reputation;
  assert.deepEqual(Object.keys(rep.breakdown), ["stability", "drift", "verdicts", "freshness", "quality"]);
  assert.ok(rep.inputs.observations >= 5);
  assert.equal(rep.band, "insufficient_data", "tracked < 2 days stays insufficient_data");
  const free = await send(SPOT + u + "&client=rep-free-1", { envo: e });
  assert.deepEqual(Object.keys(free.body.reputation).sort(), ["band", "host", "rules"]);
  const dry = await send(SPOT + u + "&client=rep-dry-1&mode=dry-run", { envo: e });
  assert.deepEqual(Object.keys(dry.body.reputation).sort(), ["band", "host", "rules"]);
  // age the data 3 days: now scored
  for (const r of db.rows) r.created_at = "2026-10-01T00:00:00Z";
  const aged = await send(SPOT + u + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(typeof aged.body.reputation.score, "number");
  assert.notEqual(aged.body.reputation.band, "insufficient_data");
  const pg = await send("/reputation/spot.target.test.json", { envo: e });
  assert.equal(pg.status, 200);
  assert.equal(pg.body.band, aged.body.reputation.band);
  assert.equal(pg.body.score, undefined, "free page: band only");
  assert.equal((await send("/reputation/not a host", { envo: e })).status, 400);
  assert.equal(kvPuts, 0, "no KV writes");
  // no store: answers still work, reputation null
  const none = await send(SPOT + u + "&client=withgrokbot-selftest", { envo: spotEnv() });
  assert.equal(none.body.reputation, null);
  assert.equal(none.body.verdict, "pay");
  const mig = (await import("node:fs")).readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "migrations", "0007_endpoint_quality.sql"), "utf8");
  assert.match(mig, /CREATE TABLE IF NOT EXISTS endpoint_quality/);
});

test("0.37.1: /receipts and /skips.json 301 to /v1 keeping the query; /pricing and /docs pages; sitemap + llms.txt; 0 KV writes", async () => {
  const e = mkEnv(); let puts = 0;
  for (const k of Object.keys(e.env)) { const b = e.env[k]; if (b && typeof b.put === "function") { const o = b.put.bind(b); b.put = async (...a) => { puts++; return o(...a); }; } }
  const raw = async (path, host = "https://402xagent.com") => worker.fetch(new Request(host + path, { headers: { "user-agent": "agent-x/1.0", "cf-connecting-ip": "203.0.113.7" } }), e.env, { waitUntil() {} });
  for (const host of ["https://402xagent.com", "https://api.402xagent.com"]) {
    let r = await raw("/receipts", host); assert.equal(r.status, 301); assert.equal(r.headers.get("location"), "/v1/receipts");
    r = await raw("/receipts?type=dry-run&page=2", host); assert.equal(r.status, 301); assert.equal(r.headers.get("location"), "/v1/receipts?type=dry-run&page=2");
    r = await raw("/skips.json?x=1", host); assert.equal(r.status, 301); assert.equal(r.headers.get("location"), "/v1/skips.json?x=1");
    r = await raw("/receipts/", host); assert.equal(r.status, 301);
    r = await raw("/pricing", host); assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/html/);
    const ph = await r.text();
    assert.match(ph, /5 live checks per client per UTC day, at most 25 per network/);
    assert.match(ph, /\$0\.02 per check, flat/);
    assert.match(ph, /\$0\.20 for 10 checks \(\$0\.02 each\)/);
    assert.match(ph, /\$9/); assert.match(ph, /href="\/rules"/); assert.match(ph, /href="\/openapi\.json"/);
    r = await raw("/docs", host); assert.equal(r.status, 200);
    const dh = await r.text();
    for (const l of ['href="/openapi.json"', 'href="/rules"', 'href="/llms.txt"', "/mcp", "github.com/withgrokbot/x402-spotcheck"]) assert.ok(dh.includes(l), l);
  }
  const sm = await (await raw("/sitemap.xml")).text(); assert.match(sm, /\/pricing<\/loc>/); assert.match(sm, /\/docs<\/loc>/);
  const ll = await (await raw("/llms.txt")).text(); assert.match(ll, /Pricing: https:\/\/402xagent\.com\/pricing/);
  assert.equal((await raw("/v1/receipts")).status === 404, false);
  assert.equal((await raw("/nope-404")).status, 404);
  assert.equal(puts, 0);
});

test("0.37.2: stale free-tier text says 5/day; sitemap lists rules/bazaar/saves; CORS on llms/sitemap/robots; OpenAPI lists live free routes; reputation JSON charset; no duplicate key; 0 KV writes", async () => {
  const e = mkEnv(); let puts = 0;
  for (const k of Object.keys(e.env)) { const b = e.env[k]; if (b && typeof b.put === "function") { const o = b.put.bind(b); b.put = async (...a) => { puts++; return o(...a); }; } }
  const raw = async (path, host = "https://402xagent.com", accept = "*/*") => worker.fetch(new Request(host + path, { headers: { accept, "user-agent": "agent-x/1.0", "cf-connecting-ip": "203.0.113.7" } }), e.env, { waitUntil() {} });
  const home = await (await raw("/", "https://402xagent.com", "text/html")).text();
  assert.ok(!/1 check per client per UTC day/.test(home)); assert.ok(!/one per day per network/.test(home));
  assert.match(home, /5 checks per client per UTC day, at most 25 per network/);
  assert.match(home, /real free 402xAgent check: 5 per day \(at most 25 per network\)/);
  const r402 = await raw("/v1/lookup/paid?task=web-search&max_price=0.01", "https://api.402xagent.com");
  assert.equal(r402.status, 402);
  const b = await r402.json(); assert.equal(b.x402Version, 2);
  assert.match(b.free_check.free, /^5 checks per client per UTC day/);
  const hdr = JSON.parse(atob(r402.headers.get("payment-required")));
  assert.equal(hdr.x402Version, 2); for (const k of ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds"]) assert.ok(hdr.accepts[0][k] != null, k);
  assert.ok(!(await (await raw("/sitemap.xml")).text()).includes("/saves</loc>"));
  e.env.SAVES_PAGE = "on";
  const sm = await raw("/sitemap.xml"); const smt = await sm.text();
  for (const p of ["/rules", "/rules.json", "/bazaar", "/bazaar.json", "/saves", "/saves.json", "/pricing", "/docs"]) assert.ok(smt.includes("402xagent.com" + p + "</loc>"), p);
  for (const p of ["/sitemap.xml", "/llms.txt", "/robots.txt"]) assert.equal((await raw(p)).headers.get("access-control-allow-origin"), "*", p);
  const oa = await (await raw("/openapi.json")).json();
  for (const p of ["/v1/skips.json", "/badge/{host}", "/pricing", "/docs", "/.well-known/x402", "/health"]) assert.ok(oa.paths[p], p);
  for (const p of Object.keys(oa.paths)) { if (p.includes("{")) continue; const s = (await raw(p === "/mcp" ? "/health" : p.replace("/v1/lookup/paid", "/health").replace(/^\/v1\/lookup$/, "/health").replace("/v1/receipts/by-url", "/health").replace(/^\/v1\/discover$/, "/health").replace(/^\/v1\/products\/.*/, "/health"))).status; assert.equal(s, 200, p); }
  assert.equal((await (await raw("/health")).json()).version, VERSION);
  const rep = await raw("/reputation/api.402rates.com.json"); assert.equal(rep.headers.get("content-type"), "application/json; charset=utf-8");
  const src = (await import("node:fs")).readFileSync(new URL("../worker/src/lib.js", import.meta.url), "utf8");
  assert.equal((src.match(/^\s*pay_to_changed: (false|null),$/gm) || []).length, 3);
  const sj = JSON.parse((await import("node:fs")).readFileSync(new URL("../server.json", import.meta.url), "utf8")); assert.equal(sj.version, VERSION);
  assert.equal(puts, 0);
});

test("0.37.3 signed receipts: ed25519 over JCS minus signature, key at /.well-known, kid-matched; no secret = unsigned and unchanged; bad secret = unsigned, no error", async () => {
  const { generateKeyPairSync, createPublicKey, verify } = await import("node:crypto");
  const S = await import("../worker/src/sign.js");
  const pub = (await send("/.well-known/402xagent-keys.json")).body;
  assert.ok(pub.keys.length >= 1 && pub.keys.every((k) => k.kty === "OKP" && k.crv === "Ed25519" && /^[A-Za-z0-9_-]{43}$/.test(k.x) && k.kid && !("d" in k)), "public keys only");
  assert.deepEqual((await send("/.well-known/402xagent-receipt-key.json")).body, pub);
  assert.equal((await send("/.well-known/x402")).body.receipt_keys, "https://api.402xagent.com/.well-known/402xagent-keys.json");
  const t = SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=0.001";
  spotTargetMode = "402";
  // no secret: unsigned, same receipt as before
  const db0 = fakeD1(), e0 = spotEnv({ RECEIPTS_DB: db0 });
  const r0 = await send(t + "&client=sig-0", { envo: e0 });
  const g0 = (await send("/v1/receipts/" + r0.body.receipt_id, { envo: e0 })).body;
  assert.ok(!("signature" in g0) && !("kid" in g0) && !db0.rows[0].body.includes("signed_view"));
  // a key that is not published, or junk: unsigned, no error
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = { ...privateKey.export({ format: "jwk" }), kid: "test-sig-1" };
  for (const bad of [JSON.stringify(jwk), "not json", "{}"]) {
    S._resetSigner();
    const db = fakeD1(), e = spotEnv({ RECEIPTS_DB: db, RECEIPT_SIGNING_KEY: bad });
    const r = await send(t + "&client=sig-bad", { envo: e });
    assert.equal(r.status, 200);
    assert.ok(!("signature" in (await send("/v1/receipts/" + r.body.receipt_id, { envo: e })).body));
  }
  // a published key: signed and verifiable offline
  S._addTestKey({ kid: jwk.kid, x: jwk.x });
  S._resetSigner();
  const db = fakeD1(), e = spotEnv({ RECEIPTS_DB: db, RECEIPT_SIGNING_KEY: JSON.stringify(jwk) });
  const r = await send(t + "&client=sig-ok", { envo: e });
  assert.deepEqual(Object.keys(r.body).sort(), Object.keys(r0.body).sort(), "check response shape unchanged");
  const g = (await send("/v1/receipts/" + r.body.receipt_id, { envo: e })).body;
  assert.equal(g.kid, "test-sig-1");
  assert.match(g.signature, /^[A-Za-z0-9_-]{86}$/);
  const { signature, ...rest } = g;
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
  assert.ok(verify(null, Buffer.from(S.canonicalize(rest)), key, Buffer.from(signature, "base64url")));
  // 0.42.4: the client param is stored but never in a public view, signed or not
  assert.ok(!("client" in g), "receipts never expose the client id publicly");
  assert.equal(JSON.parse(db.rows[db.rows.length - 1].body).client, "sig-ok", "stored row keeps client");
  { // a row signed under 0.42.3 (client inside signed_view) is stripped and re-signed on read
    const row = db.rows[db.rows.length - 1], saved = row.body, b = JSON.parse(row.body);
    b.signed_view = { ...b.signed_view, client: "sig-ok" }; row.body = JSON.stringify(b);
    const h = (await send("/v1/receipts/" + r.body.receipt_id, { envo: e })).body;
    assert.ok(!("client" in h), "legacy signed view: client stripped");
    const { signature: sg, ...rs } = h;
    assert.ok(verify(null, Buffer.from(S.canonicalize(rs)), key, Buffer.from(sg, "base64url")), "re-signed view verifies");
    const list = (await send("/v1/receipts?type=live", { envo: e })).body;
    assert.ok(list.receipts.length >= 1 && list.receipts.every((x) => !("client" in x)), "list never exposes client");
    row.body = saved;
  }
  assert.ok(!verify(null, Buffer.from(S.canonicalize({ ...rest, verdict: "skip" })), key, Buffer.from(signature, "base64url")));
  const { signature: _s, kid: _k, ...g0rest } = g;
  assert.deepEqual(Object.keys(g0rest).sort(), Object.keys(g0).sort(), "signed view = the served receipt + kid + signature");
  assert.equal(g.redacted, g0.redacted, "free-tier redaction still applies");
  assert.ok(!db.rows[0].body.includes(jwk.d) && !JSON.stringify(g).includes(jwk.d), "private key never stored or served");
  const { normReceipt } = await import("../worker/src/lib.js");
  assert.deepEqual(normReceipt(JSON.parse(db.rows[0].body)), g, "every read path (lists too) serves the signed view");
  // the docs snippet verifies the served receipt too (same JCS, no dependencies)
  const { VERIFY_SNIPPET } = await import("../worker/src/pages.js");
  const jcsSrc = VERIFY_SNIPPET.slice(VERIFY_SNIPPET.indexOf("const jcs = ") + 12, VERIFY_SNIPPET.indexOf("\nconst receipt")).trim().replace(/;$/, "");
  const jcs = new Function("const jcs = " + jcsSrc + "; return jcs;")();
  assert.equal(jcs(rest), S.canonicalize(rest));
  try { const W = await import("/workspace/products/x402-spotcheck/receipt.js"); assert.equal((await W.verifyReceipt(g, { publicKey: { keys: [{ kty: "OKP", crv: "Ed25519", kid: jwk.kid, x: jwk.x }] } })).valid, true); } catch (err) { if (err.code !== "ERR_MODULE_NOT_FOUND") throw err; }
  S._resetSigner();
});

test("0.38.0 flat $0.02: 402 amount 20000 for any quote; well-known/OpenAPI/llms/home/pricing say $0.02; pack $9 and badges unchanged; old 1/10 copy gone", async () => {
  const L = await import("../worker/src/lib.js");
  for (const q of [null, 0.0001, 0.001, 0.2, 5, 1000]) assert.equal(L.spotDynCfg({ priceAtomic: "250000" }, q).priceAtomic, "20000", String(q));
  assert.equal(L.spotDynCfg({}, 5).priceUsd, "0.02");
  const wk = (await send("/.well-known/x402")).body;
  const sc = wk.resourceCatalog.find((r) => r.url.endsWith("/endpoint-spot-check"));
  assert.equal(sc.accepts[0].amount, "20000");
  assert.deepEqual(sc.price, { mode: "fixed", currency: "USD", amount: "0.02" });
  assert.equal(wk.resourceCatalog.find((r) => r.url.endsWith("/overnight-cos-pack")).accepts[0].amount, "9000000", "pack unchanged");
  const oa = (await send("/openapi.json")).body;
  assert.equal(oa.paths["/v1/products/endpoint-spot-check"].get["x-payment-info"].price.amount, "0.02");
  const raw = async (p, h = {}) => worker.fetch(new Request("https://402xagent.com" + p, { headers: h }), mkEnv().env, { waitUntil() {} });
  const llms = await (await raw("/llms.txt")).text();
  assert.match(llms, /\$0\.02 USDC a check/);
  const home = await (await raw("/", { accept: "text/html" })).text();
  const pricing = await (await raw("/pricing")).text();
  for (const [n, t] of [["llms", llms], ["home", home], ["pricing", pricing], ["openapi", JSON.stringify(oa)], ["well-known", JSON.stringify(wk)]]) {
    assert.ok(!/one tenth|1\/10 of the target|\$0\.01 to \$0\.25|\$0\.01-\$0\.25|from \$0\.01/.test(t), n + " still has the old price copy");
  }
  assert.match(home, /5 free checks a day, from \$0\.02/);
  assert.match(home, /free_per_day(&quot;|"|&#34;): 5/);
  assert.match(pricing, /\$9 \(<code>\/v1\/products\/overnight-cos-pack/);
  const b = await raw("/badge/api.402rates.com.svg"); assert.equal(b.status, 200);
  assert.ok(!/\$0\.0/.test(await b.text()), "badges carry no price");
});

test("0.38.0 crawl schedule copy: 'Updated weekly (last crawl Oct 13, next crawl Oct 19)' computed from crawled_at on home + skips", async () => {
  const { crawlSchedule, crawlScheduleText } = await import("../worker/src/skips.js");
  const { landingHtml } = await import("../worker/src/landing.js");
  assert.deepEqual(crawlSchedule("2026-10-13T14:36:14Z"), { last: "Oct 13", next: "Oct 19", last_iso: "2026-10-13", next_iso: "2026-10-19" });
  assert.equal(crawlSchedule("2026-10-19T09:00:00Z").next, "Oct 26", "on its Monday: last + 7 days");
  assert.equal(crawlSchedule("2026-12-28T23:59:00Z").next, "Jan 4", "year rollover");
  assert.equal(crawlScheduleText("nope"), "Updated weekly.");
  const html = landingHtml("https://402xagent.com", { crawled_at: "2026-11-02T14:00:00Z", endpoints_covered: 9 });
  assert.match(html, /Updated weekly \(last crawl Nov 2, next crawl Nov 9\)\. Each row has a public receipt\./);
  assert.match(html, />9 checks · last crawl Nov 2</);
  assert.ok(!/crawl of 20/.test(html));
  const live = landingHtml("https://402xagent.com");
  const exp = crawlScheduleText(RECEIPTS_META.crawled_at);
  assert.ok(live.includes(exp.replace(/\(/g, "(")), "home uses the bundled crawl date");
  const sk = await worker.fetch(new Request("https://402xagent.com/v1/skips", { headers: { accept: "text/html" } }), mkEnv().env, { waitUntil() {} });
  const skt = await sk.text();
  assert.ok(skt.includes(exp), "skips page uses the same wording");
  assert.ok(!/crawled 20\d\d-/.test(skt));
});

test("0.38.0: no served page, JSON, 402 or MCP text carries the old price copy (one tenth / 1/10 / $0.01-$0.25) or a free_per_day other than 5", async () => {
  const OLD = /one tenth|tenth of the (target|endpoint)|1\/10 of|\$0\.01 ?(to|-) ?\$0\.25|0\.01-0\.25|from \$0\.01|\$0\.01\+|\$0\.001\/check|\$0\.001 per check/i;
  const e = spotEnv({ SPOT_FREE_PER_DAY: "5", SAVES_PAGE: "on" });
  const paths = ["/", "/llms.txt", "/openapi.json", "/.well-known/x402", "/.well-known/402xagent-keys.json", "/pricing", "/docs", "/blog", "/blog/meet-402xagent-check-before-your-agent-pays", "/blog/preflight-budget-then-check", "/blog/x402-retry-double-pay-check-before-you-resign", "/blog/x402-skips-report-what-agents-almost-paid-for", "/blog/x402-spotcheck-audit-layer-budgets-ledger", "/rules", "/rules.json", "/v1/skips", "/v1/skips.json", "/bazaar", "/bazaar.json", "/saves", "/saves.json", "/health", "/v1/tasks", "/v1/products/endpoint-spot-check", "/v1/products/endpoint-spot-check?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=old-copy", "/v1/lookup/paid", "/badge/api.402rates.com"];
  spotTargetMode = "402";
  for (const p of paths) for (const accept of ["application/json", "text/html"]) {
    const r = await worker.fetch(new Request("https://402xagent.com" + p, { headers: { accept, "user-agent": "agent-x/1.0", "cf-connecting-ip": "203.0.113.9" } }), e.env, { waitUntil() {} });
    let t = await r.text();
    const ph = r.headers.get("payment-required"); if (ph) t += atob(ph);
    for (const fp of t.matchAll(/free_per_day(?:\\?"|&quot;|&#34;)?\s*:\s*(\d+)/g)) assert.equal(fp[1], "5", `${p} (${accept}) sample says free_per_day ${fp[1]}`);
    assert.ok(!/1 free check per|1 check\/day|1 free\/day/i.test(t), `${p} (${accept}) says 1 free a day`);
    const m = t.match(OLD);
    assert.ok(!m, `${p} (${accept}) still says "${m && t.slice(Math.max(0, m.index - 60), m.index + 60)}"`);
  }
  const rpc = async (body) => (await worker.fetch(new Request("https://402xagent.com/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }), e.env, { waitUntil() {} })).text();
  const tools = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.match(tools, /endpoint_spot_check/);
  assert.ok(!OLD.test(tools), "MCP tools/list");
  const call = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "endpoint_spot_check", arguments: { url: "https://spot.target.test/api" } } });
  assert.ok(!OLD.test(call), "MCP tool 402 text");
});

test("0.39.0 home: 'Try a check' runs the free Try-it flow; REAL stored example (listing -> live 402 -> verdict); networks + limits; /docs#quick-start; hosted offer marked coming soon", async () => {
  const { landingHtml, HOME_EXAMPLE } = await import("../worker/src/landing.js");
  const html = landingHtml("https://402xagent.com");
  assert.equal((html.match(/class="btn primary"[^>]*>Try a check</g) || []).length, 1, "one primary Try a check button");
  assert.match(html, /id="trynow"/); assert.match(html, /\$\("#trynow"\)[\s\S]*run\(\)/, "button reuses run()");
  assert.match(html, /no signup/i);
  // the example is the real crawl receipt 3a76c5c79b, byte for byte against the stored record
  const rec = JSON.parse((await import("node:fs")).readFileSync("/workspace/factory/jobs/BM-001-verified-catalog/receipts/receipts-20261013T143614Z.jsonl", "utf8").split("\n").find((l) => l.includes('"id":"3a76c5c79b"') || l.includes('"id": "3a76c5c79b"')) || "null");
  if (rec) {
    assert.equal(HOME_EXAMPLE.url, rec.url); assert.equal(HOME_EXAMPLE.listing.price_usd, rec.claimed_price_usd); assert.equal(HOME_EXAMPLE.live_402.price_usd, rec.quoted_price_usd);
    assert.equal(HOME_EXAMPLE.live_402.pay_to, rec.pay_to); assert.equal(HOME_EXAMPLE.verdict, rec.verdict); assert.equal(HOME_EXAMPLE.reason, rec.reason); assert.equal(HOME_EXAMPLE.checked_at, rec.timestamp);
    assert.equal(HOME_EXAMPLE.listing.source, rec.source_list); assert.equal(HOME_EXAMPLE.live_402.network, rec.network); assert.equal(HOME_EXAMPLE.method, rec.method);
  }
  assert.match(html, /href="\/v1\/receipts\/3a76c5c79b"/);
  assert.match(html, /<b>Listing<\/b> \(agent-tools-cloud\): \$0\.05/); assert.match(html, /<b>Live 402<\/b> \(POST, HTTP 402\): \$0\.25 USDC on Base/); assert.match(html, /rx-skip">skip</);
  assert.match(html, /canonical USDC on Base, Ethereum, OP Mainnet, Polygon, Arbitrum, Avalanche and Solana;/);
  assert.match(html, /can&#39;t verify|can't verify/);
  assert.match(html, /href="\/docs#quick-start"/);
  assert.ok(!/coming soon|Hosted mode/i.test(html), "no hosted coming-soon offer");
  { const nav = html.match(/<nav aria-label="Primary">([\s\S]*?)<\/nav>/)[1]; assert.match(nav, /<a href="\/blog">Blog<\/a>/, "0.39.2: Blog in top nav, no hide-sm"); }
  assert.match(html.match(/<nav aria-label="Footer">([\s\S]*?)<\/nav>/)[1], /href="\/blog"/, "Blog in footer");
  for (const p of ["/pricing", "/docs", "/blog", "/v1/skips"]) assert.match(await (await worker.fetch(new Request("https://402xagent.com" + p, { headers: { accept: "text/html" } }), {}, {})).text(), /href="\/blog"/, p + " links /blog");
  for (const s of [html, ...await Promise.all(["/llms.txt", "/docs", "/pricing", "/openapi.json", "/.well-known/x402"].map(async (p) => (await worker.fetch(new Request("https://402xagent.com" + p), {}, {})).text()))]) assert.ok(!/router integration gets|1,000 free checks|offer-h/i.test(s), "0.39.1: router-integration offer card removed");
  assert.match(html, /Checks read these networks: /); assert.match(html, /You pay us in USDC on Base\./);
  assert.ok(html.includes(Number(RECEIPTS_META.endpoints_covered).toLocaleString("en-US") + " checks · last crawl"), "hero label formatted from data");
  assert.match(landingHtml("https://402xagent.com", { crawled_at: "2026-10-13T00:00:00Z", endpoints_covered: 121785 }), />121,785 checks · last crawl Oct 13</);
  const L = await import("../worker/src/lib.js");
  for (const net of ["eip155:8453", "eip155:1", "eip155:10", "eip155:137", "eip155:42161", "eip155:43114", "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp"]) assert.ok(L.USDC_BY_NETWORK[net], net + " supported as claimed");
  assert.equal(Object.keys(L.USDC_BY_NETWORK).length, 7, "the networks line lists every supported network");
  const docs = await (await worker.fetch(new Request("https://402xagent.com/docs"), mkEnv().env, { waitUntil() {} })).text();
  assert.match(docs, /id="quick-start"/);
});

test("0.39.0 blog: bundled posts, /blog list + /blog/<slug>, sitemap + llms.txt, editorial notes not published, prices match 0.38.0, no personal identifiers", async () => {
  const { BLOG_POSTS } = await import("../worker/src/blog-data.js");
  const { renderMarkdown } = await import("../worker/scripts/build_blog.mjs");
  assert.ok(BLOG_POSTS.length >= 2);
  const env = mkEnv().env;
  const get = async (p) => { const r = await worker.fetch(new Request("https://402xagent.com" + p, { headers: { accept: "text/html" } }), env, { waitUntil() {} }); return { status: r.status, ct: r.headers.get("content-type"), t: await r.text() }; };
  const list = await get("/blog");
  assert.equal(list.status, 200); assert.match(list.ct, /text\/html/);
  for (const p of BLOG_POSTS) {
    assert.ok(list.t.includes(`href="/blog/${p.slug}"`), p.slug);
    const r = await get("/blog/" + p.slug);
    assert.equal(r.status, 200, p.slug);
    assert.ok(r.t.includes(`<link rel="canonical" href="https://402xagent.com/blog/${p.slug}">`));
    assert.ok(!/Alternative headlines|<!--|Pricing written for/.test(r.t), p.slug + ": editorial notes stripped");
    assert.ok(!/<script/i.test(p.html), "no script in posts");
    if (r.t.includes("5,768")) assert.match(r.t, /5,768(<\/strong>)? cases asked more than listed \(per <a href="https:\/\/402xagent\.com\/saves">\/saves<\/a>, last 30 days\)|per \/saves, last 30 days\)<\/td><td class="r">5,768/, p.slug + ": 5,768 cites /saves");
    if (r.t.includes("5,788")) assert.match(r.t, /<td class="r">5,788<\/td>|5,788 skips \(per <a href="https:\/\/402xagent\.com\/v1\/skips\.json">/, p.slug + ": 5,788 cites skips.json");
    assert.ok(!/one tenth|1\/10 of|\$0\.01 ?(to|-) ?\$0\.25|1 free check/i.test(r.t), p.slug + ": no old price");
    for (const m of r.t.matchAll(/\$(\d+\.\d+) (USDC )?per (paid )?check/g)) assert.equal(m[1], "0.02", p.slug);
    for (const m of r.t.matchAll(/(\d+) (free|live) checks (per|a) day/g)) assert.equal(m[1], "5", p.slug);
  }
  assert.equal((await get("/blog/nope")).status, 404);
  const sm = (await get("/sitemap.xml")).t;
  assert.ok(sm.includes("https://402xagent.com/blog</loc>")); for (const p of BLOG_POSTS) assert.ok(sm.includes(`/blog/${p.slug}</loc>`));
  const llms = (await get("/llms.txt")).t;
  assert.match(llms, /Blog: https:\/\/402xagent\.com\/blog/); for (const p of BLOG_POSTS) assert.ok(llms.includes(`https://402xagent.com/blog/${p.slug}`));
  // renderer: tables, code, lists, links, escaping, editorial tail
  const h = renderMarkdown("# T\n\nA **b** `c<d>` [l](https://x.y) <i>x</i>\n\n| a | b |\n|---|---:|\n| 1 | 2 |\n\n- x\n- y\n\n```js\nq<1\n```\n<!-- note -->\n\n---\n\n**Alternative headlines**\n\n1. Z");
  assert.ok(h.includes('<h1 id="t">T</h1>') && h.includes("<strong>b</strong>") && h.includes("<code>c&lt;d&gt;</code>") && h.includes('<a href="https://x.y">l</a>') && h.includes("&lt;i&gt;x&lt;/i&gt;"));
  assert.ok(h.includes('<th class="r">b</th>') && h.includes("<ul><li>x</li><li>y</li></ul>") && h.includes('<pre><code class="lang-js">q&lt;1</code></pre>'));
  assert.ok(!h.includes("note") && !h.includes("Alternative") && !h.includes("Z"));
  assert.equal(renderMarkdown("[x](javascript:alert)"), "<p>x</p>", "no javascript: links");
});

// Personal-identifier check: the forbidden terms live OUTSIDE every repo, in one local file (mode 600, one per line):
// $FORBIDDEN_TERMS_FILE, default /home/box/.secrets/forbidden-terms.txt. Whole-word, case-insensitive. Skipped if absent.
test("0.39.0 blog: no personal identifiers in any post (terms from the local forbidden-terms file)", async (t) => {
  const { readFileSync, existsSync } = await import("node:fs");
  const f = process.env.FORBIDDEN_TERMS_FILE || "/home/box/.secrets/forbidden-terms.txt";
  if (!existsSync(f)) t.skip(`forbidden-terms file not found (${f}; set FORBIDDEN_TERMS_FILE): personal-identifier check skipped`);
  const terms = readFileSync(f, "utf8").split("\n").map((x) => x.trim()).filter((x) => x && !x.startsWith("#"));
  if (!terms.length) t.skip("forbidden-terms file has no terms: personal-identifier check skipped");
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?<![A-Za-z0-9_])(" + terms.map(esc).join("|") + ")(?![A-Za-z0-9_])", "i");
  const { BLOG_POSTS } = await import("../worker/src/blog-data.js");
  const env = mkEnv().env;
  for (const p of BLOG_POSTS) {
    const r = await worker.fetch(new Request("https://402xagent.com/blog/" + p.slug, { headers: { accept: "text/html" } }), env, { waitUntil() {} });
    assert.ok(!re.test(await r.text()), p.slug + ": no personal identifiers");
  }
});


test("0.42.3 receipt labels: check_type matches the real mode (live / dry-run / self-checked); client stored only when given (never served publicly); same single write", async () => {
  const db = fakeD1(); const e = spotEnv({ RECEIPTS_DB: db });
  spotTargetMode = "402";
  const base = SPOT + "?url=" + encodeURIComponent("https://spot.target.test/lbl") + "&claimed_price=0.001";
  await send(base + "&client=receipt-label-check", { envo: e });
  await send(base + "&client=receipt-label-dry&mode=dry-run", { envo: e });
  await send(base, { envo: e });
  const rows = db.rows.map((r) => ({ ct: r.check_type, b: JSON.parse(r.body) }));
  assert.equal(rows.length, 3, "one receipt row per call (no extra writes)");
  assert.deepEqual(rows.map((r) => [r.ct, r.b.check_type, r.b.mode, r.b.dry_run, r.b.client]), [
    ["live", "live", "live", false, "receipt-label-check"],
    ["dry-run", "dry-run", "dry-run", true, "receipt-label-dry"],
    ["live", "live", "live", false, null],
  ]);
  for (const r of rows) assert.ok(r.ct !== "dry-run" || r.b.dry_run === true, "check_type dry-run only for real dry runs");
  for (const r of rows) { const g = (await send("/v1/receipts/" + r.b.id, { envo: e })).body; assert.equal(g.check_type, r.ct); assert.ok(!("client" in g), "receipts never expose the client id publicly"); }
});

// ---------------- 0.44.0 crawl storage in D1 (crawl_store), KV fallback for keys not migrated ----------------
function crawlD1(rows = []) {
  const calls = { select: 0 };
  return {
    calls, rows,
    prepare(sql) {
      return { bind(...a) { return { async all() {
        if (!/FROM crawl_store WHERE key = \?/.test(sql)) throw new Error("unexpected sql " + sql);
        calls.select++;
        return { results: rows.filter((r) => r.key === a[0]).sort((x, y) => x.part - y.part).map(({ part, parts, sha256, value }) => ({ part, parts, sha256, value })) };
      }, async first() { return null; }, async run() { return {}; } }; } };
    },
  };
}
const sha256hex = (t) => createHash("sha256").update(t).digest("hex");
function d1Put(rows, key, obj, partSize = 50) {
  const text = JSON.stringify(obj), h = sha256hex(text), parts = [];
  for (let i = 0; i < text.length; i += partSize) parts.push(text.slice(i, i + partSize));
  parts.forEach((v, i) => rows.push({ key, part: i, parts: parts.length, sha256: h, value: v }));
}
test("0.44.0 crawl store: receipts and skip pages come from D1 (multi-part, sha-checked); KV only for keys not in D1", async () => {
  const { _clearCrawlStoreCache, crawlStoreGet } = await import("../worker/src/skips.js");
  const ext = "https://spot.target.test/d1-thing", id = await receiptIdFor(ext);
  const rec = { id, url: ext, verdict: "skip", reason: "price_mismatch", listed_pay_to: "0x" + "33".repeat(20), listed_network: "eip155:8453" };
  const rows = []; d1Put(rows, "c:" + id.slice(0, 2), { [id]: rec }); d1Put(rows, "s:2", [rec]);
  assert.ok(rows.filter((r) => r.key === "s:2").length > 1, "value is split into several parts");
  const kvCalls = []; const kvRec = { ...rec, id: "ffffffffff", url: "https://kv.only.test/x" };
  const kv = { async get(k, o) { kvCalls.push(k); return k === "c:ff" ? { ffffffffff: kvRec } : null; } };
  const db = crawlD1(rows);
  _clearCrawlStoreCache();
  const e = spotEnv({ RECEIPTS_DB: db, CRAWL_KV: kv });
  const r = await send("/v1/receipts/" + id, { envo: e });
  assert.equal(r.status, 200); assert.equal(r.body.url, ext);
  assert.deepEqual(kvCalls, [], "a migrated key never touches KV");
  if ((RECEIPTS_META.skip_pages || 1) >= 2) {
    const p2 = await send("/v1/skips.json?page=2", { envo: e });
    assert.equal(p2.body.skips[0].id, id, "skip page 2 from D1");
  }
  const k = await send("/v1/receipts/ffffffffff", { envo: e });
  assert.equal(k.status, 200, "not-yet-migrated key falls back to KV"); assert.deepEqual(kvCalls, ["c:ff"]);
  // torn write (a part missing) or a sha mismatch is never served: KV fallback instead
  _clearCrawlStoreCache();
  const torn = rows.filter((x) => !(x.key === "s:2" && x.part === 1));
  assert.equal(await crawlStoreGet({ RECEIPTS_DB: crawlD1(torn) }, "s:2"), undefined);
  const bad = rows.map((x) => (x.key === "s:2" && x.part === 0 ? { ...x, value: " " + x.value.slice(1) } : x));
  assert.equal(await crawlStoreGet({ RECEIPTS_DB: crawlD1(bad) }, "s:2"), undefined);
  // table missing (migration not applied) or D1 down: KV, no crash
  _clearCrawlStoreCache();
  const down = { prepare() { return { bind() { return { async all() { throw new Error("no such table: crawl_store"); } }; } }; } };
  const kv2 = { async get(key) { return key === "c:" + id.slice(0, 2) ? { [id]: rec } : null; } };
  const f = await send("/v1/receipts/" + id, { envo: spotEnv({ RECEIPTS_DB: down, CRAWL_KV: kv2 }) });
  assert.equal(f.status, 200, "pre-migration deploy keeps serving from KV");
  _clearCrawlStoreCache();
});
test("0.44.0 d1_upload.py: parts <= 90 KB (UTF-8), delete+insert per key (files are D1 transactions), quotes escaped, only changed keys, meta last", () => {
  const code = String.raw`
import sys, json, hashlib
sys.path.insert(0, sys.argv[1])
import d1_upload as d
v = json.dumps({"x": "é" * 60000 + "it's"})
parts = d.split_parts(v)
sql, n = d.statements("c:ab", v, "2026-10-20T00:00:00Z")
ok = {
  "rejoin": "".join(parts) == v,
  "max_part": max(len(p.encode()) for p in parts) <= d.PART_BYTES,
  "nparts": n == len(parts) and n >= 2,
  "tx": sql[0].startswith("DELETE FROM crawl_store WHERE key = 'c:ab'") and all(x.startswith("INSERT INTO crawl_store") for x in sql[1:]),
  "quote": "it''s" in "".join(sql),
  "stmt_size": max(len(s.encode()) for s in sql) < 100000,
}
print(json.dumps(ok))`;
  const py = spawnSync("python3", ["-c", code, new URL("../scripts/weekly-crawl", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  const ok = JSON.parse(py.stdout);
  for (const [k, v] of Object.entries(ok)) assert.equal(v, true, k);
  const sh = readFileSync(new URL("../scripts/weekly-crawl/weekly_refresh_skips.sh", import.meta.url), "utf8");
  assert.match(sh, /CRAWL_STORE="\$\{CRAWL_STORE:-d1\}"/, "default is d1 since the cutover");
  assert.match(sh, /d1\) set \+e; python3 "\$S\/d1_upload.py" --remote/);
  const up = readFileSync(new URL("../scripts/weekly-crawl/d1_upload.py", import.meta.url), "utf8");
  assert.match(up, /todo = \[c for c in changed if have.get\(c\["key"\]\) != sha\(c\["value"\]\)\]/, "only changed keys");
  assert.match(up, /todo.sort\(key=lambda c: c\["key"\] in \("meta", "d:meta"\)\)/, "meta (and d:meta) last");
  assert.match(up, /--source", default="crawl", choices=\["crawl", "discover"\]/, "0.45.0: discovery blobs tagged source=discover");
  assert.match(sh, /build_discover_blobs\.py" "\$R\/\$\(cat "\$R\/latest\.txt"\)" "\$TMP\/d-blobs\.json" && python3 "\$S\/d1_upload\.py" --remote --source discover/, "0.45.0: weekly d1 run refreshes the d: blobs");
  const mig = readFileSync(new URL("../worker/migrations/0011_crawl_store.sql", import.meta.url), "utf8");
  assert.match(mig, /PRIMARY KEY \(key, part\)/);
});


// ---------------- 0.40.0 payment-status (after-payment check): mocked Base RPC, three sources ----------------
const PSA = "https://alch.test/v2/SECRETKEY123", PSB = "https://rpc2.test/k/SECRET2", PSP = "https://pub.test/";
const PS_FROM = "0x" + "a1".repeat(20), PS_NONCE = "0x" + "b2".repeat(32), PS_TX = "0x" + "c3".repeat(32), PS_SELLER = "0x" + "d4".repeat(20), PS_SUBMITTER = "0x" + "e5".repeat(20);
const PS_VB = 1900000000;
const psPad = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const psHex = (n) => "0x" + n.toString(16);
const psNode = (o = {}) => ({ head: 5000, time: PS_VB + 1000, used: false, event: null, receipt: null, fail: false, ...o });
let psChain = {};
const psCalls = [];
function psReceipt({ block, status = 1, to = PS_SELLER, value = 10000, from = PS_FROM, event = "used" }) {
  const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", U = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
  const logs = [{ address: USDC, topics: [T, psPad(from), psPad(to)], data: psPad(value.toString(16)) }];
  if (event === "used") logs.unshift({ address: USDC, topics: [U, psPad(from), PS_NONCE], data: "0x" });
  return { transactionHash: PS_TX, blockNumber: psHex(block), status: psHex(status), from: PS_SUBMITTER, logs };
}
const psFetch = (orig) => async (url, init = {}) => {
  const n = psChain[String(url)];
  if (!n) return orig(url, init);
  const { method, params } = JSON.parse(init.body);
  psCalls.push([String(url), method]);
  if (n.fail) return new Response("rate limited", { status: 429 });
  const R = (result) => Response.json({ jsonrpc: "2.0", id: 1, result });
  if (method === "eth_getBlockByNumber") return R({ number: psHex(n.head), timestamp: psHex(n.time) });
  if (method === "eth_call") {
    if (n.callFail) return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "call failed" } });
    assert.equal(params[0].to, USDC.toLowerCase()); assert.ok(params[0].data.startsWith("0xe94a0102"));
    assert.equal(params[0].data, "0xe94a0102" + psPad(PS_FROM).slice(2) + PS_NONCE.slice(2), "authorizationState(from, nonce) calldata");
    return R(psPad(n.used ? "1" : "0"));
  }
  if (method === "eth_getLogs") {
    if (n.logsFail) return new Response("limit", { status: 429 });
    assert.deepEqual(params[0].topics.slice(1), [psPad(PS_FROM), PS_NONCE]);
    if (!n.event) return R([]);
    return R([{ address: USDC, topics: [n.event === "canceled" ? "0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81" : "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5", psPad(PS_FROM), PS_NONCE], data: "0x", blockNumber: psHex(n.eventBlock ?? n.head - 50), transactionHash: n.event === "canceled" ? "0x" + "77".repeat(32) : PS_TX }]);
  }
  if (method === "alchemy_getAssetTransfers") {
    if (n.alchFail) return new Response("x", { status: 500 });
    assert.equal(params[0].fromAddress, PS_FROM); assert.deepEqual(params[0].contractAddresses, [USDC.toLowerCase()]); assert.equal(params[0].order, "desc");
    n.atParams = params[0];
    const hs = n.transfers || (n.event === "used" && n.receipt ? [PS_TX] : []);
    return R({ transfers: hs.map((hash) => ({ hash, from: PS_FROM, asset: "USDC" })) });
  }
  if (method === "eth_getTransactionReceipt" && !n.receipt && n.event === "canceled" && n.eventBlock != null) // a cancel tx: AuthorizationCanceled only, no Transfer
    return R({ transactionHash: params[0], blockNumber: psHex(n.eventBlock), status: "0x1", from: PS_FROM, logs: [{ address: USDC, topics: ["0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81", psPad(PS_FROM), PS_NONCE], data: "0x" }] });
  if (method === "eth_getTransactionReceipt") return R(typeof n.receiptFor === "function" ? n.receiptFor(params[0]) : n.receipt);
  return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } });
};
const PS_PAYLOAD = (o = {}) => b64({
  x402Version: 2,
  accepted: { scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC, payTo: PS_SELLER, ...(o.accepted || {}) },
  payload: { signature: "0x" + "ee".repeat(65), authorization: { from: PS_FROM, to: PS_SELLER, value: "10000", validAfter: "0", validBefore: String(o.vb ?? PS_VB), nonce: PS_NONCE } },
});
function psD1() {
  const rows = [];
  return { rows, prepare(sql) { return { bind(...a) { return {
    async run() { if (/^INSERT INTO payment_status/.test(sql)) rows.push({ id: a[0], lookup_key: a[1], status: a[2], created_at: a[3], body: a[4] }); return { success: true }; },
    async first() {
      if (/WHERE lookup_key = \?/.test(sql)) { const r = rows.filter((x) => x.lookup_key === a[0]).at(-1); return r ? { body: r.body } : null; }
      if (/WHERE id = \?/.test(sql)) { const r = rows.find((x) => x.id === a[0]); return r ? { body: r.body } : null; }
      return null;
    },
    async all() { return { results: [] }; },
  }; } }; } };
}
const PS = "/v1/products/payment-status";
function psEnv(extra = {}) { return spotEnv({ ALCHEMY_BASE_RPC_URL: PSA, RPC2_BASE_URL: PSB, PAYSTATUS_PUBLIC_RPC: PSP, PAYSTATUS_PUBLIC_RPC2: "off", RECEIPTS_DB: psD1(), SPOT_FREE_PER_DAY: "5", ...extra }); }
async function psSend(body, { envo, headers = {}, client = "ps-agent" } = {}) {
  const orig = globalThis.fetch;
  globalThis.fetch = psFetch(orig);
  try {
    return await send(PS, { envo, method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ client, ...body }) });
  } finally { globalThis.fetch = orig; }
}
const psSet = (a, b, p = psNode({ fail: true })) => { psChain = { [PSA]: a, [PSB]: b, [PSP]: p }; psCalls.length = 0; };

test("0.40.0 payment-status: bare GET/POST/HEAD -> x402 v2 discovery 402 at 20000 with Bazaar metadata, no RPC, nothing used or written", async () => {
  const e = psEnv();
  psSet(psNode(), psNode());
  for (const method of ["GET", "POST"]) {
    const orig = globalThis.fetch; globalThis.fetch = psFetch(orig);
    let r; try { r = await send(PS, { envo: e, method }); } finally { globalThis.fetch = orig; }
    assert.equal(r.status, 402, method);
    assert.equal(r.body.x402Version, 2); assert.equal(r.body.accepts[0].amount, "20000"); assert.equal(r.body.accepts[0].payTo, PAY_TO);
    assert.equal(r.body.discovery, true); assert.match(r.body.error, /Missing payment reference/);
    assert.equal(r.body.extensions.bazaar.info.input.method, "POST");
    assert.deepEqual(unb64(r.headers.get("payment-required")), r.body);
  }
  const h = await worker.fetch(new Request("https://lookup.test" + PS, { method: "HEAD" }), e.env, { waitUntil() {} });
  assert.equal(h.status, 402);
  assert.equal(psCalls.length, 0, "no RPC"); assert.equal(e.env.RECEIPTS_DB.rows.length, 0, "no D1 write");
  const f = await psSend({ payment_payload: PS_PAYLOAD() }, { envo: e });
  assert.equal(f.body.access.free_used_today, 1, "discovery did not use a free check");
});

test("0.40.0 payment-status: landed (10+ confirmations) -> landed, safe_to_resign false, tx + terms match + claim; final answer stored in D1, served at /v1/receipts/ps-..., cached on repeat; signed receipt verifies", async () => {
  const S = await import("../worker/src/sign.js");
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", privateKey)), kid: "ps-test-key" };
  S._addTestKey({ kid: jwk.kid, x: jwk.x }); S._resetSigner();
  const e = psEnv({ RECEIPT_SIGNING_KEY: JSON.stringify(jwk) });
  const rc = psReceipt({ block: 4980 });
  psSet(psNode({ used: true, event: "used", receipt: rc }), psNode({ used: true, event: "used", receipt: rc }));
  const r = await psSend({ payment_payload: PS_PAYLOAD(), seller_url: "https://spot.target.test/ps" }, { envo: e });
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.status, "landed"); assert.equal(b.reason, "settled_onchain");
  assert.equal(b.safe_to_resign, false); assert.equal(b.safe_to_retry_same_payload, true); assert.match(b.same_payload_note, /replay/);
  assert.equal(b.tx.hash, PS_TX); assert.equal(b.tx.confirmations, 21); assert.equal(b.tx.submitter, PS_SUBMITTER); assert.equal(b.tx.basescan_url, "https://basescan.org/tx/" + PS_TX);
  assert.deepEqual(b.tx.transfer, { from: PS_FROM, to: PS_SELLER, value: "10000" });
  assert.deepEqual(b.terms_match, { amount: "match", pay_to: "match", asset: "match", network: "match", source: "payment_payload", compared: "onchain_transfer" });
  assert.equal(b.claim.relevant, true); assert.ok(b.claim.contacts.some((c) => c.role === "facilitator" && c.submitter === PS_SUBMITTER && c.inferred));
  assert.ok(b.claim.contacts.some((c) => c.role === "seller" && c.host === "spot.target.test"));
  assert.equal(b.finality.reorg_safe, true); assert.equal(b.rpc.sources_agreed, 2);
  assert.ok(Array.isArray(b.cannot_know) && b.cannot_know.some((x) => /delivered/.test(x)));
  assert.equal(b.access.tier, "free"); assert.equal(b.access.shared_with, "402xAgent check");
  { const u = await psSend({ tx_hash: PS_TX }, { envo: psEnv() }); assert.equal(u.body.receipt, null); assert.match(u.body.signature_note, /unsigned/); }
  // RPC URLs (with keys) never leak
  assert.doesNotMatch(JSON.stringify(b), /SECRETKEY123|SECRET2|alch\.test|rpc2\.test/);
  assert.deepEqual(b.rpc.sources.map((s) => s.name), ["alchemy", "rpc2"]);
  // signed copy verifies (ed25519 over JCS minus signature)
  assert.equal(b.receipt.kid, "ps-test-key");
  const sig = Uint8Array.from(Buffer.from(b.receipt.signature, "base64url"));
  assert.ok(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, sig, S.signingInput(b.receipt)), "receipt signature verifies");
  const { receipt, cached, signature_note, access, ...top } = b;
  const { kid, signature, ...signedRest } = receipt;
  assert.deepEqual(top, signedRest, "top-level answer == signed copy");
  // stored (final) and readable
  assert.equal(e.env.RECEIPTS_DB.rows.length, 1); assert.equal(b.stored, true);
  const got = await send("/v1/receipts/" + b.id, { envo: e });
  assert.equal(got.status, 200); assert.deepEqual(got.body, b.receipt);
  // repeat: cached, no RPC
  psCalls.length = 0;
  const r2 = await psSend({ payment_payload: PS_PAYLOAD(), seller_url: "https://spot.target.test/ps" }, { envo: e });
  assert.equal(r2.body.cached, true); assert.equal(psCalls.length, 0); assert.equal(r2.body.access.free_used_today, 2);
  assert.equal((await send("/v1/receipts/ps-0000000000000000", { envo: e })).status, 404);
  S._resetSigner();
});

test("0.40.0 payment-status strict re-sign rule: not_landed only with two sources + unused + past validBefore+120s; expiry edge; pending; single source; fallback to public; disagreement; canceled; low confirmations; tx-only; terms mismatch", async () => {
  const ask = async (a, b, p, body = { payment_payload: PS_PAYLOAD() }) => { psSet(a, b, p); return psSend(body, { envo: psEnv(), client: "ps-" + Math.random() }); }; // fresh D1 each time (final answers are cached)
  // not_landed: both unused, expired by > margin
  let r = await ask(psNode({ time: PS_VB + 121 }), psNode({ time: PS_VB + 500 }));
  assert.deepEqual([r.body.status, r.body.reason, r.body.safe_to_resign, r.body.rpc.sources_agreed], ["not_landed", "expired_unused", true, 2]);
  assert.equal(r.body.authorization.used_onchain, false); assert.equal(r.body.authorization.expired, true);
  assert.equal(r.body.stored, true, "final -> stored");
  assert.ok(!psCalls.some(([u]) => u === PSP), "public node not needed with two sources");
  // Max's condition: not_landed + safe_to_resign rests on authorizationState(from, nonce) eth_call == false from BOTH
  // sources (+ expiry), never on log-search absence: no eth_getLogs is even made for an unused nonce
  { const calls = psCalls.filter(([, m]) => m === "eth_call").map(([u]) => u);
    assert.deepEqual(calls.sort(), [PSA, PSB].sort(), "one authorizationState eth_call per agreeing source");
    assert.equal(psCalls.filter(([, m]) => m === "eth_getLogs").length, 0, "no log search behind not_landed"); }
  // a source whose authorizationState call fails does not count, even if everything else answers (logs empty, head fine)
  r = await ask(psNode(), psNode({ callFail: true }), psNode({ fail: true }));
  assert.deepEqual([r.body.status, r.body.safe_to_resign, r.body.rpc.sources_agreed], ["unknown", false, 1]);
  r = await ask(psNode({ callFail: true }), psNode({ callFail: true }), psNode({ callFail: true }));
  assert.equal(r.status, 503, "no contract read anywhere -> no answer");
  // expiry edge: exactly validBefore + 120 on one source is NOT past the margin
  r = await ask(psNode({ time: PS_VB + 120 }), psNode({ time: PS_VB + 500 }));
  assert.deepEqual([r.body.status, r.body.reason, r.body.safe_to_resign], ["pending", "authorization_still_valid", false]);
  assert.equal(r.body.wait_until, new Date((PS_VB + 121) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
  assert.equal(r.body.stored, false); assert.equal(r.body.permalink, null);
  // pending: still valid
  r = await ask(psNode({ time: PS_VB - 60 }), psNode({ time: PS_VB - 60 }));
  assert.deepEqual([r.body.status, r.body.safe_to_resign], ["pending", false]);
  // single source: rpc2 + public fail
  r = await ask(psNode(), psNode({ fail: true }), psNode({ fail: true }));
  assert.deepEqual([r.body.status, r.body.reason, r.body.safe_to_resign, r.body.rpc.sources_agreed], ["unknown", "single_source", false, 1]);
  assert.deepEqual(r.body.rpc.sources.map((s) => [s.name, s.ok, s.error || null]), [["alchemy", true, null], ["rpc2", false, "http_429"], ["base-public", false, "http_429"]]);
  // fallback: rpc2 fails, public answers -> two sources agree
  r = await ask(psNode(), psNode({ fail: true }), psNode());
  assert.deepEqual([r.body.status, r.body.safe_to_resign, r.body.rpc.sources_agreed], ["not_landed", true, 2]);
  // disagreement: one sees it landed, the other not
  const deep = psReceipt({ block: 4000 });
  r = await ask(psNode({ used: true, event: "used", receipt: deep }), psNode());
  assert.deepEqual([r.body.status, r.body.reason, r.body.safe_to_resign], ["pending", "sources_disagree", false]);
  // disagreement on the nonce only (one says used, no event found)
  r = await ask(psNode(), psNode({ used: true }));
  assert.deepEqual([r.body.status, r.body.safe_to_resign], ["unknown", false]);
  // canceled
  // canceled: safe only when BOTH sources see AuthorizationCanceled (this authorizer + nonce) with >= 10 confirmations
  r = await ask(psNode({ used: true, event: "canceled", eventBlock: 4991 }), psNode({ used: true, event: "canceled", eventBlock: 4991 }));
  assert.deepEqual([r.body.status, r.body.reason, r.body.safe_to_resign], ["canceled", "authorization_canceled", true]);
  r = await ask(psNode({ used: true, event: "canceled", eventBlock: 4992 }), psNode({ used: true, event: "canceled", eventBlock: 4980 }));
  assert.deepEqual([r.body.status, r.body.reason, r.body.safe_to_resign], ["canceled", "canceled_low_confirmations", false], "9 confirmations on one source");
  // (0.40.1: Alchemy finds cancels only by reading the cancel tx another source located, so the lone finder is rpc2 here)
  r = await ask(psNode({ fail: true }), psNode({ used: true, event: "canceled", eventBlock: 4000 }), psNode({ fail: true }));
  assert.deepEqual([r.body.status, r.body.reason, r.body.safe_to_resign], ["canceled", "canceled_single_source", false]);
  r = await ask(psNode({ used: true }), psNode({ used: true, event: "canceled", eventBlock: 4000 }));
  assert.deepEqual([r.body.status, r.body.reason, r.body.safe_to_resign], ["canceled", "canceled_sources_disagree", false]);
  r = await ask(psNode({ used: true, event: "canceled", eventBlock: 4000 }), psNode({ used: true, event: "canceled", eventBlock: 4000 }));
  assert.equal(r.body.authorization.event, "canceled");
  // a source whose eth_getLogs is rate-limited still counts (nonce state) and reads the tx the other source located
  r = await ask(psNode({ used: true, event: "used", receipt: deep }), psNode({ used: true, logsFail: true, receipt: deep }), undefined, { from: PS_FROM, nonce: PS_NONCE });
  assert.deepEqual([r.body.status, r.body.rpc.sources_agreed, r.body.safe_to_resign], ["landed", 2, false]);
  assert.ok(psCalls.some(([u, m]) => u === PSB && m === "eth_getTransactionReceipt"), "second source read the receipt itself");
  // reorg window: landed with 3 confirmations -> pending, not stored
  const shallow = psReceipt({ block: 4998 });
  r = await ask(psNode({ used: true, event: "used", receipt: shallow }), psNode({ used: true, event: "used", receipt: shallow }));
  assert.deepEqual([r.body.status, r.body.reason, r.body.safe_to_resign, r.body.tx.confirmations, r.body.stored], ["pending", "low_confirmations", false, 3, false]);
  assert.equal(r.body.finality.reorg_safe, false);
  // terms mismatch: money went to another wallet / amount
  const other = psReceipt({ block: 4000, to: "0x" + "99".repeat(20), value: 25000 });
  r = await ask(psNode({ used: true, event: "used", receipt: other }), psNode({ used: true, event: "used", receipt: other }));
  assert.equal(r.body.status, "landed");
  assert.deepEqual([r.body.terms_match.pay_to, r.body.terms_match.amount], ["mismatch", "mismatch"]);
  assert.equal(r.body.claim.relevant, true);
  // explicit terms override + live 402 terms when only seller_url is given
  r = await ask(psNode({ used: true, event: "used", receipt: deep }), psNode({ used: true, event: "used", receipt: deep }), undefined, { from: PS_FROM, nonce: PS_NONCE, terms: { amount: "10000", payTo: PS_SELLER } });
  assert.deepEqual([r.body.terms_match.amount, r.body.terms_match.pay_to, r.body.terms_match.source], ["match", "match", "provided"]);
  // from + nonce without validBefore: unused -> pending, never safe
  r = await ask(psNode(), psNode(), undefined, { from: PS_FROM, nonce: PS_NONCE });
  assert.deepEqual([r.body.status, r.body.reason, r.body.safe_to_resign], ["pending", "valid_before_unknown", false]);
  r = await ask(psNode(), psNode(), undefined, { from: PS_FROM, nonce: PS_NONCE, valid_before: String(PS_VB) });
  assert.deepEqual([r.body.status, r.body.safe_to_resign], ["not_landed", true]);
  // tx hash only: not found -> pending; reverted -> not_landed but never safe (no nonce check)
  r = await ask(psNode(), psNode(), undefined, { tx_hash: PS_TX });
  assert.deepEqual([r.body.status, r.body.reason, r.body.safe_to_resign], ["pending", "tx_not_found", false]);
  const rev = psReceipt({ block: 4000, status: 0 });
  r = await ask(psNode({ receipt: rev }), psNode({ receipt: rev }), undefined, { tx_hash: PS_TX });
  assert.deepEqual([r.body.status, r.body.reason, r.body.safe_to_resign], ["not_landed", "tx_reverted", false]);
  r = await ask(psNode({ receipt: deep }), psNode({ receipt: deep }), undefined, { tx_hash: PS_TX });
  assert.deepEqual([r.body.status, r.body.safe_to_resign], ["landed", false]);
  // same-payload retry is always reported safe
  assert.equal(r.body.safe_to_retry_same_payload, true);
});

test("0.40.1 payment-status: every PAID call writes a NEW signed receipt (new ps- id, own D1 row) with payer, amount, settle tx, tier paid, embedding + linking the cached chain answer; free unchanged; verifies", async () => {
  const S = await import("../worker/src/sign.js");
  const { privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", privateKey)), kid: "ps-paid-key" };
  S._addTestKey({ kid: jwk.kid, x: jwk.x }); S._resetSigner();
  const db = psD1();
  const e = psEnv({ RECEIPT_SIGNING_KEY: JSON.stringify(jwk), SPOT_FREE_PER_DAY: "1", RECEIPTS_DB: db });
  const rc = psReceipt({ block: 4980 });
  psSet(psNode({ used: true, event: "used", receipt: rc }), psNode({ used: true, event: "used", receipt: rc }));
  const free = await psSend({ payment_payload: PS_PAYLOAD() }, { envo: e, client: "ps-paid" });
  assert.equal(free.body.access.tier, "free"); assert.equal(free.body.payment_received, undefined, "free unchanged"); assert.equal(free.body.tier, undefined);
  const chainId = free.body.id;
  psCalls.length = 0;
  facMode = "ok";
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const r = await psSend({ payment_payload: PS_PAYLOAD() }, { envo: e, client: "ps-paid", headers: { "payment-signature": v2Payment() } });
    assert.equal(r.status, 200); assert.equal(r.body.access.tier, "paid");
    const g = r.body.receipt;
    assert.ok(g && g.signature && g.kid === jwk.kid, "signed");
    assert.match(g.id, /^ps-/); assert.notEqual(g.id, chainId, "new id, not the cached chain answer's");
    assert.equal(g.tier, "paid"); assert.equal(g.status, "landed");
    assert.deepEqual(g.payment_received, { tier: "paid", payer: "0x" + "11".repeat(20), amount_atomic: "20000", amount_usd: "0.02", asset: USDC, network: "eip155:8453", settle_tx: TX, basescan_url: "https://basescan.org/tx/" + TX });
    assert.equal(g.chain_answer.receipt_id, chainId); assert.equal(g.chain_answer.receipt_url, free.body.permalink); assert.match(free.body.permalink, new RegExp(chainId + "$")); assert.equal(g.chain_answer.cached, true, "chain answer reused from D1");
    assert.equal(g.permalink, free.body.permalink.replace(chainId, g.id));
    assert.deepEqual(r.body.payment_received, g.payment_received, "top-level body is the paid body");
    const W = await import("/workspace/products/x402-spotcheck/receipt.js");
    assert.equal((await W.verifyReceipt(g, { publicKey: { keys: [{ kty: "OKP", crv: "Ed25519", kid: jwk.kid, x: jwk.x }] } })).valid, true, "paid receipt verifies");
    const tampered = { ...g, payment_received: { ...g.payment_received, payer: "0x" + "22".repeat(20) } };
    assert.equal((await W.verifyReceipt(tampered, { publicKey: { keys: [{ kty: "OKP", crv: "Ed25519", kid: jwk.kid, x: jwk.x }] } })).valid, false, "payer is under the signature");
    const served = await send("/v1/receipts/" + g.id, { envo: e });
    assert.equal(served.status, 200); assert.equal((served.body.receipt || served.body).payment_received.settle_tx, TX);
    ids.push(g.id);
  }
  assert.notEqual(ids[0], ids[1], "each paid call has its own receipt");
  assert.equal(psCalls.filter(([, m]) => m === "eth_call").length, 0, "paid calls reused the cached final chain answer (no new chain reads)");
  // a later free lookup is still served from the chain answer, not a paid row
  const e2 = psEnv({ RECEIPTS_DB: db });
  const again = await psSend({ payment_payload: PS_PAYLOAD() }, { envo: e2, client: "ps-paid-2" });
  assert.equal(again.body.id, chainId); assert.equal(again.body.payment_received, undefined);
});

test("0.40.1 payment-status sources: RPC3_BASE_URL (keyed) sits after Alchemy and ahead of keyless; Alchemy nonce-only lookup uses alchemy_getAssetTransfers (full history) not 10-block getLogs; bounded calls; keyless keep 9,000 blocks", async () => {
  const P = await import("../worker/src/paystatus.js");
  const names = P.rpcSources({ ALCHEMY_BASE_RPC_URL: "https://a.test/", RPC3_BASE_URL: "https://k3.test/", RPC2_BASE_URL: "https://k2.test/" }).map((x) => [x.name, x.kind, x.logWindow]);
  assert.deepEqual(names.slice(0, 3), [["alchemy", "alchemy", 9000], ["rpc3", "keyed", 9000], ["rpc2", "keyless", 9000]]);
  assert.ok(names.slice(3).every(([, k, w]) => k === "keyless" && w === 9000));
  assert.equal(P.rpcSources({ RPC3_BASE_URL: "http://insecure.test/" }).some((x) => x.name === "rpc3"), false, "https only");
  assert.equal(P.rpcSources({ RPC3_BASE_URL: "https://k3.test/", PAYSTATUS_RPC3_LOG_WINDOW: "50000" }).find((x) => x.name === "rpc3").logWindow, 50000);
  // nonce-only lookup of an OLD payment (event far outside 9,000 blocks): Alchemy finds it via transfers, the keyless one cross-reads the tx
  const old = psReceipt({ block: 100 });
  const others = Array.from({ length: 30 }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0"));
  psSet(psNode({ head: 500000, used: true, transfers: [...others.slice(0, 7), PS_TX, ...others.slice(7)], receiptFor: (h) => (h === PS_TX ? old : psReceipt({ block: 90, event: "none" })) }), psNode({ head: 500000, used: true, receiptFor: (h) => (h === PS_TX ? old : null) }));
  let r = await psSend({ from: PS_FROM, nonce: PS_NONCE }, { envo: psEnv(), client: "ps-old" });
  assert.deepEqual([r.body.status, r.body.rpc.sources_agreed], ["landed", 2]);
  assert.equal(r.body.tx.hash, PS_TX);
  const aCalls = psCalls.filter(([u]) => u === PSA).map(([, m]) => m);
  assert.equal(aCalls.filter((m) => m === "eth_getLogs").length, 0, "no getLogs on Alchemy (free tier: 10-block range)");
  assert.equal(aCalls.filter((m) => m === "alchemy_getAssetTransfers").length, 1);
  assert.equal(aCalls.filter((m) => m === "eth_getTransactionReceipt").length, 10, "stops at the batch with the hit (2 batches of 5)");
  const bLogs = psCalls.filter(([u, m]) => u === PSB && m === "eth_getLogs").length;
  assert.ok(bLogs >= 1, "keyless source still searches its 9,000-block window");
  // bound: no hit in 30 candidates -> at most 20 receipts read, then honest unknown
  psSet(psNode({ head: 500000, used: true, transfers: others, receiptFor: () => psReceipt({ block: 90, event: "none" }) }), psNode({ head: 500000, used: true }));
  r = await psSend({ from: PS_FROM, nonce: PS_NONCE }, { envo: psEnv(), client: "ps-old2" });
  assert.equal(r.body.status, "unknown"); assert.equal(r.body.safe_to_resign, false);
  const n = psCalls.filter(([u, m]) => u === PSA && m === "eth_getTransactionReceipt").length;
  assert.equal(n, 20, "bounded at PS_ALCH_MAX_RECEIPTS");
  assert.ok(psCalls.filter(([u]) => u === PSA).length <= 1 + 1 + 1 + 20, "head + eth_call + transfers + <=20 receipts");
  // expired validBefore narrows the transfers search toward that time
  psSet(psNode({ head: 500000, used: true, transfers: [PS_TX], receiptFor: () => old }), psNode({ head: 500000, used: true, receiptFor: () => old }));
  await psSend({ from: PS_FROM, nonce: PS_NONCE, valid_before: PS_VB }, { envo: psEnv(), client: "ps-old3" });
  assert.notEqual(psChain[PSA].atParams.toBlock, "latest");
  // Alchemy transfers call failing is non-fatal (nonce state still counts) and never makes re-signing safe
  psSet(psNode({ used: true, alchFail: true }), psNode({ used: true }));
  r = await psSend({ from: PS_FROM, nonce: PS_NONCE }, { envo: psEnv(), client: "ps-old4" });
  assert.equal(r.body.safe_to_resign, false);
});

// 0.41.0 hosted mode: a D1 layer that adds integrators + hosted_usage on top of an existing fake
function hostedD1(inner) {
  const integ = [], usage = [];
  return { integ, usage, rows: inner.rows, prepare(sql) {
    if (!/integrators|hosted_usage/.test(sql)) return inner.prepare(sql);
    return { bind(...a) { return {
      async run() { if (/^INSERT INTO hosted_usage/.test(sql)) { const [receipt_id, integrator_id, product, created_at, month, price_atomic, band, end_user_hash] = a; usage.push({ receipt_id, integrator_id, product, created_at, month, price_atomic, band, end_user_hash, invoiced: 0 }); } return { success: true }; },
      async first() {
        if (/FROM integrators WHERE id = \?/.test(sql)) return integ.find((x) => x.id === a[0]) || null;
        if (/FROM hosted_usage WHERE integrator_id = \?2/.test(sql)) { const [month, id] = a; const u = usage.filter((x) => x.integrator_id === id);
          return { total: u.length, month_checks: u.filter((x) => x.month === month).length, month_billable: u.filter((x) => x.month === month && x.price_atomic > 0).length, outstanding_atomic: u.filter((x) => !x.invoiced).reduce((t, x) => t + Number(x.price_atomic), 0) }; }
        return null;
      },
      async all() { return { results: [] }; },
    }; } };
  } };
}
const H_PEPPER = "test-pepper-not-real";
async function hostedKey(db, { id = "0a1b2c3d", name = "internal-test", status = "active", free_total = 1000, first_invoice_paid = 0 } = {}) {
  const Hm = await import("../worker/src/hosted.js");
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  db.integ.push({ id, name, status, key_hash: await Hm.keyHash(H_PEPPER, secret), free_total, first_invoice_paid });
  return "402x_live_" + id + "_" + secret;
}
const norm = (t) => String(t).replace(/\b(sc|ps)-[0-9a-f]{16}\b/g, "ID").replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "TS").replace(/"(used|free_used_today|free_remaining_today|latency_ms|probed_at)":[^,}]+/g, '"$1":X');

test("0.41.0 hosted: calls WITHOUT a key are byte-for-byte unchanged (pepper + integrators present or not; a non-402x Bearer is ignored)", async () => {
  spotTargetMode = "402";
  const run = async (extra, headers = {}) => {
    const e = spotEnv({ RECEIPTS_DB: hostedD1(fakeD1()), ...extra });
    const a = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/nokey") + "&client=nokey", { envo: e, headers });
    psSet(psNode(), psNode());
    const b = await psSend({ payment_payload: PS_PAYLOAD() }, { envo: { ...e, env: { ...e.env, ALCHEMY_BASE_RPC_URL: PSA, RPC2_BASE_URL: PSB, PAYSTATUS_PUBLIC_RPC: PSP, PAYSTATUS_PUBLIC_RPC2: "off" } }, client: "nokey", headers });
    return [a.status, norm(JSON.stringify(a.body)), [...a.headers.keys()].sort().join(","), b.status, norm(JSON.stringify(b.body)), [...b.headers.keys()].sort().join(",")];
  };
  const base = await run({});
  assert.deepEqual(await run({ HOSTED_KEY_PEPPER: H_PEPPER }), base, "pepper set, no key");
  assert.deepEqual(await run({ HOSTED_KEY_PEPPER: H_PEPPER }, { authorization: "Bearer some-other-token" }), base, "non-402x bearer is not a key");
  assert.ok(!base[1].includes("hosted") && !base[4].includes("\"hosted\""));
  const Hm = await import("../worker/src/hosted.js");
  assert.equal(Hm.hostedKeyFrom(new Request("https://x.test/")), null);
});

test("0.41.0 hosted spot-check: valid key -> tier hosted, full answer, no free counter, payment header ignored, usage metered, signed receipt with hosted block verifies; bad/revoked/no-pepper refused; /v1/integrators/me", async () => {
  const S = await import("../worker/src/sign.js");
  const { privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", privateKey)), kid: "hosted-key" };
  S._addTestKey({ kid: jwk.kid, x: jwk.x }); S._resetSigner();
  const db = hostedD1(fakeD1());
  const key = await hostedKey(db);
  const e = spotEnv({ RECEIPTS_DB: db, HOSTED_KEY_PEPPER: H_PEPPER, RECEIPT_SIGNING_KEY: JSON.stringify(jwk), SPOT_FREE_PER_DAY: "0" });
  spotTargetMode = "402"; facCalls.length = 0;
  const W = await import("/workspace/products/x402-spotcheck/receipt.js");
  for (let i = 0; i < 2; i++) {
    const r = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/h" + i) + "&client=hosted-agent", { envo: e, headers: { authorization: "Bearer " + key, "x-402xagent-end-user": "agent-42", "payment-signature": spotPayment({ amount: "20000" }) } });
    assert.equal(r.status, 200);
    assert.equal(r.body.access.tier, "hosted"); assert.equal(r.body.access.integrator, "0a1b2c3d"); assert.equal(r.body.access.band, "free_allowance"); assert.equal(r.body.access.price_atomic, "0"); assert.equal(r.body.access.billed_on, "invoice");
    assert.match(r.body.access.end_user_hash, /^[0-9a-f]{24}$/); assert.ok(!JSON.stringify(r.body).includes("agent-42"));
    assert.ok(r.body.pay_to, "full answer (not the free redacted shape)");
    const row = db.rows.find((x) => x.id === r.body.receipt_id); const stored = JSON.parse(row.body);
    const g = stored.signed_view || stored;
    const rc = await send("/v1/receipts/" + r.body.receipt_id, { envo: e }); const sv = rc.body.receipt || rc.body;
    assert.equal(sv.access_tier, "hosted"); assert.equal(sv.hosted.integrator, "0a1b2c3d"); assert.equal(sv.hosted.band, "free_allowance");
    assert.equal((await W.verifyReceipt(sv, { publicKey: { keys: [{ kty: "OKP", crv: "Ed25519", kid: jwk.kid, x: jwk.x }] } })).valid, true);
    assert.equal((await W.verifyReceipt({ ...sv, hosted: { ...sv.hosted, band: "volume" } }, { publicKey: { keys: [{ kty: "OKP", crv: "Ed25519", kid: jwk.kid, x: jwk.x }] } })).valid, false);
    void g;
  }
  assert.equal(facCalls.length, 0, "no x402 settle for hosted calls");
  assert.deepEqual(db.usage.map((u) => [u.integrator_id, u.product, u.price_atomic, u.band]), [["0a1b2c3d", "spot", 0, "free_allowance"], ["0a1b2c3d", "spot", 0, "free_allowance"]]);
  const me = await send("/v1/integrators/me", { envo: e, headers: { authorization: "Bearer " + key } });
  assert.equal(me.status, 200); assert.equal(me.body.meter.total, 2); assert.equal(me.body.next_check.band, "free_allowance"); assert.equal(me.body.credit_limit_atomic, "20000000");
  // refusals never fall back to free
  for (const [hdrs, status, code] of [[{ authorization: "Bearer 402x_live_0a1b2c3d_" + "A".repeat(43) }, 401, "bad_key"], [{ "x-402xagent-key": "nope" }, 401, "bad_key"]]) {
    const r = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/bad") + "&client=hosted-agent", { envo: e, headers: hdrs });
    assert.deepEqual([r.status, r.body.code], [status, code]);
  }
  db.integ[0].status = "revoked";
  let r = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/rev") + "&client=hosted-agent", { envo: e, headers: { authorization: "Bearer " + key } });
  assert.deepEqual([r.status, r.body.code], [401, "key_revoked"]);
  const e0 = spotEnv({ RECEIPTS_DB: db });
  r = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/np") + "&client=hosted-agent", { envo: e0, headers: { authorization: "Bearer " + key } });
  assert.deepEqual([r.status, r.body.code], [501, "hosted_not_enabled"]);
  assert.equal(db.usage.length, 2, "refused calls are not metered");
});

test("0.41.0 hosted pricing: 1,000 free lifetime, then $0.02, then marginal $0.01 after 1,000 billable in the UTC month; cached billable; credit limit $20 -> x402 fallback, $100 after first paid invoice; rate limit", async () => {
  const Hm = await import("../worker/src/hosted.js");
  const month = Hm.utcMonth();
  assert.deepEqual(Hm.hostedPrice({ total: 999, month_billable: 0 }, { free_total: 1000 }), { price_atomic: 0, band: "free_allowance" });
  assert.deepEqual(Hm.hostedPrice({ total: 1000, month_billable: 0 }, { free_total: 1000 }), { price_atomic: 20000, band: "standard" });
  assert.deepEqual(Hm.hostedPrice({ total: 5000, month_billable: 999 }, {}), { price_atomic: 20000, band: "standard" }, "the 1,000th billable is still $0.02");
  assert.deepEqual(Hm.hostedPrice({ total: 5000, month_billable: 1000 }, {}), { price_atomic: 10000, band: "volume" }, "1,001st is $0.01");
  assert.equal(Hm.creditLimitAtomic({ first_invoice_paid: 0 }), 20000000); assert.equal(Hm.creditLimitAtomic({ first_invoice_paid: 1 }), 100000000);
  const db = hostedD1(fakeD1());
  const key = await hostedKey(db, { free_total: 1 });
  const e = spotEnv({ RECEIPTS_DB: db, HOSTED_KEY_PEPPER: H_PEPPER, SPOT_FREE_PER_DAY: "5" });
  spotTargetMode = "402";
  const call = (p, extra = {}) => send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/" + p) + "&client=hp", { envo: e, headers: { authorization: "Bearer " + key, ...extra } });
  assert.equal((await call("a")).body.access.band, "free_allowance");
  let r = await call("a"); // same url again: cached probe answer, still billable
  assert.deepEqual([r.body.access.band, r.body.access.price_atomic], ["standard", "20000"]);
  assert.equal(db.usage.at(-1).price_atomic, 20000);
  // last month's checks do not count toward this month's volume band
  for (let i = 0; i < 1000; i++) db.usage.push({ receipt_id: "old" + i, integrator_id: "0a1b2c3d", product: "spot", month: "2000-01", price_atomic: 20000, band: "standard", invoiced: 1 });
  assert.equal((await call("b")).body.access.band, "standard");
  for (let i = 0; i < 998; i++) db.usage.push({ receipt_id: "m" + i, integrator_id: "0a1b2c3d", product: "spot", month, price_atomic: 20000, band: "standard", invoiced: 1 });
  r = await call("c"); assert.equal(r.body.access.band, "volume", "after 1,000 billable this month"); assert.equal(r.body.access.price_atomic, "10000");
  // credit limit: $20 outstanding (uninvoiced) -> normal path (here: the normal 5 free/day), header says why, not metered
  db.usage.push({ receipt_id: "owed", integrator_id: "0a1b2c3d", product: "spot", month, price_atomic: 19990000, band: "standard", invoiced: 0 });
  const n = db.usage.length;
  r = await call("d");
  assert.equal(r.body.access.tier, "free"); assert.equal(r.headers.get("x-402xagent-hosted"), "fallback: credit_limit"); assert.equal(db.usage.length, n);
  db.integ[0].first_invoice_paid = 1;
  r = await call("d"); assert.equal(r.body.access.tier, "hosted", "limit is $100 after the first paid invoice");
  // rate limit per key per minute
  const e1 = spotEnv({ RECEIPTS_DB: db, HOSTED_KEY_PEPPER: H_PEPPER, HOSTED_PER_MIN: "1" });
  const c1 = (p) => send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/" + p) + "&client=hp", { envo: e1, headers: { "x-402xagent-key": key } });
  assert.equal((await c1("r1")).status, 200);
  r = await c1("r2"); assert.deepEqual([r.status, r.body.code], [429, "hosted_rate_limited"]);
});

test("0.41.0 hosted payment-status: own new ps- receipt (tier hosted, hosted block, chain answer embedded), signed + verifies, cached chain answer still billable, no free counter or x402", async () => {
  const S = await import("../worker/src/sign.js");
  const { privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", privateKey)), kid: "hosted-ps-key" };
  S._addTestKey({ kid: jwk.kid, x: jwk.x }); S._resetSigner();
  const db = hostedD1(psD1());
  const key = await hostedKey(db);
  const e = psEnv({ RECEIPTS_DB: db, HOSTED_KEY_PEPPER: H_PEPPER, RECEIPT_SIGNING_KEY: JSON.stringify(jwk), SPOT_FREE_PER_DAY: "0" });
  const rc = psReceipt({ block: 4980 });
  psSet(psNode({ used: true, event: "used", receipt: rc }), psNode({ used: true, event: "used", receipt: rc }));
  const W = await import("/workspace/products/x402-spotcheck/receipt.js");
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const r = await psSend({ payment_payload: PS_PAYLOAD() }, { envo: e, client: "ps-h", headers: { authorization: "Bearer " + key } });
    assert.equal(r.status, 200); assert.equal(r.body.access.tier, "hosted");
    const g = r.body.receipt;
    assert.equal(g.tier, "hosted"); assert.equal(g.hosted.integrator, "0a1b2c3d"); assert.equal(g.payment_received, undefined); assert.equal(g.status, "landed");
    assert.equal(g.chain_answer.cached, i === 1);
    assert.equal((await W.verifyReceipt(g, { publicKey: { keys: [{ kty: "OKP", crv: "Ed25519", kid: jwk.kid, x: jwk.x }] } })).valid, true);
    ids.push(g.id);
  }
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(db.usage.map((u) => [u.receipt_id, u.product]), ids.map((id) => [id, "payment-status"]), "cached answer billable too");
});

test("0.40.0 payment-status: chain outage -> 503 (nothing charged, no free check); 400s; shared free counter with the check, then 402, then paid via x402; MCP tool", async () => {
  const e = psEnv({ SPOT_FREE_PER_DAY: "2" });
  psSet(psNode({ fail: true }), psNode({ fail: true }), psNode({ fail: true }));
  let r = await psSend({ payment_payload: PS_PAYLOAD() }, { envo: e, client: "ps-shared" });
  assert.equal(r.status, 503); assert.equal(r.body.code, "chain_unavailable"); assert.equal(r.body.safe_to_resign, false); assert.equal(r.headers.get("retry-after"), "30");
  assert.doesNotMatch(JSON.stringify(r.body), /SECRET|alch\.test/);
  for (const [b, code] of [[{ nonce: "0x12" , from: PS_FROM }, "bad_nonce"], [{ tx_hash: PS_TX, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, "unsupported_network"], [{ tx_hash: PS_TX, asset: "0x" + "00".repeat(20) }, "unsupported_asset"], [{ payment_payload: PS_PAYLOAD(), nonce: "0x" + "ff".repeat(32) }, "inconsistent"], [{ payment_payload: "not base64!" }, "bad_payload"], [{ from: PS_FROM }, "missing_reference"], [{ payment_payload: PS_PAYLOAD({ accepted: { network: "eip155:1" } }) }, "unsupported_network"]]) {
    r = await psSend(b, { envo: e, client: "ps-shared" });
    assert.equal(r.status, 400, code); assert.equal(r.body.code, code);
  }
  // shared counter: one free spot-check + one free payment-status = 2 free/day, then 402
  spotTargetMode = "402";
  const sc = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/ps-shared") + "&client=ps-shared", { envo: e });
  assert.equal(sc.body.access.tier, "free"); assert.equal(sc.body.access.free_used_today, 1, "503 and 400s used nothing");
  psSet(psNode(), psNode());
  r = await psSend({ payment_payload: PS_PAYLOAD() }, { envo: e, client: "ps-shared" });
  assert.equal(r.body.access.free_used_today, 2);
  r = await psSend({ payment_payload: PS_PAYLOAD() }, { envo: e, client: "ps-shared" });
  assert.equal(r.status, 402); assert.equal(r.body.accepts[0].amount, "20000"); assert.match(r.body.error, /shared with the 402xAgent check/);
  const sc2 = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/ps-shared2") + "&client=ps-shared", { envo: e });
  assert.equal(sc2.status, 402, "the check sees the same counter");
  // paid via x402 (our own PAYMENT-SIGNATURE header; the subject payment is in the body)
  facMode = "ok";
  r = await psSend({ payment_payload: PS_PAYLOAD() }, { envo: e, client: "ps-shared", headers: { "payment-signature": v2Payment() } });
  assert.equal(r.status, 200); assert.equal(r.body.access.tier, "paid"); assert.equal(r.body.access.charged_usd, "0.02"); assert.ok(r.headers.get("payment-response"));
  // a wrong-amount payment header is refused before any settle
  r = await psSend({ payment_payload: PS_PAYLOAD() }, { envo: e, client: "ps-shared", headers: { "payment-signature": v2Payment({ amount: "10000" }) } });
  assert.equal(r.status, 402); assert.match(r.body.error, /amount does not match/);
  // per-network free cap (shared with the check): 3 free per network, across client names
  const e3 = psEnv({ SPOT_FREE_PER_IP_DAY: "3" });
  psSet(psNode(), psNode());
  for (let i = 0; i < 2; i++) assert.equal((await psSend({ payment_payload: PS_PAYLOAD() }, { envo: e3, client: "ps-ipcap-" + i })).body.access.tier, "free");
  assert.equal((await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/ipcap") + "&client=ps-ipcap-x", { envo: e3 })).body.access.tier, "free", "3rd free on this network (a check)");
  r = await psSend({ payment_payload: PS_PAYLOAD() }, { envo: e3, client: "ps-ipcap-new" });
  assert.equal(r.status, 402); assert.match(r.body.error, /per UTC day from one network/);
  assert.equal((await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/ipcap2") + "&client=ps-ipcap-y", { envo: e3 })).status, 429, "the check sees the same network cap");
  // MCP tool
  const orig = globalThis.fetch; globalThis.fetch = psFetch(orig);
  try {
    const e2 = psEnv();
    const t = await send("/mcp", { envo: e2, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "payment_status", arguments: { payment_payload: PS_PAYLOAD() } } }) });
    const data = JSON.parse(t.body.result.content[0].text);
    assert.equal(data.status, "not_landed"); assert.equal(data.safe_to_resign, true);
    const t2 = await send("/mcp", { envo: e2, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "payment_status", arguments: {} } }) });
    assert.equal(t2.body.result.isError, true);
  } finally { globalThis.fetch = orig; }
  // docs surfaces
  const wk = await send("/.well-known/x402", { envo: e });
  assert.ok(wk.body.resourceCatalog.some((x) => x.url.endsWith("/v1/products/payment-status") && x.accepts[0].amount === "20000"));
  const oa = await send("/openapi.json", { envo: e });
  assert.ok(oa.body.paths["/v1/products/payment-status"].post);
  const llms = await (await worker.fetch(new Request("https://lookup.test/llms.txt"), e.env, { waitUntil() {} })).text();
  assert.match(llms, /payment-status/); assert.match(llms, /safe_to_resign/);
  const docs = await (await worker.fetch(new Request("https://402xagent.com/docs", { headers: { accept: "text/html" } }), e.env, { waitUntil() {} })).text();
  assert.match(docs, /id="payment-status"/);
  assert.match(docs, /\$0\.02/); assert.match(docs, /same 5 free per day/);
  const pr = await (await worker.fetch(new Request("https://402xagent.com/pricing", { headers: { accept: "text/html" } }), e.env, { waitUntil() {} })).text();
  assert.match(pr, /Payment status \(after you pay\)<\/th><td>\$0\.02 per lookup, flat, after the same \d+ free checks per day \(shared with the check/);
  assert.match(pr, /href="\/docs#payment-status"/);
});

test("0.40.0 paystatus unit: payload decode (v1 + v2), selectors/topics, rpcSources order + 'off', decide() never sets safe_to_resign without two sources", async () => {
  const P = await import("../worker/src/paystatus.js");
  const d2 = P.decodeSubjectPayload(PS_PAYLOAD());
  assert.deepEqual([d2.from, d2.nonce, d2.valid_before, d2.network, d2.terms.payTo], [PS_FROM, PS_NONCE, PS_VB, "eip155:8453", PS_SELLER]);
  const d1 = P.decodeSubjectPayload(b64({ x402Version: 1, scheme: "exact", network: "base", payload: { authorization: { from: PS_FROM, to: PS_SELLER, value: "1", validAfter: "0", validBefore: "5", nonce: PS_NONCE } } }));
  assert.equal(d1.network, "eip155:8453"); assert.equal(d1.terms, null);
  assert.equal(P.SEL_AUTHORIZATION_STATE, "0xe94a0102");
  assert.deepEqual(P.rpcSources({ ALCHEMY_BASE_RPC_URL: PSA, RPC2_BASE_URL: PSB }).map((s) => s.name), ["alchemy", "rpc2", "base-public", "drpc"]);
  assert.deepEqual(P.rpcSources({ RPC2_BASE_URL: "off", PAYSTATUS_PUBLIC_RPC: "off" }), []);
  assert.deepEqual(P.rpcSources({}).map((s) => [s.name, s.url]), [["rpc2", "https://base-rpc.publicnode.com"], ["base-public", "https://mainnet.base.org"], ["drpc", "https://base.drpc.org"]], "keyless defaults: three different operators");
  // log window: <= 9000 blocks; anchored near validBefore when it is older than ~5h
  const seen = [];
  const f = async (u, i) => { const { method, params } = JSON.parse(i.body); seen.push([method, params]);
    if (method === "eth_getBlockByNumber") return Response.json({ result: { number: "0x" + (1000000).toString(16), timestamp: "0x" + (PS_VB + 86400).toString(16) } });
    if (method === "eth_call") return Response.json({ result: "0x" + "0".repeat(63) + "1" });
    return Response.json({ result: [] }); };
  await P.readSource({ name: "t", url: "https://t.test" }, { from: PS_FROM, nonce: PS_NONCE, valid_before: PS_VB }, f);
  const lg = seen.find((x) => x[0] === "eth_getLogs")[1][0];
  assert.equal(parseInt(lg.toBlock, 16), 1000000 - 43200 + 150); assert.equal(parseInt(lg.toBlock, 16) - parseInt(lg.fromBlock, 16), 9000);
  const v = (o) => ({ name: "x", ok: true, head: 10, head_time: PS_VB + 999, state: false, receipt: null, event: null, ...o });
  const q = { from: PS_FROM, nonce: PS_NONCE, valid_before: PS_VB };
  assert.equal(P.decide([v({})], q).safe_to_resign, false);
  assert.equal(P.decide([v({}), { name: "y", ok: false, error: "unreachable" }], q).safe_to_resign, false);
  assert.equal(P.decide([v({}), v({ name: "y" })], q).safe_to_resign, true);
  assert.equal(P.decide([v({}), v({ name: "y", head_time: PS_VB })], q).safe_to_resign, false);
  assert.deepEqual(P.decide([{ name: "x", ok: false }], q), { error: "chain_unavailable" });
});

test("0.42.0 opt-in check_expiry: expired 402 -> skip/challenge_expired; skew cap 300; absent param unchanged; docs worked example", async () => {
  facMode = "ok";
  const strip = (b) => JSON.parse(JSON.stringify(b, (k, v) => (["checked_at", "id", "receipt_id", "receipt", "receipt_url", "signature", "ts", "generated_at", "last_checked", "check_id"].includes(k) ? undefined : v)));
  const run = async (mode, extra, client) => {
    spotTargetMode = mode;
    const e = spotEnv();
    return send("/v1/products/endpoint-spot-check?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=0.001&client=" + client + extra, { envo: e, headers: { "payment-signature": spotPayment({ amount: "20000" }) } });
  };
  const exp = await run("expired", "&check_expiry=1", "exp-1");
  assert.equal(exp.status, 200);
  assert.equal(exp.body.verdict, "skip");
  assert.equal(exp.body.reason_code, "challenge_expired");
  assert.equal(exp.body.expiry_check.expired, true);
  const soon = await run("expiring", "&check_expiry=1&skew_s=9999", "exp-2"); // skew capped at 300 > 120 s left
  assert.equal(soon.body.reason_code, "challenge_expired");
  assert.equal(soon.body.expiry_check.skew_s, 300);
  const soonDef = await run("expiring", "&check_expiry=1", "exp-3"); // default 30 s < 120 s left
  assert.equal(soonDef.body.verdict, "pay");
  assert.equal(soonDef.body.expiry_check.expired, false);
  const fut = await run("future", "&check_expiry=1", "exp-4");
  assert.equal(fut.body.verdict, "pay");
  for (const m of ["expired", "402", "future"]) {
    const off = await run(m, "", "exp-off");
    assert.equal(off.body.verdict, "pay", m + " without the param must keep its old verdict");
    assert.ok(!("expiry_check" in off.body));
    const off2 = await run(m, "&check_expiry=0", "exp-off");
    assert.deepEqual(Object.keys(off2.body).sort(), Object.keys(off.body).sort());
  }
  spotTargetMode = "402";
  const e2 = spotEnv();
  const html = await (await worker.fetch(new Request("https://lookup.test/docs", { headers: { "user-agent": "agent-x/1.0" } }), e2.env, { waitUntil() {} })).text();
  assert.ok(html.includes('id="payment-status-example"') && html.includes("https://402xagent.com/v1/receipts/ps-65a4fdffae01d2b6") && html.includes('id="expiry-check"'));
  const rj = (await send("/rules.json", { envo: spotEnv() })).body;
  assert.ok(rj.reason_codes.some((r) => r.code === "challenge_expired"));
});

test("0.42.1 self-check: own hosts are served in-process (same-zone fetch fails), others still use fetch; spot-check route never recursed", async () => {
  const L = await import("../worker/src/lib.js");
  assert.ok(L.isOwnHost("api.402xagent.com") && L.isOwnHost("402xagent.com") && L.isOwnHost("payscout.dev") && L.isOwnHost("verified-catalog-lookup.abc.workers.dev"));
  assert.ok(!L.isOwnHost("evil402xagent.com") && !L.isOwnHost("402xagent.com.evil.test") && !L.isOwnHost("other.abc.workers.dev"));
  let outer = [];
  const base = async (u) => { outer.push(String(u)); return new Response("same-zone", { status: 522 }); };
  const e = spotEnv();
  const f = L.selfFetch(e.env, base);
  const r = await f("https://api.402xagent.com/v1/lookup/paid?task=web-search", { headers: { accept: "application/json" } });
  assert.equal(r.status, 402, "own host answered in-process");
  assert.equal(outer.length, 0);
  await f("https://spot.target.test/api"); await f("https://api.402xagent.com/v1/products/endpoint-spot-check?url=x"); await f("http://api.402xagent.com/v1/lookup/paid");
  assert.equal(outer.length, 3, "external host, the spot-check route and non-https all go through normal fetch");
  const s = await send("/v1/products/endpoint-spot-check?url=" + encodeURIComponent("https://api.402xagent.com/v1/lookup/paid?task=web-search") + "&client=self-1", { envo: e });
  assert.equal(s.status, 200);
  assert.notEqual(s.body.reason_code, "server_error");
  assert.equal(s.body.verdict, "pay", JSON.stringify(s.body).slice(0, 300));
});

let passed = 0, skipped = 0;
const SKIP = Symbol("skip");
for (const [name, fn] of T) {
  try {
    await fn({ skip(msg) { throw { [SKIP]: msg }; } });
    passed++;
    console.log("PASS " + name);
  } catch (e) {
    if (e && e[SKIP] !== undefined) { skipped++; console.log("SKIP " + name + ": " + e[SKIP]); continue; }
    console.log("FAIL " + name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 12).join("\n  ") : e));
  }
}
console.log(`${passed}/${T.length - skipped} worker tests passed` + (skipped ? ` (${skipped} skipped)` : ""));
process.exit(passed === T.length ? 0 : 1);
