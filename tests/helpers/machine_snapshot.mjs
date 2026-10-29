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

export async function snapshot(workerPath, onResponse = null) { // 0.58.9: optional onResponse(key, res, body) tap (bodies402.mjs)
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
    if (onResponse) onResponse(key, res, body);
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

// 0.58.4: everything at once against 0.58.3 (main 139fed1): the full machine snapshot, the extra set, /pricing on every host
// and Accept (HTML), and the homepage body hash. Only the homepage HTML is expected to differ (the audit layer card).
export async function snapshot0583(workerPath) {
  const out = { ...(await snapshot(workerPath)), ...(await snapshotExtra(workerPath)) };
  const mod = await import(pathToFileURL(resolve(workerPath)).href);
  const lib = await import(pathToFileURL(resolve(workerPath, "..", "lib.js")).href);
  const norm = (x) => x.split(lib.VERSION).join("<VERSION>");
  const env = { DATA_BASE_URL: BASE, CLIENT_SALT: "snap-salt", SELF_CLIENTS: "withgrokbot", MULTIPROBE_GAP_MS: "0", FREE_PER_DAY: "5", PRICE_ATOMIC: "20000",
    PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", ENDPOINT_REPORT: "1", WATCHTOWER: "1", EXPLAIN_LINE: "1", BULK_REPORT: "1", FEED: "observe", DELIVERY_CHECK: "1", WEEK_EPOCH: "2026-10-01" };
  const HTML = { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "Mozilla/5.0", "cf-connecting-ip": "203.0.113.9" };
  for (const h of HOSTS) for (const [an, a] of [...Object.entries(ACCEPTS), ["html", null]]) {
    const [accept, ua] = a ? a.split("|") : [null, null];
    const headers = an === "html" ? HTML : { "cf-connecting-ip": "203.0.113.9", ...(ua ? { "user-agent": ua } : {}), ...(accept ? { accept } : {}) };
    const res = await mod.default.fetch(new Request(h + "/pricing", { headers }), env, { waitUntil() {}, passThroughOnException() {} });
    const body = await res.text(); const hd = {};
    for (const [k, v] of [...res.headers.entries()].sort()) hd[k] = norm(v);
    out[`GET ${h}/pricing [${an}]`] = { status: res.status, headers: hd, sha256: createHash("sha256").update(norm(body)).digest("hex") };
  }
  return out;
}

// 0.58.5: the receipt routes with a receipt store (fake D1 holding real public receipt views sampled from production,
// tests/fixtures/receipts_sample_2026-10-28.json) on every host and Accept, plus the bundled crawl receipts. Fixture from
// main 1d5868d (0.58.4): non-browser answers must stay byte-identical when /v1/receipts gains HTML for browsers.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const SAMPLE = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/receipts_sample_2026-10-28.json", import.meta.url)), "utf8")).rows;
export function fakeReceiptsD1(rows = SAMPLE) {
  const byNew = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1));
  const q = (sql, a) => {
    if (/FROM spot_receipts WHERE id = \?/.test(sql)) return rows.filter((r) => r.id === a[0]);
    if (/FROM spot_receipts WHERE url = \?/.test(sql)) return byNew.filter((r) => r.url === a[0]).slice(0, 1);
    if (/FROM spot_receipts WHERE check_type = \?/.test(sql)) {
      let i = 1, out = byNew.filter((r) => r.check_type === a[0]);
      if (/AND ref = \?/.test(sql)) { const ref = a[i++]; out = out.filter((r) => r.ref === ref); }
      if (/created_at < \?/.test(sql)) { const c = a[i], cid = a[i + 2]; i += 3; out = out.filter((r) => r.created_at < c || (r.created_at === c && r.id < cid)); }
      return out.slice(0, a[i]);
    }
    return [];
  };
  return { prepare(sql) { const st = { a: [], bind(...x) { st.a = x; return st; }, async first() { return q(sql, st.a)[0] || null; }, async all() { return { results: q(sql, st.a) }; }, async run() { return { success: true, meta: { changes: 0 } }; } }; return st; }, async batch() { return []; } };
}
/** 0.58.5: the only keys allowed to differ from the 0.58.4 fixtures: browser Accept (names text/html) on the receipt pages
 * (/v1/receipts, crawl and sc- ids) of 402xagent.com and api.402xagent.com. by-url, ps-/er-/eb- and the older hosts' 301s are excluded. */
