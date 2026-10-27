// 0.37.0 seller reputation (additive; never changes verdict or reason_code). One score per seller host, 0..100,
// computed on read from D1 data that already exists (spot_receipts, endpoint_history, endpoint_quality). No KV.
// Published verbatim at /rules and /rules.json (REPUTATION_RULES).
import { DELIVERY_WEIGHT, hostDeliveries } from "./delivery.js";
import { historySummary } from "./history.js";
import { QUALITY_SCORE } from "./quality.js";

export const REPUTATION_VERSION = "2026-10-15"; // unchanged for hosts without delivery data (0.53.3 delivery component is additive)
export const REPUTATION_WEIGHTS = { stability: 25, drift: 20, verdicts: 30, freshness: 10, quality: 15 };
export const REPUTATION_MIN = { observations: 5, tracking_days: 2 };
// a host that almost never passes cannot rank above low, however stable its (wrong) terms are
export const REPUTATION_CAP = { pay_share_below: 0.2, min_clear_checks: 5, max_score: 49 };
export const REPUTATION_WINDOW_DAYS = 30;
export const REPUTATION_MAX_ENDPOINTS = 10;
export const BANDS = [{ band: "high", min: 75 }, { band: "medium", min: 50 }, { band: "low", min: 0 }];
const DAY = 86400000;
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const clamp = (x) => Math.max(0, Math.min(1, x));

export const REPUTATION_RULES = {
  version: REPUTATION_VERSION,
  scope: "one score per seller host (scheme://host); every endpoint we have checked on that host counts",
  formula: "score = round(100 * sum(w_i * c_i) / sum(w_i)), over the components c_i (each 0..1) that have data; a component with no data is left out and the remaining weights are renormalized. Cap: with at least 5 pay/skip checks in 30 days and pay_share under 0.2, score = min(score, 49).",
  weights: REPUTATION_WEIGHTS,
  components: {
    stability: "per endpoint: time the current payment terms (price, network, asset, pay_to) have held / time we have observed the endpoint (endpoint_history, last 30 observations); mean over endpoints. Observations without terms (timeouts) do not reset it.",
    drift: "1 - min(1, 2 * penalty / transitions) over consecutive term-bearing observations of every endpoint; penalty per transition: pay_to change 1, network or asset change 1, price-only change 0.5. No transitions -> no data.",
    verdicts: "last 30 days of checks: pay_share * (0.5 + 0.5 * consistency). pay_share = pay / (pay + skip); consistency = share of checks that agree with their endpoint's latest verdict. Recheck verdicts (timeouts, 5xx) are left out.",
    freshness: "1 if the newest check is under 24 h old, then linear down to 0 at 14 days.",
    delivery: `0.53.3, only for hosts with post-payment delivery checks (our own paid check rounds): share of delivery checks in 30 days whose delivered response was ok (not a 5xx, challenge/CAPTCHA page, sign-in/subscribe wall, canned refusal, error-only or placeholder body). Weight ${DELIVERY_WEIGHT}, added to the sum only when the host has delivery data; hosts without delivery data are scored exactly as before.`,
    quality: "mean over endpoints of the latest quality code's value: " + Object.entries(QUALITY_SCORE).map(([k, v]) => k + "=" + v).join(", ") + ". No quality data -> no data.",
  },
  insufficient_data: `fewer than ${REPUTATION_MIN.observations} observations, or first seen less than ${REPUTATION_MIN.tracking_days} days ago: band insufficient_data and score null (paid answers still show provisional_score and the breakdown). A new host is never given a low score for being new.`,
  bands: "high >= 75, medium 50..74, low < 50, or insufficient_data",
  confidence: "high: >= 20 observations, tracked >= 14 days and quality data; medium: >= 10 observations and tracked >= 5 days; else low",
  tiers: "paid, router and exempt answers: reputation {host, score, band, confidence, breakdown, inputs}; free answers and dry runs: reputation {host, band} only",
  note: "reputation never changes verdict, reason_code or confidence; it is extra context, refreshed on every read",
};

