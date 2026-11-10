# Email validation (0.68.1) — unreleased

0.68.0 added the checks below with SMTP left off. 0.68.1 maps a probe result when `EMAIL_SMTP_URL` and `EMAIL_SMTP_SECRET` are both set, adds the scale price id, and gives email subscriptions the same failed-payment grace as render. The flag is still unset.

Not priced and not launched. The routes answer only when `EMAIL=1`. That flag is unset in `worker/wrangler.toml`, so production keeps returning 404. OpenAPI and `llms.txt` list the routes only while the flag is on, and they are marked unreleased.

## Routes

Same API keys as the render API (`x-api-key` or `Authorization: Bearer rk_...`). Email plan and quota are `email_plan` and `email_monthly_quota`. Usage is one `api_key_usage` row per key per UTC month with `kind = 'email'`; the counter is the `emails` column and `renders` on that row stays 0. Render quota is the sum of `renders` for `pdf`, `shot` and `card` only. The email quota is a hard cap.

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

`deliverable` is returned only when `checks.smtp` is `pass` and `checks.catch_all` is `no`. That is a non-catch-all 250 RCPT from the probe. With the probe unset, `checks.smtp` stays `not_checked` and the status is never `deliverable`. The best status without SMTP is `risky` (disposable, role, or MX missing but an A record exists) or `unknown` (MX exists, nothing else wrong). `undeliverable` is used when the address fails RFC 5322 syntax, the domain has no MX and no A record (including a null MX), or the probe reports a 5xx on RCPT. A 4xx, a catch-all, or a skipped provider stays `unknown` or `risky`, not `deliverable`.

## Checks

- Syntax: RFC 5322 addr-spec (dot-atom or quoted local part) and IDNA for the domain. DNS uses the ASCII form.
- MX: DNS-over-HTTPS (`cloudflare-dns.com`). If there is no MX, an A record counts as a fallback (`checks.mx = "a_fallback"`).
- Disposable domains: the bundled list in `worker/src/disposable-domains.js`, plus rows refreshed weekly from `disposable-email-domains/disposable-email-domains` (`disposable_email_blocklist.conf`). Cron `23 6 * * 1` (Monday 06:23 UTC) runs the refresh only when `EMAIL=1`.
- Role addresses: `admin`, `info`, `support` and the other locals in `ROLE_LOCALS` (the part before `+`).
- Typo suggestions: one edit, or a unique two-edit, against a list of popular domains (`gmial.com` suggests `gmail.com`).
- Catch-all: `not_checked` until the probe runs. A random second RCPT that is also accepted is `yes`. Domain rows are cached for 24 hours (MX and catch-all).

## SMTP probe

`EMAIL_SMTP_URL` (https) and `EMAIL_SMTP_SECRET` configure the probe in `probe/`. Both are unset, so the probe is off and the worker does not call it. When both are set, the worker POSTs `{"v":1,"ts":<unix>,"email":"<ascii address>"}` with header `x-email-probe-signature: v1=<hmac-sha256 hex of the raw body>`. The probe checks the signature, the timestamp (300 seconds), and rejects a replay.

The probe looks up MX and, unless the MX is Gmail, Outlook, or Yahoo, connects on port 25. It sends EHLO, MAIL FROM, RCPT TO, and QUIT. It never sends a message body. A 4xx is `unknown`. Gmail, Outlook, and Yahoo return `unknown` without a connection. `deliverable` requires code 250 and `catch_all: false`.

The probe host is retired. No host is deployed, and `docs/probe-dns.md` has no IP. Turning the probe on needs a provider with outbound port 25 open. The service is not installed by this repo.

## Billing

The free tier is `email_plan = free`, 1,000 validations a UTC month, and it has no Stripe price id.

`STRIPE_PRICE_EMAIL_STARTER`, `STRIPE_PRICE_EMAIL_PRO`, and `STRIPE_PRICE_EMAIL_SCALE` are blank. When a price id is set later, the Stripe webhook maps it onto `email_plan` / `email_monthly_quota` and does not change the render plan. Quotas: free 1,000, starter 10,000, pro 50,000, scale 200,000 per UTC month. No price is charged.

`invoice.payment_failed` on an email subscription keeps the paid email plan until `email_grace_ends_at` (the event time plus `BILLING_GRACE_DAYS`, default 3). A later successful payment or an active subscription update clears it. The next validation after the grace ends returns the key to the free tier. Render grace stays on `grace_ends_at`.

A missing, blank, or whitespace-only `STRIPE_PRICE_EMAIL_*` value is not a price id. It never equals a subscription price, never grants an email plan, and never selects the render starter or pro plan. Usage is `api_key_usage` kind `email` (the `emails` column; `renders` stays 0), outside the pdf + shot + card sum.

## Migration

`worker/migrations/0030_email.sql` adds the email plan and quota columns, rebuilds `api_key_usage` so `kind` may be `email`, and adds `email_domain_cache` and `email_disposable_domains`. `worker/migrations/0031_email_grace.sql` adds `email_stripe_subscription_id` and `email_grace_ends_at`. No raw address is stored.
