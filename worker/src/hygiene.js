// 0.50.0 x402 hygiene scorer (docs/plan-hygiene.md + Max's answers 2026-10-22).
// hygiene(probe) is pure. GET /v1/hygiene?url= is free (20/day per hashed IP prefix, D1), cached 24 h in a PRIVATE
// D1 table. We NEVER send deliberately bad requests to sellers: only normal unpaid GETs. Grades are returned only to
// the caller: no leaderboard, no badges, never exported to /v1/skips, /saves, /bazaar, recent lists or ops stats.
import { assertSafeUrl, resolveHost } from "./spotcheck.js";
import { isPlaceholderUrl } from "./ops.js";
import { ipPrefix } from "./lib.js";

export const HYGIENE_FREE_PER_DAY = 20;
export const HYGIENE_TTL_S = 86400;
export const HYGIENE_SAMPLES = 3;
export const HYGIENE_TIMEOUT_MS = 5000;
const MAX_BODY = 65536;
const W = { version: 20, amount: 20, timeout: 10, parse: 20, size: 10, status_discipline: 10, latency: 10 };
const FIX = {
  version_inconsistent: "Send one x402Version; v2 uses `amount`, v1 `maxAmountRequired`.",
  version_missing: "Send x402Version (1 or 2) in the 402 body or PAYMENT-REQUIRED header.",
  amount_not_atomic: "amount is atomic units (USDC 6 decimals): a positive integer string, e.g. \"10000\" = $0.01.",
  amount_implausible: "amount is atomic units (USDC 6 decimals); this quote is over $1,000,000.",
  timeout_out_of_range: "Set maxTimeoutSeconds 60–3600.",
  unparseable: "Return JSON with accepts[]: scheme, network, amount, asset, payTo.",
  unknown_network: "Use a known network id (v2: CAIP-2 such as eip155:8453; v1: base, base-sepolia, solana, ...).",
  network_mismatch: "The 402 network differs from your listing; publish the same network in both.",
  quote_too_large: "Trim the 402 body under 4 KB.",
  paywall_on_400: "Validate input before the paywall; reply 400 without payment terms, 402 only for unpaid valid calls.",
};
const V1_NETS = { base: "eip155:8453", "base-sepolia": "eip155:84532", avalanche: "eip155:43114", "avalanche-fuji": "eip155:43113", polygon: "eip155:137", "polygon-amoy": "eip155:80002", sei: "eip155:1329", "sei-testnet": "eip155:1328", iotex: "eip155:4689", solana: "solana:mainnet", "solana-devnet": "solana:devnet" };
const normNet = (n) => { const s = String(n || "").toLowerCase(); return V1_NETS[s] || s; };
const knownNet = (n) => /^eip155:\d+$/.test(normNet(n)) || /^solana:/.test(normNet(n));
const USDC_RE = /^0x(833589fcd6edb6e08f4c7c32d4f71b54bda02913|036cbd53842c5426634e7929541ec2318f3dcf7e)$/i;

export const gradeOf = (s) => (s >= 90 ? "A" : s >= 75 ? "B" : s >= 60 ? "C" : s >= 40 ? "D" : "F");
const hget = (h, k) => { if (!h) return ""; if (typeof h.get === "function") return h.get(k) || ""; const e = Object.entries(h).find(([n]) => n.toLowerCase() === k); return e ? String(e[1]) : ""; };
const tryJson = (s) => { try { const o = JSON.parse(s); return o && typeof o === "object" ? o : null; } catch (_) { return null; } };
const unb64 = (s) => { try { return tryJson(typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString()); } catch (_) { return null; } };

