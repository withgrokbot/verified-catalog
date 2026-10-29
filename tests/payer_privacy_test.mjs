// 0.59.2 privacy: the buyer wallet (payment_received.payer, access.payer, hosted.payer) never appears on any public receipt
// surface (JSON by id, by-url, list, HTML page, MCP get_receipt); the private D1 row keeps it unchanged; signatures of
// served views verify (new receipts: payer never signed; old rows whose signed_view embedded payer: served re-signed,
// redacted_v2). Real SQLite behind a tiny D1 adapter (LOCAL only). All values synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import { saveLiveReceipt } from "../worker/src/lib.js";
import * as S from "../worker/src/sign.js";
import { verifierCore } from "../worker/src/verify-core.js";

const MIG = join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "migrations");
function d1() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIG).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(join(MIG, f), "utf8"));
  const norm = (a) => a.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x));
  const mk = (sql, args = []) => ({ bind: (...a) => mk(sql, norm(a)), first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }) });
  return { raw: db, prepare: (sql) => mk(sql), batch: async (st) => Promise.all(st.map((x) => x.run())) };
}
const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", privateKey)), kid: "test-payer-key" };
S._addTestKey({ kid: jwk.kid, x: jwk.x }); S._resetSigner();
const V = verifierCore([{ kid: jwk.kid, x: jwk.x }]);
const PAYER = "0x" + "B1c2".repeat(10), PAYER_LC = PAYER.toLowerCase(), TX = "0x" + "c7".repeat(32);
const URL1 = "https://spot.target.fixture/api";
const body = (id) => ({ id, url: URL1, checked_at: "2026-10-29T10:00:00Z", verdict: "pay", reason: "terms match", check_type: "live", access_tier: "paid", method: "GET",
  payment_received: { tier: "paid", payer: PAYER_LC, amount_atomic: "20000", amount_usd: "0.02", network: "eip155:8453", settle_tx: TX, basescan_url: "https://basescan.org/tx/" + TX },
  access: { tier: "paid", payer: PAYER, tx: TX }, hosted: { integrator: "it-1", payer: PAYER } });
const env = (db) => ({ RECEIPTS_DB: db, DATA_BASE_URL: "https://data.fixture/vc/", RECEIPT_SIGNING_KEY: JSON.stringify(jwk), CLIENT_SALT: "s" });
const leaks = (t) => t.includes(PAYER_LC) || t.toLowerCase().includes(PAYER_LC) || t.includes(TX);
async function surfaces(e, id) {
  const go = async (host, p, accept) => (await worker.fetch(new Request(host + p, { headers: accept ? { accept } : {} }), e, { waitUntil() {}, passThroughOnException() {} })).text();
  const mcp = async (args) => (await worker.fetch(new Request("https://api.402xagent.com/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_receipt", arguments: args } }) }), e, { waitUntil() {} })).text();
  return {
    json: await go("https://api.402xagent.com", "/v1/receipts/" + id + "?format=json"),
    html: await go("https://402xagent.com", "/v1/receipts/" + id, "text/html"),
    byurl: await go("https://api.402xagent.com", "/v1/receipts/by-url?url=" + encodeURIComponent(URL1)),
    list: await go("https://api.402xagent.com", "/v1/receipts?type=live"),
    mcp_id: await mcp({ id }), mcp_url: await mcp({ url: URL1 }),
  };
}
test("0.59.2 a new paid receipt: payer on no public surface, kept in private D1, served signature verifies", async () => {
  const db = d1(), e = env(db), id = "sc-00000000000000a1";
  assert.equal(await saveLiveReceipt(e, body(id)), true);
  const stored = JSON.parse(db.raw.prepare("SELECT body FROM spot_receipts WHERE id = ?").get(id).body);
  assert.equal(stored.payment_received.payer, PAYER_LC, "private row keeps the payer");
  assert.equal(stored.access.payer, PAYER);
  assert.ok(stored.signed_view && !leaks(JSON.stringify(stored.signed_view)), "payer is never signed into a new receipt");
  const s = await surfaces(e, id);
  for (const [k, t] of Object.entries(s)) { assert.ok(t.length > 50, k); assert.ok(!leaks(t), k + " leaks the payer"); }
  assert.equal((await V.verifyText(s.json)).status, "valid");
});
test("0.59.2 an old row whose signed_view embedded the payer (0.42.x): served re-signed (redacted_v2), verifies, payer absent; row unchanged", async () => {
  const db = d1(), e = env(db), id = "sc-00000000000000a2";
  const b = body(id); const { access: _a, hosted: _h, ...pub } = b;
  const signedOld = await S.signObject(e, { service: "402xAgent", ...pub }); // the 0.42.x behaviour: payer inside the signed bytes
  const raw = JSON.stringify({ ...b, signed_view: signedOld });
  db.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, body) VALUES (?, ?, ?, 'pay', 'r', 'live', ?)").run(id, URL1, b.checked_at, raw);
  assert.equal((await V.verifyText(JSON.stringify(signedOld))).status, "valid", "the stored original still verifies (private)");
  const s = await surfaces(e, id);
  for (const [k, t] of Object.entries(s)) assert.ok(!leaks(t), k + " leaks the payer");
  const served = JSON.parse(s.json); if (process.env.DBG) console.log("SERVED", JSON.stringify(served).replace(/0x[0-9a-fA-F]{40}/g, "0xADDR"));
  assert.equal(served.redacted_v2, true);
  { const v = await V.verifyText(s.json); assert.equal(v.status, "valid", "the served (redacted, re-signed) view verifies: " + JSON.stringify(v).slice(0, 300)); }
  assert.equal(db.raw.prepare("SELECT body FROM spot_receipts WHERE id = ?").get(id).body, raw, "stored row never rewritten");
});
test("0.59.2 hardening: a receipt carrying only access.payer / hosted.payer (no payment_received) never shows them", async () => {
  const db = d1(), e = env(db), id = "sc-00000000000000a3";
  const { payment_received: _p, ...b } = body(id);
  assert.equal(await saveLiveReceipt(e, b), true);
  const s = await surfaces(e, id);
  for (const [k, t] of Object.entries(s)) assert.ok(!leaks(t), k + " leaks the payer");
  assert.equal((await V.verifyText(s.json)).status, "valid");
  assert.equal(JSON.parse(db.raw.prepare("SELECT body FROM spot_receipts WHERE id = ?").get(id).body).access.payer, PAYER, "private row unchanged");
});
