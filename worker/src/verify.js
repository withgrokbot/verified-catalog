// 0.59.0: public offline receipt verifier. /verify (page), /verify.js (its script, external so the page keeps the strict
// CSP: script-src 'self' + Cloudflare Web Analytics, no inline script), /verify/402xagent-verifier.html (one
// self-contained HTML file to save and open from disk via file://) and /verify/verify-receipt.mjs (Node 18+ script).
// The public keys are PINNED into every copy (from RECEIPT_PUBLIC_KEYS, the same list /.well-known/402xagent-keys.json
// publishes; tests/verify_test.mjs checks they match). The verification path makes no network call: the page's only
// request is the optional "Fetch receipt JSON" convenience (same-origin GET /v1/receipts/<id>?format=json), which just
// fills the text box; checking is the same local code either way. No KV, no D1, nothing stored.
import { chromePage, esc } from "./chrome.js";
import { RECEIPT_PUBLIC_KEYS } from "./sign.js";
import { VERIFIER_CORE_SRC } from "./verify-core-src.js"; // static string, see scripts/gen-verify-core.mjs

export const VERIFY_PATH = "/verify";
export const VERIFY_SCRIPT_PATH = "/verify.js";
export const VERIFY_STANDALONE_PATH = "/verify/402xagent-verifier.html";
export const VERIFY_NODE_PATH = "/verify/verify-receipt.mjs";
export const VERIFY_PATHS = [VERIFY_PATH, VERIFY_SCRIPT_PATH, VERIFY_STANDALONE_PATH, VERIFY_NODE_PATH];
export const VERIFY_EXAMPLE_ID = "sc-7cf5080faccbc6ee";

/** The pinned keys: public part only, exactly the published {kid, x}. */
export const pinnedKeys = () => RECEIPT_PUBLIC_KEYS.map((k) => ({ kid: k.kid, x: k.x }));
const coreSrc = () => `const V402 = (${VERIFIER_CORE_SRC})(${JSON.stringify(pinnedKeys())});`;

