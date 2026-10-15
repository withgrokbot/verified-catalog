// 0.37.0 response quality check (additive; never changes verdict or reason_code). No paid calls: everything here is read
// from the unpaid probe that already runs for every free, paid, router, exempt and dry-run check (the 402 challenge
// response). Only metadata is kept: status, content-type (media type only), size in bytes, schema declared, schema match.
// No bodies, headers or query strings are stored. One D1 insert per FRESH probe (a cached probe is the same observation).
export const QUALITY_KEEP = 30;
export const QUALITY_CODES = [
  { code: "quality_ok", score: 1, rule: "Reachable, answered HTTP 402 with a well-formed payment request (JSON body or PAYMENT-REQUIRED header), declares an output schema, and the response sample it publishes validates against that schema." },
  { code: "quality_unverified", score: 0.7, rule: "Reachable, HTTP 402 with a well-formed content type, but there is nothing to validate: no output schema declared, or a schema without a sample. Not a fault; we never pay the seller to capture a real response." },
  { code: "quality_bad_content_type", score: 0.4, rule: "HTTP 402 whose terms are only in the body, and the body is not JSON (content-type is not application/json or +json)." },
  { code: "quality_schema_mismatch", score: 0.3, rule: "The listing declares an output schema (bazaar extension or v1 outputSchema) and the sample it publishes does not validate against it." },
  { code: "quality_bad_status", score: 0.2, rule: "Reachable, but the response is not an HTTP 402 payment request (e.g. 200 without a paywall, 404, 5xx)." },
  { code: "quality_unreachable", score: 0, rule: "No response: timeout, DNS/TLS/network error, or an address we refuse to fetch." },
];
export const QUALITY_SCORE = Object.fromEntries(QUALITY_CODES.map((q) => [q.code, q.score]));

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
export const mediaType = (ct) => (ct ? String(ct).split(";")[0].trim().toLowerCase().slice(0, 80) : null);
export const jsonType = (mt) => !!mt && (mt === "application/json" || mt.endsWith("+json"));

function decodeHeader(v) {
  try {
    const bin = atob(String(v).trim());
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch (_) {
    return null;
  }
}

// Minimal JSON Schema subset: type (incl. integer/null and arrays of types), const, enum, required, properties,
// additionalProperties: false, items. Unknown keywords are ignored (lenient: only clear violations fail).
export function validateSchema(value, schema, depth = 0) {
  if (!isObj(schema) || depth > 24) return true;
  const typeOk = (t) => {
    if (t === "null") return value === null;
    if (t === "integer") return Number.isInteger(value);
    if (t === "number") return typeof value === "number" && Number.isFinite(value);
    if (t === "array") return Array.isArray(value);
    if (t === "object") return isObj(value);
    if (t === "string" || t === "boolean") return typeof value === t;
    return true;
  };
  if (schema.type != null && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(typeOk)) return false;
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return false;
  if (isObj(value)) {
    if (Array.isArray(schema.required) && schema.required.some((k) => !(k in value))) return false;
    const props = isObj(schema.properties) ? schema.properties : {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) { if (!validateSchema(v, props[k], depth + 1)) return false; }
      else if (schema.additionalProperties === false) return false;
      else if (isObj(schema.additionalProperties) && !validateSchema(v, schema.additionalProperties, depth + 1)) return false;
    }
  }
  if (Array.isArray(value) && isObj(schema.items)) for (const v of value.slice(0, 50)) if (!validateSchema(v, schema.items, depth + 1)) return false;
  return true;
}

// Where the listing declares its output: x402 v2 extensions.bazaar (info.output + schema), or v1 accepts[].outputSchema.
// Returns { declared, source, match } where match is true/false when a published sample could be validated, else null.
export function outputSchemaCheck(challenge) {
  const out = { declared: false, source: null, match: null };
  if (!isObj(challenge)) return out;
  const bz = isObj(challenge.extensions) && isObj(challenge.extensions.bazaar) ? challenge.extensions.bazaar : null;
  if (bz && (isObj(bz.info && bz.info.output) || isObj(bz.schema && bz.schema.properties && bz.schema.properties.output))) {
    out.declared = true;
    out.source = "bazaar";
    if (isObj(bz.info) && isObj(bz.schema)) out.match = validateSchema(bz.info, bz.schema);
    // a declared example checked against the declared output schema, when both are present
    const oSchema = bz.schema && bz.schema.properties && bz.schema.properties.output && bz.schema.properties.output.properties && bz.schema.properties.output.properties.example;
    if (out.match !== false && isObj(oSchema) && bz.info && bz.info.output && "example" in bz.info.output) out.match = validateSchema(bz.info.output.example, oSchema);
    return out;
  }
  for (const a of Array.isArray(challenge.accepts) ? challenge.accepts.slice(0, 8) : []) {
    const os = a && a.outputSchema;
    if (isObj(os) && isObj(os.output) && Object.keys(os.output).length) {
      out.declared = true;
      out.source = "outputSchema";
      if (isObj(os.output.schema) && "example" in os.output) out.match = validateSchema(os.output.example, os.output.schema);
      return out;
    }
  }
  return out;
}

