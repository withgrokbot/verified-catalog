// 0.59.10: which crawl the bundled data is (worker/src/receipts-data.js RECEIPTS_META), and the per-crawl snapshot
// fixtures. No side effects (machine_snapshot.mjs freezes the clock; this module does not).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const DATA_META = JSON.parse(/RECEIPTS_META = (\{.*?\});/.exec(readFileSync(new URL("../../worker/src/receipts-data.js", import.meta.url), "utf8"))[1]);
export const CRAWLED_AT = DATA_META.crawled_at;
export const CRAWL_STAMP = CRAWLED_AT.replace(/[-:]/g, "");
/** 0.59.10: a crawl receipt that is in the bundled page 1 (the featured one), instead of a hard-coded id. */
export const CRAWL_RECEIPT_ID = DATA_META.featured_id;
/** Snapshot clock: noon UTC the day after the crawl (2026-10-28T12:00:00Z for the 2026-10-27 crawl, the clock every older fixture used). */
export const SNAP_NOW = Date.parse(CRAWLED_AT.slice(0, 10) + "T12:00:00Z") + 86400000;
/** 0.59.10: snapshot fixtures are per crawl. The 2026-10-27 crawl's live at tests/fixtures/<dir>/<file> (as taken);
 * any other crawl's at tests/fixtures/<dir>/crawl-<stamp>/<file>, made by scripts/regen_snapshot_fixtures.sh, which runs machine_snapshot.mjs / bodies402.mjs against each fixture's ORIGINAL version (git archive of that commit) with the bundled crawl data dropped in. */
export const LEGACY_CRAWL = "2026-10-27T17:36:57Z";
export function fixturePath(dir, file) {
  const u = new URL(`../fixtures/${dir}/${CRAWLED_AT === LEGACY_CRAWL ? "" : `crawl-${CRAWL_STAMP}/`}${file}`, import.meta.url);
  if (!existsSync(u)) throw new Error(`no snapshot fixture ${dir}/${file} for crawl ${CRAWLED_AT}: run scripts/regen_snapshot_fixtures.sh`);
  return fileURLToPath(u);
}
export const readFixture = (dir, file) => JSON.parse(readFileSync(fixturePath(dir, file), "utf8"));
