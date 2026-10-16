// 0.40.0: after-payment check ("did my x402 payment land?"), Base USDC (EIP-3009) only.
// Pure logic + a small multi-source JSON-RPC reader. No KV. RPC URLs come from Worker secrets and are NEVER returned,
// logged or put in errors (they can carry API keys): answers name sources only ("alchemy", "rpc2", "base-public").
// Plan: /workspace/402xagent/plans/2026-10-16_after-payment-check_scope.md
//
// STRICT re-sign rule (Max, 2026-10-16): safe_to_resign is true ONLY when two independent sources agree the
// authorization nonce is unused AND every agreeing source's chain head time is past validBefore + margin. Any doubt,
// disagreement, single source, missing validBefore or RPC error => false ("don't re-sign"). Retrying the SAME payload
// is always reported safe: an EIP-3009 nonce is single-use, so a replay can never charge twice.

export const PS_ID = "payment-status";
export const PS_NETWORK = "eip155:8453";
export const USDC_BASE_LC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // Circle: USDC on Base
// keccak-256 selectors / topics (verified 2026-10-16; see plan §2)
export const SEL_AUTHORIZATION_STATE = "0xe94a0102"; // authorizationState(address,bytes32) -> bool
export const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TOPIC_AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const TOPIC_AUTH_CANCELED = "0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81";
export const PS_MIN_CONFIRMATIONS = 10; // Base ~2s blocks: ~20s; below this a landed tx is reported pending (reorg window)
export const PS_EXPIRY_MARGIN_S = 120; // validBefore must be this far behind the chain head time
export const PS_LOG_WINDOW_BLOCKS = 43200; // ~24h of Base blocks for the AuthorizationUsed/Canceled lookup
export const PS_RPC_TIMEOUT_MS = 2500;
export const PS_CANNOT_KNOW = [
  "whether the seller delivered the content (the chain shows money moved, not that data was served)",
  "the seller's off-chain state (credits, sessions, idempotency caches)",
  "facilitator internals (queued or in-flight settles that were never broadcast)",
  "reorgs before finality (Base L2 blocks can reorg until L1-finalized; we require " + PS_MIN_CONFIRMATIONS + " confirmations for landed)",
];

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const lc = (s) => String(s || "").toLowerCase();
const pad32 = (addr) => "0x" + lc(addr).replace(/^0x/, "").padStart(64, "0");
const hexNum = (h) => (h == null ? null : Number(BigInt(h)));
const topicAddr = (t) => "0x" + lc(t).slice(-40);
const isoS = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** RPC sources in priority order, from Worker secrets/vars. Never expose .url. */
export function rpcSources(env = {}) {
  const pub = env.PAYSTATUS_PUBLIC_RPC === "off" ? "" : env.PAYSTATUS_PUBLIC_RPC || "https://mainnet.base.org";
  const out = [];
  for (const [name, url] of [["alchemy", env.ALCHEMY_BASE_RPC_URL], ["rpc2", env.RPC2_BASE_URL], ["base-public", pub]]) {
    if (typeof url === "string" && /^https:\/\//.test(url) && !out.some((s) => s.url === url)) out.push({ name, url });
  }
  return out;
}

async function rpc(src, method, params, fetchImpl) {
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), PS_RPC_TIMEOUT_MS) : null;
  try {
    const r = await fetchImpl(src.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), ...(ac ? { signal: ac.signal } : {}) });
    if (!r.ok) throw new Error("http_" + r.status);
    const j = await r.json();
    if (j && j.error) throw new Error("rpc_error");
    return j ? j.result : null;
  } catch (e) {
    throw new Error(/^(http_\d+|rpc_error)$/.test(e && e.message) ? e.message : "unreachable"); // never the URL
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function parseReceipt(rcpt) {
  if (!rcpt) return null;
  const logs = Array.isArray(rcpt.logs) ? rcpt.logs : [];
  const usdc = logs.filter((l) => lc(l.address) === USDC_BASE_LC);
  return {
    hash: rcpt.transactionHash || null,
    block: hexNum(rcpt.blockNumber),
    status: rcpt.status == null ? null : hexNum(rcpt.status),
    submitter: rcpt.from ? lc(rcpt.from) : null,
    transfers: usdc.filter((l) => lc(l.topics && l.topics[0]) === TOPIC_TRANSFER).map((l) => ({ from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), value: BigInt(l.data || "0x0").toString() })),
    auth_used: usdc.filter((l) => lc(l.topics && l.topics[0]) === TOPIC_AUTH_USED).map((l) => ({ authorizer: topicAddr(l.topics[1]), nonce: lc(l.topics[2]) })),
    auth_canceled: usdc.filter((l) => lc(l.topics && l.topics[0]) === TOPIC_AUTH_CANCELED).map((l) => ({ authorizer: topicAddr(l.topics[1]), nonce: lc(l.topics[2]) })),
  };
}

