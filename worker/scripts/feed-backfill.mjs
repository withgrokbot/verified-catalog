#!/usr/bin/env node
// 0.52.0 Watchtower feed backfill + D1 size estimate. LOCAL OR PREVIEW D1 ONLY: this script refuses to touch production.
//
//   node worker/scripts/feed-backfill.mjs --estimate [--watches N] [--crawl-rows N] [--history-rows N] [--db-bytes N]
//       [--changes-per-day X] [--snapshot-bytes N]
//       Measures bytes per feed row on a scratch SQLite (node >= 22.5, migration 0018) and prints the growth estimate:
//       (1 daily heartbeat + changes) x opted-in watches x 400 days, at today's count and at the 100 cap, + backfill + snapshots.
//       Reads nothing remote.
//   node worker/scripts/feed-backfill.mjs --local   [--persist-to DIR] [--dry-run] [--out DIR]
//   node worker/scripts/feed-backfill.mjs --preview [--dry-run] [--out DIR]
//       Reads the discover shards (crawl_store d:*) and endpoint_history from that D1 with `wrangler d1 execute`, writes
//       SQL files (feed_endpoints upserts + feed_observations, src c/h) to DIR, then applies them to the same D1
//       (skipped with --dry-run). Only crawl-known public URLs are written; endpoint_history rows are used only when their
//       hkey matches a crawl URL. No query strings, no payer/tx/IP fields (those tables are never read).
// --remote / production is not supported on purpose: production needs the owner's explicit OK and a separate runbook.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as F from "../src/feed.js";
import { decodeBlob, expandShard } from "../src/discover.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..");
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DB = "vc-spot-receipts";
const sqlLit = (v) => (v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
// fake D1 that renders the exact statements the Worker uses (feed.observationStatements) as SQL text
const sqlDb = { prepare: (sql) => ({ bind: (...a) => { let i = 0; return { text: sql.replace(/\?/g, () => sqlLit(a[i++])).replace(/\s+/g, " ") + ";" }; } }) };

if (flag("--remote") || flag("--production") || flag("--prod")) { console.error("refused: production D1 is out of scope for this script (local or preview only)"); process.exit(2); }

if (flag("--estimate")) await estimate();
else if (flag("--local") || flag("--preview")) await backfill(flag("--local") ? ["--local", ...(opt("--persist-to") ? ["--persist-to", opt("--persist-to")] : [])] : ["--remote", "--preview"]);
else { console.error("usage: --estimate | --local | --preview  (see header)"); process.exit(2); }

async function measure() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(WORKER, "migrations", "0013_watchtower.sql"), "utf8"));
  db.exec(readFileSync(join(WORKER, "migrations", "0018_feed.sql"), "utf8"));
  const size = () => db.prepare("PRAGMA page_count").get().page_count * db.prepare("PRAGMA page_size").get().page_size;
  const before = size();
  const N = 20000, EP = 2000;
  const ins = db.prepare("INSERT INTO feed_observations (hkey, observed_at, src, state, http_status, price_usd, amount_atomic, network, asset, pay_to, terms_sig, event, changes) VALUES (?, ?, 'w', 'up', 402, 0.01, '10000', 'eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', ?, ?, NULL, NULL)");
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) ins.run("h:" + (await F.sha256Hex("u" + (i % EP))), new Date(Date.UTC(2026, 0, 1) + Math.floor(i / EP) * 3600000).toISOString().slice(0, 19) + "Z", "0x" + (i % EP).toString(16).padStart(40, "0"), "sha256:" + (await F.sha256Hex("t" + (i % EP))));
  db.exec("COMMIT");
  const obsBytes = (size() - before) / N;
  const b2 = size();
  const insE = db.prepare("INSERT INTO feed_endpoints (hkey, url, host, method, category, crawl_known, first_seen_at, observed_at, state, http_status, price_usd, amount_atomic, network, asset, pay_to, terms_sig, last_change_at) VALUES (?, ?, ?, 'GET', 'other', 1, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', 'up', 402, 0.01, '10000', 'eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', ?, ?, '2026-10-20T00:00:00Z')");
  db.exec("BEGIN");
  for (let i = 0; i < EP; i++) insE.run("h:" + (await F.sha256Hex("e" + i)), `https://api${i}.seller-example.com/v1/some/path/${i}`, `api${i}.seller-example.com`, "0x" + i.toString(16).padStart(40, "0"), "sha256:" + (await F.sha256Hex("t" + i)));
  db.exec("COMMIT");
  // snapshot: gzip+base64 of the JSON row arrays, the way feed.buildSnapshot stores it
  const rows = db.prepare(`SELECT ${F.FEED_COLUMNS.join(", ")} FROM feed_endpoints`).all().map((r) => F.FEED_COLUMNS.map((c) => r[c] ?? null));
  const gz = new Uint8Array(await new Response(new Blob([JSON.stringify(rows)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  return { obsBytes, epBytes: (size() - b2) / EP, snapBytes: (gz.length * 4 / 3) / EP };
}
async function estimate() {
  // 0.52.0 (PR #7 review): observations are written only on change + one heartbeat per endpoint per UTC day, and at most
  // FEED_OPT_IN_MAX (100) watches opt in. rows/day per endpoint = 1 + --changes-per-day (default 0.1; worst case 24 = every probe).
  const watches = Number(opt("--watches", "1")), crawl = Number(opt("--crawl-rows", "0")), hist = Number(opt("--history-rows", "0")), dbBytes = Number(opt("--db-bytes", "0"));
  const cpd = Number(opt("--changes-per-day", "0.1"));
  const snapMeasured = Number(opt("--snapshot-bytes", "0")); // e.g. measured under wrangler dev
  const { obsBytes, epBytes, snapBytes } = await measure();
  const mb = (b) => (b / 1e6).toFixed(2) + " MB";
  const series = (n, c) => n * (1 + c) * F.KEEP_DAYS;
  const snapOne = snapMeasured || crawl * snapBytes;
  const backfillBytes = (crawl + hist) * obsBytes + crawl * epBytes;
  const out = {
    measured_bytes_per_row: { feed_observations: Math.round(obsBytes), feed_endpoints: Math.round(epBytes) },
    model: `rows per opted-in endpoint per day = 1 heartbeat + ${cpd} changes; ${F.KEEP_DAYS} days`,
    current_db: dbBytes ? mb(dbBytes) : "pass --db-bytes",
    series_400d: Object.fromEntries([[`${watches}_watch`, watches], ["cap_100", 100]].map(([k, n]) => [k, { rows: Math.round(series(n, cpd)), bytes: mb(series(n, cpd) * obsBytes), worst_case_hourly: mb(series(n, 23) * obsBytes) }])),
    backfill: { observation_rows: crawl + hist, endpoint_rows: crawl, bytes: mb(backfillBytes) },
    snapshots: { per_snapshot: mb(snapOne), kept: F.SNAPSHOT_KEEP, bytes: mb(snapOne * F.SNAPSHOT_KEEP) },
  };
  if (dbBytes) {
    out.total_after_400d_now = mb(dbBytes + backfillBytes + snapOne * F.SNAPSHOT_KEEP + series(watches, cpd) * obsBytes);
    out.total_after_400d_at_cap = mb(dbBytes + backfillBytes + snapOne * F.SNAPSHOT_KEEP + series(100, cpd) * obsBytes);
    out.total_at_cap_worst_case = mb(dbBytes + backfillBytes + snapOne * F.SNAPSHOT_KEEP + series(100, 23) * obsBytes);
  }
  console.log(JSON.stringify(out, null, 2));
}

function d1(where, sql) {
  const o = execFileSync("npx", ["-y", "wrangler@4", "d1", "execute", DB, ...where, "--json", "--command", sql], { cwd: WORKER, encoding: "utf8", maxBuffer: 1 << 30 });
  return JSON.parse(o)[0].results || [];
}
async function backfill(where) {
  const out = opt("--out", join(WORKER, ".feed-backfill"));
  mkdirSync(out, { recursive: true });
  // 1. crawl-known URLs from the discover shards (all parts, sha-checked)
  const parts = d1(where, "SELECT key, part, parts, sha256, value FROM crawl_store WHERE key >= 'd:' AND key < 'd;' ORDER BY key, part");
  const byKey = new Map();
  for (const p of parts) { if (!byKey.has(p.key)) byKey.set(p.key, []); byKey.get(p.key).push(p); }
  let run = null;
  if (byKey.has("d:meta")) { try { run = JSON.parse(byKey.get("d:meta").map((x) => x.value).join("")).crawl_run || null; } catch (_) {} }
  const eps = new Map(); // hkey -> {ep, obs: []}
  for (const [k, ps] of byKey) {
    const m = /^d:(pay|skip|recheck):[0-9a-f]$/.exec(k);
    if (!m || ps.length !== ps[0].parts) continue;
    const v = ps.map((x) => x.value).join("");
    if ((await F.sha256Hex(v)) !== ps[0].sha256) continue;
    for (const r of expandShard(m[1], await decodeBlob(v), run)) {
      const pu = F.publicUrl(r.url); if (!pu) continue;
      const hkey = await F.feedKey(pu.url);
      const t = { network: r.network, asset: r.asset, pay_to: null, amount_atomic: null };
      const quoted = r.price_usd != null || !!r.network;
      const state = quoted ? "up" : /unreachable|timeout|timed out|5\d\d|dns|connection|refused/i.test(r.reason || "") ? "down" : "unknown";
      if (!eps.has(hkey)) eps.set(hkey, { ep: { hkey, ...pu, method: r.method || "GET", category: F.categoryOf(r), crawl_known: 1, watch_opt_in: 0 }, obs: [] });
      eps.get(hkey).obs.push({ observed_at: r.checked_at, src: "c", state, http_status: null, ...t, price_usd: r.price_usd ?? null, terms_sig: await F.termsSig({ network: r.network, asset: r.asset }) });
    }
  }
  // 2. endpoint_history rows whose hkey is a crawl URL (same key: "h:" + sha256(normalized URL))
  const keys = [...eps.keys()];
  for (let i = 0; i < keys.length; i += 200) {
    const rows = d1(where, `SELECT hkey, observed_at, http_status, amount_atomic, price_usd, network, asset, pay_to FROM endpoint_history WHERE hkey IN (${keys.slice(i, i + 200).map(sqlLit).join(",")})`);
    for (const h of rows) {
      const t = { network: h.network, asset: h.asset, pay_to: h.pay_to, amount_atomic: h.amount_atomic };
      eps.get(h.hkey).obs.push({ observed_at: h.observed_at, src: "h", state: h.http_status && h.http_status < 500 ? "up" : "down", http_status: h.http_status, ...t, price_usd: h.price_usd ?? F.priceUsdOf(h.amount_atomic, h.asset), terms_sig: await F.termsSig(t) });
    }
  }
  // 3. order per endpoint, compute drift/down/recovery, render SQL
  let files = 0, lines = [], nObs = 0;
  const flush = () => { if (!lines.length) return; writeFileSync(join(out, `feed-backfill-${String(files++).padStart(4, "0")}.sql`), lines.join("\n") + "\n"); lines = []; };
  for (const { ep, obs } of eps.values()) {
    obs.sort((a, b) => (a.observed_at < b.observed_at ? -1 : 1));
    let prev = null;
    for (const o of obs) {
      const e = F.eventOf(prev, o);
      for (const st of F.observationStatements(sqlDb, ep, { ...o, event: e.event, changes: e.changes })) lines.push(st.text);
      prev = o; nObs++;
      if (lines.length >= 2000) flush();
    }
  }
  flush();
  console.log(JSON.stringify({ target: where.join(" "), endpoints: eps.size, observations: nObs, sql_files: files, out }, null, 2));
  if (flag("--dry-run")) return;
  for (let i = 0; i < files; i++) execFileSync("npx", ["-y", "wrangler@4", "d1", "execute", DB, ...where, "--file", join(out, `feed-backfill-${String(i).padStart(4, "0")}.sql`)], { cwd: WORKER, stdio: "inherit" });
}
