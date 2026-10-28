// 0.57.1: the free "Try it" box on /docs. A thin same-origin client of GET /v1/products/endpoint-spot-check?url=...
// (the same free check, the same 5 free per client per UTC day, the same $0.02 x402 402 after; no new paid path, no
// quota change). The markup is server-rendered (docsTryItHtml); the behaviour is one external script served from
// /docs/try-it.js, so /docs needs no inline script and can carry a strict CSP (script-src 'self').
// The script never uses innerHTML: every server string goes into the page through textContent / attributes.
export const DOCS_TRYIT_PREFILL = "https://api.402xagent.com/v1/lookup/paid"; // our own paid route (served in-process by the probe since 0.42.1)
export const DOCS_TRYIT_PLACEHOLDER = "https://example.com/paid-endpoint";
export const DOCS_TRYIT_SCRIPT_PATH = "/docs/try-it.js";
export const DOCS_TRYIT_REF = "via-402xagent-site"; // same ref as the homepage try-it box (own-ref list in recent.js, demand_weekly.py)
export const DOCS_TRYIT_TIMEOUT_MS = 15000; // client-side AbortController cap; the server's own probe budget is PROBE_TIMEOUT_MS (8 s) + a short confirm, so 15 s only trips on a stuck request
export const DOCS_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function docsTryItHtml({ prefill = DOCS_TRYIT_PREFILL, freePerDay = 5 } = {}) {
  return `<section id="try-it" aria-labelledby="try-it-h">
<style>#try-it form{display:flex;gap:.5rem;flex-wrap:wrap;margin:.5rem 0}#try-it label{flex-basis:100%;font-weight:600}#try-it input{flex:1 1 16rem;min-width:0;font:inherit;padding:.45rem .6rem;border:1px solid #bbb;border-radius:6px}#try-it button{font:inherit;padding:.45rem 1.1rem;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}#try-it button[disabled]{opacity:.6;cursor:wait}#tryit-out{margin-top:.6rem}#tryit-out:empty{display:none}.ti-card{border:1px solid #ddd;border-radius:8px;padding:.7rem .9rem;overflow-wrap:anywhere}.ti-v{display:inline-block;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:.05rem .5rem;border-radius:4px;margin-right:.5rem}.ti-pay{background:#e3f6e8;color:#0b6b2a}.ti-skip{background:#fde8e8;color:#9b1c1c}.ti-recheck{background:#fff4d6;color:#7a5200}.ti-msg{background:#f6f6f6}.ti-err{background:#fdf0f0;border-color:#f1c4c4}.ti-note{color:#555;font-size:.92rem;margin:.4rem 0 0}#try-it table{margin-top:.5rem;font-size:.95rem}#try-it td.ok{color:#0b6b2a}#try-it td.bad{color:#9b1c1c}@media (max-width:760px){pre{overflow-x:auto;max-width:100%}code{overflow-wrap:anywhere}}</style>
<h2 id="try-it-h">Try it: check an endpoint (free)</h2>
<p>Paste an x402 endpoint URL and press Check. This runs the real free check (${esc(freePerDay)} a day, then $0.02 per check over x402). No wallet, no curl; nothing is signed or paid.</p>
<form id="tryit-form" novalidate>
<label for="tryit-url">x402 endpoint URL</label>
<input id="tryit-url" name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="2048" placeholder="${esc(DOCS_TRYIT_PLACEHOLDER)}" value="${esc(prefill)}" required>
<button type="submit" id="tryit-go">Check</button>
</form>
<div id="tryit-out" role="status" aria-live="polite"></div>
<noscript><p>Needs JavaScript. Same check without it: <code>GET /v1/products/endpoint-spot-check?url=&lt;endpoint&gt;</code></p></noscript>
<script src="${DOCS_TRYIT_SCRIPT_PATH}" defer></script>
</section>
`;
}

