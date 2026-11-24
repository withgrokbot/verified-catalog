// 0.78.0 settlement matching (worker/src/settle.js, migration 0035). Real SQLite behind the D1 adapter; RPC is mocked
// (it filters logs by block range and payTo topic like a node). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { VERSION } from "../worker/src/lib.js";
import { sqliteD1 } from "./helpers/sqlite_d1.mjs";
import { settleTick, settleWeekly, settleWeeklyText, classify, delayBucket, quotesFromReceipt, settleCfg, SETTLE_CAVEAT } from "../worker/src/settle.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const OURS = "0x37cfcc8a29e9ff9458902b29e31e42dc7b718674";
const P1 = "0x1111111111111111111111111111111111111111";
const P2 = "0x2222222222222222222222222222222222222222";
const BUYER = "0x9999999999999999999999999999999999999999";
const NOW = new Date("2026-11-24T12:00:00Z");
const HEAD = 1_000_000;
const pad = (a) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
const hx = (n) => "0x" + BigInt(n).toString(16);
const blockAt = (iso) => HEAD - Math.round((NOW.getTime() - Date.parse(iso)) / 200);
let txn = 0;
const mkLog = ({ to, value, at, from = BUYER, address = USDC }) => { txn++; const bn = blockAt(at); return { address, topics: [TRANSFER, pad(from), pad(to)], data: hx(value), blockNumber: hx(bn), blockTimestamp: hx(Math.floor(Date.parse(at) / 1000)), transactionHash: "0x" + ("ab" + txn.toString(16)).padEnd(64, "c"), logIndex: hx(7 + txn), blockHash: "0x" + "d".repeat(64), removed: false }; };

