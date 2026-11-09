// 0.66.2: the crawl source breakdown is a partition of the headline, and per-endpoint history names
// days observed (distinct UTC dates) plus last checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RECEIPTS_META } from "../worker/src/receipts-data.js";
import { sourceBreakdown, sourceLine, skipRowHtml } from "../worker/src/skips-html.js";
import { historySummary, observationSpan, observationSpanText } from "../worker/src/history.js";
import { crawlReceiptHtml, liveReceiptHtml } from "../worker/src/receipts-html.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

test("published crawl: the four large primary lists are 197,463; agent402 (1) and awesome-x402 (3) are the other four", () => {
  const big = ["payai-bazaar", "agent-tools-cloud", "payapi-market", "cdp-bazaar"];
  const bigSum = big.reduce((n, k) => n + RECEIPTS_META.lists[k], 0);
  assert.equal(bigSum, 197463);
  assert.equal(RECEIPTS_META.lists.agent402, 1);
  assert.equal(RECEIPTS_META.lists["awesome-x402"], 3);
  assert.equal(bigSum + 4, RECEIPTS_META.endpoints_covered);
  const by = sourceBreakdown(RECEIPTS_META);
  assert.equal(sum(by), RECEIPTS_META.endpoints_covered);
  assert.equal(sum(by), RECEIPTS_META.total);
  assert.equal(by["other/unknown"], undefined, "every published receipt already has a named primary list");
  assert.ok(sourceLine(RECEIPTS_META).includes("agent402 1") && sourceLine(RECEIPTS_META).includes("awesome-x402 3"));
  assert.ok(sourceLine(RECEIPTS_META).includes("these add up to 197,467"));
});

test("a gap of 4 blank or missing sources is an explicit other/unknown bucket, and the breakdown still sums to the headline", () => {
  const meta = { endpoints_covered: 10, total: 10, lists: { "cdp-bazaar": 6, "": 2, unknown: 1 } };
  const by = sourceBreakdown(meta);
  assert.equal(by["cdp-bazaar"], 6);
  assert.equal(by["other/unknown"], 4); // 2 blank + 1 unknown + 1 receipt the named lists do not cover
  assert.equal(sum(by), 10);
  const named = { endpoints_covered: 5, lists: { "payai-bazaar": 5, "agent402": 0 } };
  assert.equal(sourceBreakdown(named)["agent402"], undefined, "a zero bucket is not shown");
  assert.equal(sum(sourceBreakdown(named)), 5);
});

test("days observed counts distinct UTC dates, and last checked is the latest stored timestamp", () => {
  const span = observationSpan(["2026-11-03T18:50:28Z", "2026-11-03T20:29:54Z", "2026-11-04T20:48:18.000Z", null, "not-a-time"]);
  assert.deepEqual(span, { days_observed: 2, first_seen: "2026-11-03T18:50:28Z", last_checked: "2026-11-04T20:48:18Z" });
  assert.equal(observationSpanText(span), "2 days observed, first seen 2026-11-03. Last checked: 2026-11-04 20:48 UTC");
  const week = observationSpan(["2026-10-12T15:00:00Z", "2026-10-26T15:00:00Z"]);
  assert.equal(week.days_observed, 2, "two crawl days, not the 14 calendar days between them");
  const now = new Date("2026-11-04T12:00:00Z");
  const summary = historySummary([
    { observed_at: "2026-11-04T01:00:00Z", amount_atomic: "1", network: "eip155:8453", pay_to: "0xa" },
    { observed_at: "2026-11-03T01:00:00Z", http_status: 504 },
    { observed_at: "2026-11-03T08:00:00Z", amount_atomic: "1", network: "eip155:8453", pay_to: "0xa" },
  ], now);
  assert.equal(summary.days_observed, 2);
  assert.equal(summary.first_seen, "2026-11-03T01:00:00Z");
  assert.equal(summary.last_checked, "2026-11-04T01:00:00Z");
  assert.equal(summary.observations, 3);
});

test("HTML shows days observed and a human last-checked time on the skips row, the crawl receipt and the live receipt", () => {
  const row = skipRowHtml({ id: "0123456789", url: "https://seller.fixture/a", method: "GET", reason: "no x402 payment request (HTTP 404)", timestamp: "2026-11-03T15:24:34Z", source_list: "cdp-bazaar" });
  assert.match(row, /1 day observed, first seen 2026-11-03\. Last checked: 2026-11-03 15:24 UTC/);
  const crawl = crawlReceiptHtml("https://402xagent.com", { id: "0123456789", url: "https://seller.fixture/a", verdict: "skip", reason: "no x402 payment request (HTTP 404)", timestamp: "2026-11-03T15:24:34Z", days_observed: 2, first_seen: "2026-10-27T14:00:00Z", last_checked: "2026-11-03T15:24:34Z" }, {});
  assert.match(crawl, /2 days observed, first seen 2026-10-27\. Last checked: 2026-11-03 15:24 UTC/);
  const live = liveReceiptHtml("https://402xagent.com", { id: "sc-0123456789abcdef", url: "https://seller.fixture/a", verdict: "pay", checked_at: "2026-11-08T18:48:47Z", history: { observations: 3, stable_for_days: 1, drift: false, days_observed: 3, first_seen: "2026-11-06T18:00:00Z", last_checked: "2026-11-08T18:48:47Z" }, live_402: { http_status: 402, accepts: [] } }, {});
  assert.match(live, /3 days observed, first seen 2026-11-06\. Last checked: 2026-11-08 18:48 UTC/);
  assert.match(live, /Last checked/);
});

test("crawl builder and term history use the same rule: unknown sources stay visible, unobserved days are not counted", () => {
  const py = spawnSync("python3", ["-c", `import json,sys
sys.path.insert(0,"scripts/weekly-crawl")
import crawl_probe as c, term_history as t
rows=[{"source_list":"cdp-bazaar"},{"source_list":"cdp-bazaar"},{"source_list":None},{"source_list":""},{"source_list":"unknown"},{"source_list":"agent402"}]
print(json.dumps({"sources":c.primary_source_counts(rows),"span":t.observed_span([{"first_seen":"2026-10-12T15:00:00Z","last_seen":"2026-10-26T15:00:00Z"}])}))
`], { cwd: join(HERE, ".."), encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  const got = JSON.parse(py.stdout);
  assert.deepEqual(got.sources, { "cdp-bazaar": 2, "other/unknown": 3, agent402: 1 });
  assert.equal(Object.values(got.sources).reduce((a, b) => a + b, 0), 6);
  assert.equal(got.span.days_observed, 2);
});