export const RECEIPT_HTML_KEY = /^GET https:\/\/(402xagent\.com|api\.402xagent\.com)\/v1\/receipts(\?\S*|\/(?!by-url|ps-|er-|eb-)\S*)? \[(html|htmljson)\]$/;
/** 0.58.6: /docs (now the index of the per-product pages) and /pricing (audit layer row, product-page links, footer) on any
 * host and Accept, plus the browser homepage, whose only change is the footer's Products list (HOME_FOOTER_* below). */
export const DOCS_PRICING_KEY = /^GET https:\/\/[^/ ]+\/(docs|pricing) \[[a-z]+\]$/;
export const HOME_KEY = "GET https://402xagent.com/ [html]";
export const HOME_FOOTER_0584 = '<div><h4>Products</h4><ul><li><a href="/docs#quick-start">402xAgent Check</a></li><li><a href="/docs#endpoint-report">Endpoint Report</a></li><li><a href="/docs#payment-status">Payment Status</a></li><li><a href="/docs#watchtower">Watchtower</a></li><li><a href="/docs#facilitator-check">Facilitator Check</a></li><li><a href="/docs#hosted">Hosted Mode</a></li></ul></div>';
export const HOME_FOOTER_0586 = '<div><h4>Products</h4><ul><li><a href="/docs/check">402xAgent Check</a></li><li><a href="/docs/endpoint-report">Endpoint Report</a></li><li><a href="/docs/payment-status">Payment Status</a></li><li><a href="/docs/watchtower">Watchtower</a></li><li><a href="/docs/facilitator-check">Facilitator Check</a></li><li><a href="/docs/hosted">Hosted Mode</a></li><li><a href="/#audit-layer">Audit layer</a></li></ul></div>';
/** The homepage body with the 0.58.6 footer Products list put back to 0.58.4's (throws unless it occurs exactly once). */
export function restoreHomeFooter(body) {
  if (body.split(HOME_FOOTER_0586).length !== 2) throw new Error("0.58.6 footer list not found exactly once");
  return body.replace(HOME_FOOTER_0586, HOME_FOOTER_0584);
}
export const RECEIPT_GETS = ["/v1/receipts", "/v1/receipts?page=2", "/v1/receipts?q=api.402rates.com", "/v1/receipts/44e3732d23", "/v1/receipts/44e3732d23?view=redacted", "/v1/receipts/0000000000",
  ...SAMPLE.map((r) => "/v1/receipts/" + r.id), "/v1/receipts/sc-ffffffffffffffff", "/v1/receipts/not-an-id", "/v1/receipts/by-url?url=https://api.402rates.com/v1/ping",
  "/v1/receipts?type=live", "/v1/receipts?type=live&limit=2", "/v1/receipts?type=dry-run", "/v1/receipts?type=self-checked", "/v1/receipts?type=bogus", "/v1/receipts?type=live&cursor=bad",
  "/v1/receipts/ps-0123456789abcdef", "/v1/receipts/er-0123456789abcdef", "/receipts"];
