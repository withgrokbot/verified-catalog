#!/bin/sh
# Firewall for the probe VPS. This script does not run from CI or from a deploy.
# On the VPS, review it, then: PROBE_APPLY_UFW=1 sh ufw-probe.sh
set -eu
if [ "${PROBE_APPLY_UFW:-}" != "1" ]; then
  echo "refusing: set PROBE_APPLY_UFW=1 on the probe VPS to apply these rules" >&2
  exit 1
fi
ufw default deny incoming
ufw default deny outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow out 53
ufw allow out 80/tcp
ufw allow out 123/udp
ufw allow out 443/tcp
ufw allow out 25/tcp
ufw deny in 25/tcp
ufw --force enable
ufw status verbose
