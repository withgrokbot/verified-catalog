// 0.74.0 per-endpoint reliability score ("safe to pay?"). PURE module: no I/O, no env reads except through the cfg
// argument, nothing wired to a route, cron or table yet. Plan: products/reliability-score/PLAN.md.
//
// Design rules (same as reputation.js): the score is advisory context and never changes a check's verdict or reason_code;
// a new endpoint is never penalised for being new (it is "unknown"); payment never buys a better label; no buyer wallet,
// tx hash, IP or client name is ever put in an answer (excluded observations are reported by category and count only).
//
// Input: a list of raw observations for ONE endpoint (receipt rows already reduced to the fields below, plus optional crawl
// rows), optional delivery checks and the latest quality code. Output: one result object. Everything is deterministic for a
// given (observations, now, cfg), so an answer can be re-derived from the public receipts behind it (inputs_digest).
import { QUALITY_SCORE } from "./quality.js";

export const SCORE_VERSION = "score-2026-11-24b";
export const SCORE_WINDOW_DAYS = 30;
export const SCORE_DELIVERY_WINDOW_DAYS = 90;
const HOUR = 3600e3, DAY = 86400e3;

// Observation weights. Outside live checks weigh MORE than our own scheduled probes (a seller can tune its answer to a
// probe it can recognise; it cannot know which outside caller is asking). Crawl rows are one look a week: low weight and a
// hard cap on how much of the sample they can be.
export const OBS_WEIGHTS = Object.freeze({ live: 1.5, probe: 1, crawl: 0.25 });
export const CRAWL_WEIGHT_CAP = 2; // all crawl observations together add at most this much to n_eff
export const LIVE_PER_DAY_CAP = 6; // outside live observations counted per UTC day (a flood of free checks cannot dominate)
export const SCORE_WEIGHTS = Object.freeze({ availability: 35, terms: 35, delivery: 20, quality: 10 });
export const DELIVERY_MIN_CHECKS = 3;
export const SHRINK = Object.freeze({ prior: 60, strength: 5 });
export const CONFIDENCE_RULES = Object.freeze({
  high: { n_eff: 20, days: 14, newest_h: 48 },
  medium: { n_eff: 8, days: 5 },
  low: { n_eff: 3, days: 2 },
});
export const BAND_RULES = Object.freeze({ good_min: 80, avoid_below: 40, stale_days: 7, flag_expiry_days: 14, flag_clear_clean: 3, failing_now_probes: 3, failing_now_hours: 2 });
export const VALID_FOR_MS = Object.freeze({ good: HOUR, caution: HOUR, avoid: 15 * 60e3, unknown: HOUR, operator_endpoint: 24 * HOUR });

// Cron probe refs (check_type self-checked + caller self-test). Anything else self-checked is a test or an audit.
export const PROBE_REFS = Object.freeze(["daily-recheck", "bazaar-daily", "stale-recheck", "score-probe"]);
// Test, audit, deploy-check and heartbeat clients on live receipts. Matched on the client value only.
export const TEST_CLIENT_RE = /(heartbeat|drill|deploy|verify|audit|selftest|self-test|smoke|rollout|dry|sec-|label-check|^vc-|^sam-|^withgrokbot)/i;
export const OPERATOR_HOSTS_DEFAULT = Object.freeze(["402xagent.com", "www.402xagent.com", "api.402xagent.com", "payscout.dev", "api.payscout.dev"])
// Exactly the hosts this Worker serves (wrangler.toml routes). Third-party services we only test against (for example the demo target in our docs) are NOT listed: they are scored like any other seller.;
const OPERATOR_HOST_RE = /^verified-catalog-lookup\.[a-z0-9-]+\.workers\.dev$/;

