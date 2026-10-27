// 0.52.0 spot-check funnel: free_check -> cap_hit -> paid, written to Workers Analytics Engine (binding FUNNEL,
// dataset vc_funnel). Every event is keyed only by a per-UTC-day SHA-256 digest of the quota key: never a raw IP,
// client name or wallet. Read back only through admin-only GET /v1/admin/funnel.
// Data point layout: index1 = digest; blob1 = event, blob2 = digest, blob3 = UA family (coarse, e.g. "node");
// double1 = free credits remaining (free_check), double2 = USD charged (paid), double3 = 1 when self-test traffic.
export const FUNNEL_EVENTS = Object.freeze(["free_check", "cap_hit", "paid"]);
export const FUNNEL_DATASET = "vc_funnel";

async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Per-day digest of a quota key ("c:name" or "ip:<hash>"). Rotates at 00:00 UTC, so it never links days. */
export async function funnelDigest(salt, key, day) {
  return (await sha256hex(`${salt || "unsalted-dev"}|funnel|${day}|${key}`)).slice(0, 32);
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
    daily: `SELECT toStartOfDay(timestamp) AS day, blob1 AS event, count(DISTINCT blob2) AS digests, SUM(_sample_interval) AS events ${base} GROUP BY day, event ORDER BY day`,
    top: `SELECT blob3 AS ua, count(DISTINCT blob2) AS digest_days, SUM(_sample_interval) AS cap_hits ${base} AND blob1 = 'cap_hit' GROUP BY ua ORDER BY cap_hits DESC LIMIT 15`,
  };
}

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
  const run = async (sql) => {
    const r = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, { method: "POST", headers: { authorization: "Bearer " + env.AE_READ_TOKEN }, body: sql });
    if (!r.ok) throw new Error("analytics query failed: HTTP " + r.status);
    return ((await r.json()) || {}).data || [];
  };
  try {
    const [daily, top] = await Promise.all([run(q.daily), run(q.top)]);
    return J(funnelSummary(daily, top, q.days));
  } catch (e) {
    return J({ error: String(e && e.message || e).slice(0, 200) }, 502);
  }
}
