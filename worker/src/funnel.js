// 0.52.0 spot-check funnel: free_check -> cap_hit -> paid, written to Workers Analytics Engine (binding FUNNEL,
// dataset vc_funnel). Every event is keyed only by a per-UTC-day SHA-256 digest of the quota key: never a raw IP,
// client name or wallet. Read back only through admin-only GET /v1/admin/funnel.
// Data point layout: index1 = digest; blob1 = event, blob2 = digest, blob3 = UA family (coarse, e.g. "node");
// double1 = free credits remaining (free_check), double2 = USD charged (paid), double3 = 1 when self-test traffic.
// 0.69.1 also returns per-UTC-day free_checks / payment_required_402 / paid_events (self vs outside, plus hostTag)
// by reading vc_lookups fields that were already written (blob6, blob13, blob16, blob20, double3). No new blobs.
import { hostTag } from "./ops.js";

export const FUNNEL_EVENTS = Object.freeze(["free_check", "cap_hit", "paid"]);
export const FUNNEL_DATASET = "vc_funnel";
export const LOOKUPS_DATASET = "vc_lookups";
export const CALL_KINDS = Object.freeze(["free_checks", "payment_required_402", "paid_events"]);
const FREE_ACCESS = new Set(["free", "exempt", "partner"]);
const PAID_ACCESS = new Set(["paid", "paid-unstored"]);

async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Per-day digest of a quota key ("c:name" or "ip:<hash>"). Rotates at 00:00 UTC, so it never links days. */
export async function funnelDigest(salt, key, day) {
  if (!salt) return ""; // no CLIENT_SALT = no digest = funnelEvent writes nothing (never an unsalted key)
  return (await sha256hex(`${salt}|funnel|${day}|${key}`)).slice(0, 32);
}

const uaFamily = (ua) => String(ua || "").split(/[\/\s(;]/)[0].slice(0, 40) || "-";

/** Write one funnel event. Never throws: counting must never break an answer. */
export function funnelEvent(env, { event, digest, ua = "", creditsRemaining = 0, amountUsd = 0, self = false }) {
  try {
    if (!FUNNEL_EVENTS.includes(event) || !digest) return false;
    if (!env.FUNNEL || typeof env.FUNNEL.writeDataPoint !== "function") return false;
    env.FUNNEL.writeDataPoint({
      indexes: [digest],
      blobs: [event, digest, uaFamily(ua)],
      doubles: [Number(creditsRemaining) || 0, Number(amountUsd) || 0, self ? 1 : 0],
    });
    return true;
  } catch (_) {
    return false;
  }
}

/** SQL for the admin read (Analytics Engine SQL API). days is clamped to 1..30. Self-test rows are excluded. */
export function funnelSql(days) {
  const d = Math.min(30, Math.max(1, Math.floor(Number(days) || 7)));
  const base = `FROM ${FUNNEL_DATASET} WHERE timestamp > NOW() - INTERVAL '${d}' DAY AND double3 = 0`;
  return {
    days: d,
    daily: `SELECT toStartOfDay(timestamp) AS day, blob1 AS event, count(DISTINCT blob2) AS digests, SUM(_sample_interval) AS events ${base} GROUP BY day, event ORDER BY day FORMAT JSON`,
    top: `SELECT blob3 AS ua, count(DISTINCT blob2) AS digest_days, SUM(_sample_interval) AS cap_hits ${base} AND blob1 = 'cap_hit' GROUP BY ua ORDER BY cap_hits DESC LIMIT 15 FORMAT JSON`,
  };
}

/** SQL for the 0.69.1 call counts. days is already clamped. Reads only aggregate columns; never client, IP, wallet or tx. */
export function callsSql(days) {
  const d = Math.min(30, Math.max(1, Math.floor(Number(days) || 7)));
  const free = "(blob16 = 'lookup' OR blob16 = 'spot') AND (blob13 = 'free' OR blob13 = 'exempt' OR blob13 = 'partner')";
  const paid = "blob13 = 'paid' OR blob13 = 'paid-unstored'";
  return `SELECT toStartOfDay(timestamp) AS day, blob6 AS reason, blob13 AS access, blob16 AS product, blob20 AS host, double3 AS status, SUM(_sample_interval) AS n FROM ${LOOKUPS_DATASET} WHERE timestamp > NOW() - INTERVAL '${d}' DAY AND ((${free}) OR double3 = 402 OR ${paid}) GROUP BY day, reason, access, product, host, status ORDER BY day FORMAT JSON`;
}

/** Which call counter a vc_lookups row belongs to. "" = not one of the three (dry runs, views, usage pages). */
export function callKind({ product = "", access = "", status = 0 } = {}) {
  const p = String(product || "");
  const a = String(access || "");
  if ((p === "lookup" || p === "spot") && FREE_ACCESS.has(a)) return "free_checks";
  if (PAID_ACCESS.has(a)) return "paid_events";
  if (Number(status) === 402) return "payment_required_402";
  return "";
}

/** self = the tag already stored in blob6. Cron/probes use SELF_CLIENTS; withgrokbot UAs and our own payers are tagged the same way at write time. */
export function callerClass(reason) {
  return String(reason || "") === "self" ? "self" : "outside";
}

/** hostTag (paywall_daily_host) on blob20. An empty host was not recorded (before 0.22.0) and is not called "other". */
export function callHost(host) {
  const h = String(host || "").trim();
  return h ? hostTag(h) : "unrecorded";
}

const split = () => ({ total: 0, self: 0, outside: 0 });
const dayCalls = (day) => ({
  day,
  free_checks: split(),
  payment_required_402: split(),
  paid_events: split(),
  by_host: {},
});
function addSplit(s, caller, n) {
  s[caller === "self" ? "self" : "outside"] += n;
  s.total += n;
}

/** Fold grouped vc_lookups rows into per-UTC-day counts. History is whatever AE still has; nothing new is written. */
export function callsSummary(rows) {
  const byDay = {};
  for (const r of rows || []) {
    const kind = callKind(r);
    if (!CALL_KINDS.includes(kind)) continue;
    const day = String(r.day || "").slice(0, 10);
    const n = Number(r.n) || 0;
    if (!day || !n) continue;
    const caller = callerClass(r.reason);
    const host = callHost(r.host);
    const o = (byDay[day] ||= dayCalls(day));
    addSplit(o[kind], caller, n);
    const bucket = (o.by_host[host] ||= { free_checks: split(), payment_required_402: split(), paid_events: split() });
    addSplit(bucket[kind], caller, n);
  }
  const list = Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1));
  for (const o of list) {
    const hosts = {};
    for (const h of Object.keys(o.by_host).sort()) hosts[h] = o.by_host[h];
    o.by_host = hosts;
  }
  const totals = { free_checks: split(), payment_required_402: split(), paid_events: split() };
  for (const o of list) for (const k of CALL_KINDS) {
    totals[k].self += o[k].self;
    totals[k].outside += o[k].outside;
    totals[k].total += o[k].total;
  }
  return { daily: list, totals };
}

