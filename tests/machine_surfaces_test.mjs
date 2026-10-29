// 0.58.0: every machine surface is byte-identical to 0.57.1 (main 5efdf33): root JSON for non-browser clients (no Accept,
// application/json, */*, text/plain, curl) on every host, llms.txt, skill.md, rules.json, openapi.json, /mcp (GET + JSON-RPC
// initialize / tools/list / resources/list), every /v1 route (GET and POST, plus browsers on /v1), /.well-known, /health.
// Status, every response header and the body sha256 must match the saved snapshot; the only tolerated change is the
// VERSION string (replaced by "<VERSION>" on both sides). Snapshot: node tests/helpers/machine_snapshot.mjs <worker/src/index.js>
// run on a 0.57.1 checkout, saved to tests/fixtures/machine_0.57.1/snapshot.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { RECEIPT_HTML_KEY, DOCS_PRICING_KEY, HOME_KEY, restoreHomeFooter, SKIPS_HTML_KEY, META402_KEYS } from "./helpers/machine_snapshot.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const BLOG0587 = { ...process.env, SNAP_BLOG_AS_0587: "1" }; // 0.58.8: older fixtures predate the two Oct 29 blog changes (see helper)
const want = JSON.parse(readFileSync(join(HERE, "fixtures", "machine_0.57.1", "snapshot.json"), "utf8"));

test("0.58.0 machine surfaces: byte-identical to the 0.57.1 snapshot (status, headers, body)", () => {
  const r = spawnSync(process.execPath, [join(HERE, "helpers", "machine_snapshot.mjs"), join(HERE, "..", "worker", "src", "index.js")], { encoding: "utf8", maxBuffer: 64 << 20, env: BLOG0587 });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.ok(Object.keys(want).length > 1000, "snapshot covers the surfaces");
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), "same request set");
  const diff = Object.keys(want).filter((k) => !RECEIPT_HTML_KEY.test(k) && !SKIPS_HTML_KEY.test(k) && !META402_KEYS.has(k) && JSON.stringify(got[k]) !== JSON.stringify(want[k])); // 0.58.7: browser /v1/skips // 0.58.5: receipt pages for browsers
  assert.deepEqual(diff, [], "changed machine responses");
  // spot checks that the snapshot really covers what matters
  for (const k of ["GET https://402xagent.com/ [none]", "GET https://402xagent.com/ [json]", "GET https://402xagent.com/ [curl]", "GET https://api.402xagent.com/ [html]",
    "GET https://402xagent.com/llms.txt [none]", "GET https://402xagent.com/skill.md [none]", "GET https://402xagent.com/rules.json [none]", "GET https://api.402xagent.com/openapi.json [none]"])
    assert.ok(want[k] && want[k].status === 200, k);
  assert.match(want["GET https://402xagent.com/ [json]"].headers["content-type"], /application\/json/);
});

test("0.58.0 snapshot helper is deterministic and normalizes only the version", () => {
  const src = readFileSync(join(HERE, "helpers", "machine_snapshot.mjs"), "utf8");
  assert.match(src, /split\(VERSION\)\.join\("<VERSION>"\)/);
  assert.equal(createHash("sha256").update(JSON.stringify(want)).digest("hex").length, 64);
});

