// Generates tests/fixtures/accepts_0.50.2.json: the accepts (and resource) of every unpaid 402, before 0.51.0.
import worker from "../../worker/src/index.js";
import * as S from "../../worker/src/sign.js";
import { writeFileSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const MIG = readFileSync(new URL("../../worker/migrations/0013_watchtower.sql", import.meta.url), "utf8");
function d1() { // real SQLite behind a tiny D1 adapter (same as watch_test)
  const db = new DatabaseSync(":memory:"); db.exec(MIG);
  const norm = (a) => a.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x));
  const mk = (sql, args = []) => ({ bind: (...a) => mk(sql, norm(a)), first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; }, _run: () => db.prepare(sql).run(...args) });
  return { prepare: (sql) => mk(sql), batch: async (st) => { for (const x of st) x._run(); return []; } };
}
const stmt = () => { const st = { bind: () => st, first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) }; return st; };
export const fakeDb = () => ({ prepare: stmt, batch: async () => [] });
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]); // throwaway test key
const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.privateKey)), kid: "test-key" };
S._addTestKey({ kid: jwk.kid, x: jwk.x }); S._resetSigner();
export const ENV = { RECEIPT_SIGNING_KEY: JSON.stringify(jwk),  DATA_BASE_URL: "https://data.fixture/vc/", CLIENT_SALT: "s", PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", ENDPOINT_REPORT: "1", BULK_REPORT: "1", RECHECK: "1", WATCHTOWER: "1", WATCH_PEPPER: "test-pepper-not-secret" };
export const CASES = {
  lookup_paid: ["GET", "/v1/lookup/paid?task=web-search&max_price=0.01&n=5"],
  pack: ["GET", "/v1/products/overnight-cos-pack"],
  payment_status: ["POST", "/v1/products/payment-status"],
  spot_discovery: ["GET", "/v1/products/endpoint-spot-check"],
  spot_placeholder: ["GET", "/v1/products/endpoint-spot-check?url=https://example.com/api/paid"],
  endpoint_report: ["POST", "/v1/products/endpoint-report"],
  bulk: ["POST", "/v1/products/endpoint-report/bulk"],
  watch: ["POST", "/v1/watch", null, true],
};
export async function collect() {
  const out = {};
  for (const [k, [m, p, body, needsDb]] of Object.entries(CASES)) {
    const r = await worker.fetch(new Request("https://api.402xagent.com" + p, { method: m, headers: { "cf-connecting-ip": "198.51.100.7", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), needsDb ? { ...ENV, RECEIPTS_DB: d1() } : ENV, { waitUntil() {} });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (_) {}
    const h = r.headers.get("payment-required"); const hj = h ? JSON.parse(Buffer.from(h, "base64").toString()) : null;
    if (r.status !== 402) console.error(k, r.status, t.slice(0, 200));
    out[k] = { status: r.status, accepts: JSON.stringify(j.accepts), header_accepts: hj ? JSON.stringify(hj.accepts) : null, bazaar: j.extensions ? !!j.extensions.bazaar : null };
  }
  return out;
}
if (process.argv[2] === "write") writeFileSync(new URL("./accepts_0.50.2.json", import.meta.url), JSON.stringify(await collect(), null, 1) + "\n");
