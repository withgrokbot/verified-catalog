// Public self-checked receipts: /v1/skips (HTML; ?format=json or /v1/skips.json for JSON), /v1/receipts, /v1/receipts/<id>.
import { RECEIPTS, RECEIPTS_META } from "./receipts-data.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (v) => (v === null || v === undefined ? "—" : "$" + Number(v).toString());
const hdrs = (type) => ({ "content-type": type, "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
const j = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: hdrs("application/json; charset=utf-8") });

// Same field name and example as the Spot-Check 400 message (lib.js spotBadRequest).
export function spotHowTo(origin) {
  return `Check before you pay: GET ${origin}/v1/products/endpoint-spot-check?url=https://example.com/api/paid (optional &claimed_price=0.01; or POST JSON {"url":"https://example.com/api/paid"}) returns verdict pay|skip|recheck. 1 free/day, then $0.01-$0.25 USDC via x402 on Base (one tenth of the target's quoted price). Never pays the target.`;
}

export function skipsSummary(origin) {
  const m = RECEIPTS_META;
  return {
    total_receipts: m.total, skip: m.skip, pay: m.pay, recheck: m.recheck, crawled_at: m.crawled_at, check_type: m.check_type,
    lists: m.lists, method: m.method, spot_check: spotHowTo(origin),
    featured_mismatch: origin + "/v1/receipts/" + m.featured_id,
    receipts: origin + "/v1/receipts", skips_html: origin + "/v1/skips", skips_json: origin + "/v1/skips.json",
  };
}

export function handleSkips(req, url) {
  const origin = url.origin;
  const skips = RECEIPTS.filter((r) => r.verdict === "skip");
  const path = url.pathname.replace(/\/+$/, "");
  const accept = req.headers.get("accept") || "";
  if (path === "/v1/skips.json" || url.searchParams.get("format") === "json" || (accept.includes("application/json") && !accept.includes("text/html")))
    return j({ ...skipsSummary(origin), skips: skips.map((r) => ({ ...r, permalink: origin + "/v1/skips#" + r.id })) });
  const m = RECEIPTS_META;
  const rows = skips
    .map((r) => {
      const f = r.id === m.featured_id;
      return `<tr id="${esc(r.id)}"${f ? ' class="featured"' : ""}><td><a href="#${esc(r.id)}">${esc(r.id)}</a>${f ? " ★" : ""}</td><td class="u">${esc(r.method)} ${esc(r.url)}</td><td>${esc(usd(r.claimed_price_usd))}${r.listed_network ? "<br><small>" + esc(r.listed_network) + "</small>" : ""}</td><td>${esc(usd(r.quoted_price_usd))}${r.network ? "<br><small>" + esc(r.network) + "</small>" : ""}</td><td class="u">${esc(r.pay_to || "—")}</td><td>${esc(r.reason)}</td><td>${esc(r.source_list)}</td><td>${esc(r.timestamp)}</td></tr>`;
    })
    .join("\n");
  const fr = RECEIPTS.find((r) => r.id === m.featured_id);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>x402 skips: self-checked receipts</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:1.5rem;max-width:1200px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:4px 6px;vertical-align:top;text-align:left}.u{word-break:break-all;font-family:ui-monospace,monospace;font-size:12px}tr:target,.featured{background:#fff6d5}header p{margin:.3rem 0}code{background:#f3f3f3;padding:1px 4px}</style></head><body>
<header><h1>x402 skips: self-checked receipts</h1>
<p><b>${m.total}</b> receipts · <b>${m.skip}</b> skip · ${m.pay} pay · ${m.recheck} recheck · crawled ${esc(m.crawled_at)} (UTC) · lists: ${esc(Object.entries(m.lists).map(([k, v]) => k + " " + v).join(", "))}</p>
<p>${esc(spotHowTo(origin))}</p>
<p><small>Self-checked: ${esc(m.method)} Skip = price mismatch, wrong asset/network, payTo differs from the listing, or a missing/malformed 402. JSON: <a href="/v1/skips.json">/v1/skips.json</a> · all receipts: <a href="/v1/receipts">/v1/receipts</a>. Facts only, not endorsements.</small></p>
${fr ? `<p>★ Featured mismatch <a href="#${esc(fr.id)}">#${esc(fr.id)}</a> (<a href="/v1/receipts/${esc(fr.id)}">permalink</a>): listed ${esc(usd(fr.claimed_price_usd))} on ${esc(fr.listed_network)}, 402 asks ${esc(usd(fr.quoted_price_usd))} on ${esc(fr.network)} → skip.</p>` : ""}
</header>
<table><thead><tr><th>id</th><th>endpoint</th><th>claimed (listing)</th><th>402 price</th><th>402 payTo</th><th>reason</th><th>list</th><th>checked (UTC)</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>`;
  return new Response(html, { status: 200, headers: hdrs("text/html; charset=utf-8") });
}

export function handleReceipts(url) {
  const path = url.pathname.replace(/\/+$/, "");
  const id = path.slice("/v1/receipts".length).replace(/^\//, "");
  if (!id) return j({ ...skipsSummary(url.origin), receipts: RECEIPTS });
  const r = RECEIPTS.find((x) => x.id === id);
  if (!r) return j({ error: "receipt not found", receipts: url.origin + "/v1/receipts" }, 404);
  return j({ ...r, permalink: url.origin + "/v1/receipts/" + r.id, on_page: url.origin + "/v1/skips#" + r.id, spot_check: spotHowTo(url.origin) });
}