/** One source's view: head, head time, nonce state, receipt and the nonce's event. Throws on any RPC error. */
export async function readSource(src, q, fetchImpl = (...a) => fetch(...a)) {
  const blk = await rpc(src, "eth_getBlockByNumber", ["latest", false], fetchImpl);
  if (!blk || blk.number == null || blk.timestamp == null) throw new Error("no_head");
  const v = { name: src.name, ok: true, head: hexNum(blk.number), head_time: hexNum(blk.timestamp), state: null, receipt: null, event: null };
  if (q.from && q.nonce) {
    const data = SEL_AUTHORIZATION_STATE + pad32(q.from).slice(2) + lc(q.nonce).slice(2);
    const res = await rpc(src, "eth_call", [{ to: USDC_BASE_LC, data }, "latest"], fetchImpl);
    if (typeof res !== "string" || !/^0x[0-9a-fA-F]*$/.test(res)) throw new Error("bad_call");
    v.state = BigInt(res === "0x" ? "0x0" : res) !== 0n;
  }
  let txHash = q.tx_hash || null;
  if (q.from && q.nonce && v.state === true) {
    const logs = await rpc(src, "eth_getLogs", [{ address: USDC_BASE_LC, topics: [[TOPIC_AUTH_USED, TOPIC_AUTH_CANCELED], pad32(q.from), lc(q.nonce)], fromBlock: "0x" + Math.max(0, v.head - PS_LOG_WINDOW_BLOCKS).toString(16), toBlock: "latest" }], fetchImpl);
    const ev = Array.isArray(logs) && logs.length ? logs[logs.length - 1] : null;
    if (ev) {
      v.event = lc(ev.topics[0]) === TOPIC_AUTH_CANCELED ? "canceled" : "used";
      if (!txHash) txHash = ev.transactionHash || null;
      v.event_tx = ev.transactionHash || null;
    }
  }
  if (txHash) v.receipt = parseReceipt(await rpc(src, "eth_getTransactionReceipt", [txHash], fetchImpl));
  if (v.receipt && q.from && q.nonce && !v.event) {
    if (v.receipt.auth_used.some((a) => a.authorizer === lc(q.from) && a.nonce === lc(q.nonce))) v.event = "used";
    else if (v.receipt.auth_canceled.some((a) => a.authorizer === lc(q.from) && a.nonce === lc(q.nonce))) v.event = "canceled";
  }
  return v;
}

/** Query the first two sources in parallel; if fewer than two answer, try the rest one by one. */
export async function readChain(env, q, fetchImpl) {
  const srcs = rpcSources(env);
  const one = (s) => readSource(s, q, fetchImpl).catch((e) => ({ name: s.name, ok: false, error: String((e && e.message) || "error") }));
  const views = await Promise.all(srcs.slice(0, 2).map(one));
  for (const s of srcs.slice(2)) {
    if (views.filter((v) => v.ok).length >= 2) break;
    views.push(await one(s));
  }
  return views;
}

// What a source says landed: a successful receipt that carries this payment (nonce event or a Transfer from the payer).
function landedIn(v, q) {
  const r = v.receipt;
  if (!r || r.status !== 1) return v.event === "used" && !r ? "event_only" : null;
  if (q.from && q.nonce) return v.event === "used" ? "yes" : null;
  if (q.from) return r.transfers.some((t) => t.from === lc(q.from)) ? "yes" : null;
  return r.transfers.length ? "yes" : null;
}

