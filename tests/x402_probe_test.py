"""x402_probe.build_payment_header: v2 payload carries the challenge's top-level extensions.

Run: python3 tests/x402_probe_test.py   (stdlib only; uses a fake signer, no keys, no network)
"""
import base64
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import x402_probe as xp  # noqa: E402

OPTION = {"scheme": "exact", "network": "eip155:8453", "amount": "10000",
          "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "payTo": "0x0000000000000000000000000000000000000001", "maxTimeoutSeconds": 60,
          "extra": {"name": "USD Coin", "version": "2"}}
RESOURCE = {"url": "https://api.test.invalid/v1/thing", "mimeType": "application/json"}
EXTENSIONS = {"bazaar": {"info": {"input": {"type": "http", "method": "GET"}}, "schema": {"type": "object"}}}


class FakeSigner:
    address = "0x0000000000000000000000000000000000000002"

    def sign_authorization(self, to, value, asset, chain_id, name, version, valid_for_s=300, now=None):
        return "0xsig", {"from": self.address, "to": to, "value": str(value), "validAfter": "0",
                         "validBefore": "1", "nonce": "0x" + "00" * 32}


def decode(value):
    return json.loads(base64.b64decode(value).decode())


def challenge_from_header(obj):
    hdr = base64.b64encode(json.dumps(obj).encode()).decode()
    return xp.parse_challenge(402, {"PAYMENT-REQUIRED": hdr}, b"")


class BuildPaymentHeaderExtensions(unittest.TestCase):
    def test_v2_extensions_survive_unchanged(self):
        ch = challenge_from_header({"x402Version": 2, "resource": RESOURCE, "accepts": [OPTION],
                                    "extensions": EXTENSIONS})
        name, value = xp.build_payment_header(ch, OPTION, FakeSigner())
        self.assertEqual(name, "PAYMENT-SIGNATURE")
        p = decode(value)
        self.assertEqual(p["extensions"], EXTENSIONS)
        self.assertEqual(p["x402Version"], 2)
        self.assertEqual(p["resource"], RESOURCE)
        self.assertEqual(p["accepted"], OPTION)
        self.assertEqual(set(p), {"x402Version", "resource", "accepted", "payload", "extensions"})

    def test_v2_without_extensions_unchanged(self):
        ch = challenge_from_header({"x402Version": 2, "resource": RESOURCE, "accepts": [OPTION]})
        name, value = xp.build_payment_header(ch, OPTION, FakeSigner())
        p = decode(value)
        self.assertNotIn("extensions", p)
        self.assertEqual(set(p), {"x402Version", "resource", "accepted", "payload"})

    def test_v1_never_gets_extensions(self):
        body = json.dumps({"x402Version": 1, "accepts": [OPTION], "extensions": EXTENSIONS}).encode()
        ch = xp.parse_challenge(402, {}, body)
        name, value = xp.build_payment_header(ch, OPTION, FakeSigner())
        self.assertEqual(name, "X-PAYMENT")
        self.assertNotIn("extensions", decode(value))


if __name__ == "__main__":
    unittest.main(verbosity=2)
