// 0.36.0: daily re-check. One extra cron ("17 10 * * *": 10:17 UTC) re-runs our free, unpaid 402 probe (the same
// endpoint-spot-check handler, exempt self-test client, never pays) on one listed endpoint for each of the badge hosts,
// so a host that still passes keeps a pay receipt under BADGE_FRESH_H (72 h) and its badge stays green.
// State lives in D1 only (tables daily_runs + daily_queue, migrations/0006): 0 KV writes per run.
// Batching: the daily trigger seeds today's queue and checks DAILY_BATCH URLs (~3 subrequests each: DNS A/AAAA + probe,
// so <= ~24 of the free plan's 50); the rest drain on the existing 20-min cron's idle steps (DAILY_BATCH per step, in
// place of that step's stale recheck, never on a Bazaar step). 26 hosts -> the daily run + 3 steps (~1 h).
// No duplication: a URL with a non-request-sourced receipt under DAILY_SKIP_H old is marked done without a probe, and the
// Bazaar list's endpoints are not probed here: the 20-min cron already re-checks every one of them once per UTC day.
import { publicUrl } from "./recent.js";

export const DAILY_CRON = "17 10 * * *";
export const DAILY_REF = "daily-recheck";
export const DAILY_CLIENT = "withgrokbot-selftest";
export const DAILY_BATCH = 8;
export const DAILY_SKIP_H = 20;

// One endpoint per badge host (from the 2026-10-13 crawl: every receipt for these hosts in all 4 crawls was pay).
export const BADGE_HOSTS = [
  { host: "stabletravel.dev", url: "https://stabletravel.dev/api/seats-aero/routes", method: "GET" },
  { host: "api.solenrich.com", url: "https://api.solenrich.com/entrypoints/query/invoke", method: "POST" },
  { host: "relay402.georgespring.workers.dev", url: "https://relay402.georgespring.workers.dev/api/company-jobs", method: "GET" },
  { host: "insider-radar-agent.insider-radar-agent.workers.dev", url: "https://insider-radar-agent.insider-radar-agent.workers.dev/v1/alerts", method: "GET" },
  { host: "x402.tbs-digital.com", url: "https://x402.tbs-digital.com/defi/tvl", method: "GET" },
  { host: "x402.sniperx.fun", url: "https://x402.sniperx.fun/api/v1/ping", method: "GET" },
  { host: "citable.run", url: "https://citable.run/v1/serp", method: "GET" },
  { host: "base-worker-01.j23726919.workers.dev", url: "https://base-worker-01.j23726919.workers.dev/api/kabukicho-guide", method: "GET" },
  { host: "signals.nsgoods.org", url: "https://signals.nsgoods.org/signals", method: "GET" },
  { host: "energy.halowerk.com", url: "https://energy.halowerk.com/demo/paid-sample", method: "GET" },
  { host: "earlythunder.com", url: "https://earlythunder.com/api/x402/v1/scores", method: "GET" },
  { host: "tick.hugen.tokyo", url: "https://tick.hugen.tokyo/tick/all", method: "GET" },
  { host: "api.justaname.id", url: "https://api.justaname.id/ens/v2/enrich", method: "GET" },
  { host: "x402.valintix.com", url: "https://x402.valintix.com/data", method: "GET" },
  { host: "gdzlcxskuhupymyxywzm.supabase.co", url: "https://gdzlcxskuhupymyxywzm.supabase.co/functions/v1/frcompany/v1/search", method: "GET" },
  { host: "token-risk.com", url: "https://token-risk.com/v1/scan", method: "POST" },
  { host: "cheaptokens.ai", url: "https://cheaptokens.ai/api/buy", method: "POST" },
  { host: "api-dev-v2.ixs.finance", url: "https://api-dev-v2.ixs.finance/x402/vaults", method: "GET" },
  { host: "headers.use.x402atlas.com", url: "https://headers.use.x402atlas.com/", method: "GET" },
  { host: "unwrap.use.x402atlas.com", url: "https://unwrap.use.x402atlas.com/", method: "GET" },
  { host: "ip402.xyz", url: "https://ip402.xyz/v1/geo", method: "GET" },
  { host: "x402.lucidcove.org", url: "https://x402.lucidcove.org/v1/ping", method: "GET" },
  { host: "x402.api.browser-use.com", url: "https://x402.api.browser-use.com/api/v3/sessions", method: "POST" },
  { host: "mcp.deep3.ai", url: "https://mcp.deep3.ai/tools/wave-1", method: "POST" },
  { host: "cdp-agent-0-01.onrender.com", url: "https://cdp-agent-0-01.onrender.com/", method: "GET" },
  { host: "x402-solvers.onrender.com", url: "https://x402-solvers.onrender.com/v1/cycles/probe", method: "POST" },
];

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const day = (now) => now.toISOString().slice(0, 10);

