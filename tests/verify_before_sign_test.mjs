// examples/verify-before-sign + examples/decision-gate/facilitator-gate.mjs. Stub signers and stub fetch; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { termsSha256 as workerTermsSha256, caip } from "../worker/src/lib.js";
import { termsKey, decideFacilitator, facilitatorCheck, evmNetwork } from "../examples/decision-gate/facilitator-gate.mjs";
import { requirementFromTypedData, checkTypedData, makeApproval, MemoryApprovals, FileApprovals, VerifyBeforeSignDenied } from "../examples/verify-before-sign/approvals.mjs";
import { verifyBeforeSignHook, resourceUrlOf } from "../examples/verify-before-sign/client-hook.mjs";
import { evaluate as owsEvaluate } from "../examples/verify-before-sign/ows-policy.mjs";
import { makeVerifiedEvmWalletProvider, GATED } from "../examples/verify-before-sign/agentkit.mjs";
import { withVerifyBeforeSign } from "../examples/verify-before-sign/turnkey.mjs";
import { ACCEPTS, RESOURCE, PAYMENT_REQUIRED, typedData, toJson, stubFacilFetch } from "../examples/verify-before-sign/fixtures.mjs";

const NOW = Date.parse("2026-10-27T17:00:00Z");
const NOW_S = Math.floor(NOW / 1000);
// What the Worker hashes for a live accepts entry (worker/src/facilcheck.js handleFacilitatorCheck).
const workerHash = (e) => workerTermsSha256({ network: caip(e.network), asset: e.asset, amount_atomic: e.amount ?? e.maxAmountRequired, pay_to: e.payTo });
const KEY = termsKey(ACCEPTS);

// ---- 1. keying: terms rebuilt from the EIP-712 typed data hash the same as the accepts entry ----
test("termsSha256 from @x402/evm typed data equals the Worker's hash of the accepts entry (USDC exact, Base)", async () => {
  const fromTd = requirementFromTypedData(typedData({ nowS: NOW_S }));
  assert.equal(termsKey(fromTd), await workerHash(ACCEPTS));
  assert.equal(termsKey(ACCEPTS), await workerHash(ACCEPTS));
  // x402 v1 entry ("base", maxAmountRequired) keys the same; JSON (OWS raw_json) form too
  const v1 = { scheme: "exact", network: "base", maxAmountRequired: "20000", asset: ACCEPTS.asset, payTo: ACCEPTS.payTo };
  assert.equal(termsKey(v1), await workerHash(v1));
  assert.equal(termsKey(v1), KEY);
  assert.equal(termsKey(requirementFromTypedData(toJson(typedData({ nowS: NOW_S })))), KEY);
  // any term change changes the key
  assert.notEqual(termsKey(requirementFromTypedData(typedData({ nowS: NOW_S, value: 20001n }))), KEY);
  assert.notEqual(termsKey(requirementFromTypedData(typedData({ nowS: NOW_S, chainId: 84532 }))), KEY);
  assert.notEqual(termsKey(requirementFromTypedData(typedData({ nowS: NOW_S, to: "0x" + "3".repeat(40) }))), KEY);
});

// ---- 2. facilitator/check variant ----
test("decideFacilitator: allows only a 200 match with the same terms hash; POSTs the requirement", async () => {
  const f = stubFacilFetch("match", KEY);
  const g = await decideFacilitator({ url: RESOURCE, requirement: ACCEPTS }, { fetch: f });
  assert.equal(g.allow, true);
  assert.equal(g.check.source, "facilitator_check");
  assert.match(f.calls[0].url, /\/v1\/facilitator\/check$/);
  assert.deepEqual(f.calls[0].body, { paymentRequirements: { scheme: "exact", network: "eip155:8453", amount: "20000", asset: ACCEPTS.asset, payTo: ACCEPTS.payTo }, url: RESOURCE, method: "GET" });
});

