# Email validation v1 (0.68.0) — unreleased

Not priced and not launched. The routes answer only when `EMAIL=1`. That flag is unset in `worker/wrangler.toml`, so production keeps returning 404. OpenAPI and `llms.txt` list the routes only while the flag is on, and they are marked unreleased.

## Routes

Same API keys as the render API (`x-api-key` or `Authorization: Bearer rk_...`). Email plan, quota and usage are separate from render quota (`email_plan`, `email_monthly_quota`, `api_key_usage.emails`). The quota is a hard cap.

- `POST /v1/email/validate` with `{"email":"user@example.com"}`
- `POST /v1/email/batch` with `{"emails":[...]}` (1 to 100 addresses)

Each address costs one unit. A batch that does not fit in the remaining quota is rejected whole.

## Result

```json
{
  "email": "user@gmial.com",
  "status": "unknown",
  "confidence": 0.4,
  "reasons": ["smtp_not_checked"],
  "checks": {
    "syntax": "valid",
    "mx": "present",
    "disposable": false,
    "role": false,
    "catch_all": "not_checked",
    "smtp": "not_checked"
  },
  "suggestion": "user@gmail.com"
}
```

`status` is `deliverable`, `undeliverable`, `risky` or `unknown`. `confidence` is from 0 to 1.

`deliverable` is returned only when `checks.smtp` is `pass`. This version does not open an SMTP session, so `checks.smtp` is always `not_checked` and the status is never `deliverable`. The best status without SMTP is `risky` (disposable, role, or MX missing but an A record exists) or `unknown` (MX exists, nothing else wrong). `undeliverable` is used when the address fails RFC 5322 syntax or the domain has no MX and no A record (including a null MX).

## Checks

- Syntax: RFC 5322 addr-spec (dot-atom or quoted local part) and IDNA for the domain. DNS uses the ASCII form.
- MX: DNS-over-HTTPS (`cloudflare-dns.com`). If there is no MX, an A record counts as a fallback (`checks.mx = "a_fallback"`).
- Disposable domains: the bundled list in `worker/src/disposable-domains.js`, plus rows refreshed weekly from `disposable-email-domains/disposable-email-domains` (`disposable_email_blocklist.conf`). Cron `23 6 * * 1` (Monday 06:23 UTC) runs the refresh only when `EMAIL=1`.
- Role addresses: `admin`, `info`, `support` and the other locals in `ROLE_LOCALS` (the part before `+`).
- Typo suggestions: one edit, or a unique two-edit, against a list of popular domains (`gmial.com` suggests `gmail.com`).
- Catch-all: not known without SMTP. `checks.catch_all` is `not_checked`. Domain rows are cached for 24 hours (MX and catch-all).

## SMTP later

`EMAIL_SMTP_URL` (https) and `EMAIL_SMTP_SECRET` configure an external probe host. Both are unset, so the probe is off. `buildSmtpProbeRequest` builds a POST whose body is signed `v1=` HMAC-SHA256 with the secret. v1 does not send that request.

## Billing

`STRIPE_PRICE_EMAIL_STARTER` and `STRIPE_PRICE_EMAIL_PRO` are blank. When a price id is set later, the Stripe webhook maps it onto `email_plan` / `email_monthly_quota` and does not change the render plan. Quotas until then: free 100, starter 5,000, pro 25,000 per UTC month. No price is charged.

## Migration

`worker/migrations/0030_email.sql` adds the email plan and quota columns, the `emails` usage column, `email_domain_cache` and `email_disposable_domains`. No raw address is stored.
