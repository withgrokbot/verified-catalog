#!/usr/bin/env node
// npx 402xagent-check <url> [--json]
// Exit codes: 0 pay, 1 skip, 2 recheck, 3 error (bad URL, quota used up, network).
import { check, CheckError } from "./index.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const url = args.find((a) => !a.startsWith("--"));
if (!url || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: npx 402xagent-check <x402-endpoint-url> [--json]\nFree check: 5 a day per client. Docs: https://402xagent.com/docs");
  process.exit(url ? 0 : 3);
}
try {
  const r = await check(url);
  if (json) console.log(JSON.stringify(r, null, 2));
  else console.log(`${String(r.verdict || "?").toUpperCase()}: ${r.reason || r.reason_code || ""}${r.receipt_id ? `\nreceipt: ${r.receipt_id}` : ""}`);
  process.exit({ pay: 0, skip: 1, recheck: 2 }[r.verdict] ?? 3);
} catch (e) {
  if (json && e instanceof CheckError) console.log(JSON.stringify({ status: e.status, ...e.body }, null, 2));
  else console.error(`error: ${e.message}`);
  process.exit(3);
}
