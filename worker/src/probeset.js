// 0.75.0 probe-set expansion for the reliability score (PR 2 of 3). OFF unless SCORE_PROBES = "1".
// The score needs history, and only ~100-130 endpoints a day are probed today. This adds a capped daily queue of the
// endpoints real callers actually look at (never the whole crawl): the top SCORE_PROBE_CAP (default 1000) by
//   check demand    outside live / dry-run check receipts in the last 30 days (spot_receipts, existing data), weight 2
//   discover demand how often a URL was among the first results shown to a real caller (endpoint_demand_daily, migration
//                   0033, written only with SCORE_DEMAND = "1"), weight 1
// minus our own hosts, URLs probed by another cron in the last SCORE_PROBE_MIN_GAP_H hours, and the curated badge hosts.
// State is D1 only (the existing daily_queue table, day key "<UTC date>+score", plus one already-done marker row): no KV,
// no new table here, and daily_runs is not touched (its finished_at feeds the "Last checked" text on the badge pages).
// Each */20 step drains a random-sized slice of a randomly ordered queue, sometimes skips the step, and sleeps a random
// pause between probes, so a seller cannot learn "the probe comes at :00 with this header". Probes use the same unpaid
// free-check path as the other crons (never pays), and rotate among a few honest, generic client User-Agents.
import { publicUrl } from "./recent.js";
import { BADGE_HOSTS } from "./daily.js";
import { isOperatorHost } from "./score.js";

export const SCORE_PROBE_REF = "score-probe";
export const SCORE_PROBE_CLIENT = "withgrokbot-selftest";
export const PROBE_DEFAULTS = Object.freeze({ cap: 1000, batch: 24, skip_p: 0.15, jitter_ms: 1500, min_gap_h: 20, demand_days: 30 });
export const PROBE_MAX = Object.freeze({ cap: 5000, batch: 60, jitter_ms: 5000 });
export const CHECK_DEMAND_WEIGHT = 2;
export const DISCOVER_DEMAND_WEIGHT = 1;
export const DEMAND_KEEP_DAYS = 45;
export const DEMAND_PER_CALL = 5; // only the first results of a discover answer count as "shown"
export const DEMAND_KIND = "discover";

// Honest, generic client strings. The first is the identified default we already send. None names a browser, a search or
// AI crawler, or another real product, and rotation never changes what the probe does (one unpaid request, no payment header).
export const GENERIC_UAS = Object.freeze(["verified-catalog-spotcheck/0.7.0", "x402-client/1.0", "agent-http-client/1.0"]);
export const UA_BLOCK_RE = /(bot\b|bot\/|crawl|spider|slurp|mozilla|chrome|safari|firefox|edge\/|opera|curl|wget|python|node|axios|undici|go-http|java|okhttp|postman|openai|gpt|anthropic|claude|gemini|perplexity|cursor|google|bing|yandex|baidu|duckduck|facebook|twitter|apple|semrush|ahrefs)/i;

const on = (v) => String(v == null ? "" : v) === "1";
export const probesOn = (env) => !!env && on(env.SCORE_PROBES);
export const demandOn = (env) => !!env && on(env.SCORE_DEMAND);
const int = (v, d, max, min = 0) => (/^\d{1,6}$/.test(String(v == null ? "" : v)) ? Math.max(min, Math.min(max, parseInt(v, 10))) : d);
export function probeConfig(env = {}) {
  const p = Number(env.SCORE_PROBE_SKIP_P);
  return {
    cap: int(env.SCORE_PROBE_CAP, PROBE_DEFAULTS.cap, PROBE_MAX.cap),
    batch: int(env.SCORE_PROBE_BATCH, PROBE_DEFAULTS.batch, PROBE_MAX.batch, 1),
    jitter_ms: int(env.SCORE_PROBE_JITTER_MS, PROBE_DEFAULTS.jitter_ms, PROBE_MAX.jitter_ms),
    min_gap_h: int(env.SCORE_PROBE_MIN_GAP_H, PROBE_DEFAULTS.min_gap_h, 24 * 14),
    demand_days: int(env.SCORE_DEMAND_DAYS, PROBE_DEFAULTS.demand_days, 60, 1),
    skip_p: env.SCORE_PROBE_SKIP_P != null && Number.isFinite(p) && p >= 0 && p <= 0.9 ? p : PROBE_DEFAULTS.skip_p,
  };
}

