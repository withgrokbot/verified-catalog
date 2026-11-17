// 0.73.0 bulk limits on /v1/receipts*: single reads unaffected, paging limited, 429 shape, verified bots keep single pages.
// No network. Runs the real QuotaCounter in an in-memory Durable Object namespace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../worker/src/index.js";
import { QuotaCounter, VERSION } from "../worker/src/lib.js";
import { receiptGuard, skipsPageGuard, isAiCrawler, isSearchEngineUa, receiptCaps, receiptRequestClass, isVerifiedBot, BULK_ACCESS_URL, RECEIPT_PAGES_PER_MIN, RECEIPT_PAGES_PER_DAY, RECEIPT_SINGLE_PER_DAY, RECEIPT_RATE_PER_MIN } from "../worker/src/receiptguard.js";
import { pricingHtml } from "../worker/src/pricing.js";

function quotaNs({ broken = false } = {}) {
  const objs = new Map(); const calls = [];
  return {
    calls,
    idFromName(n) { return n; },
    get(id) {
      if (broken) return { fetch: async () => { throw new Error("DO down"); } };
      if (!objs.has(id)) { const m = new Map(); objs.set(id, new QuotaCounter({ storage: { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, structuredClone(v)) } }, {})); }
      const o = objs.get(id);
      return { fetch: (u) => { calls.push(id.split(":")[0] + " " + new URL(u).pathname); return o.fetch(new Request(u)); } };
    },
  };
}
const NOW = new Date("2026-11-17T18:00:30Z");
let inner = 0;
const ok = async () => { inner++; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); };
function mk(env0, ip = "198.51.100.10", ua = "curl/8") {
  const env = env0 && env0.BULK_LIMITS === undefined ? { BULK_LIMITS: "1", ...env0 } : env0;
  return async (u, { h = {}, cf = null, now = NOW } = {}) => {
    const url = new URL(u); const req = new Request(url, { headers: { "cf-connecting-ip": ip, "user-agent": ua, ...h } });
    if (cf) Object.defineProperty(req, "cf", { value: cf });
    return receiptGuard(req, env, null, url, url.pathname.replace(/\/+$/, "") || "/", ok, { now, cache: null });
  };
}
const SINGLE = "https://402xagent.com/v1/receipts/sc-0123456789abcdef";

test("version and defaults", () => {
  assert.equal(VERSION, "0.75.0");
  assert.deepEqual([RECEIPT_PAGES_PER_MIN, RECEIPT_PAGES_PER_DAY, RECEIPT_SINGLE_PER_DAY, RECEIPT_RATE_PER_MIN], [6, 40, 300, 120]);
  const c = receiptCaps({ RECEIPT_PAGES_PER_MIN: "2", RECEIPT_SINGLE_PER_DAY: "abc", BULK_LIMITS: "0" });
  assert.equal(c.pagesPerMin, 2); assert.equal(c.singlePerDay, 300, "bad var falls back to the default"); assert.equal(c.on, false, "off unless BULK_LIMITS=1"); assert.equal(receiptCaps({ BULK_LIMITS: "1" }).on, true);
});

test("request classes: pages walk the list, singles are single", () => {
  const cl = (u) => { const x = new URL(u); return receiptRequestClass(x, x.pathname.replace(/\/+$/, "")); };
  assert.equal(cl("https://402xagent.com/v1/receipts"), "list");
  assert.equal(cl("https://402xagent.com/v1/receipts?format=json"), "list");
  for (const q of ["?type=live", "?page=2", "?cursor=abc", "?ref=x", "?limit=100", "?offset=500", "?type=live&cursor=abc"]) assert.equal(cl("https://402xagent.com/v1/receipts" + q), "page", q);
  for (const p of ["/sc-0123456789abcdef", "/0123456789", "/by-url?url=https://a.example/x", "/sc-0123456789abcdef/proof"]) assert.equal(cl("https://402xagent.com/v1/receipts" + p), "single", p);
});

