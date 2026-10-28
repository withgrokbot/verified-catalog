// 0.58.0: the human landing page for 402xagent.com (browsers only: GET / with Accept: text/html on 402xagent.com).
// Every machine surface (root JSON for non-browser clients, llms.txt, skill.md, rules.json, openapi.json, /mcp, /v1/*)
// is untouched; tests/machine_surfaces_test.mjs proves it against a 0.57.1 snapshot.
// Strict CSP like /docs: no inline script; the behaviour is /home.js. The checker reuses the /docs Try-it core
// (TRYIT_CORE: same validation, same free endpoint, same ref, same quota messages, same per-term comparison) and never
// shows a price or a payTo. Stats and Latest skips come from the published crawl (receipts-data.js, the data behind
// /v1/skips) and hide when missing or stale. No inline numbers are hand-edited; no badge; no personal names.
import { RECEIPTS, RECEIPTS_META } from "./receipts-data.js";
import { crawlSchedule } from "./skips.js";
import { TRYIT_CORE, DOCS_TRYIT_PREFILL, DOCS_TRYIT_PLACEHOLDER, DOCS_TRYIT_REF, DOCS_TRYIT_TIMEOUT_MS, DOCS_CSP } from "./tryit.js";

export const HOME_SCRIPT_PATH = "/home.js";
export const HOME_CSP = DOCS_CSP;
export const HOME_REF = DOCS_TRYIT_REF; // the existing site ref (own-ref list in recent.js, almost_paid.py): same quota, same counting
export const HOME_STATS_MAX_AGE_DAYS = 14; // the crawl is weekly; older numbers are hidden, never shown stale
export const HOME_VERDICT_ROWS = 6;
const LOGO = "/brand/logo-light.png";
const GH_REPO = "https://github.com/withgrokbot/verified-catalog";
const GH_GUARD = "https://github.com/withgrokbot/x402-spotcheck";
const NPM_GUARD = "https://www.npmjs.com/package/x402-spotcheck";
const ONE_LINER = "const pay = wrapFetchWithPayment(spotCheckFetch(fetch), client);";
// Real public endpoints for the example chips (they only prefill the box; nothing runs until Check is pressed).
export const HOME_EXAMPLES = [
  { url: DOCS_TRYIT_PREFILL, label: "api.402xagent.com" },
  { url: "https://api.402rates.com/v1/ping", label: "api.402rates.com" },
  { url: "https://api.automaton-sovereign.workers.dev/v2/oracle/base", label: "automaton-sovereign" },
];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n.toLocaleString("en-US") : null);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return ""; const d = new Date(t); return MON[d.getUTCMonth()] + " " + d.getUTCDate(); };

/** Live crawl numbers for the proof strip; each is null when missing; all null when the crawl is older than the max age. */
export function homeStats(meta = RECEIPTS_META, now = Date.now()) {
  const m = meta || {};
  const t = Date.parse(m.crawled_at || "");
  if (!Number.isFinite(t) || now - t > HOME_STATS_MAX_AGE_DAYS * 86400000 || t - now > 86400000) return { covered: null, newWeek: null, recheck: null, skip: null, crawled: null };
  return { covered: num(m.endpoints_covered ?? m.total), newWeek: num(m.new_this_week), recheck: num(m.recheck), skip: num(m.skip), crawled: day(m.crawled_at) };
}

/** 0.58.2: "Last crawl Oct 27 · next crawl Nov 3" under the proof strip, from the crawl timestamp and the 0.53.4 weekly
 * schedule (crawlSchedule: next = the first Tuesday after the last crawl's UTC date). Absolute dates only (the page is cached
 * 5 min). Each part is null when missing: no valid crawled_at -> no last (and no next); a next date already in the past
 * (a missed crawl) is hidden rather than shown wrong. Both null -> the line is not rendered. */
export function homeCrawlDates(meta = RECEIPTS_META, now = Date.now()) {
  const s = crawlSchedule((meta || {}).crawled_at);
  if (!s) return { last: null, next: null, text: null };
  const last = Date.parse(s.last_iso) <= now + 86400000 ? s.last : null; // a crawl date in the future is bad data
  const next = Date.parse(s.next_iso) + 86400000 > now ? s.next : null; // still today or later (UTC)
  const parts = [last && "Last crawl " + last, next && (last ? "next crawl " : "Next crawl ") + next].filter(Boolean);
  return { last, next, text: parts.length ? parts.join(" \u00b7 ") : null };
}

// Plain-language reasons for the table, in neutral wording about the payment terms (never about the seller): the crawl's
// reason is matched by shape and replaced; its parenthetical detail (wallets, chain ids) is never shown. Unknown shapes are dropped.
const PLAIN = [
  [/^pays a different wallet than listed/i, "Payment wallet differs from the listing"],
  [/^asks a different price than listed/i, "Payment price differs from the listing"],
  [/^asks for payment on a different network than listed/i, "Payment network differs from the listing"],
  [/^no x402 payment request/i, "No x402 payment request found at this URL"],
  [/^payment request matches/i, "Live terms match the listing"],
];
export function plainReason(r) {
  const s = String(r || "").trim();
  for (const [re, text] of PLAIN) if (re.test(s)) return text;
  return null;
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch (_) { return null; } };
/** Latest skips rows: newest first, one per host, only rows with a plain reason. Host, verdict, reason, date: nothing else. */
export function homeVerdicts(receipts = RECEIPTS, meta = RECEIPTS_META, n = HOME_VERDICT_ROWS, now = Date.now()) {
  if (!homeStats(meta, now).crawled) return [];
  const seen = new Set(), rows = [];
  for (const r of [...(receipts || [])].filter((r) => r && r.timestamp).sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))) {
    const host = hostOf(r.url), reason = plainReason(r.reason), v = String(r.verdict || "");
    if (!host || !reason || !["pay", "skip", "recheck"].includes(v) || seen.has(host)) continue;
    seen.add(host); rows.push({ host, verdict: v, reason, when: day(r.timestamp) });
    if (rows.length >= n) break;
  }
  return rows;
}

