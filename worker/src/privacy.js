// 0.45.6 privacy hotfix: buyer data never appears in a public view. Removed from every public receipt (sc-, ps-, lists,
// by-url, MCP get_receipt): payment_received.{payer, settle_tx, basescan_url}, query.{from, nonce, tx_hash},
// authorization.{from, nonce}, tx.{hash, submitter, transfer, basescan_url}, any buyer payment payload / signature /
// authorization, client and IP fields. Any other string that contains one of the removed values is masked too.
// Stored rows keep the raw data (private, never served). A signed view that changed is re-signed with the current key
// and marked redacted_v2: true (the old signature is never served). Seller pay_to stays public.
import { signObject } from "./sign.js";

const PATHS = [
  ["payment_received", ["payer", "settle_tx", "basescan_url"]],
  ["query", ["from", "nonce", "tx_hash"]],
  ["authorization", ["from", "nonce"]],
  ["tx", ["hash", "submitter", "transfer", "basescan_url"]],
];
const TOP = ["payment_payload", "payment_signature", "payment_header", "x_payment", "paymentPayload", "client", "client_ip", "ip", "cf_connecting_ip", "payer"];
const MASK = "<redacted>";

function collect(v, out) {
  if (v == null) return;
  if (typeof v === "string") { if (v.length >= 8) out.add(v); if (v.length >= 8) out.add(v.toLowerCase()); return; }
  if (typeof v === "object") for (const x of Object.values(v)) collect(x, out);
}
function maskDeep(v, secrets) {
  if (typeof v === "string") {
    let s = v;
    for (const x of secrets) if (s.includes(x)) s = s.split(x).join(MASK);
    if (secrets.size && s !== v) return s;
    const lc = s.toLowerCase();
    for (const x of secrets) if (lc.includes(x)) return MASK;
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, secrets));
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = maskDeep(x, secrets); return o; }
  return v;
}
function scrubLevel(o, secrets) {
  let changed = false;
  for (const k of TOP) if (k in o) { collect(o[k], secrets); delete o[k]; changed = true; }
  for (const [parent, keys] of PATHS) {
    const p = o[parent];
    if (!p || typeof p !== "object") continue;
    const c = { ...p };
    for (const k of keys) if (k in c) { collect(c[k], secrets); delete c[k]; changed = true; }
    o[parent] = c;
  }
  return changed;
}
// Pure: returns { view, changed }. Scrubs the top level and any embedded receipt (receipt, signed_view, chain_answer).
export function scrubView(r) {
  if (!r || typeof r !== "object") return { view: r, changed: false };
  const secrets = new Set();
  const o = JSON.parse(JSON.stringify(r));
  let changed = scrubLevel(o, secrets);
  for (const k of ["receipt", "chain_answer"]) if (o[k] && typeof o[k] === "object") changed = scrubLevel(o[k], secrets) || changed;
  if (!secrets.size) return { view: o, changed };
  const masked = maskDeep(o, secrets);
  return { view: masked, changed: changed || JSON.stringify(masked) !== JSON.stringify(o) };
}
// Public view: scrub; if anything was removed from a signed view, drop the old signature and re-sign (current key).
export async function privateFree(env, r) {
  const { view, changed } = scrubView(r);
  if (!changed || !view || typeof view !== "object") return view;
  const { signature, kid, ...rest } = view;
  if (rest.receipt && typeof rest.receipt === "object" && rest.receipt.signature) {
    const { signature: _s, kid: _k, ...inner } = rest.receipt;
    rest.receipt = (await signObject(env, { ...inner, redacted_v2: true })) || { ...inner, redacted_v2: true };
  }
  const out = { ...rest, redacted_v2: true };
  return signature ? (await signObject(env, out)) || out : out;
}