/**
 * Decide from the source views. Returns {status, reason, safe_to_resign, why, wait_until, landed_view, confirmations, agreed}
 * status: landed | not_landed | pending | canceled | unknown.
 */
export function decide(views, q) {
  const ok = views.filter((v) => v.ok);
  if (!ok.length) return { error: "chain_unavailable" };
  const no = (status, reason, why, extra = {}) => ({ status, reason, safe_to_resign: false, why, wait_until: null, agreed: ok.length, ...extra });
  const L = ok.map((v) => landedIn(v, q));
  const anyLanded = L.some((x) => x === "yes");
  const anyCanceled = ok.some((v) => v.event === "canceled");
  const anyUsed = ok.some((v) => v.state === true || v.event === "used");
  const allUnused = q.from && q.nonce ? ok.every((v) => v.state === false && !v.event) : false;

  if (anyCanceled && !anyLanded && !ok.some((v) => v.event === "used"))
    return no("canceled", "authorization_canceled", "the nonce was canceled on-chain (cancelAuthorization), so this payment can never settle; the strict rule only clears re-signing for an expired, unused nonce confirmed by two sources", { final: ok.every((v) => v.event === "canceled") && ok.length >= 1 });

  if (anyLanded) {
    const lv = ok[L.indexOf("yes")];
    const confs = lv.head - lv.receipt.block + 1;
    const disagree = ok.some((v, i) => L[i] !== "yes");
    if (disagree) return no("pending", "sources_disagree", "one RPC source sees the payment on-chain and another does not yet; wait and ask again, do not re-sign", { landed_view: lv, confirmations: confs });
    if (confs < PS_MIN_CONFIRMATIONS) return no("pending", "low_confirmations", `the payment is on-chain with ${confs} confirmation(s); below ${PS_MIN_CONFIRMATIONS} it can still be reorged. Do not re-sign`, { landed_view: lv, confirmations: confs });
    return no("landed", "settled_onchain", "the payment settled on-chain; do not pay again. If nothing was delivered, claim from the seller with this receipt", { landed_view: lv, confirmations: confs, final: true });
  }
  if (anyUsed) {
    const ev = ok.find((v) => v.event === "used" || v.state === true);
    return no("unknown", ok.some((v) => v.event === "used") ? "event_without_receipt" : "nonce_used_tx_not_found", "the nonce is already used on-chain but we could not read the settling transaction (outside our lookup window or a source error); treat it as paid and do not re-sign", { landed_view: ev && ev.receipt ? ev : null });
  }
  // nobody sees it landed or used
  if (q.tx_hash && !(q.from && q.nonce)) {
    const reverted = ok.every((v) => v.receipt && v.receipt.status === 0);
    if (reverted) return no("not_landed", "tx_reverted", "the settle transaction reverted; send from + nonce (or the payment payload) so we can confirm the authorization is unused and expired before you re-sign");
    return no("pending", "tx_not_found", "the transaction is not on-chain (yet); it may still be in a mempool. Send from + nonce (or the payment payload) for a definitive answer; do not re-sign");
  }
  if (!allUnused) return no("unknown", "sources_disagree", "RPC sources disagree about the authorization nonce; do not re-sign");
  if (q.valid_before == null) return no("pending", "valid_before_unknown", "the nonce is unused, but without validBefore (send the payment payload or valid_before) we cannot tell whether it can still settle; do not re-sign");
  const deadline = Number(q.valid_before) + PS_EXPIRY_MARGIN_S;
  const expiredAll = ok.every((v) => v.head_time > deadline);
  if (!expiredAll) return no("pending", "authorization_still_valid", `the authorization is unused but still valid until ${isoS(Number(q.valid_before))}; a facilitator could still settle it. Wait until after ${isoS(deadline)} and ask again; do not re-sign`, { wait_until: isoS(deadline + 1) });
  if (ok.length < 2) return no("unknown", "single_source", "only one RPC source answered; it says the authorization is unused and expired, but the strict rule needs two independent sources before re-signing. Ask again shortly; do not re-sign yet");
  return { status: "not_landed", reason: "expired_unused", safe_to_resign: true, why: `two independent sources (${ok.map((v) => v.name).join(", ")}) agree the nonce is unused and the chain is past validBefore + ${PS_EXPIRY_MARGIN_S}s: this authorization can never settle, so a new payment cannot double-charge`, wait_until: null, agreed: ok.length, final: true };
}

