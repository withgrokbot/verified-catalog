// 0.72.0 "ship the upsell": the paid-check offer (paid_check) is finished. (1) the price is derived from the amount the paid
// 402 quotes, not typed; (2) the free x402 hygiene answer (HTTP and MCP) carries the same offer as the free spot check;
// (3) receipt pages carry a "Full check" panel. Free-tier behaviour, limits and every other field are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/index.js";
import { SPOT_PAID_ATOMIC, VERSION, FREE_UPSELL } from "../worker/src/lib.js";
import { SPOT_DEFAULT_PRICE_ATOMIC } from "../worker/src/spotcheck.js";
import { paidCheckBlock, PAID_CHECK_NOTE, PAID_CHECK_PRICE_USD, PAID_CHECK_AMOUNT_ATOMIC } from "../worker/src/paidcheck.js";
import { handleHygiene, HYGIENE_FREE_PER_DAY } from "../worker/src/hygiene.js";
import { liveReceiptHtml, crawlReceiptHtml, fullCheckPanel } from "../worker/src/receipts-html.js";
import { GOOD } from "./fixtures/hygiene.mjs";

const escH = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://api.402xagent.com";
const PAY_TO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";

test("0.72.0 version", () => assert.equal(VERSION, "0.80.0"));

test("price comes from the source of truth: no typed price in paidcheck.js, equal to the live 402 amount, the pricing row and SPOT_PAID_ATOMIC", async () => {
  const code = readFileSync(join(HERE, "..", "worker", "src", "paidcheck.js"), "utf8").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  assert.ok(!/0\.02|20000|\$0\./.test(code), "no price literal in the code of paidcheck.js");
  assert.equal(PAID_CHECK_AMOUNT_ATOMIC, SPOT_DEFAULT_PRICE_ATOMIC); assert.equal(PAID_CHECK_AMOUNT_ATOMIC, SPOT_PAID_ATOMIC);
  assert.equal(PAID_CHECK_PRICE_USD, String(Number(SPOT_PAID_ATOMIC) / 1e6));
  const r = await worker.fetch(new Request(API + "/v1/products/endpoint-spot-check", { headers: { "cf-connecting-ip": "198.51.100.7" } }), { PAY_TO, CLIENT_SALT: "t" }, { waitUntil() {} });
  assert.equal(r.status, 402); const q = await r.json();
  const b = paidCheckBlock("https://api.402rates.com/v1/ping");
  assert.equal(b.payment.amount_atomic, q.accepts[0].amount, "offer amount = what the paid 402 asks");
  assert.equal(b.payment.network, q.accepts[0].network); assert.equal(b.price_usd, String(q.price_usd));
  assert.deepEqual(b.endpoint, { method: "GET", url: API + "/v1/products/endpoint-spot-check" });
  assert.equal(b.product, "402xAgent paid check");
  const p = await worker.fetch(new Request("https://402xagent.com/pricing", { headers: { accept: "text/html" } }), { PAY_TO, CLIENT_SALT: "t" }, { waitUntil() {} });
  const row = /<tr id="check">([\s\S]*?)<\/tr>/.exec(await p.text())[1].replace(/<[^>]+>/g, " ");
  assert.ok(row.includes("$" + PAID_CHECK_PRICE_USD), "the /pricing row shows the same price: " + row.slice(0, 120));
  assert.ok(PAID_CHECK_NOTE.includes("$" + PAID_CHECK_PRICE_USD));
  assert.equal(FREE_UPSELL, "Full 402 details (exact payment terms, pay_to, deadline) for this endpoint for $" + PAID_CHECK_PRICE_USD, "FREE_UPSELL price derived, same text as before");
  assert.match(b.how.steps, /^After the 5 free checks per UTC day/);
});

function fakeD1() {
  const cache = new Map(), quota = new Map();
  return { cache, quota, prepare(sql) {
    const st = { args: [], bind(...a) { st.args = a; return st; },
      async first() {
        if (/FROM hygiene_cache/.test(sql)) { const r = cache.get(st.args[0]); return r && r.scored_at >= st.args[1] ? r : null; }
        if (/INTO hygiene_quota/.test(sql)) { const k = st.args[0] + "|" + st.args[1]; quota.set(k, (quota.get(k) || 0) + 1); return { n: quota.get(k) }; }
        return null;
      },
      async run() { if (/INTO hygiene_cache/.test(sql)) cache.set(st.args[0], { hkey: st.args[0], scored_at: st.args[1], json: st.args[2] }); return {}; } };
    return st; } };
}
const deps = (calls) => ({ resolveHostFn: async () => ["203.0.113.50"], fetchImpl: async (u) => { calls.push(String(u)); return new Response(GOOD.bodyText, { status: 402, headers: GOOD.headers }); } });
const get = (q, ip = "198.51.100.23") => new Request(API + "/v1/hygiene" + q, { headers: { "cf-connecting-ip": ip } });

