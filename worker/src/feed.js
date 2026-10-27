// 0.52.0 Watchtower drift & liveness data feed. GET /v1/feed, /v1/feed/endpoint/{hkey}, /v1/feed/drift,
// /v1/feed/snapshot.json|.csv, /v1/feed/manifest; POST /v1/feed/subscribe. D1 only (migration 0018); no KV.
// FACTS ONLY: liveness, payment terms and drift events. No scores, grades, quality ratings or rankings.
// PRIVACY: every response is built from the explicit FEED_COLUMNS / EVENT_COLUMNS allowlists over feed_* tables only.
// This module never reads watches.webhook_url / webhook_hash / ip_hash / secret_hash, watch_events, spot_receipts,
// settled_payments, hygiene tables or trial_claims. pay_to is the public seller address. No query strings.
// Flags: FEED=1 serves the routes (default off -> 404). FEED_OBSERVE=1 writes hourly observations from opted-in watches.
// FEED_MAINNET=1 takes paid tiers on the main payment preset; default (off) = Base Sepolia testnet USDC.
import { normUrl } from "./skips.js";
import { canonicalize, signObject } from "./sign.js";

export const FEED_CATEGORIES = Object.freeze(["search/data", "inference", "crypto-market", "content", "infra", "other"]);
export const FEED_COLUMNS = Object.freeze(["hkey", "url", "host", "method", "category", "state", "http_status", "price_usd", "amount_atomic", "network", "asset", "pay_to", "terms_sig", "observed_at", "last_change_at"]);
export const EVENT_COLUMNS = Object.freeze(["hkey", "url", "host", "category", "event", "observed_at", "state", "http_status", "changes"]);
export const OBS_COLUMNS = Object.freeze(["observed_at", "state", "http_status", "price_usd", "amount_atomic", "network", "asset", "pay_to", "terms_sig", "event", "changes"]);
export const FEED_DELAY_H = 24;
export const FREE_ROWS = 100;
export const PAID_ROWS = 1000;
export const FREE_DRIFT_DAYS = 7;
export const FEED_FREE_PER_DAY = 200;
export const KEEP_DAYS = 400;
export const SNAPSHOT_KEEP = 3;
export const PERIOD_DAYS = 30;
export const FEED_PRICES = Object.freeze({
  call: { atomic: "10000", usd: "0.01", what: "one real-time call on /v1/feed or /v1/feed/endpoint/{hkey}" },
  drift: { atomic: "50000", usd: "0.05", what: "one call on /v1/feed/drift with full history" },
  endpoint: { atomic: "1000000", usd: "1.00", what: "30 days real-time for one endpoint (hkey)", subscription: true },
  category: { atomic: "10000000", usd: "10.00", what: "30 days real-time for one category", subscription: true },
  firehose: { atomic: "49000000", usd: "49.00", what: "30 days real-time for every endpoint plus the live daily snapshot", subscription: true },
});
const USDC = new Set(["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0x036cbd53842c5426634e7929541ec2318f3dcf7e", "epjfwdd5aufqssqem2qn1xzybapc8g4wegggzwytdt1v"]);
const HKEY_RE = /^h:[0-9a-f]{64}$/;
const KEY_RE = /^fk_[0-9a-f]{48}$/;
const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s))));
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const on = (v) => ["1", "on", "true"].includes(String(v || "").toLowerCase());
export const feedOn = (env) => on(env && env.FEED);
export const feedObserveOn = (env) => on(env && env.FEED_OBSERVE);
export const feedMainnet = (env) => on(env && env.FEED_MAINNET);
const pepper = (env) => String(env.FEED_PEPPER || env.WATCH_PEPPER || env.HOSTED_KEY_PEPPER || "");
const J = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE", "cache-control": "no-store", ...extra } });