function mockRpc(logs, { failLogs = false } = {}) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ method, params });
    if (method === "eth_getBlockByNumber") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: hx(HEAD), timestamp: hx(NOW.getTime() / 1000) } }));
    if (method === "eth_getLogs") {
      if (failLogs) return new Response("bad", { status: 503 });
      const q = params[0], a = Number(BigInt(q.fromBlock)), b = Number(BigInt(q.toBlock)), tos = new Set(q.topics[2]);
      const out = logs.filter((l) => l.address.toLowerCase() === q.address && Number(BigInt(l.blockNumber)) >= a && Number(BigInt(l.blockNumber)) <= b && tos.has(l.topics[2]));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: out }));
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1 } }));
  };
  return { fetchImpl, calls };
}
function receipt(db, { id, url, at, verdict = "pay", accepts, type = "live" }) {
  const body = { id, url, method: "GET", checked_at: at, verdict, live_402: { http_status: 402, x402_challenge: true, accepts } };
  db.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, body) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, url, at, verdict, "ok", type, JSON.stringify(body));
}
const base = (pay_to, amount_atomic, extra = {}) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount_atomic, pay_to, ...extra });
const ENV = (db) => ({ RECEIPTS_DB: db, SETTLE_MATCH: "1", PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674" });
const rows = (db, t) => db.raw.prepare(`SELECT * FROM ${t}`).all();
const quiet = async (fn) => { const orig = console.log, lines = []; console.log = (...a) => lines.push(a.join(" ")); try { return [await fn(), lines]; } finally { console.log = orig; } };

function scenario() {
  const db = sqliteD1();
  receipt(db, { id: "sc-a", url: "https://a.test/api", at: "2026-11-24T11:50:00Z", verdict: "pay", accepts: [base(P1, "20000")] });
  receipt(db, { id: "sc-b", url: "https://b.test/api", at: "2026-11-24T11:50:00Z", verdict: "skip", accepts: [base(P2, "50000")] });
  receipt(db, { id: "sc-net", url: "https://c.test/api", at: "2026-11-24T11:50:00Z", accepts: [base(P1, "20000", { network: "eip155:84532" })] });
  receipt(db, { id: "sc-asset", url: "https://d.test/api", at: "2026-11-24T11:50:00Z", accepts: [base(P1, "20000", { asset: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb" })] });
  receipt(db, { id: "sc-self", url: "https://e.test/api", at: "2026-11-24T11:50:00Z", accepts: [base(P1, "20000")], type: "self-checked" });
  const logs = [
    mkLog({ to: P1, value: 20000, at: "2026-11-24T11:52:00Z" }),          // exact -> sc-a, 1_5m
    mkLog({ to: P1, value: 20500, at: "2026-11-24T11:53:00Z" }),          // near (2.5%) -> sc-a, separate
    mkLog({ to: P1, value: 90000, at: "2026-11-24T11:54:00Z" }),          // no match (other)
    mkLog({ to: P1, value: 20000, at: "2026-11-24T11:49:00Z" }),          // before the check: other
    mkLog({ to: P1, value: 20000, at: "2026-11-24T11:55:00Z", from: OURS }), // our own wallet: excluded
    mkLog({ to: P1, value: 20000, at: "2026-11-24T11:56:00Z", address: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb" }), // other token: ignored
    mkLog({ to: P2, value: 50000, at: "2026-11-24T11:58:30Z" }),          // exact -> sc-b, 5_15m
  ];
  return { db, logs };
}

test("0.78.0 version", () => assert.equal(VERSION, "0.78.0"));

test("classify: exact, near (own tier), none; tolerance documented as 5% with a 1-unit floor", () => {
  assert.equal(classify("20000", "20000"), "exact");
  assert.equal(classify("21000", "20000"), "near");
  assert.equal(classify("19000", "20000"), "near");
  assert.equal(classify("21001", "20000"), null);
  assert.equal(classify("2", "1"), "near"); // floor of 1 atomic unit
  assert.equal(classify("3", "1"), null);
  assert.equal(settleCfg({}).windowH, 6);
  assert.equal(settleCfg({}).nearBps, 500);
  assert.deepEqual([30, 61, 400, 1000, 4000, 30000].map(delayBucket), ["lt1m", "1_5m", "5_15m", "15_60m", "1_6h", "6_24h"]);
});

test("quotes: only Base USDC exact-scheme quotes; wrong network, asset or upto are ignored", () => {
  const mk = (accepts) => ({ id: "x", url: "u", created_at: "2026-11-24T11:00:00Z", verdict: "pay", body: JSON.stringify({ live_402: { accepts } }) });
  assert.equal(quotesFromReceipt(mk([base(P1, "1")])).length, 1);
  assert.equal(quotesFromReceipt(mk([base(P1, "1", { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })])).length, 0);
  assert.equal(quotesFromReceipt(mk([base(P1, "1", { asset: "0x0000000000000000000000000000000000000001" })])).length, 0);
  assert.equal(quotesFromReceipt(mk([base(P1, "1", { scheme: "upto" })])).length, 0);
  assert.equal(quotesFromReceipt(mk([base("not-an-address", "1")])).length, 0);
});

test("exact match, near kept separate, no match, wrong asset/network ignored, self excluded", async () => {
  const { db, logs } = scenario();
  const { fetchImpl, calls } = mockRpc(logs);
  const [r] = await quiet(() => settleTick(ENV(db), NOW, { fetchImpl }));
  assert.equal(r.did, "scanned");
  const sc = Object.fromEntries(rows(db, "settle_checks").map((x) => [x.check_id, x]));
  assert.deepEqual(Object.keys(sc).sort(), ["sc-a", "sc-b"]); // no row for the testnet, other-asset or self-checked receipts
  assert.equal(sc["sc-a"].exact_n, 1);
  assert.equal(sc["sc-a"].near_n, 1);
  assert.equal(sc["sc-a"].exact_first_bucket, "1_5m");
  assert.equal(sc["sc-a"].near_first_bucket, "1_5m");
  assert.equal(sc["sc-a"].near_min_atomic, "20500");
  assert.equal(sc["sc-a"].near_max_atomic, "20500");
  assert.equal(sc["sc-a"].last_observed_day, "2026-11-24");
  assert.equal(sc["sc-b"].exact_n, 1);
  assert.equal(sc["sc-b"].near_n, 0);
  assert.equal(sc["sc-b"].exact_first_bucket, "5_15m");
  assert.equal(r.exact_n, 2);
  assert.equal(r.near_n, 1);
  assert.equal(r.other_n, 2); // 90000 and the pre-check transfer
  assert.equal(r.self_excluded, 1);
  const run = rows(db, "settle_runs_daily")[0];
  assert.equal(run.exact_n, 2); assert.equal(run.near_n, 1); assert.equal(run.log_queries, 1); assert.equal(run.runs, 1);
  // one head call + one getLogs (one range, both payTos in one topic OR list)
  assert.deepEqual(calls.map((c) => c.method), ["eth_getBlockByNumber", "eth_getLogs"]);
  assert.deepEqual(calls[1].params[0].topics[2].sort(), [pad(P1), pad(P2)]);
  // second run: cursor moved, nothing new, same counts (each block is scanned once)
  await quiet(() => settleTick(ENV(db), NOW, { fetchImpl }));
  assert.equal(rows(db, "settle_checks").find((x) => x.check_id === "sc-a").exact_n, 1);
});

test("no sender, tx hash, block number, log index or exact time is ever persisted or logged", async () => {
  const { db, logs } = scenario();
  const { fetchImpl } = mockRpc(logs);
  const [, lines] = await quiet(() => settleTick(ENV(db), NOW, { fetchImpl }));
  const forbidden = [BUYER.slice(2), OURS.slice(2), "d".repeat(64)];
  for (const l of logs) {
    forbidden.push(l.transactionHash.slice(2), String(Number(BigInt(l.blockNumber))), l.blockNumber.slice(2));
    forbidden.push(new Date(Number(BigInt(l.blockTimestamp)) * 1000).toISOString().slice(11, 19)); // exact HH:MM:SS
  }
  const blob = JSON.stringify([rows(db, "settle_checks"), rows(db, "settle_runs_daily"), rows(db, "settle_state").filter((x) => x.k !== "block")]) + lines.join("\n");
  for (const f of forbidden) assert.ok(!blob.toLowerCase().includes(f.toLowerCase()), "persisted or logged: " + f);
  const cols = db.raw.prepare("SELECT name FROM pragma_table_info('settle_checks')").all().map((c) => c.name);
  for (const c of cols) assert.doesNotMatch(c, /from|sender|payer|buyer|hash|tx|block|log_index/);
  // the only block number stored is our own scan cursor (safe head), not a transfer's block
  assert.equal(rows(db, "settle_state").find((x) => x.k === "block").v, String(HEAD - 60));
});

test("flag off: no D1 read, no RPC call", async () => {
  const boom = { prepare() { throw new Error("db touched"); }, batch() { throw new Error("db touched"); } };
  const r = await settleTick({ RECEIPTS_DB: boom }, NOW, { fetchImpl: () => { throw new Error("fetch called"); } });
  assert.deepEqual(r, { did: "off" });
  assert.deepEqual(await settleTick({ RECEIPTS_DB: boom, SETTLE_MATCH: "0" }, NOW, { fetchImpl: () => { throw new Error("fetch called"); } }), { did: "off" });
});

test("RPC failure keeps the block cursor; getLogs batches payTos and respects the per-run caps", async () => {
  const db = sqliteD1();
  const accepts = Array.from({ length: 120 }, (_, i) => base("0x" + (0x1000 + i).toString(16).padStart(40, "0"), "1000"));
  receipt(db, { id: "sc-many", url: "https://m.test/api", at: "2026-11-24T11:50:00Z", accepts });
  const bad = mockRpc([], { failLogs: true });
  const [r1] = await quiet(() => settleTick(ENV(db), NOW, { fetchImpl: bad.fetchImpl }));
  assert.equal(r1.blocks, 0);
  assert.equal(rows(db, "settle_state").find((x) => x.k === "block"), undefined);
  const ok = mockRpc([]);
  const [r2] = await quiet(() => settleTick({ ...ENV(db), SETTLE_BLOCKS_PER_RUN: "12000" }, NOW, { fetchImpl: ok.fetchImpl }));
  assert.equal(r2.log_queries, 3); // first run: one 5,000-block range x ceil(120 / 50) topic batches
  assert.ok(ok.calls.filter((c) => c.method === "eth_getLogs").every((c) => c.params[0].topics[2].length <= 50 && Number(BigInt(c.params[0].toBlock)) - Number(BigInt(c.params[0].fromBlock)) < 5000));
});

test("weekly summary: per-endpoint activity, verdict split, tiers apart, caveat always present", async () => {
  const { db, logs } = scenario();
  const { fetchImpl } = mockRpc(logs);
  await quiet(() => settleTick(ENV(db), NOW, { fetchImpl }));
  const s = await settleWeekly(db, { now: NOW });
  assert.equal(s.caveat, SETTLE_CAVEAT);
  assert.match(s.caveat, /never means the endpoint was not paid/);
  assert.match(s.caveat, /cannot link a payer to whoever requested a check/);
  assert.match(s.framing, /not what callers did with our verdicts/);
  assert.equal(s.totals.checks, 2);
  assert.equal(s.totals.with_exact, 2);
  assert.equal(s.totals.exact_transfers, 2);
  assert.equal(s.totals.near_transfers, 1);
  assert.deepEqual(s.totals.by_verdict.pay, { checks: 1, with_exact: 1, with_near_only: 0 });
  assert.deepEqual(s.totals.by_verdict.skip, { checks: 1, with_exact: 1, with_near_only: 0 });
  const a = s.endpoints.find((e) => e.url === "https://a.test/api");
  assert.equal(a.exact_transfers, 1); assert.equal(a.near_transfers, 1); assert.equal(a.near_min_atomic, "20500");
  assert.equal(a.time_to_first_exact["1_5m"], 1);
  const txt = settleWeeklyText(s);
  assert.ok(txt.includes("caveat: " + SETTLE_CAVEAT));
  assert.ok(!JSON.stringify(s).includes(BUYER.slice(2)));
});

test("/v1/ops/stats: settlement section only with SETTLE_MATCH=1, with the caveat; no new public route", async () => {
  const { db, logs } = scenario();
  await quiet(() => settleTick(ENV(db), NOW, { fetchImpl: mockRpc(logs).fetchImpl }));
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const get = (env) => worker.fetch(new Request("https://api.402xagent.com/v1/ops/stats", { headers: { authorization: "Bearer t" } }), { WATCH_STATS_TOKEN: "t", RECEIPTS_DB: db, ...env }, ctx);
  const off = await (await get({})).json();
  assert.equal("settlement_activity" in off, false);
  const on = await (await get({ SETTLE_MATCH: "1" })).json();
  assert.equal(on.settlement_activity.caveat, SETTLE_CAVEAT);
  for (const p of ["/v1/settlement", "/v1/settlements", "/settlement"]) {
    const r = await worker.fetch(new Request("https://api.402xagent.com" + p), { SETTLE_MATCH: "1", RECEIPTS_DB: db }, ctx);
    assert.equal(r.status, 404);
  }
});

// Follow-up: ambiguous attribution, DRILL_WALLETS exclusion, ops_weekly.sh gated on SETTLE_MATCH.
test("ambiguous_n: two endpoints share a payTo and amount; the transfer counts once, on the latest check, flagged ambiguous", async () => {
  const db = sqliteD1();
  receipt(db, { id: "sc-old", url: "https://x.test/one", at: "2026-11-24T11:48:00Z", accepts: [base(P1, "20000")] });
  receipt(db, { id: "sc-new", url: "https://x.test/two", at: "2026-11-24T11:50:00Z", verdict: "recheck", accepts: [base(P1, "20000")] });
  const logs = [mkLog({ to: P1, value: 20000, at: "2026-11-24T11:51:00Z" })];
  const [r] = await quiet(() => settleTick(ENV(db), NOW, { fetchImpl: mockRpc(logs).fetchImpl }));
  const sc = Object.fromEntries(rows(db, "settle_checks").map((x) => [x.check_id, x]));
  assert.equal(r.exact_n, 1);
  assert.equal(sc["sc-new"].exact_n, 1);
  assert.equal(sc["sc-new"].ambiguous_n, 1);
  assert.equal(sc["sc-old"].exact_n, 0);
  assert.equal(sc["sc-old"].ambiguous_n, 0);
  // same endpoint checked twice is not ambiguous
  const db2 = sqliteD1();
  receipt(db2, { id: "sc-1", url: "https://x.test/one", at: "2026-11-24T11:48:00Z", accepts: [base(P1, "20000")] });
  receipt(db2, { id: "sc-2", url: "https://x.test/one", at: "2026-11-24T11:50:00Z", accepts: [base(P1, "20000")] });
  await quiet(() => settleTick(ENV(db2), NOW, { fetchImpl: mockRpc(logs).fetchImpl }));
  assert.deepEqual(rows(db2, "settle_checks").map((x) => [x.check_id, x.exact_n, x.ambiguous_n]).sort(), [["sc-1", 0, 0], ["sc-2", 1, 0]]);
});

test("DRILL_WALLETS and SETTLE_SELF_WALLETS senders are excluded and never stored", async () => {
  const DRILL = "0xa880153A381Fc8d9AF0933a4c8a69fA32De6Ef22", EXTRA = "0x7777777777777777777777777777777777777777";
  const db = sqliteD1();
  receipt(db, { id: "sc-a", url: "https://a.test/api", at: "2026-11-24T11:50:00Z", accepts: [base(P1, "20000")] });
  const logs = [
    mkLog({ to: P1, value: 20000, at: "2026-11-24T11:51:00Z", from: DRILL }),
    mkLog({ to: P1, value: 20000, at: "2026-11-24T11:52:00Z", from: EXTRA }),
    mkLog({ to: P1, value: 20500, at: "2026-11-24T11:53:00Z", from: DRILL }),
  ];
  const [r, lines] = await quiet(() => settleTick({ ...ENV(db), DRILL_WALLETS: DRILL + ", not-a-wallet", SETTLE_SELF_WALLETS: EXTRA }, NOW, { fetchImpl: mockRpc(logs).fetchImpl }));
  assert.equal(r.self_excluded, 3);
  assert.equal(r.exact_n, 0);
  assert.equal(r.near_n, 0);
  const sc = rows(db, "settle_checks")[0];
  assert.equal(sc.exact_n, 0); assert.equal(sc.near_n, 0);
  assert.equal(rows(db, "settle_runs_daily")[0].self_excluded, 3);
  const blob = (JSON.stringify([rows(db, "settle_checks"), rows(db, "settle_runs_daily"), rows(db, "settle_state")]) + lines.join("\n")).toLowerCase();
  for (const w of [DRILL, EXTRA]) assert.ok(!blob.includes(w.toLowerCase().slice(2)));
  // without DRILL_WALLETS the same drill transfer would count: the exclusion is what kept it out
  const db2 = sqliteD1();
  receipt(db2, { id: "sc-a", url: "https://a.test/api", at: "2026-11-24T11:50:00Z", accepts: [base(P1, "20000")] });
  const [r2] = await quiet(() => settleTick(ENV(db2), NOW, { fetchImpl: mockRpc([logs[0]]).fetchImpl }));
  assert.equal(r2.exact_n, 1);
});

test("ops_weekly.sh: settlement section only when wrangler.toml sets SETTLE_MATCH = \"1\"; caveat inside the gated block", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const sh = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "scripts", "ops_weekly.sh"), "utf8");
  const i = sh.indexOf("if grep -Eq '^SETTLE_MATCH *= *\"1\"' wrangler.toml; then");
  assert.ok(i > 0);
  const block = sh.slice(i, sh.indexOf("\nfi", i));
  assert.match(block, /never means the endpoint was not paid/);
  assert.match(block, /settle_checks/);
  assert.match(block, /else\n  echo "== settlement activity: SETTLE_MATCH is off/);
  assert.equal(sh.slice(0, i).includes("settle_checks"), false, "no settle query outside the gate");
});
