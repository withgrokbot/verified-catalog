// 0.76.0 reliability score: storage, daily rollup and serving (PR 3 of 3). Behind SCORE_BAND = off (default) | shadow | on.
//   off     nothing runs, nothing is read or written, no route, no MCP tool, no field on discover rows.
//   shadow  the daily rollup computes every probed endpoint's band and records it in endpoint_score_daily (migration 0034).
//           Nothing is served: /v1/score and /score-rules.json answer like any unknown path, no MCP tool, no discover field.
//   on      shadow + GET /v1/score?url=, /score-rules.json, a `band` on discover rows, and the MCP tool safe_to_pay.
// Every served answer is Ed25519-signed like a receipt (signObject). The public band never says avoid (see score.js).
import { computeScore, publicAnswer, inputsDigest, scoreConfig, SCORE_RULES, SCORE_VERSION, isOperatorHost, hostOf, holdBand, PUBLIC_MIN_CONFIDENCE } from "./score.js";
import { publicUrl } from "./recent.js";
import { signObject } from "./sign.js";
import { paidCheckBlock } from "./paidcheck.js";
import { GENERIC_UAS } from "./probeset.js";

export const SCORE_MODES = Object.freeze(["off", "shadow", "on"]);
export const scoreMode = (env) => { const v = String((env && env.SCORE_BAND) || "").toLowerCase(); return SCORE_MODES.includes(v) ? v : "off"; };
export const scoreServeOn = (env) => scoreMode(env) === "on";
export const scoreRecordOn = (env) => scoreMode(env) !== "off";
export const SCORE_API = "https://api.402xagent.com";
export const SCORE_SITE = "https://402xagent.com";
export const ROLLUP_DEFAULT_BATCH = 60;
export const ROLLUP_MAX_BATCH = 150;
export const SCORE_KEEP_DAYS = 400;
export const SCORE_WINDOW_MS = 30 * 86400e3;
const SEED_MARK = "~seeded~";
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const dayOf = (now) => now.toISOString().slice(0, 10);
export const rollupBatch = (env) => (/^\d{1,4}$/.test(String((env && env.SCORE_ROLLUP_BATCH) || "")) ? Math.max(1, Math.min(ROLLUP_MAX_BATCH, parseInt(env.SCORE_ROLLUP_BATCH, 10))) : ROLLUP_DEFAULT_BATCH);
export const queueKey = (now) => dayOf(now) + "+scoreq";

async function rows(db, sql, ...binds) { const r = await db.prepare(sql).bind(...binds).all(); return (r && r.results) || []; }
async function rowsSafe(db, sql, ...binds) { try { return await rows(db, sql, ...binds); } catch (_) { return []; } }

/** Both stored spellings of an endpoint URL (receipts keep a trailing slash that publicUrl strips). */
export function urlVariants(raw) {
  const p = publicUrl(raw);
  if (!p) return null;
  const set = new Set([p]);
  try { const u = new URL(p); set.add(`${u.protocol}//${u.host}${u.pathname.endsWith("/") ? u.pathname.slice(0, -1) || "/" : u.pathname + "/"}`); } catch (_) {}
  return { url: p, variants: [...set].slice(0, 2) };
}

const RECEIPT_SQL = `SELECT id, created_at AS at, verdict, check_type, ref,
  json_extract(body, '$.client') AS client, json_extract(body, '$.caller') AS caller, json_extract(body, '$.probe_origin') AS origin,
  COALESCE(json_extract(body, '$.reason_code'), reason) AS reason_code,
  json_extract(body, '$.live_402.http_status') AS http_status, json_extract(body, '$.live_402.x402_challenge') AS challenge,
  json_extract(body, '$.listing.source') AS listing_source, json_extract(body, '$.method') AS method,
  COALESCE(json_extract(body, '$.approved_payment.pay_to'), json_extract(body, '$.live_402.accepts[0].pay_to')) AS pay_to,
  COALESCE(json_extract(body, '$.approved_payment.network'), json_extract(body, '$.live_402.accepts[0].network')) AS network,
  COALESCE(json_extract(body, '$.approved_payment.asset'), json_extract(body, '$.live_402.accepts[0].asset')) AS asset,
  COALESCE(json_extract(body, '$.approved_payment.amount_atomic'), json_extract(body, '$.live_402.accepts[0].amount_atomic')) AS amount,
  CASE WHEN COALESCE(json_extract(body, '$.reason_code'), reason) = 'pay_to_mismatch' THEN json_extract(body, '$.live_402.accepts') END AS accepts,
  json_extract(body, '$.expected.network') AS expected_network,
  CASE WHEN COALESCE(json_extract(body, '$.reason_code'), reason) = 'price_mismatch' THEN json_extract(body, '$.expected.claimed_price_usd') END AS claimed
  FROM spot_receipts WHERE url IN (?, ?) AND created_at >= ? ORDER BY created_at DESC LIMIT 600`;

