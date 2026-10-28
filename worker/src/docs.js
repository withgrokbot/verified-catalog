// 0.58.6: /docs split into one page per product, in the homepage design (chrome.js). Filing, not rewriting: the legacy
// generator docsHtml (pages.js, unchanged) is rendered with the same options and cut at its own <h2 id> boundaries; each
// section is re-housed whole on its product page. Only two wording fixes are applied, each asserted to hit exactly once:
// Watchtower "Every hour we re-probe." -> the /pricing wording (Regular re-probes), and the Hosted invoice lines -> "usage
// tracked; billed monthly by arrangement". Old /docs anchors keep an element with the same id on /docs (a visible pointer
// that works with JavaScript off), and /docs/anchors.js (self-hosted, script-src 'self') forwards those hashes.
// Paragraph map: scripts/docs_paragraph_map.mjs; test: tests/docs_split_test.mjs.
import { docsHtml } from "./pages.js";
import { chromePage, esc, NPM_GUARD } from "./chrome.js";
import { REASON_CODES } from "./rules.js";
import { REASON_TEXT } from "./recent.js";

export const DOCS_ANCHORS_PATH = "/docs/anchors.js";
export const DOCS_EXAMPLE_RECEIPT = "/v1/receipts/sc-85c8963fb57e7b25"; // a stored, signed live-check receipt (never rotates, unlike crawl ids)
// Product pages, in order. section = the legacy <h2 id> chunks it carries; pricing = its row on /pricing.
export const DOCS_PAGES = [
  { slug: "check", name: "402xAgent Check", sections: ["quick-start", "expiry-check"], pricing: "check", blurb: "The check itself: pay, skip or recheck right before your agent pays, the reason codes, and the expiry-check opt-in." },
  { slug: "endpoint-report", name: "Endpoint Report", sections: ["endpoint-report"], pricing: "endpoint-report", flag: "endpointReport", always: true, blurb: "The locked teasers and commitments in every free answer, and how buying and revealing a report works." },
  { slug: "payment-status", name: "Payment Status", sections: ["payment-status"], pricing: "payment-status", blurb: "After you pay: did it land, and is it safe to sign again? With the full worked example." },
  { slug: "watchtower", name: "Watchtower", sections: ["watchtower"], pricing: "watchtower", flag: "watchtower", blurb: "Watch, renew and status; drift, down and recovery events; webhook signatures and retries." },
  { slug: "facilitator-check", name: "Facilitator Check", sections: ["facilitator-check"], pricing: "facilitator-check", blurb: "The free pre-settle check for a facilitator's onBeforeSettle hook." },
  { slug: "hosted", name: "Hosted Mode", sections: ["hosted"], pricing: "hosted", blurb: "Integrator keys for routers and wallets: pricing bands, credit, receipts and your meter." },
  { slug: "receipt-verification", name: "Receipt Verification", sections: ["receipt-signatures"], pricing: null, blurb: "Receipt signatures, the keys doc, and RFC 8785 (JCS) verification with a Node example." },
];
// Every id the old single page had, and where it lives now. try-it and quick-start stay on /docs.
export const DOCS_ANCHOR_MAP = {
  "try-it": "/docs#try-it", "quick-start": "/docs#quick-start",
  "endpoint-report": "/docs/endpoint-report", "endpoint-report-verify": "/docs/endpoint-report#endpoint-report-verify",
  watchtower: "/docs/watchtower", "payment-status": "/docs/payment-status", "payment-status-example": "/docs/payment-status#payment-status-example",
  "facilitator-check": "/docs/facilitator-check", "expiry-check": "/docs/check#expiry-check", hosted: "/docs/hosted",
  "receipt-signatures": "/docs/receipt-verification#receipt-signatures",
};
export const DOCS_MOVED = Object.keys(DOCS_ANCHOR_MAP).filter((k) => !DOCS_ANCHOR_MAP[k].startsWith("/docs#"));

