"""Two sanity checks a vendor index makes possible, plus the memo-chain test.

1. Payments to Trump properties across the whole file (every committee), by
   committee kind, and how much of it is current members' campaigns and
   leadership PACs.
2. For current members' rows: of the non-memo "pass-through" parents (credit
   card payments, payroll services), how many dollars have memo children that
   point back at them (BACK_REF_TRAN_ID), i.e. where the real vendor can be
   recovered from the children.

Run: python3 src/scripts/disbursements/payees.py 2026 [2024]
"""
import collections
import json
import os
import re
import sys

from scan import CACHE, C, COLS, ROOT, money, rows
from vendors import bucket

TRUMP = re.compile(r"\bTRUMP\b|MAR-?A-?LAGO|\bDORAL\b|BEDMINSTER|TRUMP (HOTEL|INTERNATIONAL|NATIONAL)", re.I)


def main(cycle):
    yy = str(cycle)[2:]
    cm = {r[0]: (r[1], r[9], r[8]) for r in rows(os.path.join(CACHE, f"cm{yy}.zip"))}
    member_cmtes = {}
    with open(os.path.join(CACHE, f"member_rows{yy}.tsv")) as f:
        next(f)
        for line in f:
            role, b, cmte = line.split("\t", 3)[:3]
            member_cmtes[cmte] = (role, b)
    hits = collections.Counter()
    hits_rows = collections.Counter()
    by_kind = collections.Counter()
    by_member_role = collections.Counter()
    examples = collections.Counter()
    for r in rows(os.path.join(CACHE, f"oppexp{yy}.zip")):
        if len(r) < 25 or r[C["MEMO_CD"]] == "X":
            continue
        name = r[C["NAME"]]
        if not TRUMP.search(name):
            continue
        # Skip payees that are Trump's own committees/people named Trump giving refunds etc.
        amt = money(r[C["TRANSACTION_AMT"]])
        info = cm.get(r[C["CMTE_ID"]])
        kind = ("leadership-pac" if info and info[2] == "D" else info[1]) if info else "?"
        hits[name.upper()[:45]] += amt
        hits_rows[name.upper()[:45]] += 1
        by_kind[kind] += amt
        mr = member_cmtes.get(r[C["CMTE_ID"]])
        if mr:
            by_member_role[mr[0]] += amt
            examples[(mr[1], name.upper()[:40], r[C["PURPOSE"]].upper()[:40])] += amt

    # Memo chains among members' rows.
    H = {c: i + 2 for i, c in enumerate(COLS)}
    parents = {}
    children = collections.Counter()
    children_n = collections.Counter()
    orphans = 0.0
    with open(os.path.join(CACHE, f"member_rows{yy}.tsv")) as f:
        next(f)
        for line in f:
            r = line.rstrip("\n").split("\t")
            key = (r[H["CMTE_ID"]], r[H["FILE_NUM"]])
            amt = money(r[H["TRANSACTION_AMT"]])
            if r[H["MEMO_CD"]] == "X":
                ref = r[H["BACK_REF_TRAN_ID"]]
                if ref:
                    children[key + (ref,)] += amt
                    children_n[key + (ref,)] += 1
                else:
                    orphans += amt
            else:
                parents[key + (r[H["TRAN_ID"]],)] = (amt, bucket(r[H["PURPOSE"]], r[H["NAME"]]), r[H["NAME"]])
    pass_total = sum(a for a, b, _ in parents.values() if b == "pass-through")
    pass_with_children = sum(a for k, (a, b, _) in parents.items() if b == "pass-through" and k in children)
    any_with_children = sum(a for k, (a, b, _) in parents.items() if k in children)
    children_matched = sum(v for k, v in children.items() if k in parents)
    children_total = sum(children.values())
    parent_names = collections.Counter()
    for k, (a, b, name) in parents.items():
        if k in children:
            parent_names[name.upper()[:40]] += a
    out = {
        "cycle": cycle,
        "trump_properties": {
            "dollars": round(sum(hits.values())), "rows": sum(hits_rows.values()),
            "by_committee_kind": {k: round(v) for k, v in by_kind.most_common()},
            "current_members": {k: round(v) for k, v in by_member_role.items()},
            "top_payees": [(k, round(v), hits_rows[k]) for k, v in hits.most_common(12)],
            "member_examples": [(k, round(v)) for k, v in examples.most_common(10)],
        },
        "memo_chains": {
            "pass_through_parents_dollars": round(pass_total),
            "pass_through_parents_with_children_dollars": round(pass_with_children),
            "any_parent_with_children_dollars": round(any_with_children),
            "children_dollars": round(children_total),
            "children_matched_to_a_parent_dollars": round(children_matched),
            "children_without_backref_dollars": round(orphans),
            "parents_with_children_top_names": [(k, round(v)) for k, v in parent_names.most_common(12)],
        },
    }
    json.dump(out, open(os.path.join(CACHE, f"payees{yy}.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    for c in sys.argv[1:] or ["2026"]:
        main(int(c))