// UI glue shared by the page script and the standalone file. Uses textContent / attributes only (never innerHTML).
// `allowFetch` is true only on the hosted page (same-origin fill-in convenience); the standalone file never fetches.
const uiSrc = (allowFetch) => `(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var box = $("vf-json"), out = $("vf-out"), form = $("vf-form"), idIn = $("vf-id"), fetchBtn = $("vf-fetch"), file = $("vf-file");
  if (!box || !out || !form) return;
  var LABEL = { valid: "VALID", invalid: "INVALID", "unsigned-crawl": "UNSIGNED (crawl record)", "unsigned-live": "UNSIGNED (older live-check record)", "unknown-key": "UNKNOWN KEY", "not-a-receipt": "NOT A RECEIPT" };
  function row(dl, k, v) { if (v === null || v === undefined || v === "") return; var dt = document.createElement("dt"); dt.textContent = k; var dd = document.createElement("dd"); dd.textContent = String(v); dl.appendChild(dt); dl.appendChild(dd); }
  function show(res) {
    out.textContent = ""; out.setAttribute("data-status", res.status);
    var h = document.createElement("p"); h.className = "vf-badge vf-" + res.status; h.id = "vf-status"; h.textContent = LABEL[res.status] || res.title; out.appendChild(h);
    var p = document.createElement("p"); p.className = "vf-detail"; p.textContent = res.detail; out.appendChild(p);
    var dl = document.createElement("dl"); dl.className = "vf-dl";
    row(dl, "Receipt", res.id); row(dl, "Verdict in receipt", res.verdict); row(dl, "Endpoint", res.url); row(dl, "Key id", res.kid);
    row(dl, "Checked with", res.engine); if (res.signed_bytes) row(dl, "Signed bytes", res.signed_bytes + " bytes, SHA-256 " + (res.signed_sha256 || "n/a"));
    if (dl.childNodes.length) out.appendChild(dl);
  }
  function busy(t) { out.textContent = ""; out.removeAttribute("data-status"); var p = document.createElement("p"); p.className = "vf-detail"; p.textContent = t; out.appendChild(p); }
  form.addEventListener("submit", function (e) { e.preventDefault(); busy("Checking on this device..."); V402.verifyText(box.value).then(show, function (err) { show({ status: "not-a-receipt", title: "Error", detail: String(err) }); }); });
  if (file) file.addEventListener("change", function () { var f = file.files && file.files[0]; if (!f) return; var rd = new FileReader(); rd.onload = function () { box.value = String(rd.result || ""); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit")); }; rd.readAsText(f); });
  ${allowFetch ? `var ID = /^(sc-[0-9a-f]{16}|[0-9a-f]{10})$/;
  function fill() {
    var id = String(idIn.value || "").trim(); if (!ID.test(id)) { busy("A receipt id is sc- plus 16 hex characters (live checks) or 10 hex characters (crawl)."); return; }
    busy("Fetching the receipt JSON (only to fill the box; the check itself runs on this device)...");
    fetch("/v1/receipts/" + id + "?format=json", { headers: { accept: "application/json" }, credentials: "omit" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(function (t) { box.value = t; form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit")); }, function (err) { busy("Could not fetch " + id + " (" + String(err && err.message || err) + "). Paste the receipt JSON instead."); });
  }
  if (fetchBtn && idIn) { fetchBtn.addEventListener("click", fill); var q = new URLSearchParams(location.search).get("id"); if (q && ID.test(q)) idIn.value = q; }` : ""}
})();`;

/** /verify.js: core + page glue (with the same-origin fill-in). */
export const verifyPageJs = () => coreSrc() + "\n" + uiSrc(true) + "\n";

const CSS = `
.vf-card{background:#fff;border:1px solid var(--border);border-radius:var(--radius-lg);padding:22px 24px;margin:0 0 18px;box-shadow:0 10px 30px rgba(60,35,5,.06)}
.vf-card h2{font-size:18px;margin:0 0 12px;color:var(--forest)}
.vf-row{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}
.vf-row input{flex:1 1 240px;min-width:0;padding:11px 14px;border:1px solid var(--border-strong);border-radius:10px;background:#fff;font:inherit;font-family:var(--mono);font-size:14px}
#vf-json{display:block;width:100%;min-height:200px;box-sizing:border-box;padding:12px 14px;border:1px solid var(--border-strong);border-radius:10px;font-family:var(--mono);font-size:13px;resize:vertical}
.vf-btn{padding:11px 18px;border-radius:10px;border:none;background:var(--accent);color:#fff;font-weight:700;cursor:pointer;font:inherit;font-weight:700}
.vf-btn.alt{background:var(--forest)}
.vf-actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:12px 0 0}
#vf-out{margin:16px 0 0}
.vf-badge{display:inline-block;font-weight:800;letter-spacing:.03em;padding:8px 14px;border-radius:999px;margin:0 0 8px;background:var(--bg-subtle);color:var(--text)}
.vf-valid{background:#1f7a3a;color:#fff}.vf-invalid{background:#b3261e;color:#fff}.vf-unknown-key{background:#8a5a00;color:#fff}
.vf-unsigned-crawl,.vf-unsigned-live,.vf-not-a-receipt{background:var(--bg-subtle);color:var(--text);border:1px solid var(--border-strong)}
.vf-detail{margin:0 0 10px;color:var(--text-2)}
dl.vf-dl{display:grid;grid-template-columns:minmax(120px,200px) minmax(0,1fr);gap:6px 16px;margin:0;font-size:14px}
dl.vf-dl dt{color:var(--text-3);font-weight:600}dl.vf-dl dd{margin:0;overflow-wrap:anywhere;font-family:var(--mono);font-size:13px}
.vf-keys code{overflow-wrap:anywhere}
@media(max-width:760px){.vf-card{padding:18px 16px}dl.vf-dl{grid-template-columns:1fr;gap:2px}dl.vf-dl dd{margin:0 0 8px}}`;

const keysList = () => pinnedKeys().map((k) => `<li><code>${esc(k.kid)}</code>: <code>${esc(k.x)}</code></li>`).join("");
const formHtml = (allowFetch) => `${allowFetch ? `<label for="vf-id"><strong>Receipt id</strong> (optional: fetches the JSON into the box below; the check itself never calls our servers)</label>
<div class="vf-row"><input id="vf-id" name="id" autocomplete="off" spellcheck="false" maxlength="40" placeholder="${VERIFY_EXAMPLE_ID}"><button type="button" class="vf-btn alt" id="vf-fetch">Fetch receipt JSON</button></div>
` : ""}<form id="vf-form" novalidate>
<label for="vf-json"><strong>Receipt JSON</strong></label>
<textarea id="vf-json" name="receipt" spellcheck="false" autocomplete="off" placeholder='{"id":"sc-...","verdict":"...","kid":"...","signature":"..."}'></textarea>
<div class="vf-actions"><button type="submit" class="vf-btn" id="vf-go">Verify</button><label>or open a saved .json file: <input type="file" id="vf-file" accept="application/json,.json"></label></div>
</form>
<div id="vf-out" role="status" aria-live="polite"></div>`;

const howHtml = () => `<p>What is checked: the Ed25519 signature (RFC 8032) over the RFC 8785 (JCS) canonical JSON of the receipt with only <code>signature</code> removed (so <code>kid</code> is signed), against the pinned key with that <code>kid</code>. A valid signature proves 402xAgent issued the receipt unchanged; it does not change or endorse the verdict.</p>
<p>Results: <strong>VALID</strong>; <strong>INVALID</strong> (changed after signing); <strong>UNKNOWN KEY</strong> (a key this copy does not pin: get a newer copy); <strong>UNSIGNED (crawl record)</strong> (crawl receipts are not signed, so they are neither valid nor invalid).</p>
<p class="vf-keys">Pinned public keys (the same as <a href="/.well-known/402xagent-keys.json">/.well-known/402xagent-keys.json</a>):</p><ul class="vf-keys">${keysList()}</ul>`;

/** GET /verify */
export function verifyPageHtml(origin, fp) {
  const main = `<section class="pg-hero"><h1>Verify a receipt offline</h1><p class="pg-lead">Paste a 402xAgent receipt and check its signature on your own device. The public keys are built into this page, so the check makes no call to our servers and still works with them blocked.</p></section>
<div class="pg-body">
<section class="vf-card" aria-labelledby="vf-h"><h2 id="vf-h">Check a receipt</h2>
${formHtml(true)}
<noscript><p>Needs JavaScript. Without it, use the Node script below.</p></noscript>
</section>
<section class="vf-card" id="download" aria-labelledby="vf-dl-h"><h2 id="vf-dl-h">Verify without this site</h2>
<p><a href="${VERIFY_STANDALONE_PATH}" download>Download the standalone verifier</a> (one HTML file, no dependencies, keys pinned inside). Open it from disk in any current browser, with no network at all.</p>
<p>Or with Node 18+: <a href="${VERIFY_NODE_PATH}" download>verify-receipt.mjs</a>, then <code>node verify-receipt.mjs receipt.json</code> (exit code 0 only for VALID).</p>
</section>
<section class="vf-card" aria-labelledby="vf-how-h"><h2 id="vf-how-h">How it works</h2>${howHtml()}
<p>Details: <a href="/docs/receipt-verification#receipt-signatures">Receipt verification docs</a>.</p></section>
</div>
<script src="${VERIFY_SCRIPT_PATH}" defer></script>`;
  return chromePage({ title: "Verify a receipt offline · 402xAgent", desc: "Check a 402xAgent receipt's Ed25519 signature on your own device, with the public keys pinned in the page. No call to our servers.", canonical: origin + VERIFY_PATH, current: "", css: CSS, main, footer: fp });
}

/** GET /verify/402xagent-verifier.html: one self-contained file (inline style + script), never fetches. */
export function verifyStandaloneHtml() {
  const script = coreSrc() + "\n" + uiSrc(false);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'; base-uri 'none'">
<title>402xAgent receipt verifier (offline)</title>
<style>:root{--border:#e4ddd3;--border-strong:#c9bfb2;--bg-subtle:#f4efe8;--text:#1d1a16;--text-2:#4a443c;--text-3:#7a7166;--forest:#1f3d2b;--accent:#c2410c;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--radius-lg:16px}
body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--text);background:#fbf8f4}main{max-width:860px;margin:0 auto;padding:28px 18px 60px}h1{font-size:28px;margin:0 0 6px;color:var(--forest)}a{color:#1d4ed8}code{font-family:var(--mono);font-size:.88em;background:var(--bg-subtle);padding:1px 5px;border-radius:5px}
${CSS}</style>
</head>
<body>
<main>
<h1>402xAgent receipt verifier (offline)</h1>
<p>This file works with no network: the public keys are pinned below and nothing is fetched. Paste a receipt JSON (from <code>https://402xagent.com/v1/receipts/&lt;id&gt;?format=json</code>) or open a saved .json file.</p>
<section class="vf-card">${formHtml(false)}</section>
<section class="vf-card">${howHtml().replace('<a href="/.well-known/402xagent-keys.json">/.well-known/402xagent-keys.json</a>', "<code>https://402xagent.com/.well-known/402xagent-keys.json</code>")}</section>
</main>
<script>
${script}
</script>
</body>
</html>
`;
}

/** GET /verify/verify-receipt.mjs: Node 18+ CLI, no dependencies, keys pinned. */
export function verifyNodeScript() {
  return `#!/usr/bin/env node
// 402xAgent offline receipt verifier (Node 18+, no dependencies, public keys pinned below, no network).
// Usage: node verify-receipt.mjs receipt.json   (or: cat receipt.json | node verify-receipt.mjs -)
// Exit code: 0 VALID, 1 INVALID, 2 unsigned / unknown key / not a receipt.
import { readFileSync } from "node:fs";
${coreSrc()}
const arg = process.argv[2];
if (!arg) { console.error("usage: node verify-receipt.mjs <receipt.json | ->"); process.exit(2); }
const text = readFileSync(arg === "-" ? 0 : arg, "utf8");
const res = await V402.verifyText(text);
console.log(res.title + (res.id ? " " + res.id : "") + (res.kid ? " (kid " + res.kid + ")" : ""));
console.log(res.detail);
process.exit(res.status === "valid" ? 0 : res.status === "invalid" ? 1 : 2);
`;
}

export const VERIFY_SCRIPT_HEADERS = { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "access-control-allow-origin": "*" };
