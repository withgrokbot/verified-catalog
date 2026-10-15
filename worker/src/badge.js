import { lastCheckedText } from "./daily.js";
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
