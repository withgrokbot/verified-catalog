// 0.57.0 hardening (a): multi-probe before pay (new live checks only; stored receipts and verdicts are never rewritten;
// no KV, no migration, no new D1 table).
//
// Why: a backtest of our tracked set found about 0.53% of live "pay" verdicts were already wrong within about an hour,
// mostly because the one probe behind them caught a flaky one-off answer. So a live, uncached check whose first probe
// would end in "pay" re-reads the same target once more (a "confirm probe") before it answers pay:
//   - the 402 terms (scheme, network, asset, amount, payTo of every offer) match  -> pay exactly as before
//   - the terms differ                                                             -> recheck/terms_unstable
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
// that would not be pay (skip and recheck answers cost no extra request), and our own hosts (served in-process). Dry
// runs and live checks share getProbe, so a cached probe that once said pay was always confirmed.
//
// Budget: the whole multi-probe shares the existing PROBE_TIMEOUT_MS budget (default 8000 ms), measured from the start of
// the first probe. Each confirm probe gets what is left after MULTIPROBE_GAP_MS, but never less than
// MULTIPROBE_MIN_CONFIRM_MS (1500 ms), so a slow-but-working first probe is not turned into a timeout for lack of time.
// Worst case is therefore PROBE_TIMEOUT_MS + (MULTIPROBE_COUNT - 1) * (MULTIPROBE_GAP_MS + 1500) ms
// (defaults: 8000 + 250 + 1500 = 9750 ms); the usual case adds one probe round trip + 250 ms.
//
// Charging: unchanged. The probes all run before any quota, router credit, hosted meter or payment step, and a check is
// still one free check or one $0.02 payment however many probes it took.

export const MULTIPROBE_COUNT_DEFAULT = 2; // 1 = off (one probe, as before 0.57.0)
export const MULTIPROBE_COUNT_MAX = 3;
export const MULTIPROBE_GAP_MS_DEFAULT = 250;
export const MULTIPROBE_GAP_MS_MAX = 2000;
export const MULTIPROBE_MIN_CONFIRM_MS = 1500;

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
/**
 * Canonical fingerprint of a probe's 402 terms: every offer's scheme, network, asset, amount and payTo, sorted, so a
 * reordered accepts list is the same terms. EVM values are lowercased; Solana (base58, case-sensitive) kept as-is.
 * null when the probe carries no readable offer.
 */
export function termsFingerprint(probe) {
  const acc = Array.isArray(probe && probe.accepts) ? probe.accepts : [];
  const rows = acc.filter((a) => a && !a.raw && (a.network || a.payTo || a.amount != null)).map((a) => {
    const v = (x) => (x == null ? "" : isSol(a.network) ? String(x) : String(x).toLowerCase());
    return [String(a.scheme || "").toLowerCase(), String(a.network || "").toLowerCase(), v(a.asset), String(a.amount ?? ""), v(a.payTo)].join("|");
  });
  if (!rows.length) return null;
  return [...new Set(rows)].sort().join("\n");
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
  const fps = [termsFingerprint(first)];
  const summary = (outcome, extra = {}) => ({ count: cfg.count, probes: probes.length, gap_ms: cfg.gapMs, budget_ms: timeoutMs, elapsed_ms: Math.max(0, now() - startedAt), outcome, results: probes.map(brief), ...extra });
  for (let i = 1; i < cfg.count; i++) {
    if (cfg.gapMs > 0) await sleep(cfg.gapMs);
    const left = timeoutMs - (now() - startedAt);
    const budget = Math.max(cfg.minConfirmMs, Math.min(timeoutMs, left));
    let p;
    try { p = await probeFn({ timeoutMs: budget }); } catch (_) { p = null; }
    if (!p) p = { reachable: false, http_status: null, latency_ms: null, ssrf_blocked: false, error: "fetch failed", x402_challenge: false, accepts: [], quoted_price_usd: null, known_answer: null, body_truncated: false };
    probes.push(p);
    if (confirmClass(p, decide) === "adopt") {
      return { ...p, ...(first.method_used && !p.method_used ? { method_used: first.method_used } : {}), multiprobe: summary("confirm_failed", { confirm_budget_ms: budget }) };
    }
    fps.push(termsFingerprint(p));
    if (i === 1) {
      if (fps[1] !== null && fps[1] === fps[0]) return { ...first, multiprobe: summary("match") };
      if (cfg.count < 3) break;
      continue; // tie-break
    }
    // i === 2 (tie-break): only "changed once, now stable" may still pay, decided on the newer terms
    if (fps[2] !== null && fps[2] === fps[1]) return { ...p, ...(first.method_used && !p.method_used ? { method_used: first.method_used } : {}), multiprobe: summary("match_after_change") };
    break;
  }
  return { ...first, terms_unstable: true, multiprobe: summary("terms_unstable") };
}
