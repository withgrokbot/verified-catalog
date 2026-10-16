#!/usr/bin/env node
// 0.41.0 owner-only hosted-mode key tool. Never prints the pepper or a full key.
//   node scripts/hosted_key.mjs pepper              create ~/.secrets/402xagent-hosted-pepper.txt (600) if missing
//   node scripts/hosted_key.mjs issue <name>        new integrator; full key written to ~/.secrets/402xagent-key-<id>.txt (600)
//   node scripts/hosted_key.mjs revoke <id>         status=revoked
//   node scripts/hosted_key.mjs meter <id>          usage counts from D1
// Then set the Worker secret once (deploy step):
//   env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN npx -y -p node@22 -p wrangler@latest wrangler secret put HOSTED_KEY_PEPPER < ~/.secrets/402xagent-hosted-pepper.txt
import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".secrets");
const PEPPER = join(DIR, "402xagent-hosted-pepper.txt");
const DB = "vc-spot-receipts";
const sq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const d1 = (sql) => {
  const env = { ...process.env }; delete env.CF_API_TOKEN; delete env.CLOUDFLARE_API_TOKEN;
  const out = execFileSync("npx", ["-y", "-p", "node@22", "-p", "wrangler@latest", "wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out);
};
const write600 = (p, s) => { mkdirSync(DIR, { recursive: true, mode: 0o700 }); writeFileSync(p, s, { mode: 0o600 }); chmodSync(p, 0o600); };

const [cmd, arg] = process.argv.slice(2);
if (cmd === "pepper") {
  if (existsSync(PEPPER)) console.log("pepper exists:", PEPPER);
  else { write600(PEPPER, randomBytes(32).toString("base64url")); console.log("pepper written:", PEPPER, "(600, not printed)"); }
} else if (cmd === "issue") {
  if (!arg || !/^[a-z0-9._ -]{2,64}$/i.test(arg)) throw new Error("usage: issue <name>");
  const pepper = readFileSync(PEPPER, "utf8").trim();
  const id = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(pepper + ":" + secret).digest("hex");
  d1(`INSERT INTO integrators (id, name, status, key_hash, free_total, first_invoice_paid, created_at) VALUES (${sq(id)}, ${sq(arg)}, 'active', ${sq(hash)}, 1000, 0, ${sq(new Date().toISOString())})`);
  const file = join(DIR, `402xagent-key-${id}.txt`);
  write600(file, `402x_live_${id}_${secret}\n`);
  console.log(JSON.stringify({ issued: id, name: arg, key_file: file, key_prefix: `402x_live_${id}_…` }));
} else if (cmd === "revoke") {
  if (!/^[0-9a-f]{8}$/.test(arg || "")) throw new Error("usage: revoke <8-hex id>");
  d1(`UPDATE integrators SET status = 'revoked', revoked_at = ${sq(new Date().toISOString())} WHERE id = ${sq(arg)}`);
  console.log(JSON.stringify(d1(`SELECT id, name, status, revoked_at FROM integrators WHERE id = ${sq(arg)}`)[0].results));
} else if (cmd === "meter") {
  if (!/^[0-9a-f]{8}$/.test(arg || "")) throw new Error("usage: meter <8-hex id>");
  console.log(JSON.stringify(d1(`SELECT month, product, band, COUNT(*) AS n, SUM(price_atomic) AS atomic FROM hosted_usage WHERE integrator_id = ${sq(arg)} GROUP BY month, product, band`)[0].results));
} else {
  console.log("commands: pepper | issue <name> | revoke <id> | meter <id>");
}
