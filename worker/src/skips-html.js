// 0.58.7: the human /v1/skips page (browsers only: Accept names text/html and no ?format=json; /v1/skips.json is always JSON).
// Same chrome as /pricing, /docs and the receipt pages (chrome.js: homepage CSS, header, nav, footer). No script at all, so the
// strict CSP (script-src 'self' + Cloudflare Web Analytics only) needs no hash; the method text is a native <details>.
// Wording reused, not new: the title and caption are the homepage's Latest skips tab (home.js), the crawl date line is
// homeCrawlDates (home.js, 0.58.2), each row's reason is crawlReasonText (receipts-html.js: the homepage's plainReason
// mapping, else the crawl reason without its parenthetical detail or any wallet). The "what skip / recheck mean" lines
// reuse the homepage's verdict wording. The dense method block is the pre-0.58.7 page's text, unchanged, inside <details>.
// Shown per row: endpoint (method, host, path), reason, listed and live price + network, the seller's own payTo (public
// listing / 402 data, shortened), lists, check time, receipt link. Never rendered: any buyer data (caller, buyer wallets,
// client IPs, payment proofs, tx hashes); recent_checks stays in the JSON only.
import { chromePage, esc } from "./chrome.js";
import { homeCrawlDates } from "./home.js";
import { crawlReasonText } from "./receipts-html.js";

export const SKIPS_TITLE = "Latest skips";
export const SKIPS_CAPTION = "Recent skips from the public crawl. A mismatch often just means the listing is out of date."; // = home.js Latest skips caption
export const SKIP_MEANS = "Skip means don't pay this endpoint as it stands: we saw a concrete reason not to pay. Each row says why and links its receipt.";
export const RECHECK_MEANS = "Recheck means the terms are not confirmed yet. Nothing is approved, so don't pay on it; check again later.";
export const METHOD_SUMMARY = "How the crawl works: method, counts and JSON";

const CSS = `
.sk-dates{margin:12px 0 0;font-size:14px;color:var(--text-3);font-weight:600}
.sk-means{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 16px}
.sk-mean{background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;display:flex;gap:12px;align-items:flex-start}
.sk-mean p{margin:0;font-size:14.5px;color:var(--text-2);line-height:1.5}
.sk-stats{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0 0 14px;font-size:14px;color:var(--text-3)}.sk-stats b{color:var(--forest);font-size:16px}
details.sk-method{background:#fff;border:1px solid var(--border);border-radius:var(--radius);margin:0 0 18px}
details.sk-method summary{cursor:pointer;padding:12px 16px;font-weight:600;color:var(--forest)}
details.sk-method[open] summary{border-bottom:1px solid var(--bg-subtle)}
.sk-mbody{padding:4px 16px 12px;font-size:14px;color:var(--text-2);line-height:1.55}.sk-mbody p{margin:10px 0}
.sk-mbody code,.sk-mono{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}
.sk-free{border:1px solid var(--border);background:var(--bg-page);border-radius:10px;padding:10px 12px;margin:10px 0}
.sk-box{background:#fff;border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;box-shadow:0 10px 30px rgba(60,35,5,.06)}
table.sk{width:100%;border-collapse:collapse;font-size:14px;table-layout:fixed}
table.sk th,table.sk td{padding:12px 14px;text-align:left;vertical-align:top;border-bottom:1px solid var(--bg-subtle);overflow-wrap:anywhere}
table.sk thead th{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3);background:var(--bg-page)}
table.sk col.c-ep{width:29%}table.sk col.c-re{width:21%}table.sk col.c-li{width:12%}table.sk col.c-lv{width:17%}table.sk col.c-ti{width:11%}table.sk col.c-op{width:10%}
table.sk tbody tr:last-child td{border-bottom:none}table.sk tbody tr:target{background:var(--mint)}
.sk-host{font-weight:600;color:var(--forest)}.sk-path{display:block;font-family:var(--mono);font-size:12px;color:var(--text-3)}
.sk-sub{display:block;font-size:12px;color:var(--text-3)}.sk-net{display:block;font-family:var(--mono);font-size:11.5px;color:var(--text-3)}
.sk-payto{display:block;font-family:var(--mono);font-size:11.5px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sk-reason{color:var(--text)}.sk-reason::first-letter{text-transform:uppercase}.sk-v{min-width:0}
.sk-price{font-weight:600}.sk-time{color:var(--text-2);font-size:13px}.sk-open{font-weight:600;color:var(--blue);white-space:nowrap}
.sk-empty{padding:28px 20px;color:var(--text-2)}
.sk-pager{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px 12px;margin:14px 0;font-size:14px;color:var(--text-3)}.sk-pager a{font-weight:700;color:var(--blue)}
@media(max-width:760px){
.sk-means{grid-template-columns:1fr}
.sk-box{background:transparent;border:none;box-shadow:none;overflow:visible}
table.sk,table.sk tbody,table.sk tr,table.sk td{display:block;width:100%}
table.sk thead,table.sk colgroup{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
table.sk tbody tr{background:#fff;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:10px;padding:12px 14px}
table.sk td{padding:3px 0;border:none}
table.sk td[data-label]{display:grid;grid-template-columns:82px minmax(0,1fr);gap:8px}
table.sk td[data-label]::before{content:attr(data-label);font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3);padding-top:2px}
table.sk td.sk-ep{display:block}table.sk td.sk-ep::before{display:none}
table.sk td.sk-op{padding-top:6px}
}`;

