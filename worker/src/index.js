// Worker entry point. The Workers runtime treats every named export of this module as an entrypoint, so all the
// logic (and the named exports the tests use) lives in lib.js and only the fetch handler is exported here.
import { handler } from "./lib.js";

export default handler;
