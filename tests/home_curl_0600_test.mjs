// 0.60.0: "Check any x402 URL" on the homepage: empty input (no prefill), live curl snippet, XSS/shell-safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { homeHtml, homeCurl, curlEnc, HOME_JS, HOME_CURL_BASE, HOME_CURL_EMPTY } from "../worker/src/home.js";
import { DOCS_TRYIT_PREFILL, DOCS_TRYIT_PLACEHOLDER } from "../worker/src/tryit.js";
import { VERSION } from "../worker/src/lib.js";

const page = () => homeHtml("https://402xagent.com", {});

test("0.60.0 version", () => assert.equal(VERSION, "0.66.2"));

test("renders the 'Check any x402 URL' box with input, button and result slot", () => {
  const t = page();
  assert.ok(t.includes("<strong>Check any x402 URL</strong>"));
  for (const id of ['id="hc-form"', 'id="hc-url"', 'id="hc-go"', 'id="hc-out"', 'id="hc-curl"', 'id="hc-curl-copy"']) assert.ok(t.includes(id), id);
});

test("input is empty with a placeholder; the docs example URL is not prefilled", () => {
  const input = page().match(/<input id="hc-url"[^>]*>/)[0];
  assert.ok(input.includes(' value=""'));
  assert.ok(input.includes(`placeholder="${DOCS_TRYIT_PLACEHOLDER}"`));
  assert.ok(!input.includes(DOCS_TRYIT_PREFILL));
});

test("server-rendered snippet shows the empty placeholder, HTML-escaped", () => {
  const t = page();
  assert.ok(t.includes(`<code id="hc-curl">curl -s &#39;${HOME_CURL_BASE}&lt;endpoint-url&gt;&#39;</code>`));
});

test("homeCurl encodes input so it can't break out of the shell quote or inject HTML", () => {
  assert.equal(homeCurl(""), `curl -s '${HOME_CURL_BASE}${HOME_CURL_EMPTY}'`);
  assert.equal(homeCurl(" https://a.b/x?y=1 "), `curl -s '${HOME_CURL_BASE}https%3A%2F%2Fa.b%2Fx%3Fy%3D1'`);
  const evil = `https://x.io/'; rm -rf / #"<script>alert(1)</script>$(id)\`id\`!*()`;
  const c = homeCurl(evil);
  const arg = c.slice("curl -s '".length, -1);
  assert.ok(!/['"<>$`\s;!*()]/.test(arg), arg);
  assert.equal(decodeURIComponent(arg.slice(HOME_CURL_BASE.length)), evil);
  assert.equal(curlEnc("'()!*"), "%27%28%29%21%2A");
});

test("/home.js updates the snippet with textContent only, using the same encoding", () => {
  assert.ok(HOME_JS.includes('curl.textContent = curlText()'));
  assert.ok(HOME_JS.includes('input.addEventListener("input", syncCurl)'));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(HOME_JS));
  assert.ok(HOME_JS.includes(JSON.stringify(HOME_CURL_BASE)));
  // run the browser curlText against the server one
  const m = HOME_JS.match(/function curlEnc\(v\) \{[^\n]*\n/)[0];
  const fn = new Function("CURL_BASE", "CURL_EMPTY", "input", m + 'function curlText() { var v = String(input ? input.value : "").trim(); return "curl -s \'" + CURL_BASE + (v ? curlEnc(v) : CURL_EMPTY) + "\'"; } return curlText();');
  for (const v of ["", "https://api.402rates.com/v1/ping", `https://e.io/'<b>"$(x)`]) assert.equal(fn(HOME_CURL_BASE, HOME_CURL_EMPTY, { value: v }), homeCurl(v));
});

test("mobile: the snippet wraps instead of overflowing", () => {
  assert.match(page(), /\.curl-snippet pre\{[^}]*white-space:pre-wrap[^}]*word-break:break-all/);
});

test("snapshot helper: the 0.60.0 diff is exactly the title, the empty value, the snippet block + CSS, and the snippet JS", async () => {
  const { as0598 } = await import("./helpers/machine_snapshot.mjs");
  const js = as0598("GET https://402xagent.com/home.js [html]", HOME_JS);
  assert.ok(js !== HOME_JS && !js.includes("hc-curl") && !js.includes("syncCurl"));
  const h = as0598("GET https://402xagent.com/ [html]", page());
  assert.ok(!h.includes("hc-curl") && !h.includes(".curl-snippet") && h.includes(`value="${DOCS_TRYIT_PREFILL}"`) && h.includes("Try it: free check"));
});