test("single lookups are unaffected: well past the page caps, one Durable Object call each, no extra call for ordinary readers", async () => {
  const ns = quotaNs(); const go = mk({ QUOTA: ns });
  for (let i = 0; i < 5; i++) {
    for (const u of [SINGLE, "https://402xagent.com/v1/receipts/0123456789", "https://402xagent.com/v1/receipts/by-url?url=https%3A%2F%2Fa.example%2Fx", SINGLE + "/proof"]) assert.equal((await go(u)).status, 200, u);
  }
  assert.equal(ns.calls.length, 20, "exactly one DO call per single read (20 reads, more than three times the page cap)");
  assert.ok(ns.calls.every((c) => c === "rcpt /multi"), "same key and one combined call as before; no group call under the probe");
  for (let i = 0; i < 10; i++) await go(SINGLE);
  assert.equal(ns.calls.length, 20 + 10 + 5, "reads 26-30 are past the probe (25) and add one group call each");
});

test("paging is limited per minute, then per day, with a 429 + Retry-After + machine-readable offer", async () => {
  const ns = quotaNs(); const go = mk({ QUOTA: ns });
  for (let i = 0; i < RECEIPT_PAGES_PER_MIN; i++) assert.equal((await go("https://402xagent.com/v1/receipts?type=live&page=" + i)).status, 200, "page " + i);
  const over = await go("https://402xagent.com/v1/receipts?type=live&cursor=zz");
  assert.equal(over.status, 429);
  assert.equal(over.headers.get("retry-after"), "30", "seconds to the next UTC minute");
  assert.equal(over.headers.get("x-receipt-limit"), "pages_minute");
  assert.equal(over.headers.get("cache-control"), "no-store");
  assert.match(over.headers.get("content-type"), /application\/json/);
  const b = await over.json();
  assert.equal(b.code, "bulk_limit"); assert.equal(b.scope, "pages_minute"); assert.equal(b.retry_after_seconds, 30);
  assert.equal(b.bulk_access.url, BULK_ACCESS_URL); assert.equal(b.bulk_access.status, "not_live");
  assert.match(b.bulk_access.note, /bulk export and \.ots bundles are paid and not live/);
  assert.match(b.free_still_works, /Single receipts stay free/);
  assert.ok(!JSON.stringify(b).includes("198.51.100"), "no client address in the body");
  // a single read is still served while paging is limited
  assert.equal((await go(SINGLE)).status, 200);
  // next minutes: the daily cap (40) bites after 40 pages in total
  let served = RECEIPT_PAGES_PER_MIN, minute = 1, last, lastNow;
  while (served < RECEIPT_PAGES_PER_DAY + 5) {
    const now = new Date(NOW.getTime() + minute * 60000); lastNow = now;
    for (let i = 0; i < RECEIPT_PAGES_PER_MIN; i++) { last = await go("https://402xagent.com/v1/receipts?page=" + served, { now }); if (last.status === 200) served++; else break; }
    if (last.status === 429) break;
    minute++;
  }
  assert.equal(served, RECEIPT_PAGES_PER_DAY, "exactly the daily cap is served");
  const d = await last.json();
  assert.equal(d.scope, "pages_day");
  assert.equal(last.headers.get("retry-after"), String(86400 - (lastNow.getUTCHours() * 3600 + lastNow.getUTCMinutes() * 60 + lastNow.getUTCSeconds())), "seconds to 00:00 UTC");
  // next UTC day starts fresh
  assert.equal((await go("https://402xagent.com/v1/receipts?page=2", { now: new Date("2026-11-18T00:00:05Z") })).status, 200);
});

test("another client is not affected by one client's paging", async () => {
  const ns = quotaNs(); const env = { QUOTA: ns };
  const a = mk(env, "198.51.100.10"), b = mk(env, "198.51.100.11");
  for (let i = 0; i < RECEIPT_PAGES_PER_MIN + 2; i++) await a("https://402xagent.com/v1/receipts?page=" + i);
  assert.equal((await a("https://402xagent.com/v1/receipts?page=9")).status, 429);
  assert.equal((await b("https://402xagent.com/v1/receipts?page=9")).status, 200);
});

