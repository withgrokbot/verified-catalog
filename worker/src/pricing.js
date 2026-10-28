// 0.58.3: the /pricing page as a real pricing table in the homepage's look (HOME_CSS, same header and footer, strict CSP
// incl. the 0.58.1 Cloudflare Web Analytics allowance, no script at all). Every number is passed in from the live price
// constants (lib.js /pricing route); nothing is typed in here. Sources (file:line at 0.58.3):
//   free checks/day      wrangler.toml:76 SPOT_FREE_PER_DAY = "5" (default spotcheck.js:18), read by lib.js:455/461
//   free per network/day wrangler.toml:77 SPOT_FREE_PER_IP_DAY = "25" (default lib.js:471), read by lib.js:465
//   check price          lib.js:1965 SPOT_PAID_ATOMIC = "20000" ($0.02), flat via spotDynCfg lib.js:1968-1970
//   endpoint report      report.js:10 ER_PAID_ATOMIC = "50000" ($0.05, everyone, no free tier)
//   payment status       lib.js:4212 spotDynCfg (flat $0.02); free tier = the check's counter lib.js:4245/4309
//   watchtower           watch.js:11 WATCH_PRICE_ATOMIC = "1000000", :13 WATCH_PERIOD_DAYS = 30, :14 TRIAL_DAYS = 7,
//                        trial once per webhook domain watch.js:472-476
//   facilitator check    facilcheck.js:15 FACIL_CHECK_PER_MIN = 60, :17 FACIL_HOST_PER_MIN = 30 (free, POST only lib.js:3949)
//   hosted               hosted.js:9 HOSTED_FREE_TOTAL = 1000, :10 HOSTED_VOLUME_AFTER = 1000, :11 HOSTED_STANDARD_ATOMIC = 20000,
//                        :12 HOSTED_VOLUME_ATOMIC = 10000 (pricing hosted.js:42-45); keys issued by scripts/hosted_key.mjs
// 0.58.6: links go to the per-product docs pages; + the audit layer row and footer entry (free, open source).
// No prepaid packs or credits are shown (the router pack and the overnight pack stay API-only routes), no badge, no names.
// Watchtower says "Regular re-probes", not hourly: next_probe_at = last probe + 1 h (watch.js:77, :291), but a */20 tick
// probes at most WATCH_BATCH_DEFAULT = 100 due watches (watch.js:21, :318-319) while WATCH_MAX_DEFAULT = 500 (watch.js:15).
import { HOME_CSS } from "./home.js";

const LOGO = "/brand/logo-light.png";
const GH_REPO = "https://github.com/withgrokbot/verified-catalog";
const GH_GUARD = "https://github.com/withgrokbot/x402-spotcheck";
const NPM_GUARD = "https://www.npmjs.com/package/x402-spotcheck";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const usd = (atomic) => "$" + (Number(atomic) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "").replace(/(\.\d)$/, "$10"); // $0.02, $1, $0.05
const n = (x) => Number(x).toLocaleString("en-US");

