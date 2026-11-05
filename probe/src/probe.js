// Look up MX, then at most one port-25 session. Limits apply per MX host and per UTC day.
import { randomBytes } from "node:crypto";
import { chooseMx, smtpDialogue, splitSafeEmail, EHLO_HOST, MAIL_FROM } from "./smtp.js";

export function randomLocal() {
  return "no-such-" + randomBytes(12).toString("hex");
}

export async function probeEmail(email, deps) {
  const parts = splitSafeEmail(email);
  if (!parts) return { smtp: "unknown", code: null, catch_all: "unknown", mx: null, reason: "bad_email" };
  const chosen = await chooseMx(parts.domain, deps.dns);
  if (chosen.reason) return { smtp: "unknown", code: null, catch_all: "unknown", mx: chosen.mx || null, reason: chosen.reason };
  const slot = deps.limiter.tryAcquire(chosen.mx);
  if (!slot.ok) return { smtp: "unknown", code: null, catch_all: "unknown", mx: chosen.mx, reason: slot.reason };
  let session = null;
  try {
    session = await deps.connect(chosen.ip, 25, deps.timeoutMs || 10_000);
    const result = await smtpDialogue(parts, session, {
      ehlo: deps.ehlo || EHLO_HOST,
      mailFrom: deps.mailFrom || MAIL_FROM,
      randomLocal: deps.randomLocal || randomLocal,
    });
    if (result.reason === "greylist") deps.limiter.note4xx(chosen.mx);
    else deps.limiter.noteClear(chosen.mx);
    return {
      smtp: result.smtp, code: result.code, catch_all: result.catch_all, mx: chosen.mx, reason: result.reason, transcript: result.transcript,
    };
  } catch (e) {
    const reason = e && e.message === "timeout" ? "timeout" : "connect_failed";
    return { smtp: "unknown", code: null, catch_all: "unknown", mx: chosen.mx, reason };
  } finally {
    slot.release();
    if (session) { try { session.close(); } catch (_) { /* already closed */ } }
  }
}
