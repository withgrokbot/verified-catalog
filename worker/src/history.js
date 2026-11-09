// 0.29.0 endpoint history (D1 only, no KV): the last HISTORY_KEEP observations per normalized endpoint URL.
// Written once per FRESH probe (a cached probe is the same observation), so the extra cost is bounded by the 5-min probe
// cache: one indexed read per check, plus one insert and one prune per fresh probe. Any store error = no history (fail open).
export const HISTORY_KEEP = 30;
/** Appended to the history field docs. Distinct dates we stored, not the span of days between them. */
export const HISTORY_SPAN_CLAUSE = " days_observed = distinct UTC dates among the stored observations; first_seen = the earliest of those; last_checked = the latest (ISO UTC).";
export const RULES_SPAN_SUFFIX = "; days_observed (distinct UTC dates), first_seen, last_checked (ISO UTC)";
export const MCP_HISTORY_OLD = "History: stable_for_days, last_changed, drift. ";
export const MCP_HISTORY_NEW = "History: stable_for_days, last_changed, drift, days_observed, first_seen, last_checked. ";
export const SKIPS_SUMMARY_SUFFIX = ". by_source counts each receipt once and adds up to endpoints_covered; other/unknown holds a receipt with no named source.";
export const LLMS_HISTORY_LINE = "- Receipt history (0.66.2): days_observed is the count of distinct UTC dates among stored observations. first_seen is the earliest of those dates (already included in the count) and last_checked is the latest (ISO UTC in JSON, YYYY-MM-DD HH:MM UTC on HTML). /v1/skips.json by_source counts each receipt once by its primary list and adds up to endpoints_covered; other/unknown holds a receipt with no named source.";
export const SKILL_HISTORY_LINE = "- Per-endpoint history: days_observed (distinct UTC dates among stored observations; first_seen is the earliest of those dates, already included in the count) and last_checked (ISO UTC in JSON; HTML says Last checked: YYYY-MM-DD HH:MM UTC).";
const DAY_MS = 86400000;

export function observation(probe, pm, verdict, observedAt) {
  return {
    observed_at: observedAt,
    http_status: probe && probe.http_status != null ? Number(probe.http_status) : null,
    amount_atomic: pm ? String(pm.amount_atomic) : null,
    price_usd: pm && pm.amount_usd != null ? Number(pm.amount_usd) : null,
    network: pm ? pm.network || null : null,
    asset: pm ? pm.asset || null : null,
    pay_to: pm ? pm.pay_to || null : null,
    verdict: verdict || null,
  };
}
const sig = (o) => (o && o.amount_atomic != null && o.network && o.pay_to ? [o.network, String(o.asset || "").toLowerCase(), String(o.pay_to).toLowerCase(), o.amount_atomic].join("|") : null);

/** ISO UTC with no milliseconds, or null when the value is not a time. */
export function isoUtc(t) {
  const ms = Date.parse(t || "");
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}
/**
 * Span of stored observations only. days_observed is the count of distinct UTC dates among the timestamps
 * we actually have. It is not the number of calendar days from first to last: a weekly crawl that saw an
 * endpoint on two Tuesdays is 2 days observed, not every day in between.
 */
export function observationSpan(times) {
  const iso = [];
  const days = new Set();
  for (const t of times || []) {
    const s = isoUtc(t);
    if (!s) continue;
    iso.push(s);
    days.add(s.slice(0, 10));
  }
  iso.sort();
  return { days_observed: days.size, first_seen: iso[0] || null, last_checked: iso.length ? iso[iso.length - 1] : null };
}
export function lastCheckedLabel(iso) {
  const s = isoUtc(iso);
  return s ? s.slice(0, 16).replace("T", " ") + " UTC" : null;
}
/** Human line for HTML. Null when there is no stored observation to describe. */
export function observationSpanText(span) {
  if (!span || (!span.days_observed && !span.last_checked)) return null;
  const n = span.days_observed || 0;
  const first = span.first_seen ? `, first seen ${span.first_seen.slice(0, 10)}` : "";
  const last = span.last_checked ? `. Last checked: ${lastCheckedLabel(span.last_checked)}` : "";
  return `${n} day${n === 1 ? "" : "s"} observed${first}${last}`;
}

// obs: newest first (the current observation first). Only observations that carried payment terms count toward
// stability, so a one-off timeout does not reset it. Returns only a summary (no price, wallet or network).
// days_observed / first_seen / last_checked count every stored observation, including ones with no payment terms.
export function historySummary(obs, now = new Date()) {
  const list = (obs || []).filter(Boolean);
  const terms = list.filter((o) => sig(o));
  const span = observationSpan(list.map((o) => o.observed_at));
  const base = { observations: list.length, stable_for_days: null, stable_since: null, last_changed: null, drift: null, ...span };
  if (!list.length || !sig(list[0])) return base;
  const cur = sig(terms[0]);
  let i = 0;
  while (i + 1 < terms.length && sig(terms[i + 1]) === cur) i++;
  const since = terms[i].observed_at;
  const changed = i + 1 < terms.length;
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / DAY_MS));
  return { ...base, stable_for_days: Number.isFinite(days) ? days : null, stable_since: since, last_changed: changed ? since : null, drift: terms.length > 1 ? sig(terms[1]) !== cur : null };
}

export async function readHistory(db, hkey) {
  const r = await db.prepare("SELECT observed_at, http_status, amount_atomic, price_usd, network, asset, pay_to, verdict FROM endpoint_history WHERE hkey = ? ORDER BY observed_at DESC LIMIT ?").bind(hkey, HISTORY_KEEP).all();
  return (r && r.results) || [];
}

// Records (when fresh) and summarizes. Never throws.
export async function recordHistory(env, hkey, obs, fresh, now = new Date()) {
  const db = env && env.RECEIPTS_DB;
  if (!db || !hkey) return null;
  try {
    const prev = await readHistory(db, hkey);
    const list = fresh ? [obs, ...prev].slice(0, HISTORY_KEEP) : prev.length ? prev : [obs];
    if (fresh) {
      await db.prepare("INSERT INTO endpoint_history (hkey, observed_at, http_status, amount_atomic, price_usd, network, asset, pay_to, verdict) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(hkey, obs.observed_at, obs.http_status, obs.amount_atomic, obs.price_usd, obs.network, obs.asset, obs.pay_to, obs.verdict).run();
      if (prev.length >= HISTORY_KEEP) {
        await db.prepare("DELETE FROM endpoint_history WHERE hkey = ? AND observed_at < ?").bind(hkey, prev[HISTORY_KEEP - 2].observed_at).run(); // keep obs + 29 newest prev
      }
    }
    const summary = historySummary(list, now);
    Object.defineProperty(summary, "list", { value: list, enumerable: false }); // full rows only for paid/router/exempt answers
    return summary;
  } catch (_) {
    return null;
  }
}
// 0.34.0: the full observations, newest first, for paid / router / exempt answers only (never on free or redacted views).
export function historyObservations(h) {
  const list = (h && h.list) || [];
  return list.map((o) => ({ observed_at: o.observed_at, http_status: o.http_status ?? null, price_usd: o.price_usd ?? null, amount_atomic: o.amount_atomic ?? null, network: o.network ?? null, asset: o.asset ?? null, pay_to: o.pay_to ?? null }));
}