test("decideFacilitator fails closed: mismatch, 429, 500, HTML, malformed, wrong hash, network error, timeout, non-EVM", async () => {
  const want = { mismatch: "terms_mismatch", 429: "check_http_429", 500: "check_http_500", html: "check_malformed", malformed: "check_malformed", badhash: "check_malformed", down: "check_unavailable" };
  for (const [kind, code] of Object.entries(want)) {
    const g = await decideFacilitator({ url: RESOURCE, requirement: ACCEPTS }, { fetch: stubFacilFetch(kind, KEY) });
    assert.equal(g.allow, false, kind);
    assert.equal(g.reason_code, code, kind);
  }
  const t0 = Date.now();
  const hung = await decideFacilitator({ url: RESOURCE, requirement: ACCEPTS }, { fetch: stubFacilFetch("hang"), timeoutMs: 50 });
  assert.equal(hung.allow, false);
  assert.match(hung.reason, /timeout/);
  assert.ok(Date.now() - t0 < 2000);
  const sol = await decideFacilitator({ url: RESOURCE, requirement: { ...ACCEPTS, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" } }, { fetch: stubFacilFetch("match", KEY) });
  assert.equal(sol.reason_code, "unsupported_network");
  assert.equal(evmNetwork("BASE"), "eip155:8453");
  assert.equal(evmNetwork("eip155:0"), null);
  assert.deepEqual(await facilitatorCheck({ url: RESOURCE, requirement: ACCEPTS }, { fetch: stubFacilFetch("down") }), { unavailable: "network error" });
});

// ---- 3. client layer: onBeforePaymentCreation ----
const ctx = (over = {}) => ({ paymentRequired: PAYMENT_REQUIRED, selectedRequirements: ACCEPTS, ...over });

test("hook: on allow it records one approval for the exact terms; on deny it aborts and records nothing", async () => {
  const store = new MemoryApprovals();
  const hook = verifyBeforeSignHook({ store, checkOpts: { fetch: stubFacilFetch("match", KEY) }, now: () => NOW });
  assert.equal(await hook(ctx()), undefined);
  const rec = store.byKey.get(KEY)[0];
  assert.equal(rec.url, RESOURCE);
  assert.equal(rec.expires_ms - rec.created_ms, 60000);
  assert.equal(rec.source, "facilitator_check");
  for (const kind of ["mismatch", "down", "429"]) {
    const s2 = new MemoryApprovals();
    const r = await verifyBeforeSignHook({ store: s2, checkOpts: { fetch: stubFacilFetch(kind, KEY) } })(ctx());
    assert.equal(r.abort, true, kind);
    assert.equal(s2.byKey.size, 0, kind);
  }
  const s3 = new MemoryApprovals();
  const h3 = verifyBeforeSignHook({ store: s3, check: async () => ({ allow: true, check: {} }) });
  assert.match((await h3(ctx({ selectedRequirements: { ...ACCEPTS, extra: { assetTransferMethod: "permit2" } } }))).reason, /EIP-3009/);
  assert.match((await h3(ctx({ selectedRequirements: { ...ACCEPTS, scheme: "upto" } }))).reason, /exact/);
  assert.match((await h3(ctx({ paymentRequired: { x402Version: 2, accepts: [ACCEPTS] } }))).reason, /resource URL/);
  assert.match((await verifyBeforeSignHook({ store: s3, check: async () => { throw new Error("boom"); } })(ctx())).reason, /boom/);
  assert.equal(resourceUrlOf({ selectedRequirements: { resource: RESOURCE } }), RESOURCE); // x402 v1
  assert.equal(s3.byKey.size, 0);
});

// ---- 4. signer layer (shared) ----
const approved = (store, over = {}) => store.add(makeApproval(ACCEPTS, { url: RESOURCE, source: "facilitator_check", now: NOW, ...over }));

test("checkTypedData: allows once; denies missing, expired, reused, replayed nonce, wrong chain, long validBefore, other typed data", () => {
  const s = new MemoryApprovals();
  const td = typedData({ nowS: NOW_S });
  assert.equal(checkTypedData(s, td, { now: NOW }).allow, false, "no approval");
  approved(s);
  assert.equal(checkTypedData(s, td, { now: NOW + 1000 }).allow, true);
  assert.match(checkTypedData(s, typedData({ nowS: NOW_S, nonce: "0x" + "ab".repeat(32) }), { now: NOW }).reason, /missing, expired or already used/, "single use");
  approved(s);
  assert.match(checkTypedData(s, td, { now: NOW }).reason, /nonce already used/);
  approved(s);
  assert.equal(checkTypedData(s, typedData({ nowS: NOW_S, nonce: "0x" + "01".repeat(32) }), { now: NOW + 60_001 }).allow, false, "expired after 60 s");
  approved(s);
  assert.match(checkTypedData(s, typedData({ nowS: NOW_S + 3600, nonce: "0x" + "02".repeat(32) }), { now: NOW }).reason, /validBefore/);
  approved(s);
  assert.match(checkTypedData(s, typedData({ nowS: NOW_S, nonce: "0x" + "03".repeat(32) }), { now: NOW, expectedChain: "eip155:1" }).reason, /chainId/);
  assert.equal(checkTypedData(s, { ...td, primaryType: "Permit" }, { now: NOW }).allow, false);
  assert.equal(checkTypedData(s, "not json", { now: NOW }).allow, false);
  assert.equal(checkTypedData(s, toJson({ ...td, message: { ...td.message, value: 1e20 } }), { now: NOW }).allow, false, "unsafe number");
});

// ---- 5. OWS executable ----
const owsCtx = (dir, over = {}) => ({
  chain_id: "eip155:8453", wallet_id: "w", api_key_id: "k", request_type: "sign_typed_data", spending: { daily_total: "0", date: "2026-10-27" },
  timestamp: "2026-10-27T17:00:00Z", typed_data: { primary_type: "TransferWithAuthorization", raw_json: toJson(typedData({ nowS: Math.floor(Date.now() / 1000) })) },
  policy_config: { approvals_dir: dir }, ...over,
});
const runOws = (input) => {
  // preload: any fetch() from the policy is recorded on stderr and fails
  const preload = "data:text/javascript," + encodeURIComponent('globalThis.fetch=()=>{process.stderr.write("FETCH_CALLED");throw new Error("no network")};');
  const r = spawnSync(process.execPath, ["--import", preload, "examples/verify-before-sign/ows-policy.mjs"], { input, encoding: "utf8", timeout: 10000 });
  return { code: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
};

test("OWS policy executable: stdin PolicyContext -> stdout {allow, reason}, exit 0, file approvals single use, no fetch", () => {
  const dir = mkdtempSync(join(tmpdir(), "vbs-ows-"));
  new FileApprovals(dir).add(makeApproval(ACCEPTS, { url: RESOURCE, source: "facilitator_check" }));
  const ok = runOws(JSON.stringify(owsCtx(dir)));
  assert.deepEqual([ok.code, ok.out.allow], [0, true]);
  assert.ok(!ok.stderr.includes("FETCH_CALLED"));
  const again = runOws(JSON.stringify(owsCtx(dir)));
  assert.deepEqual([again.code, again.out.allow], [0, false], "approval was consumed");
  for (const input of ["not json", "", JSON.stringify(owsCtx(dir, { request_type: "sign_transaction" })), JSON.stringify(owsCtx(dir, { policy_config: {} }))]) {
    const r = runOws(input);
    assert.equal(r.code, 0);
    assert.equal(r.out.allow, false);
    assert.equal(typeof r.out.reason, "string");
  }
  assert.ok(readdirSync(dir).every((f) => f.startsWith("nonce-")), "no approval files left");
  assert.equal(owsEvaluate(owsCtx(dir, { request_type: "read_balance", policy_config: { approvals_dir: dir, allow_request_types: ["read_balance"] } })).allow, true);
  const sample = JSON.parse(readFileSync("examples/verify-before-sign/ows-policy.sample.json", "utf8"));
  assert.deepEqual([sample.action, sample.version, typeof sample.config.approvals_dir], ["deny", 1, "string"]);
});

// ---- 6. AgentKit wrapper (minimal stub of the abstract EvmWalletProvider shape) ----
class StubEvmWalletProvider { toSigner() { return { address: this.getAddress(), signTypedData: (td) => this.signTypedData(td) }; } }
const stubInner = () => {
  const calls = [];
  const rec = (m) => async (...a) => { calls.push(m); return "0xsig-" + m; };
  return { calls, getAddress: () => "0x2222222222222222222222222222222222222222", getNetwork: () => ({ chainId: "8453", networkId: "base-mainnet", protocolFamily: "evm" }), getName: () => "stub",
    signTypedData: rec("signTypedData"), sign: rec("sign"), signMessage: rec("signMessage"), signTransaction: rec("signTransaction"), sendTransaction: rec("sendTransaction"), nativeTransfer: rec("nativeTransfer") };
};

test("AgentKit VerifiedEvmWalletProvider: typed data only with an approval; other signing methods fail closed unless allowed", async () => {
  const V = makeVerifiedEvmWalletProvider(StubEvmWalletProvider);
  const store = new MemoryApprovals(), inner = stubInner();
  const w = new V(inner, { store, now: () => NOW });
  assert.ok(w instanceof StubEvmWalletProvider);
  await assert.rejects(w.toSigner().signTypedData(typedData({ nowS: NOW_S })), VerifyBeforeSignDenied);
  approved(store);
  assert.equal(await w.toSigner().signTypedData(typedData({ nowS: NOW_S })), "0xsig-signTypedData");
  for (const m of GATED) await assert.rejects(w[m]("x"), VerifyBeforeSignDenied, m);
  assert.deepEqual(inner.calls, ["signTypedData"]);
  const w2 = new V(inner, { store, allow: ["signMessage"] });
  assert.equal(await w2.signMessage("hi"), "0xsig-signMessage");
  assert.equal(w2.getName(), "stub");
});

// ---- 7. Turnkey viem account wrapper ----
test("Turnkey withVerifyBeforeSign: wraps signTypedData; every other sign* throws unless allowed", async () => {
  const inner = stubInner();
  const account = { address: inner.getAddress(), type: "local", source: "custom", signTypedData: inner.signTypedData, sign: inner.sign, signMessage: inner.signMessage, signTransaction: inner.signTransaction, signAuthorization: async () => "0xauth" };
  const store = new MemoryApprovals();
  const a = withVerifyBeforeSign(account, { store, now: () => NOW, chain: "eip155:8453" });
  await assert.rejects(a.signTypedData(typedData({ nowS: NOW_S })), /no approval/);
  approved(store);
  assert.equal(await a.signTypedData(typedData({ nowS: NOW_S })), "0xsig-signTypedData");
  for (const m of ["sign", "signMessage", "signTransaction", "signAuthorization"]) await assert.rejects(a[m]({}), VerifyBeforeSignDenied, m);
  assert.equal(a.address, account.address);
  assert.equal(await withVerifyBeforeSign(account, { store, allow: ["signAuthorization"] }).signAuthorization({}), "0xauth");
});

// ---- 8. end to end: hook -> approval -> wrapped signer, all stubbed ----
test("end to end: approved payment signs once; a changed payTo between check and sign is denied", async () => {
  const store = new MemoryApprovals();
  const hook = verifyBeforeSignHook({ store, checkOpts: { fetch: stubFacilFetch("match", KEY) } });
  const a = withVerifyBeforeSign({ signTypedData: async () => "0xsig" }, { store });
  const nowS = Math.floor(Date.now() / 1000);
  assert.equal(await hook(ctx()), undefined);
  await assert.rejects(a.signTypedData(typedData({ nowS, to: "0x" + "4".repeat(40) })), /no approval/);
  assert.equal(await hook(ctx()), undefined);
  assert.equal(await a.signTypedData(typedData({ nowS })), "0xsig");
});

// ---- 9. seen-nonce set is bounded: pruned once validBefore has passed, hard cap fails closed ----
test("nonces: replay inside the validity window is refused; expired entries are pruned (memory and OWS dir); cap fails closed", () => {
  const N = (b) => "0x" + b.repeat(32);
  for (const mk of [() => new MemoryApprovals(), () => new FileApprovals(mkdtempSync(join(tmpdir(), "vbs-nonce-")))]) {
    const s = mk();
    const count = () => (s instanceof MemoryApprovals ? s.nonces.size : readdirSync(s.dir).filter((f) => f.startsWith("nonce-")).length);
    approved(s);
    assert.equal(checkTypedData(s, typedData({ nowS: NOW_S, nonce: N("a1") }), { now: NOW }).allow, true); // validBefore = NOW_S + 60
    approved(s, { now: NOW + 50_000 });
    assert.match(checkTypedData(s, typedData({ nowS: NOW_S, nonce: N("a1") }), { now: NOW + 50_000 }).reason, /nonce already used/, "replay inside window");
    assert.equal(count(), 1);
    approved(s, { now: NOW + 66_000 });   // validBefore + 5 s slack has passed: the a1 entry is pruned on this check
    assert.equal(checkTypedData(s, typedData({ nowS: NOW_S + 66, nonce: N("b2") }), { now: NOW + 66_000 }).allow, true);
    assert.equal(count(), 1, "a1 pruned, only b2 left");
    if (s instanceof FileApprovals) {
      s.add(makeApproval(ACCEPTS, { url: RESOURCE, now: NOW }));   // expired approval file is cleaned up too
      s.prune(NOW + 61_000);
      assert.deepEqual(readdirSync(s.dir).filter((f) => f.endsWith(".json")), []);
    }
  }
  const capped = new MemoryApprovals({ maxNonces: 1 });
  approved(capped); approved(capped);
  assert.equal(checkTypedData(capped, typedData({ nowS: NOW_S, nonce: N("c3") }), { now: NOW }).allow, true);
  assert.match(checkTypedData(capped, typedData({ nowS: NOW_S, nonce: N("d4") }), { now: NOW }).reason, /store full/);
});
