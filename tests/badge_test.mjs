// 0.49.3: agenteconomy.report badge on the homepage + "Verified owner" link next to our payTo on /docs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { landingHtml } from "../worker/src/landing.js";
import { docsHtml } from "../worker/src/pages.js";
import { VERSION } from "../worker/src/lib.js";

const COPY = "Independently tracked by agenteconomy.report";

test("0.49.3 version", () => assert.equal(VERSION, "0.49.3"));

test("homepage badge: link, async img, fixed size, alt + visible text", () => {
  const html = landingHtml("https://402xagent.com");
  const m = html.match(/<a href="https:\/\/agenteconomy\.report\/s\/"[^>]*>(<img [^>]+>)\s*<span>([^<]+)<\/span><\/a>/);
  assert.ok(m, "badge anchor present");
  const img = m[1];
  assert.match(img, /src="https:\/\/agenteconomy\.report\/s\/api\.402xagent\.com\.svg"/);
  assert.match(img, /loading="lazy"/);
  assert.match(img, /decoding="async"/);
  assert.match(img, /width="\d+"/);
  assert.match(img, /height="\d+"/);
  assert.ok(img.includes(`alt="${COPY}"`));
  assert.equal(m[2], COPY);
  assert.ok(!/grade/i.test(html.slice(html.indexOf("aer-badge"), html.indexOf("</footer>"))), "no grade commentary");
});

test("docs: Verified owner link next to our payTo", () => {
  const html = docsHtml("https://402xagent.com", "https://api.402xagent.com");
  assert.match(html, /0x37cf…8674<\/code> \(our payTo; <a href="https:\/\/agenteconomy\.report\/api\/claim\/api\.402xagent\.com"[^>]*>Verified owner<\/a>\)/);
});