export const bandFor = (score) => (score == null ? "insufficient_data" : BANDS.find((b) => score >= b.min).band);

export function hostOf(u) {
  try { const x = new URL(String(u)); return x.protocol === "http:" || x.protocol === "https:" ? x.host.toLowerCase() : null; } catch (_) { return null; }
}

const termSig = (o) => (o && o.amount_atomic != null && o.network && o.pay_to ? o : null);

// Pure. receipts: [{url, created_at, verdict}] newest first; histories: {hkey: [obs newest first]}; quality: [{hkey, observed_at, code}];
// firstSeen: ISO or null.
export function computeReputation({ host, receipts = [], histories = {}, quality = [], firstSeen = null, now = new Date(), deliveries = [] }) {
  const t = now.getTime();
  const winStart = t - REPUTATION_WINDOW_DAYS * DAY;
  // stability + drift (endpoint_history)
  let stabSum = 0, stabN = 0, pen = 0, trans = 0, payToChanges = 0, networkChanges = 0, priceChanges = 0, histObs = 0;
  const stableDays = [];
  for (const list of Object.values(histories)) {
    histObs += list.length;
    const terms = list.filter(termSig);
    if (terms.length) {
      const s = historySummary(list, now);
      const first = Date.parse(terms[terms.length - 1].observed_at);
      const since = s.stable_since ? Date.parse(s.stable_since) : null;
      if (since != null && Number.isFinite(first)) {
        const span = t - first;
        stabSum += span <= 0 ? 1 : clamp((t - since) / span);
        stabN++;
        if (s.stable_for_days != null) stableDays.push(s.stable_for_days);
      }
    }
    for (let i = 0; i + 1 < terms.length; i++) {
      const a = terms[i], b = terms[i + 1];
      trans++;
      const wallet = String(a.pay_to).toLowerCase() !== String(b.pay_to).toLowerCase();
      const net = a.network !== b.network || String(a.asset || "").toLowerCase() !== String(b.asset || "").toLowerCase();
      const price = String(a.amount_atomic) !== String(b.amount_atomic);
      if (wallet) payToChanges++;
      if (net) networkChanges++;
      if (price) priceChanges++;
      pen += wallet || net ? 1 : price ? 0.5 : 0;
    }
  }
  const stability = stabN ? stabSum / stabN : null;
  const drift = trans ? clamp(1 - (2 * pen) / trans) : null;
  // verdicts (spot_receipts, last 30 days)
  const recent = receipts.filter((r) => Date.parse(r.created_at) >= winStart);
  const clear = recent.filter((r) => r.verdict === "pay" || r.verdict === "skip");
  const latestByUrl = {};
  for (const r of receipts) if (!(r.url in latestByUrl) && (r.verdict === "pay" || r.verdict === "skip")) latestByUrl[r.url] = r.verdict;
  const pays = clear.filter((r) => r.verdict === "pay").length;
  const agree = clear.filter((r) => latestByUrl[r.url] === r.verdict).length;
  const verdicts = clear.length ? (pays / clear.length) * (0.5 + 0.5 * (agree / clear.length)) : null;
  // freshness
  const newest = Math.max(receipts.length ? Date.parse(receipts[0].created_at) : 0, ...Object.values(histories).map((l) => (l.length ? Date.parse(l[0].observed_at) : 0)));
  const ageH = newest > 0 ? (t - newest) / 3600000 : null;
  const freshness = ageH == null ? null : ageH <= 24 ? 1 : clamp(1 - (ageH - 24) / (13 * 24));
  // quality (latest code per endpoint)
  const qLatest = {};
  for (const q of quality) if (!(q.hkey in qLatest) && q.code in QUALITY_SCORE) qLatest[q.hkey] = q.code;
  const qCodes = Object.values(qLatest);
  const qual = qCodes.length ? qCodes.reduce((s, c) => s + QUALITY_SCORE[c], 0) / qCodes.length : null;

  const comps = { stability, drift, verdicts, freshness, quality: qual };
  let wsum = 0, acc = 0;
  const breakdown = {};
  for (const [k, w] of Object.entries(REPUTATION_WEIGHTS)) {
    const v = comps[k];
    breakdown[k] = { value: r3(v), weight: w, points: null };
    if (v != null) { wsum += w; acc += w * v; }
  }
  // 0.53.3 delivery component: only when the host has delivery rows (30 days), so other hosts are unchanged
  const dRows = (deliveries || []).filter((x) => x && (x.flag === "ok" || x.flag === "failed"));
  const dFailed = dRows.filter((x) => x.flag === "failed").length;
  const dVal = dRows.length ? (dRows.length - dFailed) / dRows.length : null;
  const weights = dVal != null ? { ...REPUTATION_WEIGHTS, delivery: DELIVERY_WEIGHT } : REPUTATION_WEIGHTS;
  if (dVal != null) { comps.delivery = dVal; breakdown.delivery = { value: r3(dVal), weight: DELIVERY_WEIGHT, points: null }; wsum += DELIVERY_WEIGHT; acc += DELIVERY_WEIGHT * dVal; }
  for (const [k, w] of Object.entries(weights)) if (comps[k] != null) breakdown[k].points = r3((100 * w * comps[k]) / wsum);
  let raw = wsum ? Math.round((100 * acc) / wsum) : null;
  const capped = raw != null && clear.length >= REPUTATION_CAP.min_clear_checks && pays / clear.length < REPUTATION_CAP.pay_share_below && raw > REPUTATION_CAP.max_score;
  if (capped) raw = REPUTATION_CAP.max_score;
  const observations = Math.max(recent.length, histObs);
  const firstMs = firstSeen ? Date.parse(firstSeen) : NaN;
  const trackingDays = Number.isFinite(firstMs) ? Math.max(0, Math.floor((t - firstMs) / DAY)) : 0;
  const insufficient = raw == null || observations < REPUTATION_MIN.observations || trackingDays < REPUTATION_MIN.tracking_days;
  const score = insufficient ? null : raw;
  const confidence = insufficient ? "low" : observations >= 20 && trackingDays >= 14 && qual != null ? "high" : observations >= 10 && trackingDays >= 5 ? "medium" : "low";
  const qCount = {};
  for (const c of qCodes) qCount[c] = (qCount[c] || 0) + 1;
  return {
    host,
    score,
    band: bandFor(score),
    confidence,
    low_data: insufficient,
    ...(insufficient && raw != null ? { provisional_score: raw } : {}),
    breakdown,
    capped,
    inputs: {
      endpoints: Math.max(Object.keys(histories).length, Object.keys(latestByUrl).length),
      observations,
      checks_30d: recent.length,
      pay_30d: pays,
      skip_30d: clear.length - pays,
      recheck_30d: recent.length - clear.length,
      term_transitions: trans,
      pay_to_changes: payToChanges,
      network_or_asset_changes: networkChanges,
      price_changes: priceChanges,
      stable_for_days_min: stableDays.length ? Math.min(...stableDays) : null,
      stable_for_days_max: stableDays.length ? Math.max(...stableDays) : null,
      last_checked: newest > 0 ? new Date(newest).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
      first_seen: Number.isFinite(firstMs) ? new Date(firstMs).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
      tracking_days: trackingDays,
      quality_codes: qCount,
      ...(dRows.length ? { delivery_checks_30d: dRows.length, delivery_failed_30d: dFailed } : {}),
    },
    formula_version: REPUTATION_VERSION,
    rules: "https://402xagent.com/rules.json",
  };
}
export const reputationPublic = (r) => (r ? { host: r.host, band: r.band, rules: r.rules } : null);

