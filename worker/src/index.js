// Worker entry point. The Workers runtime treats every named export of this module as an entrypoint, so all the
// logic (and the named exports the tests use) lives in lib.js; only the fetch handler and the Durable Object class
// (the free-quota counter, which the runtime must see as a named export) are exported here.
import { handler, QuotaCounter } from "./lib.js";

export { QuotaCounter };
export default handler;
