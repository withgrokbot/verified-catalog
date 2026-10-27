// 0.57.0 hardening (a): multi-probe before pay (new live checks only; stored receipts and verdicts are never rewritten;
// no KV, no migration, no new D1 table).
//
// Why: a backtest of our tracked set found about 0.53% of live "pay" verdicts were already wrong within about an hour,
// mostly because the one probe behind them caught a flaky one-off answer. So a live, uncached check whose first probe
// would end in "pay" re-reads the same target once more (a "confirm probe") before it answers pay:
//   - the 402 terms match (scheme, network, asset, payTo of every offer exactly; amount within the existing 1%
//     PRICE_TOLERANCE of spotcheck.js, the same rule a listed price gets)        -> pay exactly as before
//   - the terms differ                                                             -> recheck/terms_unstable, with
//     multiprobe.diff_fields naming WHICH fields differed (field names only, never values or addresses)
//   - the confirm probe fails (5xx, timeout, connection error) or answers another
//     "not now" (429, WAF 403, DNS, our own concurrency cap, free trial)            -> that probe's own existing recheck
//     reason (server_error, timeout, unreachable, rate_limited, ...); it is recorded with the per-host breaker like any
//     other probe, so a failed confirm counts as a normal breaker failure
//   - a redirect hop of the confirm probe that resolves to a private/blocked address -> skip/ssrf_blocked (assertSafeUrl
//     runs again, fresh, for the confirm probe and every one of its hops)
// With MULTIPROBE_COUNT=3, a third probe runs only as a tie-break when the first two differ: pay is possible only when
// the 2nd and 3rd agree (the terms changed once and are now stable); the verdict is then decided on those newer terms.
// Anything else (A, B, A or A, B, C) is terms_unstable.
//
// Not re-probed: the 5-minute probe cache (a cached probe is reused as before), crawl/catalog answers, any first probe
// that would not be pay (skip and recheck answers cost no extra request), cron self-checks (bazaar / stale / daily),
// requests that never get access (unpaid over-quota 402, rejected payment), and our own hosts (in-process). Dry
// runs and live checks share getProbe, so a cached probe that once said pay was always confirmed.
//
// Budget: the whole multi-probe shares the existing PROBE_TIMEOUT_MS budget (default 8000 ms), measured from the start of
// the first probe. Each confirm probe gets what is left after MULTIPROBE_GAP_MS, but never less than
// MULTIPROBE_MIN_CONFIRM_MS (1500 ms), so a slow-but-working first probe is not turned into a timeout for lack of time.
// Worst case is therefore PROBE_TIMEOUT_MS + (MULTIPROBE_COUNT - 1) * (MULTIPROBE_GAP_MS + 1500) ms
// (defaults: 8000 + 250 + 1500 = 9750 ms); the usual case adds one probe round trip + 250 ms.
//
// When (0.57.0 review): the confirm probe runs only after access is granted (a free check taken, a payment verified and
// settled, prepaid router credit spent, a hosted key accepted, partner pool or exempt), right before the answer is
// built. An unpaid over-quota request (402) therefore makes exactly one outbound probe. Charging and settlement are the
// same as for any other recheck today: the access step already happened, so a confirm that turns pay into a recheck
// is answered like a first-probe recheck (free check used / payment settled and charged $0.02). Cron self-checks
// (bazaar, stale, daily) never confirm.

import { priceMatchesClaimed } from "./spotcheck.js"; // the existing 1% PRICE_TOLERANCE rule (no new constant)

export const MULTIPROBE_COUNT_DEFAULT = 2; // 1 = off (one probe, as before 0.57.0)
export const MULTIPROBE_COUNT_MAX = 3;
export const MULTIPROBE_GAP_MS_DEFAULT = 250;
export const MULTIPROBE_GAP_MS_MAX = 2000;
export const MULTIPROBE_MIN_CONFIRM_MS = 1500;
// 0.57.0 review: diff_fields names (stable; stored in receipts at probe.multiprobe.diff_fields)
export const DIFF_FIELDS = Object.freeze(["scheme", "network", "asset", "amount", "payTo", "accepts"]);


