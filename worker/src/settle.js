// 0.78.0 settlement matching. Record-only, OFF unless SETTLE_MATCH=1. No routes, nothing public; migration 0035.
//
// For every live spot check that quoted Base USDC (eip155:8453) we already store the seller's payTo, the quoted amount
// and checked_at on the receipt. The */20 cron copies those quotes into settle_checks, then reads USDC Transfer logs
// TO the watched payTo addresses (eth_getLogs, block ranges, payTo topic filter, block cursor) and counts transfers
// that land within SETTLE_WINDOW_H hours after a check:
//   exact (high confidence): value == quoted amount
//   near  (low confidence):  0 < |value - quoted| <= max(1, quoted * SETTLE_NEAR_BPS / 10000); own columns, never
//                            merged into exact
// This describes settlement activity per endpoint (does it settle, how often, amounts, time-to-settle, split by our
// verdict). It is NOT a measure of callers acting on our verdicts: we cannot link a payer to whoever asked for a check.
//
// PRIVACY: the sender wallet is read from the log only to drop our own wallets and is then discarded. Tx hash, block
// number, log index and exact transfer time are never stored, logged or returned. Time survives only as a delay bucket
// and a UTC day.
// CAVEAT: absence of an observed settlement never means "not paid" (see SETTLE_CAVEAT).
import { USDC_BASE_LC, TOPIC_TRANSFER, PS_DEFAULT_RPC2 } from "./paystatus.js";

export const SETTLE_NETWORK = "eip155:8453";
export const SETTLE_CAVEAT = "Absence of an observed settlement never means the endpoint was not paid. We only watch Base USDC transfers to the payTo quoted in the check, within the window after it; payments on other networks or assets, outside the window, to another address, batched, off-chain, or in blocks we skipped are not seen, and RPC sources can miss logs. We cannot link a payer to whoever requested a check, so these counts describe settlement activity per endpoint, not what callers did with our verdicts.";
export const SETTLE_BUCKETS = ["lt1m", "1_5m", "5_15m", "15_60m", "1_6h", "6_24h"];
export const settleOn = (env) => String((env && env.SETTLE_MATCH) || "") === "1";

const int = (v, d, lo, hi) => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
export function settleCfg(env = {}) {
  return {
    windowH: int(env.SETTLE_WINDOW_H, 6, 1, 24),
    nearBps: int(env.SETTLE_NEAR_BPS, 500, 1, 2000),
    blocksPerRun: int(env.SETTLE_BLOCKS_PER_RUN, 12000, 100, 100000), // Base ~0.2 s blocks: 6,000 per 20 min, so 2x lets a lagging cursor catch up
    rangeBlocks: int(env.SETTLE_RANGE_BLOCKS, 5000, 100, 10000),      // per eth_getLogs (keyless publicnode tested to 50k)
    topicsPerQuery: int(env.SETTLE_TOPICS_PER_QUERY, 50, 1, 100),
    maxLogQueries: int(env.SETTLE_MAX_LOG_QUERIES, 24, 1, 200),
    confirmBlocks: int(env.SETTLE_CONFIRM_BLOCKS, 60, 0, 10000),     // ~12 s behind head (reorg margin)
    blockMs: int(env.SETTLE_BLOCK_MS, 200, 50, 5000),                // fallback only; logs carry blockTimestamp
    receiptsPerRun: int(env.SETTLE_RECEIPTS_PER_RUN, 500, 1, 2000),
    openChecksMax: int(env.SETTLE_OPEN_CHECKS_MAX, 3000, 10, 20000),
    retentionDays: 400,
  };
}