export function dailyCheckUrl(origin, it) {
  const qp = new URLSearchParams({ url: it.url, client: DAILY_CLIENT, ref: DAILY_REF });
  if (String(it.method || "GET").toUpperCase() === "POST") qp.set("method", "POST");
  return origin + "/v1/products/endpoint-spot-check?" + qp.toString();
}

// Daily trigger: seed today's queue (idempotent: INSERT OR IGNORE), then run one batch.
export async function dailySeed(env, { now = new Date(), list = BADGE_HOSTS } = {}) {
  const db = env.RECEIPTS_DB;
  if (!db) return { did: "no-db" };
  const d = day(now);
  const items = list.filter((x) => publicUrl(x.url));
  try {
    await db.batch([
      db.prepare("DELETE FROM daily_queue WHERE day < ?").bind(day(new Date(now.getTime() - 14 * 86400e3))),
      db.prepare("INSERT OR IGNORE INTO daily_runs (day, started_at, total) VALUES (?, ?, ?)").bind(d, now.toISOString(), items.length),
      ...items.map((x) => db.prepare("INSERT OR IGNORE INTO daily_queue (day, url, method, host) VALUES (?, ?, ?, ?)").bind(d, x.url, String(x.method || "GET").toUpperCase(), x.host)),
    ]);
  } catch (_) { return { did: "db-error" }; }
  return { did: "seeded", n: items.length };
}

// One batch from today's queue. Returns did: "none" (no queue today / table missing), "drained" (nothing pending) or
// "checked". Callers fall back to the stale recheck on "none"/"drained".
export async function dailyStep(env, { now = new Date(), runCheck, origin, batch = DAILY_BATCH }) {
  const db = env.RECEIPTS_DB;
  if (!db) return { did: "none" };
  const d = day(now);
  let pend = [];
  try {
    const r = await db.prepare("SELECT url, method, host FROM daily_queue WHERE day = ? AND done_at IS NULL ORDER BY host LIMIT ?").bind(d, batch).all();
    pend = (r && r.results) || [];
  } catch (_) { return { did: "none" }; }
  if (!pend.length) return { did: "drained" };
  const since = iso(now.getTime() - DAILY_SKIP_H * 3600e3);
  const ups = [];
  let n = 0, skipped = 0;
  for (const it of pend) {
    let verdict = null, rid = null;
    try {
      const fresh = await db.prepare("SELECT id, verdict FROM spot_receipts WHERE url = ? AND created_at >= ? AND check_type != 'dry-run' AND COALESCE(json_extract(body, '$.expected.source'), '') != 'request' ORDER BY created_at DESC LIMIT 1").bind(it.url, since).first();
      if (fresh) { verdict = fresh.verdict; rid = fresh.id; skipped++; }
    } catch (_) {}
    if (!rid) {
      try {
        const res = await runCheck(dailyCheckUrl(origin, it));
        const b = await res.json();
        verdict = b && b.verdict || null;
        rid = b && b.receipt_id || null;
        n++;
      } catch (_) { verdict = "recheck"; }
    }
    ups.push(db.prepare("UPDATE daily_queue SET done_at = ?, verdict = ?, receipt_id = ? WHERE day = ? AND url = ?").bind(now.toISOString(), verdict, rid, d, it.url));
  }
  ups.push(db.prepare("UPDATE daily_runs SET finished_at = ?, done = (SELECT COUNT(*) FROM daily_queue WHERE day = ? AND done_at IS NOT NULL) WHERE day = ?").bind(now.toISOString(), d, d));
  try { await db.batch(ups); } catch (_) {}
  return { did: "checked", n, skipped };
}

// Latest daily re-check time (ISO, UTC) or null. One indexed D1 read; fails open to null.
export async function lastDailyCheck(db) {
  if (!db) return null;
  try {
    const r = await db.prepare("SELECT MAX(finished_at) AS t FROM daily_runs").first();
    return (r && r.t) || null;
  } catch (_) { return null; }
}

// "Last checked: 2026-10-14 10:21 UTC" (or "pending").
export function lastCheckedText(t) {
  const ms = Date.parse(t || "");
  return "Last checked: " + (ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "pending");
}