// The wording fixes (old -> new). Each must match exactly once in the legacy text, or the build fails loudly in tests.
export const DOCS_WORDING = [
  ["<p>Every hour we re-probe. Events:", "<p>Regular re-probes: each watch is due again an hour after its last probe, and at busy times a probe can run later. Events:"],
  ["Cached answers count. Billed on a monthly USDC invoice on Base, not per call.</li>", "Cached answers count. Usage tracked; billed monthly by arrangement, not per call.</li>"],
  ["Credit limit $20 until the first invoice is paid, then $100;", "Credit limit $20 until the first monthly bill is paid, then $100;"],
];

const H2 = /\n?<h2 id="(quick-start|endpoint-report|watchtower|payment-status|facilitator-check|expiry-check|hosted|receipt-signatures)">/g;
/** The legacy /docs body (exact), cut into { intro, sections: {id: html} }. */
export function legacyDocsParts(origin, apiOrigin, opts = {}) {
  const full = docsHtml(origin, apiOrigin, opts);
  const start = full.indexOf("</a></p>\n", full.indexOf("<body>")) + "</a></p>\n".length;
  const body = full.slice(start, full.lastIndexOf("\n</body>"));
  const marks = [...body.matchAll(H2)];
  const intro = body.slice(0, marks.length ? marks[0].index : body.length);
  const sections = {};
  marks.forEach((m, i) => { sections[m[1]] = body.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : body.length).replace(/^\n/, ""); });
  return { full, body, intro, sections };
}
export function applyWording(html) {
  let out = html;
  for (const [a, b] of DOCS_WORDING) if (out.includes(a)) out = out.split(a).join(b);
  return out;
}

export const DOCS_ANCHORS_JS = `(function () {
  "use strict";
  var M = ${JSON.stringify(Object.fromEntries(DOCS_MOVED.map((k) => [k, DOCS_ANCHOR_MAP[k]])))};
  function go() {
    var h = (location.hash || "").slice(1);
    if (h && Object.prototype.hasOwnProperty.call(M, h) && /^\\/docs\\/?$/.test(location.pathname)) location.replace(M[h]);
  }
  go();
  window.addEventListener("hashchange", go);
})();
`;

const CSS = `
.dc-grid{display:grid;grid-template-columns:220px minmax(0,1fr);gap:40px;align-items:start;margin:8px 0 72px}
.dc-side{position:sticky;top:88px;font-size:14.5px}
.dc-side h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin:0 0 8px}
.dc-side ul{list-style:none;margin:0;padding:0}.dc-side li a{display:block;padding:6px 10px;border-radius:8px;color:var(--text-2);font-weight:500}
.dc-side li a:hover{background:var(--bg-subtle)}.dc-side li a[aria-current="page"]{background:var(--accent-light);color:var(--accent);font-weight:700}
.dc{min-width:0;font-size:16px;line-height:1.65;color:var(--text-2)}
.dc h2{font-size:24px;letter-spacing:-.02em;color:var(--forest);margin:36px 0 10px;scroll-margin-top:90px}
.dc h3{font-size:18px;color:var(--forest);margin:26px 0 8px;scroll-margin-top:90px}
.dc>:first-child,.dc section>:first-child{margin-top:0}
.dc a{color:var(--blue)}.dc a:hover{text-decoration:underline}
.dc code{font-family:var(--mono);font-size:.86em;background:var(--bg-subtle);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}
.dc pre{background:#16161D;color:#F3EFE9;border-radius:12px;padding:16px 18px;overflow-x:auto;max-width:100%;font-size:13px;line-height:1.55}
.dc pre code{background:none;padding:0;color:inherit;overflow-wrap:normal;white-space:pre}
.dc ul,.dc ol{padding-left:22px}.dc li{margin:6px 0}
.dc #try-it{background:#fff;border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px 20px;margin:24px 0}
.dc-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:14px 0 8px}
.dc-card{display:block;background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;color:var(--text-2)}
.dc-card:hover{border-color:var(--blue);text-decoration:none!important}.dc-card strong{display:block;color:var(--forest);font-size:16.5px;margin-bottom:4px}
.dc-moved{background:var(--mint);border:1px solid #F5D9B5;border-radius:var(--radius);padding:12px 16px;margin:10px 0;scroll-margin-top:90px}
.dc-moved h2{font-size:16px;margin:0 0 2px}.dc-moved p{margin:0;font-size:14.5px}
.dc-moved:target{outline:3px solid var(--accent);outline-offset:2px}
.dc-next{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;border-top:1px solid var(--border);margin:40px 0 0;padding:18px 0 0;font-weight:600}
.dc-codes{width:100%;border-collapse:collapse;font-size:14px;margin:8px 0}
.dc-codes th,.dc-codes td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--bg-subtle)}
.dc-codes thead th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3)}
@media(max-width:900px){.dc-grid{grid-template-columns:1fr;gap:12px}.dc-side{position:static}.dc-side ul{display:flex;flex-wrap:wrap;gap:6px}.dc-side li a{border:1px solid var(--border);background:#fff;padding:6px 10px}}
@media(max-width:760px){.dc-cards{grid-template-columns:1fr}.dc h2{font-size:21px}.dc pre{font-size:12px;padding:12px}
.dc-codes,.dc-codes tbody,.dc-codes tr,.dc-codes td{display:block;width:100%}.dc-codes thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.dc-codes tr{border-bottom:1px solid var(--border);padding:6px 0}.dc-codes td{border:none;padding:2px 0}}`;