/** 0.79.0: the 402's accepts entries (pay_to_mismatch rows only), reduced to network + pay_to + asset, at most 8. */
export function acceptsOf(j) {
  let a = null;
  try { a = typeof j === "string" ? JSON.parse(j) : j; } catch (_) { return null; }
  if (!Array.isArray(a)) return null;
  const out = a.filter((x) => x && typeof x === "object").slice(0, 8).map((x) => ({ network: x.network, pay_to: x.pay_to || x.payTo, asset: x.asset }));
  return out.length ? out : null;
}
/** One receipt row -> the scorer's raw observation. */
export function receiptObservation(r) {
  return {
    id: r.id, at: r.at, source: "receipt", check_type: r.check_type, ref: r.ref, client: r.client, caller: r.caller, origin: r.origin,
    verdict: r.verdict, reason_code: r.reason_code, http_status: r.http_status, x402_challenge: r.challenge == null ? undefined : !!r.challenge,
    listing_source: r.listing_source, terms: r.pay_to && r.network ? { pay_to: r.pay_to, network: r.network, asset: r.asset, amount: r.amount } : null,
    ...(r.accepts ? { accepts: acceptsOf(r.accepts) } : {}), ...(r.expected_network ? { expected_network: r.expected_network } : {}),
    ...(r.claimed != null ? { claimed: Number(r.claimed) } : {}),
  };
}
/** Weekly crawl row -> one low-weight observation. Only a pay is read as an outcome; a crawl never penalises (no reason code, no terms). */
export function crawlObservation(c) {
  const at = c && (c.timestamp || c.checked_at);
  if (!c || !Number.isFinite(Date.parse(at))) return null;
  return { id: String(c.id || "crawl"), at, source: "crawl", verdict: c.verdict, reason_code: c.verdict === "pay" ? "price_ok" : "", http_status: c.http_status ?? null, terms: null };
}

/** Everything the scorer needs for one endpoint. deps: { historyKey, listingForAsync } from lib.js (kept injected: no import cycle). */
export async function loadScoreInputs(env, url, now, deps = {}) {
  const db = env.RECEIPTS_DB;
  const uv = urlVariants(url);
  if (!db || !uv) return null;
  const since = iso(now.getTime() - SCORE_WINDOW_MS);
  const [a, b] = [uv.variants[0], uv.variants[1] || uv.variants[0]];
  let recs = [];
  try { recs = await rows(db, RECEIPT_SQL, a, b, since); } catch (_) { return { url: uv.url, observations: [], delivery: [], quality: null, error: "db" }; }
  const observations = recs.map(receiptObservation);
  let delivery = [], quality = null;
  if (deps.historyKey) {
    const hk = await deps.historyKey(uv.url);
    delivery = (await rowsSafe(db, "SELECT checked_at AS at, flag, reason FROM delivery_checks WHERE hkey = ? AND checked_at >= ? ORDER BY checked_at DESC LIMIT 100", hk, iso(now.getTime() - 90 * 86400e3))).map((d) => ({ at: d.at, flag: d.flag, reason: d.reason }));
    const q = (await rowsSafe(db, "SELECT code FROM endpoint_quality WHERE hkey = ? ORDER BY observed_at DESC LIMIT 1", hk))[0];
    quality = q ? { code: q.code } : null;
  }
  let listing = null;
  if (deps.listingForAsync) {
    try {
      const l = await deps.listingForAsync(env, uv.url);
      const c = crawlObservation(l); if (c) observations.push(c);
      // 0.79.0: the listed wallets (listed_pay_to + listed_pay_tos) so a 402 paying another listed wallet is not a mismatch
      // 0.80.0: also the listing's current price claim (a $0 or missing price is no claim)
      if (l) listing = { listed_pay_to: l.listed_pay_to || null, listed_network: l.listed_network || null, listed_pay_tos: Array.isArray(l.listed_pay_tos) ? l.listed_pay_tos : [], claimed_price_usd: l.claimed_price_usd ?? null };
    } catch (_) {}
  }
  const method = (recs.find((r) => String(r.method || "").toUpperCase() === "POST") && "POST") || "GET";
  return { url: uv.url, method, observations, delivery, quality, listing };
}

