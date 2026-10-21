# Plan: Watchtower (approved by Max 2026-10-21; built in 0.47.0 on release-0.47.0, flag WATCHTOWER off)
Spec (via Max): watch one x402 endpoint for $1/month, prepaid via x402. API only, hourly re-probe, signed webhooks for drift, down and recovery. **Supersedes** the 2026-10-20 seller-monitoring proposal (Free email watch, Starter $5/mo, x402 $0.02/endpoint-day). No separate scope doc for that proposal was found in /workspace. From it we keep the change delta (price, payTo, network, capability), dedup and thresholds, and webhook verification. We drop email, tiers and per-day billing.

## 1. API (flag `WATCHTOWER`, off by default; docs use concrete example values, never `{id}`)
- `POST /v1/watch` `{url, method?, webhook_url}`:
  - If the trial applies: 201, no payment. Otherwise: 402, $1 (1,000,000 atomic, active preset; Base mainnet by default).
  - The request first checks the endpoint and webhook URLs are safe to fetch (§4), then probes the endpoint once (this becomes the baseline). It then sends a synchronous signed `watch.verify` event to the webhook and needs a 2xx within 5 s.
  - If any step fails: 400, nothing is charged, nothing is stored.
  - Returns `{watch_id: "wt-0123456789abcdef", watch_secret (shown once), status, trial, paid_until, baseline {terms_sha256, x402_version, schemes, http_status}, receipt_id}`.
  - The same (url, webhook_url) pair returns the existing watch's id, never its secret.
- `POST /v1/watch/wt-…/renew`: x402 $1 adds 30 days to max(now, paid_until). No auth (anyone may pay). A paused watch resumes and is probed at once.
- `GET /v1/watch/wt-…` with `Authorization: Bearer wts_<secret>`: status (active, paused, deleted), paid_until, baseline, state (up or down), last_probe_at, last_event, webhook health, `probes_total`, `probes_this_period`.
- `DELETE /v1/watch/wt-…` (Bearer): soft delete; the row is purged after 30 days.
- No accounts: the secret is stored only as sha256(pepper ":" secret), the same pattern as hosted keys. A lost secret leaves the watch running until it expires.
- Out of scope: email, a dashboard, custom cadences, changing the webhook URL, quota changes. The 5/day free check is untouched.
- On expiry the watch pauses (status paused, no probes). It is not deleted and resumes on renew. If the terms changed while it was paused, the first probe after renew fires `drift` with `changed_while_paused: true`.

## 2. Trial and privacy (0.45.6 rules)
- A 7-day trial applies to the first watch of a **webhook registrable domain** (eTLD+1). The webhook domain is the buyer's identity; no wallet is involved.
  - Stored: `trial_claims(key_hash = HMAC(pepper, "trial|" + domain))`.
  - Also capped: one trial per endpoint URL hash per 90 days, and 3 trials per IP-prefix hash per day.
- No payer wallet, tx hash or payment payload is stored or returned. A paid create or renew writes a `wr-` receipt with `payment_received` scrubbed by `privacy.js`. Only `paid_until` is kept.

## 3. D1 schema (migration 0013)
- `watches`:
  - id PK, secret_hash, url (no query), method, hkey, webhook_url, webhook_domain_hash
  - status, trial, created_at, paid_until
  - slot (0..2), next_probe_at
  - baseline_json, baseline_sig, baseline_at
  - state, fail_streak, ok_streak, pending_sig, pending_count
  - last_probe_at, last_event_id
  - probes_total, probes_period, events_total, deliveries_failed
  - Index: (status, next_probe_at).
- `watch_events`: id `evt-<16 hex>` PK, watch_id, type, created_at, payload, receipt_id.
- `watch_deliveries`: event_id, attempt, next_attempt_at, status, http_status. Index: (status, next_attempt_at).
- `watch_usage`: (watch_id, day) PK, probes, events, deliveries. A daily rollup from the counters, kept for re-pricing.
- `trial_claims`: key_hash PK, claimed_at.

## 4. Cron and cost (Workers Paid)
- **Fan-out:** reuse the existing `*/20` cron. Each watch has `slot = hash(id) % 3`, so every tick probes one third of the watches and each watch is probed once an hour (±20 min).
  - The tick selects `status='active' AND next_probe_at <= now` LIMIT `WATCH_BATCH` (default 150), and runs probes 6 at a time with `Promise.allSettled`.
