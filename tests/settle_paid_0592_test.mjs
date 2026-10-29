// 0.59.2 regression tests ported from the statechart replay (bugs 2 + 3): a settle whose answer is lost, or a Worker crash
// after settle, must end in a paid answer (or an honest 503 pending), never a 402 for a charged payment; a receipt that
// could not be stored is never linked. Real SQLite (node:sqlite) runs every migration behind a tiny D1 adapter (LOCAL
// only); the facilitator and the chain RPC are stubbed. No network, no secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { verifyAndSettle, cfg, settlementKey } from "../worker/src/lib.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGDIR = join(ROOT, "worker", "migrations");
export function d1() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGDIR).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(join(MIGDIR, f), "utf8"));
  const norm = (a) => a.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x));
  const mk = (sql, args = []) => ({ bind: (...a) => mk(sql, norm(a)), first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }) });
  return { raw: db, prepare: (sql) => mk(sql) };
}
const PAY_TO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", PAYAI = "https://facilitator.payai.network";
const SPOT = new URL("https://api.402xagent.com/v1/products/endpoint-spot-check");
const TX = "0x" + "ab".repeat(32);
const payload = (n) => ({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO },
  payload: { signature: "0xsig", authorization: { from: "0x00000000000000000000000000000000000000b1", to: PAY_TO, value: "20000", nonce: "0x" + n.repeat(32) } } });
// facilitator + chain stub: `used` is the on-chain nonce set (shared truth); chain = "up" | "down" (RPC unreachable)
function world({ loseSettleAnswer = false, chain = "up" } = {}) {
  const w = { used: new Set(), loseSettleAnswer, chain, settles: 0 };
  globalThis.fetch = async (u, init = {}) => {
    const b = JSON.parse(init.body || "{}");
    if (b.jsonrpc) { // read-only RPC: eth_getBlockByNumber, eth_call authorizationState, eth_getLogs, receipt
      if (w.chain !== "up") throw new Error("rpc down");
      const r = (result) => Response.json({ jsonrpc: "2.0", id: 1, result });
      if (b.method === "eth_getBlockByNumber") return r({ number: "0x1000", timestamp: "0x6700000" });
      if (b.method === "eth_call") return r(w.used.has("0x" + b.params[0].data.slice(-64)) ? "0x" + "0".repeat(63) + "1" : "0x" + "0".repeat(64));
      if (b.method === "eth_getLogs") { const n = b.params[0].topics[2]; return r(w.used.has(n) ? [{ topics: ["0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5", b.params[0].topics[1], n], transactionHash: TX, blockNumber: "0xff0" }] : []); }
      if (b.method === "eth_getTransactionReceipt") return r(null);
      return r(null);
    }
    const n = b.paymentPayload.payload.authorization.nonce;
    if (String(u).endsWith("/verify")) return Response.json(w.used.has(n) ? { isValid: false, invalidReason: "nonce_already_used" } : { isValid: true, payer: "0xb1" });
    if (w.used.has(n)) return Response.json({ success: false, errorReason: "nonce_already_used" });
    w.used.add(n); w.settles++;
    if (w.loseSettleAnswer) throw new Error("timeout after settle");
    return Response.json({ success: true, transaction: TX, network: "eip155:8453", payer: "0xb1" });
  };
  return w;
}
const mkc = (db) => cfg({ PAY_TO, FACILITATOR_URL: PAYAI, RECEIPTS_DB: db, PAYSTATUS_PUBLIC_RPC: "https://rpc-a.fixture", RPC2_BASE_URL: "off" });

test("0.59.2 replay A: settle lands on chain but its answer is lost -> the same request finishes paid (no 402)", async () => {
  const db = d1(); const w = world({ loseSettleAnswer: true });
  const r = await verifyAndSettle(mkc(db), payload("11"), SPOT);
  assert.equal(w.used.size, 1, "charged on chain");
  assert.equal(r.ok, true, "first answer: " + r.reason);
  assert.equal(r.settle.transaction, TX);
  const rows = db.raw.prepare("SELECT state FROM settled_payments").all();
  assert.equal(rows.length, 1); assert.equal(rows[0].state, "settled");
});

test("0.59.2 replay A': answer lost and chain unreachable -> 503-style pending (never 'payment rejected'); the retry of the same payment finishes paid", async () => {
  const db = d1(); const w = world({ loseSettleAnswer: true, chain: "down" });
  const r1 = await verifyAndSettle(mkc(db), payload("12"), SPOT);
  assert.equal(r1.ok, false); assert.equal(r1.pending, true, "pending, not a denial: " + r1.reason); assert.match(r1.ref, /^pay-[0-9a-f]{20}$/);
  w.chain = "up"; w.loseSettleAnswer = false;
  const r2 = await verifyAndSettle(mkc(db), payload("12"), SPOT);
  assert.equal(r2.ok, true, "retry: " + r2.reason); assert.equal(r2.settle.transaction, TX); assert.equal(r2.ref, r1.ref, "stable reference");
  assert.equal(w.settles, 1, "never settled twice");
  const r3 = await verifyAndSettle(mkc(db), payload("12"), SPOT);
  assert.equal(r3.replayed, true);
});

test("0.59.2 Worker crash after settle (row left PENDING) -> the retry resolves on chain instead of nonce_already_used", async () => {
  const db = d1(); const w = world();
  const c = mkc(db), p = payload("13");
  w.used.add(p.payload.authorization.nonce); // settled on chain, then the Worker died before recording it
  db.raw.prepare("INSERT INTO settled_payments (key, resource, amount, settle, facilitator, created_at) VALUES (?, ?, '20000', '{}', NULL, '2026-10-29T00:00:00Z')").run(await settlementKey(c, p), SPOT.origin + SPOT.pathname);
  const r = await verifyAndSettle(c, p, SPOT);
  assert.equal(r.ok, true, r.reason); assert.equal(r.settle.transaction, TX);
});

test("0.59.2 a definitive refusal (nonce unused on chain) leaves no pending row and stays a plain denial", async () => {
  const db = d1(); world();
  globalThis.fetch = (orig => async (u, init) => (String(u).endsWith("/verify") ? Response.json({ isValid: false, invalidReason: "insufficient_funds" }) : orig(u, init)))(globalThis.fetch);
  const r = await verifyAndSettle(mkc(db), payload("14"), SPOT);
  assert.equal(r.ok, false); assert.ok(!r.pending); assert.match(r.reason, /insufficient_funds/);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM settled_payments").get().n, 0);
});
