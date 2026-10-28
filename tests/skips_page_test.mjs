// 0.58.7: the human /v1/skips page (worker/src/skips-html.js). Content checks on the rendered page with a store holding a
// real published page 2 (tests/fixtures/skips_sample_2026-10-28.json); byte identity of the JSON forms is in
// tests/machine_surfaces_test.mjs ("0.58.7 skips page").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { skipsBody } from "./helpers/machine_snapshot.mjs";
import { RECEIPTS, RECEIPTS_META } from "../worker/src/receipts-data.js";
import { homeCrawlDates, plainReason } from "../worker/src/home.js";
import { crawlReasonText } from "../worker/src/receipts-html.js";
import { SKIPS_TITLE, SKIPS_CAPTION, SKIP_MEANS, RECHECK_MEANS, skipRowHtml } from "../worker/src/skips-html.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, "..", "worker", "src", "index.js");
const SAMPLE = JSON.parse(readFileSync(join(HERE, "fixtures", "skips_sample_2026-10-28.json"), "utf8"));
const BROWSER = "text/html,application/xhtml+xml,*/*;q=0.8";
const get = (p, accept = BROWSER, host = "https://402xagent.com") => skipsBody(W, host + p, accept);
const rowIds = (h) => [...h.matchAll(/<tr id="([0-9a-f]{10})">/g)].map((m) => m[1]);
const homeSrc = readFileSync(join(HERE, "..", "worker", "src", "home.js"), "utf8");

test("0.58.7 skips page: title, caption and crawl date line come from the homepage", async () => {
  const { status, headers, body } = await get("/v1/skips");
  assert.equal(status, 200); assert.match(headers["content-type"], /^text\/html/);
  assert.equal(SKIPS_TITLE, "Latest skips");
  assert.equal(SKIPS_CAPTION, "Recent skips from the public crawl. A mismatch often just means the listing is out of date.");
  assert.ok(homeSrc.includes(`<span>${SKIPS_CAPTION}</span>`), "same caption string as the homepage's Latest skips tab");
  assert.ok(homeSrc.includes(">Latest skips</button>"), "same title as the homepage tab");
  assert.ok(body.includes(`<h1>Latest skips</h1>\n<p class="pg-lead">${SKIPS_CAPTION}</p>`));
  assert.ok(body.includes("<title>Latest skips · 402xAgent</title>"));
  const cd = homeCrawlDates(RECEIPTS_META, Date.now());
  assert.ok(cd.text && /^Last crawl [A-Z][a-z]{2} \d{1,2} · next crawl [A-Z][a-z]{2} \d{1,2}$/.test(cd.text), cd.text);
  assert.ok(body.includes(`<p class="sk-dates" id="crawl-dates">${cd.text}</p>`), "derived from crawled_at like the homepage line");
  assert.ok(body.includes(SKIP_MEANS.replace(/'/g, "&#39;")) && body.includes(RECHECK_MEANS.replace(/'/g, "&#39;")));
  // shared chrome: same header nav and footer as /pricing, /docs and the receipt pages; Receipts is the current nav item
  assert.ok(body.includes('<a href="/v1/skips" aria-current="page">Receipts</a>') && body.includes('<div class="footer-grid">') && body.includes('class="skip-link"'));
});

test("0.58.7 skips page: method text kept inside <details>; featured callout gone; no script", async () => {
  const { headers, body } = await get("/v1/skips");
  const d0 = body.indexOf('<details class="sk-method">'), d1 = body.indexOf("</details>", d0);
  assert.ok(d0 > 0 && d1 > d0);
  const det = body.slice(d0, d1);
  for (const s of ["Check your endpoint free first:", "Self-checked: ", "Skip = no paywall (no 402), a malformed 402, price mismatch, wrong or unsupported network, a token other than canonical USDC, or a payTo that differs from the listing.", "Recheck = transient (timeout, network error, 5xx) or a free trial in use.", "Facts only, not endorsements.", "endpoints covered", "new this week", "lists: ", "Never pays the target."])
    assert.ok(det.includes(s), s);
  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  assert.ok(det.includes(`Self-checked: ${esc(RECEIPTS_META.method)} Deduped by ${esc(RECEIPTS_META.dedupe)}.`), "the crawl method text, unchanged");
  assert.doesNotMatch(body, /Featured mismatch|★|class="featured"/);
  assert.doesNotMatch(body, /<script/i, "no script at all");
  assert.match(headers["content-security-policy"], /^default-src 'none'; script-src 'self' https:\/\/static\.cloudflareinsights\.com;/);
  assert.equal(headers["x-content-type-options"], "nosniff");
});