/** Decode the agent's payment payload (base64 PAYMENT-SIGNATURE/X-PAYMENT value or the parsed object). */
export function decodeSubjectPayload(p) {
  let obj = p;
  if (typeof p === "string") {
    try {
      const bin = atob(p.trim());
      obj = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    } catch (_) {
      try { obj = JSON.parse(p); } catch (_) { return { error: "bad_payload" }; }
    }
  }
  if (!obj || typeof obj !== "object") return { error: "bad_payload" };
  const v = Number(obj.x402Version || 1);
  const a = (obj.payload && obj.payload.authorization) || null;
  if (!a || !HEX40.test(a.from || "") || !HEX64.test(a.nonce || "")) return { error: "bad_payload" };
  const acc = v === 2 ? obj.accepted || {} : { network: obj.network, scheme: obj.scheme };
  const network = acc.network === "base" ? PS_NETWORK : acc.network || null;
  return {
    from: lc(a.from), to: lc(a.to), value: a.value != null ? String(a.value) : null, nonce: lc(a.nonce),
    valid_after: a.validAfter != null ? Number(a.validAfter) : null, valid_before: a.validBefore != null ? Number(a.validBefore) : null,
    network, scheme: acc.scheme || null,
    terms: v === 2 && acc.payTo ? { amount: acc.amount != null ? String(acc.amount) : null, payTo: lc(acc.payTo), asset: lc(acc.asset), network } : null,
  };
}

/** Normalize the request body/query. Returns {q} or {error, field, problem}. */
export function parseRequest(b = {}) {
  const net = b.network == null ? PS_NETWORK : String(b.network);
  if (net !== PS_NETWORK && net !== "base") return { error: "unsupported_network", field: "network", problem: "only Base mainnet (eip155:8453) is supported for now; Solana is planned" };
  if (b.asset != null && lc(b.asset) !== USDC_BASE_LC) return { error: "unsupported_asset", field: "asset", problem: "only canonical USDC on Base (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, EIP-3009 exact) is supported" };
  const q = { from: null, nonce: null, tx_hash: null, valid_before: null, seller_url: null, terms: null, payload: null };
  if (b.payment_payload != null && b.payment_payload !== "") {
    const p = decodeSubjectPayload(b.payment_payload);
    if (p.error) return { error: "bad_payload", field: "payment_payload", problem: "payment_payload must be the base64 PAYMENT-SIGNATURE (x402 v2) or X-PAYMENT (v1) value of an exact EIP-3009 USDC payment" };
    if (p.network && p.network !== PS_NETWORK) return { error: "unsupported_network", field: "payment_payload", problem: "the payload is for " + p.network + "; only eip155:8453 is supported for now" };
    if (p.terms && p.terms.asset && p.terms.asset !== USDC_BASE_LC) return { error: "unsupported_asset", field: "payment_payload", problem: "the payload asset is not USDC on Base" };
    Object.assign(q, { from: p.from, nonce: p.nonce, valid_before: p.valid_before, payload: p });
    if (p.terms) q.terms = p.terms;
  }
  for (const [k, re] of [["from", HEX40], ["nonce", HEX64], ["tx_hash", HEX64]]) {
    if (b[k] == null || b[k] === "") continue;
    if (!re.test(String(b[k]))) return { error: "bad_" + k, field: k, problem: `${k} must be ${re === HEX40 ? "a 0x 20-byte address" : "0x + 32 bytes hex"}` };
    if (q[k] && q[k] !== lc(b[k])) return { error: "inconsistent", field: k, problem: `${k} does not match the payment_payload` };
    q[k] = lc(b[k]);
  }
  if (b.valid_before != null && b.valid_before !== "" && q.valid_before == null) {
    if (!/^\d{1,12}$/.test(String(b.valid_before))) return { error: "bad_valid_before", field: "valid_before", problem: "valid_before must be unix seconds" };
    q.valid_before = Number(b.valid_before);
  }
  if ((q.from && !q.nonce) || (q.nonce && !q.from)) return { error: "missing_reference", field: q.from ? "nonce" : "from", problem: "send from and nonce together" };
  if (!q.tx_hash && !(q.from && q.nonce)) return { error: "missing_reference", field: "payment_payload", problem: "send payment_payload, or tx_hash, or from + nonce" };
  if (b.seller_url != null && b.seller_url !== "") {
    if (!/^https?:\/\/[^\s/]+\.[^\s]+/i.test(String(b.seller_url))) return { error: "bad_seller_url", field: "seller_url", problem: "seller_url must be the public http(s) URL you paid" };
    q.seller_url = String(b.seller_url).trim();
  }
  if (b.terms && typeof b.terms === "object") {
    const t = b.terms;
    q.terms = { amount: t.amount != null ? String(t.amount) : null, payTo: t.payTo || t.pay_to ? lc(t.payTo || t.pay_to) : null, asset: t.asset ? lc(t.asset) : USDC_BASE_LC, network: t.network || PS_NETWORK, source: "provided" };
  } else if (q.terms) q.terms = { ...q.terms, source: "payment_payload" };
  return { q };
}

