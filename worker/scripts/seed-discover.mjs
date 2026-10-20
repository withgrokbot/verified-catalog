// 0.43.0: build a SQL file that seeds D1 discover_index from a crawl receipts JSONL (local dev and, only when
// approved, the remote D1). Usage: node scripts/seed-discover.mjs <receipts-*.jsonl> <out.sql>
// verified_price_usd = the price the live 402 quoted (null when no valid 402); the listing claim is not used.
// then: npx wrangler d1 execute RECEIPTS_DB --local --file <out.sql>
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const [inp, out] = process.argv.slice(2);
if (!inp || !out) { console.error("usage: seed-discover.mjs <receipts.jsonl> <out.sql>"); process.exit(2); }
const run = basename(inp).replace(/\.jsonl$/, "");
const s = (v) => (v === null || v === undefined || v === "" ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");
const n = (v) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "NULL");
const rows = [];
for (const line of readFileSync(inp, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  if (!/^[0-9a-f]{10}$/.test(r.id || "") || !["pay", "skip", "recheck"].includes(r.verdict) || !r.timestamp) continue;
  const url = r.norm_url || r.url;
  const search = [url, r.source_list, ...(r.also_listed_in || [])].filter(Boolean).join(" ").toLowerCase();
  rows.push(`(${s(r.id)},${s(r.url)},${s(search)},${s(r.verdict)},${s(r.reason || "")},${n(r.quoted_price_usd)},${s(r.network)},${s(r.asset)},${s(r.method)},${s(r.source_list)},${s(r.timestamp)},${s(run)})`);
}
const cols = "(id,url,search,verdict,reason,price_usd,network,asset,method,source_list,checked_at,crawl_run)";
const parts = [];
for (let i = 0; i < rows.length; i += 200) parts.push(`INSERT OR REPLACE INTO discover_index ${cols} VALUES\n${rows.slice(i, i + 200).join(",\n")};`);
writeFileSync(out, parts.join("\n") + "\n");
console.log(`${rows.length} rows from ${run} -> ${out}`);