- **Subrequests:** each probe uses about 3–4 (DoH A/AAAA plus the probe, plus a POST fallback sometimes). A webhook delivery uses about 3. 150 watches ≈ 600, under the per-invocation limit (1,000 default on Paid; verify the current limit).
  - Past about 450 watches, add a Cloudflare Queue: the cron enqueues batches of 50 and a consumer probes them. Until then, `WATCH_MAX` (500) caps creation.
- **CPU:** about 5–10 ms per probe, which is well within `cpu_ms = 5000` per tick.
- **D1:** one batched read per tick and one `UPDATE` per probe (state, streaks, counters, next_probe_at). Event, delivery, history and receipt writes happen only on events. The daily rollup writes one row per watch.
- **Cost per watch per month (modeled):**
  - 720 probes ≈ 720 D1 writes plus about 30 rollup writes. That is under $0.001 above the included 50M writes ($1/M after).
  - About 7 CPU-seconds ≈ $0.0002. Subrequests are free.
  - **Total under $0.01 of the $1.** The real costs are support and abuse, not compute.
- **Probes:** each run uses the existing SSRF-safe probe as client `watchtower` (self-checked: not counted as an outside check, not listed in recent_checks). It writes `endpoint_history` and `endpoint_quality`, which also feed the free teasers. A `sc-` receipt is written only on events.

## 5. Event semantics
- **Baseline:** terms signature (network, asset, payTo, amount_atomic, the same `sig` as history.js), x402_version, scheme set, http status class.
- **drift** fires only on a material change:
  - payTo changed;
  - network or asset changed;
  - price changed by more than 1% (the saves rule);
  - capability changed (x402 version, scheme set, or a paywall gained or lost).
  - Ignored: latency, validBefore, maxTimeoutSeconds, headers, bodies.
  - It must be seen on **2 consecutive probes** (`pending_sig` plus `pending_count`). It then fires once with `changes: [{field, from, to}]` and becomes the new baseline. That is the dedupe: one event per distinct new signature.
- **down:** 2 consecutive failures (unreachable, timeout, 5xx, or no 402 where the baseline had one). **recovery:** 2 consecutive healthy probes after down.
- **Flapping:** more than 2 down/recovery pairs in 6 h fires one `flapping` event, then stays quiet until the watch has been stable for 6 h.
- **Reuse:**
  - Every event writes a normal `sc-` live receipt whose `receipt_v2.supersedes` chains to the previous one for that endpoint. The event carries `receipt_id` and permalink.
  - drift also carries a `commitment_ref` plus digests (the 0.46.0 commitments) for the before snapshot.

## 6. Webhook delivery
- **Signing (recommendation: Ed25519 with the existing receipt keys, no HMAC):**
  - Receivers verify with `/.well-known/402xagent-keys.json` (the same verifier as receipts, and x402-spotcheck can do it). There is no per-watch secret to store, leak or rotate, and the key rotation rules already exist.
  - Signed bytes are `timestamp + "." + body`. Headers: `X-402x-Signature` (base64url), `X-402x-Kid`, `X-402x-Timestamp`, `X-402x-Event-Id`.
  - Receivers reject deliveries with a timestamp skew over 5 minutes.
  - Downside: anyone can verify, but only we can sign, which is all that's needed.
- **Idempotency:** `event_id` stays the same across retries, and the body includes `{event_id, watch_id, type, occurred_at, endpoint, changes|state, receipt_id}`. The body is ≤ 4 KB and has no secrets or buyer data.
- **Retries:** after a non-2xx, timeout or network error, retry at 1 m, 5 m, 30 m, 2 h and 6 h (5 attempts) from `watch_deliveries` on each cron tick, with a 5 s timeout. After the last attempt the delivery is failed and `deliveries_failed++`. After 10 consecutive failures `webhook_failing: true` shows on GET, but the watch keeps probing.
- **SSRF:**
  - https only, port 443 only, no credentials in the URL, no redirects followed.
  - `assertSafeUrl` runs at create **and before every delivery** (against DNS rebinding).
  - The webhook can't be our own hosts. The response body is ignored (we read at most 1 KB).

## 7. Abuse limits
- `WATCH_MAX` 500 overall (until Queues are added).
- At most 20 active watches per webhook domain and 10 creates per IP-prefix per day.
- The same endpoint can be watched by many buyers, but each probe is shared through the 5-minute probe cache, so 100 watches on one URL means one probe per tick.
- Webhook verify plus a paid renew is the anti-spam gate.

## 8. Tests
1. Create:
   - trial eligibility (first webhook domain, second refused with 402);
   - unsafe URLs give 400 and nothing stored or charged;
   - the verify event must return 2xx;
   - the same pair returns the existing id without the secret;
   - the secret is returned once and only its hash is stored.
