"""scripts/demand_weekly.py and scripts/funnel_weekly.py exclude nightly anchor AE points. Run: python3 tests/demand_weekly_test.py"""
import datetime as dt, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import demand_weekly as dw
import funnel_weekly as fw

since = dt.datetime(2026, 11, 18, 0, 0, 0)
rows = dw.sql_rows(since)
paid = dw.sql_paid(since)
funnel = fw.sql(since)
for name, sql in (("sql_rows", rows), ("sql_paid", paid), ("funnel_weekly", funnel)):
    assert "blob16 != 'anchor'" in sql, name
    assert "2026-11-18 00:00:00" in sql, name
assert "blob13 = 'paid'" in paid
# no query in these scripts filters on the AE index; exclusion is by the product tag
assert "index1" not in rows and "index1" not in paid and "index1" not in funnel
print("demand_weekly/funnel_weekly: ok")
