// 0.58.5: the shared page chrome for the new human pages (receipts now, docs pages next): the homepage stylesheet
// (HOME_CSS), the same sticky header with the logo and nav, the mobile menu and the near-black footer as /pricing.
// /pricing and the homepage keep their own copies of this markup, so nothing they serve changes.
import { HOME_CSS } from "./home.js";

export const LOGO = "/brand/logo-light.png";
export const GH_REPO = "https://github.com/withgrokbot/verified-catalog";
export const GH_GUARD = "https://github.com/withgrokbot/x402-spotcheck";
export const NPM_GUARD = "https://www.npmjs.com/package/x402-spotcheck";
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const NAV = [["Products", "/#explore"], ["Docs", "/docs"], ["Pricing", "/pricing"], ["Blog", "/blog"], ["Receipts", "/v1/skips"], ["GitHub", GH_GUARD]];

// Header menu and page basics, the same rules /pricing uses (copied, so /pricing's own CSS string is untouched).
export const CHROME_CSS = `
.pr-menu{display:none;position:relative}
.pr-menu summary{list-style:none;width:40px;height:40px;border:1px solid var(--border);background:#fff;border-radius:9px;display:grid;place-items:center;cursor:pointer;color:var(--text)}
.pr-menu summary::-webkit-details-marker{display:none}
.pr-menu nav{position:absolute;right:0;top:48px;background:#fff;border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.12);padding:8px 14px;min-width:220px}
.pr-menu nav a{display:block;padding:10px 4px;font-weight:500;border-bottom:1px solid var(--bg-subtle)}.pr-menu nav a:last-child{border-bottom:none;font-weight:700;color:var(--accent)}
nav.main a[aria-current="page"]{color:var(--accent);font-weight:600}
@media(max-width:900px){.pr-menu{display:block}}
.pg-hero{padding:48px 0 8px}.pg-hero h1{font-size:clamp(30px,4.4vw,46px);margin:0;max-width:none}
.pg-lead{font-size:17px;color:var(--text-2);max-width:720px;margin:14px 0 0;line-height:1.55}
.pg-crumb{font-size:13.5px;color:var(--text-3);margin:0 0 10px}.pg-crumb a{color:var(--blue);font-weight:600}
.pg-body{margin:24px 0 72px}
.pg-body code,.pg-mono{font-family:var(--mono);font-size:.88em;background:var(--bg-subtle);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}
.pg-body a{color:var(--blue)}.pg-body a:hover{color:var(--blue-hover);text-decoration:underline}
@media(max-width:760px){.pg-hero{padding:32px 0 4px}.pg-lead{font-size:16px}}`;

/** Footer product links: fp = { endpointReport, watchtower, links? } (links default to the current /docs anchors). */
export function footerHtml(fp = {}) {
  const L = { check: "/docs#quick-start", report: "/docs#endpoint-report", status: "/docs#payment-status", watch: "/docs#watchtower", facil: "/docs#facilitator-check", hosted: "/docs#hosted", ...(fp.links || {}) };
  const audit = fp.audit ? `<li><a href="${esc(fp.audit)}">Audit layer</a></li>` : "";
  return `<footer>
<div class="wrap">
<div class="footer-grid">
<div class="footer-brand"><a class="brand" href="/" aria-label="402xAgent home"><span class="footer-logo-chip"><img src="${LOGO}" alt="402xAgent" width="49" height="40"></span></a><p>Verification for the x402 economy. Ask before your agent pays, and keep the receipt.</p></div>
<div><h4>Products</h4><ul><li><a href="${L.check}">402xAgent Check</a></li>${fp.endpointReport ? `<li><a href="${L.report}">Endpoint Report</a></li>` : ""}<li><a href="${L.status}">Payment Status</a></li>${fp.watchtower ? `<li><a href="${L.watch}">Watchtower</a></li>` : ""}<li><a href="${L.facil}">Facilitator Check</a></li><li><a href="${L.hosted}">Hosted Mode</a></li>${audit}</ul></div>
<div><h4>Resources</h4><ul><li><a href="/docs">Docs</a></li><li><a href="/blog">Blog</a></li><li><a href="/v1/skips">Receipts</a></li><li><a href="/pricing">Pricing</a></li><li><a href="${GH_GUARD}">GitHub</a></li><li><a href="${NPM_GUARD}">npm: x402-spotcheck</a></li></ul></div>
<div><h4>Company</h4><ul><li><a href="/health">Status</a></li><li><a href="${GH_REPO}/issues">Contact</a></li><li><a href="/rules">Verdict rules</a></li></ul></div>
</div>
<div class="footer-bottom"><span>402xAgent — verification for the x402 economy.</span><span>402xagent.com · Probes never pay the target</span></div>
</div>
</footer>`;
}

/** A full page: { title, desc, canonical, current (nav href), css, main (HTML), footer (footerHtml opts), robots } */
export function chromePage(o) {
  const navHtml = NAV.map(([t, h]) => `<a href="${esc(h)}"${h === o.current ? ' aria-current="page"' : ""}>${t}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#ffffff">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.desc)}">
${o.robots ? `<meta name="robots" content="${esc(o.robots)}">\n` : ""}<link rel="canonical" href="${esc(o.canonical)}">
<link rel="icon" type="image/png" href="${LOGO}">
${o.alternate ? `<link rel="alternate" type="application/json" href="${esc(o.alternate)}">\n` : ""}<meta property="og:type" content="website">
<meta property="og:site_name" content="402xAgent">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.desc)}">
<meta property="og:url" content="${esc(o.canonical)}">
<meta property="og:image" content="https://402xagent.com${LOGO}">
<style>${HOME_CSS}${CHROME_CSS}${o.css || ""}</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="top">
<div class="wrap header-inner">
<a class="brand" href="/" aria-label="402xAgent home"><img class="brand-logo" src="${LOGO}" alt="402xAgent" width="54" height="44"></a>
<nav class="main" aria-label="Primary">${navHtml}</nav>
<div class="header-actions">
<a class="btn btn-primary" href="/#checker">Run a free check</a>
<details class="pr-menu"><summary aria-label="Menu"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></summary><nav aria-label="Mobile">${navHtml}<a href="/#checker">Run a free check &rarr;</a></nav></details>
</div>
</div>
</header>
<main id="main">
<div class="wrap">
${o.main}
</div>
</main>
${footerHtml(o.footer)}
</body>
</html>
`;
}