2. Renew extends from max(now, paid_until); a paused watch resumes; $1 accepts under the default and Sepolia presets.
3. GET and DELETE require the Bearer token (401 without); probe counters increment.
4. Cron: slots spread watches across ticks; each active watch is probed exactly once per hour; the batch cap holds; subrequests per tick stay within budget; paused or expired watches are not probed.
5. Drift: a material change fires once after 2 probes and becomes the new baseline. Non-material changes fire nothing. A change while paused is flagged.
6. Down/recovery need 2 consecutive probes; flapping gives one event.
7. Webhook:
   - the Ed25519 signature verifies against the keys doc, and a tampered body or timestamp fails;
   - retries follow the schedule with the same event_id;
   - a DNS-rebind to a private IP at delivery time is blocked;
   - redirects are not followed.
8. Privacy sweep: no payer, tx or IP in any watch response, event, `wr-` receipt or GET. Trial keys are HMAC'd.
9. Listings: OpenAPI, `.well-known`, llms.txt and MCP when on; no bare templates.

## 9. Rollout
- 0.47.0 behind `WATCHTOWER=off`.
- First a local `wrangler dev` with `PAYMENT_PRESET=base-sepolia`: a real $1 test-USDC create and renew, with webhooks to a local receiver. Then a mainnet self-test watch on our own endpoint for 48 h. Then the flag goes on.
- Migration 0013 is applied first. Nothing deploys without approval.

## 10. Decisions (Max, 2026-10-21)
- (a) Trial key = webhook registrable domain (eTLD+1), EXCEPT shared relay hosts, which key on full host + path (query dropped): webhook.site, hooks.slack.com, discord.com / discordapp.com, hooks.zapier.com, pipedream.net / m.pipedream.net, n8n cloud (*.app.n8n.cloud), ngrok (*.ngrok.io, *.ngrok-free.app, *.ngrok.app), requestbin, hookdeck, make.com hooks and similar (list: `RELAY_HOSTS` in worker/src/watch.js).
- (b) Cron tick now (rides `*/20`, `WATCH_BATCH` 100 per tick, 6 concurrent, one shared probe per URL per tick). Move to Cloudflare Queues at **300 active** watches of `WATCH_MAX` (500): the tick logs `{"watchtower":"move_to_queues"}` and `/v1/watch/stats` shows `queues.move_to_queues`.
- (c) A new wallet never resets the trial (wallets are never stored; the trial key is the webhook domain).
- (d) Our own routes are watchable as endpoints (the webhook still cannot be a 402xAgent host).
- (e) Auto-pause after 3 consecutive UTC days on which every delivery failed (a day with any 2xx resets; days without deliveries are neutral). A signed `paused` event (reason `webhook_failing`) is written. A 2xx `POST /v1/watch/wt-…/verify` (Bearer) or a renew resumes (`resumed` event).
- (f) Pricing review at 60 days after the first paid watch or at 50 paid watches, whichever first, from `watch_usage`. Internal stat: `GET /v1/watch/stats` with `Authorization: Bearer $WATCH_STATS_TOKEN` (404 when the secret is unset) reports `pricing_review.due`.

## 11. As built (0.47.0) — differences from the plan above
- Events are signed (Ed25519, JCS) and stored in `watch_events`; each carries `supersedes` = the previous event id of the watch (the first drift supersedes the create `watch.verify`). Events do not write `sc-` receipts or commitments yet, and the watch probe does not write `endpoint_history` (keeps the free teasers unaffected); candidates for 0.47.x.
- Paid create/renew write signed `wr-` receipts (amount, network, asset, seller pay_to, paid_until; never payer or tx), stored in `watch_events` (type `receipt`) and returned in the response.
- Create/verify answer 503 `signing_unavailable` (nothing charged) when the published signing key is not configured, so every webhook is verifiable.
- Secrets are hashed with `WATCH_PEPPER` (falls back to `HOSTED_KEY_PEPPER`); without either the API answers 503.
- No MCP tool for Watchtower (management needs the secret; API only). Listed in .well-known/x402, OpenAPI, llms.txt, /docs#watchtower and /pricing when the flag is on.
- Dev-only `WATCH_DEV_LOCAL=1` allows http loopback endpoints/webhooks for local `wrangler dev`; `WATCH_RETRY_SCHEDULE_S` and `WATCH_PROBE_INTERVAL_S` exist for local simulation. None of these are set in wrangler.toml (tested).
- Tests: tests/watch_test.mjs (17, real SQLite running migration 0013; needs Node >= 22.5: `npx -y -p node@22 node tests/watch_test.mjs`).