/** probe: {status, headers, bodyText, latencies[], listing?: {network}} -> {score, grade, deductions[{code, points, fix}], na[]} */
export function hygiene(probe) {
  const p = probe || {};
  const body = tryJson(p.bodyText || "");
  const hdrRaw = hget(p.headers, "payment-required");
  const hdr = hdrRaw ? unb64(hdrRaw) || tryJson(hdrRaw) : null;
  const ch = (body && Array.isArray(body.accepts) ? body : null) || (hdr && Array.isArray(hdr.accepts) ? hdr : null);
  const accepts = ch ? ch.accepts.filter((a) => a && typeof a === "object") : [];
  const raw = []; const na = [];
  const ded = (code, pts) => raw.push({ code, raw: pts });

  // version consistency (v1-only is neutral; only inconsistency or absence costs)
  const vs = new Set();
  if (body && body.x402Version != null) vs.add(Number(body.x402Version));
  if (hdr && hdr.x402Version != null) vs.add(Number(hdr.x402Version));
  for (const a of accepts) {
    if (a.amount != null) vs.add(2);
    if (a.maxAmountRequired != null) vs.add(1);
    if (/^[a-z-]+$/.test(String(a.network || "")) && V1_NETS[a.network] && ch && Number(ch.x402Version) === 2) vs.add(1);
  }
  if (vs.size > 1) ded("version_inconsistent", W.version); else if (vs.size === 0) ded("version_missing", W.version);

  // parseability, network ids, listing match
  const complete = accepts.length > 0 && accepts.every((a) => a.scheme && a.network && a.asset && a.payTo && (a.amount != null || a.maxAmountRequired != null));
  if (!complete) ded("unparseable", W.parse);
  else {
    if (!accepts.every((a) => knownNet(a.network))) ded("unknown_network", 10);
    const ln = p.listing && p.listing.network ? normNet(p.listing.network) : null;
    if (ln && !accepts.some((a) => normNet(a.network) === ln)) ded("network_mismatch", 10);
  }

  // amount sanity
  const amts = accepts.map((a) => (a.amount != null ? a.amount : a.maxAmountRequired));
  if (!amts.length || !amts.every((x) => typeof x === "string" && /^\d+$/.test(x) && BigInt(x) > 0n)) ded("amount_not_atomic", W.amount);
  else if (accepts.some((a, i) => USDC_RE.test(String(a.asset || "")) && BigInt(amts[i]) > 1000000000000n)) ded("amount_implausible", W.amount);

  // timeout
  if (!accepts.length || !accepts.every((a) => Number.isFinite(Number(a.maxTimeoutSeconds)) && a.maxTimeoutSeconds >= 60 && a.maxTimeoutSeconds <= 3600)) ded("timeout_out_of_range", W.timeout);

  // size
  const bytes = new TextEncoder().encode(String(p.bodyText || "")).length;
  if (bytes >= 4096) ded("quote_too_large", W.size);

  // 402-vs-400, only from the normal unpaid probe
  if (p.status === 402) {} else if ((p.status === 400 || p.status === 422) && accepts.length) ded("paywall_on_400", W.status_discipline); else na.push("status_discipline");

  // latency p50
  const ls = (p.latencies || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  let p50 = null;
  if (!ls.length) na.push("latency");
  else {
    p50 = Math.round(ls[Math.floor((ls.length - 1) / 2)]);
    if (p50 > 1500) ded("latency_slow", W.latency); else if (p50 > 500) ded("latency_slow", W.latency / 2);
  }
  const avail = Object.entries(W).filter(([k]) => !na.includes(k)).reduce((s, [, v]) => s + v, 0);
  const deductions = raw.map((d) => ({ code: d.code, points: Math.round((d.raw * 100) / avail), fix: d.code === "latency_slow" ? `Unpaid 402 should be fast (≤500 ms full points, ≤1.5 s half); p50 was ${p50} ms.` : FIX[d.code] }));
  const score = Math.max(0, 100 - deductions.reduce((s, d) => s + d.points, 0));
  return { score, grade: gradeOf(score), deductions, na };
}

// ---- store (private D1 tables from migrations/0016_hygiene.sql)
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const normKey = (u) => { try { const x = new URL(u); x.hash = ""; return x.toString(); } catch (_) { return String(u); } };
export async function cachedHygiene(env, url, now = new Date()) {
  if (!env || !env.RECEIPTS_DB) return null;
  try {
    const row = await env.RECEIPTS_DB.prepare("SELECT json, scored_at FROM hygiene_cache WHERE hkey = ? AND scored_at >= ?").bind(await sha(normKey(url)), iso(new Date(now - HYGIENE_TTL_S * 1000))).first();
    return row ? { ...JSON.parse(row.json), scored_at: row.scored_at } : null;
  } catch (_) { return null; }
}
/** Paid-report field: the cached score only (no extra seller request). Informational: never changes any verdict. */
export async function reportHygiene(env, url, now = new Date()) {
  const c = await cachedHygiene(env, url, now);
  if (!c) return { score: null, grade: null, deductions: [], note: "not scored in the last 24 h; GET /v1/hygiene?url= (free) scores it; never affects the verdict" };
  return { score: c.score, grade: c.grade, deductions: c.deductions, scored_at: c.scored_at, note: "informational; never affects the verdict" };
}

const J = (o, status = 200, extra = {}) => new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store", ...extra } });
const bad = (error) => J({ error, field: "url", example: "https://api.402xagent.com/v1/hygiene?url=https://api.402rates.com/v1/ping", nothing_probed: true }, 400);

async function probeSeller(url, fetchImpl) {
  const latencies = []; let first = null;
  for (let i = 0; i < HYGIENE_SAMPLES; i++) {
    const t0 = Date.now();
    let resp;
    try { resp = await fetchImpl(url, { method: "GET", redirect: "manual", headers: { accept: "application/json", "user-agent": "402xAgent-hygiene/0.51.0 (+https://402xagent.com/docs)" }, signal: AbortSignal.timeout(HYGIENE_TIMEOUT_MS) }); }
    catch (_) { if (!first) return null; break; }
    const text = (await resp.text()).slice(0, MAX_BODY);
    latencies.push(Date.now() - t0);
    if (!first) { first = { status: resp.status, headers: Object.fromEntries(resp.headers), bodyText: text }; if (resp.status !== 402) break; }
  }
  return { ...first, latencies };
}

export async function handleHygiene(req, env, deps = {}, now = new Date()) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET" } });
  if (req.method !== "GET" && req.method !== "HEAD") return J({ error: "use GET /v1/hygiene?url=<endpoint>" }, 405, { allow: "GET" });
  const raw = new URL(req.url).searchParams.get("url");
  if (!raw) return bad('"url" is required: the full http(s) URL of an x402 endpoint');
  let target; try { target = new URL(raw); } catch (_) {}
  if (!target || !/^https?:$/.test(target.protocol)) return bad('"url" must be a full http(s) URL');
  if (isPlaceholderUrl(raw)) return bad("This looks like the docs placeholder. Submit a real x402 endpoint URL.");
  const fetchImpl = deps.fetchImpl || fetch;
  const safe = await assertSafeUrl(target.toString(), { resolveHostFn: deps.resolveHostFn || resolveHost, fetchImpl });
  if (!safe.ok) return bad("blocked: " + safe.reason);
  const url = target.toString();
  const hit = await cachedHygiene(env, url, now);
  if (hit) return J({ url, score: hit.score, grade: hit.grade, deductions: hit.deductions, scored_at: hit.scored_at, cached: true });
  if (!env || !env.RECEIPTS_DB) return J({ error: "hygiene store unavailable, try again shortly" }, 503);
  // free quota: D1 counter keyed by a salted hash of the /24 (/48) prefix; the raw IP and prefix are never stored
  let n;
  try {
    const pkey = (await sha(String(env.CLIENT_SALT || "") + "|hygiene|" + ipPrefix(req.headers.get("cf-connecting-ip") || ""))).slice(0, 32);
    const row = await env.RECEIPTS_DB.prepare("INSERT INTO hygiene_quota (day, pkey, n) VALUES (?, ?, 1) ON CONFLICT(day, pkey) DO UPDATE SET n = n + 1 RETURNING n").bind(iso(now).slice(0, 10), pkey).first();
    n = row ? Number(row.n) : 1;
  } catch (_) { return J({ error: "hygiene store unavailable, try again shortly" }, 503); }
  if (n > HYGIENE_FREE_PER_DAY) return J({ error: `free hygiene quota used: ${HYGIENE_FREE_PER_DAY} per day per network; cached results stay free`, limit: HYGIENE_FREE_PER_DAY }, 429, { "retry-after": "3600" });
  // 0.50.1: our own hosts are probed in-process (same-zone subrequests never reach the Worker)
  const probe = await probeSeller(url, deps.probeFetchImpl || fetchImpl);
  if (!probe) return J({ url, error: "endpoint unreachable (5 s timeout); nothing scored" }, 502);
  const { score, grade, deductions } = hygiene(probe);
  const scored_at = iso(now);
  try {
    await env.RECEIPTS_DB.prepare("INSERT OR REPLACE INTO hygiene_cache (hkey, scored_at, json) VALUES (?, ?, ?)").bind(await sha(normKey(url)), scored_at, JSON.stringify({ score, grade, deductions })).run();
    await env.RECEIPTS_DB.prepare("DELETE FROM hygiene_cache WHERE scored_at < ?").bind(iso(new Date(now - 2 * HYGIENE_TTL_S * 1000))).run();
    await env.RECEIPTS_DB.prepare("DELETE FROM hygiene_quota WHERE day < ?").bind(iso(new Date(now - 2 * HYGIENE_TTL_S * 1000)).slice(0, 10)).run();
  } catch (_) {}
  return J({ url, score, grade, deductions, scored_at, cached: false });
}