const usd = (v) => (v === null || v === undefined ? "—" : "$" + Number(v).toString()); // same as the pre-0.58.7 page
const short = (a) => { const s = String(a || ""); return s.length > 14 ? s.slice(0, 6) + "…" + s.slice(-4) : s; };
const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : n == null ? "—" : String(n));
const utc = (t) => { const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(t || "")); return m ? `${m[1]} ${m[2]} UTC` : (t ? String(t) : "—"); };
const hostPath = (u) => { try { const x = new URL(u); return { host: x.host, path: x.pathname + x.search }; } catch (_) { return { host: String(u || ""), path: "" }; } };

/** One skip row (crawl receipt from the published skip page). Only the allow-listed public fields below are read. */
export function skipRowHtml(r) {
  const hp = hostPath(r.url);
  const lists = [r.source_list, ...(Array.isArray(r.also_listed_in) ? r.also_listed_in : [])].filter(Boolean).join(", ");
  const net = (n) => (n ? `<span class="sk-net">${esc(n)}</span>` : "");
  const payTo = r.pay_to ? `<span class="sk-payto" title="payTo ${esc(r.pay_to)}">payTo ${esc(short(r.pay_to))}</span>` : "";
  return `<tr id="${esc(r.id)}"><td class="sk-ep" data-label="Endpoint"><span class="sk-host">${esc(hp.host)}</span><span class="sk-path">${esc(r.method || "GET")} ${esc(hp.path)}</span>${lists ? `<span class="sk-sub">${esc(lists)}</span>` : ""}</td>`
    + `<td data-label="Reason"><div class="sk-v sk-reason">${esc(crawlReasonText(r.reason))}</div></td>`
    + `<td data-label="Listing"><div class="sk-v"><span class="sk-price">${esc(usd(r.claimed_price_usd))}</span>${net(r.listed_network)}</div></td>`
    + `<td data-label="Live 402"><div class="sk-v"><span class="sk-price">${esc(usd(r.quoted_price_usd))}</span>${net(r.network)}${payTo}</div></td>`
    + `<td data-label="Checked"><div class="sk-v sk-time">${esc(utc(r.timestamp))}</div></td>`
    + `<td class="sk-op"><a class="sk-open" href="/v1/receipts/${esc(r.id)}">Receipt &rarr;</a></td></tr>`;
}

