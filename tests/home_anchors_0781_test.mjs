// 0.78.1: homepage receipt-anchors section, Receipts nav points at /v1/receipts (skip/live/dry list),
// /anchors stays reachable from that list and the footer. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { VERSION } from "../worker/src/lib.js";
import { NAV, footerHtml } from "../worker/src/chrome.js";
import {
  homeHtml, homeAnchorsSection, homeAnchorsHeightText,
  HOME_ANCHORS_KICKER, HOME_ANCHORS_HEADING, HOME_ANCHORS_BODY, HOME_ANCHORS_LINK,
} from "../worker/src/home.js";
import { latestConfirmedBtcHeight } from "../worker/src/anchors.js";
import { sqliteD1 } from "./helpers/sqlite_d1.mjs";
import { fakeReceiptsD1 } from "./helpers/machine_snapshot.mjs";
import { pricingHtml } from "../worker/src/pricing.js";

test("0.78.1 version", () => assert.equal(VERSION, "0.80.0"));

const HTML = { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "Mozilla/5.0" };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const get = (path, env = {}, host = "https://402xagent.com") =>
  worker.fetch(new Request(host + path, { headers: { ...HTML, "cf-connecting-ip": "203.0.113.21" } }), { CLIENT_SALT: "t", ENDPOINT_REPORT: "1", WATCHTOWER: "1", ...env }, ctx);

const COPY = {
  kicker: HOME_ANCHORS_KICKER,
  heading: HOME_ANCHORS_HEADING,
  body: HOME_ANCHORS_BODY,
  link: HOME_ANCHORS_LINK,
};
const HEIGHT = 840123;
const OTS = new Uint8Array([0, 1, 2, 3]);

async function seedAnchors(rows) {
  const db = sqliteD1();
  for (const r of rows) {
    await db.prepare("INSERT INTO receipt_anchors (id, created_at, merkle_root, file_sha256, receipt_count, first_receipt_id, last_receipt_id, first_created_at, last_created_at, status, ots_proof, calendars, btc_height, confirmed_at) VALUES (?, ?, '00', '00', 1, 'a', 'a', 'x', 'x', ?, ?, '[]', ?, ?)")
      .bind(r.id, r.created_at || "2026-11-20T03:41:00Z", r.status, OTS, r.btc_height ?? null, r.confirmed_at ?? null).run();
  }
  return db;
}

test("homepage section: present, styled like the other sections, exact wording, link to /anchors", () => {
  const t = homeHtml("https://402xagent.com");
  const secStart = t.lastIndexOf("<section", t.indexOf('id="anchors"'));
  const sec = t.slice(secStart, t.indexOf("</main>"));
  assert.ok(t.includes('id="trust"') && t.indexOf('id="trust"') < t.indexOf('id="anchors"'), "follows the trust section");
  assert.match(sec, /<section class="tight" id="anchors">/);
  assert.match(sec, /<div class="section-head">/);
  assert.match(sec, /<div class="kicker">Receipt anchors<\/div>/);
  assert.ok(sec.includes(`<h2>${COPY.heading}</h2>`));
  assert.ok(sec.includes(`<p>${COPY.body} <a href="/anchors">${COPY.link}</a>.</p>`));
  assert.equal(sec.includes("at height"), false, "no block height without live confirmed data");
  assert.match(COPY.body, /pending is not a Bitcoin confirmation/);
  assert.match(COPY.body, /A confirmed anchor has a Bitcoin block header attestation/);
  assert.equal(homeAnchorsSection({ anchors: false }), "");
  assert.ok(!homeHtml("https://402xagent.com", { anchors: false }).includes('id="anchors"'));
});

test("block height is shown only for a positive confirmed height passed at render", () => {
  assert.equal(homeAnchorsHeightText(HEIGHT), ` The latest confirmed anchor has a Bitcoin block header attestation at height ${HEIGHT}.`);
  for (const bad of [null, undefined, "", 0, -1, 1.5, "pending", "840123abc", NaN, Infinity]) {
    assert.equal(homeAnchorsHeightText(bad), "", String(bad));
  }
  const withH = homeHtml("https://402xagent.com", { anchors: true, confirmedHeight: HEIGHT });
  const sec = withH.slice(withH.indexOf('id="anchors"'), withH.indexOf("</main>"));
  assert.ok(sec.includes(`at height ${HEIGHT}`));
  assert.ok(sec.includes("The latest confirmed anchor has a Bitcoin block header attestation"));
  assert.ok(sec.includes(COPY.body));
  const none = homeHtml("https://402xagent.com", { anchors: true, confirmedHeight: null });
  const secNone = none.slice(none.indexOf('id="anchors"'), none.indexOf("</main>"));
  assert.equal(secNone.includes("at height"), false);
  assert.equal(secNone.includes("The latest confirmed anchor"), false);
  assert.ok(secNone.includes(COPY.body));
  // a pending-only page must not claim a confirmation exists
  assert.doesNotMatch(secNone, /is confirmed|has been confirmed|confirmed on Bitcoin/i);
});