// 0.58.3: /pricing is rebuilt (HTML for every Accept, as before; it never had a machine form). Everything around it stays
// byte-identical to main 714e418 (0.58.2): the /pricing machine-looking paths (404 JSON) on every host and Accept, and the
// browser homepage, /home.js, /docs and /docs/try-it.js on 402xagent.com. The 0.57.1 snapshot above still covers root JSON,
// llms.txt, skill.md, openapi.json, /mcp and every /v1 route (llms.txt and openapi.json mention /pricing; both unchanged).
test("0.58.3 /pricing rebuild: pricing machine paths and the homepage are byte-identical to 0.58.2", () => {
  const want2 = JSON.parse(readFileSync(join(HERE, "fixtures", "machine_0.58.2", "extra.json"), "utf8"));
  const r = spawnSync(process.execPath, [join(HERE, "helpers", "machine_snapshot.mjs"), "--extra", join(HERE, "..", "worker", "src", "index.js")], { encoding: "utf8", maxBuffer: 64 << 20, env: BLOG0587 });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.ok(Object.keys(want2).length >= 180, "extra snapshot covers the pricing paths on every host");
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want2).sort(), "same request set");
  const HOME = "GET https://402xagent.com/ [html]";
  assert.deepEqual(Object.keys(want2).filter((k) => k !== HOME && !DOCS_PRICING_KEY.test(k) && !META402_KEYS.has(k) && JSON.stringify(got[k]) !== JSON.stringify(want2[k])), [], "changed responses"); // 0.58.6: /docs split
  // the homepage: same status and headers; the body differs from 0.58.2 only by the two review strings (Watchtower and Hosted cards)
  assert.equal(got[HOME].status, want2[HOME].status); assert.deepEqual(got[HOME].headers, want2[HOME].headers);
  assert.notEqual(got[HOME].sha256, want2[HOME].sha256, "the two card strings did change");
  for (const k of ["GET https://402xagent.com/ [html]", "GET https://402xagent.com/home.js [html]", "GET https://402xagent.com/docs [html]"]) assert.equal(want2[k].status, 200, k);
  for (const k of ["GET https://402xagent.com/pricing.json [json]", "GET https://api.402xagent.com/pricing.json [none]", "GET https://402xagent.com/v1/pricing [curl]"]) assert.equal(want2[k].status, 404, k);
});

test("0.58.3 review + 0.58.4: the homepage body equals 0.58.2 once the two card strings are swapped back and the audit card is removed", async () => {
  const want2 = JSON.parse(readFileSync(join(HERE, "fixtures", "machine_0.58.2", "extra.json"), "utf8"));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { snapshotHomeBody } = await import(${JSON.stringify(join(HERE, "helpers", "machine_snapshot.mjs"))});
    process.stdout.write(await snapshotHomeBody(${JSON.stringify(join(HERE, "..", "worker", "src", "index.js"))}));`], { encoding: "utf8", maxBuffer: 64 << 20, env: BLOG0587 });
  assert.equal(r.status, 0, r.stderr);
  const body = restoreHomeFooter(r.stdout); // 0.58.6: the footer's Products list is the only other change
  const SWAPS = [["Regular re-probes of an endpoint you depend on", "Hourly re-probes of an endpoint you depend on"],
    ["by arrangement: usage tracked; billed monthly by arrangement.", "by arrangement: hosted checks billed on a monthly USDC invoice instead of per call."]];
  for (const [now] of SWAPS) assert.equal(body.split(now).length, 2, now);
  // 0.58.4: the only other homepage change is the audit layer card (its HTML in the Products grid and its own CSS)
  const { AUDIT_CARD_HTML, AUDIT_CSS } = await import("../worker/src/home.js");
  assert.equal(body.split(AUDIT_CARD_HTML).length, 2, "the card once"); assert.equal(body.split(AUDIT_CSS).length, 2, "its CSS once");
  let old = body.replace("\n" + AUDIT_CARD_HTML, "").replace(AUDIT_CSS, "");
  for (const [now, was] of SWAPS) old = old.replace(now, was);
  assert.equal(createHash("sha256").update(old).digest("hex"), want2["GET https://402xagent.com/ [html]"].sha256, "nothing else on the homepage changed");
});

// 0.58.4: the audit layer card. Against a full 0.58.3 snapshot (main 139fed1: every machine surface, root JSON, llms.txt,
// openapi.json, /.well-known/*, /v1/*, /mcp, /home.js, /docs, /pricing on every host and Accept, the /pricing.json-style
// 404s): everything is byte-identical except the browser homepage, and the homepage minus the card equals 0.58.3 exactly.
test("0.58.4 audit layer card: every surface byte-identical to 0.58.3; the homepage only gains the card", async () => {
  const want3 = JSON.parse(readFileSync(join(HERE, "fixtures", "machine_0.58.3", "snapshot.json"), "utf8"));
  const r = spawnSync(process.execPath, [join(HERE, "helpers", "machine_snapshot.mjs"), "--0583", join(HERE, "..", "worker", "src", "index.js")], { encoding: "utf8", maxBuffer: 64 << 20, env: BLOG0587 });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  const HOME = "GET https://402xagent.com/ [html]";
  assert.ok(Object.keys(want3).length > 1400);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want3).sort(), "same request set");
  assert.deepEqual(Object.keys(want3).filter((k) => k !== HOME && !RECEIPT_HTML_KEY.test(k) && !DOCS_PRICING_KEY.test(k) && !SKIPS_HTML_KEY.test(k) && !META402_KEYS.has(k) && JSON.stringify(got[k]) !== JSON.stringify(want3[k])), [], "changed responses"); // 0.58.5 receipts, 0.58.6 docs + pricing
  for (const k of ["GET https://402xagent.com/pricing [html]", "GET https://api.402xagent.com/pricing [json]", "GET https://402xagent.com/home.js [html]", "GET https://402xagent.com/docs [html]", "GET https://402xagent.com/ [json]", "GET https://402xagent.com/llms.txt [none]", "GET https://api.402xagent.com/openapi.json [none]", "GET https://402xagent.com/.well-known/x402 [none]"])
    assert.ok(want3[k] && want3[k].status === 200, k);
  assert.deepEqual(got[HOME].headers, want3[HOME].headers);
  const b = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { snapshotHomeBody } = await import(${JSON.stringify(join(HERE, "helpers", "machine_snapshot.mjs"))});
    process.stdout.write(await snapshotHomeBody(${JSON.stringify(join(HERE, "..", "worker", "src", "index.js"))}));`], { encoding: "utf8", maxBuffer: 64 << 20, env: BLOG0587 });
  assert.equal(b.status, 0, b.stderr);
  const { AUDIT_CARD_HTML, AUDIT_CSS } = await import("../worker/src/home.js");
  const without = restoreHomeFooter(b.stdout).replace("\n" + AUDIT_CARD_HTML, "").replace(AUDIT_CSS, "");
  assert.equal(createHash("sha256").update(without).digest("hex"), want3[HOME].sha256, "homepage minus the card = 0.58.3");
});

