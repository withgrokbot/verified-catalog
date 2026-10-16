// 0.26.0: /bazaar — our free check run on the top public CDP Bazaar search results for a few common queries.
// Lean daily refresh: a cron step (every 20 min) does nothing unless today's snapshot is unbuilt; each working step
// makes at most 3 search calls or BAZAAR_BATCH checks (~3 subrequests each), well under the free plan's 50/invocation.
// Checks run as our exempt self-test client with ref "bazaar-daily": check_type self-checked (never outside, never in
// recent_checks), and their receipts are stored with access_tier "bazaar" so they stay redacted like any free receipt.
import { publicUrl, shortReason } from "./recent.js";
import { lastCheckedText } from "./daily.js";

export const BAZAAR_SEARCH = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";
export const BAZAAR_QUERIES = ["weather forecast", "crypto token price", "web search"];
export const BAZAAR_TOP = 20;
export const BAZAAR_BATCH = 10;
export const BAZAAR_KEY = "bazaar:v1";
export const BAZAAR_REF = "bazaar-daily";
export const BAZAAR_CLIENT = "withgrokbot-selftest";
const USDC = new Set(["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v"]);

const day = (now) => now.toISOString().slice(0, 10);

// One search result -> the check we run (probe URL as listed; Base terms preferred as the expectation).
export function bazaarItem(res, query, rank) {
  const url = String((res && res.resource) || "");
  const endpoint = publicUrl(url);
  if (!endpoint) return null;
  if (/\/(:[A-Za-z_]|\{)|%7B/i.test(endpoint)) return null; // path templates (":address", "{id}") are not real URLs: a probe would be a false skip
  const info = (((res.extensions || {}).bazaar || {}).info || {}).input || {};
  const method = String(info.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const acc = (res.accepts || []).filter((a) => a && a.scheme === "exact");
  const a = acc.find((x) => x.network === "eip155:8453") || acc[0] || null;
  const it = { query, rank, url: url.split("#")[0], endpoint, method, service: String(res.serviceName || "").slice(0, 80) || null };
  if (a) {
    it.network = a.network || null;
    it.pay_to = a.payTo || null;
    if (USDC.has(String(a.asset || "").toLowerCase()) && /^\d{1,15}$/.test(String(a.amount || ""))) it.claimed_price = Number(a.amount) / 1e6;
  }
  return it;
}

export async function bazaarSearch(fetchImpl, queries = BAZAAR_QUERIES) {
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    const u = BAZAAR_SEARCH + "?" + new URLSearchParams({ query: q, limit: String(BAZAAR_TOP) });
    let j = null;
    try {
      const r = await fetchImpl(u, { headers: { accept: "application/json", "user-agent": "402xagent-bazaar/1" } });
      if (r.ok) j = await r.json();
    } catch (_) { j = null; }
    const list = (j && Array.isArray(j.resources) ? j.resources : []).slice(0, BAZAAR_TOP);
    list.forEach((res, i) => {
      const it = bazaarItem(res, q, i + 1);
      if (!it) return;
      const k = it.method + " " + it.endpoint;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(it);
    });
  }
  return out;
}

export function checkUrl(origin, it) {
  const qp = new URLSearchParams({ url: it.url, client: BAZAAR_CLIENT, ref: BAZAAR_REF });
  if (it.method !== "GET") qp.set("method", it.method);
  for (const k of ["pay_to", "network"]) if (it[k]) qp.set(k, it[k]);
  if (it.claimed_price != null) qp.set("claimed_price", String(it.claimed_price));
  return origin + "/v1/products/endpoint-spot-check?" + qp.toString();
}

function toRow(it, body, status) {
  const verdict = body && ["pay", "skip", "recheck"].includes(body.verdict) ? body.verdict : "recheck";
  const reason = body && body.reason ? String(body.reason) : status === 200 ? "unknown" : "check_failed";
  return { query: it.query, rank: it.rank, service: it.service, endpoint: it.endpoint, method: it.method, verdict, reason, reason_text: shortReason(reason), receipt_url: (body && body.receipt_url) || null };
}

export function bazaarCounts(rows) {
  const c = { pay: 0, skip: 0, recheck: 0 };
  for (const r of rows) c[r.verdict] = (c[r.verdict] || 0) + 1;
  return c;
}

// One cron step. runCheck(urlString) -> Response from our own check handler (no network hop).
// 0.28.1: once today's snapshot is live, an isolate remembers it and skips the 20-min KV read until the UTC day changes.
let idleDay = null;
export function _resetBazaarIdle() { idleDay = null; }
// KV writes can fail when the daily free-plan write quota is spent; the cron then just tries again next step (fail open).
async function kvPut(kv, key, val) {
  try { await kv.put(key, val); return true; } catch (_) { return false; }
}
export async function bazaarStep(env, { now = new Date(), fetchImpl = fetch, runCheck, origin }) {
  const kv = env.CRAWL_KV;
  if (!kv) return { did: "no-kv" };
  if (idleDay === day(now)) return { did: "idle" };
  let st = null;
  try { st = await kv.get(BAZAAR_KEY, "json"); } catch (_) { st = null; }
  st = st || { live: null, build: null };
  const today = day(now);
  if (!st.build && st.live && st.live.day === today) { idleDay = today; return { did: "idle" }; }
  if (!st.build || st.build.day !== today) {
    const items = await bazaarSearch(fetchImpl);
    if (!items.length) return { did: "search-empty" }; // keep yesterday's page; retry next step
    st.build = { day: today, started_at: now.toISOString(), pending: items, rows: [] };
    if (!(await kvPut(kv, BAZAAR_KEY, JSON.stringify(st)))) return { did: "kv-write-failed" };
    return { did: "searched", n: items.length };
  }
  const batch = st.build.pending.splice(0, BAZAAR_BATCH);
  for (const it of batch) {
    let body = null, status = 0;
    try {
      const r = await runCheck(checkUrl(origin, it), it.method);
      status = r.status;
      body = await r.json();
    } catch (_) { body = null; }
    st.build.rows.push(toRow(it, body, status));
  }
  if (!st.build.pending.length) {
    const rows = st.build.rows.sort((a, b) => BAZAAR_QUERIES.indexOf(a.query) - BAZAAR_QUERIES.indexOf(b.query) || a.rank - b.rank);
    st.live = { day: today, generated_at: now.toISOString(), queries: BAZAAR_QUERIES, counts: bazaarCounts(rows), rows };
    st.build = null;
  }
  if (!(await kvPut(kv, BAZAAR_KEY, JSON.stringify(st)))) return { did: "kv-write-failed" };
  return { did: "checked", n: batch.length, done: !st.build };
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function bazaarJson(live, origin) {
  const base = {
    service: "402xAgent Bazaar check",
    about: "Our free check run daily on the top public CDP Bazaar search results for a few common queries. Endpoints are shown without query strings; receipts are the public (redacted) view. These are our own checks, not outside calls.",
    source: BAZAAR_SEARCH,
    page: origin + "/bazaar",
  };
  if (!live) return { ...base, generated_at: null, last_checked: null, queries: BAZAAR_QUERIES, counts: { pay: 0, skip: 0, recheck: 0 }, rows: [], note: "first daily refresh pending" };
  return { ...base, generated_at: live.generated_at, last_checked: live.generated_at || null, queries: live.queries, counts: live.counts, rows: live.rows.map(({ query, rank, service, endpoint, method, verdict, reason, reason_text, receipt_url }) => ({ query, rank, service, endpoint, method, verdict, reason, reason_text, receipt_url })) };
}

export function bazaarHtml(j) {
  const groups = j.queries.map((q) => {
    const rows = j.rows.filter((r) => r.query === q);
    const trs = rows.map((r) => `<tr><td>${r.rank}</td><td><code>${esc(r.method)} ${esc(r.endpoint)}</code>${r.service ? `<br><small>${esc(r.service)}</small>` : ""}</td><td class="v ${esc(r.verdict)}">${esc(r.verdict)}</td><td>${esc(r.reason_text)}</td><td>${r.receipt_url ? `<a href="${esc(r.receipt_url)}">receipt</a>` : ""}</td></tr>`).join("");
    return `<h2>“${esc(q)}”</h2><table><thead><tr><th>#</th><th>Endpoint</th><th>Verdict</th><th>Why</th><th></th></tr></thead><tbody>${trs || '<tr><td colspan="5">no results</td></tr>'}</tbody></table>`;
  }).join("");
  const c = j.counts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bazaar check · 402xAgent</title><link rel="alternate" type="application/json" href="/bazaar.json"><style>body{font:15px/1.5 system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%;margin-bottom:1.5rem}td,th{border-bottom:1px solid #ddd;padding:.4rem;text-align:left;vertical-align:top}code{font-size:13px;word-break:break-all}.v{font-weight:600}.pay{color:#08710f}.skip{color:#b00020}.recheck{color:#8a5a00}small{color:#555}</style></head><body><p><a href="/">402xAgent</a></p><h1>Bazaar check</h1><p>Each day we run our free check on the top public <a href="https://docs.cdp.coinbase.com/x402/bazaar">CDP Bazaar</a> results for ${j.queries.length} common searches: does the live 402 still match what Bazaar lists? <b>pay</b> = terms match, <b>skip</b> = something is off, <b>recheck</b> = we could not get a clean 402 right now.</p><p>${j.generated_at ? `Checked ${esc(j.generated_at)} · pay ${c.pay} · skip ${c.skip} · recheck ${c.recheck}` : "First daily refresh pending."} · <a href="/bazaar.json">JSON</a></p><p class="last-checked">${esc(lastCheckedText(j.last_checked))}</p>${groups}<p><small>Endpoints shown without query strings. Receipts are the public view. Want the full terms for one? A paid check ($0.02) re-fetches the live 402 for you: <a href="/v1/products/endpoint-spot-check">endpoint-spot-check</a>.</small></p></body></html>`;
}

export async function handleBazaar(req, url, env, path, origin) {
  let live = null;
  try { const st = env.CRAWL_KV ? await env.CRAWL_KV.get(BAZAAR_KEY, "json") : null; live = st && st.live; } catch (_) { live = null; }
  const j = bazaarJson(live, origin);
  const wantsHtml = path === "/bazaar" && /text\/html/.test(req.headers.get("accept") || "");
  const h = { "cache-control": "public, max-age=300", vary: "accept", "access-control-allow-origin": "*" };
  if (wantsHtml) return new Response(bazaarHtml(j), { headers: { ...h, "content-type": "text/html; charset=utf-8" } });
  return new Response(JSON.stringify(j, null, 2), { headers: { ...h, "content-type": "application/json; charset=utf-8" } });
}
