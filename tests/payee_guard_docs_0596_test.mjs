// 0.59.6: /docs carries the payee-guard composition section once, in the order payee -> route/price -> pay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { docsIndexHtml, DOCS_PAYEE_GUARD } from "../worker/src/docs.js";
import { CANON_ORIGIN, API_ORIGIN } from "../worker/src/spotcheck.js";

test("0.59.6 payee-guard section on /docs, once, after the quick start", () => {
  const t = docsIndexHtml(CANON_ORIGIN, API_ORIGIN, { endpointReport: true, watchtower: true, tryIt: { freePerDay: 5 } });
  assert.equal(t.split('id="payee-guard"').length, 2);
  assert.ok(t.includes(DOCS_PAYEE_GUARD));
  assert.ok(t.indexOf('id="quick-start"') < t.indexOf('id="payee-guard"') && t.indexOf('id="payee-guard"') < t.indexOf('id="products"'));
  const a = DOCS_PAYEE_GUARD.indexOf("inamGuardedFetch(fetch"), b = DOCS_PAYEE_GUARD.indexOf("spotCheckFetch(payeeChecked)"), c = DOCS_PAYEE_GUARD.indexOf("wrapFetchWithPayment(routeChecked, client)");
  assert.ok(a > 0 && a < b && b < c, "payee, then route/price, then pay");
  assert.ok(!/partner|endorse|official/i.test(DOCS_PAYEE_GUARD), "no partnership or endorsement wording");
});