/** 0.79.0 hysteresis knob: SCORE_HOLD = "0" turns it off (default on). Not a mode change: off/shadow/on is SCORE_BAND. */
export const scoreHoldOn = (env) => String((env && env.SCORE_HOLD) ?? "1") !== "0";

/** Internal result for one endpoint (band may be avoid). */
export async function scoreEndpoint(env, url, now = new Date(), deps = {}) {
  const inp = await loadScoreInputs(env, url, now, deps);
  if (!inp) return null;
  const cfg = scoreConfig(env);
  const args = { url: inp.url, method: inp.method, observations: inp.observations, delivery: inp.delivery, quality: inp.quality, listing: inp.listing, cfg };
  let res = computeScore({ ...args, now });
  // 0.79.0 hysteresis: compare with the band recorded yesterday; when it differs, the change needs yesterday's inputs to agree
  if (scoreHoldOn(env) && env.RECEIPTS_DB && res.band !== "operator_endpoint") {
    const prev = (await rowsSafe(env.RECEIPTS_DB, "SELECT internal_band FROM endpoint_score_daily WHERE url = ? AND day = ? LIMIT 1", inp.url, dayOf(new Date(now.getTime() - 86400e3))))[0];
    const prevBand = prev && prev.internal_band;
    if (prevBand && prevBand !== res.band) res = holdBand(res, prevBand, computeScore({ ...args, now: new Date(now.getTime() - 86400e3) }).band);
  }
  res.inputs_digest = await inputsDigest(res.input_ids);
  return res;
}

const j = (o) => JSON.stringify(o == null ? null : o);
function dbRow(day, r) {
  const pub = publicAnswer(r);
  return [day, r.url, r.method, pub.band, r.band, r.score, r.raw, r.confidence, r.confidence_score, r.n_eff, r.observations, r.days_observed, r.first_seen, r.last_checked, j(pub.flags), j(pub.reasons), j(r.excluded), r.formula_version, r.inputs_digest || null, r.computed_at];
}
const UPSERT = "INSERT OR REPLACE INTO endpoint_score_daily (day, url, method, band, internal_band, score, raw, confidence, confidence_score, n_eff, n_obs, days_observed, first_seen, last_checked, flags, reasons, excluded, formula_version, inputs_digest, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * Once per UTC day: queue every endpoint with a counted-kind receipt in the window (daily_queue, day key "<date>+scoreq" plus a
 * done marker row; daily_runs untouched). Returns {did: "seeded" | "already" | "off" | "no-db" | "db-error", n}.
 */
export async function scoreSeed(env, { now = new Date() } = {}) {
  if (!scoreRecordOn(env)) return { did: "off" };
  const db = env.RECEIPTS_DB;
  if (!db) return { did: "no-db" };
  const key = queueKey(now);
  try {
    const have = await db.prepare("SELECT 1 AS x FROM daily_queue WHERE day = ? AND url = ?").bind(key, SEED_MARK).first();
    if (have) return { did: "already" };
    await db.prepare("DELETE FROM daily_queue WHERE day LIKE '%+scoreq' AND day < ?").bind(dayOf(new Date(now.getTime() - 7 * 86400e3))).run().catch(() => {});
    await db.prepare("DELETE FROM endpoint_score_daily WHERE day < ?").bind(dayOf(new Date(now.getTime() - SCORE_KEEP_DAYS * 86400e3))).run().catch(() => {});
    const urls = await rows(db, "SELECT DISTINCT url FROM spot_receipts WHERE created_at >= ? AND check_type IN ('self-checked', 'live')", iso(now.getTime() - SCORE_WINDOW_MS));
    const cfg = scoreConfig(env);
    const list = [...new Set(urls.map((r) => r.url))].filter((u) => publicUrl(u) && !isOperatorHost(hostOf(u), cfg));
    for (let i = 0; i < list.length; i += 90) await db.batch(list.slice(i, i + 90).map((u) => db.prepare("INSERT OR IGNORE INTO daily_queue (day, url, method, host) VALUES (?, ?, 'GET', ?)").bind(key, u, hostOf(u))));
    await db.prepare("INSERT OR IGNORE INTO daily_queue (day, url, method, host, done_at, verdict) VALUES (?, ?, 'GET', '', ?, ?)").bind(key, SEED_MARK, now.toISOString(), "seeded:" + list.length).run();
    return { did: "seeded", n: list.length };
  } catch (_) { return { did: "db-error" }; }
}