/** The table rows, built only from the passed constants. Each row: id, name, price, unit, free, terms (HTML), href, link. */
export function pricingRows(p) {
  return [
    { id: "free", name: "Free", price: `${n(p.freePerDay)} a day`, unit: "free live checks", free: "No wallet, no signup",
      terms: `${n(p.freePerDay)} live checks per client per UTC day, at most ${n(p.freePerIpDay)} per network (IP) per day across client names. The same daily count covers the 402xAgent Check and Payment Status. Dry runs (<code>&amp;mode=dry-run</code>) are free.`,
      href: "/#checker", link: "Run a free check" },
    { id: "check", name: "402xAgent Check", price: usd(p.paidAtomic), unit: "per check", free: `${n(p.freePerDay)} free a day`,
      terms: `${usd(p.paidAtomic)} per check, flat, whatever the target endpoint charges. Pay, skip or recheck right before your agent pays, with a signed receipt. The paid check adds the full payment terms and the payment object to sign.`,
      href: "/docs/check", link: "Quick start" },
    p.endpointReport && { id: "endpoint-report", name: "Endpoint Report", price: usd(p.erAtomic), unit: "per report", free: "No free tier",
      terms: `${usd(p.erAtomic)} per report, flat, for everyone: the committed drift history and hygiene detail behind a free check of one endpoint, with digests you can verify.`,
      href: "/docs/endpoint-report", link: "How it works" },
    { id: "payment-status", name: "Payment Status", price: usd(p.paidAtomic), unit: "per lookup", free: `${n(p.freePerDay)} free a day, shared with the check`,
      terms: `${usd(p.paidAtomic)} per lookup, flat, after the same ${n(p.freePerDay)} free checks per day (shared with the check). After you pay: did the Base USDC payment land, and is it safe to sign a new one? A signed answer before your agent pays twice.`,
      href: "/docs/payment-status", link: "How it works" },
    p.watchtower && { id: "watchtower", name: "Watchtower", price: usd(p.watchAtomic), unit: `per ${n(p.watchDays)} days`, free: `${n(p.trialDays)}-day trial`,
      terms: `Per watched endpoint, paid via x402. The ${n(p.trialDays)}-day free trial is for the first watch per webhook domain. Regular re-probes, with Ed25519-signed webhooks on drift, down and recovery.`,
      href: "/docs/watchtower", link: "Start monitoring" },
    { id: "facilitator-check", name: "Facilitator Check", price: "Free", unit: "rate-limited", free: "Always free",
      terms: `Up to ${n(p.facilPerMin)} per minute per network (IP) and ${n(p.facilHostPerMin)} per minute per seller host. Compares the payment requirements you are about to settle with the seller's live 402 terms; it never pays.`,
      href: "/docs/facilitator-check", link: "Integrate" },
    { id: "hosted", name: "Hosted Mode", price: `${n(p.hostedFree)} free`, unit: `then ${usd(p.hostedStdAtomic)}; ${usd(p.hostedVolAtomic)} past ${n(p.hostedVolAfter)}/month`, free: `${n(p.hostedFree)} free hosted checks, once`,
      terms: `Integrator keys for routers and wallets, by arrangement. ${n(p.hostedFree)} free hosted checks per integrator, then ${usd(p.hostedStdAtomic)} per check; each billable check after the first ${n(p.hostedVolAfter)} in a UTC calendar month is ${usd(p.hostedVolAtomic)}. Covers the check and Payment Status; usage tracked; billed monthly by arrangement.`,
      href: "/docs/hosted", link: "Integrator keys" },
    // 0.58.6: the audit layer (x402-spotcheck/audit), the seventh product: free, open source, runs in the buyer's agent
    { id: "audit-layer", name: "Audit layer", price: "Free", unit: "open source (MIT)", free: "Runs in your agent",
      terms: "x402-spotcheck/audit: a per-call ceiling and a daily budget, a wallet deny list and a hash-chained audit ledger, applied inside your agent before a payment is signed. Not a paid check: it never sees your keys and these steps make no network calls.",
      href: NPM_GUARD, link: "npm: x402-spotcheck" },
  ].filter(Boolean);
}