// Reason-code classes. Availability: did the endpoint answer with a usable 402 challenge.
const AVAIL_FAIL = new Set(["server_error", "timeout", "unreachable", "dns_error", "dns_error_persistent", "bad_challenge"]);
const AVAIL_NULL = new Set(["rate_limited", "rate_limited_persistent", "waf_challenge", "waf_blocked_persistent", "no_paywall", "host_unstable", "ssrf_blocked", "terms_stale", "check_failed", "unknown", ""]);
// Terms integrity penalty per reason code (only when the claim was a listing/cron claim, see claimCounts()).
const CLAIM_PENALTY = { pay_to_mismatch: 1, network_mismatch: 1, price_mismatch: 0.5 };
export const HARD_FLAGS = Object.freeze(["pay_to_mismatch", "network_mismatch", "pay_to_changed", "network_changed", "failing_now", "delivery_failed_recent"]);
export const SOFT_FLAGS = Object.freeze(["price_above_listing", "live_probe_disagree", "price_changed", "quality_issue"]);
export const REASON_CODES_SCORE = Object.freeze(["probes_ok", "terms_stable", ...HARD_FLAGS, ...SOFT_FLAGS, "low_score", "stale_data", "low_data", "crawl_only", "not_x402", "operator_endpoint", "band_held"]);
export const PUBLIC_BANDS = Object.freeze(["good", "caution", "unknown", "operator_endpoint"]);
// 0.79.0 (shadow review, Nov 24): a confirmed pay_to flag at LOW confidence is "unknown", not avoid/caution; the public view
// shows a band only at medium or high confidence; a band changes only when two daily computations agree (hysteresis), except
// for the facts below, which apply at once.
export const PAY_TO_FLAGS = Object.freeze(["pay_to_mismatch", "pay_to_changed"]);
export const PUBLIC_MIN_CONFIDENCE = "medium";
export const HOLD_IMMEDIATE_REASONS = Object.freeze(["failing_now", "delivery_failed_recent", "stale_data", "not_x402", "operator_endpoint", "crawl_only"]);

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const isoUtc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const lc = (s) => String(s == null ? "" : s).toLowerCase();
// 0.79.0 listed payTo alternatives. Network names as the Worker spells them (CAIP-2); EVM addresses compare case-insensitively,
// Solana base58 exactly (same rule as lib.js sameAddr).
const NET_ALIAS = { base: "eip155:8453", ethereum: "eip155:1", optimism: "eip155:10", polygon: "eip155:137", arbitrum: "eip155:42161", avalanche: "eip155:43114", solana: "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp", "base-sepolia": "eip155:84532" };
export const netKey = (n) => NET_ALIAS[lc(n)] || lc(n);
export const addrKey = (a, n) => { const x = String(a == null ? "" : a).trim(); return netKey(n).startsWith("solana:") ? x : x.toLowerCase(); };
/**
 * Every payTo a listing names, by network: the single expected one (listed_pay_to on listed_network) plus the crawl's
 * listed_pay_tos (all accepts entries of this endpoint in every Bazaar, and the same site's wallets on the same networks).
 * Returns Map<network, Set<addrKey>> or null when the listing names fewer than two wallets (nothing to widen).
 */
export function listedPayTos(listing) {
  if (!listing) return null;
  const m = new Map();
  const add = (network, payTo) => {
    const k = netKey(network), a = addrKey(payTo, network);
    if (!k || !a) return;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(a);
  };
  if (listing.listed_pay_to) add(listing.listed_network || "eip155:8453", listing.listed_pay_to);
  for (const e of Array.isArray(listing.listed_pay_tos) ? listing.listed_pay_tos.slice(0, 16) : []) if (e && e.pay_to && e.network) add(e.network, e.pay_to);
  let n = 0;
  for (const set of m.values()) n += set.size;
  return n > 1 ? m : null;
}
const altHas = (alt, network, payTo) => !!(alt && payTo && alt.has(netKey(network)) && alt.get(netKey(network)).has(addrKey(payTo, network)));