test("0.58.7 skips page: every row has the homepage's plain reason and its receipt link; numbers from the crawl meta", async () => {
  const { body } = await get("/v1/skips");
  const ids = rowIds(body);
  assert.deepEqual(ids, RECEIPTS.map((r) => r.id), "same rows, same order as the JSON page 1");
  for (const r of RECEIPTS) {
    assert.ok(body.includes(`<a class="sk-open" href="/v1/receipts/${r.id}">Receipt &rarr;</a>`), r.id);
    const p = plainReason(r.reason);
    if (p) assert.equal(crawlReasonText(r.reason), p);
  }
  const row = skipRowHtml(RECEIPTS.find((r) => /^asks for payment on a different network/.test(r.reason)));
  assert.match(row, />Payment network differs from the listing</);
  assert.match(skipRowHtml(RECEIPTS.find((r) => /^pays a different wallet/.test(r.reason))), />Payment wallet differs from the listing</);
  assert.match(skipRowHtml(RECEIPTS.find((r) => /^asks a different price/.test(r.reason))), />Payment price differs from the listing</);
  assert.doesNotMatch(body, /pays a different wallet than listed \(|asks a different price than listed \(/, "raw crawl reasons (with wallets) are not shown");
  const n = (x) => x.toLocaleString("en-US");
  for (const [v, l] of [[RECEIPTS_META.endpoints_covered ?? RECEIPTS_META.total, "endpoints covered"], [RECEIPTS_META.skip, "skip"], [RECEIPTS_META.pay, "pay"], [RECEIPTS_META.recheck, "recheck"]])
    assert.ok(body.includes(`<b>${n(v)}</b> ${l}</span>`), l);
});

test("0.58.7 skips page: seller payTo shortened on a secondary line; no buyer data at all", async () => {
  const { body } = await get("/v1/skips");
  const r = RECEIPTS.find((x) => x.pay_to && x.pay_to.startsWith("0x"));
  const row = skipRowHtml(r);
  assert.ok(row.includes(`<span class="sk-payto" title="payTo ${r.pay_to}">payTo ${r.pay_to.slice(0, 6)}…${r.pay_to.slice(-4)}</span>`));
  // recent_checks (outside callers' checks) are JSON-only: none of their URLs or receipt ids, no caller field
  for (const c of SAMPLE.recent) { assert.ok(!body.includes(c.id), c.id); }
  assert.doesNotMatch(body, /caller|outside check|recent_checks|203\.0\.113\.9|payment_received|approved_payment|tx_hash|0x[0-9a-fA-F]{64}/);
  // only the allow-listed row fields: no listed_pay_to column, no http_status, no check_type
  assert.doesNotMatch(body, /listed_pay_to|http_status|check_type/);
});

test("0.58.7 skips page: paging as before (?page=N, clamped), page 2 from the store, JSON negotiation unchanged", async () => {
  const p2 = (await get("/v1/skips?page=2")).body;
  assert.deepEqual(rowIds(p2), SAMPLE.s2.map((r) => r.id));
  const pages = RECEIPTS_META.skip_pages;
  assert.ok(p2.includes(`<a href="/v1/skips?page=1" rel="prev">&larr; prev</a>`) && p2.includes(`<a href="/v1/skips?page=3" rel="next">next &rarr;</a>`));
  assert.ok(p2.includes(`Page 2 of ${pages} (${RECEIPTS_META.page_size} skips per page, clearest mismatches first)`));
  assert.ok(p2.includes('<link rel="canonical" href="https://402xagent.com/v1/skips?page=2">'));
  const p1 = (await get("/v1/skips")).body;
  assert.ok(!p1.includes('rel="prev"') && p1.includes('<a href="/v1/skips?page=2" rel="next">'));
  const last = (await get("/v1/skips?page=999")).body;
  assert.ok(last.includes(`Page ${pages} of ${pages}`) && !last.includes('rel="next"') && last.includes("No skips on this page."));
  assert.ok((await get("/v1/skips?page=abc")).body.includes(`Page 1 of ${pages}`));
  for (const [p, a] of [["/v1/skips?format=json", BROWSER], ["/v1/skips.json", BROWSER], ["/v1/skips", "application/json"], ["/v1/skips", "*/*"], ["/v1/skips", null], ["/v1/skips?page=2&format=json", "text/html"]]) {
    const r = await get(p, a);
    assert.match(r.headers["content-type"], /^application\/json/, p + " " + a);
    const j = JSON.parse(r.body); assert.ok(Array.isArray(j.skips) && Array.isArray(j.recent_checks) && j.featured_mismatch, p);
  }
  assert.match((await get("/v1/skips", "text/html")).headers["content-type"], /^text\/html/);
});

test("0.58.7 skips page: phone layout is cards (table rows become blocks), no fixed widths wider than a phone", async () => {
  const { body } = await get("/v1/skips");
  const css = body.slice(body.indexOf("<style>"), body.indexOf("</style>"));
  assert.match(css, /@media\(max-width:760px\)\{[^]*table\.sk,table\.sk tbody,table\.sk tr,table\.sk td\{display:block;width:100%\}/);
  assert.match(css, /\.sk-payto\{[^}]*text-overflow:ellipsis/);
  assert.match(body, /<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">/);
});
