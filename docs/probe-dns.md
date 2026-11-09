# DNS for the SMTP probe

These records are set by hand. Nothing in this repo changes DNS, the VPS, or a deploy.

Host: `probe.402xagent.com`  
Address: `108.61.195.175`

## A

| Name | Type | Value |
| --- | --- | --- |
| `probe.402xagent.com` | A | `108.61.195.175` |

## SPF

TXT on `probe.402xagent.com` (the probe host, not the zone apex):

```text
v=spf1 ip4:108.61.195.175 -all
```

`-all` means mail from any other address fails SPF. The probe uses `MAIL FROM:<probe@402xagent.com>` and does not send a message body.

## PTR

Set the reverse DNS for `108.61.195.175` in the Vultr console to `probe.402xagent.com`.

The PTR must match the A record, and the EHLO name is the same host. Check before the first probe and again before each warm-up step:

```sh
dig +short A probe.402xagent.com
dig +short -x 108.61.195.175
dig +short TXT probe.402xagent.com
```

The A answer is `108.61.195.175`. The PTR answer is `probe.402xagent.com`. The TXT answer is the SPF record above.
