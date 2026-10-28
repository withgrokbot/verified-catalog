// 0.58.5: receipts for people. Browsers (Accept: text/html, the /v1/skips rule) get these pages; every other client keeps
// the exact JSON (tests/receipts_html_test.mjs, tests/fixtures/machine_0.58.4/receipts.json).
// Shown fields come only from the public JSON view (publicReceipt / handleReceipts), and only from the allow-list below.
// Never rendered, even when the public JSON carries them: ref, caller, payment_received, approved_payment, probe_snapshot,
// norm_key, receipt_v2.request_sha256 / supersedes / source_vintage, badge snippets, worker_version. Buyer wallets, client
// IPs, payment proofs and tx hashes are not in any public view (privacy.js) and have no slot here. Seller pay_to (the
// seller's own 402 terms, also on /v1/skips) is shown where the receipt compares it.
// Signatures: live-check receipts (sc-) with kid + signature show the signature block and "Verify offline"; sc- receipts
// without one say they are unsigned; crawl receipts say plainly that they are unsigned, with no signature block.
import { chromePage, esc } from "./chrome.js";
import { plainReason } from "./home.js";

export const RECEIPTS_PAGE_SIZE = 50; // crawl rows per HTML page
export const LIVE_PAGE_SIZE = 25;
export const VERIFY_HREF = "/docs#receipt-signatures";
export const KEYS_HREF = "/.well-known/402xagent-keys.json";
export const TABS = [["crawl", "Crawl skips"], ["live", "Live checks"], ["dry-run", "Dry runs"], ["self-checked", "Self-checked"]];

const CSS = `
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.rc-tabs{display:flex;flex-wrap:wrap;gap:8px;margin:22px 0 14px}
.rc-tabs a{padding:8px 14px;border-radius:999px;border:1px solid var(--border);background:#fff;font-weight:600;font-size:14px;color:var(--text-2)}
.rc-tabs a[aria-current="page"]{background:var(--forest);border-color:var(--forest);color:#fff}
.rc-search{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 6px}
.rc-search input{flex:1 1 260px;min-width:0;padding:11px 14px;border:1px solid var(--border-strong);border-radius:10px;background:#fff;font-size:15px}
.rc-search button{padding:11px 18px;border-radius:10px;border:none;background:var(--accent);color:#fff;font-weight:700;cursor:pointer}
.rc-hint{font-size:13px;color:var(--text-3);margin:0 0 16px}
.rc-box{background:#fff;border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;box-shadow:0 10px 30px rgba(60,35,5,.06)}
table.rc{width:100%;border-collapse:collapse;font-size:14.5px}
table.rc th,table.rc td{padding:12px 16px;text-align:left;vertical-align:top;border-bottom:1px solid var(--bg-subtle)}
table.rc thead th{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3);background:var(--bg-page)}
table.rc tbody tr:last-child td{border-bottom:none}
.rc-host{font-weight:600;color:var(--forest);overflow-wrap:anywhere}.rc-path{display:block;font-family:var(--mono);font-size:12.5px;color:var(--text-3);overflow-wrap:anywhere}
.rc-time{white-space:nowrap;color:var(--text-2);font-size:13.5px}.rc-open{font-weight:600;color:var(--blue);white-space:nowrap}
.rc-empty{padding:28px 20px;color:var(--text-2)}
.rc-pager{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:16px 0 0;font-size:14px;color:var(--text-3)}
.rc-pager a{font-weight:700;color:var(--blue)}
.rc-card{background:#fff;border:1px solid var(--border);border-radius:var(--radius-lg);padding:22px 24px;margin:0 0 18px;box-shadow:0 10px 30px rgba(60,35,5,.06)}
.rc-card h2{font-size:18px;margin:0 0 12px;color:var(--forest)}
.rc-verdict{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.rc-verdict .verdict{font-size:14px;padding:8px 14px}
.rc-reason{font-size:18px;font-weight:600;color:var(--forest);margin:12px 0 0}
dl.rc-dl{display:grid;grid-template-columns:minmax(140px,220px) minmax(0,1fr);gap:8px 18px;margin:0;font-size:14.5px}
dl.rc-dl dt{color:var(--text-3);font-weight:600}dl.rc-dl dd{margin:0;color:var(--text);overflow-wrap:anywhere}
table.rc-cmp{width:100%;border-collapse:collapse;font-size:14px}
table.rc-cmp th,table.rc-cmp td{padding:9px 10px;text-align:left;vertical-align:top;border-bottom:1px solid var(--bg-subtle);overflow-wrap:anywhere}
table.rc-cmp thead th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3)}
.rc-diff{color:var(--skip-text);font-weight:700}
table.rc-cmp tbody th[scope=row]{white-space:nowrap;width:1%;color:var(--text-3);font-weight:600}
.rc-note{font-size:14px;color:var(--text-2);margin:10px 0 0}
.rc-sig{font-family:var(--mono);font-size:12.5px;background:var(--bg-subtle);border-radius:8px;padding:10px 12px;overflow-wrap:anywhere;margin:8px 0 0}
.rc-unsigned{border-left:4px solid var(--recheck-dot)}
.rc-actions{display:flex;flex-wrap:wrap;gap:10px 22px;margin:14px 0 0;font-weight:600}
@media(max-width:760px){
.rc-box{background:transparent;border:none;box-shadow:none;overflow:visible}
table.rc,table.rc tbody,table.rc tr,table.rc td{display:block;width:100%}
table.rc thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
table.rc tbody tr{background:#fff;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:10px;padding:12px 14px}
table.rc td{padding:3px 0;border:none}
.rc-card{padding:18px 16px}
dl.rc-dl{grid-template-columns:1fr;gap:2px}dl.rc-dl dd{margin:0 0 8px}
table.rc-cmp th,table.rc-cmp td{padding:8px 6px;font-size:13px}
table.rc-opts thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
table.rc-opts,table.rc-opts tbody,table.rc-opts tr,table.rc-opts td{display:block;width:100%}
table.rc-opts tr{border:1px solid var(--border);border-radius:10px;padding:6px 10px;margin:0 0 8px}
table.rc-opts td{border:none;padding:3px 0;display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px}
table.rc-opts td::before{content:attr(data-label);font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3)}
}`;

