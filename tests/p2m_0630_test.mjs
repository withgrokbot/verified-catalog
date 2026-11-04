// 0.63.0 page-to-markdown: extraction fixtures, robots.txt, SSRF guard, the 402 flow (free -> 402 -> paid; never charged
// without a page), MCP page_to_markdown, and the discovery entries (present with P2M on, absent with P2M=off). No network:
// DoH, robots, pages and the facilitator are stubbed; settle idempotency runs on in-memory SQLite (local only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToMarkdown, parseRobots } from "../worker/src/page2md.js";
import { handlePageToMarkdown, P2M_PATH, p2mCfg } from "../worker/src/p2m.js";
import worker from "../worker/src/index.js";
import { QuotaCounter, VERSION } from "../worker/src/lib.js";
import { sqliteD1 as d1 } from "./helpers/sqlite_d1.mjs";

const FX = (f) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "p2m", f), "utf8");
const PAY_TO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";
const API = "https://api.402xagent.com";

// ---- world: DoH, robots.txt, pages, facilitator
const PAGES = {
  "https://ok.fixture/post": { status: 200, body: FX("article.html") },
  "https://ok.fixture/login": { status: 200, body: FX("login.html") },
  "https://ok.fixture/story": { status: 200, body: FX("paywall.html") },
  "https://ok.fixture/private/x": { status: 200, body: FX("article.html") },
  "https://ok.fixture/secret": { status: 403, body: "Forbidden" },
  "https://ok.fixture/hop": { status: 302, location: "http://10.0.0.5/admin" },
  "https://ok.fixture/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private\n", type: "text/plain" },
};
let settles = 0, used = new Set();
globalThis.fetch = async (u, init = {}) => {
  const s = String(u && u.url ? u.url : u);
  if (s.startsWith("https://cloudflare-dns.com/dns-query")) {
    const name = new URL(s).searchParams.get("name"), type = new URL(s).searchParams.get("type");
    const ip = name === "internal.fixture" ? "10.1.2.3" : "93.184.216.34";
    return Response.json({ Answer: type === "A" ? [{ type: 1, data: ip }] : [] });
  }
  if (s.includes("facilitator")) {
    const b = JSON.parse(init.body || "{}"); const n = b.paymentPayload.payload.authorization.nonce;
    if (s.endsWith("/verify")) return Response.json(used.has(n) ? { isValid: false, invalidReason: "nonce_already_used" } : { isValid: true, payer: "0xb1" });
    used.add(n); settles++; return Response.json({ success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer: "0xb1" });
  }
  const p = PAGES[s];
  if (!p) return new Response("nope", { status: 404 });
  return new Response(p.status === 302 ? null : p.body, { status: p.status, headers: { "content-type": p.type || "text/html; charset=utf-8", ...(p.location ? { location: p.location } : {}) } });
};
function quotaNs() { // the real QuotaCounter class on an in-memory storage
  const objs = new Map();
  return { idFromName: (n) => n, get: (id) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, new QuotaCounter({ storage: { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) } }, {})); } const o = objs.get(id); return { fetch: (u) => o.fetch(new Request(u)) }; } };
}
const env = (x = {}) => ({ PAY_TO, FACILITATOR_URL: "https://facilitator.fixture", CLIENT_SALT: "t", QUOTA: quotaNs(), RECEIPTS_DB: d1(), PAYSTATUS_PUBLIC_RPC: "https://rpc.fixture", RPC2_BASE_URL: "off", ...x });
const call = (e, target, headers = {}) => { const url = new URL(API + P2M_PATH + "?url=" + encodeURIComponent(target)); return handlePageToMarkdown(new Request(url, { headers: { "cf-connecting-ip": "198.51.100.7", ...headers } }), e, {}, url); };
const pay = (n, amount = "2000") => btoa(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", amount, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO },
  payload: { signature: "0xsig", authorization: { from: "0x00000000000000000000000000000000000000b1", to: PAY_TO, value: amount, nonce: "0x" + n.repeat(32), validBefore: "9999999999" } } }));

test("0.63.0 version", () => assert.equal(VERSION, "0.66.1"));