// 0.58.5: receipts get HTML for browsers. Against main 1d5868d (0.58.4): the full snapshot (incl. the extra set and /pricing)
// is byte-identical except the browser receipt keys, and the receipt routes with a store of real sampled public receipts
// (fake D1) are byte-identical for every non-browser Accept; browsers get text/html with the strict CSP and vary: accept.
test("0.58.5 receipts HTML: every machine answer byte-identical to 0.58.4; only browser receipt pages change", () => {
  const W = join(HERE, "..", "worker", "src", "index.js");
  for (const [flag, file] of [["--0583", "snapshot.json"], ["--receipts", "receipts.json"]]) {
    const want4 = JSON.parse(readFileSync(join(HERE, "fixtures", "machine_0.58.4", file), "utf8"));
    const r = spawnSync(process.execPath, [join(HERE, "helpers", "machine_snapshot.mjs"), flag, W], { encoding: "utf8", maxBuffer: 64 << 20, env: BLOG0587 });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want4).sort(), file + ": same request set");
    assert.deepEqual(Object.keys(want4).filter((k) => !RECEIPT_HTML_KEY.test(k) && !DOCS_PRICING_KEY.test(k) && !SKIPS_HTML_KEY.test(k) && k !== HOME_KEY && !META402_KEYS.has(k) && JSON.stringify(got[k]) !== JSON.stringify(want4[k])), [], file + ": changed machine responses"); // 0.58.6: docs, pricing, home footer
    const changed = Object.keys(want4).filter((k) => RECEIPT_HTML_KEY.test(k));
    for (const k of changed) {
      assert.match(got[k].headers["content-type"], /^text\/html/, k);
      assert.equal(got[k].headers.vary, "accept", k);
      assert.match(got[k].headers["content-security-policy"], /default-src 'none'; script-src 'self' https:\/\/static\.cloudflareinsights\.com;/, k);
    }
    if (file === "receipts.json") {
      // the sampled real receipts are covered as JSON for every non-browser Accept on every host
      for (const id of ["44e3732d23", "sc-85c8963fb57e7b25", "sc-9841a8498462c4b0"]) for (const a of ["none", "json", "any", "text", "curl"]) for (const h of ["https://402xagent.com", "https://api.402xagent.com"]) {
        const k = `GET ${h}/v1/receipts/${id} [${a}]`;
        assert.equal(want4[k].status, 200, k); assert.match(want4[k].headers["content-type"], /application\/json/, k);
      }
      for (const a of ["none", "json", "any", "text", "curl"]) assert.match(want4[`GET https://402xagent.com/v1/receipts [${a}]`].headers["content-type"], /application\/json/);
      assert.equal(want4["GET https://402xagent.com/v1/receipts?type=live [json]"].status, 200);
      // left alone for browsers too: by-url, side receipts, the older hosts' 301
      for (const k of ["GET https://402xagent.com/v1/receipts/by-url?url=https://api.402rates.com/v1/ping [html]", "GET https://402xagent.com/v1/receipts/ps-0123456789abcdef [html]", "GET https://verified-catalog-lookup.withgrokbot.workers.dev/v1/receipts [html]"])
        assert.deepEqual(got[k], want4[k], k);
      assert.ok(changed.length >= 80, "browser receipt keys covered: " + changed.length);
    }
  }
});