test("latestConfirmedBtcHeight: confirmed rows only, fail closed", async () => {
  const pending = await seedAnchors([
    { id: "an-aaaaaaaaaaaaaaaa", status: "pending", btc_height: 999999 },
  ]);
  assert.equal(await latestConfirmedBtcHeight({ ANCHORS: "1", RECEIPTS_DB: pending }), null, "pending height is ignored even if the column is set");

  const confirmed = await seedAnchors([
    { id: "an-bbbbbbbbbbbbbbbb", status: "pending" },
    { id: "an-cccccccccccccccc", status: "confirmed", btc_height: 800000, confirmed_at: "2026-11-21T00:00:00Z" },
    { id: "an-dddddddddddddddd", status: "confirmed", btc_height: HEIGHT, confirmed_at: "2026-11-22T00:00:00Z" },
    { id: "an-eeeeeeeeeeeeeeee", status: "confirmed", confirmed_at: "2026-11-23T00:00:00Z" },
  ]);
  assert.equal(await latestConfirmedBtcHeight({ ANCHORS: "1", RECEIPTS_DB: confirmed }), HEIGHT);
  assert.equal(await latestConfirmedBtcHeight({ ANCHORS: "0", RECEIPTS_DB: confirmed }), null);
  assert.equal(await latestConfirmedBtcHeight({ RECEIPTS_DB: confirmed }), null);
  assert.equal(await latestConfirmedBtcHeight({ ANCHORS: "1" }), null);
  const boom = { prepare() { throw new Error("d1 down"); } };
  assert.equal(await latestConfirmedBtcHeight({ ANCHORS: "1", RECEIPTS_DB: boom }), null);
  const noInt = await seedAnchors([{ id: "an-ffffffffffffffff", status: "confirmed", btc_height: 0 }]);
  assert.equal(await latestConfirmedBtcHeight({ ANCHORS: "1", RECEIPTS_DB: noInt }), null);
});

test("served homepage: live D1 height, 60s cache when anchors are on, no stale long cache of that height", async () => {
  const db = await seedAnchors([
    { id: "an-1111111111111111", status: "pending" },
    { id: "an-2222222222222222", status: "confirmed", btc_height: HEIGHT, confirmed_at: "2026-11-22T00:00:00Z" },
  ]);
  const on = await get("/", { ANCHORS: "1", RECEIPTS_DB: db });
  assert.equal(on.status, 200);
  assert.equal(on.headers.get("cache-control"), "public, max-age=60");
  const t = await on.text();
  assert.ok(t.includes('id="anchors"'));
  assert.ok(t.includes(COPY.body));
  assert.ok(t.includes(`at height ${HEIGHT}`));
  assert.ok(t.includes('<a href="/anchors">See receipt anchors</a>'));

  const pendingOnly = await get("/", { ANCHORS: "1", RECEIPTS_DB: await seedAnchors([{ id: "an-3333333333333333", status: "pending" }]) });
  assert.equal(pendingOnly.headers.get("cache-control"), "public, max-age=60");
  const p = await pendingOnly.text();
  assert.ok(p.includes('id="anchors"') && p.includes(COPY.body));
  assert.equal(p.includes("at height"), false);
  assert.equal(p.includes("The latest confirmed anchor"), false);

  const failed = await get("/", { ANCHORS: "1", RECEIPTS_DB: { prepare() { throw new Error("d1 down"); } } });
  const f = await failed.text();
  assert.equal(failed.headers.get("cache-control"), "public, max-age=60");
  assert.ok(f.includes('id="anchors"'));
  assert.equal(f.includes("at height"), false);

  const off = await get("/");
  assert.equal(off.headers.get("cache-control"), "public, max-age=300");
  const o = await off.text();
  assert.ok(!o.includes('id="anchors"'));
  assert.equal(o.includes("at height"), false);
});

