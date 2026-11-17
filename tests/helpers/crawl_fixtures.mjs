// 0.59.10: which crawl the bundled data is (worker/src/receipts-data.js RECEIPTS_META), and the per-crawl snapshot
// fixtures. Loading this module generates missing per-crawl snapshots into a temp cache when the
// bundled crawl is not the 2026-10-27 legacy set (skipped when VC_GENERATING_FIXTURES=1 or VC_SKIP_FIXTURE_GEN=1).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCrawlFixtures, cacheRoot } from "./generate_crawl_fixtures.mjs";
const DATA_META = JSON.parse(/RECEIPTS_META = (\{.*?\});/.exec(readFileSync(new URL("../../worker/src/receipts-data.js", import.meta.url), "utf8"))[1]);
export const CRAWLED_AT = DATA_META.crawled_at;
export const CRAWL_STAMP = CRAWLED_AT.replace(/[-:]/g, "");
/** 0.59.10: a crawl receipt that is in the bundled page 1 (the featured one), instead of a hard-coded id. */
export const CRAWL_RECEIPT_ID = DATA_META.featured_id;
/** Snapshot clock: noon UTC the day after the crawl (2026-10-28T12:00:00Z for the 2026-10-27 crawl, the clock every older fixture used). */
export const SNAP_NOW = Date.parse(CRAWLED_AT.slice(0, 10) + "T12:00:00Z") + 86400000;
/** 0.59.10: snapshot fixtures are per crawl. The 2026-10-27 crawl's live at tests/fixtures/<dir>/<file> (as taken);
 * any other crawl's fixtures are generated on demand (tests/helpers/generate_crawl_fixtures.mjs) into a temp cache, or taken from tests/fixtures/<dir>/crawl-<stamp>/<file> if present. Generation uses machine_snapshot.mjs / bodies402.mjs against each fixture's ORIGINAL version (git archive of that commit) with the bundled crawl data dropped in, so a weekly crawl refresh does not need a new committed stamp. */
export const LEGACY_CRAWL = "2026-10-27T17:36:57Z";
export function fixturePath(dir, file) {
  if (CRAWLED_AT === LEGACY_CRAWL) {
    const u = new URL(`../fixtures/${dir}/${file}`, import.meta.url);
    if (!existsSync(u)) throw new Error(`no snapshot fixture ${dir}/${file} for the legacy crawl ${CRAWLED_AT}`);
    return fileURLToPath(u);
  }
  const cached = join(cacheRoot(CRAWL_STAMP), dir, file);
  if (existsSync(cached)) return cached;
  const repo = fileURLToPath(new URL(`../fixtures/${dir}/crawl-${CRAWL_STAMP}/${file}`, import.meta.url));
  if (existsSync(repo)) return repo;
  throw new Error(`no snapshot fixture ${dir}/${file} for crawl ${CRAWLED_AT}: auto-generation did not produce it (see tests/helpers/generate_crawl_fixtures.mjs)`);
}
if (CRAWLED_AT !== LEGACY_CRAWL && process.env.VC_GENERATING_FIXTURES !== "1" && process.env.VC_SKIP_FIXTURE_GEN !== "1") {
  ensureCrawlFixtures({ stamp: CRAWL_STAMP, crawledAt: CRAWLED_AT });
}
export const readFixture = (dir, file) => JSON.parse(readFileSync(fixturePath(dir, file), "utf8"));
