// 0.49.3: agenteconomy.report badge on the homepage + "Verified owner" link next to our payTo on /docs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { landingHtml } from "../worker/src/landing.js";
import { docsHtml } from "../worker/src/pages.js";
import { VERSION } from "../worker/src/lib.js";

const COPY = "Independently tracked by agenteconomy.report";

test("version (0.49.3 badge, now 0.58.9)", () => assert.equal(VERSION, "0.58.9"));

test("homepage badge: text link only until graded, no img", () => {
  const html = landingHtml("https://402xagent.com");
  const m = html.match(/<a href="https:\/\/agenteconomy\.report\/s\/"[^>]*><span>([^<]+)<\/span><\/a>/);
  assert.ok(m, "text link present");
  assert.equal(m[1], COPY);
  const foot = html.slice(html.indexOf("aer-badge"), html.indexOf("</footer>"));
  assert.ok(!/<img[^>]+agenteconomy/.test(html), "no badge img");
  assert.ok(!/agenteconomy\.report\/s\/[^"]*\.svg/.test(html), "no SVG URL in source (incl. comments)");
  assert.ok(!/grade[ds]? [A-F]\b/.test(foot), "no grade commentary");
});

test("docs: Verified owner link next to our payTo", () => {
  const html = docsHtml("https://402xagent.com", "https://api.402xagent.com");
  assert.match(html, /0x37cf…8674<\/code> \(our payTo; <a href="https:\/\/agenteconomy\.report\/api\/claim\/api\.402xagent\.com"[^>]*>Verified owner<\/a>\)/);
});
