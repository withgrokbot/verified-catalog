# Crawl storage: Workers KV -> D1 (0.44.0, branch crawl-d1-0.44.0)

Status: built and tested locally only. Nothing deployed, no production D1 writes, KV unchanged.

## What changed
- `worker/migrations/0011_crawl_store.sql`: table `crawl_store(key, part, parts, sha256, value, source, updated_at)`,
  primary key `(key, part)`. Keys are the old KV names (`c:<id[0:2]>` receipt shards, `s:<n>` skip pages, `meta`). A value
  is stored as parts of at most 90 KB, because a D1 SQL statement is capped at 100 KB.
- Worker (`skips.js`, `crawlStoreGet`): reads every part of a key, joins them, and checks the sha256. It serves the value
  only if all parts are present and the hash matches. Otherwise (key missing, a torn write, table missing or D1 down)
  it falls back to `CRAWL_KV`, so a deploy before any backfill is safe. Results are cached per isolate for 300 s, the
  same as the KV cacheTtl.
- `scripts/weekly-crawl/d1_upload.py`: the same input as `kv_upload.py` (`receipts/kv/changed.json`). It asks D1 for each
  key's current sha256 (read-only), then writes only the changed keys as DELETE + INSERT. Keys are grouped into SQL
  files of 8 MB or less; D1 runs each file as one transaction, so a key never spans two files. meta goes last, and every
  key is verified after the write. Use `--local` (the default) or `--remote`.
- `weekly_refresh_skips.sh`: `CRAWL_STORE=kv|d1` picks the storage (default `kv` until the cutover). The `d1` mode makes
  no KV writes.

## Size against the free plan (Workers Free: D1 500 MB per database, 5 GB per account, 5M rows read and 100k rows written per day)
- The 2026-10-20 crawl as rows: 333 keys, 917 rows, 61.4 MB of values. Measured in the local D1 from the dry run.
- Production `vc-spot-receipts` today: 11.5 MB, 9 tables, 1.69M rows read and 2,872 rows written in 24 h (`wrangler d1 info`).
- After the backfill: about 73 MB, roughly 15% of the 500 MB database cap (modeled; the index and page overhead are not measured).
- Writes: a full backfill is 917 rows; a normal week writes only the changed keys (at most 917 rows). That's under 1%
  of the 100k/day cap.
- Reads: a receipt lookup reads 1–4 rows (one shard) and a skips page 1–2 rows, and a hit is cached for 300 s. That
  adds well under 1M rows a day at current traffic (modeled), so the total stays under 5M.

## Cutover (only after approval)
1. Merge `crawl-d1-0.44.0` to main (rebase over discover-0.43.0 first if that merges; its `0010_discover_index.sql` and our `0011` don't collide).
2. Apply the migration to production: `wrangler d1 migrations apply RECEIPTS_DB --remote` (it creates an empty table; reads keep using KV).
3. Deploy the Worker (committed code, the usual command). It's safe with an empty table, because every key falls back to KV.
4. Backfill: `python3 receipts/scripts/d1_upload.py --remote --changed receipts/kv/bulk.json` (917 rows, no KV writes). Verify
   the live `/v1/skips.json?page=N` and `/v1/receipts/<crawl id>` (the same checks as the local run).
5. Weekly runs from then on: `CRAWL_STORE=d1 bash receipts/scripts/weekly_refresh_skips.sh`. This deploys the new bundle
   only after D1 verifies, so the site shows the new crawl date with no KV writes.
6. Later (separate OK): stop reading KV (drop the fallback and the `CRAWL_KV` binding) after one full week served from D1.
   Rollback before that point is a redeploy of the previous version; KV still holds the Oct 13 data.

## Discovery reuse (0.43.0)
- discover-0.43.0 already keeps its query index in D1 (`discover_index`, one row per endpoint, with filters in SQL). That
  stays separate, because it needs row-level queries, which `crawl_store` blobs can't answer.
- Shared parts: the weekly crawl output feeds both. In the same run, after the `d1_upload.py` step,
  `build_discover_index` upserts only the changed `discover_index` rows (keyed by normalized URL; the same changed-only
  rule, compared by row hash).
- Any blob that discovery needs to serve (e.g. a per-task snapshot or a "newest crawl" summary) goes in `crawl_store`
  with `source='discover'` and a `d:` key prefix. It's read with the same `crawlStoreGet`, with the same sha check, and
  needs no new table or KV.
- One freshness source: `crawl_store` key `meta` (`crawled_at`). Both /v1/skips and /v1/discover read it, so they can't disagree.