/** cfg from the Worker env (all optional). Pure: callers pass env, nothing is read globally. */
export function scoreConfig(env = {}) {
  const list = (v) => String(v || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return {
    operatorHosts: new Set([...OPERATOR_HOSTS_DEFAULT, ...list(env.SCORE_OPERATOR_HOSTS)]),
    operatorPayTo: new Set(list(env.PAY_TO)),
    drillWallets: new Set(list(env.DRILL_WALLETS)),
    selfClients: new Set(list(env.SELF_CLIENTS)),
    // ISO time from which a cron probe must carry origin "cron" to count (set when the Worker starts stamping it)
    originRequiredFrom: Number.isFinite(Date.parse(env.SCORE_ORIGIN_FROM || "")) ? Date.parse(env.SCORE_ORIGIN_FROM) : null,
  };
}
const need = (cfg) => cfg || scoreConfig({});

export function hostOf(url) { try { return new URL(url).host.toLowerCase(); } catch (_) { return ""; } }
export function isOperatorHost(host, cfg) {
  const h = lc(host);
  return !!h && (need(cfg).operatorHosts.has(h) || OPERATOR_HOST_RE.test(h));
}

/**
 * Classify one raw observation. Returns { kind, weight } when it can count, or { excluded: category } when it cannot.
 * Categories (counts only, never identities): dry_run, test_client, self_settle.
 */
export function classifyObservation(raw, cfg) {
  const c = need(cfg);
  if (!raw) return { excluded: "test_client" };
  if (raw.source === "crawl") return { kind: "crawl", weight: OBS_WEIGHTS.crawl };
  const type = lc(raw.check_type);
  const client = lc(raw.client);
  if (type === "dry-run" || raw.dry_run === true) return { excluded: "dry_run" };
  if (raw.payer && c.drillWallets.has(lc(raw.payer))) return { excluded: "self_settle" };
  if (type === "self-checked") {
    // origin "cron" is stamped by the Worker itself on scheduled probes (PR 2) and cannot be set by a caller. The self-test
    // client value and ref are public, so once stamping is live (cfg.originRequiredFrom) a probe without the stamp is not trusted.
    const stamped = lc(raw.origin) === "cron";
    const t = Date.parse(raw.at);
    const needStamp = c.originRequiredFrom != null && Number.isFinite(t) && t >= c.originRequiredFrom;
    if (stamped && PROBE_REFS.includes(lc(raw.ref))) return { kind: "probe", weight: OBS_WEIGHTS.probe };
    if (!needStamp && lc(raw.caller) === "self-test" && PROBE_REFS.includes(lc(raw.ref))) return { kind: "probe", weight: OBS_WEIGHTS.probe };
    return { excluded: needStamp && lc(raw.caller) === "self-test" && PROBE_REFS.includes(lc(raw.ref)) ? "unstamped_probe" : "test_client" };
  }
  if (type === "live" || type === "") {
    if (client && (c.selfClients.has(client) || TEST_CLIENT_RE.test(client))) return { excluded: "test_client" };
    return { kind: "live", weight: OBS_WEIGHTS.live };
  }
  return { excluded: "test_client" };
}

// A claim (listed price, pay_to, network) counts only when it came from a listing or from our own cron; an outside caller's
// claimed_price / pay_to / network (listing_source "request" on a live receipt) never counts against the seller.
function claimCounts(kind, listingSource) {
  if (kind === "crawl") return false;
  if (kind === "probe") return true;
  return lc(listingSource) === "listing";
}
const termsSig = (t) => (t && t.pay_to && t.network ? [t.network, lc(t.asset), lc(t.pay_to), String(t.amount == null ? "" : t.amount)].join("|") : null);
const fieldsOf = (t) => (t ? { pay_to: lc(t.pay_to), pay_to_raw: String(t.pay_to == null ? "" : t.pay_to), network: lc(t.network), asset: lc(t.asset), amount: String(t.amount == null ? "" : t.amount) } : null);

/** One raw observation -> the counted shape. */
// 0.80.0: a price claim counts only when it is a real price: a listing price of $0 is a placeholder, and when the current
// listing names no price any more (listingClaims === false) an older price_mismatch was measured against a price nobody lists.
const claimIsPrice = (raw, listingClaims) => !(raw.claimed != null && !(Number(raw.claimed) > 0)) && listingClaims !== false;
function shape(raw, cls, alt = null, listingClaims = null) {
  const code = lc(raw.reason_code || raw.reason);
  const status = raw.http_status == null ? null : Number(raw.http_status);
  let avail = null;
  if (AVAIL_FAIL.has(code) || code.startsWith("dns_error")) avail = 0;
  else if (AVAIL_NULL.has(code)) avail = null;
  else if (code) avail = 1;
  // the crawl's "recheck / not probed this run" rows have no outcome of their own
  if (cls.kind === "crawl" && lc(raw.verdict) === "recheck" && avail === 1) avail = null;
  const challenge = raw.x402_challenge != null ? !!raw.x402_challenge : status === 402 || (avail === 1 && code !== "");
  const claim = claimCounts(cls.kind, raw.listing_source);
  let penalty = null; // terms-integrity penalty from a claim comparison
  const hard = [], soft = [];
  // 0.79.0: a pay_to_mismatch where the 402 pays a wallet the listing ALSO names on the same network (another accepts entry,
  // the other Bazaar, or the same site's other endpoints) is a match: no penalty, no flag.
  let altListed = false;
  if (claim && code === "pay_to_mismatch" && alt) {
    const accs = Array.isArray(raw.accepts) && raw.accepts.length ? raw.accepts : raw.terms ? [raw.terms] : [];
    const want = raw.expected_network ? netKey(raw.expected_network) : null;
    altListed = accs.some((a) => a && (!want || netKey(a.network) === want) && altHas(alt, a.network, a.pay_to));
  }
  const noPriceClaim = claim && code === "price_mismatch" && !claimIsPrice(raw, listingClaims);
  if (altListed) penalty = 0;
  else if (noPriceClaim) penalty = null; // 0.80.0: no claim to compare with (the price itself still counts as availability)
  else if (claim && CLAIM_PENALTY[code] != null) {
    penalty = CLAIM_PENALTY[code];
    if (code === "pay_to_mismatch" || code === "network_mismatch") hard.push(code);
    if (code === "price_mismatch") soft.push("price_above_listing");
  } else if (claim && (code === "price_ok" || code === "price_below_listing")) penalty = 0;
  return {
    id: String(raw.id || ""), at: Date.parse(raw.at), kind: cls.kind, weight: cls.weight,
    avail, challenge, nopay: code === "no_paywall", terms: fieldsOf(raw.terms), sig: termsSig(raw.terms), penalty, hard, soft, code: altListed ? "pay_to_alt_listed" : code, verdict: lc(raw.verdict), alt_listed: altListed,
  };
}

/** One counted observation per UTC hour and kind (earliest wins). Kinds are kept apart on purpose: a seller must not be able
 *  to hide one of our failing probes by running an outside check in the same hour (or the other way round). */
function dedupeHours(list, excluded) {
  const by = new Map();
  for (const o of list) {
    const k = Math.floor(o.at / HOUR) + ":" + o.kind;
    const cur = by.get(k);
    if (!cur) by.set(k, o);
    else {
      if (o.at < cur.at) by.set(k, o);
      excluded.duplicate_hour = (excluded.duplicate_hour || 0) + 1;
    }
  }
  return [...by.values()].sort((a, b) => a.at - b.at);
}
function capLivePerDay(list, excluded) {
  const perDay = new Map();
  return list.filter((o) => {
    if (o.kind !== "live") return true;
    const d = isoUtc(o.at).slice(0, 10);
    const n = (perDay.get(d) || 0) + 1;
    perDay.set(d, n);
    if (n > LIVE_PER_DAY_CAP) { excluded.live_daily_cap = (excluded.live_daily_cap || 0) + 1; return false; }
    return true;
  });
}
function capCrawl(list) {
  const total = list.filter((o) => o.kind === "crawl").reduce((s, o) => s + o.weight, 0);
  if (total <= CRAWL_WEIGHT_CAP) return list;
  const f = CRAWL_WEIGHT_CAP / total;
  return list.map((o) => (o.kind === "crawl" ? { ...o, weight: o.weight * f } : o));
}

// Terms transitions between consecutive term-bearing observations (oldest first): pay_to / network / asset change = 1 and a
// hard flag; price-only change = 0.5 and a soft flag. Applied to the later observation.
function applyTransitions(list, alt = null) {
  let prev = null;
  for (const o of list) {
    if (!o.sig) continue;
    if (prev) {
      const a = prev.terms, b = o.terms;
      let pen = 0;
      // 0.79.0: moving between two wallets the listing names on this network is not a change
      const bothListed = altHas(alt, b.network, a.pay_to_raw) && altHas(alt, b.network, b.pay_to_raw) && netKey(a.network) === netKey(b.network);
      if (a.pay_to !== b.pay_to && !bothListed) { pen = 1; o.hard.push("pay_to_changed"); }
      if (a.network !== b.network || a.asset !== b.asset) { pen = 1; if (!o.hard.includes("network_changed")) o.hard.push("network_changed"); }
      if (pen === 0 && a.amount !== b.amount) { pen = 0.5; o.soft.push("price_changed"); }
      if (pen > 0) o.penalty = Math.max(o.penalty == null ? 0 : o.penalty, pen);
      else if (o.penalty == null) o.penalty = 0;
    }
    prev = o;
  }
}

/**
 * Confirmed hard flag state per code. A flag is confirmed when the same fact appears in >= 2 counted observations on >= 2
 * UTC days, or in the newest two. It expires 14 days after its last confirming observation and clears after 3 consecutive
 * clean observations over >= 2 days since its last appearance.
 */
function flagState(list, code, now) {
  const idx = [];
  list.forEach((o, i) => { if (o.hard.includes(code)) idx.push(i); });
  if (!idx.length) return null;
  const days = new Set(idx.map((i) => isoUtc(list[i].at).slice(0, 10)));
  const newestTwo = idx.length >= 2 && idx[idx.length - 1] === list.length - 1 && idx[idx.length - 2] === list.length - 2;
  const confirmed = (idx.length >= 2 && days.size >= 2) || newestTwo;
  const last = idx[idx.length - 1];
  const after = list.slice(last + 1).filter((o) => o.kind !== "crawl");
  const afterDays = new Set(after.map((o) => isoUtc(o.at).slice(0, 10)));
  const cleared = after.length >= BAND_RULES.flag_clear_clean && afterDays.size >= 2;
  const expired = now - list[last].at > BAND_RULES.flag_expiry_days * DAY;
  return { code, hard: true, seen: idx.length, confirmed: confirmed && !cleared && !expired, cleared, expired, last_at: list[last].at };
}

/** Distinct UTC dates, first and last time of a list. */
function span(list) {
  const days = new Set(list.map((o) => isoUtc(o.at).slice(0, 10)));
  return { days: days.size, first: list.length ? isoUtc(list[0].at) : null, last: list.length ? isoUtc(list[list.length - 1].at) : null };
}

export function confidenceLevel(nEff, days, newestAgeMs) {
  const H = CONFIDENCE_RULES.high, M = CONFIDENCE_RULES.medium, L = CONFIDENCE_RULES.low;
  if (nEff >= H.n_eff && days >= H.days && newestAgeMs != null && newestAgeMs <= H.newest_h * HOUR) return "high";
  if (nEff >= M.n_eff && days >= M.days) return "medium";
  if (nEff >= L.n_eff && days >= L.days) return "low";
  return "none";
}
const confRank = { none: 0, low: 1, medium: 2, high: 3 };

/**
 * Compute the score for one endpoint.
 * @param {object} a { url, method?, observations: raw[], delivery?: [{at, flag, payer?, pay_to?}], quality?: {code}|null, now?: Date, cfg? }
 * @returns internal result. `band` here may be "avoid"; use publicAnswer() for anything served.
 */
export function computeScore({ url, method = "GET", observations = [], delivery = [], quality = null, listing = null, now = new Date(), cfg } = {}) {
  const c = need(cfg);
  const nowMs = now.getTime();
  const base = { url: String(url || ""), method: String(method || "GET").toUpperCase(), formula_version: SCORE_VERSION, computed_at: isoUtc(nowMs) };
  const excluded = {};
  const host = hostOf(url);
  const opPayTo = (observations || []).some((r) => r && r.terms && r.terms.pay_to && c.operatorPayTo.has(lc(r.terms.pay_to)));
  if (isOperatorHost(host, c) || opPayTo) {
    return { ...base, band: "operator_endpoint", score: null, raw: null, confidence: "none", confidence_score: 0, n_eff: 0, observations: 0, days_observed: 0, first_seen: null, last_checked: null,
      flags: [], reasons: ["operator_endpoint"], excluded: {}, stale: false, ranked: false, breakdown: null, input_ids: [], crawl_hint: null };
  }
  // 1) classify + shape, drop out-of-window and unusable rows
  const alt = listedPayTos(listing);
  const listingClaims = listing && "claimed_price_usd" in listing ? Number(listing.claimed_price_usd) > 0 : null;
  let list = [];
  for (const raw of observations || []) {
    const cls = classifyObservation(raw, c);
    if (cls.excluded) { excluded[cls.excluded] = (excluded[cls.excluded] || 0) + 1; continue; }
    const t = Date.parse(raw.at);
    if (!Number.isFinite(t) || t > nowMs + 5 * 60e3 || nowMs - t > SCORE_WINDOW_DAYS * DAY) continue;
    list.push(shape(raw, cls, alt, listingClaims));
  }
  list.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  list = dedupeHours(list, excluded);
  list = capLivePerDay(list, excluded);
  list = capCrawl(list);
  applyTransitions(list, alt);

  const real = list.filter((o) => o.kind !== "crawl");
  const nEff = list.reduce((s, o) => s + o.weight, 0);
  const sp = span(list);
  const newest = real.length ? real[real.length - 1] : list.length ? list[list.length - 1] : null; // freshness is about real probes/checks, not the weekly crawl
  const newestAge = newest ? nowMs - newest.at : null;
  const conf = confidenceLevel(nEff, sp.days, newestAge);
  const confScore = Math.min(1, nEff / 20) * Math.min(1, sp.days / 14);

  // 2) components
  const comp = {};
  const wsum = (arr, f) => arr.reduce((s, o) => s + o.weight * f(o), 0);
  const av = list.filter((o) => o.avail != null);
  if (av.length) comp.availability = wsum(av, (o) => o.avail) / av.reduce((s, o) => s + o.weight, 0);
  const tm = list.filter((o) => o.penalty != null);
  if (tm.length) comp.terms = 1 - wsum(tm, (o) => o.penalty) / tm.reduce((s, o) => s + o.weight, 0);
  const dl = (delivery || []).filter((d) => d && Number.isFinite(Date.parse(d.at)) && nowMs - Date.parse(d.at) <= SCORE_DELIVERY_WINDOW_DAYS * DAY && !(d.payer && c.drillWallets.has(lc(d.payer))) && !(d.pay_to && c.operatorPayTo.has(lc(d.pay_to))));
  if (dl.length >= DELIVERY_MIN_CHECKS) comp.delivery = dl.filter((d) => lc(d.flag) === "ok").length / dl.length;
  if (quality && quality.code && QUALITY_SCORE[quality.code] != null) comp.quality = QUALITY_SCORE[quality.code];
  let rawScore = null, shrunk = null;
  const breakdown = {};
  let wTot = 0, pts = 0;
  for (const [k, w] of Object.entries(SCORE_WEIGHTS)) if (comp[k] != null) { wTot += w; pts += w * comp[k]; }
  for (const [k, w] of Object.entries(SCORE_WEIGHTS)) if (comp[k] != null) breakdown[k] = { value: r3(comp[k]), weight: w, effective_weight: r3(w / wTot), points: r1((100 * w * comp[k]) / wTot) };
  if (wTot > 0) { rawScore = (100 * pts) / wTot; shrunk = (nEff * rawScore + SHRINK.strength * SHRINK.prior) / (nEff + SHRINK.strength); }

  // 3) flags
  const flags = [];
  for (const code of ["pay_to_mismatch", "network_mismatch", "pay_to_changed", "network_changed"]) {
    const st = flagState(list, code, nowMs);
    if (st && !st.cleared && !st.expired) flags.push({ code, severity: "hard", confirmed: st.confirmed, observations: st.seen });
  }
  const tail = real.filter((o) => o.avail != null).slice(-BAND_RULES.failing_now_probes);
  if (tail.length === BAND_RULES.failing_now_probes && tail.every((o) => o.avail === 0) && tail[tail.length - 1].at - tail[0].at >= BAND_RULES.failing_now_hours * HOUR)
    flags.push({ code: "failing_now", severity: "hard", confirmed: true, observations: tail.length });
  const dlSorted = [...dl].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (dlSorted.length && lc(dlSorted[0].flag) === "failed" && nowMs - Date.parse(dlSorted[0].at) <= 14 * DAY) flags.push({ code: "delivery_failed_recent", severity: "hard", confirmed: true, observations: 1 });
  // soft: a quote above the listing in any of the last 3 claim-bearing observations (it fades once 3 newer ones are clean)
  const lastClaims = real.filter((o) => o.penalty != null).slice(-3);
  if (lastClaims.some((o) => o.soft.includes("price_above_listing"))) flags.push({ code: "price_above_listing", severity: "soft", confirmed: false, observations: real.filter((o) => o.soft.includes("price_above_listing")).length });
  const lastChange = [...list].reverse().find((o) => o.soft.includes("price_changed"));
  if (lastChange && nowMs - lastChange.at <= BAND_RULES.flag_expiry_days * DAY) flags.push({ code: "price_changed", severity: "soft", confirmed: false, observations: 1 });
  const liveAvail = [...real].reverse().find((o) => o.kind === "live" && o.avail != null && nowMs - o.at <= BAND_RULES.stale_days * DAY);
  const probeAvail = [...real].reverse().find((o) => o.kind === "probe" && o.avail != null);
  if (liveAvail && probeAvail && liveAvail.avail === 0 && probeAvail.avail === 1) flags.push({ code: "live_probe_disagree", severity: "soft", confirmed: false, observations: 1 });
  if (quality && ["quality_schema_mismatch", "quality_bad_status", "quality_unreachable"].includes(quality.code)) flags.push({ code: "quality_issue", severity: "soft", confirmed: false, observations: 1 });

  // 4) band (internal; avoid is never served publicly, see publicAnswer)
  const reasons = [];
  const confirmedHard = flags.filter((f) => f.severity === "hard" && f.confirmed);
  const anyChallenge = list.some((o) => o.challenge);
  const crawlHintSrc = list.filter((o) => o.kind === "crawl");
  const crawlHint = crawlHintSrc.length ? { observations: crawlHintSrc.length, last_crawl_at: isoUtc(crawlHintSrc[crawlHintSrc.length - 1].at), last_verdict: crawlHintSrc[crawlHintSrc.length - 1].verdict || null, term_changes: crawlHintSrc.filter((o) => o.hard.length || o.soft.includes("price_changed")).length } : null;
  const stale = !!newest && newestAge > BAND_RULES.stale_days * DAY;
  let band;
  if (!list.length) { band = "unknown"; reasons.push("low_data"); }
  else if (stale) { band = "unknown"; reasons.push("stale_data"); }
  else if (!anyChallenge && real.filter((o) => o.nopay).length * 2 >= real.length && real.some((o) => o.nopay)) { band = "unknown"; reasons.push("not_x402"); }
  else if (!real.length) { band = "unknown"; reasons.push("crawl_only"); }
  else if (conf === "none") { band = "unknown"; reasons.push("low_data"); }
  // 0.79.0: at low confidence a confirmed pay_to flag alone is not enough to call it: unknown (the flag stays in reasons)
  else if (conf === "low" && confirmedHard.length && confirmedHard.every((f) => PAY_TO_FLAGS.includes(f.code))) { band = "unknown"; reasons.push("low_data"); for (const f of confirmedHard) reasons.push(f.code); }
  else if (confirmedHard.length) { band = "avoid"; for (const f of confirmedHard) reasons.push(f.code); }
  else if (shrunk != null && shrunk < BAND_RULES.avoid_below && confRank[conf] >= confRank.medium) { band = "avoid"; reasons.push("low_score"); }
  else if (conf === "low") { band = "unknown"; reasons.push("low_data"); }
  else {
    const latestAvail = [...real].reverse().find((o) => o.avail != null);
    const unconfirmedHard = flags.some((f) => f.severity === "hard" && !f.confirmed);
    const softFlag = flags.some((f) => f.severity === "soft");
    const latestOk = !latestAvail || latestAvail.avail === 1;
    if (shrunk != null && shrunk >= BAND_RULES.good_min && !unconfirmedHard && !softFlag && latestOk) band = "good";
    else { band = "caution"; if (shrunk != null && shrunk < BAND_RULES.good_min) reasons.push("low_score"); }
    if (band === "good") { if ((comp.availability ?? 1) >= 0.9) reasons.push("probes_ok"); if ((comp.terms ?? 1) >= 0.95) reasons.push("terms_stable"); }
  }
  for (const f of flags) if (!reasons.includes(f.code) && band !== "good") reasons.push(f.code);
  if (band === "unknown") for (const f of flags) if (f.confirmed && !reasons.includes(f.code)) reasons.push(f.code);

  return {
    ...base, band, score: shrunk == null ? null : Math.round(shrunk), raw: rawScore == null ? null : Math.round(rawScore),
    confidence: conf, confidence_score: r3(confScore), n_eff: r1(nEff), observations: list.length, days_observed: sp.days,
    first_seen: sp.first, last_checked: sp.last, flags, reasons: [...new Set(reasons)], excluded, stale, ranked: true,
    breakdown: Object.keys(breakdown).length ? breakdown : null, input_ids: list.map((o) => o.id).filter(Boolean).sort(), crawl_hint: band === "unknown" ? crawlHint : null,
    pay_to_alt_listed: list.filter((o) => o.alt_listed).length,
  };
}

/** sha256 over the sorted observation ids: lets a reader re-derive the answer from the public receipts. */
export async function inputsDigest(ids) {
  const data = new TextEncoder().encode([...ids].sort().join("\n"));
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return "sha256:" + h;
}

export const BAND_MEANING = Object.freeze({
  good: "Our checks in the last 30 days found a well-formed 402, stable payment terms and no mismatch. Not a guarantee of delivery and not a rating of the seller.",
  caution: "Something in our checks warrants a fresh check before paying: see flags and reasons. Not a finding about the seller.",
  unknown: "Not enough independent observations to say. Unknown is not a pass: run a live check before paying.",
  operator_endpoint: "An endpoint operated by 402xAgent. Shown for completeness and left out of rankings and statistics.",
});

/**
 * The only shape that may be served. avoid -> caution with the specific flags/reasons (no public avoid label until the appeal
 * path ships). Never includes score, raw, breakdown or the observation ids (the paid answer adds those later).
 */
export function publicAnswer(result, { now = new Date() } = {}) {
  const r = result;
  // 0.79.0: below medium confidence nothing but unknown is shown (the internal band may still be avoid/caution)
  const confOk = (confRank[r.confidence] || 0) >= confRank[PUBLIC_MIN_CONFIDENCE];
  const band = r.band === "operator_endpoint" || r.band === "unknown" ? r.band : !confOk ? "unknown" : r.band === "avoid" ? "caution" : r.band;
  const computed = Date.parse(r.computed_at) || now.getTime();
  const validMs = VALID_FOR_MS[r.band] || HOUR;
  const out = {
    url: r.url, method: r.method, band,
    meaning: BAND_MEANING[band],
    confidence: r.confidence,
    basis: { observations: r.observations, days_observed: r.days_observed, first_seen: r.first_seen, last_checked: r.last_checked },
    reasons: band === "unknown" && r.band !== "unknown" ? [...new Set(["low_data", ...r.reasons])] : r.reasons.slice(),
    flags: r.flags.map((f) => ({ code: f.code, severity: f.severity, confirmed: !!f.confirmed })),
    stale: !!r.stale,
    ...(band === "operator_endpoint" ? { ranked: false } : {}),
    ...(r.crawl_hint ? { crawl_hint: r.crawl_hint } : {}),
    formula_version: r.formula_version, computed_at: r.computed_at, valid_until: isoUtc(computed + validMs),
  };
  return out;
}

/**
 * 0.79.0 hysteresis. A band changes only when the new band holds on two consecutive daily computations; until then the band
 * recorded yesterday is kept (reason band_held). Facts in HOLD_IMMEDIATE_REASONS (failing now, a failed delivery, stale data,
 * not x402, crawl only, our own endpoint) apply at once. Pure.
 * @param today      computeScore() result for now
 * @param prevBand   the internal band recorded for this endpoint on the previous UTC day (null = none: no hold)
 * @param prevCandidate the band computeScore() gives for the same inputs 24 hours earlier (null = unknown: hold)
 */
export function holdBand(today, prevBand, prevCandidate) {
  if (!today || !prevBand || prevBand === today.band) return today;
  if ((today.reasons || []).some((x) => HOLD_IMMEDIATE_REASONS.includes(x))) return today;
  if (prevCandidate === today.band) return today;
  return { ...today, band: prevBand, candidate_band: today.band, reasons: [...new Set([...(today.reasons || []), "band_held"])] };
}

/** Published verbatim at /score-rules.json (served in a later PR). */
export const SCORE_RULES = Object.freeze({
  version: SCORE_VERSION,
  scope: "one score per endpoint URL + method; 30-day window; advisory only (never changes a check's verdict or reason_code)",
  observation_weights: OBS_WEIGHTS,
  caps: { crawl_total_weight: CRAWL_WEIGHT_CAP, outside_live_per_utc_day: LIVE_PER_DAY_CAP, per_utc_hour: 1 },
  excluded: "dry runs, test/audit/deploy/heartbeat clients, payments from our drill wallets, anything touching our own hosts or payTo (operator_endpoint). Reported by category and count only.",
  components: SCORE_WEIGHTS,
  shrinkage: `score = (n_eff * raw + ${SHRINK.strength} * ${SHRINK.prior}) / (n_eff + ${SHRINK.strength})`,
  confidence: CONFIDENCE_RULES,
  bands: { good: `score >= ${BAND_RULES.good_min}, confidence >= medium, no hard flag, latest check ok, no soft flag`, caution: "everything else with enough data, and any internal avoid", unknown: "confidence none/low, stale (> 7 days), crawl-only, not an x402 endpoint", operator_endpoint: "our own hosts" },
  public_avoid: "no public avoid label until the appeal path ships: it is served as caution with the specific flags",
  public_min_confidence: `${PUBLIC_MIN_CONFIDENCE}: below it the public band is unknown (low_data)`,
  listed_pay_to: "a 402 paying any wallet the listing names on the same network (any accepts entry, any Bazaar, or the same site's other endpoints) is a match, not pay_to_mismatch; moving between two listed wallets is not pay_to_changed",
  price_claim: "a listing price of $0, or a listing that no longer names a price, is no claim: price_mismatch against it is not price_above_listing",
  low_confidence_pay_to: "a confirmed pay_to flag at low confidence gives unknown, not caution",
  hysteresis: "a band changes only when two consecutive daily computations agree (reason band_held while waiting); failing_now, delivery_failed_recent, stale_data, not_x402, crawl_only apply at once",
  flags: { hard: HARD_FLAGS, soft: SOFT_FLAGS, confirm: "same fact in >= 2 observations on >= 2 UTC days, or in the newest two", clear: `${BAND_RULES.flag_clear_clean} clean observations over >= 2 days`, expire_days: BAND_RULES.flag_expiry_days },
  reasons: REASON_CODES_SCORE,
});
