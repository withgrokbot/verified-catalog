# 402xagent-check

Check any x402 endpoint before your agent pays. One call to the free [402xAgent](https://402xagent.com) check returns a verdict: **pay**, **skip** or **recheck**, with the reason. Nothing is signed or paid. No dependencies.

## Install

```sh
npm install 402xagent-check
# or run it once:
npx 402xagent-check https://api.402rates.com/v1/ping
```

## Example

```js
import { check } from "402xagent-check";

const r = await check("https://api.402rates.com/v1/ping");
if (r.verdict !== "pay") console.log("don't pay:", r.reason);
```

The CLI prints `PAY|SKIP|RECHECK: reason` (or the full JSON with `--json`) and exits 0 for pay, 1 for skip, 2 for recheck, 3 on error.

## Free quota

5 free checks a day per client (reset at 00:00 UTC). After that the endpoint answers HTTP 402 and a check costs $0.02 over x402; `check()` rejects with a `CheckError` (`status` 402). A bad URL rejects with status 400.

Docs: https://402xagent.com/docs