test("many IPs, one ASN and one User-Agent share the group page budget", async () => {
  const ns = quotaNs(); const env = { QUOTA: ns, RECEIPT_PAGES_PER_DAY_GROUP: "5" };
  let n = 0, hit = null;
  for (let i = 0; i < 12 && !hit; i++) {
    const r = await mk(env, "203.0.113." + (i + 1), "scraper/1")("https://402xagent.com/v1/receipts?page=" + i, { cf: { asn: 64500 } });
    if (r.status === 429) hit = r; else n++;
  }
  assert.equal(n, 5); assert.equal(hit.headers.get("x-receipt-limit"), "pages_group");
  // same IPs on another ASN are a different group
  assert.equal((await mk(env, "203.0.113.50", "scraper/1")("https://402xagent.com/v1/receipts?page=1", { cf: { asn: 64501 } })).status, 200);
});

test("daily single-read cap: a client past it gets the 429, a normal reader never does", async () => {
  const ns = quotaNs(); const env = { QUOTA: ns, RECEIPT_SINGLE_PER_DAY: "30", RECEIPT_RATE_PER_MIN: "1000" };
  const go = mk(env, "198.51.100.20", "Mozilla/5.0 (scraper)");
  for (let i = 0; i < 30; i++) assert.equal((await go("https://402xagent.com/v1/receipts/0123456789")).status, 200, "read " + i);
  const r = await go("https://402xagent.com/v1/receipts/0123456789");
  assert.equal(r.status, 429); const b = await r.json();
  assert.equal(b.scope, "single_day"); assert.equal(b.code, "bulk_limit"); assert.equal(b.bulk_access.url, BULK_ACCESS_URL);
  assert.equal(r.headers.get("retry-after"), String(86400 - (18 * 3600 + 30)));
  // per-minute limit keeps its 0.62.0 body
  const env2 = { QUOTA: quotaNs(), RECEIPT_RATE_PER_MIN: "3" }; const g2 = mk(env2, "198.51.100.21");
  for (let i = 0; i < 3; i++) await g2(SINGLE);
  const m = await g2(SINGLE); const mb = await m.json();
  assert.equal(m.status, 429); assert.equal(mb.code, "rate_limited"); assert.equal(mb.error, "rate limited"); assert.equal(mb.retry_after_seconds, 30);
});

test("heavy clients past the probe also feed the group counter; the group cap then limits a spread-out crawl", async () => {
  const ns = quotaNs(); const env = { QUOTA: ns, RECEIPT_GROUP_PROBE: "2", RECEIPT_SINGLE_PER_DAY_GROUP: "6", RECEIPT_RATE_PER_MIN: "1000" };
  let hit = null, served = 0;
  for (let ip = 1; ip <= 4 && !hit; ip++) for (let i = 0; i < 6 && !hit; i++) {
    const r = await mk(env, "203.0.113." + ip, "crawler-x")("https://402xagent.com/v1/receipts/0123456789", { cf: { asn: 64500 } });
    if (r.status === 429) hit = r; else served++;
  }
  assert.ok(hit, "group cap reached"); assert.equal(hit.headers.get("x-receipt-limit"), "single_group");
  assert.equal(served, 10, "IP1: 2 reads under the probe + 4 group units; IP2: 2 + the last 2 group units; IP2's next read is over the group cap");
});

test("verified search bots keep single pages (no daily single cap) but are still capped on paging", async () => {
  const env = { QUOTA: quotaNs(), RECEIPT_SINGLE_PER_DAY: "5", RECEIPT_RATE_PER_MIN: "1000", RECEIPT_GROUP_PROBE: "1", RECEIPT_SINGLE_PER_DAY_GROUP: "5" };
  const ua = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
  for (const cf of [{ botManagement: { verifiedBot: true } }, { verifiedBotCategory: "Search Engine Crawler" }, { asn: 15169 }]) {
    const go = mk({ ...env, QUOTA: quotaNs() }, "198.51.100.30", ua);
    for (let i = 0; i < 40; i++) assert.equal((await go("https://402xagent.com/v1/receipts/0123456789", { cf })).status, 200, JSON.stringify(cf) + " single " + i);
    let pages = 0; for (let i = 0; i < 12; i++) if ((await go("https://402xagent.com/v1/receipts?page=" + i, { cf })).status === 200) pages++;
    assert.equal(pages, RECEIPT_PAGES_PER_MIN, "paging capped for a verified bot: " + JSON.stringify(cf));
  }
  assert.equal(isVerifiedBot(new Request("https://x/", { headers: { "user-agent": "curl/8" } })), false);
});

