// 0.62.0: (1) paid-check upsell block + one-line note on free results and receipt pages, (2) receipt edge cache + per-client
// limit (receiptguard.js), (3) B1 scheme census in the weekly crawl. Snapshots: with SNAP_KEEP_0620=1 the only differences
// from the 0.58.9 fixture are the intended ones; without it (every older snapshot test) nothing differs.
import { readFixture } from "./helpers/crawl_fixtures.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { paidCheckBlock, PAID_CHECK_NOTE, PAID_CHECK_PRICE_USD } from "../worker/src/paidcheck.js";
import { SPOT_PAID_ATOMIC, VERSION } from "../worker/src/lib.js";
import { agentCard } from "../worker/src/agentcard.js";
import { HOME_JS } from "../worker/src/home.js";
import { DOCS_TRYIT_JS } from "../worker/src/tryit.js";
import { liveReceiptHtml, crawlReceiptHtml } from "../worker/src/receipts-html.js";
import { receiptCacheControl, RECEIPT_RATE_PER_MIN } from "../worker/src/receiptguard.js";
const HERE = dirname(fileURLToPath(import.meta.url));

test("0.62.0 version", () => assert.equal(VERSION, "0.68.0"));
test("paid_check block: price, terms and how-to come from the paid path and the agent card", () => {
  const b = paidCheckBlock("https://api.402rates.com/v1/ping");
  assert.equal(PAID_CHECK_PRICE_USD, String(Number(SPOT_PAID_ATOMIC) / 1e6));
  assert.deepEqual(b.payment, { scheme: "exact", network: "eip155:8453", asset: "USDC on Base", amount_atomic: SPOT_PAID_ATOMIC, protocol: "x402 (HTTP 402)" });
  const card = agentCard(VERSION).skills.find((s) => s.id === "spot-check").description;
  for (const w of ["$0.02 USDC on Base", "exact scheme, amount 20000", "pay_to and deadline", "claimed_price", "network", "skip or recheck", "Never pays the target"]) assert.ok(card.includes(w), "agent card says " + w);
  assert.match(b.adds.join(" | "), /full payment terms.*pay_to.*deadline.*claimed_price, pay_to and network/);
  assert.equal(b.how.url, "https://api.402xagent.com/v1/products/endpoint-spot-check?url=https%3A%2F%2Fapi.402rates.com%2Fv1%2Fping&claimed_price=<usd>&pay_to=<0x...>&network=eip155:8453");
  assert.match(b.how.steps, /5 free checks per UTC day.*HTTP 402.*PAYMENT-SIGNATURE/);
  assert.equal(b.note, PAID_CHECK_NOTE);
  assert.ok(JSON.stringify(b).length < 1200, "small");
  assert.ok(!/reputation|quality|history|score/i.test(JSON.stringify(b)), "no reputation/quality/history skeleton");
});

test("one-line note: homepage box, /docs Try it (server note first, same text as fallback), receipt pages", () => {
  for (const js of [HOME_JS, DOCS_TRYIT_JS]) { assert.ok(js.includes("(j.paid_check && j.paid_check.note) || " + JSON.stringify(PAID_CHECK_NOTE))); new Function(js); }
  const live = { id: "sc-0123456789abcdef", url: "https://a.example/x", verdict: "pay", checked_at: "2026-11-03T00:00:00Z", live_402: { http_status: 402, x402_challenge: true, accepts_count: 1 } };
  const note = '<p class="rc-note rc-paid">' + PAID_CHECK_NOTE + "</p>";
  assert.ok(liveReceiptHtml("https://402xagent.com", { ...live, redacted: true }, "").includes(note), "free (redacted) receipt");
  assert.ok(liveReceiptHtml("https://402xagent.com", { ...live, dry_run: true }, "").includes(note), "dry-run receipt");
  assert.ok(!liveReceiptHtml("https://402xagent.com", live, "").includes(note), "a full (paid) receipt has no upsell");
  assert.ok(crawlReceiptHtml("https://402xagent.com", { id: "0123456789", url: "https://a.example/x", verdict: "skip", reason: "no x402 payment request (HTTP 200)", timestamp: "2026-11-03T00:00:00Z" }, "").includes(note), "crawl receipt");
});

test("receipt cache policy: ids only; live ids immutable, crawl ids 1 h; limit number", () => {
  assert.equal(receiptCacheControl("/v1/receipts/sc-0123456789abcdef"), "public, max-age=31536000, immutable");
  for (const p of ["ps", "er", "eb"]) assert.match(receiptCacheControl(`/v1/receipts/${p}-0123456789abcdef`), /immutable/);
  assert.equal(receiptCacheControl("/v1/receipts/0123456789"), "public, max-age=3600");
  for (const p of ["/v1/receipts", "/v1/receipts/by-url", "/v1/receipts/not-an-id"]) assert.equal(receiptCacheControl(p), null);
  assert.equal(RECEIPT_RATE_PER_MIN, 120);
});