/** Keyed sources first; the keyless default is Allnodes publicnode (no secret). URLs are never logged or returned. */
export function settleRpcSources(env = {}) {
  const out = [];
  for (const [name, url] of [["settle", env.SETTLE_RPC_URL], ["rpc3", env.RPC3_BASE_URL], ["rpc2", env.RPC2_BASE_URL === "off" ? "" : env.RPC2_BASE_URL || PS_DEFAULT_RPC2]]) {
    if (typeof url === "string" && /^https:\/\//.test(url) && !out.some((s) => s.url === url)) out.push({ name, url });
  }
  return out;
}

const lc = (s) => String(s || "").toLowerCase();
const HEX40 = /^0x[0-9a-f]{40}$/;
const pad32 = (a) => "0x" + lc(a).replace(/^0x/, "").padStart(64, "0");
const isoS = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Base USDC quotes in one stored receipt row ({id, url, created_at, verdict, body}). Other networks/assets: none. */
export function quotesFromReceipt(row, cfg = settleCfg()) {
  let b;
  try { b = typeof row.body === "string" ? JSON.parse(row.body) : row.body || {}; } catch (_) { return []; }
  const accepts = (b && b.live_402 && Array.isArray(b.live_402.accepts)) ? b.live_402.accepts : [];
  const checkedAt = row.created_at || b.checked_at;
  const t = Date.parse(checkedAt);
  if (!Number.isFinite(t)) return [];
  const out = [];
  accepts.forEach((a, i) => {
    if (!a || !(a.network === SETTLE_NETWORK || a.network === "base")) return;
    if (lc(a.asset) !== USDC_BASE_LC) return;
    if (a.scheme && a.scheme !== "exact") return; // "upto" has no fixed amount to match
    const payTo = lc(a.pay_to), amt = String(a.amount_atomic ?? "");
    if (!HEX40.test(payTo) || !/^[1-9][0-9]{0,30}$/.test(amt)) return;
    out.push({ check_id: row.id, opt: i, url: row.url, method: String(b.method || "GET").toUpperCase().slice(0, 10), verdict: String(row.verdict || b.verdict || ""), pay_to: payTo, amount_atomic: amt, checked_at: isoS(t), window_end: isoS(t + cfg.windowH * 3600000) });
  });
  return out;
}

export function classify(value, quoted, cfg = settleCfg()) {
  const v = BigInt(value), q = BigInt(quoted);
  if (v === q) return "exact";
  const tol = (q * BigInt(cfg.nearBps)) / 10000n;
  const d = v > q ? v - q : q - v;
  return d <= (tol > 1n ? tol : 1n) ? "near" : null;
}

export function delayBucket(sec) {
  if (sec < 60) return "lt1m";
  if (sec < 300) return "1_5m";
  if (sec < 900) return "5_15m";
  if (sec < 3600) return "15_60m";
  if (sec < 21600) return "1_6h";
  return "6_24h";
}

/** One raw log -> { to, value, ts } | { self: true } | null. Sender, tx hash, block and log index are not returned. */
export function parseTransferLog(log, { selfSet = new Set(), head = null, blockMs = 200 } = {}) {
  if (!log || log.removed === true || lc(log.address) !== USDC_BASE_LC) return null;
  const tp = log.topics || [];
  if (lc(tp[0]) !== TOPIC_TRANSFER || tp.length < 3) return null;
  if (selfSet.has("0x" + lc(tp[1]).slice(-40))) return { self: true }; // the sender is looked at for this test only
  let value;
  try { value = BigInt(log.data || "0x0").toString(); } catch (_) { return null; }
  let ts = null;
  if (log.blockTimestamp != null) ts = Number(BigInt(log.blockTimestamp)) * 1000;
  else if (head && log.blockNumber != null) ts = head.ts - (head.n - Number(BigInt(log.blockNumber))) * blockMs;
  if (!Number.isFinite(ts)) return null;
  return { to: "0x" + lc(tp[2]).slice(-40), value, ts };
}

/** Attribute transfers to open checks. Each transfer counts once: exact beats near; the latest check whose window
 *  covers the transfer wins. Returns per-check deltas keyed "check_id|opt" and run counters. */
export function matchTransfers(transfers, checks, cfg = settleCfg()) {
  const byPayTo = new Map();
  for (const c of checks) {
    const x = { ...c, _t0: Date.parse(c.checked_at), _t1: Date.parse(c.window_end) };
    (byPayTo.get(c.pay_to) || byPayTo.set(c.pay_to, []).get(c.pay_to)).push(x);
  }
  const deltas = new Map();
  const counts = { exact_n: 0, near_n: 0, other_n: 0 };
  const latest = (a, b) => (a._t0 !== b._t0 ? b._t0 - a._t0 : String(b.check_id).localeCompare(String(a.check_id)));
  for (const t of transfers) {
    const cands = (byPayTo.get(t.to) || []).filter((c) => t.ts >= c._t0 && t.ts <= c._t1);
    const tiers = cands.map((c) => [c, classify(t.value, c.amount_atomic, cfg)]);
    let tier = "exact", pool = tiers.filter(([, k]) => k === "exact").map(([c]) => c);
    if (!pool.length) { tier = "near"; pool = tiers.filter(([, k]) => k === "near").map(([c]) => c); }
    if (!pool.length) { counts.other_n++; continue; }
    if (tier === "near") pool.sort((a, b) => { const da = BigInt(t.value) - BigInt(a.amount_atomic), db = BigInt(t.value) - BigInt(b.amount_atomic); const x = (da < 0n ? -da : da) - (db < 0n ? -db : db); return x !== 0n ? (x < 0n ? -1 : 1) : latest(a, b); });
    else pool.sort(latest);
    const c = pool[0];
    const key = c.check_id + "|" + c.opt;
    const d = deltas.get(key) || { check_id: c.check_id, opt: c.opt, exact_n: 0, near_n: 0, ambiguous_n: 0, exact_first_bucket: null, near_first_bucket: null, _ef: Infinity, _nf: Infinity, near_min_atomic: null, near_max_atomic: null, last_observed_day: null, _last: 0 };
    const delayS = Math.max(0, (t.ts - c._t0) / 1000);
    if (new Set(pool.map((p) => p.url + " " + p.method)).size > 1) d.ambiguous_n++;
    if (tier === "exact") { d.exact_n++; counts.exact_n++; if (delayS < d._ef) { d._ef = delayS; d.exact_first_bucket = delayBucket(delayS); } }
    else {
      d.near_n++; counts.near_n++;
      if (delayS < d._nf) { d._nf = delayS; d.near_first_bucket = delayBucket(delayS); }
      const v = BigInt(t.value);
      if (d.near_min_atomic == null || v < BigInt(d.near_min_atomic)) d.near_min_atomic = v.toString();
      if (d.near_max_atomic == null || v > BigInt(d.near_max_atomic)) d.near_max_atomic = v.toString();
    }
    if (t.ts > d._last) { d._last = t.ts; d.last_observed_day = dayOf(t.ts); }
    deltas.set(key, d);
  }
  for (const d of deltas.values()) { delete d._ef; delete d._nf; delete d._last; }
  return { deltas: [...deltas.values()], counts };
}

async function rpcCall(src, method, params, fetchImpl, timeoutMs = 4000) {
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(src.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), ...(ac ? { signal: ac.signal } : {}) });
    if (!r.ok) throw new Error("http_" + r.status);
    const j = await r.json();
    if (!j || j.error) throw new Error("rpc_error");
    return j.result;
  } catch (e) {
    throw new Error(/^(http_\d+|rpc_error)$/.test(e && e.message) ? e.message : "unreachable"); // never the URL
  } finally { if (timer) clearTimeout(timer); }
}
/** First source that answers; counts every attempt. Throws "all_sources_failed" (no URL) when none does. */
async function rpcAny(sources, method, params, fetchImpl, stat) {
  for (const s of sources) {
    stat.rpc_calls++;
    try { return await rpcCall(s, method, params, fetchImpl); } catch (_) { stat.rpc_errors++; }
  }
  throw new Error("all_sources_failed");
}