test("self-declared search-engine UAs count as verified for single reads with no CF flag and no ASN match; AI crawlers never do, even marked verified by CF", async () => {
  const env = { QUOTA: quotaNs(), RECEIPT_SINGLE_PER_DAY: "5", RECEIPT_RATE_PER_MIN: "1000", RECEIPT_GROUP_PROBE: "1", RECEIPT_SINGLE_PER_DAY_GROUP: "5" };
  const search = ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "Mozilla/5.0 (Macintosh) AppleWebKit/605 (Applebot/0.1)", "Mozilla/5.0 (compatible; YandexBot/3.0)", "Mozilla/5.0 (compatible; Baiduspider/2.0)"];
  for (const ua of search) {
    assert.ok(isSearchEngineUa(ua), ua);
    for (const cf of [null, { asn: 64500 }]) {
      const go = mk({ ...env, QUOTA: quotaNs() }, "198.51.100.32", ua);
      for (let i = 0; i < 30; i++) assert.equal((await go("https://402xagent.com/v1/receipts/0123456789", { cf })).status, 200, ua + " " + i);
    }
  }
  const ai = ["Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.1; +https://openai.com/gptbot)", "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "CCBot/2.0 (https://commoncrawl.org/faq/)",
    "Mozilla/5.0 (compatible; PerplexityBot/1.0)", "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)", "Mozilla/5.0 (compatible; Amazonbot/0.1)",
    "Mozilla/5.0 (compatible; Google-Extended)", "Mozilla/5.0 (compatible; meta-externalagent/1.1)", "Mozilla/5.0 (compatible; Applebot-Extended/0.1)"];
  for (const ua of ai) {
    assert.ok(isAiCrawler(ua), ua); assert.equal(isSearchEngineUa(ua), false, ua);
    for (const cf of [null, { botManagement: { verifiedBot: true } }, { verifiedBotCategory: "AI Crawler" }, { verifiedBotCategory: "Search Engine Crawler", asn: 15169 }]) {
      const go = mk({ ...env, QUOTA: quotaNs() }, "198.51.100.33", ua); let n = 0;
      for (let i = 0; i < 12; i++) if ((await go("https://402xagent.com/v1/receipts/0123456789", { cf })).status === 200) n++;
      assert.equal(n, 5, "AI crawler capped like anyone else: " + ua + " " + JSON.stringify(cf));
    }
  }
  // paging stays capped for everyone, search engines included
  const g = mk({ ...env, QUOTA: quotaNs() }, "198.51.100.34", search[0]); let pages = 0;
  for (let i = 0; i < 12; i++) if ((await g("https://402xagent.com/v1/receipts?page=" + i, { cf: { botManagement: { verifiedBot: true } } })).status === 200) pages++;
  assert.equal(pages, RECEIPT_PAGES_PER_MIN);
  // another CF-verified client with an ordinary UA (e.g. a monitor) is still treated as verified for single reads
  assert.equal(isVerifiedBot(new Request("https://x/", { headers: { "user-agent": "SomeMonitor/1" } })), false);
  const mon = new Request("https://x/", { headers: { "user-agent": "SomeMonitor/1" } }); Object.defineProperty(mon, "cf", { value: { verifiedBotCategory: "Monitoring & Analytics" } });
  assert.equal(isVerifiedBot(mon), true);
});

