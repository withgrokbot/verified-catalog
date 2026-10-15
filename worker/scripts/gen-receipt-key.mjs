#!/usr/bin/env node
// Generates the 402xAgent receipt-signing ed25519 key pair LOCALLY.
// - The private JWK is written straight to a file (mode 600, dir 700) OUTSIDE the repo; it is never printed.
// - Only the public part (kid, x) is printed and written into worker/src/sign.js (RECEIPT_PUBLIC_KEYS).
// - Refuses to overwrite an existing key file. Deploying the secret is a separate, manual step:
//     wrangler secret put RECEIPT_SIGNING_KEY < ~/.secrets/402xagent-receipt-ed25519.json
// Usage: node worker/scripts/gen-receipt-key.mjs [--out PATH]
import { generateKeyPairSync, createHash } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const i = process.argv.indexOf("--out");
const out = resolve(i > 0 ? process.argv[i + 1] : join(homedir(), ".secrets", "402xagent-receipt-ed25519.json"));
if (out.startsWith(repo + "/")) { console.error("refusing: key file must be outside the repo"); process.exit(1); }
if (existsSync(out)) { console.error("refusing: " + out + " exists (not overwritten)"); process.exit(1); }

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "jwk" });
const created = new Date().toISOString().slice(0, 10);
const kid = "402xagent-" + created.replace(/-/g, "") + "-" + createHash("sha256").update(Buffer.from(pub.x, "base64url")).digest("hex").slice(0, 8);
const priv = { ...privateKey.export({ format: "jwk" }), kid };

mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
chmodSync(dirname(out), 0o700);
writeFileSync(out, JSON.stringify(priv), { mode: 0o600, flag: "wx" });
chmodSync(out, 0o600);

const signJs = join(repo, "worker", "src", "sign.js");
const s = readFileSync(signJs, "utf8");
const line = `  { kid: ${JSON.stringify(kid)}, x: ${JSON.stringify(pub.x)}, created: ${JSON.stringify(created)} },\n`;
writeFileSync(signJs, s.replace(/( *\/\/ RECEIPT_PUBLIC_KEYS_END)/, line + "$1"));
console.log(JSON.stringify({ wrote_private_key_file: out, mode: "600", public: { kid, kty: "OKP", crv: "Ed25519", x: pub.x } }, null, 2));
