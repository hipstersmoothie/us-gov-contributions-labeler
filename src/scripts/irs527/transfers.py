"""How much 2023-2026 Schedule A money is transfers between 527s (double counted
when summing receipts across orgs), and how much flows through ActBlue Non-Federal.

Run after orgs.py:  python3 src/scripts/irs527/transfers.py
"""
import csv, json, os, sys, collections

sys.path.insert(0, os.path.dirname(__file__))
from names import normalize_org
from orgs import load_reports, dedupe, money, CACHE

csv.field_size_limit(10**9)


def main():
    orgs = json.load(open(os.path.join(CACHE, "orgs_2023_2026.json")))
    filers = {}
    for g in orgs:
        for nm in (g["name"], g.get("name8871") or ""):
            n = normalize_org(nm)
            if len(n) >= 5:
                filers[n] = g["ein"]
    keep = {r["form_id"] for r in dedupe(load_reports()).values()}
    t = 0.0
    tot = 0.0
    pairs = collections.Counter()
    with open(os.path.join(CACHE, "sched_a.tsv")) as f:
        for r in csv.DictReader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            if r["form_id"] not in keep:
                continue
            a = money(r["amount"])
            tot += a
            src = filers.get(normalize_org(r["name"]))
            if src and src != r["ein"]:
                t += a
                pairs[(r["name"][:40], r["org"][:40])] += a
    out = {"scheduleA_total": tot, "from_other_527_filers": t, "top_pairs": [[a, b, v] for (a, b), v in pairs.most_common(25)]}
    json.dump(out, open(os.path.join(CACHE, "transfers.json"), "w"), indent=1)
    print(f"Schedule A total {tot:,.0f}; from other 527 filers {t:,.0f} ({t/tot:.1%})")
    for (a, b), v in pairs.most_common(25):
        print(f"  {v:>13,.0f}  {a} -> {b}")


if __name__ == "__main__":
    main()