const num = (raw) => (raw === undefined || raw === null || String(raw).trim() === "" ? NaN : Number(String(raw).trim()));

/** MULTIPROBE_COUNT integer 1..3 (else 2); MULTIPROBE_GAP_MS integer 0..2000 (else 250). */
export function multiprobeCfg(env) {
  const c = num(env && env.MULTIPROBE_COUNT);
  const g = num(env && env.MULTIPROBE_GAP_MS);
  const count = Number.isInteger(c) && c >= 1 && c <= MULTIPROBE_COUNT_MAX ? c : MULTIPROBE_COUNT_DEFAULT;
  const gapMs = Number.isInteger(g) && g >= 0 && g <= MULTIPROBE_GAP_MS_MAX ? g : MULTIPROBE_GAP_MS_DEFAULT;
  return { enabled: count > 1, count, gapMs, minConfirmMs: MULTIPROBE_MIN_CONFIRM_MS };
}

/** Worst-case wall time of one live check's probes (ms), for docs and the budget test. */
export function multiprobeWorstCaseMs(timeoutMs, cfg) {
  return timeoutMs + Math.max(0, cfg.count - 1) * (cfg.gapMs + cfg.minConfirmMs);
}

const isSol = (n) => /^solana/i.test(String(n || ""));
const FIELDS = ["scheme", "network", "asset", "amount", "payTo"];
/** A probe's offers as normalized rows {scheme, network, asset, amount, payTo}. EVM values lowercased; Solana as-is. */
export function termsRows(probe) {
  const acc = Array.isArray(probe && probe.accepts) ? probe.accepts : [];
  return acc.filter((a) => a && !a.raw && (a.network || a.payTo || a.amount != null)).map((a) => {
    const v = (x) => (x == null ? "" : isSol(a.network) ? String(x) : String(x).toLowerCase());
    return { scheme: String(a.scheme || "").toLowerCase(), network: String(a.network || "").toLowerCase(), asset: v(a.asset), amount: String(a.amount ?? ""), payTo: v(a.payTo) };
  });
}
const keyOf = (r) => [r.scheme, r.network, r.asset, r.payTo].join("|");
const sortRows = (rows) => [...rows].sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : Number(x.amount) - Number(y.amount)));
/** Amounts agree when equal, or within the existing 1% tolerance (priceMatchesClaimed, base = the earlier probe). */
export function amountsMatch(earlier, later) {
  if (String(earlier) === String(later)) return true;
  return priceMatchesClaimed(later, earlier) === true;
}
/** Canonical exact fingerprint (all five fields, amount exact), kept for logging/tests; null when no offers. */
export function termsFingerprint(probe) {
  const rows = termsRows(probe);
  if (!rows.length) return null;
  return [...new Set(rows.map((r) => FIELDS.map((f) => r[f]).join("|")))].sort().join("\n");
}
/**
 * Compare two probes' 402 terms. Returns { match, diff_fields }. diff_fields lists the field NAMES that differ
 * (scheme, network, asset, amount, payTo), or "accepts" when one side has no readable offer or the number of offers
 * differs. Never values. Amounts use the 1% tolerance; everything else is exact (EVM case-insensitive).
 */
export function compareTerms(a, b) {
  const ra = sortRows(termsRows(a)), rb = sortRows(termsRows(b));
  if (!ra.length || !rb.length || ra.length !== rb.length) {
    return { match: false, diff_fields: ["accepts"] };
  }
  const diff = new Set();
  // per-field: compare the sorted value lists of each field (amount with tolerance) so the names are order-independent
  for (const f of ["scheme", "network", "asset", "payTo"]) {
    const x = ra.map((r) => r[f]).sort(), y = rb.map((r) => r[f]).sort();
    if (x.some((v, i) => v !== y[i])) diff.add(f);
  }
  const ax = ra.map((r) => Number(r.amount)).sort((p, q) => p - q), ay = rb.map((r) => Number(r.amount)).sort((p, q) => p - q);
  if (ax.some((v, i) => !amountsMatch(v, ay[i]))) diff.add("amount");
  // pairwise (same offer, same key, amount within tolerance)
  const pairOk = ra.every((r, i) => keyOf(r) === keyOf(rb[i]) && amountsMatch(r.amount, rb[i].amount));
  if (!diff.size && !pairOk) diff.add("accepts"); // same values, recombined into different offers
  return { match: diff.size === 0 && pairOk, diff_fields: FIELDS.concat("accepts").filter((f) => diff.has(f)) };
}