test("free hygiene answer (fresh and cached) carries the paid_check offer for that URL; free behaviour, quota and the cached row are unchanged; errors carry none", async () => {
  const db = fakeD1(), calls = [], env = { RECEIPTS_DB: db, CLIENT_SALT: "s" };
  const target = "https://seller.fixture/api?q=1";
  const a = await (await handleHygiene(get("?url=" + target), env, deps(calls))).json();
  assert.deepEqual(a.paid_check, paidCheckBlock(target));
  assert.deepEqual(Object.keys(a).filter((k) => k !== "paid_check").sort(), ["cached", "deductions", "grade", "score", "scored_at", "url"], "every old field kept");
  assert.equal(a.cached, false); assert.equal(a.grade, "A");
  const stored = JSON.parse([...db.cache.values()][0].json); assert.ok(!("paid_check" in stored), "the cache row is the same as before");
  const b = await (await handleHygiene(get("?url=" + target), env, deps(calls))).json();
  assert.equal(b.cached, true); assert.deepEqual(b.paid_check, paidCheckBlock(target));
  assert.equal([...db.quota.values()][0], 1, "the cached answer used no quota; the fresh one used exactly one");
  for (const q of ["", "?url=notaurl", "?url=https://example.com/x"]) { const r = await handleHygiene(get(q), env, deps(calls)); assert.equal(r.status, 400); assert.ok(!("paid_check" in (await r.json())), q); }
  const lim = fakeD1(); const env2 = { RECEIPTS_DB: lim, CLIENT_SALT: "s" };
  for (let i = 0; i < HYGIENE_FREE_PER_DAY; i++) await handleHygiene(get("?url=https://seller.fixture/n" + i), env2, deps([]));
  const over = await handleHygiene(get("?url=https://seller.fixture/over"), env2, deps([])); assert.equal(over.status, 429);
  assert.ok(!("paid_check" in (await over.json())), "the limit answer is unchanged");
});

test("MCP x402_hygiene (free tool) result carries paid_check in structuredContent and the text", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    const s = String(u && u.url ? u.url : u);
    if (s.startsWith("https://cloudflare-dns.com/dns-query")) { const t = new URL(s).searchParams.get("type"); return Response.json({ Answer: t === "A" ? [{ type: 1, data: "93.184.216.34" }] : [] }); }
    if (s.startsWith("https://seller.fixture/")) return new Response(GOOD.bodyText, { status: 402, headers: GOOD.headers });
    return new Response("nope", { status: 404 });
  };
  try {
    const target = "https://seller.fixture/api";
    const r = await worker.fetch(new Request(API + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "198.51.100.9" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x402_hygiene", arguments: { url: target } } }) }), { RECEIPTS_DB: fakeD1(), CLIENT_SALT: "s", PAY_TO }, { waitUntil() {} });
    const res = (await r.json()).result;
    assert.ok(!res.isError, JSON.stringify(res).slice(0, 300));
    assert.deepEqual(res.structuredContent.paid_check, paidCheckBlock(target));
    assert.equal(JSON.parse(res.content[0].text).paid_check.price_usd, PAID_CHECK_PRICE_USD);
  } finally { globalThis.fetch = realFetch; }
});

test("receipt pages: a Full check panel on free (redacted), dry-run and crawl receipts, built from paidCheckBlock; a paid receipt has none; hostile urls are escaped", () => {
  const live = { id: "sc-0123456789abcdef", url: "https://a.example/x?y=1", verdict: "pay", checked_at: "2026-11-03T00:00:00Z", live_402: { http_status: 402, x402_challenge: true, accepts_count: 1 } };
  const crawl = { id: "0123456789", url: "https://a.example/x", verdict: "skip", reason: "no x402 payment request (HTTP 200)", timestamp: "2026-11-03T00:00:00Z" };
  const panel = fullCheckPanel(live.url), b = paidCheckBlock(live.url);
  for (const html of [liveReceiptHtml("https://402xagent.com", { ...live, redacted: true }, ""), liveReceiptHtml("https://402xagent.com", { ...live, dry_run: true }, ""), crawlReceiptHtml("https://402xagent.com", { ...crawl, url: live.url }, "")]) {
    assert.ok(html.includes('<section class="rc-card rc-full" id="full-check"><h2>Full check</h2>'), "panel present");
    assert.ok(html.includes("<dt>Price</dt><dd>$" + PAID_CHECK_PRICE_USD + " USDC on Base via x402, per check</dd>"));
    assert.ok(html.includes('<p class="rc-note rc-paid">' + PAID_CHECK_NOTE + "</p>"), "the 0.62.0 note is inside the panel");
    assert.ok(html.includes(escH(b.how.url)), "the request for THIS url");
    for (const a of b.adds) assert.ok(html.includes(escH(a)), "adds: " + a);
    assert.ok(html.includes('<a href="/pricing#check">Pricing</a>'));
  }
  assert.ok(!liveReceiptHtml("https://402xagent.com", live, "").includes("full-check"), "a full (paid) receipt has no upsell");
  assert.ok(panel.length < 2200, "small: " + panel.length);
  const evil = fullCheckPanel('https://a.example/"><script>alert(1)</script>');
  assert.ok(!evil.includes("<script") && !evil.includes("alert(1)<"), "escaped");
});

test("free spot-check answer: same fields as before plus the offer (now with product and endpoint); the offer never leaks paid-only fields", async () => {
  const b = paidCheckBlock("https://api.402rates.com/v1/ping");
  assert.deepEqual(Object.keys(b), ["product", "price_usd", "endpoint", "payment", "adds", "how", "note"]);
  assert.ok(!/reputation|quality|history|score|pay_to":"0x/i.test(JSON.stringify(b)), "no paid data in the offer");
  assert.ok(JSON.stringify(b).length < 1300, "small: " + JSON.stringify(b).length);
});