// 0.58.6: /docs split + the audit layer on /pricing and in the footer. Against main 1d5868d (0.58.4), both fixture sets:
// the only changed keys are the browser receipt pages (0.58.5), /docs and /pricing (same status and headers), and the
// browser homepage, which equals 0.58.4 byte for byte once its footer Products list is put back. /docs/try-it.js, /home.js,
// llms.txt, openapi.json, /.well-known/*, /v1/*, root JSON and /mcp are unchanged.
test("0.58.6 docs split: only /docs, /pricing and the homepage footer change; every machine surface byte-identical to 0.58.4", async () => {
  const W = join(HERE, "..", "worker", "src", "index.js");
  const want4 = JSON.parse(readFileSync(join(HERE, "fixtures", "machine_0.58.4", "snapshot.json"), "utf8"));
  const r = spawnSync(process.execPath, [join(HERE, "helpers", "machine_snapshot.mjs"), "--0583", W], { encoding: "utf8", maxBuffer: 64 << 20, env: BLOG0587 });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  const changed = Object.keys(want4).filter((k) => !META402_KEYS.has(k) && JSON.stringify(got[k]) !== JSON.stringify(want4[k]));
  assert.deepEqual(changed.filter((k) => !RECEIPT_HTML_KEY.test(k) && !DOCS_PRICING_KEY.test(k) && !SKIPS_HTML_KEY.test(k) && k !== HOME_KEY), [], "nothing else changed");
  for (const k of changed.filter((k) => DOCS_PRICING_KEY.test(k) || k === HOME_KEY)) {
    assert.equal(got[k].status, want4[k].status, k); assert.deepEqual(got[k].headers, want4[k].headers, k + " headers");
  }
  for (const k of ["GET https://402xagent.com/docs/try-it.js [html]", "GET https://402xagent.com/home.js [html]", "GET https://402xagent.com/llms.txt [none]", "GET https://api.402xagent.com/openapi.json [json]", "GET https://402xagent.com/.well-known/x402 [none]", "GET https://402xagent.com/ [json]", "GET https://402xagent.com/v1/skips.json [html]", "GET https://402xagent.com/v1/skips [json]"])
    assert.deepEqual(got[k], want4[k], k); // 0.58.7: /v1/skips [html] is the redesigned page (test below); its JSON forms stay
  assert.ok(changed.includes("GET https://402xagent.com/docs [html]") && changed.includes("GET https://402xagent.com/pricing [html]") && changed.includes(HOME_KEY));
  const b = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { snapshotHomeBody } = await import(${JSON.stringify(join(HERE, "helpers", "machine_snapshot.mjs"))});
    process.stdout.write(await snapshotHomeBody(${JSON.stringify(W)}));`], { encoding: "utf8", maxBuffer: 64 << 20, env: BLOG0587 });
  assert.equal(b.status, 0, b.stderr);
  assert.equal(createHash("sha256").update(restoreHomeFooter(b.stdout)).digest("hex"), want4[HOME_KEY].sha256, "homepage = 0.58.4 except the footer Products list");
});

// 0.58.7: /v1/skips for people. Against main 17342a1 (0.58.6), tests/fixtures/machine_0.58.6/skips.json: /v1/skips,
// /v1/skips/, /v1/skips.json, /skips.json (301), ?format=json, ?page=1/2/3/999/0/abc, ?format=html, on every host and every
// Accept (none, application/json, */*, text/plain, curl, a browser, text/html;q=0.1 + JSON), with a store holding a real
// published page 2 and real public recent_checks. Every non-browser answer, /v1/skips.json and /skips.json for browsers
// too, and ?format=json is byte-identical (status, every header, body sha256); the only changed keys are browser Accept on
// /v1/skips of 402xagent.com and api.402xagent.com, which get text/html with the strict CSP. The older hosts are unchanged.
test("0.58.7 skips page: /v1/skips.json, /skips.json and non-browser /v1/skips JSON byte-identical to 0.58.6; only browser /v1/skips changes", () => {
  const W = join(HERE, "..", "worker", "src", "index.js");
  const want6 = JSON.parse(readFileSync(join(HERE, "fixtures", "machine_0.58.6", "skips.json"), "utf8"));
  const r = spawnSync(process.execPath, [join(HERE, "helpers", "machine_snapshot.mjs"), "--skips", W], { encoding: "utf8", maxBuffer: 64 << 20, env: BLOG0587 });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want6).sort(), "same request set");
  assert.ok(Object.keys(want6).length >= 595, "every host x path x Accept");
  const changed = Object.keys(want6).filter((k) => !META402_KEYS.has(k) && JSON.stringify(got[k]) !== JSON.stringify(want6[k]));
  assert.deepEqual(changed.filter((k) => !SKIPS_HTML_KEY.test(k)), [], "changed machine responses");
  const html = Object.keys(want6).filter((k) => SKIPS_HTML_KEY.test(k));
  assert.equal(html.length, 36, "browser keys: 2 hosts x 9 paths x 2 Accepts");
  assert.deepEqual(changed.sort(), html.sort(), "every browser page changed, nothing else");
  for (const k of html) {
    assert.equal(got[k].status, 200, k); assert.match(got[k].headers["content-type"], /^text\/html/, k); assert.equal(got[k].headers.vary, "accept", k);
    assert.equal(got[k].headers["content-security-policy"], "default-src 'none'; script-src 'self' https://static.cloudflareinsights.com; style-src 'unsafe-inline'; connect-src 'self' https://cloudflareinsights.com; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", k);
  }
  // the JSON forms really are JSON, with real rows, on the redesigned hosts
  for (const h of ["https://402xagent.com", "https://api.402xagent.com"]) {
    for (const p of ["/v1/skips.json", "/v1/skips?format=json", "/v1/skips?page=2&format=json", "/v1/skips.json?page=2"]) for (const a of ["none", "json", "any", "text", "curl", "html", "htmljson"]) {
      const k = `GET ${h}${p} [${a}]`;
      assert.equal(want6[k].status, 200, k); assert.match(want6[k].headers["content-type"], /^application\/json/, k); assert.deepEqual(got[k], want6[k], k);
    }
    for (const a of ["none", "json", "any", "text", "curl"]) assert.deepEqual(got[`GET ${h}/v1/skips [${a}]`], want6[`GET ${h}/v1/skips [${a}]`]);
    for (const a of ["none", "html"]) { const k = `GET ${h}/skips.json [${a}]`; assert.equal(want6[k].status, 301, k); assert.deepEqual(got[k], want6[k], k); }
  }
  assert.ok(want6["GET https://402xagent.com/v1/skips?page=2 [json]"].length > 30000, "page 2 has the real rows");
});

// 0.58.7: and against a full 0.58.6 snapshot (main 17342a1: every machine surface, the browser homepage, /home.js, /docs,
// /docs/try-it.js, /pricing on every host and Accept, plus the receipt routes with real sampled receipts): the only keys
// that differ are the browser /v1/skips pages. The homepage, /pricing, /docs and the receipt pages are byte-identical.
test("0.58.7 skips page: every other surface (homepage, /pricing, /docs, receipts, machine JSON) byte-identical to 0.58.6", () => {
  const W = join(HERE, "..", "worker", "src", "index.js");
  for (const [flag, file, n] of [["--0583", "snapshot.json", 4], ["--receipts", "receipts.json", 0]]) {
    const want6 = JSON.parse(readFileSync(join(HERE, "fixtures", "machine_0.58.6", file), "utf8"));
    const r = spawnSync(process.execPath, [join(HERE, "helpers", "machine_snapshot.mjs"), flag, W], { encoding: "utf8", maxBuffer: 64 << 20, env: BLOG0587 });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want6).sort(), file + ": same request set");
    const changed = Object.keys(want6).filter((k) => !META402_KEYS.has(k) && JSON.stringify(got[k]) !== JSON.stringify(want6[k]));
    assert.deepEqual(changed.filter((k) => !SKIPS_HTML_KEY.test(k)), [], file + ": nothing but browser /v1/skips changed");
    assert.equal(changed.length, n, file);
    for (const k of [HOME_KEY, "GET https://402xagent.com/pricing [html]", "GET https://402xagent.com/docs [html]", "GET https://402xagent.com/home.js [html]"]) if (want6[k]) assert.deepEqual(got[k], want6[k], k);
  }
});

// 0.58.8: two blog posts (the updated comparison post and /blog/what-is-x402-verification). The only machine surface that
// lists blog posts is llms.txt: against the full 0.57.1 snapshot with the live blog, the changed keys are exactly the
// llms.txt answers, and the new body is the 0.58.7 one plus the new post line and the retitled comparison line.
test("0.58.8 blog posts: only llms.txt changes on machine surfaces, by exactly the two blog lines", async () => {
  const W = join(HERE, "..", "worker", "src", "index.js");
  const r = spawnSync(process.execPath, [join(HERE, "helpers", "machine_snapshot.mjs"), W], { encoding: "utf8", maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  const changed = Object.keys(want).filter((k) => !RECEIPT_HTML_KEY.test(k) && !SKIPS_HTML_KEY.test(k) && JSON.stringify(got[k]) !== JSON.stringify(want[k]));
  assert.ok(changed.length > 0);
  assert.deepEqual(changed.filter((k) => !/\/llms\.txt \[/.test(k) && !META402_KEYS.has(k)), [], "only llms.txt (and the 0.58.9 402 metadata, checked in bazaar_meta_test.mjs)");
  for (const k of changed.filter((k) => /\/llms\.txt \[/.test(k))) { assert.equal(got[k].status, want[k].status, k); assert.deepEqual(got[k].headers, want[k].headers, k); }
  const worker = (await import(W)).default;
  const txt = await (await worker.fetch(new Request("https://402xagent.com/llms.txt"), {}, { waitUntil() {}, passThroughOnException() {} })).text();
  assert.match(txt, /\n  - What x402 Verification Actually Means \(and What It Can't Tell You\): https:\/\/402xagent\.com\/blog\/what-is-x402-verification\n/);
  assert.match(txt, /\n  - x402 Endpoint Checks Compared: Seven Ways to Look Before Your Agent Pays: https:\/\/402xagent\.com\/blog\/x402-endpoint-checks-compared\n/);
  assert.doesNotMatch(txt, /Six Ways|UPDATE/);
});
