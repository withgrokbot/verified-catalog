# Verify before sign (examples)

Policy modules that let a wallet sign an x402 payment only after 402xAgent has checked the seller's live terms.
Our code never holds or touches a key: it only returns allow or deny. Examples, not a published package;
no Worker changes. Node 18+, no dependencies.

## Two layers

The signer only sees EIP-712 typed data (payee, amount, token, chain). It never sees the resource URL, which
both checks need. So the check runs earlier, and the signer only looks up the result.

1. **Client layer** (`client-hook.mjs`): an `onBeforePaymentCreation` hook for `@x402/core`'s `x402Client`.
   It runs while the URL is known and calls `POST /v1/facilitator/check` (default, free; `decideFacilitator` in
   `../decision-gate/facilitator-gate.mjs`) or the spot-check (`check: "spot"`, `decide()` in `gate.mjs`). On
   allow it records an approval; on anything else it aborts, so nothing is signed.
2. **Signer layer** (`approvals.mjs` `checkTypedData`, used by the three wrappers below). No network. It rebuilds
   the terms from the `TransferWithAuthorization` typed data and allows only with a matching approval.

**Approvals** are single use and expire after 60 s (`ttlMs`). They are keyed on `termsSha256`
(`network|asset|amount|payTo`, the service's formula, with the network normalized to CAIP-2).
`tests/verify_before_sign_test.mjs` shows that the hash rebuilt from the typed data `@x402/evm` 2.28.0 signs
equals the Worker's hash of the accepts entry (USDC exact on Base, x402 v1 and v2). The EIP-3009 nonce and
`validBefore` can't be part of the key: `@x402/evm` creates them after the hook runs. Instead the signer
consumes the approval, requires `validBefore <= now + maxTimeoutSeconds + 5 s`, and refuses a nonce it has
already seen.

Denied:
- a missing, expired or already-used approval;
- a reused nonce;
- a chain mismatch;
- any typed data other than `TransferWithAuthorization`;
- Permit2 (`assetTransferMethod: "permit2"`) and non-`exact` schemes;
- non-EVM networks;
- check timeouts, non-200 responses and malformed bodies.

```js
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
const store = new MemoryApprovals();                       // FileApprovals(dir) for OWS
const client = new x402Client();
registerExactEvmScheme(client, { signer: wrappedAccount }); // one of the wrappers below
client.onBeforePaymentCreation(verifyBeforeSignHook({ store }));
```

The hook can't see the HTTP method, so it checks with `method` (default `GET`).

## Wallets

| File | Wallet | Hook used |
| --- | --- | --- |
| `ows-policy.mjs` + `ows-policy.sample.json` | Open Wallet Standard (MoonPay, MIT, github.com/open-wallet-standard/core) | OWS executable policy: PolicyContext JSON on stdin, `{allow, reason}` on stdout |
| `agentkit.mjs` | Coinbase AgentKit | `makeVerifiedEvmWalletProvider(EvmWalletProvider)`: wraps an inner `EvmWalletProvider` |
| `turnkey.mjs` | Turnkey | `withVerifyBeforeSign(account)`: wraps a viem account from `@turnkey/viem` |

**OWS.**
- Policies run only in agent-token mode, when signing with an `ows_key_...` API key. Owner (passphrase) signing
  skips all policies, so this does nothing there.
- The executable reads `typed_data.raw_json`, reads and consumes approvals from `policy_config.approvals_dir`
  (the client layer writes them with `FileApprovals`), and always exits 0 with JSON, so a deny is explicit.
- It never calls the network. The check already ran in the client layer, so OWS's 5 s executable limit never
  matters.
- Every other request type is denied unless listed in `allow_request_types`. That includes `read_balance`,
  which OWS also gates; add it if you need balance reads.
- Make the file executable and put `node` on OWS's `PATH`. OWS starts the executable with no arguments.

**AgentKit.**
- AgentKit has no pre-sign hook; every EVM signature goes through `EvmWalletProvider`'s abstract methods.
- Pass AgentKit's own `EvmWalletProvider` class in, so its `instanceof` checks still hold (the x402 action
  provider uses one).
- `signTypedData` needs an approval. `sign`, `signMessage`, `signTransaction`, `sendTransaction` and
  `nativeTransfer` throw unless named in `allow`.
- AgentKit's base constructor sends its own initialization analytics event; the wrapper doesn't change that.
- `@coinbase/agentkit` isn't a dependency; the tests use a minimal stub of the abstract shape.

**Turnkey.**
- Turnkey's policy engine is declarative and runs on Turnkey's servers. It can't call out, so this is a
  client-side wrapper only.
- **Anything that calls the Turnkey API directly (another SDK client, a script, the dashboard) bypasses it.**
- Every other `sign*` method throws unless named in `allow`.
- Turnkey's co-signing consensus (`approveActivity`) exists but is out of scope here.

## Run

```
node --test tests/verify_before_sign_test.mjs
```