const SKIPS = "https://402xagent.com/v1/skips";
test("skips paging: ?page=N (N>1) on /v1/skips and /v1/skips.json shares the receipt list-paging cap; page 1 and the bare page stay free", async () => {
  const env = { QUOTA: quotaNs(), BULK_LIMITS: "1" };
  const guard = (u, ip, ua = "curl/8", cf = null, now = NOW) => { const url = new URL(u); const req = new Request(url, { headers: { "cf-connecting-ip": ip, "user-agent": ua } }); if (cf) Object.defineProperty(req, "cf", { value: cf }); return skipsPageGuard(req, env, url, now); };
  for (let i = 0; i < 50; i++) { assert.equal(await guard(SKIPS, "198.51.100.70"), null, "bare"); assert.equal(await guard(SKIPS + "?page=1", "198.51.100.70"), null, "page=1"); assert.equal(await guard(SKIPS + ".json?page=junk", "198.51.100.70"), null); }
  let served = 0, hit = null;
  for (let i = 2; i < 14 && !hit; i++) { const r = await guard((i % 2 ? SKIPS : SKIPS + ".json") + "?page=" + i, "198.51.100.71"); if (r) hit = r; else served++; }
  assert.equal(served, RECEIPT_PAGES_PER_MIN, "HTML and JSON skips pages share one per-minute budget");
  assert.equal(hit.status, 429); assert.equal(hit.headers.get("x-receipt-limit"), "pages_minute"); assert.equal(hit.headers.get("retry-after"), "30");
  const b = await hit.json(); assert.equal(b.code, "bulk_limit"); assert.equal(b.bulk_access.url, BULK_ACCESS_URL); assert.equal(b.bulk_access.status, "not_live");
  // shared with receipt list pages: the same client's receipt pages are now over budget too, and another client is unaffected
  const rg = mk(env, "198.51.100.71");
  assert.equal((await rg("https://402xagent.com/v1/receipts?page=2")).status, 429);
  assert.equal(await guard(SKIPS + "?page=2", "198.51.100.72"), null);
  // verified search bot: still capped on paging
  let bp = 0; for (let i = 2; i < 14; i++) if (!(await guard(SKIPS + "?page=" + i, "198.51.100.73", "Mozilla/5.0 (compatible; Googlebot/2.1)", { botManagement: { verifiedBot: true } }))) bp++;
  assert.equal(bp, RECEIPT_PAGES_PER_MIN);
  // daily cap
  let day = 0, last; for (let m = 0; m < 20 && !last; m++) for (let i = 0; i < 6; i++) { const r = await guard(SKIPS + "?page=" + (i + 2), "198.51.100.74", "curl/8", null, new Date(NOW.getTime() + m * 60000)); if (r) { last = r; break; } day++; }
  assert.equal(day, RECEIPT_PAGES_PER_DAY); assert.equal((await last.json()).scope, "pages_day");
  // payscout.dev never limited; flag off never limited
  for (let i = 0; i < 12; i++) assert.equal(await guard("https://api.payscout.dev/v1/skips.json?page=" + (i + 2), "198.51.100.75"), null);
  const off = { QUOTA: quotaNs() };
  for (let i = 0; i < 12; i++) { const url = new URL(SKIPS + "?page=" + (i + 2)); assert.equal(await skipsPageGuard(new Request(url, { headers: { "cf-connecting-ip": "198.51.100.76" } }), off, url, NOW), null); }
});

test("skips paging end to end through the Worker: 429 on the 7th page, page 1 answers, scope in analytics blob17", async () => {
  const points = []; const pending = []; const ctx = { waitUntil: (p) => void pending.push(p) };
  const env = { BULK_LIMITS: "1", QUOTA: quotaNs(), CLIENT_SALT: "s", LOOKUPS: { writeDataPoint: (d) => points.push(d) }, RECEIPT_PAGES_PER_DAY: "2" };
  const call = (u, accept = "application/json") => worker.fetch(new Request(u, { headers: { "cf-connecting-ip": "198.51.100.80", "user-agent": "walker/1", accept } }), env, ctx);
  assert.equal((await call(SKIPS + ".json?page=2")).status, 200);
  assert.equal((await call(SKIPS + "?page=3", "text/html")).status, 200, "HTML skips page");
  const r = await call(SKIPS + ".json?page=4");
  assert.equal(r.status, 429); assert.equal((await r.json()).bulk_access.url, BULK_ACCESS_URL);
  assert.equal((await call(SKIPS + ".json")).status, 200, "first page still free");
  await Promise.all(pending);
  const rl = points.filter((p) => p.blobs[12] === "view-skips" && p.doubles[2] === 429);
  assert.equal(rl.length, 1); assert.equal(rl[0].blobs[16], "pages_day");
});

