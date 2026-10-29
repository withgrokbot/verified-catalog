// 0.51.0 facilitator adapter (CDP primary, PayAI fallback) + Bazaar metadata on endpoint-report/bulk/watch + self_test label.
// All keys are throwaway test keys generated here; no real CDP credentials. Network is stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cdpJwt, facilitatorChain, CDP_FACILITATOR_URL } from "../worker/src/facilitator.js";
import { verifyAndSettle, cfg, VERSION } from "../worker/src/lib.js";
import { selfTestOf } from "../worker/src/ops.js";
import { collect, ENV as SNAP_ENV } from "./fixtures/gen_accepts_0.50.2.mjs";

const SNAP = JSON.parse(readFileSync(new URL("./fixtures/accepts_0.50.2.json", import.meta.url), "utf8"));
const PAY_TO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";
const PAYAI = "https://facilitator.payai.network";
const b64u = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

// throwaway Ed25519 key in the CDP secret format: base64(seed32 || pub32)
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwkPriv = await crypto.subtle.exportKey("jwk", kp.privateKey);
const seed = Buffer.from(jwkPriv.d, "base64url"), pub = Buffer.from(jwkPriv.x, "base64url");
const TEST_KEY_ID = "test-key-id-0000", TEST_KEY_SECRET = Buffer.concat([seed, pub]).toString("base64");

const payload = { x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO }, payload: { signature: "0xsig", authorization: { from: "0x00000000000000000000000000000000000000b1", to: PAY_TO, value: "20000", nonce: "0x" + "11".repeat(32) } } };
const URL_SPOT = new URL("https://api.402xagent.com/v1/products/endpoint-spot-check");
const cdpEnv = (extra = {}) => ({ PAY_TO, FACILITATOR_PRIMARY: "cdp", CDP_API_KEY_ID: TEST_KEY_ID, CDP_API_KEY_SECRET: TEST_KEY_SECRET, ...extra });

// scripted fetch: per "<host>/<op>" a list of responses ("timeout" | [status, body])
function stubFetch(script) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init = {}) => {
    const s = String(u); const op = (s.startsWith(CDP_FACILITATOR_URL) ? "cdp" : s.startsWith(PAYAI) ? "payai" : "other") + s.slice(s.lastIndexOf("/"));
    calls.push({ op, url: s, headers: Object.fromEntries(new Headers(init.headers || {})), body: init.body });
    const q = script[op] || []; const next = q.length > 1 ? q.shift() : q[0];
    if (!next) throw new Error("unexpected fetch " + op);
    if (next === "timeout") { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }
    return new Response(JSON.stringify(next[1]), { status: next[0], headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const OKV = [200, { isValid: true, payer: "0xb1" }], OKS = [200, { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: "0xb1" }];
const run = async (env, script) => { const s = stubFetch(script); try { return { r: await verifyAndSettle(cfg(env), payload, URL_SPOT, { paidPath: false }), calls: s.calls }; } finally { s.restore(); } };
const ops = (calls) => calls.map((c) => c.op);

test("0.58.9 version", () => assert.equal(VERSION, "0.59.1"));

test("CDP JWT shape: EdDSA header {alg,kid,typ,nonce}, claims {sub,iss:cdp,nbf,exp=nbf+120,uris:[METHOD host/path]}, valid signature", async () => {
  const t = await cdpJwt({ keyId: TEST_KEY_ID, keySecret: TEST_KEY_SECRET, method: "POST", url: CDP_FACILITATOR_URL + "/verify", now: 1_800_000_000 });
  const [h, p, sig] = t.split(".");
  const H = b64u(h), P = b64u(p);
  assert.deepEqual(Object.keys(H).sort(), ["alg", "kid", "nonce", "typ"]);
  assert.equal(H.alg, "EdDSA"); assert.equal(H.typ, "JWT"); assert.equal(H.kid, TEST_KEY_ID); assert.match(H.nonce, /^[0-9a-f]{32}$/);
  assert.equal(P.sub, TEST_KEY_ID); assert.equal(P.iss, "cdp"); assert.equal(P.nbf, 1_800_000_000); assert.equal(P.exp, 1_800_000_120);
  assert.deepEqual(P.uris, ["POST api.cdp.coinbase.com/platform/v2/x402/verify"]);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, kp.publicKey, Buffer.from(sig, "base64url"), new TextEncoder().encode(h + "." + p));
  assert.ok(ok, "signature verifies with the key's public half");
  const t2 = await cdpJwt({ keyId: TEST_KEY_ID, keySecret: TEST_KEY_SECRET, method: "POST", url: CDP_FACILITATOR_URL + "/verify", now: 1_800_000_000 });
  assert.notEqual(b64u(t2.split(".")[0]).nonce, H.nonce, "fresh nonce per token");
});

test("CDP JWT: ES256 PEM keys (PKCS8 and SEC1 EC) sign verifiable P-256 tokens", async () => {
  const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", ec.privateKey));
  const pem = "-----BEGIN PRIVATE KEY-----\n" + der.toString("base64").match(/.{1,64}/g).join("\n") + "\n-----END PRIVATE KEY-----\n";
  const t = await cdpJwt({ keyId: "organizations/o/apiKeys/k", keySecret: pem, method: "POST", url: CDP_FACILITATOR_URL + "/settle" });
  const [h, p, sig] = t.split(".");
  assert.equal(b64u(h).alg, "ES256");
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ec.publicKey, Buffer.from(sig, "base64url"), new TextEncoder().encode(h + "." + p)));
  // SEC1 ("EC PRIVATE KEY") form, as CDP's legacy keys are shipped: the inner ECPrivateKey of the PKCS8 above
  const { createPrivateKey } = await import("node:crypto");
  const sec1 = createPrivateKey({ key: der, format: "der", type: "pkcs8" }).export({ format: "pem", type: "sec1" });
  const t3 = await cdpJwt({ keyId: "k", keySecret: sec1, method: "POST", url: CDP_FACILITATOR_URL + "/settle" });
  const [h3, p3, s3] = t3.split(".");
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ec.publicKey, Buffer.from(s3, "base64url"), new TextEncoder().encode(h3 + "." + p3)));
});