/**
 * How a confirm probe is used. "adopt": the confirm probe itself becomes the answer (its own existing reason): an SSRF
 * block, or anything decideVerdict would answer recheck for (5xx, timeout, connection error, 429, WAF 403, DNS, our
 * concurrency cap, free trial). "compare": it read an answer from the target, so its terms are compared.
 */
export function confirmClass(p, decide) {
  if (!p || p.ssrf_blocked) return "adopt";
  const d = decide(p);
  return d && d.verdict === "recheck" ? "adopt" : "compare";
}

const brief = (p) => ({ http_status: p && p.http_status != null ? p.http_status : null, latency_ms: p && p.latency_ms != null ? p.latency_ms : null });

/**
 * first: the first probe (already recorded with the breaker). probeFn({ timeoutMs }) runs one more probe of the same
 * target (same method; SSRF guard, concurrency cap and breaker recording are the caller's spotProbe + record).
 * decide(p) = decideVerdict(p) for confirmClass. Returns the probe to decide on, with a `multiprobe` summary attached,
 * and `terms_unstable: true` when the terms differed. Never throws (a throwing probeFn counts as a connection error).
 */
export async function confirmBeforePay({ first, probeFn, decide, cfg, timeoutMs, startedAt, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const probes = [first];
  const diffs = new Set();
  const summary = (outcome, extra = {}) => ({ count: cfg.count, probes: probes.length, gap_ms: cfg.gapMs, budget_ms: timeoutMs, elapsed_ms: Math.max(0, now() - startedAt), outcome, results: probes.map(brief), ...extra });
  const withMethod = (p) => ({ ...p, ...(first.method_used && !p.method_used ? { method_used: first.method_used } : {}) });
  for (let i = 1; i < cfg.count; i++) {
    if (cfg.gapMs > 0) await sleep(cfg.gapMs);
    const left = timeoutMs - (now() - startedAt);
    const budget = Math.max(cfg.minConfirmMs, Math.min(timeoutMs, left));
    let p;
    try { p = await probeFn({ timeoutMs: budget }); } catch (_) { p = null; }
    if (!p) p = { reachable: false, http_status: null, latency_ms: null, ssrf_blocked: false, error: "fetch failed", x402_challenge: false, accepts: [], quoted_price_usd: null, known_answer: null, body_truncated: false };
    probes.push(p);
    if (confirmClass(p, decide) === "adopt") return { ...withMethod(p), multiprobe: summary("confirm_failed", { confirm_budget_ms: budget }) };
    const c = compareTerms(probes[i - 1], p);
    if (c.match) {
      if (i === 1) return { ...first, multiprobe: summary("match") };
      return { ...withMethod(p), multiprobe: summary("match_after_change", { diff_fields: [...diffs] }) }; // tie-break: 2nd == 3rd
    }
    for (const f of c.diff_fields) diffs.add(f);
    if (i === 1 && cfg.count < 3) break;
    if (i === 2) { // A, B, A or A, B, C: also note how the 3rd differs from the 1st (union of differences)
      for (const f of compareTerms(first, p).diff_fields) diffs.add(f);
    }
  }
  const diff_fields = FIELDS.concat("accepts").filter((f) => diffs.has(f));
  return { ...first, terms_unstable: true, multiprobe: summary("terms_unstable", { diff_fields }) };
}