/** One cron step (every 20 minutes) of the rollup: score up to SCORE_ROLLUP_BATCH queued endpoints and record them. Never throws. */
export async function scoreTick(env, { now = new Date(), deps = {} } = {}) {
  if (!scoreRecordOn(env)) return { did: "off" };
  const db = env.RECEIPTS_DB;
  if (!db) return { did: "no-db" };
  const seed = await scoreSeed(env, { now });
  if (seed.did === "db-error" || seed.did === "no-db") return { did: seed.did };
  const key = queueKey(now), day = dayOf(now);
  const pend = await rowsSafe(db, "SELECT url FROM daily_queue WHERE day = ? AND done_at IS NULL ORDER BY rowid LIMIT ?", key, rollupBatch(env));
  if (!pend.length) return { did: "drained", seeded: seed.did };
  const t0 = Date.now();
  let n = 0, failed = 0;
  for (const p of pend) {
    try {
      const r = await scoreEndpoint(env, p.url, now, deps);
      if (r) { await db.prepare(UPSERT).bind(...dbRow(day, r)).run(); n++; } else failed++;
    } catch (_) { failed++; if (failed >= 5 && n === 0) return { did: "db-error", n, failed }; }
    try { await db.prepare("UPDATE daily_queue SET done_at = ?, verdict = ? WHERE day = ? AND url = ?").bind(new Date().toISOString(), "scored", key, p.url).run(); } catch (_) {}
  }
  const out = { did: "scored", n, failed, ms: Date.now() - t0, seeded: seed.did };
  console.log(JSON.stringify({ score_rollup: out }));
  return out;
}

/** Counts for the shadow run: operator endpoints are left out of every figure. Read-only. */
export async function scoreSummary(db, day) {
  const by = async (col) => Object.fromEntries((await rowsSafe(db, `SELECT ${col} AS k, COUNT(*) AS n FROM endpoint_score_daily WHERE day = ? AND band != 'operator_endpoint' GROUP BY ${col}`, day)).map((r) => [r.k, r.n]));
  return { day, band: await by("band"), internal_band: await by("internal_band"), confidence: await by("confidence") };
}

// ------------------------------------------------------------------------------------------------ serving (SCORE_BAND = on)
const jsonRes = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...h } });

/** The signed free answer for one endpoint (HTTP and MCP). Returns {status, body}. */
export async function scoreAnswer(env, rawUrl, method, now = new Date(), deps = {}) {
  const url = String(rawUrl || "").trim().slice(0, 2000);
  if (!url) return { status: 400, body: { error: "give url=<x402 endpoint>", example: SCORE_API + "/v1/score?url=https://api.402rates.com/v1/ping" } };
  const uv = urlVariants(url);
  if (!uv) return { status: 400, body: { error: "url must be a public http(s) URL (no credentials, IP literal or private host)", example: SCORE_API + "/v1/score?url=https://api.402rates.com/v1/ping" } };
  const m = String(method || "GET").toUpperCase();
  if (m !== "GET" && m !== "POST") return { status: 400, body: { error: "method must be GET or POST" } };
  let res;
  try { res = await scoreEndpoint(env, uv.url, now, deps); } catch (_) { res = null; }
  if (!res) return { status: 503, body: { error: "score unavailable, try again shortly" } };
  const pub = publicAnswer(res, { now });
  const body = {
    ...pub, method: m,
    detail: { paid_check: paidCheckBlock(uv.url), note: "the paid check adds the full payment terms and a fresh live probe; payment never changes a band" },
    inputs_digest: res.inputs_digest, rules: SCORE_SITE + "/score-rules.json", receipts: SCORE_API + "/v1/receipts/by-url?url=" + encodeURIComponent(uv.url),
  };
  const signed = await signObject(env, body);
  return { status: 200, body: signed || { ...body, signature: null, note: "unsigned: signing key not configured on this host" } };
}