// 4 indexed D1 reads, no writes. hkeyFn = historyKey (passed in to keep this module free of lib.js). Never throws.
export async function hostReputation(env, host, hkeyFn, now = new Date()) {
  const db = env && env.RECEIPTS_DB;
  if (!db || !host) return null;
  const h = String(host).toLowerCase();
  const ranges = ["https://" + h + "/", "https://" + h + "0", "http://" + h + "/", "http://" + h + "0"]; // "0" sorts right after "/"
  const where = "((url >= ? AND url < ?) OR (url >= ? AND url < ?))";
  try {
    const rr = await db.prepare(`SELECT url, created_at, verdict FROM spot_receipts WHERE ${where} ORDER BY created_at DESC LIMIT 500`).bind(...ranges).all();
    const receipts = (rr && rr.results) || [];
    let firstSeen = null;
    try {
      const f = await db.prepare(`SELECT MIN(created_at) AS first_seen FROM spot_receipts WHERE ${where}`).bind(...ranges).first();
      firstSeen = (f && f.first_seen) || null;
    } catch (_) {}
    const urls = [...new Set(receipts.map((r) => r.url))].slice(0, REPUTATION_MAX_ENDPOINTS);
    const keys = await Promise.all(urls.map((u) => hkeyFn(u)));
    const histories = {};
    if (keys.length) {
      try {
        const hr = await db.prepare(`SELECT hkey, observed_at, http_status, amount_atomic, price_usd, network, asset, pay_to, verdict FROM endpoint_history WHERE hkey IN (${keys.map(() => "?").join(", ")}) ORDER BY observed_at DESC LIMIT 300`).bind(...keys).all();
        for (const o of (hr && hr.results) || []) (histories[o.hkey] = histories[o.hkey] || []).push(o);
        for (const l of Object.values(histories)) if (l.length && (!firstSeen || l[l.length - 1].observed_at < firstSeen)) firstSeen = l[l.length - 1].observed_at;
      } catch (_) {}
    }
    let quality = [];
    try {
      const qr = await db.prepare("SELECT hkey, observed_at, code FROM endpoint_quality WHERE host = ? ORDER BY observed_at DESC LIMIT 100").bind(h).all();
      quality = (qr && qr.results) || [];
    } catch (_) {} // migration 0007 not applied yet: no quality component
    const deliveries = await hostDeliveries(env, h, now); // [] unless DELIVERY_CHECK=1 and migration 0020 has rows
    return computeReputation({ host: h, receipts, histories, quality, firstSeen, now, deliveries });
  } catch (_) {
    return null;
  }
}