/** Compare what moved (or what was authorized) against the seller's terms. */
export function termsMatch(terms, transfer, q) {
  const m = (a, b) => (a == null || b == null ? "unknown" : lc(a) === lc(b) ? "match" : "mismatch");
  if (!terms) return { amount: "unknown", pay_to: "unknown", asset: "unknown", network: "unknown", source: "none", compared: null };
  const subj = transfer ? { value: transfer.value, to: transfer.to, asset: USDC_BASE_LC, compared: "onchain_transfer" } : q.payload ? { value: q.payload.value, to: q.payload.to, asset: USDC_BASE_LC, compared: "authorization" } : null;
  if (!subj) return { amount: "unknown", pay_to: "unknown", asset: "unknown", network: m(terms.network, PS_NETWORK), source: terms.source || "none", compared: null };
  return { amount: m(terms.amount, subj.value), pay_to: m(terms.payTo, subj.to), asset: m(terms.asset, subj.asset), network: m(terms.network, PS_NETWORK), source: terms.source || "none", compared: subj.compared };
}

export function knownFacilitators(env = {}) {
  try {
    const j = JSON.parse(String(env.PAYSTATUS_FACILITATORS || "{}")); // {"0xsubmitter": {"name":"…","contact":"…"}}
    return j && typeof j === "object" ? Object.fromEntries(Object.entries(j).map(([k, v]) => [lc(k), v])) : {};
  } catch (_) {
    return {};
  }
}

export function claimPointer(status, d, tm, q, sellerContact, env) {
  const fac = d.landed_view && d.landed_view.receipt ? d.landed_view.receipt.submitter : null;
  const known = fac ? knownFacilitators(env)[fac] : null;
  const contacts = [];
  if (sellerContact) contacts.push({ role: "seller", ...sellerContact });
  else if (q.seller_url) { try { contacts.push({ role: "seller", host: new URL(q.seller_url).host, how: "no contact in the seller's 402 or listing; reach the operator of this host" }); } catch (_) {} }
  if (fac) contacts.push({ role: "facilitator", submitter: fac, name: known ? known.name || null : null, how: known ? known.contact || null : "unknown relayer; ask the seller which facilitator they use", inferred: true });
  const needed = status === "landed" || tm.pay_to === "mismatch" || tm.amount === "mismatch";
  return {
    relevant: needed,
    when: "if you paid (status landed) but got nothing, or the amount/payTo differs from the seller's 402 terms",
    evidence: ["this signed receipt (receipt_url + signature)", "tx hash and Basescan link", "authorization from + nonce", "the seller's 402 terms you paid against", "time of your request and the error you got"],
    contacts,
    note: "x402 exact has no protocol refund; a refund is up to the seller (or facilitator). We report chain state, not delivery.",
  };
}

