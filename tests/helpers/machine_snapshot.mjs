// 0.58.0: snapshot of every machine surface (what non-browser clients get), used by tests/machine_surfaces_test.mjs.
// Run: node tests/helpers/machine_snapshot.mjs <path-to-worker/src/index.js>  -> prints JSON {key: {status, headers, sha256}}.
// Deterministic: frozen clock, seeded randomness, stubbed outbound fetch, no bindings. The Worker VERSION string is
// replaced by "<VERSION>" before hashing, so a version bump is the only difference this snapshot tolerates.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const FIXED = Date.parse("2026-10-28T12:00:00Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(FIXED); }
  static now() { return FIXED; }
}
globalThis.Date = FixedDate;
let seed = 42;
Math.random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const realGRV = crypto.getRandomValues.bind(crypto);
crypto.getRandomValues = (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; };
crypto.randomUUID = () => "00000000-0000-4000-8000-" + String(Math.floor(Math.random() * 1e12)).padStart(12, "0");
void realGRV;

const BASE = "https://data.fixture/vc/";
const CATALOG = { generated_at: "2026-10-28T11:00:00Z", services: [{ id: "alpha", name: "ALPHA", endpoint: "https://alpha.fixture/api", category: "web search", description: "synthetic", tasks: ["web-search"], advertised_price: { amount_usd: "0.01" }, sample_request: { method: "GET" }, latest: { checked_at: "2026-10-28T11:00:00Z", reachable: true, x402_challenge: true, quoted_price_usd: "0.01", price_matches_listing: true } }] };
globalThis.fetch = async (u) => {
  const s = String(u && u.url ? u.url : u);
  if (s === BASE + "catalog.json") return new Response(JSON.stringify(CATALOG), { headers: { "content-type": "application/json" } });
  if (s === BASE + "receipts.json") return new Response(JSON.stringify({ stale_after_hours: 36, services: {} }), { headers: { "content-type": "application/json" } });
  return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
};

const HOSTS = ["https://402xagent.com", "https://api.402xagent.com", "https://verified-catalog-lookup.withgrokbot.workers.dev", "https://payscout.dev", "https://api.payscout.dev"];
const ACCEPTS = { none: null, json: "application/json", any: "*/*", text: "text/plain", curl: "*/*|curl/8.5.0" };
const GETS = ["/", "/llms.txt", "/skill.md", "/rules.json", "/openapi.json", "/mcp", "/health", "/robots.txt", "/.well-known/x402", "/.well-known/402xagent-keys.json",
  "/v1/skips", "/v1/skips.json", "/v1/skips?page=2", "/v1/discover", "/v1/receipts", "/v1/receipts/006776f7b6", "/v1/receipts/sc-0123456789abcdef", "/v1/receipts/by-url?url=https://api.402rates.com/v1/ping",
  "/v1/receipts?type=dry-run", "/v1/lookup?task=web-search&max_price=0.01&n=5", "/v1/lookup/paid?task=web-search&max_price=0.01&n=5", "/v1/tasks", "/v1/hygiene?url=https://api.402rates.com/v1/ping",
  "/v1/integrators/me", "/v1/products/endpoint-spot-check", "/v1/products/endpoint-spot-check?url=https://alpha.fixture/api", "/v1/products/endpoint-spot-check?url=https://alpha.fixture/api&mode=dry-run",
  "/v1/products/endpoint-spot-check/docs", "/v1/products/overnight-cos-pack", "/v1/products/payment-status", "/v1/products/endpoint-report", "/v1/products/bulk-report", "/v1/watch", "/v1/feed",
  "/v1/feed/manifest", "/v1/ops/stats", "/v1/admin/funnel", "/v1/spot-check?url=https://alpha.fixture/api", "/v1/nope", "/nope"];
