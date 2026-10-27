// Coinbase AgentKit: a wallet-provider wrapper. AgentKit has no pre-sign hook, but every EVM signature goes through
// the abstract methods of EvmWalletProvider (typescript/agentkit/src/wallet-providers/evmWalletProvider.ts), including
// the x402 action provider's toSigner(). Pass AgentKit's own class in, so `instanceof EvmWalletProvider` still holds:
//   import { EvmWalletProvider } from "@coinbase/agentkit";
//   const VerifiedEvmWalletProvider = makeVerifiedEvmWalletProvider(EvmWalletProvider);
//   const wallet = new VerifiedEvmWalletProvider(inner, { store });
// signTypedData is allowed only for an approved x402 payment; sign, signMessage, signTransaction, sendTransaction
// and nativeTransfer are denied unless named in opts.allow. No network calls here.
import { checkTypedData, VerifyBeforeSignDenied } from "./approvals.mjs";
export { VerifyBeforeSignDenied };

export const GATED = ["sign", "signMessage", "signTransaction", "sendTransaction", "nativeTransfer"];
const PASS = ["getAddress", "getNetwork", "getName", "getBalance", "waitForTransactionReceipt", "readContract", "getPublicClient"];

export function makeVerifiedEvmWalletProvider(EvmWalletProvider) {
  class VerifiedEvmWalletProvider extends EvmWalletProvider {
    /** opts: { store (required), allow: [] method names from GATED to pass through, now } */
    constructor(inner, opts = {}) {
      super();
      if (!inner || !opts.store) throw new Error("VerifiedEvmWalletProvider: inner provider and store are required");
      this.inner = inner;
      this.vbs = { store: opts.store, allow: new Set(opts.allow || []), now: opts.now || Date.now };
    }
    async signTypedData(typedData) {
      const chainId = this.inner.getNetwork && this.inner.getNetwork().chainId;
      const v = checkTypedData(this.vbs.store, typedData, { now: this.vbs.now(), expectedChain: chainId ? "eip155:" + chainId : undefined });
      if (!v.allow) throw new VerifyBeforeSignDenied(v.reason);
      return this.inner.signTypedData(typedData);
    }
  }
  for (const m of GATED) {
    VerifiedEvmWalletProvider.prototype[m] = async function (...args) {
      if (!this.vbs.allow.has(m)) throw new VerifyBeforeSignDenied(m + " is not allowed by this wrapper");
      return this.inner[m](...args);
    };
  }
  for (const m of PASS) VerifiedEvmWalletProvider.prototype[m] = function (...args) { return this.inner[m](...args); };
  return VerifiedEvmWalletProvider;
}
