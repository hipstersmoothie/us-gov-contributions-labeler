"""Does oppexp carry an amended report next to the original it replaces?

For every (committee, report year, report type) that appears under more than
one FILE_NUM, compare the rows: how many dollars sit in the older file numbers,
and how many of their TRAN_IDs also appear in the newest one (a true duplicate)
as opposed to being a different report with the same type code (two 12G
pre-general reports for two elections, say).

Run: python3 src/scripts/disbursements/amend.py 2026
"""
import collections
import json
import os
import sys

from scan import CACHE, C, money, rows


def main(cycle):
    yy = str(cycle)[2:]
    files = collections.defaultdict(set)
    path = os.path.join(CACHE, f"oppexp{yy}.zip")
    for r in rows(path):
        if len(r) < 25:
            continue
        files[(r[C["CMTE_ID"]], r[C["RPT_YR"]], r[C["RPT_TP"]])].add(r[C["FILE_NUM"]])
    multi = {k: v for k, v in files.items() if len(v) > 1}
    # Second pass: rows of those reports only.
    trans = collections.defaultdict(lambda: collections.defaultdict(dict))  # key -> file -> tran -> amt
    amndt = collections.defaultdict(dict)
    for r in rows(path):
        if len(r) < 25:
            continue
        k = (r[C["CMTE_ID"]], r[C["RPT_YR"]], r[C["RPT_TP"]])
        if k not in multi:
            continue
        f = r[C["FILE_NUM"]]
        trans[k][f][r[C["TRAN_ID"]] or r[C["SUB_ID"]]] = money(r[C["TRANSACTION_AMT"]])
        amndt[k][f] = r[C["AMNDT_IND"]]
    older_dollars = 0.0
    dup_dollars = 0.0
    dup_reports = 0
    examples = []
    for k, byfile in trans.items():
        newest = max(byfile, key=int)
        new_ids = set(byfile[newest])
        for f, t in byfile.items():
            if f == newest:
                continue
            older_dollars += sum(t.values())
            overlap = [tid for tid in t if tid in new_ids]
            d = sum(t[tid] for tid in overlap)
            if overlap:
                dup_dollars += d
                dup_reports += 1
                if len(examples) < 8:
                    examples.append({"report": list(k), "older": f, "newest": newest, "amndt": amndt[k],
                                     "older_rows": len(t), "overlapping_rows": len(overlap), "overlap_dollars": round(d)})
    out = {
        "cycle": cycle,
        "reports_with_multiple_file_nums": len(multi),
        "dollars_in_older_file_nums": round(older_dollars),
        "older_files_whose_tran_ids_recur_in_newest": dup_reports,
        "dollars_of_recurring_tran_ids": round(dup_dollars),
        "examples": examples,
    }
    json.dump(out, open(os.path.join(CACHE, f"amend{yy}.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    for c in sys.argv[1:] or ["2026"]:
        main(int(c))