/** d: { meta, skips, page, pages, now, freeCheck: { url, exampleUrl, example }, spotHowTo, scheduleText } */
export function skipsHtml(origin, d, fp) {
  const m = d.meta || {};
  const page = d.page, pages = d.pages;
  const cd = homeCrawlDates(m, d.now);
  const listed = Object.entries(m.listed_in || m.lists || {}).map(([k, v]) => k + " " + num(v)).join(", ");
  const pager = pages > 1 ? `<nav class="sk-pager" aria-label="Pages"><span>${page > 1 ? `<a href="/v1/skips?page=${page - 1}" rel="prev">&larr; prev</a>` : ""}</span><span>Page ${page} of ${pages} (${esc(m.page_size)} skips per page, clearest mismatches first)</span><span>${page < pages ? `<a href="/v1/skips?page=${page + 1}" rel="next">next &rarr;</a>` : ""}</span></nav>` : "";
  const rows = (d.skips || []).map(skipRowHtml).join("\n");
  const fc = d.freeCheck || {};
  const main = `<section class="pg-hero"><h1>${esc(SKIPS_TITLE)}</h1>
<p class="pg-lead">${esc(SKIPS_CAPTION)}</p>
${cd.text ? `<p class="sk-dates" id="crawl-dates">${esc(cd.text)}</p>` : ""}</section>
<div class="pg-body">
<div class="sk-means"><div class="sk-mean"><span class="verdict skip"><i></i>skip</span><p>${esc(SKIP_MEANS)}</p></div><div class="sk-mean"><span class="verdict recheck"><i></i>recheck</span><p>${esc(RECHECK_MEANS)}</p></div></div>
<p class="sk-stats"><span><b>${esc(num(m.endpoints_covered ?? m.total))}</b> endpoints covered</span><span><b>${esc(num(m.skip))}</b> skip</span><span><b>${esc(num(m.pay))}</b> pay</span><span><b>${esc(num(m.recheck))}</b> recheck</span></p>
<details class="sk-method"><summary>${esc(METHOD_SUMMARY)}</summary><div class="sk-mbody">
<div class="sk-free"><b>Check your endpoint free first:</b> <code>GET ${esc(fc.url)}</code><br><small>Real example: <a class="sk-mono" href="${esc(fc.exampleUrl)}">${esc(fc.exampleUrl)}</a> → <code>${esc(JSON.stringify(fc.example))}</code>. 5 free per day (25 per network), free dry runs with &amp;mode=dry-run. Then, only for the full payment terms, the paid check (HTTP 402).</small></div>
<p><b>${esc(num(m.endpoints_covered ?? m.total))}</b> endpoints covered · <b>${esc(num(m.new_this_week))}</b> new this week${m.previous_run ? "" : " (first full crawl)"} · ${esc(d.scheduleText)}</p>
<p><b>${esc(num(m.skip))}</b> skip · ${esc(num(m.pay))} pay · ${esc(num(m.recheck))} recheck · lists: ${esc(listed)}</p>
<p>${esc(d.spotHowTo)}</p>
<p><small>Self-checked: ${esc(m.method)} Deduped by ${esc(m.dedupe || "URL")}. Skip = no paywall (no 402), a malformed 402, price mismatch, wrong or unsupported network, a token other than canonical USDC, or a payTo that differs from the listing. Recheck = transient (timeout, network error, 5xx) or a free trial in use. JSON: <a href="/v1/skips.json">/v1/skips.json</a> · one receipt: /v1/receipts/&lt;id&gt; · by URL: /v1/receipts/by-url?url=&lt;endpoint&gt;. Facts only, not endorsements.</small></p>
</div></details>
${pager}
<div class="sk-box"><table class="sk"><colgroup><col class="c-ep"><col class="c-re"><col class="c-li"><col class="c-lv"><col class="c-ti"><col class="c-op"></colgroup>
<thead><tr><th scope="col">Endpoint</th><th scope="col">Reason</th><th scope="col">Listing</th><th scope="col">Live 402</th><th scope="col">Checked</th><th scope="col"><span class="sr-only">Receipt</span></th></tr></thead><tbody>
${rows || `<tr><td class="sk-empty" colspan="6">No skips on this page.</td></tr>`}
</tbody></table></div>
${pager}
</div>`;
  return chromePage({ title: SKIPS_TITLE + " · 402xAgent", desc: SKIPS_CAPTION, canonical: origin + "/v1/skips" + (page > 1 ? "?page=" + page : ""), alternate: "/v1/skips.json" + (page > 1 ? "?page=" + page : ""), current: "/v1/skips", css: CSS + `.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}`, main, footer: fp });
}