/** GET /v1/score?url=&method= . Callers gate on scoreServeOn(env) first (off/shadow = the path does not exist). */
export async function handleScore(req, env, url, { rateOk, deps }) {
  const noStore = { "cache-control": "no-store" };
  for (const k of url.searchParams.keys()) if (!["url", "method", "client", "ref"].includes(k)) return jsonRes({ error: `unknown parameter ${k.slice(0, 40)}`, allowed: ["url", "method"] }, 400, noStore);
  if (rateOk && !(await rateOk())) return jsonRes({ error: "rate limited", limit: "60 requests per minute" }, 429, { ...noStore, "retry-after": String(60 - new Date().getUTCSeconds()) });
  const r = await scoreAnswer(env, url.searchParams.get("url"), url.searchParams.get("method"), new Date(), deps);
  return jsonRes(r.body, r.status, r.status === 200 ? { "cache-control": "public, max-age=300" } : noStore);
}
export const scoreRulesJson = () => ({ ...SCORE_RULES, page: SCORE_SITE + "/score-rules.json", free_endpoint: SCORE_API + "/v1/score?url=<endpoint>", probes: "scheduled probes come from Cloudflare Workers, send one unpaid request per endpoint without any payment header, and use one of a few generic client User-Agents (" + GENERIC_UAS.join(", ") + "); none is a browser or a crawler" });

/** Adds `band` (+ confidence) to discover results from the latest daily row (<= 3 days old), one D1 read. Never throws; failure = unknown. */
export async function annotateDiscover(env, results, now = new Date()) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return list;
  const db = env.RECEIPTS_DB;
  const cfg = scoreConfig(env);
  const urls = list.map((r) => publicUrl(r.endpoint)).filter(Boolean);
  let by = new Map();
  if (db && urls.length) {
    const since = dayOf(new Date(now.getTime() - 3 * 86400e3));
    const rs = await rowsSafe(db, `SELECT url, band, confidence, day FROM endpoint_score_daily WHERE day >= ? AND url IN (${urls.map(() => "?").join(",")}) ORDER BY day DESC`, since, ...urls);
    for (const r of rs) if (!by.has(r.url)) by.set(r.url, r);
  }
  for (const r of list) {
    const u = publicUrl(r.endpoint);
    if (u && isOperatorHost(hostOf(u), cfg)) { r.band = "operator_endpoint"; continue; }
    const s = u && by.get(u);
    // 0.79.0: never avoid, and nothing but unknown below medium confidence, whatever an older stored row says
    const rank = { none: 0, low: 1, medium: 2, high: 3 };
    const ok = s && (rank[s.confidence] || 0) >= rank[PUBLIC_MIN_CONFIDENCE];
    r.band = !s ? "unknown" : !ok ? "unknown" : s.band === "avoid" ? "caution" : s.band;
    r.band_confidence = s ? s.confidence : "none";
    r.band_url = SCORE_API + "/v1/score?url=" + encodeURIComponent(r.endpoint);
  }
  return list;
}

export const SAFE_TO_PAY_TOOL = Object.freeze({
  name: "safe_to_pay",
  description: "Free. Call this right before paying an x402 endpoint (and before endpoint_spot_check): returns a signed coarse band for one endpoint from 402xAgent's own checks over the last 30 days: good, caution, unknown or operator_endpoint, with confidence, how many observations and days it rests on, and the specific flags. Only 'good' with confidence medium or high should be paid without a fresh check; 'unknown' is not a pass; 'caution' lists what to look at. Advisory: it never changes a check's verdict, is not a delivery guarantee and not a rating of the seller. Payment never changes a band.",
  inputSchema: { type: "object", properties: { url: { type: "string", description: "the x402 endpoint URL (query string is ignored)" }, method: { type: "string", enum: ["GET", "POST"], description: "default GET" } }, required: ["url"], additionalProperties: false },
  annotations: { title: "Is this endpoint safe to pay?", readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false },
});
export const SCORE_OPENAPI_PATHS = Object.freeze({
  "/v1/score": { get: { operationId: "endpointScore", security: [], summary: "Free signed coarse reliability band for one x402 endpoint (good | caution | unknown | operator_endpoint) from 402xAgent's own checks over 30 days, with confidence, observations, days observed and flags. Advisory only; there is no list route.", parameters: [{ name: "url", in: "query", required: true, schema: { type: "string" } }, { name: "method", in: "query", schema: { type: "string", enum: ["GET", "POST"] } }], responses: { 200: { description: "signed band" }, 400: { description: "bad url or method" }, 429: { description: "rate limited" } } } },
  "/score-rules.json": { get: { operationId: "scoreRules", security: [], summary: "The published score formula, weights, bands and flags.", responses: { 200: { description: "rules" } } } },
});