export const CALLS_DEFINITION = "Per UTC day from vc_lookups, SUM(_sample_interval). free_checks = product lookup or spot with access free, exempt or partner (a free lookup or free spot-check, including SELF_CLIENTS and the partner pool; dry runs are not included). payment_required_402 = a recorded HTTP 402 (double3), including payment-required and payment-failed. paid_events = a settled call (access paid or paid-unstored). self = blob6 already equal to self (SELF_CLIENTS such as the cron and probes, a withgrokbot user-agent, or a settled spot check whose payer is our payTo or DRILL_WALLETS); every other caller is outside. by_host is hostTag on blob20 (api.402xagent.com, 402xagent.com, workers.dev, payscout, other); an empty host is unrecorded. These columns were already written, so history is the Analytics Engine retention of vc_lookups and host is empty before 0.22.0. No new blobs in 0.69.1. The query does not read and the body does not return a raw IP, wallet, client name or transaction. daily.paid_events above is still the spot-funnel sample count from vc_funnel; calls[].paid_events is settled calls from vc_lookups.";

/** Fold the daily rows into per-day counts plus liteConversion = distinct paid digests / distinct cap_hit digests. */
export function funnelSummary(dailyRows, topRows, days) {
  const byDay = {};
  for (const r of dailyRows || []) {
    const day = String(r.day).slice(0, 10);
    const o = (byDay[day] ||= { day, free_check: 0, cap_hit: 0, paid: 0, free_check_events: 0, cap_hit_events: 0, paid_events: 0 });
    if (!FUNNEL_EVENTS.includes(r.event)) continue;
    o[r.event] = Number(r.digests) || 0;
    o[r.event + "_events"] = Number(r.events) || 0;
  }
  const list = Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1));
  for (const o of list) o.liteConversion = o.cap_hit ? +(o.paid / o.cap_hit).toFixed(4) : null;
  const tot = list.reduce((a, o) => ({ cap: a.cap + o.cap_hit, paid: a.paid + o.paid }), { cap: 0, paid: 0 });
  return {
    days,
    liteConversion: tot.cap ? +(tot.paid / tot.cap).toFixed(4) : null,
    definition: "liteConversion = distinct paying digests / distinct digests that hit the free cap (digest = per-UTC-day SHA-256 of the quota key; summed over days). Self-test traffic excluded.",
    totals: { cap_hit_digest_days: tot.cap, paid_digest_days: tot.paid },
    daily: list,
    top_cap_hitters_by_ua: (topRows || []).map((r) => ({ ua: r.ua, digest_days: Number(r.digest_days) || 0, cap_hits: Number(r.cap_hits) || 0 })),
  };
}

function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

const J = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });

/** GET /v1/admin/funnel?days=N. Bearer FUNNEL_ADMIN_TOKEN; reads via CF_ACCOUNT_ID + AE_READ_TOKEN (secrets). */
export async function handleFunnelAdmin(req, env, { fetchImpl = fetch } = {}) {
  const tok = String(env.FUNNEL_ADMIN_TOKEN || "");
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok || !safeEq(got, tok)) return J({ error: "not found" }, 404);
  if (!env.CF_ACCOUNT_ID || !env.AE_READ_TOKEN) return J({ error: "funnel read not configured (CF_ACCOUNT_ID / AE_READ_TOKEN)" }, 503);
  const q = funnelSql(new URL(req.url).searchParams.get("days"));
  const callsQuery = callsSql(q.days);
  const run = async (sql) => {
    const r = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, { method: "POST", headers: { authorization: "Bearer " + env.AE_READ_TOKEN }, body: sql });
    if (!r.ok) throw new Error("analytics query failed: HTTP " + r.status);
    return ((await r.json()) || {}).data || [];
  };
  try {
    const [daily, top, callRows] = await Promise.all([run(q.daily), run(q.top), run(callsQuery)]);
    const calls = callsSummary(callRows);
    return J({ ...funnelSummary(daily, top, q.days), calls_definition: CALLS_DEFINITION, calls: calls.daily, calls_totals: calls.totals });
  } catch (e) {
    return J({ error: String(e && e.message || e).slice(0, 200) }, 502);
  }
}