// GET /reputation/<host>[.json]: free, coarse band only (the score and breakdown are in paid / router answers).
const escH = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export async function handleReputation(req, env, url, hkeyFn) {
  let raw = decodeURIComponent(url.pathname.slice("/reputation/".length)).trim().toLowerCase();
  const wantJson = raw.endsWith(".json") || !/text\/html/.test(req.headers.get("accept") || "");
  if (raw.endsWith(".json")) raw = raw.slice(0, -5);
  const hdr = { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" };
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/.test(raw) || raw.length > 253)
    return new Response(JSON.stringify({ error: "use /reputation/<host>, e.g. /reputation/api.402rates.com" }), { status: 400, headers: { ...hdr, "content-type": "application/json; charset=utf-8" } });
  const rep = await hostReputation(env, raw, hkeyFn);
  const body = {
    host: raw,
    band: rep ? rep.band : "insufficient_data",
    bands: "high | medium | low | insufficient_data",
    note: "free view: coarse band only. Paid, router and exempt 402xAgent checks carry reputation.score, breakdown and inputs.",
    check: "https://api.402xagent.com/v1/products/endpoint-spot-check?url=<endpoint on this host>",
    rules: "https://402xagent.com/rules.json",
  };
  if (wantJson) return new Response(JSON.stringify(body), { headers: { ...hdr, "content-type": "application/json; charset=utf-8" } });
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>402xAgent reputation: ${escH(raw)}</title><link rel="alternate" type="application/json" href="/reputation/${escH(raw)}.json"><style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px}</style></head><body><h1>Seller reputation: ${escH(raw)}</h1><p>Band: <b>${escH(body.band)}</b> (high, medium, low or insufficient_data).</p><p>${escH(body.note)}</p><p>Formula and weights: <a href="/rules">/rules</a> · JSON: <a href="/reputation/${escH(raw)}.json">/reputation/${escH(raw)}.json</a></p></body></html>`, { headers: { ...hdr, "content-type": "text/html; charset=utf-8" } });
}