function productCards(opts) {
  const p = [
    { name: "402xAgent Check", price: "$0.02", unit: "per check", tag: `${opts.freePerDay} free / day`, href: "#checker", link: "Run a free check", docs: "/docs#quick-start",
      text: "The core verdict: pay, skip, or recheck, right before payment, with a signed receipt. One line in an x402 client." },
    opts.endpointReport && { name: "Endpoint Report", price: "$0.05", unit: "per report", href: "/docs#endpoint-report", link: "How it works",
      text: "The drift history and hygiene detail behind a free check of one endpoint, with digests you can verify." },
    { name: "Payment Status", price: "$0.02", unit: "per lookup", tag: `${opts.freePerDay} free / day`, href: "/docs#payment-status", link: "How it works",
      text: "A payment timed out: did it land, and is it safe to sign again? A signed answer before your agent pays twice." },
    opts.watchtower && { name: "Watchtower", price: "$1", unit: "per 30 days", tag: "7-day trial", href: "/docs#watchtower", link: "Start monitoring",
      text: "Hourly re-probes of an endpoint you depend on, with signed webhooks on drift, down and recovery." },
    { name: "Facilitator Check", price: "Free", unit: "rate-limited", href: "/docs#facilitator-check", link: "Integrate",
      text: "Pre-settle verification: compares the payment requirements you are about to settle with the seller's live 402 terms." },
    { name: "Hosted Mode", price: "1,000 free", unit: "then $0.02; $0.01 past 1,000/month", href: "/docs#hosted", link: "Integrator keys",
      text: "Integrator keys for routers and wallets, by arrangement: hosted checks billed on a monthly USDC invoice instead of per call." },
  ].filter(Boolean);
  return p.map((c) => `<article class="product"><div class="product-top"><h3>${esc(c.name)}</h3><div class="price">${esc(c.price)}<small>${esc(c.unit)}</small></div></div><p>${esc(c.text)}</p><div class="product-foot"><a class="product-link" href="${esc(c.href)}"${c.href === "#checker" ? ' data-focus-checker="1"' : ""}>${esc(c.link)} <span aria-hidden="true">&rarr;</span></a>${c.tag ? `<span class="free-tag">${esc(c.tag)}</span>` : ""}</div></article>`).join("\n");
}

const ICON = {
  shield: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
  search: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  doc: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 15l2 2 4-4"/></svg>',
  lock: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
};

