// 0.58.8: blog-only release. The comparison post is replaced in place (same slug) and "What x402 verification actually
// means" is new. Editorial parts (reviewer HTML comment) must not ship; the blog index and llms.txt list the new post.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { BLOG_POSTS } from "../worker/src/blog-data.js";

// SAVES_PAGE on as in worker/wrangler.toml (the comparison post links /saves)
const env = { SAVES_PAGE: "on", WEEK_EPOCH: "2026-10-01", FREE_PER_DAY: "5", PRICE_ATOMIC: "20000" };
const get = async (p, accept = "text/html") => {
  const res = await worker.fetch(new Request("https://402xagent.com" + p, { headers: { accept, "user-agent": "Mozilla/5.0", "cf-connecting-ip": "203.0.113.9" } }), env, { waitUntil() {}, passThroughOnException() {} });
  return { status: res.status, body: await res.text() };
};

test("0.58.8 blog: both posts render, no editorial comment ships", async () => {
  for (const slug of ["x402-endpoint-checks-compared", "what-is-x402-verification"]) {
    const r = await get("/blog/" + slug);
    assert.equal(r.status, 200, slug);
    assert.doesNotMatch(r.body, /REVIEWER|CHANGELOG|<!--/, slug);
  }
  for (const p of BLOG_POSTS) assert.doesNotMatch(p.html, /REVIEWER|<!--/, p.slug);
  assert.ok(!BLOG_POSTS.some((p) => /UPDATE/i.test(p.slug)), "no -UPDATE post");
});

test("0.58.8 blog: comparison post has seven tools and the corrected TOLLkit quote", async () => {
  const { body } = await get("/blog/x402-endpoint-checks-compared");
  assert.match(body, /Seven Ways to Look Before Your Agent Pays/);
  assert.match(body, /facts and signals only/);
  assert.doesNotMatch(body, /does not score or recommend/);
});

test("0.58.8 blog: index and llms.txt list the new post first", async () => {
  assert.equal(BLOG_POSTS[0].slug, "what-is-x402-verification");
  assert.match((await get("/blog")).body, /href="\/blog\/what-is-x402-verification"/);
  assert.match((await get("/llms.txt", "text/plain")).body, /\n  - What x402 Verification Actually Means \(and What It Can't Tell You\): https:\/\/402xagent\.com\/blog\/what-is-x402-verification\n/);
});

test("0.58.8 blog: internal links in both posts resolve", async () => {
  for (const slug of ["x402-endpoint-checks-compared", "what-is-x402-verification"]) {
    const html = BLOG_POSTS.find((p) => p.slug === slug).html;
    const links = [...html.matchAll(/href="https:\/\/402xagent\.com(\/[^"#]*)(?:#([^"]+))?"/g)];
    assert.ok(links.length > 0, slug);
    for (const [, path, frag] of links) {
      const r = await get(path.replace(/&amp;/g, "&"));
      assert.equal(r.status, 200, slug + " -> " + path);
      if (frag) assert.match(r.body, new RegExp(`id="${frag}"`), slug + " -> " + path + "#" + frag);
    }
  }
});
