// 0.49.2 placeholder hosts: example.com/.org/.net (+ subdomains), localhost, 127.0.0.1, test.com, *.test, *.invalid,
// *.example are rejected at the API before any probe and before any free quota is used; unpaid -> the 0.49.1
// 402 + input_error shape, with a payment header -> strict 400 (nothing verified). Counted on their own
// (paywall_daily event 'placeholder') and filtered out of /v1/ops/stats funnel + endpoints-checked (raw kept).
// Real SQLite (node:sqlite) runs every migration. All data is synthetic. Run: node tests/placeholder_test.mjs (Node >= 22.5)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import * as O from "../worker/src/ops.js";
import * as S from "../worker/src/sign.js";

let quotaCalls = 0;
const quota = () => ({ idFromName: (k) => k, get: () => ({ fetch: async () => { quotaCalls++; return new Response(JSON.stringify({ free: true, used: 1 })); } }) });
let outbound = [];
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
  if (!/\/(verify|settle)$/.test(s)) outbound.push(s);
  if (s.endsWith("/verify")) { if (fac.throwVerify) throw new Error("down"); return new Response(JSON.stringify(fac.verify), { headers: { "content-type": "application/json" } }); }
  if (s.endsWith("/settle")) return new Response(JSON.stringify(fac.settle), { headers: { "content-type": "application/json" } });
  return new Response("nope", { status: 404 });
};
const { privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", privateKey)), kid: "test-placeholder-key" };
S._addTestKey({ kid: jwk.kid, x: jwk.x }); S._resetSigner();
function setup(extra = {}) {
  const env = { RECEIPTS_DB: d1(), QUOTA: quota(), PAY_TO, DRILL_WALLETS: DRILL, ENDPOINT_REPORT: "1", WATCH_STATS_TOKEN: "stat-token", RECEIPT_SIGNING_KEY: JSON.stringify(jwk), ...extra };
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
const SPOT = "/v1/products/endpoint-spot-check";
const BULK = ER + "/bulk";
const MSG = "This looks like the docs placeholder. Submit a real x402 endpoint URL.";
const PH = ["https://example.com/api/paid", "https://api.example.org/x", "http://www.example.net/", "http://localhost:8080/a", "http://127.0.0.1/",
  "https://test.com/x", "https://seller.test/x", "https://a.b.invalid/", "https://seller.example/api/x", "https://EXAMPLE.COM./x"];

test("isPlaceholderHost / isPlaceholderUrl: the approved list and nothing else", () => {
  for (const h of ["example.com", "Example.Org", "example.net", "a.b.example.com", "localhost", "127.0.0.1", "test.com", "x.test", "foo.invalid", "seller.example", "example.com."])
    assert.ok(O.isPlaceholderHost(h), h);
  for (const h of ["api.402rates.com", "myexample.com", "example.co", "example.com.evil.dev", "test.com.au", "latest.dev", "testnet.io", "127.0.0.2", "examples.net", "invalid.dev", ""])
    assert.ok(!O.isPlaceholderHost(h), h);
  for (const u of PH) assert.ok(O.isPlaceholderUrl(u), u);
  assert.ok(O.isPlaceholderUrl("example.com/api/paid"), "no scheme");
  assert.ok(!O.isPlaceholderUrl("https://api.402rates.com/v1/ping"));
  assert.ok(!O.isPlaceholderUrl("not a url")); assert.ok(!O.isPlaceholderUrl(null));
});

test("placeholderSql matches isPlaceholderUrl on stored URLs (SQLite)", () => {
  const db = new DatabaseSync(":memory:");
  const urls = [...PH, "https://u:p@example.com/x", "https://example.com?x=1", "https://example.com#f", "https://api.402rates.com/v1/ping",
    "https://myexample.com/x", "https://example.com.evil.dev/x", "https://test.com.au/", "http://127.0.0.2/"];
  for (const u of urls) {
    const r = db.prepare(`SELECT ${O.placeholderSql("u")} AS p FROM (SELECT ? AS u)`).get(u);
    assert.equal(!!r.p, O.isPlaceholderUrl(u), u);
  }
});

test("spot-check: unpaid placeholder -> 402 + input_error (normal accepts), no probe, no free quota; with a payment header -> strict 400, nothing verified", async () => {
  const t = setup();
  const real = await t.call("GET", SPOT); // discovery 402: the normal accepts
  assert.equal(real.status, 402);
  for (const u of PH) {
    outbound = []; quotaCalls = 0;
    const r = await t.call("GET", SPOT + "?url=" + encodeURIComponent(u));
    assert.equal(r.status, 402, u + " " + r.text);
    assert.equal(r.j.error, MSG);
    assert.equal(r.j.input_error.code, "placeholder_host");
    assert.equal(r.j.input_error.field, "url");
    assert.equal(r.j.input_error.message, MSG);
    assert.ok(r.j.input_error.expected && r.j.input_error.received, u);
    assert.deepEqual(r.j.accepts, real.j.accepts, "accepts unchanged");
    assert.ok(r.headers.get("payment-required"));
    assert.equal(r.headers.get("x-402-input-error"), "url");
    assert.deepEqual(outbound, [], "no probe / DNS for " + u);
    assert.equal(quotaCalls, 0, "no free quota used for " + u);
  }
  // POST JSON body and dry-run are rejected the same way
  assert.equal((await t.call("POST", SPOT, { body: { url: "https://example.com/api/paid" } })).status, 402);
  assert.equal((await t.call("GET", SPOT + "?mode=dry-run&url=" + encodeURIComponent("https://example.com/api/paid"))).j.input_error.code, "placeholder_host");
  let verified = 0; const of = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (/\/(verify|settle)$/.test(String(u))) verified++; return of(u, i); };
  try {
    outbound = []; quotaCalls = 0;
    const h = await t.call("GET", SPOT + "?url=" + encodeURIComponent("https://example.com/api/paid"), { headers: pay(OUTSIDE, { amount: "20000" }) });
    assert.equal(h.status, 400, h.text);
    assert.equal(h.j.error, MSG); assert.equal(h.j.code, "placeholder_host"); assert.equal(h.j.field, "url");
    assert.deepEqual(outbound, []); assert.equal(quotaCalls, 0);
  } finally { globalThis.fetch = of; }
  assert.equal(verified, 0, "nothing verified or settled");
  assert.equal(t.rows("spot_receipts").length, 0, "no receipt stored");
  const f = funnel(t);
  assert.equal(f[`${SPOT}|outside|placeholder|unpaid`], PH.length + 2);
  assert.equal(f[`${SPOT}|outside|placeholder|paid`], 1);
  assert.equal(f[`${SPOT}|outside|402|`], 1, "only the real discovery 402 is in the funnel");
  assert.equal(f[`${SPOT}|outside|attempt|`], undefined, "a placeholder with a header is not a payment attempt");
});

test("endpoint-report, bulk and watch: placeholder url -> 402 + input_error unpaid, strict 400 with a header; real URLs unchanged", async () => {
  const t = setup({ BULK_REPORT: "1", WATCHTOWER: "1", WATCH_PEPPER: "test-pepper" });
  const okER = await t.call("POST", ER, { body: { url: "https://api.402rates.com/x" } });
  assert.equal(okER.status, 402); assert.equal(okER.j.input_error, undefined, "a real URL is not flagged");
  const cases = [
    [ER, { url: "https://example.com/api/paid" }, "url", okER.j.accepts],
    [BULK, { urls: ["https://api.402rates.com/1", "http://localhost/x"] }, "urls[1]", null],
    [BULK, { urls: ["https://x.test/1"] }, "urls[0]", null],
    ["/v1/watch", { url: "https://api.example.com/v1", webhook_url: "https://hooks.real-buyer.dev/h" }, "url", null],
  ];
  let verified = 0; const of = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (/\/(verify|settle)$/.test(String(u))) verified++; return of(u, i); };
  try {
    for (const [path, body, field, acc] of cases) {
      outbound = [];
      const r = await t.call("POST", path, { body });
      assert.equal(r.status, 402, path + " " + r.text);
      assert.equal(r.j.error, MSG, path);
      assert.equal(r.j.input_error.code, "placeholder_host", path);
      assert.equal(r.j.input_error.field, field, path);
      assert.ok(Array.isArray(r.j.accepts) && r.j.accepts.length, path);
      if (acc) assert.deepEqual(r.j.accepts, acc, "accepts unchanged " + path);
      assert.equal(r.headers.get("x-402-input-error"), field, path);
      const h = await t.call("POST", path, { body, headers: pay(OUTSIDE) });
      assert.equal(h.status, 400, "with header " + path + " " + h.text);
      assert.equal(h.j.error, MSG, path); assert.equal(h.j.field, field, path);
      assert.deepEqual(outbound, [], "no probe " + path);
    }
  } finally { globalThis.fetch = of; }
  assert.equal(verified, 0);
  const f = funnel(t);
  assert.equal(f[`${ER}|outside|placeholder|unpaid`], 1); assert.equal(f[`${ER}|outside|placeholder|paid`], 1);
  assert.equal(f[`${BULK}|outside|placeholder|unpaid`], 2); assert.equal(f[`/v1/watch|outside|placeholder|paid`], 1);
  assert.equal(f[`${ER}|outside|402|`], 1, "the real URL's 402 only");
});

