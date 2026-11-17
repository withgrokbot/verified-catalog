"""scripts/four_xx_rate.py offline: 402 is not a 4xx error, self rows split out, compare runs. Run: python3 tests/four_xx_rate_test.py"""
import datetime as dt, io, os, sys, contextlib
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import four_xx_rate as f

ROWS = [
    {"product": "spot", "access": "spot-bad-params", "status": 400, "self": 0, "n": "6"},
    {"product": "spot", "access": "spot-discovery", "status": 402, "self": 0, "n": "100"},
    {"product": "spot", "access": "free", "status": 200, "self": 1, "n": "50"},
    {"product": "view", "access": "view-receipts", "status": 404, "self": 0, "n": "30"},
    {"product": "view", "access": "view-receipts", "status": 404, "self": 1, "n": "4"},
    {"product": "view", "access": "view-docs", "status": 200, "self": 0, "n": "1000"},
]
a, b = dt.datetime(2026, 11, 10), dt.datetime(2026, 11, 17)
s = f.summarize(ROWS, a, b, {"total": 70, "top": []}, "t")
assert s["total"]["four_xx"] == 40 and s["total"]["paywall_402"] == 100 and s["total"]["requests"] == 1190, s["total"]
assert s["total"]["by_status"] == {400: 6, 404: 34}, s["total"]
assert s["by_family"]["spot"]["four_xx"] == 6 and s["by_family"]["spot"]["paywall_402"] == 100
assert s["by_family"]["view"]["four_xx_outside"] == 30 and s["by_family"]["view"]["four_xx"] == 34
assert s["total"]["four_xx_per_day"] == round(40 / 7, 1) and s["d1_404"]["per_day"] == 10.0
assert "SELECT" in f.ae_sql(a, b) and "2026-11-10 00:00:00" in f.ae_sql(a, b)
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    f.show(s); f.compare(s, s)
assert "COMPARE" in buf.getvalue() and "402 paywall answers" in buf.getvalue()
print("four_xx_rate: ok")