/** User-Agent list from SCORE_PROBE_UAS ("|" separated) with anything crawler-, browser- or product-like dropped. */
export function probeUserAgents(env = {}) {
  const raw = String(env.SCORE_PROBE_UAS || "").split("|").map((s) => s.trim()).filter(Boolean);
  const ok = raw.filter((s) => s.length <= 80 && /^[\x21-\x7e ]+$/.test(s) && !UA_BLOCK_RE.test(s));
  return ok.length ? ok : GENERIC_UAS.slice();
}
export const pickUa = (list, rnd = Math.random) => list[Math.min(list.length - 1, Math.floor(rnd() * list.length))];
export function shuffled(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const dayOf = (now) => now.toISOString().slice(0, 10);
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
export const queueDay = (now) => dayOf(now) + "+score";
export const SEED_MARK = "~seeded~"; // a done daily_queue row: today's queue has been built

/** One question per candidate: is it a public, non-template, non-operator URL we may probe? Returns the stored form or null. */
export function candidateUrl(raw, cfgScore) {
  const u = publicUrl(raw);
  if (!u) return null;
  if (/\/(:[A-Za-z_]|\{)|%7B/i.test(u)) return null; // path templates are not real URLs
  let host;
  try { host = new URL(u).host.toLowerCase(); } catch (_) { return null; }
  if (isOperatorHost(host, cfgScore)) return null;
  return u;
}

/** Merge the two demand sources into ranked candidates {url, method, score, checks, discover}. Pure. */
export function rankDemand({ checks = [], discover = [] } = {}) {
  const by = new Map();
  const add = (url, f) => { const cur = by.get(url) || { url, method: "GET", checks: 0, discover: 0 }; f(cur); by.set(url, cur); };
  for (const r of checks) add(r.url, (c) => { c.checks += Number(r.c || 0); if (String(r.method || "").toUpperCase() === "POST") c.method = "POST"; });
  for (const r of discover) add(r.url, (c) => { c.discover += Number(r.d || 0); });
  return [...by.values()].map((c) => ({ ...c, score: c.checks * CHECK_DEMAND_WEIGHT + c.discover * DISCOVER_DEMAND_WEIGHT }))
    .sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : 1));
}

async function rows(db, sql, ...binds) {
  try { const r = await db.prepare(sql).bind(...binds).all(); return (r && r.results) || []; } catch (_) { return []; }
}

/** The expansion list for one day: top-demand endpoints up to cap, filtered. */
export async function buildExpansion(env, { now = new Date(), scoreCfg } = {}) {
  const db = env.RECEIPTS_DB;
  const cfg = probeConfig(env);
  if (!db) return { items: [], considered: 0, cfg };
  const since = iso(now.getTime() - cfg.demand_days * 86400e3);
  const sinceDay = dayOf(new Date(now.getTime() - cfg.demand_days * 86400e3));
  const gapSince = iso(now.getTime() - cfg.min_gap_h * 3600e3);
  const [checks, discover, recent] = await Promise.all([
    rows(db, "SELECT url, COUNT(*) AS c, json_extract(body, '$.method') AS method FROM spot_receipts WHERE check_type IN ('live', 'dry-run') AND created_at >= ? AND json_extract(body, '$.client') IS NULL GROUP BY url ORDER BY c DESC LIMIT ?", since, cfg.cap * 2),
    rows(db, "SELECT url, SUM(n) AS d FROM endpoint_demand_daily WHERE day >= ? GROUP BY url ORDER BY d DESC LIMIT ?", sinceDay, cfg.cap * 2),
    rows(db, "SELECT DISTINCT url FROM spot_receipts WHERE check_type = 'self-checked' AND created_at >= ?", gapSince),
  ]);
  const skip = new Set([...recent.map((r) => r.url), ...BADGE_HOSTS.map((b) => publicUrl(b.url))].filter(Boolean));
  const ranked = rankDemand({ checks, discover });
  const items = [];
  const seen = new Set();
  for (const c of ranked) {
    const u = candidateUrl(c.url, scoreCfg);
    if (!u || skip.has(u) || seen.has(u)) continue;
    seen.add(u);
    items.push({ url: u, method: c.method, host: new URL(u).host.toLowerCase(), score: c.score });
    if (items.length >= cfg.cap) break;
  }
  return { items, considered: ranked.length, cfg };
}

export function probeCheckUrl(origin, it) {
  const qp = new URLSearchParams({ url: it.url, client: SCORE_PROBE_CLIENT, ref: SCORE_PROBE_REF });
  if (String(it.method || "GET").toUpperCase() === "POST") qp.set("method", "POST");
  return origin + "/v1/products/endpoint-spot-check?" + qp.toString();
}

/**
 * Seed today's queue once (idempotent). Rows are inserted in random order and drained in rowid order, so the order a
 * seller sees us in is not the demand order. Returns {did: "seeded" | "already" | "off" | "no-db" | "db-error", n}.
 */