function receiptsHrefs(html) {
  const primary = html.match(/<nav class="main" aria-label="Primary">([\s\S]*?)<\/nav>/);
  const mobile = html.match(/<nav aria-label="Mobile">([\s\S]*?)<\/nav>/) || html.match(/<nav class="mobile-nav" id="mobile-nav" aria-label="Mobile">([\s\S]*?)<\/nav>/);
  return { primary: primary ? primary[1] : "", mobile: mobile ? mobile[1] : "", footer: html.includes('<footer') ? html.slice(html.indexOf("<footer")) : "" };
}

test("Receipts nav points at /v1/receipts on every page, including the mobile menu; anchors stay in the footer", async () => {
  assert.deepEqual(NAV.find((x) => x[0] === "Receipts"), ["Receipts", "/v1/receipts"]);
  const foot = footerHtml();
  assert.ok(foot.includes('<a href="/v1/receipts">Receipts</a>'));
  assert.ok(foot.includes('<a href="/anchors">Anchors</a>'));
  const pricing = pricingHtml("https://402xagent.com", { freePerDay: 5, freePerIpDay: 25, paidAtomic: "20000", erAtomic: "50000", watchAtomic: "1000000", watchDays: 30, trialDays: 7, facilPerMin: 60, facilHostPerMin: 30, hostedFree: 1000, hostedVolAfter: 1000, hostedStdAtomic: 20000, hostedVolAtomic: 10000, lookupFreePerDay: 5, lookupAtomic: "20000", apiOrigin: "https://api.402xagent.com", endpointReport: true, watchtower: true });
  const pr = receiptsHrefs(pricing);
  assert.match(pr.primary, /<a href="\/v1\/receipts">Receipts<\/a>/);
  assert.match(pr.mobile, /<a href="\/v1\/receipts">Receipts<\/a>/);
  assert.ok(pr.footer.includes('<a href="/anchors">Anchors</a>'));

  const home = homeHtml("https://402xagent.com");
  const hr = receiptsHrefs(home);
  assert.equal(((hr.primary + hr.mobile).match(/<a href="\/v1\/receipts">Receipts<\/a>/g) || []).length, 2);
  assert.match(hr.primary, /<a href="\/v1\/receipts">Receipts<\/a>/);
  assert.match(hr.mobile, /<a href="\/v1\/receipts">Receipts<\/a>/);
  assert.ok(!/data-tab="skips"/.test(hr.primary + hr.mobile));
  assert.ok(hr.footer.includes('<a href="/anchors">Anchors</a>'));

  const db = await seedAnchors([{ id: "an-4444444444444444", status: "confirmed", btc_height: HEIGHT, confirmed_at: "2026-11-22T00:00:00Z" }]);
  const env = { ANCHORS: "1", RECEIPTS_DB: db };
  const pages = ["/", "/pricing", "/docs", "/docs/check", "/verify", "/v1/skips", "/anchors"];
  for (const path of pages) {
    const r = await get(path, env);
    assert.equal(r.status, 200, path);
    const t = await r.text();
    const navs = receiptsHrefs(t);
    assert.match(navs.primary, /href="\/v1\/receipts"/, path + " primary");
    assert.match(navs.primary, />Receipts<\/a>/, path + " primary label");
    assert.match(navs.mobile, /href="\/v1\/receipts"/, path + " mobile");
    assert.match(navs.mobile, />Receipts<\/a>/, path + " mobile label");
    assert.ok(navs.footer.includes('<a href="/anchors">Anchors</a>'), path + " footer anchors");
    assert.ok(!navs.primary.includes('href="/v1/skips">Receipts') && !navs.mobile.includes('href="/v1/skips">Receipts'), path);
  }
});

test("/v1/receipts lists skip, live and dry checks; Receipts is current; anchors are linked from the page and footer", async () => {
  const r = await get("/v1/receipts", { RECEIPTS_DB: fakeReceiptsD1() });
  assert.equal(r.status, 200);
  const t = await r.text();
  assert.match(t, /<nav class="rc-tabs"/);
  for (const label of ["Crawl skips", "Live checks", "Dry runs", "Self-checked"]) assert.ok(t.includes(label), label);
  assert.ok(t.includes('<a href="/v1/receipts?type=live">Live checks</a>'));
  assert.ok(t.includes('<a href="/v1/receipts?type=dry-run">Dry runs</a>'));
  const navs = receiptsHrefs(t);
  assert.match(navs.primary, /<a href="\/v1\/receipts" aria-current="page">Receipts<\/a>/);
  assert.match(navs.mobile, /<a href="\/v1\/receipts" aria-current="page">Receipts<\/a>/);
  assert.ok(t.includes('See <a href="/anchors">receipt anchors</a>.'));
  assert.ok(navs.footer.includes('<a href="/anchors">Anchors</a>'));
});