const snap = (flag, keep) => {
  const args = [join(HERE, "helpers", "machine_snapshot.mjs"), ...(flag ? [flag] : []), join(HERE, "..", "worker", "src", "index.js")];
  const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, SNAP_KEEP_0620: keep ? "1" : "", SNAP_BLOG_AS_05910: "1" } });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
};
const diffKeys = (a, b) => Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

test("snapshot vs 0.58.9: machine surfaces change only in the paid_check block (free answer, examples) and the two UI scripts", () => {
  const want = readFixture("machine_0.58.9", "snapshot.json");
  const kept = snap(null, true);
  assert.deepEqual(diffKeys(want, snap(null, false)), [], "nothing else changed");
  const changed = diffKeys(want, kept);
  assert.ok(changed.length > 0);
  const ok = /^(POST https:\/\/[^/ ]+\/v1\/products\/endpoint-spot-check \{"url"|GET https:\/\/[^/ ]+\/(openapi\.json|v1\/products\/endpoint-spot-check(\/docs|\?url=\S+)|home\.js|docs\/try-it\.js) \[[a-z]+\]$)/;
  assert.deepEqual(changed.filter((k) => !ok.test(k)), [], "only the intended surfaces");
  for (const k of changed) assert.deepEqual({ ...kept[k], sha256: 0, headers: { ...kept[k].headers, "content-length": 0 } }, { ...want[k], sha256: 0, headers: { ...want[k].headers, "content-length": 0 } }, "status + headers unchanged: " + k);
});

test("snapshot vs 0.58.9: receipt routes change only by Cache-Control / x-receipt-cache on receipt ids and the note on receipt pages", () => {
  const want = readFixture("machine_0.58.9", "receipts.json");
  const kept = snap("--receipts", true);
  assert.deepEqual(diffKeys(want, snap("--receipts", false)), [], "nothing else changed");
  const changed = diffKeys(want, kept);
  assert.deepEqual(changed.filter((k) => !/^GET https:\/\/[^/ ]+\/v1\/receipts\/(sc-[0-9a-f]{16}|ps-[0-9a-f]{16}|er-[0-9a-f]{16}|eb-[0-9a-f]{16}|[0-9a-f]{10})(\?view=redacted)? \[[a-z]+\]$/.test(k)), [], "receipt ids only");
  for (const k of changed) {
    const a = { ...want[k].headers }, b = { ...kept[k].headers };
    const u = new URL(k.split(" ")[1]);
    if (!u.search) { assert.equal(b["x-receipt-cache"], "miss", k); assert.equal(b["cache-control"], receiptCacheControl(u.pathname), k); }
    else assert.equal(b["x-receipt-cache"], undefined, "a query string is never edge-cached: " + k);
    for (const h of ["cache-control", "x-receipt-cache"]) { delete a[h]; delete b[h]; }
    assert.deepEqual(b, a, "no other header changed: " + k); assert.equal(kept[k].status, want[k].status);
    if (!/\[(html|htmljson)\]$/.test(k)) assert.equal(kept[k].sha256, want[k].sha256, "JSON bodies byte-identical: " + k);
  }
});

test("B1 scheme census (crawl_probe.py + build_worker_data.py): tags, receipt-row field, summary counts", () => {
  const dir = join(HERE, "..", "scripts", "weekly-crawl");
  const py = spawnSync("python3", ["-c", `import sys,json;sys.path.insert(0,sys.argv[1]);import crawl_probe as c
print(json.dumps([[c.scheme_tag(s) for s in ["exact","EXACT","upto","up-to","up_to","batch","batch-settlement","deferred","",None]],
 c.scheme_of([]), c.scheme_of([{"scheme":"upto"},{"scheme":"exact"}]), c.scheme_of([{"scheme":"upto"},{"scheme":"exact"}], {"scheme":"exact"}),
 c.scheme_counts([{"x402_scheme":"exact"},{"x402_scheme":"exact"},{"x402_scheme":"batch"},{},{"x402_scheme":"other"}])]))`, dir], { encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  const [tags, none, first, chosen, counts] = JSON.parse(py.stdout);
  assert.deepEqual(tags, ["exact", "exact", "upto", "upto", "upto", "batch", "batch", "other", "unknown", "unknown"]);
  assert.equal(none, "unknown"); assert.equal(first, "upto"); assert.equal(chosen, "exact");
  assert.deepEqual(counts, { exact: 2, upto: 0, batch: 1, other: 1, unknown: 1 });
});