// Plain browser JS (no build step). Kept ES2017 so older mobile browsers run it.
export const DOCS_TRYIT_JS = `(function () {
  "use strict";
  var form = document.getElementById("tryit-form"), input = document.getElementById("tryit-url"), btn = document.getElementById("tryit-go"), out = document.getElementById("tryit-out");
  if (!form || !input || !btn || !out) return;
  var REF = ${JSON.stringify(DOCS_TRYIT_REF)}, TIMEOUT_MS = ${DOCS_TRYIT_TIMEOUT_MS}, EXAMPLE = ${JSON.stringify(DOCS_TRYIT_PLACEHOLDER)};
  var NETS = { "eip155:8453": "Base", "base": "Base", "eip155:1": "Ethereum", "eip155:10": "OP Mainnet", "eip155:137": "Polygon", "eip155:42161": "Arbitrum", "eip155:43114": "Avalanche", "solana": "Solana", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana" };
  var FIELD_FAIL = { price_mismatch: ["price", "differs from the listing"], pay_to_mismatch: ["payTo", "different wallet than listed"], network_mismatch: ["network", "different network than listed"], network_unsupported: ["network", "testnet or unsupported network"], asset_not_usdc: ["token", "not canonical USDC"] };
  var RECHECK_WHY = {
    timeout: "The endpoint did not answer in time.",
    unreachable: "We could not connect to the endpoint.",
    server_error: "The endpoint returned a server error (5xx).",
    dns_error: "The endpoint's host name did not resolve.",
    rate_limited: "The endpoint rate-limited our probe (HTTP 429).",
    waf_challenge: "A firewall challenged our probe instead of answering.",
    host_unstable: "This host failed several probes in a row, so we paused probing it for a few minutes.",
    terms_unstable: "Two quick probes a moment apart saw different payment terms, so the terms are not stable enough to pay.",
    free_trial_active: "The seller says a free trial is active, so there is no price to check yet.",
    delivery_failed: "The terms look fine, but a recent paid call to this endpoint did not deliver.",
    terms_changed_since_quote: "The live terms differ from the quote you passed."
  };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function show(nodes, cls) { var c = el("div", "ti-card " + (cls || "")); nodes.forEach(function (n) { if (n) c.appendChild(n); }); out.replaceChildren ? out.replaceChildren(c) : (out.textContent = "", out.appendChild(c)); }
  function message(text, cls, extra) { show([el("p", null, text)].concat(extra || []), cls || "ti-msg"); }
  function shortAddr(a) { a = String(a || ""); return a.length > 14 ? a.slice(0, 6) + "\\u2026" + a.slice(-4) : a; }
  function netName(n) { n = String(n || ""); return NETS[n] || NETS[n.toLowerCase()] || (/^solana/i.test(n) ? "Solana" : n); }
  function link(href, text) { var a = el("a", null, text); a.href = href; return a; }
  function belowLink() { var p = el("p", "ti-note"); p.appendChild(document.createTextNode("Agents: ")); p.appendChild(link("#quick-start", "quick start")); p.appendChild(document.createTextNode(" \\u00b7 ")); p.appendChild(link("/pricing", "pricing")); return p; }
  function validate(raw) {
    var v = String(raw || "").trim();
    if (!v) return { error: "Paste an endpoint URL first, for example " + EXAMPLE + "." };
    if (v.length > 2048) return { error: "That URL is too long (2,048 characters at most)." };
    if (!/^https?:\\/\\//i.test(v)) return { error: "Enter a full URL starting with https:// (for example " + EXAMPLE + ")." };
    var u; try { u = new URL(v); } catch (_) { return { error: "That doesn't look like a valid URL. Check for typos or spaces." }; }
    if (!u.hostname || (u.hostname.indexOf(".") < 0 && u.hostname.indexOf(":") < 0)) return { error: "Enter a public endpoint URL with a full host name (for example " + EXAMPLE + ")." };
    if (/(^|\\.)(example\\.(com|org|net)|test\\.com|localhost)$|\\.(test|invalid|example|localhost)$|^127\\./i.test(u.hostname.replace(/\\.+$/, ""))) return { error: "That's an example address. Paste a real x402 endpoint URL." };
    return { url: u.toString() };
  }
  // Only same-site receipt links (a relative /v1/receipts/... path), never an arbitrary href from the response.
  function receiptHref(j) {
    try { var u = new URL(String(j.receipt_url || ""), location.href); if ((u.hostname === "402xagent.com" || u.hostname === location.hostname) && /^\\/v1\\/receipts\\/[A-Za-z0-9-]+$/.test(u.pathname)) return u.pathname; } catch (_) {}
    if (/^[a-z]{2}-[0-9a-f]{8,32}$/.test(String(j.receipt_id || ""))) return "/v1/receipts/" + j.receipt_id;
    return null;
  }
  // Per-term status from the free answer only: the explain line ("Price, payee and network match the listing; ...",
  // "Payee differs from the listing; ...", "No listing to compare; ...") and the reason code. Values (amount, wallet) appear
  // only when the answer carries the paid payment object, which a free check never does.
  var NOUN = { price: "price", payee: "payTo", network: "network", asset: "token" };
  function termStatus(j) {
    var st = {}, code = String(j.reason_code || ""), pay = j.verdict === "pay";
    String(j.explain || "").split(";").forEach(function (clause) {
      var c = clause.trim(), words = c.match(/\\b(price|payee|network|asset)\\b/gi) || [];
      if (/^no listing to compare/i.test(c)) { ["price", "payTo", "network"].forEach(function (f) { if (!st[f]) st[f] = ["no listing to compare", ""]; }); return; }
      var tag = /\\bdiffers?\\b/i.test(c) ? ["differs from the listing", "bad"] : /\\bmatch(es)?\\b/i.test(c) ? ["matches the listing", "ok"] : null;
      if (tag) words.forEach(function (w) { st[NOUN[w.toLowerCase()]] = tag; });
    });
    var f = FIELD_FAIL[code]; if (f) st[f[0]] = [f[1], "bad"];
    if (pay) {
      if (!st.network || st.network[1] !== "bad") st.network = [st.network && st.network[1] === "ok" ? "matches the listing (supported mainnet)" : "supported mainnet", "ok"];
      if (!st.token) st.token = ["canonical USDC", "ok"];
    }
    return st;
  }
  function termsTable(j) {
    var pm = j.payment || null, st = termStatus(j);
    var rows = [["price", "Price", pm && pm.amount && pm.amount.usd != null ? "$" + pm.amount.usd : null], ["payTo", "payTo wallet", pm && pm.pay_to ? shortAddr(pm.pay_to) : null], ["network", "Network", pm && pm.network ? netName(pm.network) : null], ["token", "Token", pm && pm.asset ? "USDC " + shortAddr(pm.asset) : null]];
    var t = el("table"), tb = el("tbody"); t.appendChild(tb);
    var hr = el("tr"); hr.appendChild(el("th", null, "Term")); hr.appendChild(el("th", null, "Live 402 terms")); tb.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el("tr"), s0 = st[r[0]] || ["not compared", ""], status = s0[0];
      if (r[2]) status += " \\u00b7 " + r[2];
      tr.appendChild(el("th", null, r[1])); tr.appendChild(el("td", s0[1], status)); tb.appendChild(tr);
    });
    return t;
  }
  // 0.57.1 review: the UI drops API-only hints about the claimed_price parameter ("payment request found (pass claimed_price
  // to compare the price)" -> "payment request found"); the API JSON keeps its reason unchanged.
  function uiReason(r) {
    var t = String(r || "").replace(/\\s*\\([^()]*claimed[_ ]price[^()]*\\)/gi, "");
    if (/claimed[_ ]price/i.test(t)) t = t.split(/[;,]/).filter(function (c) { return !/claimed[_ ]price/i.test(c); }).join(",").replace(/\\s+/g, " ").trim();
    return t || "payment request found";
  }
  function result(j) {
    var v = String(j.verdict || ""), head = el("p");
    var badge = el("span", "ti-v ti-" + (v === "pay" || v === "skip" || v === "recheck" ? v : "msg"), v || "?"); head.appendChild(badge);
    head.appendChild(document.createTextNode(uiReason(j.reason || j.reason_code || "")));
    var nodes = [head];
    if (v === "recheck") nodes.push(el("p", "ti-note", (RECHECK_WHY[j.reason_code] || "We couldn't confirm the terms right now.") + " Recheck means nothing is approved yet: don't pay on this answer; check again in a minute."));
    else if (v === "skip") nodes.push(el("p", "ti-note", "Skip means don't pay this endpoint as it stands."));
    else if (v === "pay") nodes.push(el("p", "ti-note", /^no listing to compare/i.test(String(j.explain || "")) ? "Pay means the live 402 is a valid USDC payment request on a supported network; there was no listing to compare the price and wallet against." : "Pay means the live 402 terms match the listing right now."));
    if (j.explain) nodes.push(el("p", "ti-note", j.explain));
    nodes.push(termsTable(j));
    if (!j.payment) nodes.push(el("p", "ti-note", "Free checks show which terms matched; the exact amount, payTo wallet and the payment object to sign come with the $0.02 paid check."));
    var href = receiptHref(j);
    if (href) { var p = el("p", "ti-note"); p.appendChild(document.createTextNode("Signed receipt: ")); p.appendChild(link(href, String(j.receipt_id || href))); nodes.push(p); }
    var a = j.access || {};
    if (a.tier === "free" && a.free_remaining_today != null) nodes.push(el("p", "ti-note", "Free checks left today: " + a.free_remaining_today + "."));
    show(nodes);
  }
  function busy(on) { btn.disabled = on; btn.textContent = on ? "Checking\\u2026" : "Check"; input.setAttribute("aria-busy", on ? "true" : "false"); }
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = validate(input.value);
    if (v.error) { message(v.error, "ti-err"); input.focus(); return; }
    busy(true); message("Checking\\u2026 (one unpaid probe of the endpoint; usually a few seconds)");
    var ctl = typeof AbortController === "function" ? new AbortController() : null, timedOut = false;
    var timer = setTimeout(function () { timedOut = true; if (ctl) ctl.abort(); }, TIMEOUT_MS);
    var q = new URLSearchParams({ url: v.url, ref: REF });
    fetch("/v1/products/endpoint-spot-check?" + q.toString(), { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, h: r.headers.get("x-402-placeholder"), j: j || {} }; }); })
      .then(function (x) {
        if (timedOut) throw new Error("timeout");
        var j = x.j;
        if (x.status === 200 && j.verdict) return result(j);
        if (x.status === 402 && (x.h === "1" || /placeholder/i.test(String(j.error || "")))) return message("That's an example address. Paste a real x402 endpoint URL.", "ti-err");
        if (x.status === 402) return message("You've used today's " + (j.free_per_day || 5) + " free checks. Agents can keep checking for $0.02 each over x402; see below. Free checks reset at 00:00 UTC.", "ti-msg", [belowLink()]);
        if (x.status === 429) return message("This network has used today's free checks (they're capped per network as well as per client). They reset at 00:00 UTC.", "ti-msg", [belowLink()]);
        if (x.status === 400) return message("We can't check that URL: " + (j.reason_code === "ssrf_blocked" ? "it points to a private, local or otherwise unsafe address, so it is never fetched." : String(j.error || j.problem || j.message || j.reason || "the server rejected it as a bad request.").slice(0, 300)), "ti-err");
        if (x.status === 503) return message("402xAgent is busy right now. Please try again in a minute.", "ti-err");
        return message("Unexpected answer from 402xAgent (HTTP " + x.status + "). Please try again in a minute.", "ti-err");
      })
      .catch(function () {
        if (timedOut) message("This endpoint is slow to respond, try again in a moment.", "ti-err");
        else message("Couldn't reach 402xAgent (network error). Check your connection and try again.", "ti-err");
      })
      .then(function () { clearTimeout(timer); busy(false); });
  });
})();
`;
