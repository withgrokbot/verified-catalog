// Generate per-crawl snapshot fixtures from each fixture's original Worker commit,
// with the currently bundled crawl data (receipts-data.js / saves-data.js) dropped in.
// Used when the bundled crawl is not the 2026-10-27 legacy set, so weekly refreshes do
// not need a committed crawl-<stamp> directory. Writes to a temp cache by default;
// --repo writes into tests/fixtures/<dir>/crawl-<stamp>/ (same as the old shell script).
//
// Run from the repo root: node tests/helpers/generate_crawl_fixtures.mjs
// Or: scripts/regen_snapshot_fixtures.sh
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

// fixture relative path, commit it was taken on, helper mode (snap | bodies | flag for machine_snapshot.mjs)
export const FIXTURE_MAP = [
  ["machine_0.57.1/snapshot.json", "5efdf33", "snap"],
  ["machine_0.58.2/extra.json", "714e418", "--extra"],
  ["machine_0.58.3/snapshot.json", "139fed1", "--0583"],
  ["machine_0.58.4/snapshot.json", "1d5868d", "--0583"],
  ["machine_0.58.4/receipts.json", "1d5868d", "--receipts"],
  ["machine_0.58.6/snapshot.json", "17342a1", "--0583"],
  ["machine_0.58.6/receipts.json", "17342a1", "--receipts"],
  ["machine_0.58.6/skips.json", "17342a1", "--skips"],
  ["machine_0.58.7/snapshot.json", "89da67f", "snap"],
  ["machine_0.58.7/bodies402.json", "89da67f", "bodies"],
  ["machine_0.58.9/snapshot.json", "8344dd7^", "snap"],
  ["machine_0.58.9/receipts.json", "8344dd7^", "--receipts"],
];

export const cacheRoot = (stamp) => join(tmpdir(), "vc-crawl-fixtures", stamp);

function extractWorker(root, commit, dest) {
  mkdirSync(dest, { recursive: true });
  const r = spawnSync("git", ["archive", commit, "worker"], { cwd: root, encoding: null, maxBuffer: 64 << 20, env: process.env });
  if (r.status !== 0) throw new Error(`git archive ${commit} failed: ${(r.stderr || "").toString().slice(-2000)}`);
  const t = spawnSync("tar", ["-x", "-C", dest], { input: r.stdout, encoding: null, maxBuffer: 64 << 20 });
  if (t.status !== 0) throw new Error(`tar extract ${commit} failed: ${(t.stderr || "").toString().slice(-2000)}`);
}

export function generateFixture(relFile, commit, mode, outFile, root = ROOT) {
  const dest = mkdtempSync(join(tmpdir(), "vc-fx-"));
  try {
    extractWorker(root, commit, dest);
    const nm = join(root, "worker", "node_modules");
    const destNm = join(dest, "worker", "node_modules");
    if (existsSync(nm) && !existsSync(destNm)) {
      try { symlinkSync(nm, destNm); } catch (_) {}
    }
    cpSync(join(root, "worker", "src", "receipts-data.js"), join(dest, "worker", "src", "receipts-data.js"));
    cpSync(join(root, "worker", "src", "saves-data.js"), join(dest, "worker", "src", "saves-data.js"));
    const workerIndex = join(dest, "worker", "src", "index.js");
    const env = { ...process.env, VC_GENERATING_FIXTURES: "1" };
    delete env.CF_API_TOKEN;
    delete env.CLOUDFLARE_API_TOKEN;
    let args;
    if (mode === "snap") args = [join(root, "tests", "helpers", "machine_snapshot.mjs"), workerIndex];
    else if (mode === "bodies") args = [join(root, "tests", "helpers", "bodies402.mjs"), workerIndex];
    else args = [join(root, "tests", "helpers", "machine_snapshot.mjs"), mode, workerIndex];
    const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", maxBuffer: 64 << 20, timeout: 180000 });
    if (r.status !== 0) {
      throw new Error(`FAILED: ${relFile} (from ${commit} ${mode}): ${(r.stderr || r.stdout || "").slice(-4000)}`);
    }
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, r.stdout);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

/**
 * Ensure every mapped fixture for this crawl exists in the cache (or already in the repo).
 * No-op when VC_GENERATING_FIXTURES=1 (the generator child) or the crawl is the legacy set.
 */
export function ensureCrawlFixtures({ root = ROOT, stamp, crawledAt, outRepo = false, force = false } = {}) {
  if (process.env.VC_GENERATING_FIXTURES === "1") return [];
  const wrote = [];
  for (const [rel, commit, mode] of FIXTURE_MAP) {
    const dir = dirname(rel);
    const file = rel.split("/").pop();
    const repo = join(root, "tests", "fixtures", dir, `crawl-${stamp}`, file);
    const cached = join(cacheRoot(stamp), dir, file);
    const dest = outRepo ? repo : cached;
    if (!force && (existsSync(dest) || (!outRepo && existsSync(repo)))) continue;
    process.stderr.write(`generating ${rel} for crawl ${crawledAt} (from ${commit} ${mode})\n`);
    generateFixture(rel, commit, mode, dest, root);
    wrote.push(dest);
  }
  return wrote;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const outRepo = process.argv.includes("--repo");
  const force = process.argv.includes("--force");
  const meta = /RECEIPTS_META = (\{.*?\});/.exec(
    (await import("node:fs")).readFileSync(join(ROOT, "worker", "src", "receipts-data.js"), "utf8"),
  )[1];
  const crawledAt = JSON.parse(meta).crawled_at;
  const stamp = crawledAt.replace(/[-:]/g, "");
  if (crawledAt === "2026-10-27T17:36:57Z") {
    console.error("bundled crawl is the legacy 2026-10-27 set; fixtures already live at tests/fixtures/<dir>/");
    process.exit(0);
  }
  const wrote = ensureCrawlFixtures({ stamp, crawledAt, outRepo, force });
  for (const f of wrote) console.error("wrote " + f);
  if (!wrote.length) console.error("all fixtures already present for " + crawledAt);
}
