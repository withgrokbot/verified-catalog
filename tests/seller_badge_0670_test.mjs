// 0.67.0: /v1/badge/{seller}.svg and .json from stored live-check receipts.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { VERSION } from "../worker/src/lib.js";
import {
  parseSellerBadgeTarget, sellerBadgeFromRows, sellerBadgeText, handleSellerBadge, SELLER_BADGE_CACHE_S, sellerBadgeOn,
} from "../worker/src/badge.js";
import { docsProductHtml, DOCS_PAYEE_GUARD, DOCS_VERIFY_OFFLINE } from "../worker/src/docs.js";
import { CANON_ORIGIN, API_ORIGIN } from "../worker/src/spotcheck.js";
import { homeHtml } from "../worker/src/home.js";

test("0.67.0 version", () => assert.equal(VERSION, "0.67.0"));

const row = (id, url, verdict, at, extra = {}) => ({
  id, url, created_at: at, verdict, check_type: extra.check_type || "live",
  body: JSON.stringify({ id, url, verdict, expected: extra.expected || { source: "listing" }, dry_run: extra.dry_run === true, check_type: extra.check_type || "live" }),
});

test("parse seller or endpoint; reject junk", () => {
  assert.deepEqual(parseSellerBadgeTarget("/v1/badge/API.Example.com.svg"), { kind: "svg", host: "api.example.com", path: "" });
  assert.deepEqual(parseSellerBadgeTarget("/v1/badge/api.example.com/v1/ping.json"), { kind: "json", host: "api.example.com", path: "/v1/ping" });
  const enc = "/v1/badge/" + encodeURIComponent("https://api.example.com/v1/ping") + ".svg";
  assert.deepEqual(parseSellerBadgeTarget(enc), { kind: "svg", host: "api.example.com", path: "/v1/ping" });
  for (const p of ["/v1/badge/127.0.0.1.svg", "/v1/badge/localhost.svg", "/v1/badge/%3Cscript%3E.svg", "/v1/badge/a.internal.svg", "/badge/api.example.com.svg"]) {
    const r = parseSellerBadgeTarget(p);
    assert.ok(!r || r.error, p);
  }
});

test("stats from receipts; dry runs and request expectations do not count; empty is not a pass", () => {
  const rows = [
    row("sc-aaaaaaaaaaaaaaaa", "https://seller.example/a", "pay", "2026-11-01T00:00:00Z"),
    row("sc-bbbbbbbbbbbbbbbb", "https://seller.example/a", "skip", "2026-11-03T00:00:00Z"),
    row("sc-cccccccccccccccc", "https://seller.example/b", "pay", "2026-11-08T12:00:00Z"),
    row("sc-dddddddddddddddd", "https://seller.example/a", "pay", "2026-11-02T00:00:00Z", { check_type: "dry-run", dry_run: true }),
    row("sc-eeeeeeeeeeeeeeee", "https://seller.example/a", "pay", "2026-11-09T00:00:00Z", { expected: { source: "request" } }),
  ];
  const s = sellerBadgeFromRows(rows);
  assert.equal(s.observed, true);
  assert.equal(s.checks_observed, 3);
  assert.equal(s.pay_count, 2);
  assert.equal(s.pass_rate, 0.667);
  assert.equal(s.last_verdict, "pay");
  assert.equal(s.days_observed, 3);
  assert.equal(s.last_checked, "2026-11-08T12:00:00Z");
  assert.equal(s.receipt_id, "sc-cccccccccccccccc");
  assert.equal(s.endpoints_observed, 2);
  assert.equal(sellerBadgeText(s), "3 checks · 67% pay · last pay · 3d · 2026-11-08");
  const none = sellerBadgeFromRows([]);
  assert.equal(none.observed, false);
  assert.equal(none.pass_rate, null);
  assert.equal(sellerBadgeText(none), "not yet observed");
  assert.doesNotMatch(sellerBadgeText(none), /\b(pay|pass|verified)\b/);
});