test("wrangler.toml leaves BULK_LIMITS unset (a merge or deploy does not enable the limits); the RECEIPT_* vars are the code defaults", () => {
  const toml = readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
  assert.doesNotMatch(toml, /^BULK_LIMITS\s*=/m);
  const num = (k) => Number((new RegExp("^" + k + '\\s*=\\s*"(\\d+)"', "m").exec(toml) || [])[1]);
  assert.deepEqual([num("RECEIPT_PAGES_PER_MIN"), num("RECEIPT_PAGES_PER_DAY"), num("RECEIPT_PAGES_PER_DAY_GROUP"), num("RECEIPT_SINGLE_PER_DAY"), num("RECEIPT_SINGLE_PER_DAY_GROUP"), num("RECEIPT_GROUP_PROBE")], [6, 40, 400, 300, 3000, 25]);
});

test("payscout.dev is never limited; BULK_LIMITS=off and a dead counter fail open", async () => {
  const env = { QUOTA: quotaNs() }; const go = mk(env);
  for (let i = 0; i < 12; i++) assert.equal((await go("https://api.payscout.dev/v1/receipts?page=" + i)).status, 200);
  const off = mk({ QUOTA: quotaNs(), BULK_LIMITS: "0" }, "198.51.100.40"); // flag off = the 0.62.0 guard: no page or daily caps
  for (let i = 0; i < 12; i++) assert.equal((await off("https://402xagent.com/v1/receipts?page=" + i)).status, 200);
  const dead = mk({ QUOTA: quotaNs({ broken: true }) }, "198.51.100.41");
  for (let i = 0; i < 12; i++) assert.equal((await dead("https://402xagent.com/v1/receipts?page=" + i)).status, 200);
  assert.equal((await mk({}, "198.51.100.42")("https://402xagent.com/v1/receipts?page=1")).status, 200, "no binding");
});

test("end to end through the Worker: list pages 429 with the offer, a single receipt id still answers, the scope is written to analytics", async () => {
  const points = []; const ns = quotaNs();
  const env = { BULK_LIMITS: "1", QUOTA: ns, CLIENT_SALT: "s", LOOKUPS: { writeDataPoint: (d) => points.push(d) }, RECEIPT_PAGES_PER_DAY: "2" }; // the day cap makes the 3rd page a 429 even if the wall clock crosses a minute
  const pending = []; const ctx = { waitUntil: (p) => void pending.push(p) };
  const call = (u) => worker.fetch(new Request(u, { headers: { "cf-connecting-ip": "198.51.100.50", "user-agent": "bulkbot/1", accept: "application/json" } }), env, ctx);
  assert.equal((await call("https://402xagent.com/v1/receipts?page=1")).status, 200);
  assert.equal((await call("https://402xagent.com/v1/receipts?page=2")).status, 200);
  const r = await call("https://402xagent.com/v1/receipts?page=3");
  assert.equal(r.status, 429); assert.equal((await r.json()).bulk_access.url, "https://402xagent.com/pricing#bulk-access");
  const single = await call("https://402xagent.com/v1/receipts/0123456789");
  assert.notEqual(single.status, 429, "a single receipt id is not limited by paging");
  await worker.fetch(new Request("https://402xagent.com/v1/receipts/0123456789", { headers: { "cf-connecting-ip": "198.51.100.51", "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.1)" } }), env, ctx);
  await Promise.all(pending);
  const gv = points.filter((p) => p.blobs[12] === "view-receipts").pop();
  assert.equal(gv.blobs[6], "gptbot", "bot token recorded in blob7 on receipt views (not verified: no cf signal)");
  const rl = points.filter((p) => p.blobs[12] === "view-receipts" && p.doubles[2] === 429);
  assert.equal(rl.length, 1); assert.equal(rl[0].blobs[16], "pages_day");
});