const V = new Set(["pay", "skip", "recheck"]);
const chip = (v) => { const s = String(v || ""); return V.has(s) ? `<span class="verdict ${s}"><i></i>${s}</span>` : `<span class="verdict">${esc(s || "unknown")}</span>`; };
const hostPath = (u) => { try { const x = new URL(u); return { host: x.host, path: x.pathname }; } catch (_) { return { host: String(u || ""), path: "" }; } };
const utc = (t) => { const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?/.exec(String(t || "")); return m ? `${m[1]} ${m[2]} UTC` : (t ? String(t) : "—"); };
const WALLET = /0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/g;
// 0.58.7: neutral wording for the crawl skip reasons the homepage mapping (plainReason) does not cover, in the same style.
// Each matches the shape scripts/weekly-crawl/crawl_probe.py emits and says only what that branch checked:
//   "payment request has no readable payment options": a 402 whose accepts decode to nothing (decode_402 empty)
//   "price looks wrong ($q)": the USDC price is not in (0, SANE_MAX_USD = 10.0], i.e. $0 or above $10
//   "asks for a token or network we can't price in USDC (net)": usd() is None (not that network's USDC, or no integer amount)
//   "wants payment on a testnet or a network we don't support (net)": the network is not in USDC_MAINNET
//   "asks for a different token than listed (...)": no accept on the listed network has the listed asset
//   "domain does not resolve (DNS)": a redirect target's host did not resolve (kept as is, already neutral)
export const CRAWL_PLAIN = [
  [/^payment request has no readable payment options/i, "Payment request has no readable payment options"],
  [/^price looks wrong/i, "Payment price is $0 or above $10"],
  [/^asks for a token or network we can't price in USDC/i, "Payment token or network can't be priced in USDC"],
  [/^wants payment on a testnet or a network we don't support/i, "Payment network is a testnet or not supported"],
  [/^asks for a different token than listed/i, "Payment token differs from the listing"],
  [/^domain does not resolve/i, "Domain does not resolve"],
];
/** Crawl reason in plain words: the homepage mapping, then CRAWL_PLAIN; other shapes lose their parenthetical detail and any address. */
export function crawlReasonText(r) {
  const s = String(r || "").trim();
  return plainReason(r) || (CRAWL_PLAIN.find(([re]) => re.test(s)) || [])[1] || s.replace(/\s*\([^)]*\)\s*$/, "").replace(WALLET, "a wallet").trim() || "—";
}
const liveReason = (r) => String(r.reason_text || r.reason_code || r.reason || "—");
const usdOf = (v) => (v === null || v === undefined || v === "" ? null : "$" + Number(v).toString());
const isUsdcBase = (a) => a && String(a.asset || "").toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const amountText = (a) => (a.amount_usd != null ? "$" + Number(a.amount_usd).toString() + " " : isUsdcBase(a) && /^\d+$/.test(String(a.amount_atomic || "")) ? "$" + (Number(a.amount_atomic) / 1e6).toString() + " " : "") + (a.amount_atomic != null ? `(${esc(a.amount_atomic)} atomic)` : "");

function page(o) {
  return chromePage({ ...o, css: CSS, current: "/v1/skips", footer: o.footer });
}

/** HTML list. d: { tab, rows:[{id, verdict, url, reason, time}], q, page, pages, prevHref, nextHref, total, note, exact } */
export function receiptListHtml(origin, d, fp) {
  const tabs = TABS.map(([k, t]) => `<a href="${k === "crawl" ? "/v1/receipts" : "/v1/receipts?type=" + k}"${k === d.tab ? ' aria-current="page"' : ""}>${esc(t)}</a>`).join("");
  const rows = d.rows.map((r) => { const hp = hostPath(r.url); return `<tr><td data-label="Verdict">${chip(r.verdict)}</td><td data-label="Endpoint"><span class="rc-host">${esc(hp.host)}</span><span class="rc-path">${esc(hp.path)}</span></td><td data-label="Reason">${esc(r.reason)}</td><td data-label="Time" class="rc-time">${esc(utc(r.time))}</td><td><a class="rc-open" href="/v1/receipts/${esc(r.id)}">Receipt &rarr;</a></td></tr>`; }).join("\n");
  const typeField = d.tab === "crawl" ? "" : `<input type="hidden" name="type" value="${esc(d.tab)}">`;
  const pager = d.prevHref || d.nextHref || d.pages ? `<nav class="rc-pager" aria-label="Pages"><span>${d.prevHref ? `<a href="${esc(d.prevHref)}" rel="prev">&larr; Newer</a>` : ""}</span><span>${d.pages ? `Page ${d.page} of ${d.pages}` : ""}</span><span>${d.nextHref ? `<a href="${esc(d.nextHref)}" rel="next">Older &rarr;</a>` : ""}</span></nav>` : "";
  const main = `<section class="pg-hero"><h1>Receipts</h1>
<p class="pg-lead">Every verdict is kept as a public receipt, free to read. Crawl receipts come from our weekly self-checked crawl and are unsigned. Live-check receipts record one check of one endpoint; the signed ones carry an Ed25519 signature you can verify offline.</p></section>
<div class="pg-body">
<nav class="rc-tabs" aria-label="Receipt types">${tabs}</nav>
<form class="rc-search" method="get" action="/v1/receipts" role="search">${typeField}<input type="search" name="q" value="${esc(d.q || "")}" placeholder="Search by host or reason, or paste an endpoint URL" aria-label="Search receipts" maxlength="300"><button type="submit">Search</button></form>
<p class="rc-hint">${esc(d.note)} <a href="${esc(d.jsonHref)}">JSON</a></p>
<div class="rc-box"><table class="rc"><thead><tr><th scope="col">Verdict</th><th scope="col">Endpoint</th><th scope="col">Reason</th><th scope="col">Time</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead><tbody>
${rows || `<tr><td class="rc-empty" colspan="5">No receipts match${d.q ? ` &ldquo;${esc(d.q)}&rdquo;` : ""} here.${d.q && !d.exact ? " Paste the full endpoint URL to look it up across every receipt." : ""}</td></tr>`}
</tbody></table></div>
${pager}
</div>`;
  return page({ title: "Receipts · 402xAgent", desc: "Public 402xAgent receipts: every pay, skip and recheck verdict, free to read.", canonical: origin + "/v1/receipts", alternate: d.jsonHref, main, footer: fp, robots: d.q || d.page > 1 || d.cursor ? "noindex" : null });
}

function sigBlock(r) {
  if (r.signature && r.kid) return `<section class="rc-card" id="signature"><h2>Signature</h2>
<p class="rc-note">Signed by 402xAgent with Ed25519 over the RFC 8785 (JCS) form of the receipt JSON without its <code>signature</code> field.</p>
<dl class="rc-dl"><dt>Key id (kid)</dt><dd><code>${esc(r.kid)}</code></dd></dl>
<div class="rc-sig">${esc(r.signature)}</div>
<div class="rc-actions"><a href="${VERIFY_HREF}">Verify offline &rarr;</a><a href="${KEYS_HREF}">Public keys</a></div></section>`;
  return `<section class="rc-card rc-unsigned" id="signature"><h2>Unsigned</h2><p class="rc-note">This live-check receipt was stored before receipts were signed, so it carries no signature.</p></section>`;
}
function termsRow(label, listed, live) {
  const diff = listed != null && live != null && String(listed).toLowerCase() !== String(live).toLowerCase();
  return `<tr><th scope="row">${esc(label)}</th><td>${listed == null ? "—" : esc(listed)}</td><td${diff ? ' class="rc-diff"' : ""}>${live == null ? "—" : esc(live)}</td></tr>`;
}

/** One live-check receipt (sc-), from the public JSON view. */
export function liveReceiptHtml(origin, r, fp) {
  const hp = hostPath(r.url);
  const ex = r.expected || {}, l4 = r.live_402 || {}, acc = Array.isArray(l4.accepts) ? l4.accepts : null;
  const live0 = acc && (acc.find((a) => ex.network && String(a.network) === String(ex.network)) || acc[0]);
  const listedPrice = usdOf(ex.claimed_price_usd);
  const terms = acc
    ? `<table class="rc-cmp"><thead><tr><th scope="col">Term</th><th scope="col">Listed</th><th scope="col">Live 402</th></tr></thead><tbody>${termsRow("Price", listedPrice, live0 ? (live0.amount_usd != null ? "$" + Number(live0.amount_usd) : isUsdcBase(live0) ? "$" + Number(live0.amount_atomic) / 1e6 : live0.amount_atomic) : null)}${termsRow("Network", ex.network, live0 && live0.network)}${termsRow("Pay to", ex.pay_to, live0 && live0.pay_to)}</tbody></table>
${acc.length ? `<p class="rc-note">All payment options in the live 402:</p><table class="rc-cmp rc-opts"><thead><tr><th scope="col">Scheme</th><th scope="col">Network</th><th scope="col">Amount</th><th scope="col">Pay to</th></tr></thead><tbody>${acc.map((a) => `<tr><td data-label="Scheme">${esc(a.scheme)}</td><td data-label="Network">${esc(a.network)}</td><td data-label="Amount">${amountText(a)}</td><td data-label="Pay to">${esc(a.pay_to)}</td></tr>`).join("")}</tbody></table>` : ""}`
    : `<p class="rc-note">${r.redacted ? "Free check: the live 402 terms are in the paid check. " : ""}The live response answered HTTP ${esc(l4.http_status ?? "—")}${l4.x402_challenge ? ` with an x402 payment request (${esc(l4.accepts_count ?? 0)} payment option${l4.accepts_count === 1 ? "" : "s"})` : " with no x402 payment request"}.</p>`;
  const diffs = r.receipt_v2 && Array.isArray(r.receipt_v2.diff) && r.receipt_v2.diff.length ? `<p class="rc-note">Fields that differed from the listing: ${r.receipt_v2.diff.map((x) => `<code>${esc(x && x.field)}</code>`).join(", ")}</p>` : "";
  const h = r.history || null;
  const hist = h ? `<dt>History</dt><dd>${esc(h.observations ?? 0)} observations${h.stable_for_days != null ? `, stable for ${esc(h.stable_for_days)} days` : ""}${h.drift === true ? ", terms drifted" : h.drift === false ? ", no drift" : ""}</dd>` : "";
  const rule = r.current_rule ? `<p class="rc-note"><strong>Current rule:</strong> ${esc(r.current_rule.note)} (${esc(r.current_rule.verdict)}, ${esc(r.current_rule.reason)}, since ${esc(r.current_rule.since)}).</p>` : "";
  const tr = r.transient && r.transient.code ? `<dt>Transient</dt><dd><code>${esc(r.transient.code)}</code></dd>` : "";
  const main = `<section class="pg-hero"><p class="pg-crumb"><a href="/v1/receipts${r.check_type && r.check_type !== "live" ? "?type=" + esc(r.check_type) : "?type=live"}">&larr; Receipts</a></p><h1>Live-check receipt</h1>
<p class="pg-lead">One ${r.dry_run ? "dry run" : "402xAgent Check"} of <code class="pg-mono">${esc(hp.host)}${esc(hp.path)}</code>: an unpaid probe of the endpoint's live x402 terms, compared with its listing. The probe never pays the endpoint.</p></section>
<div class="pg-body">
<section class="rc-card"><div class="rc-verdict">${chip(r.verdict)}${r.reason_code ? `<code>${esc(r.reason_code)}</code>` : ""}${r.confidence ? `<span class="rc-note">confidence ${esc(r.confidence)}</span>` : ""}</div><p class="rc-reason">${esc(liveReason(r))}</p>${rule}</section>
<section class="rc-card"><h2>What was compared</h2>${terms}${acc ? '<p class="rc-note">Pay to is the seller&rsquo;s wallet from its own 402 terms.</p>' : ""}${diffs}${r.pay_to_changed === true ? '<p class="rc-note rc-diff">The seller wallet changed since the previous receipt for this URL.</p>' : ""}</section>
<section class="rc-card"><h2>Details</h2><dl class="rc-dl"><dt>Endpoint</dt><dd><code>${esc(r.method || "GET")} ${esc(r.url)}</code></dd><dt>Checked</dt><dd>${esc(utc(r.checked_at))}</dd>${r.probe && r.probe.probed_at ? `<dt>Probed</dt><dd>${esc(utc(r.probe.probed_at))}${r.probe.cached ? " (cached probe)" : ""}</dd>` : ""}<dt>Type</dt><dd>${r.dry_run ? "dry run: nothing signed or paid" : "live check"}</dd><dt>Listing source</dt><dd>${esc(ex.source || "none")}</dd>${hist}${tr}${r.payment_terms_sha256 ? `<dt>Terms digest</dt><dd><code>sha256:${esc(r.payment_terms_sha256)}</code></dd>` : ""}<dt>Receipt id</dt><dd><code>${esc(r.id)}</code></dd></dl>
<div class="rc-actions"><a href="/v1/receipts/${esc(r.id)}?format=json">View JSON</a><a href="/#checker">Run a fresh check</a></div></section>
${sigBlock(r)}
</div>`;
  return page({ title: `Receipt ${r.id} · 402xAgent`, desc: `402xAgent live-check receipt: ${r.verdict} for ${hp.host}${hp.path}.`, canonical: origin + "/v1/receipts/" + r.id, alternate: "/v1/receipts/" + r.id + "?format=json", main, footer: fp });
}

/** One crawl receipt (10 hex id), from the public JSON (handleReceipts). Unsigned, said plainly. */
export function crawlReceiptHtml(origin, r, fp) {
  const hp = hostPath(r.url), f = r.freshness || null;
  const lists = [r.source_list, ...(Array.isArray(r.also_listed_in) ? r.also_listed_in : [])].filter(Boolean).join(", ");
  const main = `<section class="pg-hero"><p class="pg-crumb"><a href="/v1/receipts">&larr; Receipts</a></p><h1>Crawl receipt</h1>
<p class="pg-lead">From our weekly self-checked crawl of listed x402 endpoints: an unpaid probe of <code class="pg-mono">${esc(hp.host)}${esc(hp.path)}</code>, compared with its listing. The probe never pays the endpoint.</p></section>
<div class="pg-body">
<section class="rc-card"><div class="rc-verdict">${chip(r.verdict)}${f && f.effective_verdict && f.effective_verdict !== r.verdict ? `<span class="rc-note">now ${esc(f.effective_verdict)}: terms older than ${esc(f.terms_max_age_hours)} h</span>` : ""}</div><p class="rc-reason">${esc(crawlReasonText(r.reason))}</p></section>
<section class="rc-card"><h2>What was compared</h2><table class="rc-cmp"><thead><tr><th scope="col">Term</th><th scope="col">Listed</th><th scope="col">Live 402</th></tr></thead><tbody>${termsRow("Price", usdOf(r.claimed_price_usd), usdOf(r.quoted_price_usd))}${termsRow("Network", r.listed_network, r.network)}${termsRow("Pay to", r.listed_pay_to, r.pay_to)}</tbody></table>
<p class="rc-note">The live response answered HTTP ${esc(r.http_status ?? "—")}. Pay to is the seller&rsquo;s wallet from its own 402 terms.</p></section>
<section class="rc-card"><h2>Details</h2><dl class="rc-dl"><dt>Endpoint</dt><dd><code>${esc(r.method || "GET")} ${esc(r.url)}</code></dd><dt>Checked</dt><dd>${esc(utc(r.timestamp))}</dd>${f ? `<dt>Terms age</dt><dd>${esc(f.terms_age_hours)} h (stale after ${esc(f.terms_max_age_hours)} h)</dd>` : ""}<dt>Listed in</dt><dd>${esc(lists || "—")}</dd><dt>Type</dt><dd>self-checked crawl</dd><dt>Receipt id</dt><dd><code>${esc(r.id)}</code></dd></dl>
<div class="rc-actions"><a href="/v1/receipts/${esc(r.id)}?format=json">View JSON</a>${r.verdict === "skip" ? '<a href="/v1/skips">All skips</a>' : ""}<a href="/#checker">Run a fresh check</a></div></section>
<section class="rc-card rc-unsigned" id="unsigned"><h2>Unsigned crawl receipt</h2><p class="rc-note">Crawl receipts are not signed. This is our record of what the weekly crawl saw, not a signed statement. For a signed answer about this endpoint right now, run a live check: its receipt is signed with Ed25519.</p></section>
</div>`;
  return page({ title: `Crawl receipt ${r.id} · 402xAgent`, desc: `402xAgent crawl receipt: ${r.verdict} for ${hp.host}${hp.path}.`, canonical: origin + "/v1/receipts/" + r.id, alternate: "/v1/receipts/" + r.id + "?format=json", main, footer: fp });
}

export function receiptNotFoundHtml(origin, id, fp) {
  const main = `<section class="pg-hero"><p class="pg-crumb"><a href="/v1/receipts">&larr; Receipts</a></p><h1>Receipt not found</h1><p class="pg-lead">There is no receipt with the id <code class="pg-mono">${esc(String(id).slice(0, 40))}</code>. Receipt ids are 10 hex characters (crawl) or <code class="pg-mono">sc-</code> plus 16 hex characters (live checks).</p></section><div class="pg-body"><p><a href="/v1/receipts">Browse all receipts</a></p></div>`;
  return page({ title: "Receipt not found · 402xAgent", desc: "No receipt with this id.", canonical: origin + "/v1/receipts", main, footer: fp, robots: "noindex" });
}
