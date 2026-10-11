// 402xAgent landing page (0.18.0 light redesign around the logo): browser view of https://402xagent.com only. Inline CSS/JS,
// no external fonts or scripts; images are the Worker's own /brand assets. Every example below is a real live answer (re-checked before each release).
import { RECEIPTS_META } from "./receipts-data.js";
import { FREE_CHECK_URL, FREE_CHECK_EXAMPLE_URL, FREE_CHECK_EXAMPLE } from "./spotcheck.js";

const esc = (x) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Real targets and what 402xAgent answered for them (exempt self-test client, twice each, re-checked Oct 10 2026 6:3x PM PT for 0.20.0; the oracle's free trial has ended, back to pay).
export const LANDING_EXAMPLES = [
  { url: "https://api.402rates.com/v1/ping", label: "402rates ping", expect: "pay" },
  { url: "https://api.automaton-sovereign.workers.dev/v2/oracle/base", label: "oracle (2 schemes)", expect: "pay" },
  { url: "https://topagentx402.vercel.app/api/send-token", label: "testnet listing, mainnet 402", expect: "skip" },
  { url: "https://kr-intel-agent-production.up.railway.app/api/briefing", label: "listed, no paywall", expect: "skip" },
];
// A real free-tier answer from api.402xagent.com for the default Try-it URL (receipt sc-67c41ed764517284, Oct 10 2026 6:3x PM PT, Worker 0.20.0), verbatim.
export const LANDING_SAMPLE = {
  "verdict": "pay",
  "reason": "listed $0.001, payment request matches, details locked",
  "payment_terms_sha256": "6ddcc14caebdf8cf0f7eb183c0916b2dc2d36500875d99d039c81e4ea5f2844e",
  "receipt_id": "sc-67c41ed764517284",
  "receipt_url": "https://402xagent.com/v1/receipts/sc-67c41ed764517284",
  "prior_checks": "https://402xagent.com/v1/skips",
  "access": {
    "tier": "free",
    "free_per_day": 1,
    "free_used_today": 1,
    "free_remaining_today": 0,
    "then": "$0.01 USDC on Base for the full check of this endpoint via x402 (HTTP 402)"
  }
};

const V = "18"; // asset cache-buster

export function landingHtml(origin, meta = RECEIPTS_META) {
  const m = meta || {};
  const covered = m.endpoints_covered ?? m.total ?? 0;
  const crawled = String(m.crawled_at || "").slice(0, 10);
  const curl = `curl "https://api.402xagent.com/v1/products/endpoint-spot-check?url=https://api.402rates.com/v1/ping"`;
  const tabs = [
    { id: "fetch", label: "@x402/fetch", code: `import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { spotCheckFetch } from "x402-spotcheck";

// one line: 402xAgent checks the target right before your client pays
const pay = wrapFetchWithPayment(spotCheckFetch(fetch), client);

const res = await pay("https://some-x402-seller.example/api/data"); // throws SpotCheckBlockedError on skip` },
    { id: "axios", label: "@x402/axios", code: `import axios from "axios";
import { wrapAxiosWithPayment } from "@x402/axios";
import { spotCheckAxios } from "x402-spotcheck";

const api = wrapAxiosWithPayment(spotCheckAxios(axios.create()), client);` },
    { id: "curl", label: "curl", code: `${curl}

# free dry run: nothing signed or paid, stored as a public receipt
curl "https://api.402xagent.com/v1/products/endpoint-spot-check?url=https://api.402rates.com/v1/ping&mode=dry-run"` },
  ];
  const desc = "402xAgent checks an x402 endpoint right before your agent pays: one unpaid probe, compared with the listing, answers pay, skip or recheck with the exact payment to sign. Never pays the target.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>402xAgent: check before your agent pays</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://402xagent.com/">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#ffffff">
<meta property="og:type" content="website">
<meta property="og:site_name" content="402xAgent">
<meta property="og:title" content="402xAgent: check before your agent pays">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="https://402xagent.com/">
<meta property="og:image" content="https://402xagent.com/og.png?v=${V}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="402xAgent logo: check before your agent pays">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="402xAgent: check before your agent pays">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="https://402xagent.com/og.png?v=${V}">
<link rel="icon" href="/favicon.ico?v=${V}" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png?v=${V}">
<link rel="icon" type="image/png" sizes="16x16" href="/brand/favicon-16.png?v=${V}">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${V}">
<link rel="preload" as="image" href="/brand/logo-light.png?v=${V}">
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "SoftwareApplication", name: "402xAgent", applicationCategory: "DeveloperApplication", operatingSystem: "Any", url: "https://402xagent.com/", image: "https://402xagent.com/og.png", description: desc, offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "1 free check per client per UTC day" } })}</script>
<style>
:root{--bg:#ffffff;--bg2:#f8fafc;--fg:#0b0b0f;--muted:#475569;--faint:#64748b;--line:#e2e8f0;--line2:#cbd5e1;--orange:#f5a623;--red:#ef4423;--yellow:#ffc93c;--blue:#2f80ed;--grad:linear-gradient(100deg,#ffb238 0%,#f5a623 30%,#ef4423 100%);--code:#0d1117;--codefg:#e6edf3;--pay:#047857;--skip:#c2410c;--recheck:#a16207;--r:14px;--shadow:0 1px 2px rgba(15,23,42,.04),0 6px 24px -8px rgba(15,23,42,.10)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--blue);text-underline-offset:3px}a:hover{text-decoration:none}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
:not(pre)>code{font-size:.9em;background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.wrap{max-width:1100px;margin:0 auto;padding:0 24px}
.skip-link{position:absolute;left:-999px;top:8px;background:var(--fg);color:#fff;padding:8px 12px;border-radius:8px;z-index:9}.skip-link:focus{left:8px}
header.top{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.86);backdrop-filter:saturate(1.8) blur(12px);-webkit-backdrop-filter:saturate(1.8) blur(12px);border-bottom:1px solid var(--line)}
.nav{display:flex;align-items:center;justify-content:space-between;height:64px}
.brand{display:flex;align-items:center;gap:10px;color:var(--fg);text-decoration:none;font-weight:700;letter-spacing:-.02em;font-size:18px}
.brand img{display:block;height:26px;width:auto}
.nav nav{display:flex;gap:4px;font-size:14px;white-space:nowrap;align-items:center}
.nav nav a{color:var(--muted);text-decoration:none;padding:7px 11px;border-radius:8px;font-weight:500}.nav nav a:hover{color:var(--fg);background:var(--bg2)}
.nav nav a.gh{color:var(--fg);border:1px solid var(--line);margin-left:6px}
.hero{position:relative;overflow:hidden;padding:72px 0 64px;text-align:center}
.hero:before{content:"";position:absolute;inset:-40% -10% auto;height:620px;background:radial-gradient(40% 50% at 30% 40%,rgba(245,166,35,.16),transparent 70%),radial-gradient(35% 45% at 72% 35%,rgba(47,128,237,.14),transparent 70%);pointer-events:none}
.hero .wrap{position:relative}
.hero-logo{display:block;margin:0 auto 22px;width:220px;height:auto}
.eyebrow{display:inline-flex;gap:8px;align-items:center;font-size:13px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:5px 12px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--pay);box-shadow:0 0 0 3px rgba(4,120,87,.15)}
h1{font-size:clamp(38px,6.2vw,66px);line-height:1.03;letter-spacing:-.04em;margin:18px auto 16px;max-width:860px;font-weight:800;text-wrap:balance}
.grad{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-size:clamp(17px,2vw,19.5px);color:var(--muted);max-width:660px;margin:0 auto 14px;text-wrap:pretty}
.saves{font-size:15.5px;color:var(--fg);margin:0 auto 30px;max-width:760px;font-weight:600;text-wrap:balance}
.cta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.freecheck{max-width:760px;margin:0 auto 28px;text-align:left;background:#fff;border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:16px 18px;position:relative;overflow:hidden}
.freecheck:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--grad)}
.fc-h{margin:0 0 8px;font-weight:650;font-size:15px}.fc-tag{display:inline-block;font:700 11px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:var(--pay);padding:4px 7px;border-radius:6px;margin-right:6px;vertical-align:1px}
.freecheck code{display:block;font-size:13px;line-height:1.55;background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;overflow-wrap:anywhere;white-space:pre-wrap;color:var(--fg)}
.fc-ex{margin:10px 0 6px;font-size:13.5px;color:var(--muted)}.fc-then{margin:10px 0 0;font-size:13.5px;color:var(--muted)}
.btn{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 20px;border-radius:10px;font-weight:600;font-size:15px;text-decoration:none;border:1px solid var(--line2);color:var(--fg);background:#fff;cursor:pointer;font-family:inherit}
.btn:hover{border-color:var(--fg)}
.btn.primary{background:var(--fg);color:#fff;border-color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.1),0 6px 18px -6px rgba(239,68,35,.45)}
.btn.primary:hover{background:#1f1f27}
.btn:disabled{opacity:.6;cursor:progress}
:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
section{padding:80px 0}
section.alt{background:var(--bg2);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.kicker{margin:0 0 8px;font-size:12.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--red)}
.kicker.blue{color:var(--blue)}
h2{font-size:clamp(28px,3.4vw,38px);letter-spacing:-.03em;line-height:1.12;margin:0 0 12px;font-weight:750}
.lead{color:var(--muted);margin:0 0 32px;max-width:680px}
.card{background:#fff;border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}
.try{padding:24px}
.row{display:flex;gap:10px;flex-wrap:wrap}
.row input{flex:1 1 360px;min-width:0;height:48px;padding:0 14px;border-radius:10px;border:1px solid var(--line2);background:#fff;color:var(--fg);font:15px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.row input:focus{border-color:var(--blue);outline:3px solid rgba(47,128,237,.18);outline-offset:0}
.row .btn{height:48px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 0}
.chip{font:500 13px ui-sans-serif,system-ui,sans-serif;border:1px solid var(--line);background:var(--bg2);color:var(--fg);border-radius:999px;padding:6px 12px;cursor:pointer}
.chip:hover{border-color:var(--orange);background:#fff}
.result{margin-top:18px;border-radius:12px;border:1px dashed var(--line2);padding:18px;min-height:78px;color:var(--faint);background:var(--bg2)}
.result.filled{border-style:solid;border-color:var(--line);color:var(--fg);background:#fff}
.verdict{display:inline-block;font:700 12.5px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;padding:6px 10px;border-radius:7px;margin-right:10px;color:#fff;vertical-align:1px}
.v-pay{background:var(--pay)}.v-skip{background:var(--skip)}.v-recheck{background:#facc15;color:#422006}
.note{font-size:13.5px;color:var(--muted);margin-top:10px}
details.sample{margin-top:18px}
details.sample summary{cursor:pointer;display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:14px;color:var(--fg);border:1px solid var(--line2);border-radius:9px;padding:7px 13px;background:#fff;list-style:none}
details.sample summary::-webkit-details-marker{display:none}
details.sample summary:before{content:"";width:0;height:0;border-left:5px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .15s}
details.sample[open] summary:before{transform:rotate(90deg)}
.cap{font-size:13px;color:var(--muted);margin:12px 0 8px}
pre{margin:0;background:var(--code);color:var(--codefg);padding:20px 22px;overflow-x:auto;font-size:13.5px;line-height:1.7;border-radius:12px}
.samplepre{border:1px solid #1f2937}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.step{padding:26px}.step b{display:block;font-size:17px;margin:12px 0 6px;letter-spacing:-.01em}.step p{margin:0;color:var(--muted);font-size:15px}
.num{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:9px;color:#fff;font-weight:800;font-size:14px}
.n1{background:var(--grad)}.n2{background:var(--fg)}.n3{background:var(--blue)}
.t-pay{color:var(--pay)}.t-skip{color:var(--skip)}.t-recheck{color:var(--recheck)}
.tabs{overflow:hidden;background:var(--code);border-color:#1f2937}
.tablist{display:flex;gap:2px;border-bottom:1px solid #1f2937;padding:8px 8px 0;background:#0b0f14;overflow-x:auto}
.tab{border:0;background:transparent;color:#94a3b8;font:600 13.5px ui-sans-serif,system-ui,sans-serif;padding:10px 14px;border-radius:8px 8px 0 0;cursor:pointer;white-space:nowrap}
.tab:hover{color:#e2e8f0}
.tab[aria-selected=true]{background:var(--code);color:#fff;box-shadow:inset 0 2px 0 var(--orange)}
.tabs pre{border-radius:0}
.copy{margin:0 4px 6px auto;align-self:center;font:600 12px ui-sans-serif,system-ui,sans-serif;background:#1f2937;color:#e5e7eb;border:1px solid #334155;border-radius:7px;padding:5px 11px;cursor:pointer}
.copy:hover{background:#273244}
.bigprice{font-size:clamp(30px,4.4vw,46px);font-weight:800;letter-spacing:-.035em;line-height:1.08;margin:0 0 10px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.price{padding:22px 24px;position:relative;overflow:hidden}
.price:before{content:"";position:absolute;left:0;right:0;top:0;height:3px}
.p1:before{background:var(--grad)}.p2:before{background:var(--fg)}.p3:before{background:var(--blue)}
.price h3{margin:0;font-size:13px;color:var(--faint);font-weight:700;text-transform:uppercase;letter-spacing:.07em}
.tiers .price p{margin:8px 0 0;font-size:14.5px;color:var(--muted)}.tiers .price b{color:var(--fg);font-weight:700}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:22px}
.stat{padding:20px 22px}.stat .n{font-size:34px;font-weight:800;letter-spacing:-.03em;line-height:1.1}.stat .l{color:var(--muted);font-size:14px;margin-top:4px}
.n.pay{color:var(--pay)}.n.skip{color:var(--skip)}.n.recheck{color:var(--recheck)}
.offer{padding:34px;display:flex;gap:24px;align-items:center;justify-content:space-between;flex-wrap:wrap;position:relative;overflow:hidden}
.offer:after{content:"";position:absolute;inset:0;background:radial-gradient(50% 120% at 100% 0%,rgba(245,166,35,.13),transparent 60%),radial-gradient(40% 100% at 0% 100%,rgba(47,128,237,.10),transparent 60%);pointer-events:none}
.offer>*{position:relative}
.offer h2{margin:0 0 6px}.offer p{margin:0;color:var(--muted);max-width:620px}
footer{border-top:1px solid var(--line);padding:32px 0 44px;color:var(--muted);font-size:14px;background:#fff}
footer .wrap{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
footer nav{display:flex;gap:18px;flex-wrap:wrap}footer a{color:var(--muted)}footer a:hover{color:var(--fg)}
.foot-brand{display:flex;align-items:center;gap:10px}.foot-brand img{height:20px;width:auto}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:820px){.steps,.grid3{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.nav nav a.hide-sm{display:none}.hero{padding:48px 0 44px}section{padding:60px 0}.hero-logo{width:180px}}
@media (max-width:560px){.wrap{padding:0 18px}.row .btn{flex:1 1 100%;justify-content:center}.tab{padding:9px 10px;font-size:13px}.tablist{padding:6px 8px 0 6px}pre{font-size:12.5px;padding:16px}.try{padding:16px}.brand span{font-size:17px}.nav nav a.gh{margin-left:2px}.offer{padding:24px}}
@media (prefers-reduced-motion:no-preference){.btn,.chip,.tab,.nav nav a{transition:background .15s,border-color .15s,color .15s}}
</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="top"><div class="wrap nav">
  <a class="brand" href="/" aria-label="402xAgent home"><img src="/brand/mark-402.png?v=${V}" width="50" height="26" alt=""><span>402xAgent</span></a>
  <nav aria-label="Primary"><a href="#try">Try it</a><a class="hide-sm" href="#code">Code</a><a class="hide-sm" href="#pricing">Pricing</a><a class="gh" href="https://github.com/withgrokbot/x402-spotcheck">GitHub</a></nav>
</div></header>
<main id="main">
<div class="hero"><div class="wrap">
  <img class="hero-logo" src="/brand/logo-light.png?v=${V}" width="560" height="459" alt="402xAgent logo">
  <span class="eyebrow"><span class="dot" aria-hidden="true"></span>${esc(covered)} x402 endpoints self-checked · ${esc(crawled)}</span>
  <h1>Check before your <span class="grad">agent pays</span></h1>
  <p class="sub">402xAgent probes an x402 endpoint once, unpaid, compares the live 402 with its listing, and tells your agent to pay, skip or recheck, with the exact payment to sign.</p>
  <p class="saves">Stops your agent paying dead, mispriced or wrong-network endpoints, or the wrong token or payee.</p>
  <div class="freecheck" aria-label="Free check">
    <p class="fc-h"><span class="fc-tag">Free</span> Check any x402 endpoint first, no payment, no key:</p>
    <code class="fc-url">GET ${esc(FREE_CHECK_URL)}</code>
    <p class="fc-ex">Real answer for <a href="${esc(FREE_CHECK_EXAMPLE_URL)}">api.402rates.com/v1/ping</a>:</p>
    <code class="fc-res">${esc(JSON.stringify(FREE_CHECK_EXAMPLE))}</code>
    <p class="fc-then">Then, only if you want the full payment terms: the paid check (HTTP 402, from $0.01).</p>
  </div>
  <div class="cta"><a class="btn primary" href="#try">Try it</a><a class="btn" href="https://github.com/withgrokbot/x402-spotcheck"><svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub</a></div>
</div></div>

<section id="try" class="alt" aria-labelledby="try-h"><div class="wrap">
  <p class="kicker">Live</p>
  <h2 id="try-h">Try it</h2>
  <p class="lead">Paste a paid x402 URL. This runs the real free 402xAgent check: one per day per network, then a free dry run (nothing signed or paid, never an approval).</p>
  <div class="card try">
    <form id="f" class="row" novalidate>
      <label class="sr" for="u">Endpoint URL</label>
      <input id="u" name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://seller.example/api/paid" value="${esc(LANDING_EXAMPLES[0].url)}" required>
      <button class="btn primary" type="submit" id="go">Check</button>
    </form>
    <div class="chips" role="group" aria-label="Example endpoints">${LANDING_EXAMPLES.map((e) => `<button type="button" class="chip" data-u="${esc(e.url)}">${esc(e.label)}</button>`).join("")}</div>
    <div class="result" id="out" aria-live="polite">Pick an example or paste a URL, then press Check.</div>
    <details class="sample" id="resp">
      <summary>Show response</summary>
      <p class="cap" id="respcap">A real free answer from api.402xagent.com (receipt <a href="/v1/receipts/${esc(LANDING_SAMPLE.receipt_id)}">${esc(LANDING_SAMPLE.receipt_id)}</a>). Paid checks add the payment object: network, canonical USDC, amount, pay_to, deadline.</p>
      <pre class="samplepre" tabindex="0"><code id="respcode">${esc(JSON.stringify(LANDING_SAMPLE, null, 2))}</code></pre>
    </details>
  </div>
</div></section>

<section aria-labelledby="how-h"><div class="wrap">
  <p class="kicker blue">How it works</p>
  <h2 id="how-h">Three steps before the payment leaves your agent</h2>
  <p class="lead">One unpaid probe, one comparison, one decision. Every check leaves a public receipt.</p>
  <div class="steps">
    <div class="card step"><span class="num n1">1</span><b>Probe</b><p>One unpaid, SSRF-safe request to the target. 402xAgent never pays it. The probe is reused for 5 minutes, so two checks in a row agree.</p></div>
    <div class="card step"><span class="num n2">2</span><b>Compare</b><p>The live 402 against the listing: price, network (supported mainnets), the canonical USDC contract and pay_to.</p></div>
    <div class="card step"><span class="num n3">3</span><b>Decide</b><p><strong class="t-pay">pay</strong> with the exact terms to sign, <strong class="t-skip">skip</strong> on a mismatch or no paywall, <strong class="t-recheck">recheck</strong> only for timeouts, 5xx or an active free trial.</p></div>
  </div>
</div></section>

<section id="code" class="alt" aria-labelledby="code-h"><div class="wrap">
  <p class="kicker">Integrate</p>
  <h2 id="code-h">One line in your x402 client</h2>
  <p class="lead"><code>npm i github:withgrokbot/x402-spotcheck</code>. Requests without a payment pass straight through; on skip the payment header is never sent.</p>
  <div class="card tabs">
    <div class="tablist" role="tablist" aria-label="Code examples">${tabs.map((t, i) => `<button class="tab" role="tab" id="t-${t.id}" aria-controls="p-${t.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(t.label)}</button>`).join("")}<button class="copy" type="button" id="copy" aria-label="Copy the code shown">Copy</button></div>
    ${tabs.map((t, i) => `<div role="tabpanel" id="p-${t.id}" aria-labelledby="t-${t.id}"${i === 0 ? "" : " hidden"}><pre tabindex="0"><code>${esc(t.code)}</code></pre></div>`).join("")}
  </div>
</div></section>

<section id="pricing" aria-labelledby="pricing-h"><div class="wrap">
  <p class="kicker">Pricing</p>
  <h2 id="pricing-h" class="bigprice">Free to try, paid checks from $0.01</h2>
  <p class="lead">USDC on Base via x402. No account, no key.</p>
  <div class="grid3 tiers">
    <div class="card price p1"><h3>Free</h3><p><b>$0</b>: 1 check per client per UTC day (verdict, plain-words reason and a hash of the approved terms). Dry runs are free too.</p></div>
    <div class="card price p2"><h3>Paid check</h3><p><b>1/10 of the target's price</b>, $0.01 min to $0.25 max. Full detail plus the payment object to sign.</p></div>
    <div class="card price p3"><h3>Router tier</h3><p><b>$0.001/check</b> in packs of 10, billed as one $0.01 x402 payment; the other 9 are prepaid on your router id.</p></div>
  </div>
</div></section>

<section class="alt" aria-labelledby="skips-h"><div class="wrap">
  <p class="kicker blue">Receipts</p>
  <h2 id="skips-h">What it finds</h2>
  <p class="lead">Our weekly self-checked crawl of listed x402 endpoints (crawl of ${esc(crawled)}, UTC). Each row has a public receipt.</p>
  <div class="stats">
    <div class="card stat"><div class="n">${esc(covered)}</div><div class="l">endpoints checked</div></div>
    <div class="card stat"><div class="n pay">${esc(m.pay ?? 0)}</div><div class="l">pay</div></div>
    <div class="card stat"><div class="n skip">${esc(m.skip ?? 0)}</div><div class="l">skip</div></div>
    <div class="card stat"><div class="n recheck">${esc(m.recheck ?? 0)}</div><div class="l">recheck</div></div>
  </div>
  <div class="cta" style="justify-content:flex-start"><a class="btn" href="/v1/skips">See the skips →</a><a class="btn" href="/v1/receipts?type=dry-run">Recent receipts</a></div>
</div></section>

<section aria-labelledby="offer-h"><div class="wrap">
  <div class="card offer">
    <div><h2 id="offer-h">First router integration gets 1,000 free checks</h2><p>Building a router or agent framework on x402? The first one to integrate 402xAgent gets 1,000 full checks (paid-tier detail, no payment). Tell us on GitHub and we'll set you up privately.</p></div>
    <a class="btn primary" href="https://github.com/withgrokbot/x402-spotcheck/issues/new?title=Router%20integration%3A%20free%20checks">Open an issue</a>
  </div>
</div></section>
</main>
<footer><div class="wrap">
  <div class="foot-brand"><img src="/brand/mark-402.png?v=${V}" width="38" height="20" alt=""><span>Made by <a href="https://github.com/withgrokbot">withgrokbot</a> · API: <span class="mono">api.402xagent.com</span></span></div>
  <nav aria-label="Footer"><a href="https://github.com/withgrokbot/x402-spotcheck">GitHub</a><a href="/mcp" title="Remote MCP endpoint (POST JSON-RPC)">MCP (/mcp)</a><a href="/llms.txt">llms.txt</a><a href="/openapi.json">OpenAPI</a><a href="/v1/skips">Skips</a></nav>
</div></footer>
<script>
(()=>{const $=(s)=>document.querySelector(s),out=$("#out"),u=$("#u"),go=$("#go");
const E=(s)=>String(s??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const setResp=(j,dry)=>{document.getElementById("respcode").textContent=JSON.stringify(j,null,2);document.getElementById("respcap").textContent=dry?"Raw response from this free dry run.":"Raw response from this check.";};
const show=(j,extra)=>{const v=String(j.verdict||"");out.className="result filled";out.innerHTML='<span class="verdict v-'+E(v)+'">'+E(v)+'</span><span>'+E(j.reason)+'</span>'+(j.receipt_url?'<div class="note">Receipt: <a href="'+E(new URL(j.receipt_url).pathname)+'">'+E(j.receipt_id||j.receipt_url)+'</a></div>':'')+(extra?'<div class="note">'+extra+'</div>':'');};
const msg=(t)=>{out.className="result filled";out.innerHTML=t;};
const call=async(url,dry)=>{const q=new URLSearchParams({url});if(dry)q.set("mode","dry-run");else q.set("ref","via-402xagent-site");return fetch("/v1/products/endpoint-spot-check?"+q,{headers:{accept:"application/json"}});};
async function run(e){if(e)e.preventDefault();const url=u.value.trim();if(!/^https?:\\/\\//i.test(url)){msg("Enter a full http(s) URL.");u.focus();return;}
go.disabled=true;msg("Checking…");try{let r=await call(url,false);let j=await r.json().catch(()=>({}));
if(r.status===200){setResp(j,false);show(j,j.access&&j.access.tier==="free"?"Free check: "+E(j.access.free_remaining_today)+" left today. Full detail and the payment object are in the paid check.":"");}
else if(r.status===402){const r2=await call(url,true),j2=await r2.json().catch(()=>({}));
if(r2.status===200){setResp(j2,true);show(j2,"Today's free check is used, so this is a free dry run: nothing signed or paid, and not an approval to pay. A full check costs "+E(j.price_usd?"$"+j.price_usd:"$0.01+")+" in USDC on Base via x402.");}
else if(r2.status===429)msg("Today's free check and dry runs are used up from this network. They reset at 00:00 UTC.");else msg(E(j2.error||("Dry run failed: HTTP "+r2.status)));}
else if(r.status===400)msg(E(j.error||("Bad request: "+(j.reason||r.status))));
else msg("Unexpected answer: HTTP "+r.status);}catch(err){msg("Could not reach 402xAgent. Try again.");}finally{go.disabled=false;}}
$("#f").addEventListener("submit",run);
document.querySelectorAll(".chip").forEach((b)=>b.addEventListener("click",()=>{u.value=b.dataset.u;run();}));
const tabs=[...document.querySelectorAll(".tab")];const sel=(t)=>{tabs.forEach((x)=>{const on=x===t;x.setAttribute("aria-selected",on);x.tabIndex=on?0:-1;document.getElementById(x.getAttribute("aria-controls")).hidden=!on;});t.focus();};
tabs.forEach((t,i)=>{t.addEventListener("click",()=>sel(t));t.addEventListener("keydown",(e)=>{if(e.key==="ArrowRight")sel(tabs[(i+1)%tabs.length]);if(e.key==="ArrowLeft")sel(tabs[(i-1+tabs.length)%tabs.length]);});});
const cb=$("#copy");cb.addEventListener("click",async()=>{const c=document.querySelector('[role=tabpanel]:not([hidden]) code');try{await navigator.clipboard.writeText(c.textContent);cb.textContent="Copied";setTimeout(()=>cb.textContent="Copy",1500);}catch(_){}});
})();
</script>
</body>
</html>`;
}