const CSS = `:root{--bg-page:#F7F5F1;--bg-subtle:#F3EFE9;--border:#E3DED6;--border-strong:#D2CBC0;--text:#111116;--text-2:#33333D;--text-3:#6B6B76;--accent:#C05303;--accent-hover:#9E4302;--accent-mid:#F97316;--accent-light:#FFE7CC;--blue:#1D6FF2;--blue-hover:#1859C9;--blue-light:#DCE9FE;--mint:#FFF3E2;--forest:#111116;--pay-bg:#D8F0DE;--pay-text:#14532D;--pay-dot:#15803D;--skip-bg:#FDE3E3;--skip-text:#7F1D1D;--skip-dot:#DC2626;--recheck-bg:#FEF0B8;--recheck-text:#78350F;--recheck-dot:#D97706;--radius:12px;--radius-lg:16px;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg-page);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.6;overflow-x:hidden}
main{background:linear-gradient(180deg,#FFE9CF 0%,#FFF3E0 460px,#FAF7F2 780px,#F7F5F1 1080px)}
a{color:inherit;text-decoration:none}button,input{font:inherit}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}.mono{font-family:var(--mono)}
.skip-link{position:absolute;left:-999px;top:8px;background:#111;color:#fff;padding:8px 12px;border-radius:8px;z-index:60}.skip-link:focus{left:8px}
:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
header.top{position:sticky;top:0;z-index:40;background:#fff;border-bottom:2px solid var(--accent)}
.header-inner{display:flex;align-items:center;justify-content:space-between;height:68px;gap:16px}
.brand{display:flex;align-items:center;flex-shrink:0}.brand-logo{display:block;height:44px;width:auto}
nav.main{display:flex;align-items:center;gap:4px}
nav.main a{font-size:14.5px;font-weight:500;color:var(--text-2);padding:8px 12px;border-radius:8px}nav.main a:hover{background:var(--bg-subtle);color:var(--text)}
.header-actions{display:flex;align-items:center;gap:10px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:600;font-size:14.5px;border-radius:999px;padding:10px 18px;border:1px solid transparent;cursor:pointer;transition:.15s;white-space:nowrap}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:var(--accent-hover)}.btn[disabled]{opacity:.7;cursor:progress}
.menu-btn{display:none;width:40px;height:40px;border:1px solid var(--border);background:#fff;border-radius:9px;place-items:center;cursor:pointer;color:var(--text)}
.mobile-nav{display:none;border-top:1px solid var(--border);padding:12px 24px 16px;background:#fff}.mobile-nav.open{display:block}
.mobile-nav a{display:block;padding:10px 4px;font-weight:500;border-bottom:1px solid var(--bg-subtle)}.mobile-nav a:last-child{border-bottom:none;font-weight:700;color:var(--accent)}
.hero{padding:64px 0 8px;text-align:center}
.hero-eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--forest);background:#fff;border:1px solid #F0C08A;box-shadow:0 2px 10px rgba(60,35,5,.10);padding:7px 13px;border-radius:999px;margin-bottom:20px}
.hero-eyebrow i{width:7px;height:7px;background:var(--pay-dot);border-radius:50%;display:block}
h1{font-size:clamp(40px,6vw,64px);line-height:.98;letter-spacing:-.045em;font-weight:800;margin:0 auto;max-width:760px;color:var(--forest)}
h1 .serif{font-family:"Source Serif 4","Source Serif Pro",Georgia,"Times New Roman",serif;font-weight:600;letter-spacing:-.02em;color:var(--blue)}
.hero-sub{font-size:18.5px;line-height:1.6;color:var(--text-2);max-width:640px;margin:20px auto 0}
.checker{max-width:760px;margin:36px auto 0;text-align:left;background:#fff;border:1px solid #E3C9A8;border-top:5px solid var(--accent-mid);border-radius:var(--radius-lg);box-shadow:0 18px 44px rgba(60,35,5,.16),0 2px 8px rgba(60,35,5,.07);overflow:hidden;scroll-margin-top:90px}
.checker-head{padding:14px 20px 2px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.checker-head strong{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--accent)}
.checker-head span{font-size:13px;color:var(--text-3);background:var(--mint);border:1px solid #F0D9B8;padding:3px 8px;border-radius:999px;font-weight:600}
.checker-form{display:flex;gap:10px;padding:14px 20px 20px;margin:0}
.url-field{flex:1;display:flex;align-items:center;gap:9px;border:1px solid var(--border-strong);border-radius:10px;padding:0 14px;background:var(--bg-subtle);min-width:0}
.url-field svg{flex-shrink:0;color:var(--text-3)}
.url-field input{flex:1;border:none;background:transparent;outline:none;font-size:14.5px;padding:13px 0;min-width:0;color:var(--text)}
.url-field:focus-within{border-color:var(--accent);background:#fff;box-shadow:0 0 0 3px var(--accent-light)}
.check-btn{flex-shrink:0}
.examples{display:flex;gap:8px;flex-wrap:wrap;padding:0 20px 16px}.examples span{font-size:12.5px;color:var(--text-3);align-self:center}
.chip-example{font-size:12.5px;font-family:var(--mono);background:var(--blue-light);border:1px solid #B9D0FA;padding:5px 9px;border-radius:999px;cursor:pointer;color:var(--forest);font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.chip-example:hover{border-color:var(--blue);color:var(--blue)}
.result{border-top:1px solid var(--border);padding:20px;background:#FFFEFB;overflow-wrap:anywhere}.result:empty{display:none}
.result.ti-err{background:#FFF6F5}
.result p{margin:0}
.checking{display:flex;align-items:center;gap:12px;color:var(--text-2);font-size:14.5px}
.spinner{width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.result-top{display:flex;gap:14px;align-items:flex-start}
.verdict{font-size:12px;font-weight:800;letter-spacing:.07em;padding:6px 10px;border-radius:999px;display:inline-flex;align-items:center;gap:7px;flex-shrink:0;text-transform:uppercase}
.verdict i{width:7px;height:7px;border-radius:50%;display:block}
.verdict.pay{background:var(--pay-bg);color:var(--pay-text)}.verdict.pay i{background:var(--pay-dot)}
.verdict.skip{background:var(--skip-bg);color:var(--skip-text)}.verdict.skip i{background:var(--skip-dot)}
.verdict.recheck{background:var(--recheck-bg);color:var(--recheck-text)}.verdict.recheck i{background:var(--recheck-dot)}
.result-reason{font-size:15.5px;line-height:1.5;font-weight:600}.result-reason p{margin:2px 0 0;color:var(--text-2);font-size:14px;font-weight:400}
.result-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:18px}
.field{background:var(--mint);border:1px solid #F0D9B8;border-radius:10px;padding:10px 12px;min-width:0}
.field .fl{display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);font-weight:700;margin-bottom:3px}
.field .fv{font-size:13.5px;font-weight:600}.field .fv.ok{color:var(--pay-text)}.field .fv.bad{color:var(--skip-text)}
.result-note{margin-top:12px!important;font-size:13px;color:var(--text-3)}
.result-foot{margin-top:16px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.receipt-link{font-size:13.5px;font-weight:600;color:var(--accent)}.receipt-link:hover{text-decoration:underline}
.result-foot small{color:var(--text-3);font-size:12.5px}
.msg-links{margin-top:8px!important;font-size:13.5px}.msg-links a{color:var(--accent);font-weight:600}
.hero-note{font-size:13.5px;color:var(--text-3);margin:16px auto 0;display:flex;justify-content:center;gap:8px;flex-wrap:wrap}.hero-note b{color:var(--text-2);font-weight:600}
.proof{margin-top:56px;background:var(--forest);color:#fff}
.proof-grid{display:grid;grid-template-columns:repeat(4,1fr)}
.proof-item{padding:28px 22px;border-left:1px solid rgba(255,255,255,.16)}.proof-item:first-child{border-left:none}
.proof-num{font-size:30px;font-weight:800;letter-spacing:-.04em;line-height:1;color:#FF9E2C}
.proof-item:nth-child(2) .proof-num{color:#6BA8FF}.proof-item:nth-child(3) .proof-num{color:#FCD34D}.proof-item:nth-child(4) .proof-num{color:#fff}
.proof-label{font-size:13.5px;color:#C9C9D1;margin-top:7px;line-height:1.45}.proof-label strong{color:#fff}
.crawl-dates{background:var(--forest);color:#C9C9D1;font-size:13px;line-height:1.4;padding:0 0 14px;border-top:1px solid rgba(255,255,255,.16)}.crawl-dates .wrap{padding-top:12px}.crawl-dates .wrap>span{display:block;padding:0 22px}.crawl-dates.solo{margin-top:56px;border-top:none}
section{padding:52px 0}section.tight{padding:40px 0}
.section-head{max-width:640px;margin-bottom:24px}.section-head.center{margin-left:auto;margin-right:auto;text-align:center}
.kicker{display:inline-block;font-size:12.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);background:var(--accent-light);padding:5px 10px;border-radius:999px;margin-bottom:12px}
h2{font-size:clamp(28px,4vw,38px);line-height:1.08;letter-spacing:-.035em;font-weight:800;margin:0}
.section-head p{color:var(--text-2);font-size:16.5px;margin:12px 0 0;line-height:1.6}
#how{background:#fff}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.step{border:1px solid #B9D0FA;border-radius:var(--radius-lg);padding:16px 18px;background:#EEF4FF;display:flex;gap:14px;align-items:flex-start}
.step:nth-child(2){background:#FFF3E0;border-color:#F0D9B8}.step:nth-child(3){background:#F3F1ED;border-color:#DDD8D0}
.step-num{width:30px;height:30px;flex-shrink:0;border-radius:50%;background:var(--blue);color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px}
.step:nth-child(2) .step-num{background:var(--accent-mid)}.step:nth-child(3) .step-num{background:var(--forest)}
.step h3{margin:0 0 4px;font-size:16px;letter-spacing:-.02em}.step p{margin:0;color:var(--text-2);font-size:13.5px;line-height:1.5}
.step code{font-family:var(--mono);font-size:12.5px;background:var(--bg-subtle);padding:2px 6px;border-radius:6px;border:1px solid var(--border)}
.explore{background:#fff;border-top:1px solid var(--border);scroll-margin-top:70px}
.tabbar{display:flex;gap:6px;border-bottom:2px solid var(--border);margin-bottom:26px;overflow-x:auto;scrollbar-width:none}
.tab-btn{appearance:none;background:none;border:none;border-bottom:3px solid transparent;margin-bottom:-2px;padding:12px 18px;font-size:15.5px;font-weight:600;color:var(--text-3);cursor:pointer;white-space:nowrap}
.tab-btn:hover{color:var(--text)}.tab-btn[aria-selected="true"]{color:var(--accent);border-bottom-color:var(--accent)}
.tab-btn:focus-visible{outline:2px solid var(--blue);outline-offset:2px;border-radius:6px}
.tab-panel[hidden]{display:none}.tab-panel:focus-visible{outline:2px solid var(--blue);outline-offset:4px;border-radius:8px}
.panel-intro{max-width:640px;margin-bottom:22px}.panel-intro h3{font-size:22px;letter-spacing:-.025em;font-weight:800;margin:0}.panel-intro p{color:var(--text-2);font-size:15.5px;margin:8px 0 0;line-height:1.6}
.products{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.product{background:#fff;border:1px solid #E0D9CF;border-top:4px solid var(--accent-mid);border-radius:var(--radius-lg);padding:24px;display:flex;flex-direction:column;min-width:0}
.product:nth-child(2){border-top-color:var(--blue)}.product:nth-child(3){border-top-color:var(--forest)}.product:nth-child(4){border-top-color:#D97706}.product:nth-child(5){border-top-color:var(--blue-hover)}.product:nth-child(6){border-top-color:#6B6B76}
.product:hover{border-color:var(--border-strong);box-shadow:0 10px 28px rgba(60,35,5,.10)}
.product-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.product h3{margin:0;font-size:17px;letter-spacing:-.02em}
.price{font-weight:800;font-size:15px;white-space:nowrap;color:var(--accent);text-align:right}.price small{display:block;font-weight:500;color:var(--text-3);font-size:12px;margin-top:2px;white-space:normal}
.product p{color:var(--text-2);font-size:14.5px;margin:10px 0 18px;flex:1}
.product-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.product-link{font-size:14px;font-weight:600;color:var(--blue)}.product-link:hover{text-decoration:underline}
.free-tag{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;background:var(--accent-light);color:var(--accent);padding:4px 8px;border-radius:999px;white-space:nowrap}
.dev{background:linear-gradient(135deg,#111116 0%,#1A2333 62%);color:#EDEEF2;border-radius:20px;padding:36px;overflow:hidden;box-shadow:0 16px 36px rgba(10,10,20,.22)}
.dev-grid{display:grid;grid-template-columns:1.05fr .95fr;gap:32px;align-items:center}
.dev .kicker{background:#2B2B33;color:#FFB15E}.dev h2{color:#fff}.dev p{color:#B8BEC9;font-size:16px}
.dev-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
.btn-white{background:#fff;color:var(--forest)}.btn-white:hover{background:#EDEEF2}
.btn-dark-outline{background:transparent;border-color:#3D4356;color:#fff}.btn-dark-outline:hover{border-color:#fff}
.code{background:#0B0B10;border:1px solid #2A2E3A;border-radius:12px;padding:20px;overflow:auto;min-width:0}
.code pre{margin:0;font-family:var(--mono);font-size:13.5px;line-height:1.7;color:#D8DAE2;white-space:pre-wrap;word-break:break-word}
.code .c{color:#8A8F9E}.code .k{color:#FFB15E}.code .s{color:#FDE68A}.code .f{color:#93C5FD}
.code-head{display:flex;gap:7px;margin-bottom:14px;align-items:center}.code-head i{width:10px;height:10px;border-radius:50%;background:#2E3242;display:block}
.copy{margin-left:auto;font-size:12px;font-weight:600;background:#1f2937;color:#e5e7eb;border:1px solid #334155;border-radius:7px;padding:4px 10px;cursor:pointer}.copy:hover{background:#273244}
.copy-note{font-size:13px;margin-top:10px;min-height:18px;color:#FFB15E!important}
.verdicts{border:1px solid #D9C9A3;border-radius:var(--radius-lg);overflow:hidden;box-shadow:0 8px 24px rgba(120,84,10,.07)}
.v-row{display:grid;grid-template-columns:220px 110px 1fr 90px;gap:16px;align-items:center;padding:16px 20px;border-bottom:1px solid #EDE4CC;background:#fff}
.v-row:nth-child(even){background:#FFFEF8}.v-row:last-child{border-bottom:none}
.v-row.head{background:var(--forest);font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#FFE7CC;font-weight:700;padding:12px 20px;border-bottom:none}
.v-host{font-family:var(--mono);font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.v-reason{font-size:14.5px;color:var(--text-2)}.v-time{font-size:13px;color:var(--text-3);text-align:right}
.caption{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:12px;color:var(--text-3);font-size:13.5px}.caption a{color:var(--accent);font-weight:600}
.trust-sec{background:#F3EFE9}
.trust{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.trust-item{padding:16px 18px;border:1px solid #B9D0FA;border-radius:var(--radius-lg);background:#EEF4FF;min-width:0}
.trust-item:nth-child(2){background:#FFF3E0;border-color:#F0D9B8}.trust-item:nth-child(3){background:#FFF8E0;border-color:#EAD9A0}.trust-item:nth-child(4){background:#F3F1ED;border-color:#DDD8D0}
.trust-item svg{color:var(--blue);margin-bottom:10px;background:#fff;border:1px solid rgba(0,0,0,.06);padding:6px;width:32px;height:32px;border-radius:9px}
.trust-item:nth-child(2) svg{color:var(--accent)}.trust-item:nth-child(4) svg{color:var(--forest)}
.trust-item strong{display:block;font-size:15px;line-height:1.4}.trust-item p{margin:6px 0 0;color:var(--text-2);font-size:13.5px;line-height:1.55}
footer{background:var(--forest);color:#DCDCE2;padding:52px 0 28px}
.footer-grid{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:32px}
.footer-logo-chip{display:inline-flex;background:#fff;border-radius:10px;padding:7px 10px;line-height:0}.footer-logo-chip img{display:block;height:40px;width:auto}
.footer-brand p{color:#A9A9B3;font-size:14px;max-width:280px;margin:12px 0 0}
footer h4{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#FFB15E;margin:0 0 14px}
footer ul{list-style:none;margin:0;padding:0;display:grid;gap:9px}footer ul a{font-size:14.5px;color:#DCDCE2}footer ul a:hover{color:#fff;text-decoration:underline}
.footer-bottom{border-top:1px solid rgba(255,255,255,.16);margin-top:36px;padding-top:20px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:#8E8E99;font-size:13.5px}
@media(max-width:900px){nav.main{display:none}.menu-btn{display:grid}.proof-grid{grid-template-columns:1fr 1fr}.proof-item:nth-child(3){border-left:none}.proof-item{border-top:1px solid rgba(255,255,255,.16)}.proof-item:nth-child(-n+2){border-top:none}.products{grid-template-columns:1fr 1fr}.step{padding:14px}.dev-grid{grid-template-columns:1fr}.trust{grid-template-columns:1fr 1fr}.footer-grid{grid-template-columns:1fr 1fr}.v-row{grid-template-columns:1fr auto}.v-row.head{display:none}.v-reason{grid-column:1/-1}.v-time{display:none}.result-grid{grid-template-columns:1fr 1fr}}
@media(max-width:560px){.wrap{padding:0 18px}.hero{padding-top:44px}section{padding:40px 0}section.tight{padding:32px 0}.checker-form{flex-direction:column}.check-btn{width:100%;padding:13px}.steps{grid-template-columns:1fr}.products{gap:10px}.product{padding:14px}.product-top{flex-direction:column;gap:4px}.price{text-align:left}.product p{font-size:13.5px}.trust{gap:10px}.trust-item{padding:14px}.footer-grid{grid-template-columns:1fr 1fr}.footer-brand{grid-column:1/-1}.tab-btn{padding:11px 12px;font-size:14.5px}.proof-num{font-size:23px}.proof-item{padding:22px 14px}.crawl-dates .wrap>span{padding:0 14px}.dev{padding:26px 20px;border-radius:16px}.result-top{flex-direction:column}.header-actions .btn-primary{display:none}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`;