export const RECEIPT_ACCEPTS = { ...ACCEPTS, html: "text/html,application/xhtml+xml,*/*;q=0.8|Mozilla/5.0", htmljson: "text/html;q=0.1,application/json|Mozilla/5.0" };
export async function snapshotReceipts(workerPath) {
  const mod = await import(pathToFileURL(resolve(workerPath)).href);
  const lib = await import(pathToFileURL(resolve(workerPath, "..", "lib.js")).href);
  const norm = (x) => x.split(lib.VERSION).join("<VERSION>");
  const env = () => ({ DATA_BASE_URL: BASE, CLIENT_SALT: "snap-salt", SELF_CLIENTS: "withgrokbot", MULTIPROBE_GAP_MS: "0", FREE_PER_DAY: "5", PRICE_ATOMIC: "20000",
    PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", ENDPOINT_REPORT: "1", WATCHTOWER: "1", EXPLAIN_LINE: "1", BULK_REPORT: "1", FEED: "observe", DELIVERY_CHECK: "1", WEEK_EPOCH: "2026-10-01", RECEIPTS_DB: fakeReceiptsD1() });
  const out = {};
  for (const h of HOSTS) for (const p of RECEIPT_GETS) for (const [an, a] of Object.entries(RECEIPT_ACCEPTS)) {
    const [accept, ua] = a ? a.split("|") : [null, null];
    const req = new Request(h + p, { headers: { "cf-connecting-ip": "203.0.113.9", ...(ua ? { "user-agent": ua } : {}), ...(accept ? { accept } : {}) } });
    const res = await mod.default.fetch(req, env(), { waitUntil() {}, passThroughOnException() {} });
    const body = await res.text(); const hd = {};
    for (const [k, v] of [...res.headers.entries()].sort()) hd[k] = norm(v);
    out[`GET ${h}${p} [${an}]`] = { status: res.status, headers: hd, sha256: createHash("sha256").update(norm(body)).digest("hex") };
  }
  return out;
}

// 0.58.7: the skips surfaces (/v1/skips, /v1/skips.json, /skips.json, ?format=json, ?page=N incl. out-of-range and junk)
// on every host and Accept, with a store holding a real published skip page 2 (crawl_store s:2, 40 real rows) and real
// public recent_checks rows (tests/fixtures/skips_sample_2026-10-28.json), so page 2 and recent_checks are non-empty.
// Fixture from main 17342a1 (0.58.6): every non-browser answer must stay byte-identical when /v1/skips HTML is redesigned.
const SKIPS_SAMPLE = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/skips_sample_2026-10-28.json", import.meta.url)), "utf8"));
export function fakeSkipsD1(sample = SKIPS_SAMPLE) {
  const store = { "s:2": JSON.stringify(sample.s2) };
  const sha = (t) => createHash("sha256").update(t).digest("hex");
  const recent = [...sample.recent].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1));
  const q = (sql, a) => {
    if (/FROM crawl_store WHERE key = \?/.test(sql)) { const v = store[a[0]]; return v === undefined ? [] : [{ part: 0, parts: 1, sha256: sha(v), value: v }]; }
    if (/FROM spot_receipts WHERE pub_url IS NOT NULL/.test(sql)) return recent.slice(0, a[0]);
    return [];
  };
  return { prepare(sql) { const st = { a: [], bind(...x) { st.a = x; return st; }, async first() { return q(sql, st.a)[0] || null; }, async all() { return { results: q(sql, st.a) }; }, async run() { return { success: true, meta: { changes: 0 } }; } }; return st; }, async batch() { return []; } };
}
export const SKIPS_GETS = ["/v1/skips", "/v1/skips/", "/v1/skips.json", "/skips.json", "/v1/skips?format=json", "/v1/skips?page=1", "/v1/skips?page=2", "/v1/skips?page=2&format=json",
  "/v1/skips.json?page=2", "/v1/skips.json?page=2&format=json", "/v1/skips?page=3", "/v1/skips.json?page=3", "/v1/skips?page=999", "/v1/skips?page=0", "/v1/skips?page=abc", "/v1/skips?format=html", "/skips.json?page=2"];
/** 0.58.7: the only keys allowed to differ from the 0.58.6 skips fixture: browser Accept (names text/html) on /v1/skips
 * (not /v1/skips.json, not /skips.json, not ?format=json). */
