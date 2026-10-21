// 0.48.0 ops tests: paywall funnel + 404 path log in D1 (migration 0014), 405 Allow + JSON, explicit 400s.
// Real SQLite (node:sqlite) runs every migration behind a tiny D1 adapter; the facilitator is stubbed.
// All data is synthetic. Run: npx -y -p node@22 node tests/ops_test.mjs  (Node >= 22.5)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import * as O from "../worker/src/ops.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGDIR = join(ROOT, "worker", "migrations");
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function d1() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGDIR).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(join(MIGDIR, f), "utf8"));
  const norm = (a) => a.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x));
  const mk = (sql, args = []) => ({
    bind: (...a) => mk(sql, norm(a)),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    _run: () => db.prepare(sql).run(...args),
  });
  return { raw: db, prepare: (sql) => mk(sql), batch: async (st) => { for (const s of st) s._run(); return []; } };
}
const PAY_TO = "0x00000000000000000000000000000000000000aa";
const DRILL = "0x00000000000000000000000000000000000000dd";
const OUTSIDE = "0x00000000000000000000000000000000000000bb";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
let fac = { verify: { isValid: true, payer: OUTSIDE }, settle: { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: OUTSIDE }, throwVerify: false };
const ofetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const s = String(u);
  if (s.endsWith("/verify")) { if (fac.throwVerify) throw new Error("down"); return new Response(JSON.stringify(fac.verify), { headers: { "content-type": "application/json" } }); }
  if (s.endsWith("/settle")) return new Response(JSON.stringify(fac.settle), { headers: { "content-type": "application/json" } });
  return new Response("nope", { status: 404 });
};
const { privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", privateKey)), kid: "test-ops-key" };
function setup(extra = {}) {
  const env = { RECEIPTS_DB: d1(), PAY_TO, DRILL_WALLETS: DRILL, ENDPOINT_REPORT: "1", WATCH_STATS_TOKEN: "stat-token", RECEIPT_SIGNING_KEY: JSON.stringify(jwk), ...extra };
  const pending = [];
  const call = async (method, path, { body, headers = {} } = {}) => {
    const req = new Request("https://api.402xagent.com" + path, { method, headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    const r = await worker.fetch(req, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending.splice(0));
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    return { status: r.status, headers: r.headers, text, j };
  };
  const rows = (t) => env.RECEIPTS_DB.raw.prepare("SELECT * FROM " + t).all();
  return { env, call, rows };
}
const pay = (from, over = {}) => ({ "payment-signature": btoa(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", amount: "50000", asset: USDC, payTo: PAY_TO, ...over }, payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: PAY_TO, value: over.amount || "50000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "22".repeat(32) } } })) });
const ER = "/v1/products/endpoint-report";
const funnel = (t) => Object.fromEntries(t.rows("paywall_daily").map((r) => [[r.route, r.segment, r.event, r.reason].join("|"), r.n]));