/** Build the receipt body (unsigned). */
export function buildBody({ id, now, q, d, views, tm, claim, origin }) {
  const lv = d.landed_view && d.landed_view.receipt ? d.landed_view : null;
  const r = lv ? lv.receipt : null;
  const tr = r ? r.transfers.find((t) => !q.from || t.from === lc(q.from)) || r.transfers[0] || null : null;
  const ok = views.filter((v) => v.ok);
  const expired = q.valid_before == null || !ok.length ? null : ok.every((v) => v.head_time > Number(q.valid_before));
  return {
    id, type: PS_ID, service: "402xAgent payment status", checked_at: now, network: PS_NETWORK, asset: USDC_BASE_LC,
    status: d.status, reason: d.reason,
    safe_to_retry_same_payload: true,
    same_payload_note: d.status === "landed" ? "safe (an EIP-3009 nonce is single-use, it cannot charge twice) but it will be rejected as a replay: ask the seller to deliver instead" : "safe: an EIP-3009 nonce is single-use, so resending the same signed payment can never charge twice",
    safe_to_resign: !!d.safe_to_resign, why: d.why, wait_until: d.wait_until || null,
    query: { from: q.from, nonce: q.nonce, tx_hash: q.tx_hash, valid_before: q.valid_before, seller_host: q.seller_url ? (() => { try { return new URL(q.seller_url).host; } catch (_) { return null; } })() : null },
    authorization: q.from && q.nonce ? { from: q.from, nonce: q.nonce, used_onchain: ok.length ? ok.some((v) => v.state === true) : null, event: (ok.find((v) => v.event) || {}).event || null, valid_before: q.valid_before == null ? null : isoS(q.valid_before), expired } : null,
    tx: r ? { hash: r.hash, basescan_url: r.hash ? "https://basescan.org/tx/" + r.hash : null, block: r.block, status: r.status, confirmations: d.confirmations ?? null, submitter: r.submitter, transfer: tr } : null,
    terms_match: tm,
    claim,
    cannot_know: PS_CANNOT_KNOW,
    finality: { confirmations: d.confirmations ?? null, min_confirmations: PS_MIN_CONFIRMATIONS, reorg_safe: d.status === "landed" },
    rpc: { sources: views.map((v) => ({ name: v.name, ok: !!v.ok, ...(v.ok ? { head: v.head } : { error: v.error }) })), sources_agreed: d.agreed || 0 },
    permalink: id ? origin + "/v1/receipts/" + id : null,
  };
}

export function newPsId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return "ps-" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export async function cacheKey(q) {
  const s = JSON.stringify([q.from, q.nonce, q.tx_hash, q.valid_before, q.seller_url, q.terms]);
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return "k:" + [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
// D1 (migration 0008): only FINAL answers (landed with >= min confirmations, canceled, not_landed + expired) are stored.
export async function cacheGet(env, key) {
  if (!env.RECEIPTS_DB) return null;
  try {
    const row = await env.RECEIPTS_DB.prepare("SELECT body FROM payment_status WHERE lookup_key = ? ORDER BY created_at DESC LIMIT 1").bind(key).first();
    return row ? JSON.parse(row.body) : null;
  } catch (_) {
    return null;
  }
}
export async function cachePut(env, key, receipt) {
  if (!env.RECEIPTS_DB) return false;
  try {
    await env.RECEIPTS_DB.prepare("INSERT INTO payment_status (id, lookup_key, status, created_at, body) VALUES (?, ?, ?, ?, ?)").bind(receipt.id, key, receipt.status, receipt.checked_at, JSON.stringify(receipt)).run();
    return true;
  } catch (_) {
    return false;
  }
}
export async function receiptById(env, id) {
  if (!env.RECEIPTS_DB || !/^ps-[0-9a-f]{16}$/.test(id)) return null;
  try {
    const row = await env.RECEIPTS_DB.prepare("SELECT body FROM payment_status WHERE id = ?").bind(id).first();
    return row ? JSON.parse(row.body) : null;
  } catch (_) {
    return null;
  }
}
