import { lastCheckedText } from "./daily.js";
import { observationSpan } from "./history.js"; // 0.66.2: days_observed / first_seen / last_checked, one definition
// 0.32.0: /badge/<host>.svg (optionally ?path=/exact/path). Shows only the real current status from the latest stored
// live receipt for that host: "pay · stable N days" when the latest verdict is pay and under BADGE_FRESH_H old;
// otherwise a neutral "stale" (pay but old) or "not verified" (skip, recheck, none, or the store is down).
// Never fetches the host (no SSRF surface), never writes (one indexed D1 read), short cache.
export const BADGE_FRESH_H = 72;
const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
export function validBadgeHost(h) {
  const s = String(h || "").toLowerCase();
  if (!HOST_RE.test(s)) return null;
  if (/^[0-9.]+$/.test(s) || /\.(local|localhost|internal|lan|home|arpa)$/.test(s) || s === "localhost") return null; // no IPs / local names
  if (!/[a-z]/.test(s.split(".").pop())) return null;
  return s;
}
export function validBadgePath(p) {
  if (p == null || p === "") return "";
  const s = String(p);
  return /^\/[A-Za-z0-9._~\-\/%:@!$&'()*+,;=]{0,500}$/.test(s) && !/[?#]/.test(s) ? s : null;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// row: { id, created_at, verdict, body } (raw stored receipt). Returns { state, text, color, receipt_id }.
export function badgeState(row, now = new Date()) {
  if (!row) return { state: "none", text: "not verified", color: "#9f9f9f", receipt_id: null };
  let b = {};
  try { b = JSON.parse(row.body || "{}"); } catch (_) { b = {}; }
  const verdict = row.verdict || b.verdict;
  const ageH = (now.getTime() - Date.parse(row.created_at || b.checked_at || "")) / 3600000;
  const id = row.id || b.id || null;
  if (verdict !== "pay") return { state: "not-pay", text: "not verified", color: "#9f9f9f", receipt_id: id };
  if (!(ageH >= 0 && ageH < BADGE_FRESH_H)) return { state: "stale", text: "stale", color: "#9f9f9f", receipt_id: id };
  const n = b.history && Number.isFinite(b.history.stable_for_days) ? b.history.stable_for_days : 0;
  return { state: "pay", text: n >= 1 ? `pay · stable ${n} day${n === 1 ? "" : "s"}` : "pay · stable <1 day", color: "#2e7d32", receipt_id: id };
}
export function badgeSvg(label, text, color) {
  const w = (s) => Math.round(String(s).length * 6.6 + 12);
  const lw = w(label), rw = w(text), W = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="20" role="img" aria-label="${esc(label)}: ${esc(text)}"><title>${esc(label)}: ${esc(text)}</title><rect width="${lw}" height="20" fill="#333"/><rect x="${lw}" width="${rw}" height="20" fill="${esc(color)}"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + rw / 2}" y="14">${esc(text)}</text></g></svg>`;
}
export function badgeSnippets(origin, host, path = "") {
  const h = validBadgeHost(host);
  if (!h) return null;
  const p = validBadgePath(path);
  const q = p ? "?path=" + encodeURIComponent(p) : "";
  const svg = `${origin}/badge/${h}.svg${q}`;
  const link = `${origin}/badge/${h}${q}`;
  return { svg, link, markdown: `[![402xAgent status](${svg})](${link})`, html: `<a href="${esc(link)}"><img src="${esc(svg)}" alt="402xAgent status"></a>` };
}

// Latest receipt for the host (both schemes), or for the exact host+path. Request-sourced checks (the caller supplied
// the expected price/wallet/network) do not count: a badge reflects the listing, not what someone asked us to compare.
export async function latestForBadge(db, host, path) {
  const ranges = path ? [["https://" + host + path], ["http://" + host + path]] : [["https://" + host + "/", "https://" + host + "0"], ["http://" + host + "/", "http://" + host + "0"]];
  const where = path ? "(url = ? OR url = ?)" : "((url >= ? AND url < ?) OR (url >= ? AND url < ?))";
  const r = await db.prepare(`SELECT id, url, created_at, verdict, body FROM spot_receipts WHERE ${where} ORDER BY created_at DESC LIMIT 25`).bind(...ranges.flat()).all();
  const rows = (r && r.results) || [];
  const seen = new Set(), out = [];
  for (const row of rows) {
    let b = {};
    try { b = JSON.parse(row.body || "{}"); } catch (_) {}
    if (b.expected && b.expected.source === "request") continue;
    if (seen.has(row.url)) continue;
    seen.add(row.url);
    out.push(row);
  }
  return out; // latest receipt per URL, newest first
}
// Host badge: pay only if the newest receipt is pay AND no other endpoint on the host has a fresher-than-72h non-pay.
export function pickBadgeRow(rows, now = new Date()) {
  if (!rows || !rows.length) return null;
  const fresh = (x) => (now.getTime() - Date.parse(x.created_at)) / 3600000 < BADGE_FRESH_H;
  const bad = rows.find((x) => x.verdict !== "pay" && fresh(x));
  return bad || rows[0];
}

export async function handleBadge(req, env, url, origin, now = new Date()) {
  const m = url.pathname.match(/^\/badge\/([^/]{1,260}?)(\.svg)?$/);
  const host = m ? validBadgeHost(decodeURIComponent(m[1])) : null;
  const path = validBadgePath(url.searchParams.get("path"));
  const hdr = (ct, maxAge) => ({ "content-type": ct, "cache-control": `public, max-age=${maxAge}`, "access-control-allow-origin": "*", "x-content-type-options": "nosniff" });
  if (!host || path === null) {
    return new Response(badgeSvg("402xAgent", "invalid host", "#9f9f9f"), { status: 400, headers: hdr("image/svg+xml; charset=utf-8", 300) });
  }
  let row = null, ok = true;
  try { row = env.RECEIPTS_DB ? pickBadgeRow(await latestForBadge(env.RECEIPTS_DB, host, path), now) : null; } catch (_) { ok = false; }
  const st = badgeState(row, now);
  const receipt = st.receipt_id ? origin + "/v1/receipts/" + st.receipt_id : origin + "/v1/receipts/by-url?url=" + encodeURIComponent("https://" + host + (path || "/"));
  if (!m[2]) {
    // /badge/<host> (the snippet's link): a small page with the badge, its current status, the receipt (redacted public
    // view) and the embed snippets. 200 so link checkers and directories can follow it.
    const sn = badgeSnippets(origin, host, path);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>402xAgent status: ${esc(host + (path || ""))}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px}pre{background:#f5f5f5;padding:8px;white-space:pre-wrap;word-break:break-all}</style></head><body><h1>402xAgent status</h1><p><code>${esc(host + (path || ""))}</code></p><p><img src="${esc(sn.svg)}" alt="402xAgent status"></p><p>Current: <b>${esc(st.text)}</b>. ${st.receipt_id ? `Receipt: <a href="${esc(receipt)}">${esc(receipt)}</a>` : `No check yet: <a href="${esc(receipt)}">receipts for this URL</a>`}.</p><p class="last-checked">${esc(lastCheckedText(row && row.created_at))}</p><p>Green only when the latest live verdict is pay and under ${BADGE_FRESH_H} h old; otherwise grey. <a href="/rules">Rules</a>.</p><h2>Embed</h2><p>Markdown</p><pre>${esc(sn.markdown)}</pre><p>HTML</p><pre>${esc(sn.html)}</pre></body></html>`;
    return new Response(html, { status: 200, headers: hdr("text/html; charset=utf-8", ok ? 300 : 60) });
  }
  return new Response(badgeSvg("402xAgent", st.text, st.color), { status: 200, headers: { ...hdr("image/svg+xml; charset=utf-8", ok ? 300 : 60), "x-402xagent-badge": st.state, ...(row && row.created_at ? { "x-402xagent-last-checked": String(row.created_at) } : {}), link: `<${receipt}>; rel="describedby"` } });
}

// 0.67.0: GET /v1/badge/{seller}.svg and .json. Stats from stored live-check receipts (spot_receipts), not a logo and
// not the weekly crawl list (those receipts are unsigned and are not counted here). Extends the 0.32.0 badge helpers
// (host checks, escaping, SVG). Dry runs and caller-supplied expectations are excluded: they are not a listing verdict.
// Unknown sellers render "not yet observed". Nothing in this path is a pass stamp.
export const SELLER_BADGE_MAX = 500;
export const SELLER_BADGE_CACHE_S = 300;
const OBSERVED_COLOR = "#374151";
const NEUTRAL_COLOR = "#9f9f9f";

/** SELLER_BADGE=off hides the route from llms.txt and OpenAPI (machine snapshots). The route itself still answers. */
export function sellerBadgeOn(env) {
  const v = String((env && env.SELLER_BADGE) ?? "on").toLowerCase();
  return v !== "off" && v !== "0";
}

/** /v1/badge/<host>.svg, /v1/badge/<host>/<path>.svg, or one percent-encoded https URL. kind is svg|json. */
export function parseSellerBadgeTarget(pathname) {
  const m = String(pathname || "").match(/^\/v1\/badge\/(.+)\.(svg|json)$/i);
  if (!m) return null;
  const kind = m[2].toLowerCase();
  let rest;
  try { rest = decodeURIComponent(m[1]); } catch (_) { return { error: "invalid", kind }; }
  if (!rest || rest.length > 600 || /[\s?#\\]/.test(rest)) return { error: "invalid", kind };
  let host, path;
  if (/^https?:\/\//i.test(rest)) {
    let u;
    try { u = new URL(rest); } catch (_) { return { error: "invalid", kind }; }
    if (u.username || u.password || u.search || u.hash || u.port) return { error: "invalid", kind };
    if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "invalid", kind };
    host = validBadgeHost(u.hostname);
    path = validBadgePath(u.pathname === "/" ? "" : u.pathname);
  } else {
    const i = rest.indexOf("/");
    host = validBadgeHost(i === -1 ? rest : rest.slice(0, i));
    path = validBadgePath(i === -1 ? "" : rest.slice(i));
  }
  if (!host || path === null) return { error: "invalid", kind };
  return { kind, host, path };
}

function excludedFromSellerBadge(row) {
  if (!row || row.check_type === "dry-run") return true;
  try {
    const b = JSON.parse(row.body || "{}");
    if (b && b.expected && b.expected.source === "request") return true;
    if (b && (b.check_type === "dry-run" || b.dry_run === true)) return true;
  } catch (_) {}
  return false;
}

/** rows: newest-or-any order. Returns the public stats object (no URLs of other sellers). */
export function sellerBadgeFromRows(rows) {
  const list = (rows || []).filter((r) => !excludedFromSellerBadge(r));
  const span = observationSpan(list.map((r) => r.created_at));
  if (!list.length) {
    return { observed: false, checks_observed: 0, pay_count: 0, pay_rate: null, last_verdict: null, ...span, receipt_id: null, latest_url: null, endpoints_observed: 0, capped: false };
  }
  list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const pays = list.filter((r) => r.verdict === "pay").length;
  const last = list[0];
  const urls = new Set(list.map((r) => r.url).filter(Boolean));
  return {
    observed: true,
    checks_observed: list.length,
    pay_count: pays,
    pay_rate: Math.round((pays / list.length) * 1000) / 1000,
    last_verdict: typeof last.verdict === "string" ? last.verdict : null,
    ...span,
    receipt_id: last.id || null,
    latest_url: last.url || null,
    endpoints_observed: urls.size,
    capped: list.length >= SELLER_BADGE_MAX,
  };
}

export function sellerBadgeText(stats) {
  if (!stats || !stats.observed) return "not yet observed";
  const n = stats.checks_observed;
  const pct = Math.round((stats.pay_count / n) * 100);
  const day = String(stats.last_checked || "").slice(0, 10);
  const verdict = stats.last_verdict || "none";
  return `${n}${stats.capped ? "+" : ""} check${n === 1 ? "" : "s"} · ${pct}% pay · last ${verdict} · ${stats.days_observed}d · ${day}`;
}

export function sellerReceiptsUrl(origin, host, path, stats) {
  if (path) return origin + "/v1/receipts/by-url?url=" + encodeURIComponent("https://" + host + path);
  if (stats && stats.latest_url) return origin + "/v1/receipts/by-url?url=" + encodeURIComponent(stats.latest_url);
  return origin + "/v1/receipts";
}

/** Host plus each path segment, encodeURIComponent, slashes kept. */
export function sellerBadgeResource(origin, host, path, ext) {
  const segs = String(path || "").split("/").map((seg, i) => (i === 0 ? "" : encodeURIComponent(seg))).join("/");
  return origin + "/v1/badge/" + encodeURIComponent(host) + segs + "." + ext;
}

export function sellerBadgeEmbed(origin, host, path, stats) {
  const svg = sellerBadgeResource(origin, host, path, "svg");
  const json = sellerBadgeResource(origin, host, path, "json");
  const receipts = sellerReceiptsUrl(origin, host, path, stats);
  return {
    svg,
    json,
    receipts,
    markdown: `[![402xAgent receipts](${svg})](${receipts})`,
    html: `<a href="${esc(receipts)}"><img src="${esc(svg)}" alt="402xAgent receipts"></a>`,
  };
}

function linkedSvg(text, color, href) {
  const svg = badgeSvg("402xAgent", text, color);
  if (!href) return svg;
  const i = svg.indexOf(">") + 1;
  return svg.slice(0, i) + `<a href="${esc(href)}">` + svg.slice(i, -"</svg>".length) + "</a></svg>";
}

export async function receiptsForSellerBadge(db, host, path) {
  const ranges = path
    ? [ "https://" + host + path, "http://" + host + path ]
    : [ "https://" + host + "/", "https://" + host + "0", "http://" + host + "/", "http://" + host + "0" ];
  const where = path ? "(url = ? OR url = ?)" : "((url >= ? AND url < ?) OR (url >= ? AND url < ?))";
  const sql = `SELECT id, url, created_at, verdict, check_type, body FROM spot_receipts /* seller-badge */ WHERE ${where} AND COALESCE(check_type, 'live') != 'dry-run' AND COALESCE(json_extract(body, '$.expected.source'), '') != 'request' ORDER BY created_at DESC LIMIT ${SELLER_BADGE_MAX}`;
  const r = await db.prepare(sql).bind(...ranges).all();
  return (r && r.results) || [];
}

function sellerJson(origin, host, path, stats, extra) {
  const embed = sellerBadgeEmbed(origin, host, path, stats);
  const base = {
    seller: host,
    endpoint: path ? "https://" + host + path : null,
    scope: path ? "endpoint" : "host",
    observed: stats.observed,
    checks_observed: stats.checks_observed,
    pay_count: stats.pay_count,
    pay_rate: stats.pay_rate,
    endpoints_observed: stats.endpoints_observed,
    last_verdict: stats.last_verdict,
    days_observed: stats.days_observed,
    first_seen: stats.first_seen,
    last_checked: stats.last_checked,
    capped: stats.capped,
    receipt: stats.receipt_id ? origin + "/v1/receipts/" + stats.receipt_id : null,
    receipts: embed.receipts,
    svg: embed.svg,
    json: embed.json,
    embed: { markdown: embed.markdown, html: embed.html },
    note: stats.observed
      ? "Counts are stored live-check receipts for this seller (newest " + SELLER_BADGE_MAX + (stats.capped ? ", cap hit" : "") + "). pay_rate is the share whose verdict is pay. days_observed is the count of distinct UTC dates among those receipts, not the calendar days from first to last. first_seen is the earliest of those timestamps and last_checked is the latest (ISO UTC). Our own scheduled (cron) self-check probes count. Dry runs and caller-supplied expectations are excluded. Crawl receipts are unsigned and are not included. This is not an endorsement."
      : "No stored live-check receipt for this seller. This is not a pass.",
  };
  return extra ? { ...base, ...extra } : base;
}

export async function handleSellerBadge(req, env, url, origin) {
  const parsed = parseSellerBadgeTarget(url.pathname);
  const hdr = (ct, maxAge) => ({ "content-type": ct, "cache-control": `public, max-age=${maxAge}`, "access-control-allow-origin": "*", "x-content-type-options": "nosniff" });
  const empty = sellerBadgeFromRows([]);
  if (!parsed || parsed.error) {
    const body = parsed && parsed.kind === "json"
      ? JSON.stringify({ error: "invalid seller", observed: false, pay_rate: null, note: "Not a seller host or endpoint. This is not a pass." })
      : linkedSvg("invalid seller", NEUTRAL_COLOR, null);
    const ct = parsed && parsed.kind === "json" ? "application/json; charset=utf-8" : "image/svg+xml; charset=utf-8";
    return new Response(req.method === "HEAD" ? null : body, { status: 400, headers: { ...hdr(ct, SELLER_BADGE_CACHE_S), "x-402xagent-badge": "invalid" } });
  }
  const { kind, host, path } = parsed;
  let stats = empty, ok = true, store = "ok";
  try {
    if (!env || !env.RECEIPTS_DB) { ok = false; store = "unavailable"; }
    else stats = sellerBadgeFromRows(await receiptsForSellerBadge(env.RECEIPTS_DB, host, path));
  } catch (_) { ok = false; store = "unavailable"; stats = empty; }
  const text = sellerBadgeText(stats);
  const color = stats.observed ? OBSERVED_COLOR : NEUTRAL_COLOR;
  const embed = sellerBadgeEmbed(origin, host, path, stats);
  const maxAge = ok ? SELLER_BADGE_CACHE_S : 60;
  const state = !ok ? "unavailable" : stats.observed ? "observed" : "not-yet-observed";
  const link = { link: `<${embed.receipts}>; rel="describedby"`, "x-402xagent-badge": state, ...(stats.last_checked ? { "x-402xagent-last-checked": String(stats.last_checked) } : {}) };
  if (kind === "json") {
    const doc = sellerJson(origin, host, path, stats, store === "unavailable" ? { store: "unavailable", note: "Receipt store unavailable. No stats were invented. This is not a pass." } : null);
    return new Response(req.method === "HEAD" ? null : JSON.stringify(doc), { status: 200, headers: { ...hdr("application/json; charset=utf-8", maxAge), ...link } });
  }
  return new Response(req.method === "HEAD" ? null : linkedSvg(text, color, embed.receipts), { status: 200, headers: { ...hdr("image/svg+xml; charset=utf-8", maxAge), ...link } });
}