const visible = (p, opts) => !p.flag || p.always || opts[p.flag];
export const docsPageHref = (slug) => "/docs/" + slug;
const footer = (opts) => ({ endpointReport: opts.endpointReport, watchtower: opts.watchtower });

function shell(origin, opts, { slug, title, desc, h1, lead, content }) {
  const pages = DOCS_PAGES.filter((p) => visible(p, opts));
  const side = `<aside class="dc-side" aria-label="Docs pages"><h2>Docs</h2><ul><li><a href="/docs"${slug === "" ? ' aria-current="page"' : ""}>Getting started</a></li>${pages.map((p) => `<li><a href="${docsPageHref(p.slug)}"${p.slug === slug ? ' aria-current="page"' : ""}>${esc(p.name)}</a></li>`).join("")}</ul></aside>`;
  const main = `<section class="pg-hero"><p class="pg-crumb">${slug ? '<a href="/docs">Docs</a>' : "Docs"}</p><h1>${esc(h1)}</h1>${lead ? `<p class="pg-lead">${lead}</p>` : ""}</section>
<div class="dc-grid">${side}<article class="dc">
${content}
</article></div>`;
  const html = chromePage({ title, desc, canonical: origin + (slug ? "/docs/" + slug : "/docs"), current: "/docs", css: CSS, main, footer: footer(opts) });
  return slug ? html : html.replace("</head>", `<script src="${DOCS_ANCHORS_PATH}"></script>\n</head>`);
}
function nextBlock(opts, p) {
  const pages = DOCS_PAGES.filter((x) => visible(x, opts));
  const i = pages.indexOf(p), nx = pages[i + 1];
  const step = p.pricing ? `<a href="/pricing#${p.pricing}">${esc(p.name)} pricing &rarr;</a>` : `<a href="${DOCS_EXAMPLE_RECEIPT}">See a signed receipt &rarr;</a>`;
  return `<nav class="dc-next" aria-label="Next step"><span>Next step: ${step}</span>${nx ? `<a href="${docsPageHref(nx.slug)}">${esc(nx.name)} &rarr;</a>` : '<a href="/docs">Back to Getting started &rarr;</a>'}</nav>`;
}