export async function probeSeed(env, { now = new Date(), rnd = Math.random, scoreCfg } = {}) {
  if (!probesOn(env)) return { did: "off" };
  const db = env.RECEIPTS_DB;
  if (!db) return { did: "no-db" };
  const key = queueDay(now);
  try {
    const have = await db.prepare("SELECT 1 AS x FROM daily_queue WHERE day = ? AND url = ?").bind(key, SEED_MARK).first();
    if (have) return { did: "already" };
    await db.prepare("DELETE FROM daily_queue WHERE day LIKE '%+score' AND day < ?").bind(dayOf(new Date(now.getTime() - 7 * 86400e3))).run().catch(() => {});
    await db.prepare("DELETE FROM endpoint_demand_daily WHERE day < ?").bind(dayOf(new Date(now.getTime() - DEMAND_KEEP_DAYS * 86400e3))).run().catch(() => {});
    const { items } = await buildExpansion(env, { now, scoreCfg });
    const order = shuffled(items, rnd);
    for (let i = 0; i < order.length; i += 90) {
      await db.batch(order.slice(i, i + 90).map((x) => db.prepare("INSERT OR IGNORE INTO daily_queue (day, url, method, host) VALUES (?, ?, ?, ?)").bind(key, x.url, x.method, x.host)));
    }
    await db.prepare("INSERT OR IGNORE INTO daily_queue (day, url, method, host, done_at, verdict) VALUES (?, ?, 'GET', '', ?, ?)").bind(key, SEED_MARK, now.toISOString(), "seeded:" + order.length).run();
    return { did: "seeded", n: order.length };
  } catch (_) { return { did: "db-error" }; }
}

/**
 * One cron step: maybe skip, else probe a random-sized slice of the pending queue with jitter and a rotated User-Agent.
 * runCheck(urlString, {userAgent}) -> Response from our own free-check handler (no network hop to ourselves).
 */
export async function probeStep(env, { now = new Date(), runCheck, origin, rnd = Math.random, sleep = sleepReal, scoreCfg } = {}) {
  if (!probesOn(env)) return { did: "off" };
  const db = env.RECEIPTS_DB;
  if (!db) return { did: "no-db" };
  const cfg = probeConfig(env);
  if (rnd() < cfg.skip_p) return { did: "skipped" };
  const seed = await probeSeed(env, { now, rnd, scoreCfg });
  if (seed.did === "db-error" || seed.did === "no-db") return { did: seed.did };
  const key = queueDay(now);
  const n = Math.max(1, Math.ceil(cfg.batch / 2) + Math.floor(rnd() * (cfg.batch - Math.ceil(cfg.batch / 2) + 1)));
  let pend = [];
  try { pend = await rows(db, "SELECT url, method, host FROM daily_queue WHERE day = ? AND done_at IS NULL ORDER BY rowid LIMIT ?", key, n); } catch (_) { pend = []; }
  if (!pend.length) return { did: "drained", seeded: seed.did };
  const uas = probeUserAgents(env);
  const t0 = Date.now();
  let done = 0, ok = 0;
  for (let i = 0; i < pend.length; i++) {
    const it = pend[i];
    if (i > 0 && cfg.jitter_ms > 0) await sleep(Math.floor(rnd() * (cfg.jitter_ms + 1)));
    let verdict = null, rid = null;
    try {
      const res = await runCheck(probeCheckUrl(origin, it), { userAgent: pickUa(uas, rnd) });
      const body = await res.json().catch(() => null);
      verdict = body && ["pay", "skip", "recheck"].includes(body.verdict) ? body.verdict : "recheck";
      rid = body && typeof body.receipt_id === "string" ? body.receipt_id.slice(0, 40) : null;
      ok++;
    } catch (_) { verdict = "recheck"; }
    done++;
    try { await db.prepare("UPDATE daily_queue SET done_at = ?, verdict = ?, receipt_id = ? WHERE day = ? AND url = ?").bind(new Date().toISOString(), verdict, rid, key, it.url).run(); } catch (_) {}
  }
  const out = { did: "probed", n: done, ok, ms: Date.now() - t0, seeded: seed.did };
  console.log(JSON.stringify({ score_probe: out }));
  return out;
}

// ---------------------------------------------------------------- demand recording (SCORE_DEMAND = "1")
/** Public result URLs of a discover answer that count as shown (first DEMAND_PER_CALL, deduped, public form). */
export function discoverShownUrls(body) {
  const out = [];
  for (const r of (body && Array.isArray(body.results) ? body.results : []).slice(0, DEMAND_PER_CALL)) {
    const u = publicUrl(r && r.endpoint);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}
/** Count one shown-to-a-caller per URL for today. `skip` is the caller's exclusion() result (self, uptime, crawler, bot). Never throws. */
export async function recordDemand(env, { urls, skip = null, now = new Date() } = {}) {
  if (!demandOn(env) || skip || !urls || !urls.length) return { did: "off" };
  const db = env.RECEIPTS_DB;
  if (!db) return { did: "no-db" };
  try {
    const day = dayOf(now);
    await db.batch(urls.slice(0, DEMAND_PER_CALL).map((u) => db.prepare("INSERT INTO endpoint_demand_daily (day, url, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, url, kind) DO UPDATE SET n = n + 1").bind(day, u, DEMAND_KIND)));
    return { did: "recorded", n: urls.length };
  } catch (_) { return { did: "db-error" }; }
}
export function recordDemandAsync(env, ctx, args) {
  const p = recordDemand(env, args);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  return p;
}
