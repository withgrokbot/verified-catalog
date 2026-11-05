// One SMTP session: EHLO, MAIL FROM, RCPT TO, and a second RCPT for catch-all. Then QUIT.
// The command list is fixed. A message body is never sent.
import { isIP } from "node:net";
import { isPublicIp } from "./public-ip.js";

export const EHLO_HOST = "probe.402xagent.com";
export const MAIL_FROM = "probe@402xagent.com";

const PROVIDER = [
  /(^|\.)gmail\.com$/,
  /(^|\.)google\.com$/,
  /(^|\.)googlemail\.com$/,
  /(^|\.)protection\.outlook\.com$/,
  /(^|\.)outlook\.com$/,
  /(^|\.)hotmail\.com$/,
  /(^|\.)live\.com$/,
  /(^|\.)yahoodns\.net$/,
  /(^|\.)yahoo\.com$/,
  /(^|\.)yahoo\.co\.uk$/,
];

export function isProviderMx(host) {
  const h = String(host || "").replace(/\.$/, "").toLowerCase();
  return PROVIDER.some((re) => re.test(h));
}

export function splitSafeEmail(email) {
  if (typeof email !== "string" || email.length > 254 || /[\r\n\0]/.test(email)) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@")) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).replace(/\.$/, "").toLowerCase();
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/.test(local)) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!/^[a-z0-9.-]{1,253}$/.test(domain) || !domain.includes(".") || domain.includes("..")) return null;
  if (domain.startsWith(".") || domain.endsWith(".")) return null;
  if (domain.split(".").some((l) => !l || l.length > 63 || l.startsWith("-") || l.endsWith("-"))) return null;
  return { local, domain };
}

function codeOf(lines) {
  const last = (Array.isArray(lines) ? lines[lines.length - 1] : lines) || "";
  const m = /^(\d{3}) /.exec(String(last));
  return m ? Number(m[1]) : 0;
}

export async function smtpDialogue(parts, session, deps) {
  const sent = [];
  const send = async (line) => {
    if (/[\r\n]/.test(line)) throw new Error("bad_command");
    sent.push(line);
    await session.write(line + "\r\n");
  };
  const finish = async (partial) => {
    try { await send("QUIT"); } catch (_) { /* the peer may already have closed */ }
    return { transcript: sent, ...partial };
  };
  const banner = codeOf(await session.readReply());
  if (banner !== 220) return finish({ smtp: "unknown", code: banner || null, catch_all: "unknown", reason: "bad_banner" });
  await send("EHLO " + (deps.ehlo || EHLO_HOST));
  const ehlo = codeOf(await session.readReply());
  if (ehlo !== 250) return finish({ smtp: "unknown", code: ehlo || null, catch_all: "unknown", reason: ehlo >= 400 && ehlo < 500 ? "greylist" : "ehlo_rejected" });
  await send("MAIL FROM:<" + (deps.mailFrom || MAIL_FROM) + ">");
  const from = codeOf(await session.readReply());
  if (from !== 250) {
    const greylist = from >= 400 && from < 500;
    return finish({ smtp: "unknown", code: from || null, catch_all: "unknown", reason: greylist ? "greylist" : "sender_rejected" });
  }
  await send("RCPT TO:<" + parts.local + "@" + parts.domain + ">");
  const rcpt = codeOf(await session.readReply());
  if (rcpt >= 400 && rcpt < 500) return finish({ smtp: "unknown", code: rcpt, catch_all: "unknown", reason: "greylist" });
  if (rcpt >= 500 && rcpt <= 599) return finish({ smtp: "fail", code: rcpt, catch_all: "no", reason: "rcpt_reject" });
  if (rcpt !== 250) return finish({ smtp: "unknown", code: rcpt || null, catch_all: "unknown", reason: "unexpected_code" });
  const rand = String(deps.randomLocal ? deps.randomLocal() : "");
  if (!/^[a-z0-9-]{8,64}$/.test(rand)) throw new Error("bad_random");
  await send("RCPT TO:<" + rand + "@" + parts.domain + ">");
  const rc2 = codeOf(await session.readReply());
  if (rc2 === 250) return finish({ smtp: "unknown", code: 250, catch_all: true, reason: "catch_all" });
  if (rc2 >= 500 && rc2 <= 599) return finish({ smtp: "pass", code: 250, catch_all: false, reason: "rcpt_accepted" });
  if (rc2 >= 400 && rc2 < 500) return finish({ smtp: "unknown", code: 250, catch_all: "unknown", reason: "greylist" });
  return finish({ smtp: "unknown", code: 250, catch_all: "unknown", reason: "catch_all_unknown" });
}

function badHost(host) {
  return host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal");
}

/** Lowest-preference MX, or a reason and no socket. Provider MX is returned before any connection. */
export async function chooseMx(domain, dns) {
  let records;
  try { records = await dns.resolveMx(domain); }
  catch (e) {
    const code = e && e.code;
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "ENOTIMP") return { reason: "no_mx" };
    return { reason: "dns_error" };
  }
  if (!Array.isArray(records) || !records.length) return { reason: "no_mx" };
  const cleaned = records.map((r) => ({
    pref: Number(r.priority) || 0,
    exchange: String((r && r.exchange) || "").replace(/\.$/, "").toLowerCase(),
  }));
  if (cleaned.some((r) => r.exchange === "" || r.exchange === ".")) return { reason: "null_mx" };
  cleaned.sort((a, b) => a.pref - b.pref);
  const host = cleaned[0].exchange;
  if (badHost(host)) return { reason: "non_public_mx", mx: host };
  if (isProviderMx(host)) return { reason: "provider_skip", mx: host };
  if (isIP(host)) {
    if (!isPublicIp(host)) return { reason: "non_public_mx", mx: host };
    return { mx: host, ip: host };
  }
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..") || !host.includes(".")) return { reason: "bad_mx", mx: host };
  let v4 = [];
  let v6 = [];
  try { v4 = await dns.resolve4(host); } catch (_) { v4 = []; }
  try { v6 = await dns.resolve6(host); } catch (_) { v6 = []; }
  const pub = [...v4, ...v6].map(String).filter(isPublicIp);
  if (!pub.length) return { reason: "non_public_mx", mx: host };
  return { mx: host, ip: pub[0] };
}
