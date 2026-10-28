// 0.58.5: receipts for browsers. Negotiation (JSON for every non-browser Accept, HTML only when Accept names text/html),
// shown fields (allow-list from the public JSON only; nothing buyer-side even if a stored row carries it), and the signing
// wording (signed live checks: signature block + Verify offline; unsigned sc-: says so; crawl: plainly unsigned, no block).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeReceiptsD1 } from "./helpers/machine_snapshot.mjs";

const worker = (await import("../worker/src/index.js")).default;
const SAMPLE = JSON.parse(readFileSync(new URL("./fixtures/receipts_sample_2026-10-28.json", import.meta.url), "utf8")).rows;
const HTML = { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "Mozilla/5.0" };
const ACCEPTS = [{}, { accept: "application/json" }, { accept: "*/*" }, { accept: "text/plain" }, { accept: "*/*", "user-agent": "curl/8.5.0" }];
const envWith = (rows = SAMPLE) => ({ CLIENT_SALT: "t", ENDPOINT_REPORT: "1", WATCHTOWER: "1", RECEIPTS_DB: fakeReceiptsD1(rows) });
const get = async (path, headers = {}, env = envWith(), host = "https://402xagent.com") => {
  const r = await worker.fetch(new Request(host + path, { headers: { "cf-connecting-ip": "203.0.113.9", ...headers } }), env, { waitUntil() {}, passThroughOnException() {} });
  return { status: r.status, headers: r.headers, text: await r.text() };
};

test("0.58.5 negotiation: non-browser clients get the same JSON as before; browsers get HTML; ?format=json forces JSON", async () => {
  for (const p of ["/v1/receipts", "/v1/receipts/44e3732d23", "/v1/receipts/sc-85c8963fb57e7b25", "/v1/receipts?type=live", "/v1/receipts/sc-ffffffffffffffff"]) {
    const base = await get(p, {});
    assert.match(base.headers.get("content-type"), /application\/json/, p);
    for (const h of ACCEPTS) { const r = await get(p, h); assert.equal(r.text, base.text, p + JSON.stringify(h)); assert.equal(r.status, base.status); }
    const h = await get(p, HTML);
    assert.match(h.headers.get("content-type"), /^text\/html/, p);
    assert.equal(h.headers.get("vary"), "accept");
    assert.match(h.headers.get("content-security-policy"), /^default-src 'none'; script-src 'self' https:\/\/static\.cloudflareinsights\.com;/);
    assert.equal(h.headers.get("x-content-type-options"), "nosniff");
    assert.doesNotMatch(h.text, /<script/i, p);
    const j = await get(p + (p.includes("?") ? "&" : "?") + "format=json", HTML);
    assert.match(j.headers.get("content-type"), /application\/json/, p);
  }
  assert.equal((await get("/v1/receipts/sc-ffffffffffffffff", HTML)).status, 404);
  for (const p of ["/v1/receipts/by-url?url=https://api.402rates.com/v1/ping", "/v1/receipts/ps-0123456789abcdef"]) assert.match((await get(p, HTML)).headers.get("content-type"), /application\/json/, p);
  assert.equal((await get("/v1/receipts", HTML, envWith(), "https://verified-catalog-lookup.withgrokbot.workers.dev")).status, 301);
  assert.match((await get("/v1/receipts/44e3732d23", HTML, envWith(), "https://api.402xagent.com")).headers.get("content-type"), /^text\/html/);
});

test("0.58.5 signed live-check receipt: verdict, compared terms, signature block with Verify offline; no hidden fields", async () => {
  const row = SAMPLE.find((r) => r.id === "sc-85c8963fb57e7b25"), b = JSON.parse(row.body);
  const { text } = await get("/v1/receipts/sc-85c8963fb57e7b25", HTML);
  assert.match(text, /<span class="verdict pay"><i><\/i>pay<\/span>/);
  assert.match(text, /What was compared/); assert.match(text, /<th scope="row">Pay to<\/th>/); assert.match(text, /seller&rsquo;s wallet/);
  assert.ok(text.includes(b.kid) && text.includes(b.signature), "kid + signature shown");
  assert.match(text, /href="\/docs#receipt-signatures">Verify offline/);
  assert.ok(text.includes("sc-85c8963fb57e7b25") && text.includes("2026-10-20 17:52 UTC"));
  // public-JSON fields that are never rendered
  for (const v of [b.norm_key, b.approved_payment.deadline, JSON.parse(SAMPLE.find((r) => r.id === "sc-9841a8498462c4b0").body).receipt_v2.request_sha256, '"maxTimeoutSeconds"', "[![402xAgent status]", "redacted_v2", "payment_received"]) assert.ok(!text.includes(v), "not shown: " + v);
  assert.doesNotMatch(text, /Spot[- ]Check/, "product name is 402xAgent Check");
  const f = JSON.parse(SAMPLE.find((r) => r.id === "sc-9841a8498462c4b0").body), ft = (await get("/v1/receipts/sc-9841a8498462c4b0", HTML)).text;
  for (const v of [f.receipt_v2.request_sha256, f.receipt_v2.supersedes, f.receipt_v2.source_vintage.crawl_id]) assert.ok(!ft.includes(v), "not shown: " + v);
  assert.match(ft, /Free check: the live 402 terms are in the paid check/); assert.match(ft, /Verify offline/);
});