test("/pricing says bulk access is not live and the page anchor exists", () => {
  const html = pricingHtml("https://402xagent.com", { bulkAccess: true, freePerDay: 5, freePerIpDay: 25, paidAtomic: "20000", erAtomic: "50000", endpointReport: true, watchtower: true, apiOrigin: "https://api.402xagent.com", lookupFreePerDay: 5, lookupAtomic: "20000", watchAtomic: "1000000", hostedFreeTotal: 1000 });
  assert.match(html, /id="bulk-access"/); assert.match(html, /Bulk access \(not live\)/); assert.match(html, /not live yet; nothing is on sale today/);
});

test("flag off (default): the guard is the 0.62.0 one: no page cap, no pricing note, no OpenAPI 429", async () => {
  const base = { freePerDay: 5, freePerIpDay: 25, paidAtomic: "20000", erAtomic: "50000", endpointReport: true, watchtower: true, apiOrigin: "https://api.402xagent.com", lookupFreePerDay: 5, lookupAtomic: "20000", watchAtomic: "1000000", hostedFreeTotal: 1000 };
  assert.ok(!pricingHtml("https://402xagent.com", base).includes("bulk-access"));
  const { openapi } = await import("../worker/src/lib.js");
  assert.equal(openapi("https://402xagent.com", {}).paths["/v1/receipts"].get.responses[429], undefined);
  assert.ok(openapi("https://402xagent.com", { BULK_LIMITS: "1" }).paths["/v1/receipts"].get.responses[429]);
  const env = { QUOTA: quotaNs() }; const req = (i) => { const url = new URL("https://402xagent.com/v1/receipts?page=" + i); return receiptGuard(new Request(url, { headers: { "cf-connecting-ip": "198.51.100.61" } }), env, null, url, url.pathname, ok, { now: NOW, cache: null }); };
  for (let i = 0; i < 20; i++) assert.equal((await req(i)).status, 200);
});

test("flag off/unset: the 120/min cap returns the exact 0.62.0 429 JSON body and headers", async () => {
  const now = NOW; // 18:00:30Z, so retry-after is 30
  const ra = String(60 - now.getUTCSeconds());
  const expectedBody = JSON.stringify({ error: "rate limited", code: "rate_limited", limit: `${RECEIPT_RATE_PER_MIN} receipt reads per minute per client (cached receipts excluded)`, retry_after_seconds: Number(ra) });
  const expectedHeaders = new Headers({ "content-type": "application/json; charset=utf-8", "retry-after": ra, "cache-control": "no-store", "access-control-allow-origin": "*" });
  const dump = (h) => [...h.entries()].map(([k, v]) => k + ": " + v).join("\n");
  for (const flag of [undefined, "0", "", "off"]) {
    const env = { QUOTA: quotaNs() };
    if (flag !== undefined) env.BULK_LIMITS = flag;
    const go = async () => {
      const url = new URL(SINGLE);
      const req = new Request(url, { headers: { "cf-connecting-ip": "198.51.100.77", "user-agent": "curl/8" } });
      return receiptGuard(req, env, null, url, url.pathname, ok, { now, cache: null });
    };
    for (let i = 0; i < RECEIPT_RATE_PER_MIN; i++) assert.equal((await go()).status, 200, "under the limit " + i + " flag=" + flag);
    const over = await go();
    assert.equal(over.status, 429, "flag=" + flag);
    const body = await over.text();
    assert.equal(body, expectedBody, "body must match 0.62.0 byte-for-byte; flag=" + flag);
    assert.equal(over.headers.get("x-receipt-limit"), null, "no x-receipt-limit when flag off");
    assert.equal(over.headers.get("link"), null, "no Link header when flag off");
    // Drop any runtime-added length header so the comparison is the 0.62.0 header set.
    const got = new Headers(over.headers);
    got.delete("content-length");
    assert.equal(dump(got), dump(expectedHeaders), "headers must match 0.62.0; flag=" + flag);
    assert.ok(!/"scope"|"free_still_works"|"bulk_access"|pricing#bulk-access/.test(body), "no new 429 fields when flag off");
  }
});