const CSS = `
.pr-hero{padding:64px 0 8px;text-align:center}
.pr-hero h1{font-size:clamp(34px,5vw,52px)}
.pr-lead{font-size:18px;color:var(--text-2);max-width:640px;margin:18px auto 0;line-height:1.55}
.pr-lead strong{color:var(--forest)}
.pr-table-box{margin:36px 0 0;background:#fff;border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:0 10px 30px rgba(60,35,5,.08);overflow:hidden}
table.pr{width:100%;border-collapse:collapse;font-size:15px}
table.pr caption{text-align:left;padding:16px 20px;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);border-bottom:1px solid var(--border)}
table.pr th,table.pr td{padding:16px 20px;text-align:left;vertical-align:top;border-bottom:1px solid var(--bg-subtle)}
table.pr thead th{font-size:12.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3);background:var(--bg-page)}
table.pr tbody tr:last-child th,table.pr tbody tr:last-child td{border-bottom:none}
table.pr tbody th{font-weight:700;color:var(--forest);white-space:nowrap}
.pr-price{font-size:22px;font-weight:800;letter-spacing:-.03em;color:var(--forest);line-height:1.15;white-space:nowrap}
.pr-unit{display:block;font-size:13px;font-weight:500;color:var(--text-3);margin-top:3px;letter-spacing:0}
.pr-free{font-size:12px;font-weight:700;letter-spacing:.03em;background:var(--accent-light);color:var(--accent);padding:4px 9px;border-radius:999px;display:inline-block}
.pr-terms{color:var(--text-2);line-height:1.55;max-width:460px}
.pr-terms code,.pr-notes code{font-family:var(--mono);font-size:.88em;background:var(--bg-subtle);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}
.pr-link{display:inline-block;margin-top:8px;font-weight:600;color:var(--blue)}.pr-link:hover{color:var(--blue-hover);text-decoration:underline}
.pr-notes{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:28px 0 72px}
.pr-note{background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;font-size:14.5px;color:var(--text-2)}
.pr-note h2{font-size:15px;margin:0 0 6px;color:var(--forest);letter-spacing:-.01em}
.pr-note p{margin:0}.pr-note a{color:var(--blue);font-weight:600}
.pr-menu{display:none;position:relative}
.pr-menu summary{list-style:none;width:40px;height:40px;border:1px solid var(--border);background:#fff;border-radius:9px;display:grid;place-items:center;cursor:pointer;color:var(--text)}
.pr-menu summary::-webkit-details-marker{display:none}
.pr-menu nav{position:absolute;right:0;top:48px;background:#fff;border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.12);padding:8px 14px;min-width:220px}
.pr-menu nav a{display:block;padding:10px 4px;font-weight:500;border-bottom:1px solid var(--bg-subtle)}.pr-menu nav a:last-child{border-bottom:none;font-weight:700;color:var(--accent)}
nav.main a[aria-current="page"]{color:var(--accent);font-weight:600}
@media(max-width:900px){.pr-menu{display:block}.pr-notes{grid-template-columns:1fr}}
@media(max-width:760px){
.pr-hero{padding:40px 0 4px}.pr-lead{font-size:16.5px}
.pr-table-box{background:transparent;border:none;box-shadow:none;overflow:visible}
table.pr,table.pr tbody,table.pr tr,table.pr th,table.pr td{display:block;width:100%}
table.pr thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
table.pr caption{display:block;padding:0 2px 12px;border:none}
table.pr tbody tr{background:#fff;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:12px;padding:14px 16px;box-shadow:0 4px 14px rgba(60,35,5,.06)}
table.pr th,table.pr td{padding:4px 0;border:none}
table.pr tbody th{font-size:17px;white-space:normal}
table.pr td[data-label]::before{content:attr(data-label);display:block;font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3);margin-top:8px}
.pr-price{white-space:normal}.pr-terms{max-width:none}
}`;