test("0.58.5 buyer data never reaches the HTML, even if a stored row holds it", async () => {
  const b = JSON.parse(SAMPLE[0].body);
  const MARK = { payer: "0xBUYERWALLET00000000000000000000000000001", settle_tx: "0xSETTLETX0000000000000000000000000000000000000000000000000000002", ip: "198.51.100.77", proof: "PAYLOADPROOF-3f9a" };
  const evil = { ...b, id: "sc-00000000000000aa", signature: undefined, kid: undefined, client: "buyer-client-tag-77", client_ip: MARK.ip, cf_connecting_ip: MARK.ip, payer: MARK.payer, payment_payload: MARK.proof, payment_signature: MARK.proof,
    payment_received: { ...b.payment_received, payer: MARK.payer, settle_tx: MARK.settle_tx, basescan_url: "https://basescan.org/tx/" + MARK.settle_tx }, tx: { hash: MARK.settle_tx, submitter: MARK.payer }, query: { from: MARK.payer, tx_hash: MARK.settle_tx },
    reason_text: "payment request matches the listed price", ref: "buyer-ref-tag-88", caller: "buyer-ref-tag-88" };
  const rows = [{ id: evil.id, url: evil.url, created_at: "2026-10-28T10:00:00Z", check_type: "dry-run", ref: "x", body: JSON.stringify(evil) }];
  for (const p of ["/v1/receipts/" + evil.id, "/v1/receipts?type=dry-run", "/v1/receipts?type=dry-run&q=402rates", "/v1/receipts?q=" + encodeURIComponent(evil.url)]) {
    const { text, status } = await get(p, HTML, envWith(rows));
    assert.equal(status, 200, p);
    for (const v of [...Object.values(MARK), MARK.payer.toLowerCase(), "buyer-client-tag-77", "buyer-ref-tag-88", "basescan"]) assert.ok(!text.includes(v), p + " leaks " + v);
  }
  const { text } = await get("/v1/receipts/" + evil.id, HTML, envWith(rows));
  assert.match(text, /<h2>Unsigned<\/h2>/); assert.doesNotMatch(text, /Verify offline/);
});

test("0.58.5 crawl receipt: plainly unsigned, no signature block, no Verify offline; compared terms from the public JSON", async () => {
  const { text, status } = await get("/v1/receipts/44e3732d23", HTML);
  assert.equal(status, 200);
  assert.match(text, /Unsigned crawl receipt/); assert.match(text, /Crawl receipts are not signed/);
  assert.doesNotMatch(text, /Verify offline|id="signature"|Key id/);
  assert.match(text, /<span class="verdict skip"><i><\/i>skip<\/span>/);
  assert.match(text, /Payment network differs from the listing/);
  assert.match(text, /eip155:84532/); assert.match(text, /class="rc-diff">eip155:8453</);
  const red = await get("/v1/receipts/44e3732d23?view=redacted", HTML);
  assert.ok(!red.text.includes("0x2D6F7D1e969a3C6218599B348EbBBDdc7f583948"), "?view=redacted keeps the wallets out of the page too");
});

test("0.58.5 receipts list: tabs, verdict chips, searchable, paginated, links to each receipt", async () => {
  const { text } = await get("/v1/receipts", HTML);
  assert.match(text, /<nav class="rc-tabs"/); assert.match(text, /aria-current="page">Crawl skips/);
  assert.equal((text.match(/<tr><td data-label="Verdict">/g) || []).length, 50);
  assert.match(text, /href="\/v1\/receipts\/[0-9a-f]{10}">Receipt/);
  assert.match(text, /<form class="rc-search" method="get" action="\/v1\/receipts" role="search">/);
  assert.match(text, /rel="next"/); assert.match(text, /Page 1 of \d+/);
  const live = await get("/v1/receipts?type=live", HTML);
  assert.equal((live.text.match(/<tr><td data-label="Verdict">/g) || []).length, SAMPLE.filter((r) => r.check_type === "live").length);
  assert.match(live.text, /href="\/v1\/receipts\/sc-[0-9a-f]{16}">Receipt/);
  const s = await get("/v1/receipts?q=" + encodeURIComponent("https://api.402rates.com/v1/ping"), HTML);
  assert.match(s.text, /sc-85c8963fb57e7b25/);
  const x = await get("/v1/receipts?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E", HTML);
  assert.doesNotMatch(x.text, /<script>alert/); assert.match(x.text, /&lt;script&gt;alert/);
  assert.match(text, /@media\(max-width:760px\)\{\n\.rc-box/);
  assert.doesNotMatch(text, /Spot[- ]Check/);
});
