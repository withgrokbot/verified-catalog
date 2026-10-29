// 0.51.1 security fixes: (b) settlement idempotency, (c) watch probe body cap, (d) SSRF IPv6/IPv4 forms. Network stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAndSettle, cfg, settlementKey } from "../worker/src/lib.js";
import { hostnameBlocked, isBlockedIp, assertSafeUrl, spotProbe } from "../worker/src/spotcheck.js";
import { probe } from "../worker/src/watch.js";

const PAY_TO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";
const PAYAI = "https://facilitator.payai.network";
const payload = (nonce = "0x" + "11".repeat(32)) => ({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO },
  payload: { signature: "0xsig", authorization: { from: "0x00000000000000000000000000000000000000b1", to: PAY_TO, value: "20000", nonce } } });
const SPOT = new URL("https://api.402xagent.com/v1/products/endpoint-spot-check");

function fakeDb() {
  const rows = new Map();
  return { rows, prepare(sql) { let args = []; return {
    bind(...a) { args = a; return this; },
    async first() { if (/^SELECT .* FROM settled_payments/.test(sql)) return rows.get(args[0]) || null; throw new Error("unexpected " + sql); },
    async run() { if (/^INSERT OR IGNORE INTO settled_payments/.test(sql)) { if (!rows.has(args[0])) rows.set(args[0], { resource: args[1], amount: args[2], settle: /'pending'/.test(sql) ? "{}" : args[3], facilitator: /'pending'/.test(sql) ? null : args[4], state: /'pending'/.test(sql) ? "pending" : null }); return { meta: { changes: 1 } }; }
      if (/^UPDATE settled_payments SET settle/.test(sql)) { const r = rows.get(args[args.length - 1]); if (r) Object.assign(r, { settle: args[0], facilitator: args[1], state: "settled" }); return { meta: { changes: r ? 1 : 0 } }; } // 0.59.2
      if (/^DELETE FROM settled_payments/.test(sql)) { if (rows.get(args[0]) && rows.get(args[0]).state === "pending") rows.delete(args[0]); return { meta: { changes: 1 } }; } throw new Error("unexpected " + sql); },
  }; } };
}
function stubFacilitator() {
  const used = new Set(), calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init = {}) => {
    const s = String(u); calls.push(s.slice(s.lastIndexOf("/")));
    const nonce = JSON.parse(init.body).paymentPayload.payload.authorization.nonce;
    if (s.endsWith("/verify")) return Response.json(used.has(nonce) ? { isValid: false, invalidReason: "nonce_already_used" } : { isValid: true, payer: "0xb1" });
    if (used.has(nonce)) return Response.json({ success: false, errorReason: "nonce_already_used" });
    used.add(nonce); return Response.json({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: "0xb1" });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("(b) a retry of the same signed payload after a lost response replays the settlement, never settles twice", async () => {
  const db = fakeDb(), c = cfg({ PAY_TO, FACILITATOR_URL: PAYAI, RECEIPTS_DB: db });
  const s = stubFacilitator();
  try {
    const first = await verifyAndSettle(c, payload(), SPOT);
    assert.equal(first.ok, true);
    const retry = await verifyAndSettle(c, payload(), SPOT);
    assert.equal(retry.ok, true, "retry gets the product, not a 402 that would make the client sign a second payment");
    assert.equal(retry.replayed, true);
    assert.equal(retry.settle.transaction, first.settle.transaction);
    assert.deepEqual(s.calls, ["/verify", "/settle"], "facilitator called once");
    const other = await verifyAndSettle(c, payload(), new URL("https://api.402xagent.com/v1/lookup/paid"));
    assert.equal(other.ok, false, "a settled payment cannot be replayed on another resource");
  } finally { s.restore(); }
});

test("(b) without the store (or before migration 0017) the 0.51.0 path is unchanged", async () => {
  const s = stubFacilitator();
  try {
    const c = cfg({ PAY_TO, FACILITATOR_URL: PAYAI });
    assert.equal((await verifyAndSettle(c, payload("0x" + "22".repeat(32)), SPOT)).ok, true);
    const broken = cfg({ PAY_TO, FACILITATOR_URL: PAYAI, RECEIPTS_DB: { prepare() { throw new Error("no such table"); } } });
    assert.equal((await verifyAndSettle(broken, payload("0x" + "33".repeat(32)), SPOT)).ok, true);
    assert.equal(await settlementKey(c, { payload: { authorization: { from: "x", nonce: "y" } } }), null);
  } finally { s.restore(); }
});

test("(c) watch probe stops reading past 64 KiB (stream cancelled), spotProbe likewise", async () => {
  let pulled = 0, cancelled = false;
  const big = () => new Response(new ReadableStream({ pull(ctl) { pulled += 65536; if (pulled > 50 * 1048576) { ctl.close(); return; } ctl.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } }), { status: 200 });
  const deps = { fetchImpl: async () => big(), resolveHostFn: async () => ["93.184.216.34"] };
  await probe("https://public.example.org/api", "GET", {}, deps);
  assert.ok(cancelled, "body stream cancelled at the cap");
  assert.ok(pulled <= 4 * 65536, "read at most a few chunks, not 50 MB (read " + pulled + ")");
  pulled = 0; cancelled = false;
  const p = await spotProbe("https://public.example.org/api", { fetchImpl: async () => big(), resolveHostFn: async () => ["93.184.216.34"] });
  assert.equal(p.body_truncated, true);
  assert.ok(pulled <= 4 * 65536);
});

test("(d) SSRF: mapped, compat, NAT64, 6to4, site-local, multicast and reserved forms are blocked; public stays allowed", async () => {
  const blocked = ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:a9fe:a9fe]", "[::127.0.0.1]", "[::7f00:1]", "[64:ff9b::10.0.0.1]", "[64:ff9b::a00:1]",
    "[2002:c0a8:101::1]", "[fec0::1]", "[ff02::1]", "[fc00::1]", "[fe80::1]", "[::1]", "[::]", "[0:0:0:0:0:0:0:1]", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.0.8",
    "127.1", "2130706433", "0x7f.0.0.1", "169.254.169.254"];
  for (const h of blocked) assert.equal(hostnameBlocked(new URL("http://" + h + "/").hostname), true, h);
  for (const a of ["::ffff:7f00:1", "64:ff9b::c0a8:1", "fd00::1", "::ffff:10.0.0.1"]) assert.equal(isBlockedIp(a), true, a); // DoH AAAA answers
  for (const h of ["8.8.8.8", "[2606:4700:4700::1111]", "[64:ff9b::808:808]"]) assert.equal(hostnameBlocked(new URL("http://" + h + "/").hostname), false, h);
  assert.equal((await assertSafeUrl("http://[::ffff:127.0.0.1]/")).ok, false);
  assert.equal((await assertSafeUrl("https://rebind.example/", { resolveHostFn: async () => ["::ffff:7f00:1"] })).ok, false);
});

test("(d) every redirect hop is re-checked, including a hop to a mapped IPv6 literal", async () => {
  const seen = [];
  const fetchImpl = async (u) => { seen.push(String(u)); return new Response("", { status: 302, headers: { location: "http://[::ffff:169.254.169.254]/latest/meta-data/" } }); };
  const p = await spotProbe("https://public.example.org/api", { fetchImpl, resolveHostFn: async () => ["93.184.216.34"] });
  assert.equal(p.ssrf_blocked, true);
  assert.match(p.error, /redirect blocked/);
  assert.equal(seen.length, 1, "the blocked hop is never fetched");
});
