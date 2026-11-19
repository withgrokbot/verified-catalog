#!/usr/bin/env bash
# 0.77.3 post-deploy acceptance checks for receipt anchor proofs. Read-only: GETs and HEADs only,
# nothing is submitted to any calendar by this script. `ots verify` may ask the calendars whether a
# pending proof has confirmed (a GET), which is what the site's own instructions tell a visitor to run.
#
#   scripts/anchors_acceptance.sh [anchor-id] [base-url]
#   ANCHOR_ID defaults to the first anchor, an-1063df4cc4c91307.
#   Needs: curl, python3, coreutils (od, sha256sum), and for check (b) the OpenTimestamps client (pip install opentimestamps-client).
set -u
ID="${1:-an-1063df4cc4c91307}"
BASE="${2:-https://402xagent.com}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
FAIL=0
ok()  { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; FAIL=1; }
MAGIC_PREFIX="004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294"

check_ots() { # path-suffix label
  local url="$BASE/anchors/$ID$1" label="$2"
  local hdr len code
  hdr="$(curl -sI "$url")"
  code="$(printf '%s' "$hdr" | head -1 | awk '{print $2}')"
  len="$(printf '%s' "$hdr" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}')"
  [ "$code" = "200" ] && ok "(a) HEAD $label -> 200" || bad "(a) HEAD $label -> $code (want 200)"
  if [ -n "$len" ] && [ "$len" -gt 0 ] 2>/dev/null; then ok "(a) HEAD $label Content-Length $len"; else bad "(a) HEAD $label Content-Length '${len:-missing}' (want > 0)"; fi
  curl -s -o "$WORK/p$1" "$url"
  local n head
  n="$(wc -c < "$WORK/p$1" | tr -d ' ')"
  head="$(head -c 31 "$WORK/p$1" | od -An -tx1 | tr -d ' \n')"
  [ "$n" -gt 0 ] && { [ -z "$len" ] || [ "$n" = "$len" ]; } && ok "(a) GET $label body $n bytes, matches Content-Length" || bad "(a) GET $label body $n bytes vs Content-Length '${len:-missing}'"
  [ "$head" = "$MAGIC_PREFIX" ] && ok "(a) $label starts with the OTS magic" || bad "(a) $label does not start with the OTS magic (got $head)"
}
check_ots ".ots" "/anchors/$ID.ots"
check_ots ".bin.ots" "/anchors/$ID.bin.ots"
cmp -s "$WORK/p.ots" "$WORK/p.bin.ots" && ok "(a) .ots and .bin.ots are byte-identical" || bad "(a) .ots and .bin.ots differ"

# (b) follow the site's own instructions: <id>.bin is the raw 32-byte root, the proof is <id>.bin.ots.
ROOT_HEX="$(curl -s "$BASE/anchors.json" | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(next((a["merkle_root"] for a in d.get("anchors",[]) if a["id"]=="'"$ID"'"),""))')"
if [ -z "$ROOT_HEX" ]; then bad "(b) $ID not found in $BASE/anchors.json"; else
  python3 -c 'import sys;sys.stdout.buffer.write(bytes.fromhex(sys.argv[1]))' "$ROOT_HEX" > "$WORK/$ID.bin"
  cp "$WORK/p.bin.ots" "$WORK/$ID.bin.ots"
  [ "$(wc -c < "$WORK/$ID.bin" | tr -d ' ')" = 32 ] && ok "(b) saved $ID.bin (32-byte root $ROOT_HEX)" || bad "(b) root is not 32 bytes"
  if command -v ots >/dev/null 2>&1; then
    INFO="$(cd "$WORK" && ots info "$ID.bin.ots" 2>&1)"
    echo "$INFO" | grep -q "File sha256 hash: $(sha256sum "$WORK/$ID.bin" | cut -d' ' -f1)" \
      && ok "(b) ots info parses it; file hash = sha256($ID.bin)" || bad "(b) ots info did not parse or the file hash differs"
    echo "$INFO" | grep -E "PendingAttestation|BitcoinBlockHeaderAttestation" | sed 's/^ *verify /      /'
    echo "$INFO" | grep -q "PendingAttestation\|BitcoinBlockHeaderAttestation" && ok "(b) calendars/attestations listed" || bad "(b) no attestation listed"
    VER="$(cd "$WORK" && ots verify "$ID.bin.ots" 2>&1)"; echo "$VER" | sed 's/^/      ots verify: /'
    # A pending proof is fine. Without a local Bitcoin node `ots verify` ends with a node-connection error after it has parsed
    # the file and asked each calendar about it ("Got N attestation(s) from <calendar>"); that still counts as parsed + calendars listed.
    if echo "$VER" | grep -qi "not a timestamp file\|Bad magic\|Error! 'an-"; then bad "(b) ots verify could not parse the proof"
    elif echo "$VER" | grep -qi "attestation(s) from\|pending\|success"; then ok "(b) ots verify parsed it and listed the calendars (pending is fine)"
    else bad "(b) ots verify output shows neither calendars, pending, nor success"; fi
  else bad "(b) ots client not installed (pip install opentimestamps-client)"; fi
fi

# (c) the link on the /anchors page must work.
LINK="$(curl -s "$BASE/anchors" | grep -o "href=\"/anchors/$ID[^\"]*\"" | head -1 | sed 's/^href="//; s/"$//')"
if [ -z "$LINK" ]; then bad "(c) /anchors has no link for $ID"; else
  C="$(curl -s -o /dev/null -w '%{http_code} %{size_download}' "$BASE$LINK")"
  case "$C" in 200\ [1-9]*) ok "(c) page link $LINK -> $C" ;; *) bad "(c) page link $LINK -> $C (want 200 and size > 0)" ;; esac
fi

# (d) the newest anchor (tonight's 03:41 UTC run, from Nov 20 on) has a non-empty proof from the start.
NEWEST="$(curl -s "$BASE/anchors.json" | python3 -c 'import json,sys
d=json.load(sys.stdin).get("anchors",[])
print(d[0]["id"]+" "+d[0]["created_at"] if d else "")')"
if [ -z "$NEWEST" ]; then bad "(d) no anchors listed"; else
  NID="${NEWEST% *}"; NAT="${NEWEST#* }"
  S="$(curl -s -o "$WORK/n.ots" -w '%{http_code} %{size_download}' "$BASE/anchors/$NID.bin.ots")"
  echo "      newest anchor: $NID created $NAT"
  case "$S" in 200\ [1-9]*) [ "$(head -c 31 "$WORK/n.ots" | od -An -tx1 | tr -d ' \n')" = "$MAGIC_PREFIX" ] && ok "(d) newest anchor $NID proof $S, OTS magic" || bad "(d) newest anchor proof has no OTS magic" ;; *) bad "(d) newest anchor $NID proof -> $S" ;; esac
  [ "$NID" != "$ID" ] || echo "      (d) note: tonight's anchor has not run yet; newest is still $ID"
fi
exit $FAIL
