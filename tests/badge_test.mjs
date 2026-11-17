// 0.49.3 added an agenteconomy.report "Independently tracked" badge on the unused
// landing page and a "Verified owner" link next to our payTo on /docs.
// The landing badge was removed after AER delisted api.402xagent.com (2026-11-16).
// Keep the stale "Independently tracked" claim off landingHtml; do not put it back.
// The /docs Verified owner link stays (claim API is independent of the rating index).
import { test } from "node:test";
import assert from "node:assert/strict";
import { landingHtml } from "../worker/src/landing.js";
import { docsHtml } from "../worker/src/pages.js";
import { VERSION } from "../worker/src/lib.js";

const STALE_CLAIM = "Independently tracked by agenteconomy.report";

test("version (0.49.3 badge, now 0.58.9)", () => assert.equal(VERSION, "0.72.0"));

test("landingHtml: no stale agenteconomy.report tracked claim, no badge img", () => {
  const html = landingHtml("https://402xagent.com");
  assert.equal(html.includes(STALE_CLAIM), false, "stale tracked claim must stay off landingHtml");
  assert.equal(html.includes("aer-badge"), false, "no aer-badge markup");
  assert.ok(!/<a[^>]+agenteconomy\.report\/s\//.test(html), "no AER index/badge link on unused landing");
  assert.ok(!/<img[^>]+agenteconomy/.test(html), "no badge img");
  assert.ok(!/agenteconomy\.report\/s\/[^"]*\.svg/.test(html), "no SVG URL in source (incl. comments)");
  assert.ok(html.includes("</footer>"), "footer still present");
});

test("docs: Verified owner link next to our payTo", () => {
  const html = docsHtml("https://402xagent.com", "https://api.402xagent.com");
  assert.match(html, /0x37cf…8674<\/code> \(our payTo; <a href="https:\/\/agenteconomy\.report\/api\/claim\/api\.402xagent\.com"[^>]*>Verified owner<\/a>\)/);
});