test("default (no FACILITATOR_PRIMARY) = PayAI only, request identical to 0.50.2 (no auth header, same body), no facilitator chain to CDP", async () => {
  const { r, calls } = await run({ PAY_TO }, { "payai/verify": [OKV], "payai/settle": [OKS] });
  assert.deepEqual(ops(calls), ["payai/verify", "payai/settle"]);
  for (const c of calls) { assert.deepEqual(Object.keys(c.headers).sort(), ["accept", "content-type"]); assert.equal(c.url.startsWith(PAYAI + "/"), true); }
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(Object.keys(body).sort(), ["paymentPayload", "paymentRequirements", "x402Version"]);
  assert.equal(r.ok, true); assert.equal(r.facilitator, "payai");
  assert.deepEqual(Object.keys(r.settle).sort(), ["network", "payer", "success", "transaction"], "settle object (PAYMENT-RESPONSE) unchanged");
  assert.deepEqual(facilitatorChain({ PAY_TO }, "/v1/products/endpoint-spot-check").map((f) => f.name), ["payai"]);
  assert.deepEqual(facilitatorChain({ PAY_TO, FACILITATOR_PRIMARY: "cdp" }, "/x").map((f) => f.name), ["payai"], "cdp without keys stays on PayAI");
});

test("CDP ok: verify+settle on CDP with Bearer JWT, PayAI never called, facilitator recorded", async () => {
  const { r, calls } = await run(cdpEnv(), { "cdp/verify": [OKV], "cdp/settle": [OKS] });
  assert.deepEqual(ops(calls), ["cdp/verify", "cdp/settle"]);
  for (const c of calls) assert.match(c.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(b64u(calls[1].headers.authorization.split(" ")[1].split(".")[1]).uris[0], "POST api.cdp.coinbase.com/platform/v2/x402/settle");
  assert.equal(r.ok, true); assert.equal(r.facilitator, "cdp"); assert.equal(r.settle.transaction, OKS[1].transaction);
});

test("CDP decline (4xx / isValid false): no fallback, nothing settled", async () => {
  for (const v of [[400, { isValid: false, invalidReason: "insufficient_funds" }], [200, { isValid: false, invalidReason: "invalid_signature" }], [401, { errorType: "unauthorized" }]]) {
    const { r, calls } = await run(cdpEnv(), { "cdp/verify": [v] });
    assert.deepEqual(ops(calls), ["cdp/verify"], JSON.stringify(v));
    assert.equal(r.ok, false); assert.equal(r.facilitator, "cdp");
  }
});

test("CDP 5xx on verify -> PayAI verify+settle (recorded payai, fallback_from cdp)", async () => {
  const { r, calls } = await run(cdpEnv(), { "cdp/verify": [[503, { errorType: "unavailable" }]], "payai/verify": [OKV], "payai/settle": [OKS] });
  assert.deepEqual(ops(calls), ["cdp/verify", "payai/verify", "payai/settle"]);
  assert.equal(r.ok, true); assert.equal(r.facilitator, "payai"); assert.equal(r.fallback_from, "cdp");
  assert.equal(calls[1].headers.authorization, undefined, "no CDP token sent to PayAI");
});

test("CDP timeout on verify -> PayAI fallback", async () => {
  const { r, calls } = await run(cdpEnv(), { "cdp/verify": ["timeout"], "payai/verify": [OKV], "payai/settle": [OKS] });
  assert.deepEqual(ops(calls), ["cdp/verify", "payai/verify", "payai/settle"]);
  assert.equal(r.ok, true); assert.equal(r.facilitator, "payai");
});

test("no double settle: once CDP verified, settle stays on CDP; 5xx/timeout on settle never re-settles on PayAI", async () => {
  for (const s of [[502, {}], "timeout", [200, { success: false, errorReason: "invalid_transaction_state" }]]) {
    const { r, calls } = await run(cdpEnv(), { "cdp/verify": [OKV], "cdp/settle": [s] });
    assert.ok(!ops(calls).some((o) => o.startsWith("payai")), "PayAI never called: " + JSON.stringify(s));
    assert.equal(ops(calls).filter((o) => o === "cdp/settle").length, 1);
    assert.equal(r.ok, false); assert.equal(r.facilitator, "cdp");
  }
  // CDP success: exactly one settle in total
  const { calls } = await run(cdpEnv(), { "cdp/verify": [OKV], "cdp/settle": [OKS] });
  assert.equal(ops(calls).filter((o) => o.endsWith("/settle")).length, 1);
});

test("FACILITATOR_CDP_ROUTES limits CDP to listed routes (flip spot-check first)", async () => {
  const env = cdpEnv({ FACILITATOR_CDP_ROUTES: "/v1/products/endpoint-spot-check" });
  assert.deepEqual(facilitatorChain(env, "/v1/products/endpoint-spot-check").map((f) => f.name), ["cdp", "payai"]);
  assert.deepEqual(facilitatorChain(env, "/v1/products/endpoint-report").map((f) => f.name), ["payai"]);
});

test("accepts byte-identical to 0.50.2 for all 8 unpaid 402s (body + PAYMENT-REQUIRED header), also with FACILITATOR_PRIMARY=cdp", async () => {
  for (const extra of [{}, { FACILITATOR_PRIMARY: "cdp", CDP_API_KEY_ID: TEST_KEY_ID, CDP_API_KEY_SECRET: TEST_KEY_SECRET }]) {
    Object.assign(SNAP_ENV, extra);
    const now = await collect();
    for (const k of Object.keys(SNAP)) {
      assert.equal(now[k].status, 402, k);
      assert.equal(now[k].accepts, SNAP[k].accepts, k + " accepts");
      assert.equal(now[k].header_accepts, SNAP[k].header_accepts, k + " header accepts");
      assert.equal(now[k].bazaar, true, k + " has extensions.bazaar");
    }
    for (const key of Object.keys(extra)) delete SNAP_ENV[key];
  }
});

// minimal JSON-Schema (2020-12 subset used by our Bazaar metadata) validator
function validate(schema, v, path = "$") {
  const errs = [];
  if (schema.const !== undefined && v !== schema.const) errs.push(`${path}: const`);
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${path}: enum`);
  const t = schema.type;
  const typeOk = !t || (t === "object" ? v && typeof v === "object" && !Array.isArray(v) : t === "array" ? Array.isArray(v) : t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" : typeof v === t);
  if (!typeOk) return [`${path}: type ${t}`];
  if (t === "object" && v) {
    for (const r of schema.required || []) if (!(r in v)) errs.push(`${path}.${r}: required`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in v) errs.push(...validate(s, v[k], path + "." + k));
    if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in (schema.properties || {}))) errs.push(`${path}.${k}: additional`);
  }
  if (t === "array" && schema.items) v.forEach((x, i) => errs.push(...validate(schema.items, x, `${path}[${i}]`)));
  return errs;
}

test("Bazaar metadata on every paid 402 is well-formed and info validates against its own schema", async () => {
  const worker = (await import("../worker/src/index.js")).default;
  const { CASES } = await import("./fixtures/gen_accepts_0.50.2.mjs");
  for (const k of Object.keys(CASES)) {
    const [m, p] = CASES[k];
    const env = k === "watch" ? null : SNAP_ENV;
    if (!env) continue; // watch checked below via the collected body
    const r = await worker.fetch(new Request("https://api.402xagent.com" + p, { method: m }), env, { waitUntil() {} });
    const b = (await r.json()).extensions.bazaar;
    assert.equal(b.schema.$schema, "https://json-schema.org/draft/2020-12/schema", k);
    assert.ok(["GET", "POST"].includes(b.info.input.method) && b.info.input.type === "http", k);
    assert.deepEqual(validate(b.schema, b.info), [], k);
  }
  const { erBazaarExtension, bulkBazaarExtension } = await import("../worker/src/lib.js");
  const { watchBazaarExtension } = await import("../worker/src/watch.js");
  for (const [n, f] of [["er", erBazaarExtension], ["bulk", bulkBazaarExtension], ["watch", watchBazaarExtension]]) {
    const b = f();
    assert.equal(b.info.input.method, "POST", n); assert.equal(b.info.input.bodyType, "json", n);
    assert.deepEqual(validate(b.schema, b.info), [], n);
    assert.ok(JSON.stringify(b).length < 2500, n + " stays small (< 2.5 KB)");
  }
});

test("self_test label: only for our own payTo or DRILL_WALLETS payers (never self-declared)", () => {
  const p = (from) => ({ payload: { authorization: { from } } });
  assert.equal(selfTestOf(p(PAY_TO.toLowerCase()), { PAY_TO }), true);
  assert.equal(selfTestOf(p("0x00000000000000000000000000000000000000d1"), { PAY_TO, DRILL_WALLETS: "0x00000000000000000000000000000000000000d1" }), true);
  assert.equal(selfTestOf(p("0x00000000000000000000000000000000000000b1"), { PAY_TO }), false);
  assert.equal(selfTestOf(null, { PAY_TO }), false);
});