export function homeHtml(origin, opts = {}) {
  const o = { freePerDay: 5, endpointReport: true, watchtower: true, meta: RECEIPTS_META, receipts: RECEIPTS, now: Date.now(), ...opts };
  const st = homeStats(o.meta, o.now);
  const rows = homeVerdicts(o.receipts, o.meta, HOME_VERDICT_ROWS, o.now);
  const cd = homeCrawlDates(o.meta, o.now);
  const title = "402xAgent: ask before your agent pays";
  const desc = "402xAgent checks an x402 endpoint right before your agent pays: pay, skip, or recheck, with a signed receipt you can verify offline. The probe never pays the target.";
  const stats = [
    st.covered && `<div class="proof-item"><div class="proof-num">${st.covered}</div><div class="proof-label"><strong>endpoints covered</strong> in the public crawl</div></div>`,
    st.newWeek && `<div class="proof-item"><div class="proof-num">${st.newWeek}</div><div class="proof-label"><strong>new this week</strong> in the crawl</div></div>`,
    st.recheck && `<div class="proof-item"><div class="proof-num">${st.recheck}</div><div class="proof-label">currently at <strong>recheck</strong>: terms not confirmed yet</div></div>`,
    st.skip && `<div class="proof-item"><div class="proof-num">${st.skip}</div><div class="proof-label">at <strong>skip</strong>: live terms differ from the listing</div></div>`,
  ].filter(Boolean);
  const nav = [["Products", "#explore", "products"], ["Docs", "/docs", ""], ["Pricing", "/pricing", "products"], ["Blog", "/blog", ""], ["Receipts", "/v1/skips", "skips"], ["GitHub", GH_GUARD, "dev"]];
  const navHtml = nav.map(([t, h, tab]) => `<a href="${esc(h)}"${tab ? ` data-tab="${tab}"` : ""}>${t}</a>`).join("");
  const vrows = rows.map((r) => `<div class="v-row" role="row"><div class="v-host" role="cell">${esc(r.host)}</div><div role="cell"><span class="verdict ${r.verdict}"><i></i>${r.verdict.toUpperCase()}</span></div><div class="v-reason" role="cell">${esc(r.reason)}</div><div class="v-time" role="cell">${esc(r.when)}</div></div>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#ffffff">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://402xagent.com/">
<link rel="icon" type="image/png" href="${LOGO}">
<link rel="apple-touch-icon" href="${LOGO}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="402xAgent">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="https://402xagent.com/">
<meta property="og:image" content="https://402xagent.com${LOGO}">
<meta property="og:image:alt" content="402xAgent logo">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="https://402xagent.com${LOGO}">
<style>${CSS}</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="top">
<div class="wrap header-inner">
<a class="brand" href="/" aria-label="402xAgent home"><img class="brand-logo" src="${LOGO}" alt="402xAgent" width="54" height="44"></a>
<nav class="main" aria-label="Primary">${navHtml}</nav>
<div class="header-actions">
<a class="btn btn-primary" href="#checker" data-focus-checker="1">Run a free check</a>
<button class="menu-btn" id="menu-btn" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="mobile-nav"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
</div>
</div>
<nav class="mobile-nav" id="mobile-nav" aria-label="Mobile">${navHtml}<a href="#checker" data-focus-checker="1">Run a free check &rarr;</a></nav>
</header>
<main id="main">
<div class="wrap hero">
<div class="hero-eyebrow"><i></i> Verification for the x402 economy</div>
<h1>Ask before your<br>agent <span class="serif">pays.</span></h1>
<p class="hero-sub">402xAgent checks an x402 endpoint right before your agent pays: pay, skip, or recheck, with a signed receipt you can verify offline.</p>
<div class="checker" id="checker">
<div class="checker-head"><strong>Try it: free check</strong><span>Live probe · No payment made</span></div>
<form class="checker-form" id="hc-form" novalidate>
<label class="url-field" for="hc-url"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><span class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">x402 endpoint URL</span>
<input id="hc-url" name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="2048" placeholder="${esc(DOCS_TRYIT_PLACEHOLDER)}" value="${esc(DOCS_TRYIT_PREFILL)}" required></label>
<button class="btn btn-primary check-btn" type="submit" id="hc-go">Check endpoint</button>
</form>
<div class="examples"><span>Try:</span>${HOME_EXAMPLES.map((x) => `<button class="chip-example" type="button" data-url="${esc(x.url)}">${esc(x.label)}</button>`).join("")}</div>
<div class="result" id="hc-out" role="status" aria-live="polite"></div>
<noscript><p class="result">Needs JavaScript. Same check without it: <code>GET /v1/products/endpoint-spot-check?url=&lt;endpoint&gt;</code></p></noscript>
</div>
<p class="hero-note"><span><b>${esc(o.freePerDay)} free checks a day</b></span><span aria-hidden="true">·</span><span>No wallet, no signup</span><span aria-hidden="true">·</span><span>The probe never pays the target</span></p>
</div>
${stats.length ? `<div class="proof" id="proof" aria-label="Live from the public crawl${st.crawled ? ", " + esc(st.crawled) : ""}"><div class="wrap proof-grid">${stats.join("")}</div></div>` : ""}
${cd.text ? `<div class="crawl-dates${stats.length ? "" : " solo"}" id="crawl-dates"><div class="wrap"><span>${esc(cd.text)}</span></div></div>` : ""}
<section id="how" class="tight"${stats.length || cd.text ? "" : ' style="margin-top:56px"'}>
<div class="wrap">
<div class="section-head"><div class="kicker">How it works</div><h2>One unpaid probe. One signed verdict.</h2>
<p>Your agent asks before it pays. 402xAgent reads the endpoint's live terms, compares them with what was listed, and answers pay, skip, or recheck.</p></div>
<div class="steps">
<article class="step"><div class="step-num">1</div><div><h3>Probe</h3><p>One unpaid probe reads the endpoint's live <code>402</code> terms, as they are right now.</p></div></article>
<article class="step"><div class="step-num">2</div><div><h3>Compare</h3><p>Live terms are checked against the listing: price, <code>payTo</code>, network and asset. Before a pay, a confirm probe catches terms that move mid-check.</p></div></article>
<article class="step"><div class="step-num">3</div><div><h3>Verdict</h3><p><strong>Pay, skip, or recheck</strong>, with an ed25519-signed receipt anyone can verify offline.</p></div></article>
</div>
</div>
</section>
<section class="explore" id="explore">
<div class="wrap">
<div class="section-head"><div class="kicker">Explore</div><h2>Products, verdicts, and the developer docs.</h2></div>
<div class="tabbar" role="tablist" aria-label="Explore 402xAgent">
<button class="tab-btn" role="tab" id="tab-products" aria-controls="panel-products" aria-selected="true" data-panel="products" type="button">Products</button>
<button class="tab-btn" role="tab" id="tab-skips" aria-controls="panel-skips" aria-selected="false" tabindex="-1" data-panel="skips" type="button">Latest skips</button>
<button class="tab-btn" role="tab" id="tab-dev" aria-controls="panel-dev" aria-selected="false" tabindex="-1" data-panel="dev" type="button">For developers</button>
</div>
<div class="tab-panel" role="tabpanel" id="panel-products" aria-labelledby="tab-products" tabindex="0">
<div class="panel-intro"><h3>Start with a check. Stay for the proof.</h3><p>Pay per use over x402. No wallet or signup for the free tier. Full terms on <a class="product-link" href="/pricing">pricing</a>.</p></div>
<div class="products">
${productCards(o)}
</div>
</div>
<div class="tab-panel" role="tabpanel" id="panel-skips" aria-labelledby="tab-skips" tabindex="0" hidden>
<div class="panel-intro"><h3>What the crawl is finding.</h3><p>The newest skips from the public crawl, one row per host, in plain words.</p></div>
${rows.length ? `<div class="verdicts" role="table" aria-label="Latest skips from the public crawl">
<div class="v-row head" role="row"><div role="columnheader">Endpoint</div><div role="columnheader">Verdict</div><div role="columnheader">Reason</div><div role="columnheader" style="text-align:right">Checked</div></div>
${vrows}
</div>` : ""}
<div class="caption"><span>Recent skips from the public crawl. A mismatch often just means the listing is out of date.</span><a href="/v1/skips">Browse all receipts &rarr;</a></div>
</div>
<div class="tab-panel" role="tabpanel" id="panel-dev" aria-labelledby="tab-dev" tabindex="0" hidden>
<div class="dev"><div class="dev-grid">
<div><div class="kicker">For developers</div><h2>One line in your<br>payment flow.</h2>
<p>Wrap your fetch once. Every paid call is checked first, and blocked on skip.</p>
<div class="dev-actions"><a class="btn btn-white" href="${GH_GUARD}">GitHub</a><a class="btn btn-dark-outline mono" href="${NPM_GUARD}" style="font-size:13.5px">npm: x402-spotcheck</a></div>
<p class="copy-note" id="copy-note" aria-live="polite"></p></div>
<div class="code" aria-label="Code example"><div class="code-head"><i></i><i></i><i></i><button class="copy" id="copy-btn" type="button" data-copy="${esc(ONE_LINER)}">Copy</button></div>
<pre><span class="c">// check before every payment</span>
<span class="k">import</span> { spotCheckFetch } <span class="k">from</span> <span class="s">"x402-spotcheck"</span>;

<span class="k">const</span> pay = <span class="f">wrapFetchWithPayment</span>(<span class="f">spotCheckFetch</span>(fetch), client);

<span class="c">// skip blocks the payment; every check has a receipt</span></pre></div>
</div></div>
</div>
</div>
</section>
<section class="tight trust-sec" id="trust">
<div class="wrap">
<div class="section-head center"><div class="kicker">Why you can trust the verdict</div><h2>Built to be checked itself.</h2></div>
<div class="trust">
<div class="trust-item">${ICON.shield}<strong>Payment never changes a verdict</strong><p>Free, paid and exempt checks run the same code on the same data. Paying buys access to the answer, not a different answer.</p></div>
<div class="trust-item">${ICON.search}<strong>Probes never pay the target</strong><p>The probe is unpaid by design: it reads the 402 terms and never attaches a payment to the seller.</p></div>
<div class="trust-item">${ICON.doc}<strong>Receipts verifiable offline</strong><p>Live-check receipts are ed25519-signed and the public keys are published, so anyone can verify one without calling us.</p></div>
<div class="trust-item">${ICON.lock}<strong>No raw IPs in our data</strong><p>The raw IP is never written to our data stores, only a salted hash.</p></div>
</div>
</div>
</section>
</main>
<footer>
<div class="wrap">
<div class="footer-grid">
<div class="footer-brand"><a class="brand" href="/" aria-label="402xAgent home"><span class="footer-logo-chip"><img src="${LOGO}" alt="402xAgent" width="49" height="40"></span></a><p>Verification for the x402 economy. Ask before your agent pays, and keep the receipt.</p></div>
<div><h4>Products</h4><ul><li><a href="/docs#quick-start">402xAgent Check</a></li>${o.endpointReport ? '<li><a href="/docs#endpoint-report">Endpoint Report</a></li>' : ""}<li><a href="/docs#payment-status">Payment Status</a></li>${o.watchtower ? '<li><a href="/docs#watchtower">Watchtower</a></li>' : ""}<li><a href="/docs#facilitator-check">Facilitator Check</a></li><li><a href="/docs#hosted">Hosted Mode</a></li></ul></div>
<div><h4>Resources</h4><ul><li><a href="/docs">Docs</a></li><li><a href="/blog">Blog</a></li><li><a href="/v1/skips">Receipts</a></li><li><a href="/pricing">Pricing</a></li><li><a href="${GH_GUARD}">GitHub</a></li><li><a href="${NPM_GUARD}">npm: x402-spotcheck</a></li></ul></div>
<div><h4>Company</h4><ul><li><a href="/health">Status</a></li><li><a href="${GH_REPO}/issues">Contact</a></li><li><a href="/rules">Verdict rules</a></li></ul></div>
</div>
<div class="footer-bottom"><span>402xAgent — verification for the x402 economy.</span><span>402xagent.com · Probes never pay the target</span></div>
</div>
</footer>
<script src="${HOME_SCRIPT_PATH}" defer></script>
</body>
</html>
`;
}

// ---- /home.js: the checker (TRYIT_CORE + home rendering) and the page UI (tabs, nav, menu, chips, copy) ----
const HOME_HEAD = `(function () {
  "use strict";
  var form = document.getElementById("hc-form"), input = document.getElementById("hc-url"), btn = document.getElementById("hc-go"), out = document.getElementById("hc-out");
  if (!form || !input || !btn || !out) return;
  var REF = ${JSON.stringify(HOME_REF)}, TIMEOUT_MS = ${DOCS_TRYIT_TIMEOUT_MS}, EXAMPLE = ${JSON.stringify(DOCS_TRYIT_PLACEHOLDER)};
`;
// Home rendering. Never reads j.payment: the card shows how each term compared, never a price or a payTo.
const HOME_RENDER = String.raw`  function show(nodes, cls) {
    out.className = "result " + (cls || "");
    var kids = nodes.filter(Boolean);
    if (cls === "ti-msg" && btn.disabled) { var w = el("div", "checking"); w.appendChild(el("div", "spinner")); kids.forEach(function (n) { w.appendChild(n); }); kids = [w]; }
    out.textContent = ""; kids.forEach(function (n) { out.appendChild(n); });
  }
  function belowLink() { var p = el("p", "msg-links"); p.appendChild(link("/docs#quick-start", "Agent quick start")); p.appendChild(document.createTextNode(" \u00b7 ")); p.appendChild(link("/pricing", "Pricing")); return p; }
  // The free reason can open with the listing's price ("listed $0.01, ..."); the home card drops it, and any amount or address.
  function homeReason(r) {
    var t = uiReason(r).replace(/^(listed \$[0-9.]+|price unlisted),\s*/i, "").replace(/\$[0-9][0-9.,]*/g, "").replace(/0x[0-9a-fA-F]{6,}/g, "").replace(/\s+/g, " ").trim();
    // neutral wording about the payment terms, never about the seller (the API keeps its own reason text unchanged)
    var NEUTRAL = [[/^pays a different wallet than listed/i, "Payment wallet differs from the listing"], [/^asks for payment on a different network than listed/i, "Payment network differs from the listing"],
      [/^asks a different price than listed/i, "Payment price differs from the listing"], [/^asks for a token other than USDC/i, "Payment token is not USDC"],
      [/^wants payment on a testnet or a network we don't support/i, "Payment network is a testnet or not supported"]];
    for (var i = 0; i < NEUTRAL.length; i++) if (NEUTRAL[i][0].test(t)) return NEUTRAL[i][1];
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Payment request found";
  }
  function termsGrid(j) {
    var st = termStatus(j), g = el("div", "result-grid");
    [["price", "Price"], ["payTo", "payTo"], ["network", "Network"], ["token", "Token"]].forEach(function (r) {
      var s0 = st[r[0]] || ["not compared", ""], f = el("div", "field");
      f.appendChild(el("span", "fl", r[1])); f.appendChild(el("div", "fv " + s0[1], s0[0])); g.appendChild(f);
    });
    return g;
  }
  function result(j) {
    var v = String(j.verdict || ""), top = el("div", "result-top"), chip = el("span", "verdict " + (v === "pay" || v === "skip" || v === "recheck" ? v : ""));
    chip.appendChild(el("i")); chip.appendChild(document.createTextNode(v || "?")); top.appendChild(chip);
    var rs = el("div", "result-reason", homeReason(j.reason || j.reason_code || "")), why;
    if (v === "recheck") why = (RECHECK_WHY[j.reason_code] || "We couldn't confirm the terms right now.") + " Nothing is approved yet: don't pay on this answer; check again in a minute.";
    else if (v === "skip") why = "Skip means don't pay this endpoint as it stands.";
    else if (v === "pay") why = /^no listing to compare/i.test(String(j.explain || "")) ? "The live 402 is a valid USDC payment request on a supported network; there was no listing to compare it against." : "The live 402 terms match the listing right now.";
    if (why) rs.appendChild(el("p", null, why));
    top.appendChild(rs);
    var nodes = [top, termsGrid(j), el("p", "result-note", "Free checks show how each term compared. The exact amount, payTo wallet and the payment to sign come with the $0.02 paid check.")];
    var foot = el("div", "result-foot"), href = receiptHref(j);
    if (href) { var a = link(href, "View signed receipt \u2192"); a.className = "receipt-link"; foot.appendChild(a); }
    var a2 = j.access || {}, small = [];
    if (j.receipt_id) small.push("Receipt " + String(j.receipt_id));
    if (a2.tier === "free" && a2.free_remaining_today != null) small.push("Free checks left today: " + a2.free_remaining_today);
    if (small.length) foot.appendChild(el("small", null, small.join(" \u00b7 ")));
    nodes.push(foot);
    show(nodes, "");
  }
  function busy(on) { btn.disabled = on; btn.textContent = on ? "Checking\u2026" : "Check endpoint"; input.setAttribute("aria-busy", on ? "true" : "false"); }
`;
const HOME_UI = String.raw`(function () {
  "use strict";
  var tabs = [].slice.call(document.querySelectorAll('[role="tab"]')), explore = document.getElementById("explore");
  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab, p = document.getElementById(t.getAttribute("aria-controls"));
      t.setAttribute("aria-selected", on ? "true" : "false"); t.tabIndex = on ? 0 : -1;
      if (p) { if (on) p.removeAttribute("hidden"); else p.setAttribute("hidden", ""); }
    });
    if (focus) tab.focus();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { select(t, false); });
    t.addEventListener("keydown", function (e) {
      var k = e.key, n = null;
      if (k === "ArrowRight") n = tabs[(i + 1) % tabs.length]; else if (k === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (k === "Home") n = tabs[0]; else if (k === "End") n = tabs[tabs.length - 1];
      if (n) { e.preventDefault(); select(n, true); }
    });
  });
  var menuBtn = document.getElementById("menu-btn"), mnav = document.getElementById("mobile-nav");
  function closeMenu() { if (mnav && mnav.classList.contains("open")) { mnav.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false"); menuBtn.setAttribute("aria-label", "Open menu"); } }
  if (menuBtn && mnav) menuBtn.addEventListener("click", function () { var open = mnav.classList.toggle("open"); menuBtn.setAttribute("aria-expanded", open ? "true" : "false"); menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu"); });
  [].slice.call(document.querySelectorAll("a[data-tab]")).forEach(function (a) {
    a.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
      var t = document.getElementById("tab-" + a.getAttribute("data-tab"));
      if (!t || !explore) return;
      e.preventDefault(); closeMenu(); select(t, false); explore.scrollIntoView({ block: "start" });
    });
  });
  var input = document.getElementById("hc-url");
  [].slice.call(document.querySelectorAll("a[data-focus-checker]")).forEach(function (a) {
    a.addEventListener("click", function (e) { if (!input) return; e.preventDefault(); closeMenu(); document.getElementById("checker").scrollIntoView({ block: "start" }); input.focus({ preventScroll: true }); });
  });
  [].slice.call(document.querySelectorAll(".chip-example")).forEach(function (c) {
    c.addEventListener("click", function () { if (!input) return; input.value = c.getAttribute("data-url") || ""; input.focus(); });
  });
  var cb = document.getElementById("copy-btn"), note = document.getElementById("copy-note");
  if (cb) cb.addEventListener("click", function () {
    var text = cb.getAttribute("data-copy") || "";
    var done = function (ok) { if (note) note.textContent = ok ? "Copied the one-liner." : "Copy failed; select the line above."; cb.textContent = ok ? "Copied" : "Copy"; setTimeout(function () { cb.textContent = "Copy"; }, 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); }); else done(false);
  });
})();
`;
export const HOME_JS = HOME_HEAD + TRYIT_CORE.TABLES + TRYIT_CORE.UTIL + TRYIT_CORE.CHECK + TRYIT_CORE.REASON + HOME_RENDER + TRYIT_CORE.SUBMIT + HOME_UI;