const POSTS = [
  ["/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "snap", version: "1" } } }],
  ["/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }],
  ["/mcp", { jsonrpc: "2.0", id: 3, method: "resources/list" }],
  ["/v1/products/endpoint-spot-check", { url: "https://alpha.fixture/api" }],
  ["/v1/products/payment-status", { seller_url: "https://alpha.fixture/api" }],
  ["/v1/facilitator/check", { url: "https://alpha.fixture/api", paymentRequirements: {} }],
  ["/v1/watch", { url: "https://alpha.fixture/api" }],
];

export async function snapshot(workerPath) {
  const mod = await import(pathToFileURL(resolve(workerPath)).href);
  const lib = await import(pathToFileURL(resolve(workerPath, "..", "lib.js")).href);
  const worker = mod.default, VERSION = lib.VERSION;
  const norm = (s) => s.split(VERSION).join("<VERSION>");
  const env = () => ({ DATA_BASE_URL: BASE, CLIENT_SALT: "snap-salt", SELF_CLIENTS: "withgrokbot", MULTIPROBE_GAP_MS: "0", FREE_PER_DAY: "5", PRICE_ATOMIC: "20000",
    PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", ENDPOINT_REPORT: "1", WATCHTOWER: "1", EXPLAIN_LINE: "1", BULK_REPORT: "1", FEED: "observe", DELIVERY_CHECK: "1", WEEK_EPOCH: "2026-10-01" });
  const out = {};
  const run = async (key, req) => {
    const res = await worker.fetch(req, env(), { waitUntil() {}, passThroughOnException() {} });
    const body = res.status === 204 || req.method === "HEAD" ? "" : await res.text();
    const headers = {};
    for (const [k, v] of [...res.headers.entries()].sort()) headers[k] = norm(v);
    out[key] = { status: res.status, headers, sha256: createHash("sha256").update(norm(body)).digest("hex") };
  };
  for (const h of HOSTS) for (const p of GETS) for (const [an, a] of Object.entries(ACCEPTS)) {
    const [accept, ua] = a ? a.split("|") : [null, null];
    const headers = { "cf-connecting-ip": "203.0.113.9", ...(ua ? { "user-agent": ua } : {}), ...(accept ? { accept } : {}) };
    await run(`GET ${h}${p} [${an}]`, new Request(h + p, { headers }));
  }
  for (const h of HOSTS.slice(0, 2)) for (const [p, b] of POSTS)
    await run(`POST ${h}${p} ${JSON.stringify(b).slice(0, 60)}`, new Request(h + p, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify(b) }));
  // browsers on every route except the homepage (the only surface 0.58.0 changes): /v1, /mcp and text surfaces keep their answers for text/html too
  for (const h of HOSTS) for (const p of GETS.filter((p) => p !== "/"))
    await run(`GET ${h}${p} [html]`, new Request(h + p, { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "Mozilla/5.0", "cf-connecting-ip": "203.0.113.9" } }));
  // the homepage on the API / legacy hosts stays JSON for browsers too
  for (const h of HOSTS.filter((h) => h !== "https://402xagent.com"))
    await run(`GET ${h}/ [html]`, new Request(h + "/", { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "Mozilla/5.0", "cf-connecting-ip": "203.0.113.9" } }));
  return out;
}

// 0.58.3: surfaces that must stay byte-identical while /pricing (HTML for every Accept, as before) is rebuilt: the /pricing
// machine-looking paths (none exist: /pricing.json and the rest answer 404 JSON) on every host and Accept, and the browser
// homepage + /home.js + /docs on 402xagent.com (the homepage must not change at all). Fixture from main 714e418 (0.58.2).
export const EXTRA_GETS = ["/pricing.json", "/pricing.txt", "/pricing/json", "/v1/pricing", "/v1/pricing.json", "/.well-known/pricing"];
export async function snapshotExtra(workerPath) {
  const mod = await import(pathToFileURL(resolve(workerPath)).href);
  const lib = await import(pathToFileURL(resolve(workerPath, "..", "lib.js")).href);
  const worker = mod.default, VERSION = lib.VERSION;
  const norm = (s) => s.split(VERSION).join("<VERSION>");
  const env = () => ({ DATA_BASE_URL: BASE, CLIENT_SALT: "snap-salt", SELF_CLIENTS: "withgrokbot", MULTIPROBE_GAP_MS: "0", FREE_PER_DAY: "5", PRICE_ATOMIC: "20000",
    PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", ENDPOINT_REPORT: "1", WATCHTOWER: "1", EXPLAIN_LINE: "1", BULK_REPORT: "1", FEED: "observe", DELIVERY_CHECK: "1", WEEK_EPOCH: "2026-10-01" });
  const out = {};
  const run = async (key, req) => {
    const res = await worker.fetch(req, env(), { waitUntil() {}, passThroughOnException() {} });
    const body = await res.text();
    const headers = {};
    for (const [k, v] of [...res.headers.entries()].sort()) headers[k] = norm(v);
    out[key] = { status: res.status, headers, sha256: createHash("sha256").update(norm(body)).digest("hex") };
  };
  const HTML = { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "Mozilla/5.0", "cf-connecting-ip": "203.0.113.9" };
  for (const h of HOSTS) for (const p of EXTRA_GETS) {
    for (const [an, a] of Object.entries(ACCEPTS)) {
      const [accept, ua] = a ? a.split("|") : [null, null];
      await run(`GET ${h}${p} [${an}]`, new Request(h + p, { headers: { "cf-connecting-ip": "203.0.113.9", ...(ua ? { "user-agent": ua } : {}), ...(accept ? { accept } : {}) } }));
    }
    await run(`GET ${h}${p} [html]`, new Request(h + p, { headers: HTML }));
  }
  for (const p of ["/", "/home.js", "/docs", "/docs/try-it.js"]) await run(`GET https://402xagent.com${p} [html]`, new Request("https://402xagent.com" + p, { headers: HTML }));
  return out;
}

// 0.58.3 review: the normalized browser homepage body (same request and env as the extra snapshot), for the string-swap check.
export async function snapshotHomeBody(workerPath) {
  const mod = await import(pathToFileURL(resolve(workerPath)).href);
  const lib = await import(pathToFileURL(resolve(workerPath, "..", "lib.js")).href);
  const env = { DATA_BASE_URL: BASE, CLIENT_SALT: "snap-salt", SELF_CLIENTS: "withgrokbot", MULTIPROBE_GAP_MS: "0", FREE_PER_DAY: "5", PRICE_ATOMIC: "20000",
    PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", ENDPOINT_REPORT: "1", WATCHTOWER: "1", EXPLAIN_LINE: "1", BULK_REPORT: "1", FEED: "observe", DELIVERY_CHECK: "1", WEEK_EPOCH: "2026-10-01" };
  const res = await mod.default.fetch(new Request("https://402xagent.com/", { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "Mozilla/5.0", "cf-connecting-ip": "203.0.113.9" } }), env, { waitUntil() {}, passThroughOnException() {} });
  return (await res.text()).split(lib.VERSION).join("<VERSION>");
}

if (process.argv[2] === "--extra" && process.argv[3]) {
  process.stdout.write(JSON.stringify(await snapshotExtra(process.argv[3]), null, 1) + "\n");
} else if (process.argv[2]) {
  const snap = await snapshot(process.argv[2]);
  process.stdout.write(JSON.stringify(snap, null, 1) + "\n");
}
