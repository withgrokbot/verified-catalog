// pdf-tables draft: off by default, fails closed without APIFY_TOKEN, page counting + quote math, 402 quote -> paid run
// -> settle only when every page succeeds. No network: DoH, the PDF host, the Apify Actor and the facilitator are stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePdfTables, countPdfPages, parsePages, quote, pdfCfg, pagesMatch, PDF_PATH } from "../worker/src/pdftables.js";
import { readFileSync } from "node:fs";
const FIX = (f) => new Uint8Array(readFileSync(new URL("./fixtures/pdf/" + f, import.meta.url)));
import { QuotaCounter } from "../worker/src/lib.js";
import { sqliteD1 as d1 } from "./helpers/sqlite_d1.mjs";

const PAY_TO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";
const API = "https://api.402xagent.com";
const pdf = (n) => "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count " + n + " >> endobj\n" + Array.from({ length: n }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`).join("") + "%%EOF";
const FILES = { "https://docs.fixture/us017.pdf": FIX("us017-objstm.pdf"), "https://docs.fixture/three.pdf": pdf(3), "https://docs.fixture/big.pdf": pdf(40), "https://docs.fixture/page.html": "<html>hi</html>" };
let settles = 0, actorCalls = [], actorMode = "ok"; const used = new Set();
globalThis.fetch = async (u, init = {}) => {
  const s = String(u && u.url ? u.url : u);
  if (s.startsWith("https://cloudflare-dns.com/dns-query")) { const type = new URL(s).searchParams.get("type"); return Response.json({ Answer: type === "A" ? [{ type: 1, data: "93.184.216.34" }] : [] }); }
  if (s.includes("facilitator")) {
    const b = JSON.parse(init.body || "{}"); const n = b.paymentPayload.payload.authorization.nonce;
    if (s.endsWith("/verify")) return Response.json(used.has(n) ? { isValid: false, invalidReason: "nonce_already_used" } : { isValid: true, payer: "0xb1" });
    used.add(n); settles++; return Response.json({ success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer: "0xb1" });
  }
  if (s.startsWith("https://api.apify.com/")) {
    assert.equal(init.headers.authorization, "Bearer test-token");
    const inp = JSON.parse(init.body); actorCalls.push(inp);
    const pages = inp.pageRange.split(",").map(Number);
    if (actorMode === "wrongpages") pages[pages.length - 1] += 1; // same row count, wrong page set
    if (actorMode === "dupe") pages[pages.length - 1] = pages[0];
    return Response.json(pages.map((p, i) => ({ source: inp.pdfUrls[0], page: p, status: actorMode === "partial" && i === 1 ? "failed" : "success", reason: actorMode === "partial" && i === 1 ? "page_error" : null, mode: "digital", tableCount: 1, tables: [{ index: 0, method: "lattice", rows: [["a", "b"], ["1", "2"]], csv: "a,b\n1,2\n", json: [{ a: "1", b: "2" }], markdown: "| a | b |" }], text: "a b 1 2" })));
  }
  if (FILES[s] !== undefined) return new Response(FILES[s], { status: 200, headers: { "content-type": s.endsWith(".pdf") ? "application/pdf" : "text/html" } });
  return new Response("nope", { status: 404 });
};
function quotaNs() {
  const objs = new Map();
  return { idFromName: (n) => n, get: (id) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, new QuotaCounter({ storage: { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) } }, {})); } const o = objs.get(id); return { fetch: (u) => o.fetch(new Request(u)) }; } };
}
const env = (x = {}) => ({ PDF_TABLES: "1", APIFY_TOKEN: "test-token", PAY_TO, FACILITATOR_URL: "https://facilitator.fixture", CLIENT_SALT: "t", QUOTA: quotaNs(), RECEIPTS_DB: d1(), ...x });
const call = (e, target, q = {}, headers = {}) => { const url = new URL(API + PDF_PATH + "?" + new URLSearchParams({ url: target, ...q })); return handlePdfTables(new Request(url, { headers: { "cf-connecting-ip": "198.51.100.7", ...headers } }), e, {}, url); };
const pay = (n, amount) => btoa(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", amount, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO },
  payload: { signature: "0xsig", authorization: { from: "0x00000000000000000000000000000000000000b1", to: PAY_TO, value: amount, nonce: "0x" + n.repeat(32), validBefore: "9999999999" } } }));

test("off by default: 404 without PDF_TABLES=1", async () => { const r = await call(env({ PDF_TABLES: undefined }), "https://docs.fixture/three.pdf"); assert.equal(r.status, 404); });
test("fails closed without APIFY_TOKEN: 503, nothing quoted, Actor never called", async () => {
  actorCalls = []; const r = await call(env({ APIFY_TOKEN: "" }), "https://docs.fixture/three.pdf");
  assert.equal(r.status, 503); const b = await r.json(); assert.equal(b.charged, false); assert.equal(b.reason, "extractor_not_configured"); assert.equal(actorCalls.length, 0);
});
test("countPdfPages: plain, synthetic, and real compressed object-stream PDFs", async () => {
  assert.equal(await countPdfPages(pdf(3)), 3); assert.equal(await countPdfPages(pdf(40)), 40); assert.equal(await countPdfPages("<html>"), null);
  assert.equal(await countPdfPages("%PDF-1.7\n<< /Type /Page >> << /Type /Page >>"), 2);
  assert.equal(await countPdfPages(FIX("foo-plain.pdf")), 1);
  // page tree only inside /Type /ObjStm FlateDecode streams (no /Count or /Type /Page in the clear)
  for (const [f, n] of [["us017-objstm.pdf", 4], ["foo-objstm.pdf", 1], ["eu002-objstm.pdf", 2]]) {
    const b = FIX(f); assert.ok(!/\/Count/.test(Buffer.from(b).toString("latin1")), f + " must hide its page tree");
    assert.equal(await countPdfPages(b), n, f);
  }
});
test("parsePages / quote", () => {
  assert.deepEqual(parsePages("1-2,2,9", 3), [1, 2]); assert.deepEqual(parsePages("", 2), [1, 2]); assert.equal(parsePages("x", 2), null); assert.deepEqual(parsePages("2-", 4), [2, 3, 4]);
  const c = pdfCfg(env()); assert.equal(quote(c, 3, "never").amountAtomic, "15000"); assert.equal(quote(c, 3, "auto").amountAtomic, "45000");
});
test("402 quotes pages x price; bad inputs are never charged", async () => {
  const r = await call(env(), "https://docs.fixture/three.pdf", { pages: "1-2" });
  assert.equal(r.status, 402); const b = await r.json();
  assert.equal(b.quoted_pages, 2); assert.equal(b.accepts[0].amount, "10000"); assert.equal(b.price_usd, "0.01");
  assert.equal((await call(env(), "https://docs.fixture/page.html")).status, 422);
  assert.equal((await call(env(), "https://docs.fixture/big.pdf")).status, 413);
  assert.equal((await call(env(), "https://docs.fixture/three.pdf", { ocr: "always" })).status, 400);
  assert.equal((await call(env(), "http://127.0.0.1/x.pdf")).status, 400);
});
test("wrong amount is rejected before the Actor runs", async () => {
  actorCalls = []; const r = await call(env(), "https://docs.fixture/three.pdf", {}, { "payment-signature": pay("a1", "5000") });
  assert.equal(r.status, 402); assert.match((await r.json()).error, /amount/); assert.equal(actorCalls.length, 0);
});
test("paid: Actor runs, settles once, returns tables", async () => {
  actorMode = "ok"; settles = 0; actorCalls = [];
  const r = await call(env(), "https://docs.fixture/three.pdf", { ocr: "auto" }, { "payment-signature": pay("b2", "45000") });
  assert.equal(r.status, 200); const b = await r.json();
  assert.equal(settles, 1); assert.equal(b.pages.length, 3); assert.equal(b.access.charged_usd, "0.045"); assert.equal(b.pages[0].tables[0].csv, "a,b\n1,2\n");
  assert.equal(actorCalls[0].pageRange, "1,2,3"); assert.equal(actorCalls[0].ocr, "auto"); assert.ok(r.headers.get("payment-response"));
});
test("partial failure: 422, nothing settled", async () => {
  actorMode = "partial"; settles = 0;
  const r = await call(env(), "https://docs.fixture/three.pdf", {}, { "payment-signature": pay("c3", "15000") });
  assert.equal(r.status, 422); assert.equal((await r.json()).charged, false); assert.equal(settles, 0); actorMode = "ok";
});

test("compressed PDF end to end: quote counts the object-stream page tree", async () => {
  const r = await call(env(), "https://docs.fixture/us017.pdf");
  assert.equal(r.status, 402); assert.equal((await r.json()).quoted_pages, 4);
});
test("pagesMatch: exact page set only", () => {
  const ok = (p) => ({ page: p, status: "success" });
  assert.ok(pagesMatch([1, 2, 3], [ok(3), ok(1), ok(2)]));
  assert.ok(!pagesMatch([1, 2, 3], [ok(1), ok(2), ok(4)])); assert.ok(!pagesMatch([1, 2, 3], [ok(1), ok(1), ok(2)]));
  assert.ok(!pagesMatch([1, 2], [ok(1)])); assert.ok(!pagesMatch([1], [{ page: 1, status: "failed" }]));
});
test("wrong page set or duplicate pages with the right row count: 422, nothing settled", async () => {
  for (const [mode, n] of [["wrongpages", "d4"], ["dupe", "e5"]]) {
    actorMode = mode; settles = 0;
    const r = await call(env(), "https://docs.fixture/three.pdf", {}, { "payment-signature": pay(n, "15000") });
    assert.equal(r.status, 422, mode); assert.equal((await r.json()).charged, false); assert.equal(settles, 0);
  }
  actorMode = "ok";
});
test("replayed payment signature returns the cached result without re-running the Actor; other request is refused", async () => {
  actorMode = "ok"; settles = 0; actorCalls = [];
  const e = env(); const sig = pay("f6", "15000");
  const r1 = await call(e, "https://docs.fixture/three.pdf", {}, { "payment-signature": sig });
  assert.equal(r1.status, 200); const b1 = await r1.json();
  const r2 = await call(e, "https://docs.fixture/three.pdf", {}, { "payment-signature": sig });
  assert.equal(r2.status, 200); const b2 = await r2.json();
  assert.equal(actorCalls.length, 1); assert.equal(settles, 1); assert.equal(b2.access.cached, true); assert.deepEqual(b2.pages, b1.pages);
  const r3 = await call(e, "https://docs.fixture/three.pdf", { pages: "1" }, { "payment-signature": pay("f6", "5000") });
  assert.equal(r3.status, 409); assert.equal(actorCalls.length, 1);
  const row = await e.RECEIPTS_DB.prepare("SELECT expires_at - created_at AS ttl, body FROM pdf_results").first();
  assert.equal(row.ttl, 86400); assert.ok(!/0xb1|payment-signature/i.test(row.body));
});
