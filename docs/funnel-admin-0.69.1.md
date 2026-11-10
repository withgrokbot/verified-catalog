# Admin funnel counts (0.69.1)

Internal only. This route is not in OpenAPI, `llms.txt`, the public docs, or the site. A request without the bearer token is a 404.

## Read

`GET /v1/admin/funnel?days=N`

- `Authorization: Bearer $FUNNEL_ADMIN_TOKEN` (a Worker secret). Missing or wrong token: 404, including when the secret is unset.
- `days` is clamped to 1..30. Omitted means 7.
- The Worker reads Analytics Engine with `CF_ACCOUNT_ID` and `AE_READ_TOKEN` (Account Analytics Read). Those stay secrets. If either is unset the route is 503. A failed query is 502.
- Response: `cache-control: no-store` and `x-robots-tag: noindex`.

## What 0.69.1 adds

The 0.52.0 spot funnel (`vc_funnel`: `free_check`, `cap_hit`, `paid`, `liteConversion`) is unchanged. `daily[].paid_events` is still that dataset's sample count.

`calls` is one object per UTC day that had any of the three counters, oldest first. `calls_totals` sums them. Each counter is `{ total, self, outside }`.

| Field | Meaning | Already stored as |
|---|---|---|
| `free_checks` | A free lookup or free spot-check. Access `free`, `exempt` (SELF_CLIENTS, including the cron and probes) or `partner`. Dry runs are not included. | `vc_lookups` blob16 `lookup` or `spot`, blob13 one of those access values |
| `payment_required_402` | An HTTP 402 the Worker recorded, including `payment-required` and `payment-failed` | double3 = 402 |
| `paid_events` | A settled call. Access `paid`, or `paid-unstored` when settlement succeeded and the receipt store did not | blob13 |

`self` is blob6 already equal to `self`: a `SELF_CLIENTS` client (the daily recheck and Bazaar probe send `withgrokbot-selftest`), a user-agent matching `withgrokbot`, or a settled spot check whose payer is our `PAY_TO` or `DRILL_WALLETS`. Everything else, including crawlers, is `outside`.

`by_host` repeats the three counters per host. The host is `hostTag` on blob20, the same buckets as `paywall_daily_host`: `api.402xagent.com`, `402xagent.com`, `workers.dev`, `payscout`, `other`. An empty blob20 (rows from before 0.22.0) is `unrecorded`.

Counts are `SUM(_sample_interval)`.

## History

No new Analytics Engine blobs or indexes. The columns above were already written on `vc_lookups`, so these counts cover whatever that dataset still retains. Host is empty on rows from before 0.22.0. Deploys do not backfill.

The query selects day, blob6, blob13, blob16, blob20, double3 and the sample interval. It does not read a client id, IP, wallet, referrer or transaction, and the JSON does not return one.
