# SMTP probe

Small Node service for one Ubuntu VPS. It accepts the signed request the worker builds (`EMAIL_SMTP_URL` + `EMAIL_SMTP_SECRET`) and checks one recipient over SMTP. It does not send a message body.

This tree does not install the service, open firewall ports, change DNS, or deploy the worker. Those steps run on the VPS, by hand, after review.

- Hostname: `probe.402xagent.com`
- Address: `108.61.195.175`
- DNS: [`docs/probe-dns.md`](../docs/probe-dns.md)

## What a request does

`POST` the raw JSON body the worker signs. The header is `x-email-probe-signature: v1=<hex>`, HMAC-SHA256 of those exact bytes. The body is `{"v":1,"ts":<unix seconds>,"email":"<addr>"}`. The timestamp must be within 300 seconds. The same signature is rejected for the rest of that window.

For each address:

1. MX lookup. A null MX, a missing MX, or a private address returns `unknown` and opens no socket.
2. Gmail, Outlook, and Yahoo MX names return `unknown` with `provider_skip` and open no socket.
3. Otherwise connect to port 25 of a public address of the lowest-preference MX and send only:
   - `EHLO probe.402xagent.com`
   - `MAIL FROM:<probe@402xagent.com>`
   - `RCPT TO:<the address>`
   - if that reply is 250, `RCPT TO:<no-such-random@the domain>` to detect a catch-all
   - `QUIT`

A 250 followed by a rejecting random recipient is `smtp: "pass"`, `catch_all: false`. A 250 on the random recipient is a catch-all (`smtp: "unknown"`). Any 4xx is `unknown` (`greylist`) and that MX backs off. A 5xx on the real recipient is `smtp: "fail"`. A 5xx on `MAIL FROM` is `unknown` (`sender_rejected`), because that does not describe the recipient.

## Limits

- At most 2 connections at once to one MX, and 4 probes a minute to that MX (the code will not go above 6 a minute or 2 connections).
- A 4xx backs that MX off for 60 seconds, then 120, up to 15 minutes.
- `PROBE_DAILY_CAP` counts SMTP connections for the UTC day. Unset means 300. The counter is stored in `PROBE_STATE_DIR` as a date and a count.

Provider skips and rejected signatures do not use the daily cap.

## Install

Requirements: Ubuntu, Node 22, outbound TCP 25, and the DNS records in `docs/probe-dns.md`. Many VPS providers block outbound 25 until support enables it. Confirm that before the first probe.

```sh
sudo useradd --system --home /opt/probe --shell /usr/sbin/nologin probe
sudo mkdir -p /opt/probe /var/lib/probe /etc/probe
sudo rsync -a --exclude test ./ /opt/probe/
sudo cp probe.env.example /etc/probe/probe.env
sudo chown -R probe:probe /opt/probe /var/lib/probe
sudo chmod 600 /etc/probe/probe.env
```

Edit `/etc/probe/probe.env`. Set `PROBE_SECRET` to the same value as the worker's `EMAIL_SMTP_SECRET` (16 characters or more). Leave `PROBE_DAILY_CAP=300` for the first week. Do not commit that file.

```sh
sudo cp probe.service /etc/systemd/system/probe.service
sudo systemctl daemon-reload
sudo systemctl enable --now probe
```

Caddy terminates TLS and proxies to `127.0.0.1:8787`:

```sh
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Firewall (incoming 22, 80, 443; outgoing 25, 53, 80, 123, 443; inbound 25 denied):

```sh
PROBE_APPLY_UFW=1 sudo sh ufw-probe.sh
```

The worker variable, set only when the feature is turned on, is `EMAIL_SMTP_URL=https://probe.402xagent.com/v1`. The secret stays in `wrangler secret put`, not in `wrangler.toml`.

## Warm-up

Raise the cap only after the blocklist checks below are clean. A listing, a PTR mismatch, or a steady run of 4xx means stay at the current cap.

| Days | `PROBE_DAILY_CAP` |
| --- | --- |
| 1–7 | 300 |
| 8–14 | 1000 |
| 15–21 | 3000 |

Change the value in `/etc/probe/probe.env` and `sudo systemctl restart probe`. After day 21, further increases are a separate decision, still gated on the checks below.

## Blocklist checks

Run these before the first probe and before each step up. Do not raise the cap while any list answers.

```sh
dig +short A probe.402xagent.com
dig +short -x 108.61.195.175
dig +short TXT probe.402xagent.com
dig +short 175.195.61.108.zen.spamhaus.org
dig +short 175.195.61.108.b.barracudacentral.org
```

The A answer is `108.61.195.175`. The PTR answer is `probe.402xagent.com`. The TXT answer is `v=spf1 ip4:108.61.195.175 -all`. An empty answer from Spamhaus ZEN and Barracuda means those lists have no hit. Also look up the address at the Spamhaus and MultiRBL query pages. If either list answers, leave the cap where it is and fix the listing before sending more probes.

## Tests

```sh
node --test test/probe.test.mjs
```