test("/v1/ops/stats: funnel + endpoints-checked without placeholders, raw counts in separate fields", async () => {
  const t = setup();
  await t.call("POST", ER, { body: { url: "https://api.402rates.com/x" } });
  await t.call("POST", ER, { body: { url: "https://example.com/x" } });
  await t.call("POST", ER, { body: { url: "https://example.com/x" } });
  await t.call("POST", ER, { body: { url: "https://example.com/x" }, headers: pay(OUTSIDE) });
  const ins = t.env.RECEIPTS_DB.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, body, check_type) VALUES (?, ?, ?, 'skip', 'x', '{}', ?)");
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  ins.run("sc-1", "https://api.402rates.com/v1/ping", ts, "live");
  ins.run("sc-2", "https://api.402rates.com/v1/ping", ts, "live");
  ins.run("sc-3", "https://other.dev/a", ts, "self-checked");
  ins.run("sc-4", "https://example.com/api/paid", ts, "live");
  ins.run("sc-5", "https://example.com/api/paid", ts, "live");
  ins.run("sc-6", "http://localhost/x", ts, "dry-run");
  const s = await t.call("GET", "/v1/ops/stats", { headers: { authorization: "Bearer stat-token" } });
  assert.equal(s.status, 200, s.text);
  const o = s.j.paywall_funnel[ER].outside;
  assert.equal(o["402"], 1); assert.equal(o["402_raw"], 3);
  assert.equal(o.attempt, 0); assert.equal(o.attempt_raw, 1);
  assert.equal(o.placeholder, 3); assert.equal(s.j.placeholder_hits, 3);
  assert.deepEqual(s.j.endpoints_checked, { endpoints: 2, endpoints_raw: 4, checks: 3, checks_raw: 6, demand: 2, demand_raw: 5, demand_endpoints: 1, demand_endpoints_raw: 3, placeholder_checks: 3 });
});

