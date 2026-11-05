// HTTPS is terminated by Caddy. This process binds 127.0.0.1 and checks the signed body.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { promises as dns } from "node:dns";
import { connectSmtp } from "./net.js";
import { createLimiter, readDailyCap } from "./limit.js";
import { dailyFileStore } from "./state.js";
import { createReplayCache, verifySignedBody, MIN_SECRET } from "./sign.js";
import { probeEmail } from "./probe.js";
import { EHLO_HOST, MAIL_FROM } from "./smtp.js";

const MAX_BODY = 4096;

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(Object.assign(new Error("too_large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function depsFromEnv(env, extras = {}) {
  const secret = String((env && env.PROBE_SECRET) || "");
  const dir = env && env.PROBE_STATE_DIR;
  const store = dir ? dailyFileStore(dir) : null;
  const base = {
    secret,
    now: () => new Date(),
    replay: createReplayCache(),
    limiter: createLimiter({
      dailyCap: readDailyCap(env),
      perMinute: 4,
      maxConcurrent: 2,
      loadDaily: store ? () => store.load() : undefined,
      saveDaily: store ? (d) => store.save(d) : undefined,
    }),
    dns,
    connect: connectSmtp,
    ehlo: EHLO_HOST,
    mailFrom: MAIL_FROM,
    timeoutMs: 10_000,
  };
  return { ...base, ...extras, secret };
}

/** Web Request in, Web Response out. Auth failures never open a socket. */
export async function handleProbe(request, deps) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  if (request.method !== "POST") return Response.json({ error: "use POST" }, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
  if (!deps.secret || deps.secret.length < MIN_SECRET) return Response.json({ error: "not configured" }, { status: 503 });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return Response.json({ error: "too large" }, { status: 413 });
  const now = deps.now();
  const verdict = verifySignedBody(deps.secret, raw, request.headers.get("x-email-probe-signature"), now.getTime(), deps.replay);
  if (!verdict.ok) return Response.json({ error: "rejected", reason: verdict.reason }, { status: verdict.status, headers: { "cache-control": "no-store" } });
  const result = await probeEmail(verdict.email, deps);
  const { transcript, ...pub } = result;
  return Response.json({ v: 1, email: pub.reason === "bad_email" ? undefined : verdict.email, ...pub }, { headers: { "cache-control": "no-store" } });
}

export function startServer(env, extras = {}) {
  const deps = depsFromEnv(env, extras);
  if (!deps.secret || deps.secret.length < MIN_SECRET) throw new Error("PROBE_SECRET is required");
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host || "127.0.0.1";
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readRaw(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const request = new Request("http://" + host + req.url, { method: req.method, headers, body });
      const out = await handleProbe(request, deps);
      const buf = Buffer.from(await out.arrayBuffer());
      const h = { "cache-control": "no-store" };
      out.headers.forEach((v, k) => { h[k] = v; });
      res.writeHead(out.status, h);
      res.end(buf);
      if (req.url !== "/healthz") console.log(JSON.stringify({ t: new Date().toISOString(), status: out.status }));
    } catch (e) {
      const status = e && e.status === 413 ? 413 : 400;
      json(res, status, { error: status === 413 ? "too large" : "bad request" });
    }
  });
  const port = env.PROBE_PORT == null || env.PROBE_PORT === "" ? 8787 : Number(env.PROBE_PORT);
  const bind = env.PROBE_BIND || "127.0.0.1";
  server.listen(port, bind);
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer(process.env);
