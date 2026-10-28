// 0.58.4: the x402-spotcheck audit layer card on the homepage Products tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { AUDIT_CARD_HTML, AUDIT_CSS, HOME_CSS, HOME_CSP } from "../worker/src/home.js";
import { BLOG_POSTS } from "../worker/src/blog-data.js";

const home = async () => (await worker.fetch(new Request("https://402xagent.com/", { headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } }), { ENDPOINT_REPORT: "1", WATCHTOWER: "1" }, { waitUntil() {} })).text();
const text = (h) => h.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").replace(/&rarr;/g, "").replace(/\s+/g, " ").trim();

test("0.58.4 audit card: on the Products tab, free and MIT, clearly not a paid check", async () => {
  const t = await home();
  const panel = t.slice(t.indexOf('id="panel-products"'), t.indexOf('id="panel-skips"'));
  assert.ok(panel.includes(AUDIT_CARD_HTML), "inside the Products panel");
  assert.equal(t.split('id="audit-layer"').length, 2);
  const c = text(AUDIT_CARD_HTML);
  assert.match(c, /^Audit layer x402-spotcheck\/audit Free open source \(MIT\)/);
  assert.match(c, /Not a paid check\. A library that runs inside your agent/);
  assert.match(c, /never sees your keys, and these steps make no network calls/);
  assert.match(c, /Per-call ceiling and a daily budget \(per UTC day\), reserved before signing/);
  assert.match(c, /Wallet deny list: a listed payTo is refused/);
  assert.match(c, /Hash-chained audit ledger .*opt-in SQLite store \(Node 22\.13\+\) it survives restarts and is verified when it opens/);
  assert.doesNotMatch(c, /\$\d|hosted|approval|remote|authorize service/i, "no price, nothing unbuilt");
});

test("0.58.4 audit card links: npm and the two Oct 20 posts (real slugs)", () => {
  const hrefs = [...AUDIT_CARD_HTML.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["https://www.npmjs.com/package/x402-spotcheck", "/blog/x402-spotcheck-audit-layer-budgets-ledger", "/blog/x402-spotcheck-1-6-audit-layer-what-it-defends"]);
  const oct20 = BLOG_POSTS.filter((p) => p.date === "2026-10-20").map((p) => "/blog/" + p.slug).sort();
  assert.deepEqual(hrefs.slice(1).sort(), oct20);
});

test("0.58.4 audit flow diagram: CSP-safe inline SVG in the 1.6.0 order, horizontal and stacked", async () => {
  const svgs = AUDIT_CARD_HTML.match(/<svg[\s\S]*?<\/svg>/g);
  assert.equal(svgs.length, 2);
  for (const s of svgs) {
    assert.doesNotMatch(s, /<script|<foreignObject|<image|<use|\son[a-z]+=|javascript:|href=|url\((?!#af[hv]-a\))|@import|style=/i);
    const labels = [...s.matchAll(/font-weight="700"[^>]*>([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(labels, ["Agent wants to pay", "Wallet deny list", "Per-call ceiling", "Daily budget", "Ledger entry", "Allowed", "Blocked"]);
    assert.match(s, /hash-chained/); assert.match(s, /written either way: reserved or denied/);
    assert.match(s, /role="img" aria-labelledby="af[hv]-t af[hv]-d"/);
  }
  assert.match(svgs[0], /class="flow-h"/); assert.match(svgs[1], /class="flow-v"/);
  assert.match(AUDIT_CSS, /@media\(max-width:760px\)\{\.audit-flow \.flow-h\{display:none\}\.audit-flow \.flow-v\{display:block/);
  assert.ok(!HOME_CSS.includes("audit"), "the shared stylesheet (also /pricing) is untouched");
  assert.match(HOME_CSP, /default-src 'none'/); assert.match(HOME_CSP, /style-src 'unsafe-inline'/); // inline <style> and SVG attributes are allowed; nothing is loaded
});
