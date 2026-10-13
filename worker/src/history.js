// 0.29.0 endpoint history (D1 only, no KV): the last HISTORY_KEEP observations per normalized endpoint URL.
// Written once per FRESH probe (a cached probe is the same observation), so the extra cost is bounded by the 5-min probe
// cache: one indexed read per check, plus one insert and one prune per fresh probe. Any store error = no history (fail open).
export const HISTORY_KEEP = 30;
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

// obs: newest first (the current observation first). Only observations that carried payment terms count toward
// stability, so a one-off timeout does not reset it. Returns only a summary (no price, wallet or network).
export function historySummary(obs, now = new Date()) {
  const list = (obs || []).filter(Boolean);
  const terms = list.filter((o) => sig(o));
  const base = { observations: list.length, stable_for_days: null, stable_since: null, last_changed: null, drift: null };
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