function memDb(rows) {
  return {
    prepare(sql) {
      return { bind(...a) {
        return { async all() {
          assert.match(sql, /seller-badge/);
          const hostRange = /url >= \?/.test(sql);
          const match = hostRange
            ? (r) => (r.url >= a[0] && r.url < a[1]) || (r.url >= a[2] && r.url < a[3])
            : (r) => r.url === a[0] || r.url === a[1];
          const out = rows.filter((r) => match(r) && r.check_type !== "dry-run");
          out.sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
          return { results: out };
        } };
      } };
    },
  };
}

test("SVG and JSON: real stats, escaped text, cache, receipt link; unknown is neutral", async () => {
  const rows = [
    row("sc-aaaaaaaaaaaaaaaa", "https://seller.example/a", "pay", "2026-11-01T01:00:00Z"),
    row("sc-bbbbbbbbbbbbbbbb", "https://seller.example/a", "skip", "2026-11-04T01:00:00Z"),
    row("sc-cccccccccccccccc", "https://other.example/a", "pay", "2026-11-08T01:00:00Z"),
    row("sc-dddddddddddddddd", "https://seller.example/a", "pay<script>", "2026-11-05T01:00:00Z"),
  ];
  const env = { RECEIPTS_DB: memDb(rows) };
  const svg = await handleSellerBadge(new Request("https://o.fixture/v1/badge/seller.example/a.svg"), env, new URL("https://o.fixture/v1/badge/seller.example/a.svg"), "https://o.fixture");
  const text = await svg.text();
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(svg.headers.get("cache-control"), new RegExp("max-age=" + SELLER_BADGE_CACHE_S));
  assert.match(svg.headers.get("link"), /\/v1\/receipts\/by-url\?url=/);
  assert.equal(svg.headers.get("x-402xagent-badge"), "observed");
  assert.match(text, /3 checks/);
  assert.match(text, /33% pay/);
  assert.match(text, /last pay&lt;script&gt;/);
  assert.ok(!text.includes("<script"), "svg text escaped");
  assert.match(text, /href="https:\/\/o\.fixture\/v1\/receipts\/by-url\?url=/);
  const js = await handleSellerBadge(new Request("https://o.fixture/v1/badge/seller.example/a.json"), env, new URL("https://o.fixture/v1/badge/seller.example/a.json"), "https://o.fixture");
  const body = JSON.parse(await js.text());
  assert.equal(body.observed, true);
  assert.equal(body.checks_observed, 3);
  assert.equal(body.pass_rate, 0.333);
  assert.equal(body.last_verdict, "pay<script>");
  assert.equal(body.days_observed, 3);
  assert.equal(body.receipt, "https://o.fixture/v1/receipts/sc-dddddddddddddddd");
  assert.match(body.receipts, /seller\.example%2Fa/);
  const unk = await handleSellerBadge(new Request("https://o.fixture/v1/badge/missing.example.svg"), env, new URL("https://o.fixture/v1/badge/missing.example.svg"), "https://o.fixture");
  const ut = await unk.text();
  assert.match(ut, />not yet observed</);
  assert.equal(unk.headers.get("x-402xagent-badge"), "not-yet-observed");
  assert.doesNotMatch(ut, /\b(pay|pass|verified)\b/);
  assert.ok(!/>#2e7d32</.test(ut) && !ut.includes("#2e7d32"), "unknown is not the pay green");
  const bad = await handleSellerBadge(new Request("https://o.fixture/v1/badge/%3Cscript%3E.svg"), env, new URL("https://o.fixture/v1/badge/%3Cscript%3E.svg"), "https://o.fixture");
  assert.equal(bad.status, 400);
  assert.ok(!(await bad.text()).includes("<script"));
  const down = await handleSellerBadge(new Request("https://o.fixture/v1/badge/seller.example.json"), { RECEIPTS_DB: { prepare() { throw new Error("down"); } } }, new URL("https://o.fixture/v1/badge/seller.example.json"), "https://o.fixture");
  const dj = JSON.parse(await down.text());
  assert.equal(dj.observed, false);
  assert.equal(dj.pass_rate, null);
  assert.match(dj.note, /not a pass/);
  assert.match(down.headers.get("cache-control"), /max-age=60/);
});

test("worker route, OpenAPI and llms.txt; flag hides the docs lines only", async () => {
  const ctx = { waitUntil() {} };
  const rows = [row("sc-aaaaaaaaaaaaaaaa", "https://seller.example/a", "skip", "2026-11-02T00:00:00Z")];
  const env = { RECEIPTS_DB: memDb(rows), SELLER_BADGE: "on" };
  const res = await worker.fetch(new Request("https://402xagent.com/v1/badge/seller.example.json"), env, ctx);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.last_verdict, "skip");
  assert.equal(j.pass_rate, 0);
  assert.match(j.receipts, /by-url/);
  const oa = await (await worker.fetch(new Request("https://api.402xagent.com/openapi.json"), env, ctx)).json();
  assert.ok(oa.paths["/v1/badge/{seller}.svg"]);
  assert.equal(oa.paths["/v1/badge/{seller}.svg"].get.parameters[0].example, "api.402rates.com");
  assert.ok(oa.paths["/v1/badge/{seller}.json"]);
  const ll = await (await worker.fetch(new Request("https://402xagent.com/llms.txt"), env, ctx)).text();
  assert.match(ll, /Verify our receipts without calling us/);
  assert.match(ll, /Stored crawl receipts \(10-character ids\) are unsigned/);
  assert.match(ll, /\/v1\/badge\/api\.402rates\.com\.svg/);
  assert.match(ll, /not yet observed/);
  assert.match(ll, /docs#payee-guard/);
  const off = { SELLER_BADGE: "off" };
  const oaOff = await (await worker.fetch(new Request("https://api.402xagent.com/openapi.json"), off, ctx)).json();
  assert.equal(oaOff.paths["/v1/badge/{seller}.svg"], undefined);
  const llOff = await (await worker.fetch(new Request("https://402xagent.com/llms.txt"), off, ctx)).text();
  assert.doesNotMatch(llOff, /Verify our receipts without calling us/);
  assert.equal(sellerBadgeOn(off), false);
  assert.equal(sellerBadgeOn({}), true);
  const post = await worker.fetch(new Request("https://402xagent.com/v1/badge/seller.example.svg", { method: "POST" }), env, ctx);
  assert.equal(post.status, 405);
});

test("docs: offline verifier and the live composition section", () => {
  const page = docsProductHtml(CANON_ORIGIN, API_ORIGIN, "receipt-verification", {});
  assert.match(page, /Verify our receipts without calling us/);
  assert.match(page, /Stored crawl receipts \(10-character ids\) are unsigned/);
  assert.match(page, /\/\.well-known\/402xagent-keys\.json/);
  assert.match(page, /node verify-receipt\.mjs receipt\.json/);
  assert.match(page, /does not fetch the receipt or the keys/);
  assert.ok(page.includes(DOCS_VERIFY_OFFLINE));
  const check = docsProductHtml(CANON_ORIGIN, API_ORIGIN, "check", { tryIt: { freePerDay: 5 } });
  assert.match(check, /href="\/docs#payee-guard"/);
  assert.match(DOCS_PAYEE_GUARD, /id="payee-guard"/);
  const a = DOCS_PAYEE_GUARD.indexOf("inamGuardedFetch(fetch"), b = DOCS_PAYEE_GUARD.indexOf("spotCheckFetch(payeeChecked)"), c = DOCS_PAYEE_GUARD.indexOf("wrapFetchWithPayment(routeChecked, client)");
  assert.ok(a > 0 && a < b && b < c);
  assert.doesNotMatch(DOCS_PAYEE_GUARD, /InamBlockedError|5 minutes by default|re-checks the signed payment/);
  const home = homeHtml("https://402xagent.com");
  assert.match(home, /Verify our receipts without calling us/);
  assert.match(home, /Stored crawl receipts are unsigned/);
  assert.match(home, /href="\/docs#payee-guard"/);
  assert.doesNotMatch(home, /badge/i);
});