// ------------------------------------------------------------------ pure helpers
export async function feedKey(u) { let n = String(u || ""); try { n = normUrl(u); } catch (_) {} return "h:" + (await sha256Hex(n)); }
export function publicUrl(u) { try { const x = new URL(String(u)); return { url: `${x.protocol}//${x.host}${x.pathname}`, host: x.hostname.toLowerCase() }; } catch (_) { return null; } }
// Fixed taxonomy from the crawl's existing fields (URL path/host words + source list names). Deterministic keyword map,
// first match wins; not a classifier and not a judgement of the endpoint.
const CAT_RULES = [
  ["crypto-market", /\b(price|prices|token|tokens|swap|dex|defi|ohlc|candles?|coin|coins|crypto|trading|trade|market|markets|orderbook|liquidity|yield|nft|btc|eth|sol|solana|ethereum|bitcoin|wallet|onchain|chain)\b/],
  ["inference", /\b(ai|llm|gpt|inference|infer|model|models|chat|completions?|embeddings?|generate|generation|prompt|agent|agents|claude|gemini|openai|llama|vision|transcribe|tts|stt)\b/],
  ["search/data", /\b(search|data|query|lookup|weather|news|scrape|scraper|crawl|index|geo|geocode|maps?|stats|analytics|feed|feeds|dataset|records?|enrich|people|company|companies)\b/],
  ["content", /\b(content|article|articles|blog|posts?|video|videos|image|images|img|music|audio|meme|memes|story|stories|pdf|media|photos?|art|book|books|quote|quotes|jokes?)\b/],
  ["infra", /\b(rpc|node|nodes|storage|compute|proxy|dns|ssl|cert|monitor|ping|health|status|faucet|facilitator|gateway|webhooks?|email|sms|ipfs|cdn|uptime|verify|auth)\b/],
];
export function categoryOf({ url = "", source_list = "", also = [] } = {}) {
  let text = String(url);
  try { const x = new URL(url); text = x.hostname + " " + x.pathname; } catch (_) {}
  text = (text + " " + (source_list || "") + " " + (also || []).join(" ")).toLowerCase().replace(/[^a-z0-9]+/g, " ");
  for (const [c, re] of CAT_RULES) if (re.test(text)) return c;
  return "other";
}
export function priceUsdOf(amount, asset) {
  if (amount == null || !/^[0-9]{1,30}$/.test(String(amount))) return null;
  return USDC.has(String(asset || "").toLowerCase()) ? Number(amount) / 1e6 : null;
}
export const termsOf = (t) => (t ? { network: t.network ?? null, asset: t.asset ? String(t.asset).toLowerCase() : null, pay_to: t.pay_to ?? t.payTo ?? null, amount_atomic: t.amount_atomic ?? t.amount ?? null } : null);
export async function termsSig(t) {
  const x = termsOf(t);
  if (!x || (!x.network && !x.asset && !x.pay_to && x.amount_atomic == null)) return null;
  if (x.pay_to) x.pay_to = String(x.pay_to).toLowerCase();
  if (x.amount_atomic != null) x.amount_atomic = String(x.amount_atomic);
  return "sha256:" + (await sha256Hex(canonicalize(x)));
}
/** Drift between two observations' payment terms: [{field, from, to}] over the public terms fields only. */
export function diffTerms(prev, next) {
  if (!prev || !next) return [];
  const a = termsOf(prev) || {}, b = termsOf(next) || {};
  const ch = [];
  for (const f of ["network", "asset", "pay_to", "amount_atomic"]) {
    const x = a[f] == null ? null : String(a[f]).toLowerCase(), y = b[f] == null ? null : String(b[f]).toLowerCase();
    if (x !== y) ch.push({ field: f, from: a[f] ?? null, to: b[f] ?? null });
  }
  return ch;
}
/** Transition between two observations: drift (terms changed while up), down, recovery, or null. */
export function eventOf(prev, next) {
  if (!prev) return { event: null, changes: [] };
  if (prev.state !== "down" && next.state === "down") return { event: "down", changes: [] };
  if (prev.state === "down" && next.state === "up") return { event: "recovery", changes: [] };
  if (next.state === "up" && prev.terms_sig && next.terms_sig && prev.terms_sig !== next.terms_sig) {
    // a field one source does not record (crawl rows have no pay_to/amount) is not a change
    const changes = diffTerms(prev, next).filter((c) => c.from != null && c.to != null);
    if (changes.length) return { event: "drift", changes };
  }
  return { event: null, changes: [] };
}
const pick = (row, cols) => { const o = {}; for (const c of cols) o[c] = row[c] === undefined ? null : row[c]; if ("changes" in o && typeof o.changes === "string") { try { o.changes = JSON.parse(o.changes); } catch (_) { o.changes = []; } } return o; };
export const feedRow = (r) => pick(r, FEED_COLUMNS);
export const eventRow = (r) => pick(r, EVENT_COLUMNS);
export const obsRow = (r) => pick(r, OBS_COLUMNS);
const csvCell = (v) => { if (v == null) return ""; const s = typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function toCsv(rows, cols = FEED_COLUMNS) { return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n"; }
export function parseCsv(text) {
  const out = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(cell); cell = ""; } else if (ch === "\n") { row.push(cell); out.push(row); row = []; cell = ""; } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}

// ------------------------------------------------------------------ writer (stepWatch batch) and upsert
/** Observation object for one watch probe (o = watch.js probe result, w = watch row after stepWatch). */
const CHANGE_FIELDS = { payTo: "pay_to", network: "network", asset: "asset", price: "amount_atomic", x402_version: "x402_version", schemes: "schemes", paywall: "paywall" };
/** Allowlisted drift changes from a signed watch drift event: {field, from, to} over public 402 fields only. */
export function changesOf(list) {
  return (Array.isArray(list) ? list : []).filter((c) => c && CHANGE_FIELDS[c.field]).map((c) => {
    const v = (x) => (x == null ? null : Array.isArray(x) ? x.map(String).slice(0, 8) : typeof x === "boolean" || typeof x === "number" ? x : String(x).slice(0, 80));
    return { field: CHANGE_FIELDS[c.field], from: v(c.from), to: v(c.to) };
  });
}
export async function watchObservation(w, o, fired, now) {
  const t = termsOf(o && o.terms);
  const state = w.state === "down" ? "down" : o && o.reachable && o.http_status && o.http_status < 500 ? "up" : w.state === "up" ? "up" : "unknown";
  const evs = (fired || []).filter((e) => e && ["drift", "down", "recovery"].includes(e.type));
  const ev = evs.length ? evs[0].type : null;
  const changes = ev === "drift" ? changesOf(evs[0].changes) : null;
  return { observed_at: iso(now), src: "w", state, http_status: (o && o.http_status) ?? null, ...(t || {}), price_usd: t ? priceUsdOf(t.amount_atomic, t.asset) : null, terms_sig: await termsSig(t), event: ev, changes };
}
/** D1 statements: one observation row + the feed_endpoints upsert. Used in the stepWatch batch and by the backfill. */
export function observationStatements(db, ep, ob) {
  const changes = ob.changes && ob.changes.length ? JSON.stringify(ob.changes) : null;
  return [
    db.prepare("INSERT OR IGNORE INTO feed_observations (hkey, observed_at, src, state, http_status, price_usd, amount_atomic, network, asset, pay_to, terms_sig, event, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(ep.hkey, ob.observed_at, ob.src, ob.state, ob.http_status ?? null, ob.price_usd ?? null, ob.amount_atomic == null ? null : String(ob.amount_atomic), ob.network ?? null, ob.asset ?? null, ob.pay_to ?? null, ob.terms_sig ?? null, ob.event ?? null, changes),
    db.prepare(`INSERT INTO feed_endpoints (hkey, url, host, method, category, crawl_known, watch_opt_in, first_seen_at, observed_at, state, http_status, price_usd, amount_atomic, network, asset, pay_to, terms_sig, last_change_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hkey) DO UPDATE SET crawl_known = MAX(feed_endpoints.crawl_known, excluded.crawl_known), watch_opt_in = MAX(feed_endpoints.watch_opt_in, excluded.watch_opt_in),
        last_change_at = CASE WHEN excluded.observed_at < feed_endpoints.observed_at THEN feed_endpoints.last_change_at
          WHEN feed_endpoints.state IS NOT excluded.state OR feed_endpoints.terms_sig IS NOT excluded.terms_sig THEN excluded.observed_at ELSE feed_endpoints.last_change_at END,
        state = CASE WHEN excluded.observed_at >= feed_endpoints.observed_at THEN excluded.state ELSE feed_endpoints.state END,
        http_status = CASE WHEN excluded.observed_at >= feed_endpoints.observed_at THEN excluded.http_status ELSE feed_endpoints.http_status END,
        price_usd = CASE WHEN excluded.observed_at >= feed_endpoints.observed_at THEN excluded.price_usd ELSE feed_endpoints.price_usd END,
        amount_atomic = CASE WHEN excluded.observed_at >= feed_endpoints.observed_at THEN excluded.amount_atomic ELSE feed_endpoints.amount_atomic END,
        network = CASE WHEN excluded.observed_at >= feed_endpoints.observed_at THEN excluded.network ELSE feed_endpoints.network END,
        asset = CASE WHEN excluded.observed_at >= feed_endpoints.observed_at THEN excluded.asset ELSE feed_endpoints.asset END,
        pay_to = CASE WHEN excluded.observed_at >= feed_endpoints.observed_at THEN excluded.pay_to ELSE feed_endpoints.pay_to END,
        terms_sig = CASE WHEN excluded.observed_at >= feed_endpoints.observed_at THEN excluded.terms_sig ELSE feed_endpoints.terms_sig END,
        first_seen_at = MIN(feed_endpoints.first_seen_at, excluded.first_seen_at),
        observed_at = MAX(feed_endpoints.observed_at, excluded.observed_at)`)
      .bind(ep.hkey, ep.url, ep.host, ep.method || "GET", ep.category, ep.crawl_known ? 1 : 0, ep.watch_opt_in ? 1 : 0, ob.observed_at, ob.observed_at, ob.state, ob.http_status ?? null, ob.price_usd ?? null, ob.amount_atomic == null ? null : String(ob.amount_atomic), ob.network ?? null, ob.asset ?? null, ob.pay_to ?? null, ob.terms_sig ?? null, ob.observed_at),
  ];
}
/** Called from watch.js stepWatch: statements to append to its batch, or [] (feed off / watch not opted in). */
// 0.52.0 (PR #7 review): an observation row is written only when something changed (state, HTTP status, terms, or a
// drift/down/recovery event) plus one heartbeat row per endpoint per UTC day; feed_endpoints is still upserted every probe.
export function needsObservation(prev, ob) {
  if (!prev) return "first";
  if (ob.event) return "event";
  if (prev.state !== ob.state || (prev.http_status ?? null) !== (ob.http_status ?? null) || (prev.terms_sig ?? null) !== (ob.terms_sig ?? null)) return "change";
  if (!prev.last_obs || prev.last_obs.slice(0, 10) < ob.observed_at.slice(0, 10)) return "heartbeat";
  return null;
}
export async function feedStatementsForWatch(env, db, w, o, fired, now) {
  if (!feedObserveOn(env) || !Number(w.feed_opt_in)) return [];
  const pu = publicUrl(w.url);
  if (!pu) return [];
  const ep = { hkey: await feedKey(pu.url), ...pu, method: w.method || "GET", category: categoryOf({ url: pu.url }), crawl_known: 0, watch_opt_in: 1 };
  const ob = await watchObservation(w, o, fired, now);
  const prev = await db.prepare("SELECT state, http_status, terms_sig, (SELECT MAX(observed_at) FROM feed_observations WHERE hkey = ?) AS last_obs FROM feed_endpoints WHERE hkey = ?").bind(ep.hkey, ep.hkey).first();
  const st = observationStatements(db, ep, ob);
  return needsObservation(prev, ob) ? st : [st[1]];
}
export const FEED_OPT_IN_MAX = 100;
export const optInMax = (env) => { const n = parseInt((env && env.FEED_OPT_IN_MAX) ?? "", 10); return Number.isFinite(n) && n >= 0 ? n : FEED_OPT_IN_MAX; };
/** true if one more watch may opt in; logs (no ids, no URLs) when the cap is hit. */
export async function optInAllowed(env, db) {
  const n = ((await db.prepare("SELECT COUNT(*) AS n FROM watches WHERE feed_opt_in = 1 AND status != 'deleted'").first()) || {}).n || 0;
  if (n < optInMax(env)) return true;
  console.log(JSON.stringify({ feed: "opt_in_cap_hit", cap: optInMax(env), opted_in: n }));
  return false;
}
/** Opt-out: drop watch-sourced rows for an endpoint that no other opted-in watch covers (crawl rows stay: public). */
export async function feedOptOut(db, url) {
  const pu = publicUrl(url); if (!pu) return;
  const hk = await feedKey(pu.url);
  await db.prepare("DELETE FROM feed_observations WHERE hkey = ? AND src = 'w'").bind(hk).run();
  const ep = await db.prepare("SELECT crawl_known FROM feed_endpoints WHERE hkey = ?").bind(hk).first();
  if (ep && !ep.crawl_known) await db.batch([db.prepare("DELETE FROM feed_endpoints WHERE hkey = ?").bind(hk), db.prepare("DELETE FROM feed_observations WHERE hkey = ?").bind(hk)]);
  else if (ep) await db.prepare("UPDATE feed_endpoints SET watch_opt_in = 0 WHERE hkey = ?").bind(hk).run();
}

// ------------------------------------------------------------------ snapshots (crawl_store, source = 'feed')
// 0.52.0 (PR #7 review): built in chunks across cron ticks and stored as pages, so no single invocation holds the whole
// snapshot (about 21 MB gzip+base64 for 123k endpoints) and free reads decode at most two ~60 KB pages.
//   f:build              build state {date, started_at, after_cat, after_hkey, count, page, categories, page_csv_sha256}
//   f:snap:<date>:p<n>   one page: base64(gzip(CSV rows)), PAGE_ROWS rows, rows ordered by (category, hkey)
//   f:snap:<date>:head   signed header: count, pages, per-category {start, count}, page_csv_sha256[], rows_root
// page CSV = FEED_COLUMNS header line + the page's rows (exactly what /v1/feed/snapshot.csv?page=n serves).
// rows_root = sha256(page_csv_sha256 values joined by "\n"); the signature covers the header (incl. rows_root).
export const PAGE_ROWS = 500;
export const BUILD_ROWS_PER_STEP = 5000;
async function gzipB64(text) {
  const buf = new Uint8Array(await new Response(new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}
async function gunzipB64(b64) {
  const str = atob(b64), bin = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bin[i] = str.charCodeAt(i);
  return new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}
const pageKey = (date, n) => `f:snap:${date}:p${String(n).padStart(5, "0")}`;
const headKey = (date) => `f:snap:${date}:head`;
const putStmt = (db, key, value, sha, now) => db.prepare("INSERT OR REPLACE INTO crawl_store (key, part, parts, sha256, value, source, updated_at) VALUES (?, 0, 1, ?, ?, 'feed', ?)").bind(key, sha, value, iso(now));
async function getOne(db, key) { const r = await db.prepare("SELECT sha256, value, updated_at FROM crawl_store WHERE key = ? AND part = 0").bind(key).first(); return r || null; }
/** One build step (one cron tick): reads up to BUILD_ROWS_PER_STEP endpoints, writes their pages, finalizes when done. */
export async function snapshotStep(env, now = new Date(), { rowsPerStep = BUILD_ROWS_PER_STEP } = {}) {
  const db = env.RECEIPTS_DB;
  const today = iso(now).slice(0, 10);
  const sraw = await getOne(db, "f:build");
  let st = sraw ? JSON.parse(sraw.value) : null;
  if (!st) {
    if (await getOne(db, headKey(today))) return { did: "idle" };
    st = { date: today, started_at: iso(now), after_cat: "", after_hkey: "", count: 0, page: 0, categories: {}, page_csv_sha256: [] };
    await db.prepare("DELETE FROM crawl_store WHERE source = 'feed' AND key >= ? AND key < ?").bind(`f:snap:${today}:`, `f:snap:${today};`).run();
  }
  const rows = ((await db.prepare(`SELECT ${FEED_COLUMNS.join(", ")} FROM feed_endpoints WHERE category > ? OR (category = ? AND hkey > ?) ORDER BY category, hkey LIMIT ?`)
    .bind(st.after_cat, st.after_cat, st.after_hkey, rowsPerStep).all()).results || []).map(feedRow);
  const stmts = [];
  for (let i = 0; i < rows.length; i += PAGE_ROWS) {
    const page = rows.slice(i, i + PAGE_ROWS);
    for (const [j, r] of page.entries()) { const c = st.categories[r.category] || (st.categories[r.category] = { start: st.count + i + j, count: 0 }); c.count++; }
    const csv = toCsv(page);
    st.page_csv_sha256.push(await sha256Hex(csv));
    const v = await gzipB64(csv.slice(csv.indexOf("\n") + 1));
    stmts.push(putStmt(db, pageKey(st.date, st.page++), v, await sha256Hex(v), now));
  }
  st.count += rows.length;
  if (rows.length) { st.after_cat = rows[rows.length - 1].category; st.after_hkey = rows[rows.length - 1].hkey; }
  const done = rows.length < rowsPerStep;
  if (!done) { const v = JSON.stringify(st); stmts.push(putStmt(db, "f:build", v, await sha256Hex(v), now)); await db.batch(stmts); return { did: "step", date: st.date, count: st.count, pages: st.page }; }
  const header = { type: "402xagent-feed-snapshot", schema: "feed.v2", date: st.date, started_at: st.started_at, built_at: iso(now), count: st.count, page_rows: PAGE_ROWS, pages: st.page,
    order: "category, hkey", columns: FEED_COLUMNS, categories: st.categories, page_csv_sha256: st.page_csv_sha256, rows_root: await sha256Hex(st.page_csv_sha256.join("\n")), issuer: "402xAgent Watchtower" };
  const signed = (await signObject(env, header)) || header;
  const hv = JSON.stringify(signed);
  stmts.push(putStmt(db, headKey(st.date), hv, await sha256Hex(hv), now));
  stmts.push(db.prepare("DELETE FROM crawl_store WHERE key = 'f:build'"));
  await db.batch(stmts);
  // keep the newest SNAPSHOT_KEEP complete snapshots; drop older dates (pages + heads)
  const heads = ((await db.prepare("SELECT key FROM crawl_store WHERE source = 'feed' AND key LIKE 'f:snap:%:head' ORDER BY key DESC").all()).results || []).map((r) => r.key.slice(7, 17));
  if (heads.length > SNAPSHOT_KEEP) await db.prepare("DELETE FROM crawl_store WHERE source = 'feed' AND key LIKE 'f:snap:%' AND key < ?").bind(`f:snap:${heads[SNAPSHOT_KEEP - 1]}:`).run();
  return { did: "done", date: st.date, count: st.count, pages: st.page, header: signed };
}
/** Runs steps until the snapshot is complete (tests, local tools). The Worker runs one step per cron tick. */
export async function buildSnapshot(env, now = new Date(), opts = {}) {
  for (let i = 0; i < 100000; i++) { const r = await snapshotStep(env, now, opts); if (r.did === "done") return { key: headKey(r.date), count: r.count, pages: r.pages, header: r.header }; if (r.did === "idle") return null; }
  throw new Error("snapshot build did not finish");
}
const headCache = new Map(), pageCache = new Map();
export function _clearFeedCache() { headCache.clear(); pageCache.clear(); }
/** Latest complete snapshot header, or (delayed = true) the newest one completed at least FEED_DELAY_H hours ago. */
export async function loadHead(db, now, delayed) {
  const cut = iso(new Date(now).getTime() - FEED_DELAY_H * 3600000);
  const heads = (await db.prepare("SELECT key, sha256, updated_at FROM crawl_store WHERE source = 'feed' AND key LIKE 'f:snap:%:head' ORDER BY key DESC").all()).results || [];
  const h = heads.find((x) => !delayed || x.updated_at <= cut);
  if (!h) return null;
  if (headCache.has(h.key) && headCache.get(h.key).sha === h.sha256) return headCache.get(h.key).v;
  const r = await getOne(db, h.key);
  if (!r || (await sha256Hex(r.value)) !== r.sha256) return null;
  const v = JSON.parse(r.value);
  if (headCache.size > 8) headCache.clear();
  headCache.set(h.key, { sha: h.sha256, v });
  return v;
}
/** One page as CSV text (with the header line) and row objects; null if missing or torn. */
export async function loadPage(db, head, n) {
  const key = pageKey(head.date, n);
  const r = await getOne(db, key);
  if (!r) return null;
  if (pageCache.has(key) && pageCache.get(key).sha === r.sha256) return pageCache.get(key).v;
  if ((await sha256Hex(r.value)) !== r.sha256) return null;
  const csv = FEED_COLUMNS.join(",") + "\n" + (await gunzipB64(r.value));
  if (head.page_csv_sha256 && head.page_csv_sha256[n] !== (await sha256Hex(csv))) return null;
  const rows = parseCsv(csv).slice(1).map(fromCsvRow);
  const v = { csv, rows };
  if (pageCache.size > 16) pageCache.clear();
  pageCache.set(key, { sha: r.sha256, v });
  return v;
}
const NUM_COLS = new Set(["http_status", "price_usd"]);
export const fromCsvRow = (a) => Object.fromEntries(FEED_COLUMNS.map((c, i) => [c, a[i] === "" || a[i] === undefined ? null : NUM_COLS.has(c) ? Number(a[i]) : a[i]]));
/** Rows [start, start + n) of a snapshot (global index), reading only the pages that cover them. */
export async function snapshotRows(db, head, start, n) {
  const out = [];
  for (let p = Math.floor(start / PAGE_ROWS); out.length < n && p < head.pages; p++) {
    const pg = await loadPage(db, head, p);
    if (!pg) throw new Error("snapshot page missing");
    const from = Math.max(0, start - p * PAGE_ROWS);
    out.push(...pg.rows.slice(from, from + (n - out.length)));
  }
  return out;
}

// ------------------------------------------------------------------ cron: prune (daily) + one snapshot step (every tick)
export async function feedDaily(env, now = new Date()) {
  if (!env.RECEIPTS_DB || !(feedOn(env) || feedObserveOn(env))) return { did: "off" };
  return { did: "daily", pruned: await prune(env.RECEIPTS_DB, now) };
}
export async function feedTick(env, now = new Date()) {
  if (!env.RECEIPTS_DB || !feedOn(env)) return { did: "off" };
  return snapshotStep(env, now);
}
export async function prune(db, now = new Date()) {
  const cut = iso(new Date(now).getTime() - KEEP_DAYS * DAY);
  const r = await db.prepare("DELETE FROM feed_observations WHERE observed_at < ?").bind(cut).run();
  await db.prepare("DELETE FROM feed_quota WHERE day < ?").bind(iso(new Date(now).getTime() - 2 * DAY).slice(0, 10)).run();
  return { observations: (r && r.meta && r.meta.changes) || 0, before: cut };
}

// ------------------------------------------------------------------ access: free quota, keys, x402
/** Payment config for the feed: Base Sepolia unless FEED_MAINNET=1 (then the Worker's normal preset). */
export function feedCfg(env, deps, priceKey) {
  const e = feedMainnet(env) ? env : { ...env, PAYMENT_PRESET: "base-sepolia", PAYMENT_NETWORK: "", PAYMENT_ASSET: "", PAYMENT_ASSET_NAME: "", PAYMENT_ASSET_VERSION: "" };
  const c = deps.cfgOf(e);
  const p = FEED_PRICES[priceKey];
  return { ...c, priceAtomic: p.atomic, priceUsd: p.usd };
}
const describe = (c, k) => `402xAgent Watchtower feed: $${FEED_PRICES[k].usd} USDC on ${c.label || "Base"} for ${FEED_PRICES[k].what}. Facts only (liveness, payment terms, drift events); payment never changes the data.`;
function paymentRequired(c, deps, resourceUrl, k, error, extra = {}) {
  const desc = describe(c, k);
  const body = { x402Version: 2, error, resource: { url: resourceUrl, description: desc, mimeType: "application/json" },
    accepts: [deps.paymentRequirements(c, resourceUrl, 2, { paidPath: true, description: desc })],
    product: "watchtower-feed", tier: k, price_usd: FEED_PRICES[k].usd, network: c.network, testnet: c.network !== "eip155:8453",
    how_to_pay: "Retry the same request with a PAYMENT-SIGNATURE header (x402 v2; X-PAYMENT also accepted) for the amount and payTo above.",
    free_alternative: "Drop live=1 / full=1 for the free tier (data 24 h old, 100 rows, 7 days of drift).", manifest: "/v1/feed/manifest", ...extra };
  return J(body, 402, { "payment-required": deps.b64encode(body) });
}
/** Verifies and settles an x402 payment. The standard x402 PAYMENT-RESPONSE header (settlement incl. tx hash and payer)
 *  goes back to the paying buyer only; it is never written to feed tables, snapshots, logs or any response body. */
async function pay(req, c, deps, resourceUrl, k) {
  const hdr = deps.paymentHeader(req);
  if (!hdr) return { none: true };
  const payload = deps.decodePaymentHeader(hdr);
  if (!payload) return { error: "payment header is not valid base64 JSON x402 payload" };
  const bad = deps.checkPayload(payload, c);
  if (bad) return { error: "payment rejected: " + bad };
  const r = await deps.verifyAndSettle(c, payload, resourceUrl, { paidPath: true, description: describe(c, k) });
  if (!r.ok) return { error: "payment rejected: " + String(r.reason || "").replace(/0x[0-9a-fA-F]{40,}/g, "[redacted]") };
  const enc = deps.b64encode(r.settle);
  return { ok: true, replayed: !!r.replayed, headers: { "payment-response": enc, "x-payment-response": enc } };
}
async function keyOf(req, env, now) {
  const m = /^Bearer\s+(fk_[0-9a-f]{48})$/.exec(req.headers.get("authorization") || "");
  if (!m || !pepper(env)) return null;
  const k = await env.RECEIPTS_DB.prepare("SELECT key_hash, tier, scope, paid_until FROM feed_keys WHERE key_hash = ?").bind(await sha256Hex(pepper(env) + ":" + m[1])).first();
  if (!k) return null;
  return { tier: k.tier, scope: k.scope, paid_until: k.paid_until, active: k.paid_until > iso(now), key_hash: k.key_hash };
}
const inScope = (k, ep) => !!k && k.active && (k.tier === "firehose" || (k.tier === "category" && ep.category === k.scope) || (k.tier === "endpoint" && ep.hkey === k.scope));
async function takeQuota(req, env, deps, now) {
  const pkey = (await sha256Hex(String(env.CLIENT_SALT || "") + "|feed|" + deps.ipPrefix(req.headers.get("cf-connecting-ip") || ""))).slice(0, 32);
  const row = await env.RECEIPTS_DB.prepare("INSERT INTO feed_quota (day, pkey, n) VALUES (?, ?, 1) ON CONFLICT(day, pkey) DO UPDATE SET n = n + 1 RETURNING n").bind(iso(now).slice(0, 10), pkey).first();
  return row ? Number(row.n) : 1;
}
const intParam = (v, d, max) => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : d; };
const isoParam = (v) => { if (!v) return null; const t = Date.parse(v); return Number.isFinite(t) ? iso(t) : undefined; };
function filters(sp) {
  const category = sp.get("category"), host = sp.get("host");
  if (category && !FEED_CATEGORIES.includes(category)) return { error: "category must be one of " + FEED_CATEGORIES.join(", ") };
  if (host && !/^[a-z0-9.-]{1,253}$/i.test(host)) return { error: "host must be a hostname" };
  const since = isoParam(sp.get("since"));
  if (since === undefined) return { error: "since must be an ISO 8601 time" };
  return { category: category || null, host: host ? host.toLowerCase() : null, since };
}
const matches = (f) => (r) => (!f.category || r.category === f.category) && (!f.host || r.host === f.host) && (!f.since || (r.observed_at || "") >= f.since);

// ------------------------------------------------------------------ manifest
export async function manifest(env, deps, origin) {
  const c = feedCfg(env, deps, "call");
  const body = {
    type: "402xagent-feed-manifest", schema: "feed.v1", issuer: "402xAgent Watchtower",
    facts_only: "Liveness, payment terms and drift events as observed. No scores, grades, ratings or rankings.",
    categories: FEED_CATEGORIES, category_source: "fixed keyword map over the crawl's URL and source-list fields",
    inclusion: "crawl-known public x402 URLs, plus Watchtower watches whose owner opted in (feed_opt_in). Query strings are never stored.",
    columns: { endpoint: FEED_COLUMNS, observation: OBS_COLUMNS, event: EVENT_COLUMNS },
    endpoints: {
      feed: "GET /v1/feed?category=&host=&since=&offset=&limit=", endpoint: "GET /v1/feed/endpoint/{hkey}", drift: "GET /v1/feed/drift?from=&to=&category=&host=",
      snapshot_json: "GET /v1/feed/snapshot.json[?page=n]", snapshot_csv: "GET /v1/feed/snapshot.csv?page=n", subscribe: "POST /v1/feed/subscribe {tier: endpoint|category|firehose, scope}", manifest: "GET /v1/feed/manifest",
    },
    free: { delay_hours: FEED_DELAY_H, max_rows: FREE_ROWS, drift_days: FREE_DRIFT_DAYS, calls_per_day_per_network: FEED_FREE_PER_DAY, snapshot: "daily, at least 24 h old, paginated" },
    paid: Object.fromEntries(Object.entries(FEED_PRICES).map(([k, p]) => [k, { price_usd: p.usd, amount_atomic: p.atomic, what: p.what, ...(p.subscription ? { period_days: PERIOD_DAYS } : { per_call: true }) }])),
    license: "Self-serve feed tiers (free and paid) exclude resale and use by risk-engine or competing verification vendors; those uses need a separate license.",
    payment: { protocol: "x402 v2 exact", network: c.network, asset: c.asset, pay_to: c.payTo, testnet: c.network !== "eip155:8453", rows_per_paid_call: PAID_ROWS,
      how: "live=1 on /v1/feed or /v1/feed/endpoint/{hkey} ($0.01), full=1 on /v1/feed/drift ($0.05), or Authorization: Bearer fk_<key> from /v1/feed/subscribe" },
    writes: "an observation row per endpoint only when state, HTTP status or payment terms change (or a drift/down/recovery event), plus one heartbeat row per UTC day",
    watched_opt_in_cap: optInMax(env),
    snapshot: { page_rows: PAGE_ROWS, order: "category, hkey", built: "in chunks across cron ticks each UTC day; as_of = started_at", index: "GET /v1/feed/snapshot.json (signed header)", page: "GET /v1/feed/snapshot.csv?page=n or .json?page=n" },
    free_filters: "category + offset on the free tier; host and since need live=1 or a key",
    limitations: [
      "Crawl-sourced rows (weekly crawl, src c) record only whether a 402 quote was present plus its network and asset; they carry no pay_to or exact amount. A field a source never recorded is not reported as drift, so pay_to/amount drift is only detected on endpoints with hourly watch probes (opted in) or endpoint_history rows.",
      "Crawl rows are as fresh as the last weekly crawl; observed_at says when.",
    ],
    retention_days: KEEP_DAYS, signing: { keys: "/.well-known/402xagent-keys.json", alg: "Ed25519", covers: "snapshot header: page_csv_sha256[] per page and rows_root = sha256(page hashes joined by \\n)" },
  };
  const signed = await signObject(env, body);
  return signed || { ...body, kid: null };
}

// ------------------------------------------------------------------ HTTP
export async function handleFeed(req, env, url, deps) {
  if (!feedOn(env)) return J({ error: "the Watchtower feed is not enabled yet", code: "not_enabled" }, 404);
  if (!env.RECEIPTS_DB) return J({ error: "feed store unavailable", code: "store_unavailable" }, 503);
  const db = env.RECEIPTS_DB;
  const now = deps.now ? deps.now() : new Date();
  const path = url.pathname.replace(/\/+$/, "");
  const sp = url.searchParams;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "Authorization, PAYMENT-SIGNATURE, X-PAYMENT, Content-Type" } });
  if (path === "/v1/feed/manifest") return J(await manifest(env, deps, url.origin));
  if (path === "/v1/feed/subscribe") return subscribe(req, env, url, deps, now);
  if (req.method !== "GET" && req.method !== "HEAD") return J({ error: "use GET" }, 405, { allow: "GET, HEAD" });
  const key = await keyOf(req, env, now);
  if (key && !key.active) return J({ error: "this feed key expired at " + key.paid_until + "; renew with POST /v1/feed/subscribe (Bearer) or drop the header for the free tier", code: "key_expired" }, 402);
  const delayCut = iso(new Date(now).getTime() - FEED_DELAY_H * 3600000);
  // which access applies: key (scoped, real-time), per-call x402 (live=1 / full=1), or free (delayed + capped + quota)
  const wantPaid = sp.get("live") === "1" || sp.get("full") === "1" || !!deps.paymentHeader(req);
  const free = async () => {
    try { const n = await takeQuota(req, env, deps, now); if (n > FEED_FREE_PER_DAY) return J({ error: `free feed quota used: ${FEED_FREE_PER_DAY} calls per UTC day per network; paid tiers at /v1/feed/manifest`, limit: FEED_FREE_PER_DAY }, 429, { "retry-after": "3600" }); }
    catch (_) { return J({ error: "feed store unavailable, try again shortly" }, 503); }
    return null;
  };
  const perCall = async (k) => {
    const c = feedCfg(env, deps, k);
    const ru = url.origin + url.pathname;
    const p = await pay(req, c, deps, ru, k);
    if (p.none) return { resp: paymentRequired(c, deps, ru, k, k === "drift" ? "Full drift history is $0.05 per call." : "Real-time feed data is $0.01 per call.") };
    if (p.error) return { resp: paymentRequired(c, deps, ru, k, p.error) };
    return { headers: p.headers };
  };

  if (path === "/v1/feed" || path === "/v1/feed/endpoint" || path.startsWith("/v1/feed/endpoint/")) {
    const one = path.startsWith("/v1/feed/endpoint/") ? decodeURIComponent(path.slice("/v1/feed/endpoint/".length)) : null;
    if (path === "/v1/feed/endpoint" || (one !== null && !HKEY_RE.test(one))) return J({ error: "hkey must be h:<64 hex> (the hkey field of /v1/feed rows)", code: "bad_hkey" }, 400);
    const f = filters(sp);
    if (f.error) return J({ error: f.error, code: "bad_input" }, 400);
    if (!one && !key && !wantPaid && (f.host || f.since)) return J({ error: "host and since filters are real-time only (live=1, $0.01, or a feed key); the free tier pages the daily snapshot by category and offset", code: "filter_needs_paid" }, 400);
    let mode = "free", headers = {};
    if (key) mode = "key";
    else if (wantPaid) { const r = await perCall("call"); if (r.resp) return r.resp; mode = "paid"; headers = r.headers; }
    else { const q = await free(); if (q) return q; }
    if (one) {
      const ep = await db.prepare(`SELECT ${FEED_COLUMNS.join(", ")} FROM feed_endpoints WHERE hkey = ?`).bind(one).first();
      if (!ep) return J({ error: "no such endpoint in the feed", code: "not_found" }, 404, headers);
      if (mode === "key" && !inScope(key, ep)) return J({ error: "this key does not cover this endpoint", code: "out_of_scope", tier: key.tier }, 403);
      const live = mode !== "free";
      const lo = live ? iso(new Date(now).getTime() - KEEP_DAYS * DAY) : iso(new Date(now).getTime() - FREE_DRIFT_DAYS * DAY);
      const hi = live ? iso(now) : delayCut;
      const lim = live ? intParam(sp.get("limit"), PAID_ROWS, PAID_ROWS) : intParam(sp.get("limit"), FREE_ROWS, FREE_ROWS);
      const obs = ((await db.prepare(`SELECT ${OBS_COLUMNS.join(", ")} FROM feed_observations WHERE hkey = ? AND observed_at >= ? AND observed_at <= ? ORDER BY observed_at DESC LIMIT ?`).bind(one, lo, hi, lim).all()).results || []).map(obsRow);
      let current = feedRow(ep);
      if (!live) { // free: the state as of 24 h ago (latest observation at or before the cut), never the live row
        const o = obs[0];
        current = o ? { ...current, ...pick(o, ["state", "http_status", "price_usd", "amount_atomic", "network", "asset", "pay_to", "terms_sig", "observed_at"]) } : null;
        if (current && current.last_change_at > delayCut) current.last_change_at = null;
      }
      return J({ access: mode, delayed_hours: live ? 0 : FEED_DELAY_H, endpoint: current, observations: obs, count: obs.length }, 200, headers);
    }
    const offset = intParam(sp.get("offset"), 0, 1000000);
    if (mode === "free") { // pages of the newest snapshot completed >= 24 h ago; at most two ~60 KB pages are decoded
      const head = await loadHead(db, now, true);
      if (!head) return J({ access: "free", delayed_hours: FEED_DELAY_H, rows: [], count: 0, total: 0, note: "no snapshot at least 24 h old yet" });
      const cat = f.category ? head.categories[f.category] || { start: 0, count: 0 } : { start: 0, count: head.count };
      const lim = intParam(sp.get("limit"), FREE_ROWS, FREE_ROWS);
      const n = Math.max(0, Math.min(lim, cat.count - offset));
      let rows;
      try { rows = n ? await snapshotRows(db, head, cat.start + offset, n) : []; } catch (_) { return J({ error: "snapshot unavailable, try again shortly" }, 503); }
      return J({ access: "free", delayed_hours: FEED_DELAY_H, as_of: head.started_at, snapshot: head.date, rows, count: rows.length, total: cat.count, offset, ...(offset + rows.length < cat.count ? { next_offset: offset + rows.length } : {}) });
    }
    const w = [], b = [];
    if (mode === "key" && key.tier === "category") { w.push("category = ?"); b.push(key.scope); }
    if (mode === "key" && key.tier === "endpoint") { w.push("hkey = ?"); b.push(key.scope); }
    if (f.category) { w.push("category = ?"); b.push(f.category); }
    if (f.host) { w.push("host = ?"); b.push(f.host); }
    if (f.since) { w.push("observed_at >= ?"); b.push(f.since); }
    const lim = intParam(sp.get("limit"), PAID_ROWS, PAID_ROWS);
    const rows = ((await db.prepare(`SELECT ${FEED_COLUMNS.join(", ")} FROM feed_endpoints ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY hkey LIMIT ? OFFSET ?`).bind(...b, lim, offset).all()).results || []).map(feedRow);
    return J({ access: mode, delayed_hours: 0, as_of: iso(now), rows, count: rows.length, offset, ...(rows.length === lim ? { next_offset: offset + lim } : {}) }, 200, headers);
  }

  if (path === "/v1/feed/drift") {
    const f = filters(sp);
    if (f.error) return J({ error: f.error, code: "bad_input" }, 400);
    const from = isoParam(sp.get("from")), to = isoParam(sp.get("to"));
    if (from === undefined || to === undefined) return J({ error: "from and to must be ISO 8601 times", code: "bad_input" }, 400);
    let mode = "free", headers = {};
    if (key) mode = "key";
    else if (wantPaid) { const r = await perCall("drift"); if (r.resp) return r.resp; mode = "paid"; headers = r.headers; }
    else { const q = await free(); if (q) return q; }
    const live = mode !== "free";
    const floor = live ? "0000" : iso(new Date(now).getTime() - FREE_DRIFT_DAYS * DAY);
    const lo = from && from > floor ? from : floor;
    const ceil = live ? iso(now) : delayCut;
    const hi = to && to < ceil ? to : ceil;
    const w = ["o.event IS NOT NULL", "o.observed_at >= ?", "o.observed_at <= ?"], b = [lo, hi];
    if (mode === "key" && key.tier === "category") { w.push("e.category = ?"); b.push(key.scope); }
    if (mode === "key" && key.tier === "endpoint") { w.push("e.hkey = ?"); b.push(key.scope); }
    if (f.category) { w.push("e.category = ?"); b.push(f.category); }
    if (f.host) { w.push("e.host = ?"); b.push(f.host); }
    const lim = live ? intParam(sp.get("limit"), PAID_ROWS, PAID_ROWS) : intParam(sp.get("limit"), FREE_ROWS, FREE_ROWS);
    const offset = intParam(sp.get("offset"), 0, 1000000);
    const rows = ((await db.prepare(`SELECT o.hkey AS hkey, e.url AS url, e.host AS host, e.category AS category, o.event AS event, o.observed_at AS observed_at, o.state AS state, o.http_status AS http_status, o.changes AS changes
      FROM feed_observations o JOIN feed_endpoints e ON e.hkey = o.hkey WHERE ${w.join(" AND ")} ORDER BY o.observed_at DESC, o.hkey LIMIT ? OFFSET ?`).bind(...b, lim, offset).all()).results || []).map(eventRow);
    return J({ access: mode, delayed_hours: live ? 0 : FEED_DELAY_H, from: lo === "0000" ? null : lo, to: hi, events: rows, count: rows.length, offset, ...(rows.length === lim ? { next_offset: offset + lim } : {}) }, 200, headers);
  }

  if (path === "/v1/feed/snapshot.json" || path === "/v1/feed/snapshot.csv") {
    // paginated: no ?page -> the signed header (index); ?page=n -> one page (PAGE_ROWS rows) as CSV or JSON
    const fire = key && key.active && key.tier === "firehose";
    const pg = sp.get("page");
    if (pg !== null && !/^[0-9]{1,6}$/.test(pg)) return J({ error: "page must be an integer >= 0", code: "bad_input" }, 400);
    if (!fire) { const q = await free(); if (q) return q; }
    const head = await loadHead(db, now, !fire);
    if (!head) return J({ error: "no snapshot available yet (built daily, in chunks)", code: "no_snapshot" }, 404);
    const sig = { "x-feed-snapshot-date": head.date, "x-feed-rows-root": head.rows_root, "x-feed-kid": String(head.kid || "") };
    const base = url.origin + url.pathname;
    if (pg === null) return J({ access: fire ? "key" : "free", delayed: !fire, header: head, pages: head.pages, page_url: base + "?page={n}", first_page: base + "?page=0" }, 200, sig);
    const n = Number(pg);
    if (n >= head.pages) return J({ error: "page out of range (0.." + (head.pages - 1) + ")", code: "bad_page" }, 404);
    const page = await loadPage(db, head, n);
    if (!page) return J({ error: "snapshot page unavailable, try again shortly" }, 503);
    const ph = { ...sig, "x-feed-page": String(n), "x-feed-page-csv-sha256": head.page_csv_sha256[n] };
    if (path.endsWith(".csv")) return new Response(page.csv, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store", "content-disposition": `attachment; filename="402xagent-feed-${head.date}-p${n}.csv"`, ...ph } });
    return J({ access: fire ? "key" : "free", delayed: !fire, date: head.date, page: n, pages: head.pages, rows: page.rows, ...(n + 1 < head.pages ? { next_page: base + "?page=" + (n + 1) } : {}) }, 200, ph);
  }
  return J({ error: "not found", manifest: "/v1/feed/manifest" }, 404);
}

async function subscribe(req, env, url, deps, now) {
  const db = env.RECEIPTS_DB;
  if (!pepper(env)) return J({ error: "subscriptions unavailable; nothing was charged", code: "store_unavailable" }, 503);
  let b = {};
  if (req.method === "POST") { try { const t = await req.text(); b = t ? JSON.parse(t) : {}; } catch (_) { b = null; } }
  const tier = b && String(b.tier || "");
  const ru = url.origin + "/v1/feed/subscribe";
  if (req.method !== "POST" || !b || !["endpoint", "category", "firehose"].includes(tier)) {
    const c = feedCfg(env, deps, "firehose");
    return paymentRequired(c, deps, ru, "firehose", "POST JSON {tier: endpoint|category|firehose, scope} (endpoint: scope = hkey; category: scope = one of the categories). Nothing was charged.", { tiers: Object.fromEntries(["endpoint", "category", "firehose"].map((k) => [k, FEED_PRICES[k].usd])), categories: FEED_CATEGORIES, discovery: true });
  }
  let scope = "*";
  if (tier === "category") { scope = String(b.scope || ""); if (!FEED_CATEGORIES.includes(scope)) return J({ error: "scope must be one of " + FEED_CATEGORIES.join(", ") + ". Nothing was charged.", code: "bad_scope" }, 400); }
  if (tier === "endpoint") {
    scope = String(b.scope || "");
    if (!HKEY_RE.test(scope)) return J({ error: "scope must be an hkey (h:<64 hex>) from /v1/feed. Nothing was charged.", code: "bad_scope" }, 400);
    if (!(await db.prepare("SELECT 1 AS x FROM feed_endpoints WHERE hkey = ?").bind(scope).first())) return J({ error: "no such endpoint in the feed. Nothing was charged.", code: "not_found" }, 404);
  }
  const existing = await keyOf(req, env, now);
  if (existing && (existing.tier !== tier || existing.scope !== scope)) return J({ error: "renew with the same tier and scope as the key. Nothing was charged.", code: "scope_mismatch" }, 400);
  const c = feedCfg(env, deps, tier);
  const p = await pay(req, c, deps, ru, tier);
  if (p.none) return paymentRequired(c, deps, ru, tier, `Payment required: $${FEED_PRICES[tier].usd} USDC per ${PERIOD_DAYS} days.`, { tier, scope });
  if (p.error) return paymentRequired(c, deps, ru, tier, p.error, { tier, scope });
  if (p.replayed) return J({ replayed: true, note: "this payment was already applied; nothing was charged again. The key was shown once." }, 200, p.headers);
  if (existing) {
    const from = Math.max(new Date(now).getTime(), new Date(existing.paid_until).getTime());
    const pu = iso(from + PERIOD_DAYS * DAY);
    await db.prepare("UPDATE feed_keys SET paid_until = ?, periods = periods + 1 WHERE key_hash = ?").bind(pu, existing.key_hash).run();
    return J({ tier, scope, paid_until: pu, renewed: true }, 200, p.headers);
  }
  const k = "fk_" + randHex(24);
  const pu = iso(new Date(now).getTime() + PERIOD_DAYS * DAY);
  await db.prepare("INSERT INTO feed_keys (key_hash, tier, scope, created_at, paid_until, periods) VALUES (?, ?, ?, ?, ?, 1)").bind(await sha256Hex(pepper(env) + ":" + k), tier, scope, iso(now), pu).run();
  return J({ feed_key: k, key_note: "shown once; send as Authorization: Bearer <feed_key>. Renew: POST /v1/feed/subscribe with the same body and the key.", tier, scope, paid_until: pu, network: c.network }, 201, p.headers);
}
