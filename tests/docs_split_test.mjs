// 0.58.6: /docs split into an index plus one page per product. Nothing lost, old anchors kept, strict CSP, audit layer in footers.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { DOCS_PAGES, DOCS_ANCHOR_MAP, DOCS_MOVED, DOCS_WORDING, DOCS_ANCHORS_PATH, DOCS_ANCHORS_JS, DOCS_EXAMPLE_RECEIPT, legacyDocsParts, applyWording } from "../worker/src/docs.js";
import { CANON_ORIGIN, API_ORIGIN } from "../worker/src/spotcheck.js";
import { DOCS_CSP } from "../worker/src/tryit.js";

const ENV = { ENDPOINT_REPORT: "1", WATCHTOWER: "1", SPOT_FREE_PER_DAY: "5", SPOT_FREE_PER_IP_DAY: "25" };
const HTML = "text/html,application/xhtml+xml,*/*;q=0.8";
const get = async (path, env = ENV, accept = HTML) => {
  const r = await worker.fetch(new Request("https://402xagent.com" + path, { headers: { accept, "user-agent": "Mozilla/5.0", "cf-connecting-ip": "203.0.113.9" } }), env, { waitUntil() {} });
  return { r, t: await r.text() };
};
const OPTS = { endpointReport: true, watchtower: true, tryIt: { freePerDay: 5 } };
const PAGES = ["/docs", ...DOCS_PAGES.map((p) => "/docs/" + p.slug)];

test("every legacy /docs block is on a new page, verbatim except the listed wording fixes", async () => {
  const { intro, sections, body } = legacyDocsParts(CANON_ORIGIN, API_ORIGIN, OPTS);
  assert.equal(intro.length + Object.values(sections).reduce((n, s) => n + s.length, 0) + Object.keys(sections).length - 1 >= body.length - 2, true, "the cut covers the whole body");
  const idx = (await get("/docs")).t;
  assert.ok(idx.includes(intro.replace(/^<h1>Docs<\/h1>\n/, "")), "intro (incl. try-it) on /docs");
  assert.ok(idx.includes(sections["quick-start"]), "quick start on /docs");
  const homeOf = Object.fromEntries(DOCS_PAGES.flatMap((p) => p.sections.map((s) => [s, "/docs/" + p.slug])));
  assert.deepEqual(Object.keys(sections).sort(), Object.keys(homeOf).sort(), "every legacy section has a page");
  for (const [id, path] of Object.entries(homeOf)) assert.ok((await get(path)).t.includes(applyWording(sections[id])), id + " re-housed on " + path);
  for (const [a, b] of DOCS_WORDING) {
    assert.equal(Object.values(sections).join("").split(a).length, 2, "wording fix hits exactly once: " + a.slice(0, 30));
    assert.equal(PAGES.length && (await Promise.all(PAGES.map((p) => get(p)))).filter(({ t }) => t.includes(b)).length, 1, "new wording on one page");
  }
  const all = (await Promise.all(PAGES.map((p) => get(p)))).map((x) => x.t).join("");
  assert.ok(!/Every hour we re-probe|monthly USDC invoice/.test(all), "old wording gone from the docs pages");
  assert.ok(all.includes("Regular re-probes") && all.includes("Usage tracked; billed monthly by arrangement"));
});

test("old anchors: each id is on /docs as a visible pointer link (works with JS off); anchors.js maps the moved ones", async () => {
  const { t } = await get("/docs");
  for (const [id, to] of Object.entries(DOCS_ANCHOR_MAP)) {
    assert.equal(t.split(`id="${id}"`).length, 2, id + " exactly once on /docs");
    if (DOCS_MOVED.includes(id)) assert.match(t, new RegExp(`<section class="dc-moved" id="${id}"><h2>[^<]+</h2><p>Moved to <a href="${to.replace(/[#/]/g, "\\$&")}">`), id + " pointer");
  }
  for (const id of DOCS_MOVED) { const [p, h] = DOCS_ANCHOR_MAP[id].split("#"); const pg = (await get(p)); assert.equal(pg.r.status, 200, p); if (h) assert.ok(pg.t.includes(`id="${h}"`), DOCS_ANCHOR_MAP[id]); }
  const js = await get(DOCS_ANCHORS_PATH);
  assert.equal(js.r.status, 200); assert.match(js.r.headers.get("content-type"), /^(text|application)\/javascript/); assert.equal(js.t, DOCS_ANCHORS_JS);
  const m = JSON.parse(js.t.match(/var M = (\{.*\});/)[1]);
  assert.deepEqual(Object.keys(m).sort(), [...DOCS_MOVED].sort());
});

test("strict CSP, self-hosted scripts only, no inline script; audit layer in every footer; never 'Spot Check'", async () => {
  for (const p of [...PAGES, "/pricing", "/"]) {
    const { r, t } = await get(p);
    assert.equal(r.status, 200, p);
    if (p.startsWith("/docs")) assert.equal(r.headers.get("content-security-policy"), DOCS_CSP, p);
    for (const s of t.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) { assert.equal(s[2].trim(), "", p + " inline script"); assert.match(s[1], /src="(\/[^"]*|https:\/\/static\.cloudflareinsights\.com\/[^"]*)"/, p); }
    assert.ok(t.includes('<li><a href="/#audit-layer">Audit layer</a></li>'), p + " footer audit layer");
    assert.ok(!/spot[ -]?check/i.test(t.replace(/<code>[\s\S]*?<\/code>|<pre>[\s\S]*?<\/pre>|<[^>]+>/g, " ").replace(/x402-spotcheck/g, "")), p + " never Spot Check"); // API paths and npm names in code are identifiers, not the product name
  }
  assert.ok((await get("/docs")).t.includes(`<script src="${DOCS_ANCHORS_PATH}"></script>`));
  assert.ok((await get("/docs/receipt-verification")).t.includes(`href="${DOCS_EXAMPLE_RECEIPT}"`));
  for (const p of DOCS_PAGES) assert.match((await get("/docs/" + p.slug)).t, /<nav class="dc-next" aria-label="Next step">/, p.slug);
  assert.equal((await get("/docs/nope")).r.status, 404);
});