function selfWallets(env) {
  const s = new Set();
  for (const w of [env.PAY_TO, ...String(env.DRILL_WALLETS || "").split(","), ...String(env.SETTLE_SELF_WALLETS || "").split(",")]) { const x = lc(String(w || "").trim()); if (HEX40.test(x)) s.add(x); }
  return s;
}

/** One every-20-minutes cron step. Flag off: returns immediately, no D1 or network access. */
export async function settleTick(env, now = new Date(), { fetchImpl = globalThis.fetch } = {}) {
  if (!settleOn(env)) return { did: "off" };
  const db = env.RECEIPTS_DB;
  if (!db) return { did: "no-db" };
  const cfg = settleCfg(env);
  const nowMs = now.getTime(), nowIso = isoS(nowMs), day = dayOf(nowMs);
  const stat = { runs: 1, blocks: 0, gap_blocks: 0, log_queries: 0, rpc_calls: 0, rpc_errors: 0, logs_seen: 0, exact_n: 0, near_n: 0, other_n: 0, self_excluded: 0, checks_added: 0 };
  const st = Object.fromEntries((((await db.prepare("SELECT k, v FROM settle_state").all()) || {}).results || []).map((r) => [r.k, r.v]));

  // 1) new live receipts -> settle_checks
  const [rcAt, rcId] = st.receipts ? String(st.receipts).split("|") : [isoS(nowMs - cfg.windowH * 3600000), ""];
  const rows = ((await db.prepare("SELECT id, url, created_at, verdict, body FROM spot_receipts WHERE check_type = 'live' AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?").bind(rcAt, rcAt, rcId, cfg.receiptsPerRun).all()) || {}).results || [];
  const ins = [];
  for (const r of rows) for (const q of quotesFromReceipt(r, cfg)) ins.push(db.prepare("INSERT OR IGNORE INTO settle_checks (check_id, opt, url, method, verdict, pay_to, amount_atomic, checked_at, window_end, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(q.check_id, q.opt, q.url, q.method, q.verdict, q.pay_to, q.amount_atomic, q.checked_at, q.window_end, nowIso));
  stat.checks_added = ins.length;
  const writes = [...ins];
  if (rows.length) { const l = rows[rows.length - 1]; writes.push(stateStmt(db, "receipts", l.created_at + "|" + l.id, nowIso)); }
  if (writes.length) await db.batch(writes);

  // 2) block range
  const sources = settleRpcSources(env);
  let head;
  try { const b = await rpcAny(sources, "eth_getBlockByNumber", ["latest", false], fetchImpl, stat); head = { n: Number(BigInt(b.number)), ts: Number(BigInt(b.timestamp)) * 1000 }; }
  catch (_) { await saveRun(db, day, stat); return { did: "rpc_error", ...stat }; }
  const safe = head.n - cfg.confirmBlocks;
  const maxLag = Math.ceil((cfg.windowH * 3600000) / cfg.blockMs);
  let from = st.block != null ? Number(st.block) + 1 : safe - cfg.rangeBlocks + 1;
  if (safe - from + 1 > maxLag) { stat.gap_blocks = safe - maxLag + 1 - from; from = safe - maxLag + 1; }
  const to = Math.min(safe, from + cfg.blocksPerRun - 1);
  if (to < from) { await saveRun(db, day, stat); return { did: "caught_up", ...stat }; }

  // 3) open checks (windows that can still cover blocks in this range)
  const fromTs = head.ts - (head.n - from) * cfg.blockMs;
  const open = ((await db.prepare("SELECT check_id, opt, url, method, verdict, pay_to, amount_atomic, checked_at, window_end FROM settle_checks WHERE window_end >= ? AND checked_at <= ? ORDER BY checked_at DESC LIMIT ?").bind(isoS(fromTs - 60000), nowIso, cfg.openChecksMax).all()) || {}).results || [];
  const payTos = [...new Set(open.map((c) => c.pay_to))].sort();
  let scannedTo = from - 1;
  const transfers = [];
  if (!payTos.length) scannedTo = to; // nothing to watch: move the cursor without a log query
  else {
    const selfSet = selfWallets(env);
    outer: for (let a = from; a <= to; a += cfg.rangeBlocks) {
      const b = Math.min(to, a + cfg.rangeBlocks - 1);
      const got = [];
      for (let i = 0; i < payTos.length; i += cfg.topicsPerQuery) {
        if (stat.log_queries >= cfg.maxLogQueries) break outer;
        stat.log_queries++;
        let logs;
        try { logs = await rpcAny(sources, "eth_getLogs", [{ address: USDC_BASE_LC, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16), topics: [TOPIC_TRANSFER, null, payTos.slice(i, i + cfg.topicsPerQuery).map(pad32)] }], fetchImpl, stat); }
        catch (_) { break outer; } // keep the cursor at the last complete range
        got.push(...(Array.isArray(logs) ? logs : []));
      }
      stat.logs_seen += got.length;
      for (const l of got) { const t = parseTransferLog(l, { selfSet, head, blockMs: cfg.blockMs }); if (!t) continue; if (t.self) { stat.self_excluded++; continue; } transfers.push(t); }
      scannedTo = b;
    }
  }
  stat.blocks = Math.max(0, scannedTo - from + 1);

  // 4) attribute + write counts (no sender, hash, block or exact time leaves this function)
  const { deltas, counts } = matchTransfers(transfers, open, cfg);
  Object.assign(stat, { exact_n: counts.exact_n, near_n: counts.near_n, other_n: counts.other_n });
  const up = deltas.map((d) => db.prepare(`UPDATE settle_checks SET exact_n = exact_n + ?, near_n = near_n + ?, ambiguous_n = ambiguous_n + ?,
      exact_first_bucket = COALESCE(exact_first_bucket, ?), near_first_bucket = COALESCE(near_first_bucket, ?),
      near_min_atomic = CASE WHEN ? IS NULL THEN near_min_atomic WHEN near_min_atomic IS NULL OR CAST(? AS INTEGER) < CAST(near_min_atomic AS INTEGER) THEN ? ELSE near_min_atomic END,
      near_max_atomic = CASE WHEN ? IS NULL THEN near_max_atomic WHEN near_max_atomic IS NULL OR CAST(? AS INTEGER) > CAST(near_max_atomic AS INTEGER) THEN ? ELSE near_max_atomic END,
      last_observed_day = CASE WHEN ? IS NULL THEN last_observed_day WHEN last_observed_day IS NULL OR ? > last_observed_day THEN ? ELSE last_observed_day END
      WHERE check_id = ? AND opt = ?`).bind(d.exact_n, d.near_n, d.ambiguous_n, d.exact_first_bucket, d.near_first_bucket,
      d.near_min_atomic, d.near_min_atomic, d.near_min_atomic, d.near_max_atomic, d.near_max_atomic, d.near_max_atomic,
      d.last_observed_day, d.last_observed_day, d.last_observed_day, d.check_id, d.opt));
  if (scannedTo >= from) up.push(stateStmt(db, "block", String(scannedTo), nowIso));
  up.push(db.prepare("DELETE FROM settle_checks WHERE checked_at < ?").bind(isoS(nowMs - cfg.retentionDays * 86400000)));
  await db.batch(up);
  await saveRun(db, day, stat);
  console.log(JSON.stringify({ settle: "tick", ...stat })); // counts only
  return { did: "scanned", ...stat };
}

const stateStmt = (db, k, v, at) => db.prepare("INSERT INTO settle_state (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at").bind(k, v, at);
const RUN_COLS = ["runs", "blocks", "gap_blocks", "log_queries", "rpc_calls", "rpc_errors", "logs_seen", "exact_n", "near_n", "other_n", "self_excluded", "checks_added"];
async function saveRun(db, day, s) {
  await db.prepare(`INSERT INTO settle_runs_daily (day, ${RUN_COLS.join(", ")}) VALUES (?, ${RUN_COLS.map(() => "?").join(", ")}) ON CONFLICT(day) DO UPDATE SET ${RUN_COLS.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")}`).bind(day, ...RUN_COLS.map((c) => s[c] || 0)).run();
}

/** Weekly section for /v1/ops/stats and worker/scripts/ops_weekly.sh: settlement activity per endpoint. Internal only. */
export async function settleWeekly(db, { days = 7, now = new Date(), top = 25 } = {}) {
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const since = new Date(now.getTime() - (n - 1) * 86400000).toISOString().slice(0, 10);
  const rows = ((await db.prepare("SELECT url, method, verdict, amount_atomic, exact_n, near_n, ambiguous_n, exact_first_bucket, near_first_bucket, near_min_atomic, near_max_atomic, window_end FROM settle_checks WHERE checked_at >= ?").bind(since + "T00:00:00Z").all()) || {}).results || [];
  const runs = (await db.prepare(`SELECT ${RUN_COLS.map((c) => `SUM(${c}) AS ${c}`).join(", ")} FROM settle_runs_daily WHERE day >= ?`).bind(since).first()) || {};
  const nowIso = isoS(now.getTime());
  const zeroV = () => ({ checks: 0, with_exact: 0, with_near_only: 0 });
  const by = new Map();
  const tot = { checks: 0, open_windows: 0, with_exact: 0, with_near_only: 0, exact_transfers: 0, near_transfers: 0, ambiguous_transfers: 0, by_verdict: { pay: zeroV(), recheck: zeroV(), skip: zeroV() } };
  for (const r of rows) {
    const k = r.url + " " + r.method;
    const e = by.get(k) || { url: r.url, method: r.method, checks: 0, open_windows: 0, with_exact: 0, with_near_only: 0, exact_transfers: 0, near_transfers: 0, ambiguous_transfers: 0, quoted_amounts_atomic: [], near_min_atomic: null, near_max_atomic: null, time_to_first_exact: Object.fromEntries(SETTLE_BUCKETS.map((b) => [b, 0])), by_verdict: { pay: zeroV(), recheck: zeroV(), skip: zeroV() } };
    const v = e.by_verdict[r.verdict] ? r.verdict : null;
    for (const x of [e, tot]) {
      x.checks++; if (r.window_end > nowIso) x.open_windows++;
      if (r.exact_n > 0) x.with_exact++; else if (r.near_n > 0) x.with_near_only++;
      x.exact_transfers += r.exact_n; x.near_transfers += r.near_n; x.ambiguous_transfers += r.ambiguous_n;
      if (v) { x.by_verdict[v].checks++; if (r.exact_n > 0) x.by_verdict[v].with_exact++; else if (r.near_n > 0) x.by_verdict[v].with_near_only++; }
    }
    if (!e.quoted_amounts_atomic.includes(r.amount_atomic) && e.quoted_amounts_atomic.length < 5) e.quoted_amounts_atomic.push(r.amount_atomic);
    if (r.exact_first_bucket && r.exact_first_bucket in e.time_to_first_exact) e.time_to_first_exact[r.exact_first_bucket]++;
    if (r.near_min_atomic != null && (e.near_min_atomic == null || BigInt(r.near_min_atomic) < BigInt(e.near_min_atomic))) e.near_min_atomic = r.near_min_atomic;
    if (r.near_max_atomic != null && (e.near_max_atomic == null || BigInt(r.near_max_atomic) > BigInt(e.near_max_atomic))) e.near_max_atomic = r.near_max_atomic;
    by.set(k, e);
  }
  const endpoints = [...by.values()].sort((a, b) => b.with_exact - a.with_exact || b.checks - a.checks || a.url.localeCompare(b.url)).slice(0, top);
  return {
    since, days: n, scope: "Base USDC (eip155:8453) transfers to the quoted payTo after live spot checks",
    framing: "settlement activity per endpoint; not what callers did with our verdicts",
    caveat: SETTLE_CAVEAT,
    tiers: { exact: "high confidence: transfer of exactly the quoted amount", near: "low confidence: within the near tolerance; counted separately, never added to exact" },
    totals: tot, runs: Object.fromEntries(RUN_COLS.map((c) => [c, runs[c] || 0])), endpoints,
  };
}

/** Plain-text block for the weekly report. The caveat is always printed. */
export function settleWeeklyText(s) {
  const t = s.totals, L = [];
  L.push(`== settlement activity since ${s.since} (UTC), ${s.scope}`);
  L.push(`caveat: ${s.caveat}`);
  L.push(`checks ${t.checks} (open windows ${t.open_windows}); with exact (high) ${t.with_exact}; near only (low) ${t.with_near_only}; exact transfers ${t.exact_transfers}; near transfers ${t.near_transfers}`);
  for (const v of ["pay", "recheck", "skip"]) L.push(`  verdict ${v}: checks ${t.by_verdict[v].checks}, with exact ${t.by_verdict[v].with_exact}, near only ${t.by_verdict[v].with_near_only}`);
  L.push(`runs ${s.runs.runs}, blocks ${s.runs.blocks}, gap blocks ${s.runs.gap_blocks}, getLogs ${s.runs.log_queries}, rpc errors ${s.runs.rpc_errors}`);
  for (const e of s.endpoints) L.push(`  ${e.method} ${e.url}: checks ${e.checks}, exact ${e.with_exact}/${e.exact_transfers} tx, near ${e.with_near_only}/${e.near_transfers} tx, quoted ${e.quoted_amounts_atomic.join("/")}`);
  return L.join("\n");
}
