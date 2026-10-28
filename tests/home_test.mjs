// 0.58.0: the human landing page (worker/src/home.js) and /home.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../worker/src/index.js";
import { homeHtml, homeStats, homeVerdicts, plainReason, HOME_JS, HOME_CSP, HOME_REF, HOME_EXAMPLES } from "../worker/src/home.js";
import { DOCS_TRYIT_JS, DOCS_CSP, DOCS_TRYIT_REF } from "../worker/src/tryit.js";
import { RECEIPTS, RECEIPTS_META } from "../worker/src/receipts-data.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const NOW = Date.parse(RECEIPTS_META.crawled_at) + 86400000;
const get = (p, accept = "text/html,application/xhtml+xml,*/*;q=0.8", host = "https://402xagent.com") => worker.fetch(new Request(host + p, { headers: { accept, "user-agent": "Mozilla/5.0" } }), { CLIENT_SALT: "t", ENDPOINT_REPORT: "1", WATCHTOWER: "1" }, { waitUntil() {} });

test("/docs/try-it.js is byte-identical to 0.57.1 after the shared-core refactor", () => {
  assert.equal(sha(DOCS_TRYIT_JS), "d4d58280048134a87325d75f01402b5a11dfe0e7e77ba9bdbfc51869fe0d00f7");
});

test("/home.js: served as JS with nosniff, parses, no innerHTML/eval, same endpoint + ref as /docs, never reads the payment object", async () => {
  const r = await get("/home.js", "*/*");
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/javascript/); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const js = await r.text(); assert.equal(js, HOME_JS);
  new Function(js);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/.test(js));
  assert.ok(js.includes('fetch("/v1/products/endpoint-spot-check?"'));
  assert.equal(HOME_REF, DOCS_TRYIT_REF); assert.ok(js.includes(JSON.stringify(DOCS_TRYIT_REF)));
  assert.ok(!/\bj\.payment\b|\bpm\.|\.pay_to\b|amount\.usd/.test(js), "the home card never shows a price or a payTo");
  for (const piece of ["function validate(", "function termStatus(", "function uiReason(", "function receiptHref(", 'form.addEventListener("submit"']) assert.ok(js.includes(piece) && DOCS_TRYIT_JS.includes(piece), piece);
  assert.ok(js.includes('"ArrowRight"') && js.includes('"Home"') && js.includes('"End"') && js.includes("aria-selected"), "keyboard tabs");
});

