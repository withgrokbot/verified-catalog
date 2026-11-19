// 0.77.0: 200 list/paged receipt and skips responses (and /v1/receipts/by-url, which is counted by the uncached-read caps)
// send Cache-Control: private, no-store so a cached page cannot bypass the caps. Single-by-id caching stays as-is.
// The new header is set whether BULK_LIMITS is on or off: a cached 200 would also bypass the flag-off 120/min cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { VERSION } from "../worker/src/lib.js";
import { RECEIPT_LIST_CC } from "../worker/src/skips.js";
import { RECEIPT_IMMUTABLE_CC, RECEIPT_CRAWL_CC } from "../worker/src/receiptguard.js";
import { CRAWL_RECEIPT_ID } from "./helpers/crawl_fixtures.mjs";
import { fakeReceiptsD1, fakeSkipsD1, restoreListCache0770 } from "./helpers/machine_snapshot.mjs";

const CTX = { waitUntil() {}, passThroughOnException() {} };
const LIVE_ID = "sc-85c8963fb57e7b25";
const LIVE_URL = "https://api.402rates.com/v1/ping";
const HTML = { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "Mozilla/5.0" };

function env(flag) {
  const e = {
    CLIENT_SALT: "test-salt",
    SELF_CLIENTS: "withgrokbot",
    PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674",
    RECEIPTS_DB: fakeReceiptsD1(),
  };
  if (flag !== undefined) e.BULK_LIMITS = flag;
  return e;
}
function skipsEnv(flag) {
  return { ...env(flag), RECEIPTS_DB: fakeSkipsD1() };
}
async function go(path, { flag, headers = {}, e } = {}) {
  const url = "https://402xagent.com" + path;
  const res = await worker.fetch(new Request(url, { headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "curl/8", ...headers } }), e || env(flag), CTX);
  return res;
}

test("0.77.1 version and list Cache-Control constant", () => {
  assert.equal(VERSION, "0.77.3");
  assert.equal(RECEIPT_LIST_CC, "private, no-store");
});

for (const flag of [undefined, "0", "1"]) {
  const label = flag === undefined ? "unset" : flag === "1" ? "on" : "off";

  test(`list and paged 200s are private, no-store when BULK_LIMITS is ${label}`, async () => {
    for (const path of ["/v1/receipts", "/v1/receipts?page=2", "/v1/receipts?type=live"]) {
      const res = await go(path, { flag });
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("cache-control"), RECEIPT_LIST_CC, path);
    }
    for (const path of ["/v1/skips", "/v1/skips.json", "/v1/skips?page=2", "/v1/skips.json?page=2"]) {
      const res = await go(path, { flag, e: skipsEnv(flag) });
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("cache-control"), RECEIPT_LIST_CC, path);
    }
    for (const path of ["/v1/receipts", "/v1/receipts?page=2", "/v1/receipts?type=live"]) {
      const res = await go(path, { flag, headers: HTML });
      assert.equal(res.status, 200, "html " + path);
      assert.equal(res.headers.get("cache-control"), RECEIPT_LIST_CC, "html " + path);
      assert.match(res.headers.get("content-type"), /text\/html/);
    }
    const skipsHtml = await go("/v1/skips?page=2", { flag, headers: HTML, e: skipsEnv(flag) });
    assert.equal(skipsHtml.status, 200);
    assert.equal(skipsHtml.headers.get("cache-control"), RECEIPT_LIST_CC);
    assert.match(skipsHtml.headers.get("content-type"), /text\/html/);
  });

  test(`by-url 200 is private, no-store when BULK_LIMITS is ${label} (counted by the uncached-read caps)`, async () => {
    const res = await go("/v1/receipts/by-url?url=" + encodeURIComponent(LIVE_URL), { flag });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), RECEIPT_LIST_CC);
  });

  test(`single-by-id 200s keep the edge-cache Cache-Control when BULK_LIMITS is ${label}`, async () => {
    const live = await go("/v1/receipts/" + LIVE_ID, { flag });
    assert.equal(live.status, 200, "live");
    assert.equal(live.headers.get("cache-control"), RECEIPT_IMMUTABLE_CC);
    const crawl = await go("/v1/receipts/" + CRAWL_RECEIPT_ID, { flag });
    assert.equal(crawl.status, 200, "crawl " + CRAWL_RECEIPT_ID);
    assert.equal(crawl.headers.get("cache-control"), RECEIPT_CRAWL_CC);
  });
}

test("a missing crawl receipt 404 keeps the pre-0.77.0 Cache-Control", async () => {
  const res = await go("/v1/receipts/ffffffffff");
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
});

test("snapshot restorer puts the older public max-age back unless SNAP_KEEP_0770=1", () => {
  const prev = process.env.SNAP_KEEP_0770;
  delete process.env.SNAP_KEEP_0770;
  const no = { "cache-control": "private, no-store", vary: "accept" };
  assert.equal(restoreListCache0770("GET https://402xagent.com/v1/skips [none]", no)["cache-control"], "public, max-age=300");
  assert.equal(restoreListCache0770("GET https://402xagent.com/v1/skips.json?page=2 [json]", no)["cache-control"], "public, max-age=300");
  assert.equal(restoreListCache0770("GET https://402xagent.com/v1/receipts [none]", no)["cache-control"], "public, max-age=300");
  assert.equal(restoreListCache0770("GET https://402xagent.com/v1/receipts?page=2 [json]", no)["cache-control"], "public, max-age=300");
  assert.equal(restoreListCache0770("GET https://402xagent.com/v1/receipts?type=dry-run [none]", no)["cache-control"], "public, max-age=60");
  assert.equal(restoreListCache0770("GET https://402xagent.com/v1/receipts [html]", no)["cache-control"], "public, max-age=60");
  assert.equal(restoreListCache0770("GET https://402xagent.com/v1/receipts/by-url?url=https://api.402rates.com/v1/ping [none]", no)["cache-control"], "public, max-age=60");
  const single = { "cache-control": "public, max-age=3600" };
  assert.equal(restoreListCache0770("GET https://402xagent.com/v1/receipts/006776f7b6 [none]", single)["cache-control"], "public, max-age=3600");
  process.env.SNAP_KEEP_0770 = "1";
  assert.equal(restoreListCache0770("GET https://402xagent.com/v1/receipts [none]", no)["cache-control"], "private, no-store");
  if (prev === undefined) delete process.env.SNAP_KEEP_0770; else process.env.SNAP_KEEP_0770 = prev;
});