// p: { freePerDay, freePerIpDay, paidAtomic, erAtomic, watchAtomic, watchDays, trialDays, facilPerMin, facilHostPerMin, hostedFree,
//      hostedVolAfter, hostedStdAtomic, hostedVolAtomic, lookupFreePerDay, lookupAtomic, apiOrigin, endpointReport, watchtower }
export function pricingHtml(origin, p) {
  const rows = pricingRows(p);
  const title = "Pricing · 402xAgent";
  const desc = `402xAgent prices: ${p.freePerDay} free checks a day, then ${usd(p.paidAtomic)} per check. All payments are USDC on Base via x402.`;
  const nav = [["Products", "/#explore"], ["Docs", "/docs"], ["Pricing", "/pricing"], ["Blog", "/blog"], ["Receipts", "/v1/skips"], ["GitHub", GH_GUARD]];
  const navHtml = nav.map(([t, h]) => `<a href="${esc(h)}"${h === "/pricing" ? ' aria-current="page"' : ""}>${t}</a>`).join("");
  const body = rows.map((r) => `<tr id="${r.id}"><th scope="row">${esc(r.name)}</th><td data-label="Price"><span class="pr-price">${esc(r.price)}<span class="pr-unit">${esc(r.unit)}</span></span></td><td data-label="Free tier"><span class="pr-free">${esc(r.free)}</span></td><td data-label="Terms"><div class="pr-terms">${r.terms}</div><a class="pr-link" href="${esc(r.href)}">${esc(r.link)} &rarr;</a></td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#ffffff">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(origin + "/pricing")}">
<link rel="icon" type="image/png" href="${LOGO}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="402xAgent">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(origin + "/pricing")}">
<meta property="og:image" content="https://402xagent.com${LOGO}">
<style>${HOME_CSS}${CSS}</style>
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
<section class="pr-hero">
<h1>Pay per use. <span class="serif">Start free.</span></h1>
<p class="pr-lead"><strong>All payments are USDC on Base via x402.</strong> No account and no key for the free tier. Payment buys access only; it never changes a verdict.</p>
</section>
<div class="pr-table-box">
<table class="pr">
<caption>Prices and terms</caption>
<thead><tr><th scope="col">Product</th><th scope="col">Price</th><th scope="col">Free tier</th><th scope="col">Terms</th></tr></thead>
<tbody>
${body}
</tbody>
</table>
</div>
<div class="pr-notes">
<div class="pr-note"><h2>Free to read</h2><p>Skips, receipts, Bazaar check, badges, rules, OpenAPI and MCP. <a href="/v1/skips">Latest skips</a></p></div>
<div class="pr-note"><h2>Check endpoint</h2><p><code>${esc(p.apiOrigin)}/v1/products/endpoint-spot-check?url=&lt;endpoint&gt;</code></p></div>
<div class="pr-note"><h2>Other API routes</h2><p>Catalog lookup (<code>/v1/lookup</code>): ${n(p.lookupFreePerDay)} free per client per UTC day, then ${usd(p.lookupAtomic)} per call. Details: <a href="/rules">rules</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/docs">docs</a></p></div>
</div>
</div>
</main>
<footer>
<div class="wrap">
<div class="footer-grid">
<div class="footer-brand"><a class="brand" href="/" aria-label="402xAgent home"><span class="footer-logo-chip"><img src="${LOGO}" alt="402xAgent" width="49" height="40"></span></a><p>Verification for the x402 economy. Ask before your agent pays, and keep the receipt.</p></div>
<div><h4>Products</h4><ul><li><a href="/docs/check">402xAgent Check</a></li>${p.endpointReport ? '<li><a href="/docs/endpoint-report">Endpoint Report</a></li>' : ""}<li><a href="/docs/payment-status">Payment Status</a></li>${p.watchtower ? '<li><a href="/docs/watchtower">Watchtower</a></li>' : ""}<li><a href="/docs/facilitator-check">Facilitator Check</a></li><li><a href="/docs/hosted">Hosted Mode</a></li><li><a href="/#audit-layer">Audit layer</a></li></ul></div>
<div><h4>Resources</h4><ul><li><a href="/docs">Docs</a></li><li><a href="/blog">Blog</a></li><li><a href="/v1/skips">Receipts</a></li><li><a href="/pricing">Pricing</a></li><li><a href="${GH_GUARD}">GitHub</a></li><li><a href="${NPM_GUARD}">npm: x402-spotcheck</a></li></ul></div>
<div><h4>Company</h4><ul><li><a href="/health">Status</a></li><li><a href="${GH_REPO}/issues">Contact</a></li><li><a href="/rules">Verdict rules</a></li></ul></div>
</div>
<div class="footer-bottom"><span>402xAgent — verification for the x402 economy.</span><span>402xagent.com · Probes never pay the target</span></div>
</div>
</footer>
</body>
</html>
`;
}