export const SKIPS_HTML_KEY = /^GET https:\/\/(402xagent\.com|api\.402xagent\.com)\/v1\/skips\/?(\?(?!\S*format=json)\S*)? \[(html|htmljson)\]$/;
export async function snapshotSkips(workerPath) {
  const mod = await import(pathToFileURL(resolve(workerPath)).href);
  const lib = await import(pathToFileURL(resolve(workerPath, "..", "lib.js")).href);
  const norm = (x) => x.split(lib.VERSION).join("<VERSION>");
  const env = () => ({ DATA_BASE_URL: BASE, CLIENT_SALT: "snap-salt", SELF_CLIENTS: "withgrokbot", MULTIPROBE_GAP_MS: "0", FREE_PER_DAY: "5", PRICE_ATOMIC: "20000",
    PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", ENDPOINT_REPORT: "1", WATCHTOWER: "1", EXPLAIN_LINE: "1", BULK_REPORT: "1", FEED: "observe", DELIVERY_CHECK: "1", WEEK_EPOCH: "2026-10-01", TERMS_MAX_AGE_HOURS: "168", RECEIPTS_DB: fakeSkipsD1() });
  const out = {};
  for (const h of HOSTS) for (const p of SKIPS_GETS) for (const [an, a] of Object.entries(RECEIPT_ACCEPTS)) {
    const [accept, ua] = a ? a.split("|") : [null, null];
    const req = new Request(h + p, { headers: { "cf-connecting-ip": "203.0.113.9", ...(ua ? { "user-agent": ua } : {}), ...(accept ? { accept } : {}) } });
    const res = await mod.default.fetch(req, env(), { waitUntil() {}, passThroughOnException() {} });
    const body = await res.text(); const hd = {};
    for (const [k, v] of [...res.headers.entries()].sort()) hd[k] = norm(v);
    out[`GET ${h}${p} [${an}]`] = { status: res.status, headers: hd, sha256: createHash("sha256").update(norm(body)).digest("hex"), length: body.length };
  }
  return out;
}
/** The raw body of one skips request (same env as snapshotSkips), for the tests' content checks. */
export async function skipsBody(workerPath, url, accept) {
  const mod = await import(pathToFileURL(resolve(workerPath)).href);
  const env = { DATA_BASE_URL: BASE, CLIENT_SALT: "snap-salt", SELF_CLIENTS: "withgrokbot", MULTIPROBE_GAP_MS: "0", FREE_PER_DAY: "5", PRICE_ATOMIC: "20000",
    PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", ENDPOINT_REPORT: "1", WATCHTOWER: "1", EXPLAIN_LINE: "1", BULK_REPORT: "1", FEED: "observe", DELIVERY_CHECK: "1", WEEK_EPOCH: "2026-10-01", TERMS_MAX_AGE_HOURS: "168", RECEIPTS_DB: fakeSkipsD1() };
  const res = await mod.default.fetch(new Request(url, { headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "Mozilla/5.0", ...(accept ? { accept } : {}) } }), env, { waitUntil() {}, passThroughOnException() {} });
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.text() };
}

if (process.argv[2] === "--skips" && process.argv[3]) {
  process.stdout.write(JSON.stringify(await snapshotSkips(process.argv[3]), null, 1) + "\n");
} else if (process.argv[2] === "--receipts" && process.argv[3]) {
  process.stdout.write(JSON.stringify(await snapshotReceipts(process.argv[3]), null, 1) + "\n");
} else if (process.argv[2] === "--0583" && process.argv[3]) {
  process.stdout.write(JSON.stringify(await snapshot0583(process.argv[3]), null, 1) + "\n");
} else if (process.argv[2] === "--extra" && process.argv[3]) {
  process.stdout.write(JSON.stringify(await snapshotExtra(process.argv[3]), null, 1) + "\n");
} else if (process.argv[2] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { // 0.58.9: not when imported (bodies402.mjs)
  const snap = await snapshot(process.argv[2]);
  process.stdout.write(JSON.stringify(snap, null, 1) + "\n");
}

// 0.58.9: every key that answered 402 in the 0.58.7 snapshot (tests/fixtures/machine_0.58.7/bodies402.json). Their only
// allowed change is the Bazaar service metadata on resource; bazaar_meta_test.mjs checks that field by field.
export const META402_KEYS = new Set(Object.keys(JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/machine_0.58.7/bodies402.json", import.meta.url)), "utf8")).bodies));
