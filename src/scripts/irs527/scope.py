"""Hand classification of the biggest 2023-2026 527s (by receipts) plus the
heuristic scope for the long tail, and the resulting money shares.

Writes .cache/irs527/scope_shares.json. Run after orgs.py.
"""
import json, os, re, sys, collections

sys.path.insert(0, os.path.dirname(__file__))
from orgs import CACHE

# (regex on name, category, short note). First match wins.
HAND = [
    (r"^ActBlue Non-Federal", "conduit", "earmarked gifts to state/local Democratic candidates"),
    (r"^ActBlue Technical", "conduit", "ActBlue's processing/services entity"),
    (r"Governors Association", "national state-level", "governors' races"),
    (r"Attorneys General|DAGA People", "national state-level", "attorney general races"),
    (r"State Leadership Committee|Legislative Campaign Committee|PAC for America's Future|American Leadership Committee|Sister District|Run for Something", "national state-level", "state legislative races"),
    (r"Secretaries of State|Redistricting|Mayors Association|Treasurers Association|Lieutenant Governors", "national state-level", "other state/local offices"),
    (r"Justice Project|The Bench 527|Justice & Public Safety|Judicial Fairness", "national state-level", "judicial / prosecutor races"),
    (r"Garden State Forward|American Technology Excellence|North Carolina Families First|Making Michigans Future|Protect Our Wisconsin|"
     r"Justice for All - Michigan|Strategic Victory State Action|Good Government Coalition|New Wisconsin Majority|Wisconsin Ideas|"
     r"Brighter Future Forward|American Representative Majority|Stronger Foundations|Forge the Future|Making Our Tomorrow|SC Conservative|"
     r"Leadership for Ohio|Minnesota|North Carolina|Wisconsin|Michigan|Nevada|Indiana|Hoosier", "single-state group", "one state's races"),
    (r"AFSCME|SERVICE EMPLOYEES|SEIU|AFT |AFT$|REALTORS|United Association|IBEW|Laborers|LABORERS|UNITE HERE|Working for Working Americans|"
     r"IAFF|Ironworkers|IRONWORKERS|SMART|AFL-CIO|Carpenters|Insulators|NEA Fund|Mutual Ins|Teamsters|TEAMSTERS|Hotlel Trades|ATU|Beverage",
     "union/business nonfederal account", "mostly state/local candidates and issue work"),
    (r"EMILY's List Non-Federal|End Citizens United|Progressive Change|Swing Left|Leaders We Deserve|Progressive Turnout|Vote Rev|LGBTQ Victory|"
     r"Emerge|GOPAC|Presidential Coalition|Young Republican|College Republican|Young Democrats|Federation of Republican Women|National Republican Lawyers|Republican National Lawyers",
     "national ideological/party-building", "mixed state + federal, mostly candidate training/turnout"),
    (r"Legal Defense|Legal Expense", "legal defense fund", "legal fees"),
]


def classify(g):
    for rx, cat, note in HAND:
        if re.search(rx, g["name"]) or re.search(rx, g.get("name8871", "")):
            return cat, note
    s = g["scope"]
    return {"state/local": "other state/local", "federal": "federal (small)", "mixed": "mixed", "unclear": "unclear"}[s], g.get("scopeWhy", "")


def main():
    orgs = json.load(open(os.path.join(CACHE, "orgs_2023_2026.json")))
    tot = sum(g["receipts"] for g in orgs)
    sh = collections.Counter()
    n = collections.Counter()
    for g in orgs:
        g["category"], g["categoryNote"] = classify(g)
        sh[g["category"]] += g["receipts"]
        n[g["category"]] += 1
    shares = [{"category": k, "orgs": n[k], "receipts": v, "share": v / tot} for k, v in sh.most_common()]
    top = [{k: g.get(k) for k in ("name", "ein", "state", "receipts", "spending", "category", "categoryNote", "siteCommittees", "fecCommittees")} for g in orgs[:25]]
    json.dump({"total": tot, "shares": shares, "top25": top}, open(os.path.join(CACHE, "scope_shares.json"), "w"), indent=1)
    for s in shares:
        print(f"{s['share']:6.1%} {s['receipts']/1e6:8.1f}M {s['orgs']:5}  {s['category']}")
    for g in top:
        print(f"{g['receipts']/1e6:6.1f} {g['name'][:50]:50} {g['category']}")


if __name__ == "__main__":
    main()