/** /docs: the index (Getting started). */
export function docsIndexHtml(origin, apiOrigin, opts = {}) {
  const { intro, sections } = legacyDocsParts(origin, apiOrigin, opts);
  const pages = DOCS_PAGES.filter((p) => visible(p, opts));
  const cards = `<h2 id="products">Product docs</h2><div class="dc-cards">${pages.map((p) => `<a class="dc-card" href="${docsPageHref(p.slug)}"><strong>${esc(p.name)} &rarr;</strong>${esc(p.blurb)}</a>`).join("")}<a class="dc-card" href="${NPM_GUARD}"><strong>Audit layer &rarr;</strong>x402-spotcheck/audit: free, open source (MIT) budgets, a wallet deny list and a hash-chained ledger inside your agent.</a></div>`;
  const moved = DOCS_MOVED.filter((id) => { const pg = DOCS_PAGES.find((p) => DOCS_ANCHOR_MAP[id].startsWith(docsPageHref(p.slug))); return pg && visible(pg, opts) && (id !== "watchtower" || opts.watchtower); });
  const nameOf = (id) => { const pg = DOCS_PAGES.find((p) => DOCS_ANCHOR_MAP[id].startsWith(docsPageHref(p.slug))); return pg ? pg.name : id; };
  const titles = { "endpoint-report-verify": "Verify a report", "payment-status-example": "Worked example (402rates-ping, Oct 16)", "expiry-check": "Expiry check (opt-in)", "receipt-signatures": "Receipt signatures" };
  const pointers = `<h2 id="moved">Moved sections</h2><p>The sections of the old single page now live on the product pages. Old links keep working: each one lands here and points on (with JavaScript on, it forwards you).</p>
${moved.map((id) => `<section class="dc-moved" id="${id}"><h2>${esc(titles[id] || nameOf(id))}</h2><p>Moved to <a href="${DOCS_ANCHOR_MAP[id]}">${esc(nameOf(id))}: ${esc(DOCS_ANCHOR_MAP[id])}</a></p></section>`).join("\n")}`;
  const content = `${intro.replace(/^<h1>Docs<\/h1>\n/, "")}${sections["quick-start"] || ""}\n${cards}\n${pointers}`;
  return shell(origin, opts, { slug: "", title: "Docs · 402xAgent", desc: "402xAgent docs: getting started, the free Try-it check, the quick start, and a page per product.", h1: "Docs", lead: "Getting started with 402xAgent, then one page per product.", content });
}

/** /docs/<slug>, or null when there is no such page (or it is switched off). */
export function docsProductHtml(origin, apiOrigin, slug, opts = {}) {
  const p = DOCS_PAGES.find((x) => x.slug === slug);
  if (!p || !visible(p, opts)) return null;
  const { sections } = legacyDocsParts(origin, apiOrigin, opts);
  let content = p.sections.map((id) => applyWording(sections[id] || "")).join("\n");
  if (p.slug === "check") {
    const rows = REASON_CODES.map((r) => `<tr><td><code>${esc(r.code)}</code></td><td>${esc(r.verdict)}</td><td>${esc(REASON_TEXT[r.code] || r.rule)}</td></tr>`).join("");
    content = `${content}\n<h2 id="reason-codes">Reason codes</h2><p>Every verdict carries a stable <code>reason_code</code> and a confidence. The full list with rules is at <a href="/rules">/rules</a> (JSON: <a href="/rules.json">/rules.json</a>).</p>
<table class="dc-codes"><thead><tr><th scope="col">reason_code</th><th scope="col">verdict</th><th scope="col">meaning</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  if (p.slug === "receipt-verification") content += `\n<p>Example: a signed live-check receipt, <a href="${DOCS_EXAMPLE_RECEIPT}">${esc(DOCS_EXAMPLE_RECEIPT)}</a> (JSON for scripts, a readable page in a browser). Crawl receipts (10-character ids) are unsigned.</p>`;
  return shell(origin, opts, { slug: p.slug, title: `${p.name} · 402xAgent docs`, desc: `402xAgent docs: ${p.name}. ${p.blurb}`, h1: p.name, lead: esc(p.blurb), content: content + "\n" + nextBlock(opts, p) });
}