// Called inside spotProbe on the final (non-redirect) response. Metadata only.
export function qualityMeta({ status, headers, bodyText, bytes }) {
  const get = (n) => (headers && typeof headers.get === "function" ? headers.get(n) : null);
  const hdr = get("payment-required");
  const ct = mediaType(get("content-type"));
  let challenge = hdr ? decodeHeader(hdr) : null;
  let body = null;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch (_) { body = null; }
  // the bazaar extension may ride in the body even when the terms are in the header
  const docs = [challenge, body].filter(isObj);
  let sc = { declared: false, source: null, match: null };
  for (const d of docs) { const r = outputSchemaCheck(d); if (r.declared) { sc = r; break; } }
  return {
    http_status: status ?? null,
    content_type: ct,
    body_bytes: Number.isFinite(bytes) ? bytes : bodyText ? new TextEncoder().encode(bodyText).length : 0,
    challenge_in_header: !!(challenge && isObj(challenge)),
    schema_declared: sc.declared,
    schema_source: sc.source,
    schema_match: sc.match,
  };
}

// probe -> the additive `quality` object (paid/router/exempt: full; free/dry-run: code only, see qualityPublic).
export function qualityFor(probe) {
  const m = (probe && probe.quality_meta) || {};
  const reachable = !!(probe && probe.reachable && !probe.ssrf_blocked);
  const status = probe && probe.http_status != null ? Number(probe.http_status) : null;
  const challengeOk = reachable && status === 402 && !!(probe && probe.x402_challenge);
  const ct = m.content_type ?? null;
  const ctOk = challengeOk ? (m.challenge_in_header === true || jsonType(ct)) : null;
  let code;
  if (!reachable) code = "quality_unreachable";
  else if (!challengeOk) code = "quality_bad_status";
  else if (!ctOk) code = probe.quality_meta ? "quality_bad_content_type" : "quality_unverified"; // pre-0.37 cached probe: no metadata
  else if (m.schema_declared && m.schema_match === false) code = "quality_schema_mismatch";
  else if (m.schema_declared && m.schema_match === true) code = "quality_ok";
  else code = "quality_unverified";
  return {
    code,
    checks: {
      reachable,
      http_status: status,
      status_is_402: reachable ? status === 402 : null,
      content_type: ct,
      content_type_ok: ctOk,
      body_bytes: m.body_bytes ?? null,
      schema_declared: m.schema_declared ?? null,
      schema_source: m.schema_source ?? null,
      schema_match: m.schema_match ?? null,
    },
    note: "metadata of the unpaid 402 response only; never pays the seller, stores no body; does not change verdict or reason_code",
    rules: "https://402xagent.com/rules.json",
  };
}
export const qualityPublic = (q) => (q ? { code: q.code, rules: q.rules } : null);

// One insert (+ a bounded prune) per fresh probe, D1 only. Never throws; a missing table (migration 0007 not applied)
// just means no quality history.
export async function recordQuality(env, hkey, host, q, observedAt, fresh) {
  const db = env && env.RECEIPTS_DB;
  if (!db || !hkey || !q || !fresh) return false;
  try {
    const c = q.checks;
    await db.prepare("INSERT INTO endpoint_quality (hkey, host, observed_at, http_status, content_type, body_bytes, schema_declared, schema_match, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(hkey, String(host || "").toLowerCase().slice(0, 253), observedAt, c.http_status, c.content_type, c.body_bytes, c.schema_declared == null ? null : c.schema_declared ? 1 : 0, c.schema_match == null ? null : c.schema_match ? 1 : 0, q.code).run();
    await db.prepare("DELETE FROM endpoint_quality WHERE hkey = ? AND observed_at NOT IN (SELECT observed_at FROM endpoint_quality WHERE hkey = ? ORDER BY observed_at DESC LIMIT ?)").bind(hkey, hkey, QUALITY_KEEP).run();
    return true;
  } catch (_) {
    return false;
  }
}