test("extraction: main content only, absolute links, no empty links, tables + code kept, whitespace collapsed", () => {
  const r = htmlToMarkdown(FX("article.html"), "https://ok.fixture/post");
  assert.equal(r.title, "Fixture Article"); assert.equal(r.description, "A fixture article.");
  assert.match(r.markdown, /^# Fixture Article\n/);
  assert.match(r.markdown, /\[relative link\]\(https:\/\/ok\.fixture\/docs\/intro\)/);
  for (const junk of ["cookies", "BUY NOW", "Related posts", "© Site", "tracking", "Share", "](https://ok.fixture/empty)", "javascript:"]) assert.ok(!r.markdown.includes(junk), junk);
  assert.match(r.markdown, /js link lots of spaces here\./);
  assert.match(r.markdown, /\| Plan \| Price \|\n\| --- \| --- \|\n\| Free \| \$0 \|\n\| Pro \| \$9 \\\| month \|/);
  assert.match(r.markdown, /```js\nconst x = 1 < 2;\n```/);
  assert.match(r.markdown, /- one\n- two\n  - nested/);
  assert.deepEqual(r.links, ["https://ok.fixture/docs/intro"]);
  assert.equal(r.token_estimate, Math.ceil(r.markdown.length / 4)); assert.ok(r.word_count > 20 && !r.blocked);
});
test("extraction: login wall and paywall are detected", () => {
  assert.equal(htmlToMarkdown(FX("login.html"), "https://ok.fixture/login").blocked, "login_wall");
  assert.equal(htmlToMarkdown(FX("paywall.html"), "https://ok.fixture/story").blocked, "paywall");
});
test("robots.txt: longest match wins, Allow on tie, specific agent group, $ anchor", () => {
  const r = parseRobots("User-agent: *\nDisallow: /\nAllow: /docs\nDisallow: /docs/private\nDisallow: /*.pdf$\n\nUser-agent: OtherBot\nDisallow:\n", "402xAgent-PageToMarkdown");
  assert.equal(r.isAllowed("/"), false); assert.equal(r.isAllowed("/docs/a"), true); assert.equal(r.isAllowed("/docs/private/x"), false);
  assert.equal(r.isAllowed("/docs/a.pdf"), false); assert.equal(r.isAllowed("/docs/a.pdf?x=1"), true);
  assert.equal(parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: OtherBot\nDisallow:\n", "otherbot").isAllowed("/x"), true);
});

test("free page: 200 with Markdown, access free; robots disallow / login wall / 403 answer 422 not charged and use no free page", async () => {
  const e = env();
  for (const [u, reason] of [["https://ok.fixture/private/x", "robots_txt_disallow"], ["https://ok.fixture/login", "login_wall"], ["https://ok.fixture/story", "paywall"], ["https://ok.fixture/secret", "auth_required_http_403"]]) {
    const r = await call(e, u); const j = await r.json();
    assert.equal(r.status, 422, u); assert.equal(j.reason, reason); assert.equal(j.charged, false);
  }
  for (let i = 1; i <= 3; i++) { const r = await call(e, "https://ok.fixture/post"); const j = await r.json(); assert.equal(r.status, 200); assert.equal(j.access.tier, "free"); assert.equal(j.access.free_used_today, i); assert.match(j.markdown, /Fixture Article/); }
  const r = await call(e, "https://ok.fixture/post");
  assert.equal(r.status, 402); const j = await r.json();
  assert.equal(j.accepts[0].amount, "2000"); assert.equal(j.accepts[0].payTo, PAY_TO); assert.equal(j.accepts[0].network, "eip155:8453");
  assert.ok(r.headers.get("payment-required")); assert.equal(settles, 0);
});

test("SSRF: private targets and private redirect hops are refused (400), never fetched", async () => {
  const e = env();
  for (const u of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "https://internal.fixture/x", "file:///etc/passwd"]) assert.equal((await call(e, u)).status, 400, u);
  const r = await call(e, "https://ok.fixture/hop"); assert.equal(r.status, 400); assert.equal((await r.json()).reason, "ssrf_blocked");
});

test("paid: settles only after a page is converted; failed page = no settle; wrong amount = 402; replay = same answer, one charge", async () => {
  const e = env({ P2M_FREE_PER_DAY: "0" }); settles = 0; used = new Set();
  let r = await call(e, "https://ok.fixture/login", { "payment-signature": pay("a1") });
  assert.equal(r.status, 422); assert.equal(settles, 0, "no settle without a page");
  r = await call(e, "https://ok.fixture/post", { "payment-signature": pay("a2", "20000") });
  assert.equal(r.status, 402); assert.match((await r.json()).error, /amount does not match/); assert.equal(settles, 0);
  r = await call(e, "https://ok.fixture/post", { "payment-signature": pay("a3") });
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(j.access.tier, "paid"); assert.equal(j.access.charged_usd, "0.002");
  assert.ok(r.headers.get("payment-response")); assert.equal(settles, 1);
  assert.ok(!JSON.stringify(j).includes("0xb1"), "no payer wallet in the body");
  r = await call(e, "https://ok.fixture/post", { "payment-signature": pay("a3") });
  assert.equal(r.status, 200); assert.equal(settles, 1, "replay is not charged twice");
  assert.equal(p2mCfg({ P2M_PRICE_ATOMIC: "1500" }).priceUsd, "0.0015");
});

test("MCP page_to_markdown: listed, free call returns Markdown, 402 text after the free pages, gone with P2M=off", async () => {
  const e = env({ P2M_FREE_PER_DAY: "1" });
  const rpc = async (ev, method, params = {}) => (await (await worker.fetch(new Request(API + "/mcp", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.9" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), ev, { waitUntil() {} })).json());
  assert.ok((await rpc(e, "tools/list")).result.tools.some((t) => t.name === "page_to_markdown"));
  let out = await rpc(e, "tools/call", { name: "page_to_markdown", arguments: { url: "https://ok.fixture/post", format: "markdown" } });
  assert.ok(!out.result.isError); assert.match(out.result.content[0].text, /Fixture Article/);
  out = await rpc(e, "tools/call", { name: "page_to_markdown", arguments: { url: "https://ok.fixture/post" } });
  assert.equal(out.result.isError, true); assert.match(out.result.content[0].text, /Payment required: \$0\.002 USDC/);
  const off = env({ P2M: "off" });
  assert.ok(!(await rpc(off, "tools/list")).result.tools.some((t) => t.name === "page_to_markdown"));
});

test("discovery: openapi, llms.txt, .well-known/x402 and /docs list it with P2M on; route 404s with P2M=off", async () => {
  const get = async (ev, p) => worker.fetch(new Request((p.startsWith("/llms") ? "https://402xagent.com" : API) + p), ev, { waitUntil() {} });
  const e = env();
  assert.ok((await (await get(e, "/openapi.json")).json()).paths[P2M_PATH].get);
  assert.match(await (await get(e, "/llms.txt")).text(), /Page to Markdown \(3 free pages\/day, then \$0\.002 USDC/);
  assert.ok(JSON.stringify(await (await get(e, "/.well-known/x402")).json()).includes(P2M_PATH));
  const d = await (await get(e, P2M_PATH + "/docs")).json(); assert.equal(d.price.then_usd, "0.002"); assert.equal(d.price.charged_only_on_success, true);
  const off = env({ P2M: "off" });
  assert.equal((await get(off, P2M_PATH + "?url=https://ok.fixture/post")).status, 404);
  assert.ok(!(await (await get(off, "/openapi.json")).json()).paths[P2M_PATH]);
});

test("machine surfaces: with P2M on, only llms.txt, openapi.json, .well-known/x402 and MCP tools/list differ from P2M=off", async () => {
  const { spawnSync } = await import("node:child_process");
  const snap = (keep) => JSON.parse(spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "helpers", "machine_snapshot.mjs"), join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "src", "index.js")],
    { encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, ...(keep ? { SNAP_KEEP_0630: "1" } : {}) } }).stdout);
  const off = snap(false), on = snap(true);
  const routes = new Set(Object.keys(off).filter((k) => JSON.stringify(off[k]) !== JSON.stringify(on[k])).map((k) => k.replace(/ \[.*\]$/, "").replace(/https:\/\/[^/]+/, "")));
  assert.deepEqual([...routes].sort(), ["GET /.well-known/x402", "GET /llms.txt", "GET /openapi.json", 'POST /mcp {"jsonrpc":"2.0","id":2,"method":"tools/list"}'].sort());
});
