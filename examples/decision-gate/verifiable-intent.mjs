// Verifiable Intent custom constraint "com.402xagent.counterparty_check" (agent-intent/verifiable-intent,
// spec/constraints.md 0.1-draft, sec. 3.1 and 6.1 Model B: a JSON object with a `type`, reverse-DNS name for an
// organisation-specific type; verifiers in permissive mode skip types they do not know).
// Meaning (our definition, not a registered type): before the agent pays a counterparty, a 402xAgent check
// of that endpoint must have returned one of `allowed_verdicts` no longer than `max_age_s` ago.
export const VI_TYPE = "com.402xagent.counterparty_check";

export function counterpartyConstraint({ allowedVerdicts = ["pay"], maxAgeS = 300 } = {}) {
  return { type: VI_TYPE, allowed_verdicts: allowedVerdicts, max_age_s: maxAgeS, service: "https://api.402xagent.com" };
}

/** Checks a decide(...).check against the constraint. Returns { ok, reason }. */
export function satisfies(constraint, check, now = new Date()) {
  if (!constraint || constraint.type !== VI_TYPE) return { ok: false, reason: "not a " + VI_TYPE + " constraint" };
  if (!check || !constraint.allowed_verdicts.includes(check.verdict)) return { ok: false, reason: "verdict " + (check && check.verdict) + " not allowed" };
  const age = (now.getTime() - Date.parse(check.checked_at)) / 1000;
  if (!(age >= 0 && age <= constraint.max_age_s)) return { ok: false, reason: "check too old or undated" };
  return { ok: true, reason: "" };
}