test("funnel: 402 served, attempts, failures by reason, settled; self (payTo / drill wallet) split from outside; per route", async () => {
  const t = setup();
  assert.equal((await t.call("POST", ER, { body: {} })).status, 402);
  assert.equal((await t.call("POST", ER, { body: { url: "https://spot.target.test/x" } })).status, 402);
  fac = { ...fac, throwVerify: false, verify: { isValid: true, payer: OUTSIDE } };
  const ok = await t.call("POST", ER, { body: { url: "https://spot.target.test/x" }, headers: pay(OUTSIDE) });
  assert.equal(ok.status, 200, ok.text); assert.ok(ok.headers.get("payment-response"));
  fac.verify = { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" };
  assert.equal((await t.call("POST", ER, { body: { url: "https://spot.target.test/x" }, headers: pay(OUTSIDE) })).status, 402);
  fac.verify = { isValid: false, invalidReason: "insufficient_funds" };
  await t.call("POST", ER, { body: { url: "https://spot.target.test/x" }, headers: pay(OUTSIDE) });
  fac.verify = { isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_valid_before" };
  await t.call("POST", ER, { body: { url: "https://spot.target.test/x" }, headers: pay(DRILL) });
  fac.throwVerify = true;
  await t.call("POST", ER, { body: { url: "https://spot.target.test/x" }, headers: pay(PAY_TO) });
  fac.throwVerify = false;
  await t.call("POST", ER, { body: { url: "https://spot.target.test/x" }, headers: pay(OUTSIDE, { network: "eip155:1" }) });
  await t.call("POST", ER, { body: { url: "https://spot.target.test/x" }, headers: { "x-payment": "not-base64-json" } });
  const f = funnel(t);
  assert.deepEqual(f, {
    [`${ER}|outside|402|`]: 6, [`${ER}|outside|attempt|`]: 5, [`${ER}|outside|settled|`]: 1,
    [`${ER}|outside|failed|bad_sig`]: 2, [`${ER}|outside|failed|insufficient_amount`]: 1, [`${ER}|outside|failed|wrong_network_or_asset`]: 1,
    [`${ER}|self|402|`]: 2, [`${ER}|self|attempt|`]: 2, [`${ER}|self|failed|expired`]: 1, [`${ER}|self|failed|facilitator_error`]: 1,
  });
  const s = await t.call("GET", "/v1/ops/stats", { headers: { authorization: "Bearer stat-token" } });
  assert.equal(s.status, 200);
  const o = s.j.paywall_funnel[ER].outside;
  assert.equal(o["402"], 6); assert.equal(o.attempt, 5); assert.equal(o.settled, 1); assert.equal(o.failed, 4);
  assert.deepEqual(o.failed_by_reason, { bad_sig: 2, wrong_network_or_asset: 1, insufficient_amount: 1, expired: 0, facilitator_error: 0, other: 0 });
  assert.equal(s.j.paywall_funnel[ER].self.failed_by_reason.facilitator_error, 1);
});

test("stats route: Bearer WATCH_STATS_TOKEN or 404; works without Watchtower on; 404s are not logged for it", async () => {
  const t = setup();
  assert.equal((await t.call("GET", "/v1/ops/stats")).status, 404);
  assert.equal((await t.call("GET", "/v1/ops/stats", { headers: { authorization: "Bearer wrong" } })).status, 404);
  assert.equal((await setup({ WATCH_STATS_TOKEN: undefined }).call("GET", "/v1/ops/stats", { headers: { authorization: "Bearer stat-token" } })).status, 404);
  assert.equal(t.rows("notfound_daily").length, 0);
});

test("404 log: normalized method + path only (no query, ids/hex/numbers/emails collapsed, <= 120 chars); top 20 on stats", async () => {
  const t = setup();
  await t.call("GET", "/wp-admin/setup.php?step=1&token=abc");
  await t.call("GET", "/wp-admin/setup.php?step=2");
  await t.call("GET", "/v1/receipts/sc-0123456789abcdef");
  await t.call("GET", "/u/someone@example.com/0x" + "ab".repeat(20));
  await t.call("GET", "/a/" + "x".repeat(300));
  await t.call("POST", "/nope/12345");
  const r = t.rows("notfound_daily");
  const paths = r.map((x) => x.method + " " + x.path).sort();
  assert.ok(paths.includes("GET /wp-admin/setup.php"));
  assert.ok(paths.includes("GET /v1/receipts/sc-:hex"));
  assert.ok(paths.includes("GET /u/:email/:hex"));
  assert.ok(paths.includes("POST /nope/:n"));
  assert.equal(r.find((x) => x.path === "/wp-admin/setup.php").n, 2);
  for (const x of r) { assert.ok(x.path.length <= 120); assert.ok(!/[?@]|203\.0\.113|example\.com|abab/.test(x.path), x.path); }
  const s = await t.call("GET", "/v1/ops/stats?days=7", { headers: { authorization: "Bearer stat-token" } });
  assert.equal(s.j.not_found.total, 6); assert.equal(s.j.not_found.top20[0].path, "/wp-admin/setup.php"); assert.ok(s.j.not_found.top20.length <= 20);
  assert.equal(O.normalizePath("/v1/watch/wt-0123456789abcdef/renew"), "/v1/watch/wt-:hex/renew");
  assert.equal(O.normalizePath("/x/550e8400-e29b-41d4-a716-446655440000"), "/x/:uuid");
});

test("405: Allow header + JSON naming the right method(s), openapi.json and skill.md; unknown paths with other methods are 404", async () => {
  const t = setup();
  const r = await t.call("POST", "/health", { body: {} });
  assert.equal(r.status, 405); assert.equal(r.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.deepEqual(r.j.allowed, ["GET", "HEAD", "OPTIONS"]); assert.match(r.j.message, /use GET/);
  assert.equal(r.j.openapi, "https://api.402xagent.com/openapi.json"); assert.equal(r.j.skill, "https://api.402xagent.com/skill.md");
  const m = await t.call("GET", "/mcp");
  assert.equal(m.status, 405); assert.equal(m.headers.get("allow"), "POST, OPTIONS"); assert.deepEqual(m.j.allowed, ["POST", "OPTIONS"]);
  const d = await t.call("DELETE", "/v1/receipts/sc-0123456789abcdef");
  assert.equal(d.status, 405); assert.equal(d.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.equal((await t.call("PUT", "/totally/unknown")).status, 404);
  const sk = await t.call("GET", "/skill.md");
  assert.equal(sk.status, 200); assert.match(sk.headers.get("content-type"), /markdown/); assert.match(sk.text, /openapi\.json/);
});

test("400: every 400 names field, expected, received (sanitized) and the openapi.json link", async () => {
  const t = setup();
  const cases = [
    ["GET", "/v1/discover?limit=abc", undefined, "limit", "abc"],
    ["GET", "/v1/discover?q=" + encodeURIComponent("<x>"), undefined, "q", "<x>"],
    ["GET", "/v1/discover?foo=1", undefined, "foo", "1"],
    ["GET", "/v1/receipts?type=nope", undefined, "type", "nope"],
    ["GET", "/v1/receipts/by-url", undefined, "url", "[not sent]"],
    ["GET", "/reputation/not_a_host", undefined, "host", "not_a_host"],
    ["GET", "/v1/receipts/%7Bid%7D", undefined, "path", "/v1/receipts/{id}"],
    ["POST", ER, "{not json", "body", "[not a JSON object]"],
    ["POST", ER, { url: "ftp://x" }, "url", "ftp://x"],
    ["POST", ER, { url: "https://a.test/x", commitment_ref: "0x" + "ab".repeat(32) }, "commitment_ref", "[66 chars, not echoed]"],
  ];
  for (const [method, path, body, field, received] of cases) {
    const r = await t.call(method, path, { body });
    assert.equal(r.status, 400, path + " " + r.text);
    assert.equal(r.j.field, field, path); assert.equal(r.j.received, received, path);
    assert.ok(typeof r.j.expected === "string" && r.j.expected.length > 3, path);
    assert.equal(r.j.openapi, "https://api.402xagent.com/openapi.json", path);
  }
  // wallets and hashes in any field are never echoed
  assert.equal(O.sanitizeReceived("q", "0x" + "ab".repeat(20)), "[42 chars, not echoed]");
  assert.equal(O.sanitizeReceived("url", "https://a.test/p?key=secret"), "https://a.test/p");
  // MCP parse errors keep JSON-RPC shape; details in error.data
  const m = await t.call("POST", "/mcp", { body: "{bad" });
  assert.equal(m.status, 400); assert.equal(m.j.jsonrpc, "2.0"); assert.equal(m.j.error.data.field, "body"); assert.equal(m.j.error.data.openapi, "https://api.402xagent.com/openapi.json");
});

test("failReason buckets + privacy: counters hold no IP, wallet, payload, tx hash or query", async () => {
  assert.equal(O.failReason("payment rejected: payment not valid: invalid_exact_evm_payload_signature"), "bad_sig");
  assert.equal(O.failReason("payment rejected: unsupported scheme or network (exact on eip155:8453 only)"), "wrong_network_or_asset");
  assert.equal(O.failReason("payment rejected: asset is not USDC on Base"), "wrong_network_or_asset");
  assert.equal(O.failReason("payment rejected: amount does not match the price"), "insufficient_amount");
  assert.equal(O.failReason("payment rejected: payment not valid: insufficient_funds"), "insufficient_amount");
  assert.equal(O.failReason("payment rejected: payment not valid: invalid_exact_evm_payload_authorization_valid_before"), "expired");
  assert.equal(O.failReason("payment rejected: facilitator unreachable (verify)"), "facilitator_error");
  assert.equal(O.failReason("payment rejected: settlement failed: HTTP 502"), "facilitator_error");
  assert.equal(O.failReason("payment rejected: payTo does not match"), "other");
  const t = setup();
  await t.call("POST", ER, { body: { url: "https://spot.target.test/x" }, headers: pay(OUTSIDE) });
  await t.call("GET", "/missing?wallet=" + OUTSIDE);
  const dump = JSON.stringify([t.rows("paywall_daily"), t.rows("notfound_daily")]);
  for (const s of [OUTSIDE, PAY_TO, DRILL, "abab", "203.0.113", "wallet=", "signature"]) assert.ok(!dump.toLowerCase().includes(s.toLowerCase()), s);
});

let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  try { await fn(); pass++; console.log("PASS " + name); } catch (e) { fail++; console.log("FAIL " + name + "\n  " + String(e && e.stack || e).split("\n").slice(0, 6).join("\n  ")); }
}
globalThis.fetch = ofetch;
console.log(`${pass}/${tests.length} ops tests passed`);
if (fail) process.exit(1);
