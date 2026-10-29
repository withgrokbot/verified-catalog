// 0.58.3: /pricing as a pricing table in the homepage look. Every price on the page comes from a code constant.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { pricingHtml, pricingRows, usd } from "../worker/src/pricing.js";
import { HOME_CSP, HOME_CSS } from "../worker/src/home.js";
import { SPOT_PAID_ATOMIC, VERSION } from "../worker/src/lib.js";
import { ER_PAID_ATOMIC } from "../worker/src/report.js";
import { WATCH_PRICE_ATOMIC, WATCH_PERIOD_DAYS, TRIAL_DAYS } from "../worker/src/watch.js";
import { FACIL_CHECK_PER_MIN, FACIL_HOST_PER_MIN } from "../worker/src/facilcheck.js";
import { HOSTED_FREE_TOTAL, HOSTED_VOLUME_AFTER, HOSTED_STANDARD_ATOMIC, HOSTED_VOLUME_ATOMIC } from "../worker/src/hosted.js";

const ENV = { ENDPOINT_REPORT: "1", WATCHTOWER: "1", SPOT_FREE_PER_DAY: "5", SPOT_FREE_PER_IP_DAY: "25", PACK_PRICE_ATOMIC: "9000000" };
const get = async (env = ENV, host = "https://402xagent.com", accept = "text/html,application/xhtml+xml,*/*;q=0.8", path = "/pricing") => {
  const r = await worker.fetch(new Request(host + path, { headers: { accept, "user-agent": "Mozilla/5.0", "cf-connecting-ip": "203.0.113.5" } }), env, { waitUntil() {} });
  return { r, t: await r.text() };
};
const row = (t, id) => { const m = t.match(new RegExp(`<tr id="${id}">([\\s\\S]*?)</tr>`)); return m ? m[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&rarr;/g, "").replace(/\s+/g, " ").trim() : null; };

test("0.58.9 version", () => assert.equal(VERSION, "0.59.0"));

test("0.58.3 /pricing table (0.58.6: + audit layer): the eight rows, every price from its code constant", async () => {
  const { r, t } = await get();
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/html/);
  assert.equal(usd(SPOT_PAID_ATOMIC), "$0.02"); assert.equal(usd(ER_PAID_ATOMIC), "$0.05"); assert.equal(usd(WATCH_PRICE_ATOMIC), "$1");
  assert.equal(usd(HOSTED_STANDARD_ATOMIC), "$0.02"); assert.equal(usd(HOSTED_VOLUME_ATOMIC), "$0.01");
  const ids = [...t.matchAll(/<tr id="([a-z-]+)">/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["free", "check", "endpoint-report", "payment-status", "watchtower", "facilitator-check", "hosted", "audit-layer"]); // 0.58.6: + audit layer
  assert.match(row(t, "audit-layer"), /^Audit layer Free open source \(MIT\) Runs in your agent x402-spotcheck\/audit: a per-call ceiling and a daily budget, a wallet deny list and a hash-chained audit ledger.*Not a paid check/);
  for (const [id, href] of [["check", "/docs/check"], ["endpoint-report", "/docs/endpoint-report"], ["payment-status", "/docs/payment-status"], ["watchtower", "/docs/watchtower"], ["facilitator-check", "/docs/facilitator-check"], ["hosted", "/docs/hosted"], ["audit-layer", "https://www.npmjs.com/package/x402-spotcheck"]])
    assert.ok(t.match(new RegExp(`<tr id="${id}">[\\s\\S]*?</tr>`))[0].includes(`class="pr-link" href="${href}"`), id + " links to its docs page");
  assert.ok(t.includes('<li><a href="/#audit-layer">Audit layer</a></li>'), "footer audit layer");
  assert.match(row(t, "free"), /^Free 5 a day free live checks .*5 live checks per client per UTC day, at most 25 per network/);
  assert.match(row(t, "check"), /^402xAgent Check \$0\.02 per check 5 free a day \$0\.02 per check, flat/);
  assert.match(row(t, "endpoint-report"), /^Endpoint Report \$0\.05 per report No free tier \$0\.05 per report, flat, for everyone/);
  assert.match(row(t, "payment-status"), /^Payment Status \$0\.02 per lookup 5 free a day, shared with the check \$0\.02 per lookup, flat/);
  assert.match(row(t, "watchtower"), new RegExp(`^Watchtower \\$1 per ${WATCH_PERIOD_DAYS} days ${TRIAL_DAYS}-day trial .*first watch per webhook domain`));
  assert.match(row(t, "facilitator-check"), new RegExp(`^Facilitator Check Free rate-limited .*${FACIL_CHECK_PER_MIN} per minute per network \\(IP\\) and ${FACIL_HOST_PER_MIN} per minute per seller host`));
  assert.match(row(t, "hosted"), /^Hosted Mode 1,000 free then \$0\.02; \$0\.01 past 1,000\/month .*by arrangement\. 1,000 free hosted checks per integrator, then \$0\.02 per check; each billable check after the first 1,000 in a UTC calendar month is \$0\.01/);
  assert.equal(HOSTED_FREE_TOTAL, 1000); assert.equal(HOSTED_VOLUME_AFTER, 1000);
  // the exact sentence, and every dollar amount on the page is one of the code prices
  assert.ok(t.includes("All payments are USDC on Base via x402."));
  const amounts = new Set([...t.replace(/<style>[\s\S]*?<\/style>/, "").matchAll(/\$\d+(?:\.\d+)?/g)].map((m) => m[0]));
  assert.deepEqual([...amounts].sort(), ["$0.01", "$0.02", "$0.05", "$1"]);
  // follows the constants, not typed-in copy
  const alt = pricingHtml("https://402xagent.com", { freePerDay: 7, freePerIpDay: 30, paidAtomic: "30000", erAtomic: "60000", watchAtomic: "2000000", watchDays: 30, trialDays: 7, facilPerMin: 60, facilHostPerMin: 30, hostedFree: 1000, hostedVolAfter: 1000, hostedStdAtomic: 20000, hostedVolAtomic: 10000, lookupFreePerDay: 1, lookupAtomic: "10000", apiOrigin: "https://api.402xagent.com", endpointReport: true, watchtower: true });
  assert.match(row(alt, "check"), /^402xAgent Check \$0\.03 per check 7 free a day/); assert.match(row(alt, "watchtower"), /^Watchtower \$2 per 30 days/);
});

