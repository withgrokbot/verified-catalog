// PayScout landing page (0.16.0): browser view of https://payscout.dev only. Single file: inline CSS/JS, no external
// fonts, scripts or images. Every example below is a real live answer (re-checked before each release).
import { RECEIPTS_META } from "./receipts-data.js";

const esc = (x) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Real targets and what PayScout answered for them (exempt self-test client, twice each, Oct 10 2026).
export const LANDING_EXAMPLES = [
  { url: "https://api.402rates.com/v1/ping", label: "402rates ping", expect: "pay" },
  { url: "https://api.automaton-sovereign.workers.dev/v2/oracle/base", label: "oracle (2 schemes)", expect: "pay" },
  { url: "https://topagentx402.vercel.app/api/send-token", label: "testnet listing, mainnet 402", expect: "skip" },
  { url: "https://kr-intel-agent-production.up.railway.app/api/briefing", label: "listed, no paywall", expect: "skip" },
];
// A real free-tier answer from payscout.dev for the default Try-it URL (receipt sc-d1e1b9b528323991, Oct 10 2026 PT), verbatim.
export const LANDING_SAMPLE = {
  "verdict": "pay",
  "reason": "listed $0.001, payment request matches, details locked",
  "payment_terms_sha256": "6ddcc14caebdf8cf0f7eb183c0916b2dc2d36500875d99d039c81e4ea5f2844e",
  "receipt_id": "sc-d1e1b9b528323991",
  "receipt_url": "https://payscout.dev/v1/receipts/sc-d1e1b9b528323991",
  "access": {
    "tier": "free",
    "free_per_day": 1,
    "free_used_today": 1,
    "free_remaining_today": 0,
    "then": "$0.01 USDC on Base for the full check of this endpoint via x402 (HTTP 402)"
  }
};

const WORDMARK = `<svg class="mark" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false"><rect width="28" height="28" rx="7" fill="var(--accent)"/><circle cx="12.5" cy="12.5" r="5.5" fill="none" stroke="#fff" stroke-width="2.4"/><path d="M16.6 16.6 21.5 21.5" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><path d="m10 12.6 1.9 1.9 3.3-3.6" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function landingHtml(origin, meta = RECEIPTS_META) {
  const m = meta || {};
  const covered = m.endpoints_covered ?? m.total ?? 0;
  const crawled = String(m.crawled_at || "").slice(0, 10);
  const curl = `curl "${origin}/v1/products/endpoint-spot-check?url=https://api.402rates.com/v1/ping"`;
  const tabs = [
    { id: "fetch", label: "@x402/fetch", code: `import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { spotCheckFetch } from "x402-spotcheck";

// one line: PayScout checks the target right before your client pays
const pay = wrapFetchWithPayment(spotCheckFetch(fetch), client);

const res = await pay("https://some-x402-seller.example/api/data"); // throws SpotCheckBlockedError on skip` },
    { id: "axios", label: "@x402/axios", code: `import axios from "axios";
import { wrapAxiosWithPayment } from "@x402/axios";
import { spotCheckAxios } from "x402-spotcheck";

const api = wrapAxiosWithPayment(spotCheckAxios(axios.create()), client);` },
    { id: "curl", label: "curl", code: `${curl}

# free dry run: nothing signed or paid, stored as a public receipt
curl "${origin}/v1/products/endpoint-spot-check?url=https://api.402rates.com/v1/ping&mode=dry-run"` },
  ];
  const desc = "PayScout checks an x402 endpoint right before your agent pays: one unpaid probe, compared with the listing, answers pay, skip or recheck with the exact payment to sign. Never pays the target.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PayScout: check before your agent pays</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://payscout.dev/">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0b0d12" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="PayScout">
