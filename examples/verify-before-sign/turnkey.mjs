// Turnkey: a client-side wrapper around a viem account from @turnkey/viem (createAccount / createAccountWithAddress).
// Turnkey's own policies are evaluated on Turnkey's servers and cannot call out, so this check runs in your process
// before the request reaches Turnkey. Anything that calls the Turnkey API directly bypasses it.
//   const account = withVerifyBeforeSign(await createAccount({ client, organizationId, signWith }), { store });
// signTypedData is allowed only for an approved x402 payment. Every other sign* method (sign, signMessage,
// signTransaction, signAuthorization, and any added later) throws unless named in opts.allow. No network calls here.
import { checkTypedData, VerifyBeforeSignDenied } from "./approvals.mjs";

export function withVerifyBeforeSign(account, opts = {}) {
  if (!account || !opts.store) throw new Error("withVerifyBeforeSign: account and store are required");
  const allow = new Set(opts.allow || []);
  const now = opts.now || Date.now;
  const out = { ...account };
  for (const [k, v] of Object.entries(account)) {
    if (typeof v !== "function" || !/^sign/.test(k) || k === "signTypedData") continue;
    out[k] = async (...args) => {
      if (!allow.has(k)) throw new VerifyBeforeSignDenied(k + " is not allowed by this wrapper");
      return v.apply(account, args);
    };
  }
  out.signTypedData = async (typedData) => {
    const r = checkTypedData(opts.store, typedData, { now: now(), expectedChain: opts.chain });
    if (!r.allow) throw new VerifyBeforeSignDenied(r.reason);
    return account.signTypedData(typedData);
  };
  return out;
}