test("0.58.3 /pricing: no packs, credits, badges or price changes; flags off hide their rows", async () => {
  const { t } = await get();
  const visible = t.replace(/<style>[\s\S]*?<\/style>/, "");
  assert.doesNotMatch(visible, /router pack|prepaid|credit|badge\/|\.svg"|1,000 free checks|facilitator\/check/i);
  const off = (await get({ ...ENV, ENDPOINT_REPORT: "0", WATCHTOWER: "0" })).t;
  assert.equal(row(off, "endpoint-report"), null); assert.equal(row(off, "watchtower"), null);
  assert.ok(row(off, "check") && row(off, "hosted"));
});

test("0.58.3 /pricing: homepage look, strict CSP with the Cloudflare beacon allowance, no script, readable at 390", async () => {
  for (const host of ["https://402xagent.com", "https://api.402xagent.com", "https://verified-catalog-lookup.withgrokbot.workers.dev"])
    for (const accept of ["text/html", "application/json", "*/*", null]) {
      const r = await worker.fetch(new Request(host + "/pricing", { headers: accept ? { accept } : {} }), ENV, { waitUntil() {} });
      if (host.includes("workers.dev") && accept === "text/html") { assert.equal(r.status, 301); assert.equal(r.headers.get("location"), "https://402xagent.com/pricing"); continue; } // unchanged: browsers on the legacy host go to the canonical page
      assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/html/, "HTML for every Accept, as before");
      assert.equal(r.headers.get("content-security-policy"), HOME_CSP);
      assert.equal(r.headers.get("cache-control"), "public, max-age=300");
    }
  assert.match(HOME_CSP, /script-src 'self' https:\/\/static\.cloudflareinsights\.com;/); assert.match(HOME_CSP, /connect-src 'self' https:\/\/cloudflareinsights\.com;/);
  const { t } = await get();
  assert.ok(t.includes(`<style>${HOME_CSS}`), "the homepage stylesheet");
  assert.doesNotMatch(t, /<script|\son[a-z]+=|javascript:/i);
  assert.match(t, /<header class="top">/); assert.match(t, /<footer>/); assert.match(t, /aria-current="page">Pricing</);
  assert.match(t, /<link rel="canonical" href="https:\/\/402xagent\.com\/pricing">/);
  assert.match(t, /@media\(max-width:760px\)\{[\s\S]*table\.pr tbody tr\{background:#fff/, "stacked cards on small screens");
  assert.match(t, /td\[data-label\]::before\{content:attr\(data-label\)/);
});

test("0.58.3 review: Hosted billing and Watchtower cadence wording on /pricing and the homepage cards; no $9 pack on /pricing", async () => {
  const { t } = await get();
  assert.match(row(t, "hosted"), /usage tracked; billed monthly by arrangement/);
  assert.match(row(t, "watchtower"), /Regular re-probes/);
  const vis = t.replace(/<style>[\s\S]*?<\/style>/, "");
  assert.doesNotMatch(vis, /hourly|invoice|overnight|\$9/i);
  assert.match(vis, /Catalog lookup \(<code>\/v1\/lookup<\/code>\)/);
  const home = await (await worker.fetch(new Request("https://402xagent.com/", { headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } }), ENV, { waitUntil() {} })).text();
  assert.ok(home.includes("usage tracked; billed monthly by arrangement")); assert.ok(home.includes("Regular re-probes of an endpoint"));
  assert.doesNotMatch(home, /monthly USDC invoice|Hourly re-probes/);
  const pack = await worker.fetch(new Request("https://api.402xagent.com/v1/products/overnight-cos-pack", { headers: { accept: "application/json" } }), ENV, { waitUntil() {} });
  assert.ok([200, 402].includes(pack.status), "the pack route stays live");
});