<meta property="og:title" content="PayScout: check before your agent pays">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="https://payscout.dev/">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="PayScout: check before your agent pays">
<meta name="twitter:description" content="${esc(desc)}">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(WORDMARK.replace('class="mark" ', "").replace("var(--accent)", "#5b5bf7").replace(' aria-hidden="true" focusable="false"', ' xmlns="http://www.w3.org/2000/svg"'))}">
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "SoftwareApplication", name: "PayScout", alternateName: "Spot-Check", applicationCategory: "DeveloperApplication", operatingSystem: "Any", url: "https://payscout.dev/", description: desc, offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "1 free check per client per UTC day" } })}</script>
<style>
:root{--bg:#ffffff;--bg2:#f6f7f9;--fg:#0b0d12;--muted:#5b6170;--line:#e4e6eb;--accent:#5b5bf7;--accent2:#7c5cff;--code:#0f1117;--codefg:#e6e8ee;--pay:#0e8a4f;--skip:#c2410c;--recheck:#a16207;--card:#ffffff;--shadow:0 1px 2px rgba(16,24,40,.06),0 8px 24px rgba(16,24,40,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--bg2:#11141b;--fg:#eef0f4;--muted:#9aa1b1;--line:#232835;--accent:#7b7bff;--accent2:#9d84ff;--code:#0d1016;--codefg:#e6e8ee;--pay:#34d399;--skip:#fb923c;--recheck:#facc15;--card:#12151d;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35)}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}a:hover{text-decoration:none}
code,pre,kbd,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
.skip-link{position:absolute;left:-999px;top:8px;background:var(--fg);color:var(--bg);padding:8px 12px;border-radius:8px;z-index:9}.skip-link:focus{left:8px}
header.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:saturate(1.6) blur(10px);border-bottom:1px solid var(--line)}
.nav{display:flex;align-items:center;justify-content:space-between;height:60px}
.brand{display:flex;align-items:center;gap:10px;color:var(--fg);text-decoration:none;font-weight:650;letter-spacing:-.01em;font-size:18px}
.brand small{font-weight:500;color:var(--muted);font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.nav nav{display:flex;gap:20px;font-size:14px;white-space:nowrap}.nav nav a{color:var(--muted);text-decoration:none}.nav nav a:hover{color:var(--fg)}
.hero{padding:88px 0 56px;text-align:center;background:radial-gradient(60% 50% at 50% 0%,color-mix(in srgb,var(--accent) 16%,transparent),transparent 70%)}
.eyebrow{display:inline-flex;gap:8px;align-items:center;font-size:13px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:4px 12px;background:var(--card)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--pay);box-shadow:0 0 0 3px color-mix(in srgb,var(--pay) 25%,transparent)}
h1{font-size:clamp(38px,6.4vw,68px);line-height:1.04;letter-spacing:-.035em;margin:20px auto 16px;max-width:900px;text-wrap:balance;font-weight:720}
h1 .grad{background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-size:clamp(17px,2.1vw,20px);color:var(--muted);max-width:640px;margin:0 auto 32px}
.cta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 20px;border-radius:10px;font-weight:600;font-size:15px;text-decoration:none;border:1px solid var(--line);color:var(--fg);background:var(--card);cursor:pointer}
.btn.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}.btn:focus-visible,button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
section{padding:72px 0;border-top:1px solid var(--line)}
h2{font-size:clamp(26px,3.4vw,36px);letter-spacing:-.025em;line-height:1.15;margin:0 0 12px}
.lead{color:var(--muted);margin:0 0 32px;max-width:680px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}
.try{padding:24px}
.row{display:flex;gap:10px;flex-wrap:wrap}
.row input{flex:1 1 360px;min-width:0;height:46px;padding:0 14px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:15px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 0}
.chip{font-size:13px;border:1px solid var(--line);background:var(--bg2);color:var(--fg);border-radius:999px;padding:5px 12px;cursor:pointer}
.chip:hover{border-color:var(--accent)}
.result{margin-top:20px;border-radius:12px;border:1px dashed var(--line);padding:18px;min-height:76px;color:var(--muted)}
.result.filled{border-style:solid;color:var(--fg)}
.verdict{display:inline-block;font:700 13px/1 ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;padding:6px 10px;border-radius:7px;margin-right:10px;color:#fff}
.v-pay{background:var(--pay)}.v-skip{background:var(--skip)}.v-recheck{background:var(--recheck);color:#1a1300}
.note{font-size:13px;color:var(--muted);margin-top:10px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;counter-reset:s}
.step{padding:24px}.step b{display:block;font-size:17px;margin:6px 0}.step p{margin:0;color:var(--muted);font-size:15px}
.num{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:8px;background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);font-weight:700;font-size:14px}
.tabs{overflow:hidden}
.tablist{display:flex;gap:2px;border-bottom:1px solid var(--line);padding:8px 8px 0;background:var(--bg2);overflow-x:auto}
.tab{border:0;background:transparent;color:var(--muted);font:600 14px ui-sans-serif,system-ui,sans-serif;padding:10px 14px;border-radius:8px 8px 0 0;cursor:pointer;white-space:nowrap}
.tab[aria-selected=true]{background:var(--code);color:var(--codefg)}
pre{margin:0;background:var(--code);color:var(--codefg);padding:20px;overflow-x:auto;font-size:13.5px;line-height:1.65}
.tabs pre{border-radius:0}
.copy{margin:0 0 6px auto;align-self:center;font:600 12px ui-sans-serif,system-ui,sans-serif;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
.sample{margin-top:24px;border-radius:12px;overflow:hidden}
.samplepre{border-radius:12px;border:1px solid var(--line)}
.sample .cap{font-size:13px;color:var(--muted);margin:0 0 8px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.price{padding:24px}.price h3{margin:0 0 4px;font-size:15px;color:var(--muted);font-weight:600}.price .amt{font-size:30px;font-weight:720;letter-spacing:-.02em}.price p{color:var(--muted);font-size:14.5px;margin:8px 0 0}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px}
.stat{padding:20px}.stat .n{font-size:32px;font-weight:720;letter-spacing:-.02em}.stat .l{color:var(--muted);font-size:14px}
.t-pay{color:var(--pay)}.t-skip{color:var(--skip)}.t-recheck{color:var(--recheck)}
.n.pay{color:var(--pay)}.n.skip{color:var(--skip)}.n.recheck{color:var(--recheck)}
.offer{padding:32px;display:flex;gap:24px;align-items:center;justify-content:space-between;flex-wrap:wrap;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 12%,var(--card)),var(--card))}
.offer h2{margin:0 0 6px}.offer p{margin:0;color:var(--muted);max-width:620px}
footer{border-top:1px solid var(--line);padding:32px 0 48px;color:var(--muted);font-size:14px}
footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}footer nav{display:flex;gap:18px;flex-wrap:wrap}footer a{color:var(--muted)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:560px){.brand small{display:none}.tab{padding:9px 10px;font-size:13px}.tablist{padding:6px 10px 0 6px}.nav nav{gap:16px}pre{font-size:12.5px;padding:16px}.try{padding:16px}}
@media (max-width:820px){.steps,.grid3{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.nav nav a.hide-sm{display:none}.hero{padding:56px 0 40px}section{padding:56px 0}}
@media (prefers-reduced-motion:no-preference){.btn,.chip,.tab{transition:background .15s,border-color .15s,color .15s}}
</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="top"><div class="wrap nav">
  <a class="brand" href="/" aria-label="PayScout home">${WORDMARK}<span>PayScout</span><small>formerly Spot-Check</small></a>
  <nav aria-label="Primary"><a href="#try">Try it</a><a class="hide-sm" href="#code">Code</a><a class="hide-sm" href="#pricing">Pricing</a><a href="https://github.com/withgrokbot/x402-spotcheck">GitHub</a></nav>
</div></header>
<main id="main">
<div class="hero"><div class="wrap">
  <span class="eyebrow"><span class="dot" aria-hidden="true"></span>${esc(covered)} x402 endpoints self-checked · ${esc(crawled)}</span>
  <h1>Check before your <span class="grad">agent pays</span></h1>
  <p class="sub">PayScout probes an x402 endpoint once, unpaid, compares the live 402 with its listing, and tells your agent to pay, skip or recheck, with the exact payment to sign.</p>
  <div class="cta"><a class="btn primary" href="#try">Try it</a><a class="btn" href="https://github.com/withgrokbot/x402-spotcheck"><svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub</a></div>
</div></div>

<section id="try" aria-labelledby="try-h"><div class="wrap">
  <h2 id="try-h">Try it</h2>
  <p class="lead">Paste a paid x402 URL. This runs the real free check on payscout.dev: one per day per network, then a free dry run (nothing signed or paid, never an approval).</p>
  <div class="card try">
    <form id="f" class="row" novalidate>
      <label class="sr" for="u">Endpoint URL</label>
      <input id="u" name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://seller.example/api/paid" value="${esc(LANDING_EXAMPLES[0].url)}" required>
      <button class="btn primary" type="submit" id="go">Check</button>
    </form>
    <div class="chips" role="group" aria-label="Example endpoints">${LANDING_EXAMPLES.map((e) => `<button type="button" class="chip" data-u="${esc(e.url)}">${esc(e.label)}</button>`).join("")}</div>
    <div class="result" id="out" aria-live="polite">Pick an example or paste a URL, then press Check.</div>
  </div>
  <div class="sample">
    <p class="cap">A real free answer from payscout.dev (receipt <a href="/v1/receipts/${esc(LANDING_SAMPLE.receipt_id)}">${esc(LANDING_SAMPLE.receipt_id)}</a>). Paid checks add the payment object: network, canonical USDC, amount, pay_to, deadline.</p>
    <pre class="samplepre" tabindex="0"><code>${esc(JSON.stringify(LANDING_SAMPLE, null, 2))}</code></pre>
  </div>
</div></section>

<section aria-labelledby="how-h"><div class="wrap">
  <h2 id="how-h">How it works</h2>
  <p class="lead">Three steps, right before the payment leaves your agent.</p>
  <div class="steps">
    <div class="card step"><span class="num">1</span><b>Probe</b><p>One unpaid, SSRF-safe request to the target. PayScout never pays it. The probe is reused for 5 minutes, so two checks in a row agree.</p></div>
    <div class="card step"><span class="num">2</span><b>Compare</b><p>The live 402 against the listing: price, network (supported mainnets), the canonical USDC contract and pay_to.</p></div>
    <div class="card step"><span class="num">3</span><b>Decide</b><p><strong class="t-pay">pay</strong> with the exact terms to sign, <strong class="t-skip">skip</strong> on a mismatch or no paywall, <strong class="t-recheck">recheck</strong> only for timeouts, 5xx or an active free trial. Every check leaves a public receipt.</p></div>
  </div>
</div></section>

<section id="code" aria-labelledby="code-h"><div class="wrap">
  <h2 id="code-h">One line in your x402 client</h2>
  <p class="lead"><code>npm i github:withgrokbot/x402-spotcheck</code>. Requests without a payment pass straight through; on skip the payment header is never sent.</p>
  <div class="card tabs">
    <div class="tablist" role="tablist" aria-label="Code examples">${tabs.map((t, i) => `<button class="tab" role="tab" id="t-${t.id}" aria-controls="p-${t.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(t.label)}</button>`).join("")}<button class="copy" type="button" id="copy" aria-label="Copy the code shown">Copy</button></div>
    ${tabs.map((t, i) => `<div role="tabpanel" id="p-${t.id}" aria-labelledby="t-${t.id}"${i === 0 ? "" : " hidden"}><pre tabindex="0"><code>${esc(t.code)}</code></pre></div>`).join("")}
  </div>
</div></section>

<section id="pricing" aria-labelledby="pricing-h"><div class="wrap">
  <h2 id="pricing-h">Pricing</h2>
  <p class="lead">USDC on Base via x402. No account, no key.</p>
  <div class="grid3">
    <div class="card price"><h3>Free</h3><div class="amt">$0</div><p>1 check per client per UTC day: verdict, plain-words reason and a hash of the approved terms. Dry runs are free too.</p></div>
    <div class="card price"><h3>Paid check</h3><div class="amt">$0.01–$0.25</div><p>One tenth of the target's quoted price, minimum $0.01, maximum $0.25. Full detail plus the payment object to sign.</p></div>
    <div class="card price"><h3>Router tier</h3><div class="amt">$0.001<span style="font-size:16px;color:var(--muted);font-weight:500"> / check</span></div><p>Billed in packs of 10 checks as one $0.01 x402 payment; the other 9 are prepaid on your router id.</p></div>
  </div>
</div></section>

<section aria-labelledby="skips-h"><div class="wrap">
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
    <div><h2 id="offer-h">First router integration gets 1,000 free checks</h2><p>Building a router or agent framework on x402? The first one to integrate PayScout gets 1,000 full checks (paid-tier detail, no payment). Tell us on GitHub and we'll set you up privately.</p></div>
    <a class="btn primary" href="https://github.com/withgrokbot/x402-spotcheck/issues/new?title=Router%20integration%3A%20free%20checks">Open an issue</a>
  </div>
</div></section>
</main>
<footer><div class="wrap">
  <nav aria-label="Footer"><a href="https://github.com/withgrokbot/x402-spotcheck">GitHub</a><a href="/mcp" title="Remote MCP endpoint (POST JSON-RPC)">MCP (/mcp)</a><a href="/llms.txt">llms.txt</a><a href="/openapi.json">OpenAPI</a><a href="/v1/skips">Skips</a></nav>
  <span>Made by <a href="https://github.com/withgrokbot">withgrokbot</a> · API: <span class="mono">api.payscout.dev</span></span>
</div></footer>
<script>
(()=>{const $=(s)=>document.querySelector(s),out=$("#out"),u=$("#u"),go=$("#go");
const E=(s)=>String(s??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const show=(j,extra)=>{const v=String(j.verdict||"");out.className="result filled";out.innerHTML='<span class="verdict v-'+E(v)+'">'+E(v)+'</span><span>'+E(j.reason)+'</span>'+(j.receipt_url?'<div class="note">Receipt: <a href="'+E(new URL(j.receipt_url).pathname)+'">'+E(j.receipt_id||j.receipt_url)+'</a></div>':'')+(extra?'<div class="note">'+extra+'</div>':'');};
const msg=(t)=>{out.className="result filled";out.innerHTML=t;};
const call=async(url,dry)=>{const q=new URLSearchParams({url});if(dry)q.set("mode","dry-run");else q.set("ref","via-payscout-site");return fetch("/v1/products/endpoint-spot-check?"+q,{headers:{accept:"application/json"}});};
async function run(e){if(e)e.preventDefault();const url=u.value.trim();if(!/^https?:\\/\\//i.test(url)){msg("Enter a full http(s) URL.");u.focus();return;}
go.disabled=true;msg("Checking…");try{let r=await call(url,false);let j=await r.json().catch(()=>({}));
if(r.status===200){show(j,j.access&&j.access.tier==="free"?"Free check: "+E(j.access.free_remaining_today)+" left today. Full detail and the payment object are in the paid check.":"");}
else if(r.status===402){const r2=await call(url,true),j2=await r2.json().catch(()=>({}));
if(r2.status===200)show(j2,"Today's free check is used, so this is a free dry run: nothing signed or paid, and not an approval to pay. A full check costs "+E(j.price_usd?"$"+j.price_usd:"$0.01+")+" in USDC on Base via x402.");
else if(r2.status===429)msg("Today's free check and dry runs are used up from this network. They reset at 00:00 UTC.");else msg(E(j2.error||("Dry run failed: HTTP "+r2.status)));}
else if(r.status===400)msg(E(j.error||("Bad request: "+(j.reason||r.status))));
else msg("Unexpected answer: HTTP "+r.status);}catch(err){msg("Could not reach PayScout. Try again.");}finally{go.disabled=false;}}
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