test("funnelRows: placeholder rows replace the 402/attempt rows", () => {
  assert.deepEqual(O.funnelRows({ route: SPOT, segment: "outside", status: 402, hasPayment: false, placeholder: true }), [[SPOT, "outside", "placeholder", "unpaid"]]);
  assert.deepEqual(O.funnelRows({ route: SPOT, segment: "self", status: 400, hasPayment: true, placeholder: true }), [[SPOT, "self", "placeholder", "paid"]]);
});

test("ops_weekly.sh filters placeholder hosts and keeps raw counts", () => {
  const sh = readFileSync(join(ROOT, "worker", "scripts", "ops_weekly.sh"), "utf8");
  assert.match(sh, /event != 'placeholder'/);
  assert.match(sh, /placeholder/i);
  assert.ok(sh.includes(O.placeholderSql("url")), "same SQL predicate as the Worker");
  assert.match(sh, /endpoints_raw/);
});

test("public recent_checks: placeholder hosts are never publishable (test.com and 127.0.0.1 included)", async () => {
  const { publishable } = await import("../worker/src/recent.js");
  for (const url of ["https://test.com/x", "http://127.0.0.1/x", "https://example.com/api/paid", "https://seller.test/x"])
    assert.equal(publishable({ tier: "free", verdict: "skip", url }), null, url);
  assert.equal(publishable({ tier: "free", verdict: "skip", url: "https://api.402rates.com/v1/ping" }), "https://api.402rates.com/v1/ping");
});

let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  try { await fn(); pass++; console.log("PASS " + name); } catch (e) { fail++; console.log("FAIL " + name + "\n  " + String(e && e.stack || e).split("\n").slice(0, 6).join("\n  ")); }
}
globalThis.fetch = ofetch;
console.log(`${pass}/${tests.length} placeholder tests passed`);
if (fail) process.exit(1);
