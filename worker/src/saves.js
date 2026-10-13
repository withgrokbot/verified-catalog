// 0.35.0 /saves and /saves.json, behind SAVES_PAGE (default off: 404). Real skips where a live 402 differed from the
// listing: price above the listing (>1%), a different pay_to ("pays a different wallet", wallets never printed), or a
// different network. Crawl rows come from saves-data.js (build_saves.py); live rows from D1 receipts of the last 30 days.
// Excludes path templates, our own hosts and our own test checks. Endpoints are shown without query strings.
import { SAVES, SAVES_META } from "./saves-data.js";
const MAX_AGE_D = 30, TOL = 0.01;
const OWN = /(^|\.)(402xagent\.com|payscout\.dev|withgrokbot\.workers\.dev|target\.test)$/i;
const TEMPLATE = /(\{[^}/]*\}|\/:[A-Za-z_]|\[[^\]/]*\]|%7B|%7D)/i;
const LIVE_REASONS = ["price_mismatch", "pay_to_mismatch", "network_mismatch"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (x) => "$" + Number(x).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

export function savesEnabled(env) { return String((env && env.SAVES_PAGE) || "off").toLowerCase() === "on"; }
export function endpointOf(u) {
  const m = /^(https?):\/\/([^/?#]+)([^?#]*)/.exec(String(u || ""));
  return m ? m[1] + "://" + m[2].toLowerCase() + (m[3] || "/") : null;
}
const usdOf = (a) => (a && /^[0-9]{1,30}$/.test(String(a.amount_atomic ?? "")) ? Number(a.amount_atomic) / 1e6 : null);

// One stored live receipt body -> save row, or null.
export function liveSave(b, now = new Date()) {
  if (!b || b.verdict !== "skip" || !LIVE_REASONS.includes(b.reason)) return null;
  if (b.caller === "self-test" || b.access_tier === "exempt" || b.check_type === "self-checked" && b.access_tier !== "bazaar" && b.access_tier !== "auto") return null;
  if (b.expected && b.expected.source === "request") return null; // compared with what a caller typed, not with a listing
  const u = endpointOf(b.url);
  if (!u || TEMPLATE.test(u) || OWN.test(u.split("/")[2].split(":")[0])) return null;
  const t = Date.parse(b.checked_at || "");
  if (!(t > 0) || (now.getTime() - t) / 86400000 > MAX_AGE_D) return null;
  const exp = b.expected || {};
  const acc = (b.live_402 && b.live_402.accepts) || [];
  let what = null, kind = null;
  if (b.reason === "price_mismatch") {
    const live = acc.map(usdOf).filter((x) => x != null);
    const q = live.length ? Math.min(...live) : null, a = Number(exp.claimed_price_usd);
    if (!(q != null && a > 0 && q > a * (1 + TOL) + 1e-9)) return null;
    kind = "price_higher"; what = `asked ${money(q)}, listed ${money(a)}`;
  } else if (b.reason === "pay_to_mismatch") {
    kind = "pay_to_changed"; what = "pays a different wallet";
  } else {
    const nets = [...new Set(acc.map((x) => x && x.network).filter(Boolean))].join(", ");
    kind = "network_changed"; what = exp.network && nets ? `asks for payment on ${nets}, listed ${exp.network}` : "asks for payment on a different network";
  }
  return { endpoint: u, kind, what, date: String(b.checked_at).slice(0, 10), source: "live", receipt_id: b.id };
}

export async function liveSaves(db, now = new Date()) {
  if (!db) return [];
  const since = new Date(now.getTime() - MAX_AGE_D * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const r = await db.prepare("SELECT body FROM spot_receipts WHERE verdict = 'skip' AND reason IN ('price_mismatch', 'pay_to_mismatch', 'network_mismatch') AND created_at >= ? ORDER BY created_at DESC LIMIT 500").bind(since).all();
  const out = [];
  for (const row of (r && r.results) || []) {
    try { const s = liveSave(JSON.parse(row.body), now); if (s) out.push(s); } catch (_) {}
  }
  return out;
}

export async function savesJson(env, origin, now = new Date()) {
  let live = [];
  try { live = await liveSaves(env.RECEIPTS_DB, now); } catch (_) { live = []; }
  const cutoff = new Date(now.getTime() - MAX_AGE_D * 86400000).toISOString().slice(0, 10);
  const seen = new Set(), rows = [];
  for (const s of [...live, ...SAVES]) {
    if (s.date < cutoff || seen.has(s.endpoint)) continue; // newest per endpoint (live first)
    seen.add(s.endpoint);
    // live sc- receipts from outside checks are redacted already; crawl receipts get ?view=redacted (no wallets)
    rows.push({ ...s, receipt: s.receipt_id ? origin + "/v1/receipts/" + s.receipt_id + (s.source === "crawl" ? "?view=redacted" : "") : null });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const counts = { price_higher: 0, pay_to_changed: 0, network_changed: 0 };
  for (const r of rows) counts[r.kind]++;
  return {
    title: "402xAgent saves: payments an agent would have made to terms that differ from the listing",
    window_days: MAX_AGE_D,
    crawl_built_at: SAVES_META.built_at || null,
    crawl_total_before_cap: SAVES_META.total ?? null,
    crawl_counts_before_cap: SAVES_META.counts || null,
    count: rows.length,
    counts,
    rules: origin + "/rules.json",
    note: "Endpoints are shown without query strings; wallets are never printed. Each row links its receipt (redacted public view).",
    saves: rows,
  };
}

export async function handleSaves(req, env, url, origin) {
  if (!savesEnabled(env)) return null; // off: the caller falls through to 404
  const j = await savesJson(env, origin);
  const hdr = { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" };
  if (url.pathname === "/saves.json" || url.searchParams.get("format") === "json") return new Response(JSON.stringify(j, null, 2), { headers: { ...hdr, "content-type": "application/json; charset=utf-8" } });
  const tr = j.saves.slice(0, 500).map((s) => `<tr><td><code>${esc(s.endpoint)}</code></td><td>${esc(s.what)}</td><td>${esc(s.date)}</td><td>${s.receipt ? `<a href="${esc(s.receipt)}">receipt</a>` : ""}</td></tr>`).join("");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>402xAgent saves</title><link rel="alternate" type="application/json" href="/saves.json"><style>body{font:15px/1.5 system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:5px 8px;text-align:left;vertical-align:top}code{word-break:break-all}</style></head><body><h1>Saves</h1><p>${esc(j.count)} endpoints in the last ${esc(j.window_days)} days where the live payment request differed from the listing: ${esc(j.counts.price_higher)} asked more than listed, ${esc(j.counts.pay_to_changed)} pay a different wallet, ${esc(j.counts.network_changed)} ask for another network. JSON: <a href="/saves.json">/saves.json</a>. Rules: <a href="/rules">/rules</a>.</p><table><tr><th>endpoint</th><th>what differed</th><th>date</th><th></th></tr>${tr}</table></body></html>`, { headers: { ...hdr, "content-type": "text/html; charset=utf-8" } });
}