test("homepage: browsers on 402xagent.com only, strict CSP, one same-origin script, no badge, real tabs", async () => {
  const r = await get("/");
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/html/);
  assert.equal(r.headers.get("content-security-policy"), DOCS_CSP); assert.equal(HOME_CSP, DOCS_CSP);
  assert.equal(r.headers.get("vary"), "accept");
  const t = await r.text();
  assert.deepEqual([...t.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]), ['<script src="/home.js" defer>']);
  assert.ok(!/ on[a-z]+="/i.test(t), "no inline handlers");
  assert.ok(!/agenteconomy|badge/i.test(t), "no badge");
  assert.ok(!/https?:\/\/(?!402xagent\.com|github\.com\/withgrokbot|www\.npmjs\.com\/package\/x402-spotcheck|api\.402xagent\.com|api\.402rates\.com|api\.automaton-sovereign|example\.com\/paid-endpoint)/.test(t.replace(/xmlns="[^"]+"/g, "")), "only own and named links");
  for (const id of ["tab-products", "tab-verdicts", "tab-dev"]) assert.ok(t.includes(`id="${id}"`));
  assert.match(t, /aria-selected="true" data-panel="products"/); assert.equal((t.match(/role="tabpanel"[^>]* hidden>/g) || []).length, 2);
  for (const tab of ["products", "verdicts", "dev"]) assert.ok(t.includes(`data-tab="${tab}"`), "nav " + tab);
  for (const a of ["/docs#quick-start", "/docs#endpoint-report", "/docs#payment-status", "/docs#watchtower", "/docs#facilitator-check", "/docs#hosted"]) assert.ok(t.includes(`href="${a}"`), a);
  assert.ok(t.includes("const pay = wrapFetchWithPayment(spotCheckFetch(fetch), client);"), "copy one-liner");
  for (const x of HOME_EXAMPLES) assert.ok(t.includes(`data-url="${x.url}"`));
  for (const h of ["https://api.402xagent.com"]) assert.match((await get("/", undefined, h)).headers.get("content-type"), /application\/json/, h);
  assert.match((await get("/", "application/json")).headers.get("content-type"), /application\/json/);
});

test("homepage product cards: real prices and terms from the code, flags respected", () => {
  const t = homeHtml("https://402xagent.com", { now: NOW });
  for (const s of ["$0.02<small>per check", "5 free / day", "$0.05<small>per report", "$0.02<small>per lookup", "$1<small>per 30 days", "7-day trial", "Free<small>rate-limited", "1,000 free<small>then $0.02; $0.01 past 1,000/month"]) assert.ok(t.includes(s), s);
  const off = homeHtml("https://402xagent.com", { now: NOW, endpointReport: false, watchtower: false });
  assert.ok(!off.includes("Endpoint Report") && !off.includes("Watchtower"), "unreleased products are not advertised");
  assert.ok(!/100%|every verdict carr/i.test(t.slice(t.indexOf("<body>"))), "no unverifiable signed-receipt claim");
});

test("proof strip: live crawl numbers, hidden when missing or stale", () => {
  const t = homeHtml("https://402xagent.com", { now: NOW });
  for (const k of ["endpoints_covered", "new_this_week", "recheck", "skip"]) assert.ok(t.includes(`<div class="proof-num">${RECEIPTS_META[k].toLocaleString("en-US")}</div>`), k);
  assert.ok(!homeHtml("https://402xagent.com", { now: NOW, meta: {} }).includes('class="proof"'), "no meta: no strip");
  assert.ok(!homeHtml("https://402xagent.com", { now: NOW + 30 * 86400000 }).includes('class="proof"'), "stale crawl: no strip");
  const part = homeHtml("https://402xagent.com", { now: NOW, meta: { crawled_at: RECEIPTS_META.crawled_at, endpoints_covered: 9 } });
  assert.equal((part.match(/class="proof-item"/g) || []).length, 1, "missing numbers are hidden one by one");
  assert.deepEqual(homeStats({ crawled_at: "nope", endpoints_covered: 5 }, NOW).covered, null);
});

test("latest verdicts: real crawl rows only (host, verdict, plain reason, date), no wallets/amounts, empty feed shows the caption only", () => {
  const rows = homeVerdicts(RECEIPTS, RECEIPTS_META, 6, NOW);
  assert.ok(rows.length > 0 && rows.length <= 6);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r), ["host", "verdict", "reason", "when"]);
    assert.ok(RECEIPTS.some((x) => new URL(x.url).hostname === r.host && x.verdict === r.verdict && plainReason(x.reason) === r.reason), r.host);
    assert.ok(!/0x[0-9a-f]{6}|\$\d|eip155|solana:/i.test(r.reason));
  }
  assert.equal(new Set(rows.map((r) => r.host)).size, rows.length, "one row per host");
  const t = homeHtml("https://402xagent.com", { now: NOW });
  const panel = t.slice(t.indexOf('id="panel-verdicts"'), t.indexOf('id="panel-dev"'));
  assert.ok(!/0x[0-9a-fA-F]{40}/.test(panel) && !/tx_hash|payment_payload|payer/i.test(panel));
  const empty = homeHtml("https://402xagent.com", { now: NOW, receipts: [] });
  const ep = empty.slice(empty.indexOf('id="panel-verdicts"'), empty.indexOf('id="panel-dev"'));
  assert.ok(ep.includes("Live from the public crawl.") && !ep.includes('class="v-row"'));
  assert.equal(plainReason("something new (0xabc)"), null, "unknown reasons are dropped, not shown raw");
});
