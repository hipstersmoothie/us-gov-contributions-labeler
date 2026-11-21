"""One pass over an FEC operating-expenditures bulk file (oppexp<yy>.zip).

Measures the file's shape (rows, dollars, committee types, memo entries,
amendments, categories) and pulls out the rows that belong to current members'
campaign committees and leadership PACs for the closer look in vendors.py.

Inputs (.cache/disbursements/): oppexp<yy>.zip, cm<yy>.zip, ccl<yy>.zip,
weball<yy>.zip, plus data/members.json and data/committees.json.
Outputs (.cache/disbursements/): stats<yy>.json, member_rows<yy>.tsv

Run: python3 src/scripts/disbursements/scan.py 2026 [2024]
"""
import collections
import json
import os
import subprocess
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CACHE = os.path.join(ROOT, ".cache", "disbursements")

# oppexp_header_file.csv
COLS = (
    "CMTE_ID,AMNDT_IND,RPT_YR,RPT_TP,IMAGE_NUM,LINE_NUM,FORM_TP_CD,SCHED_TP_CD,NAME,CITY,STATE,"
    "ZIP_CODE,TRANSACTION_DT,TRANSACTION_AMT,TRANSACTION_PGI,PURPOSE,CATEGORY,CATEGORY_DESC,MEMO_CD,"
    "MEMO_TEXT,ENTITY_TP,SUB_ID,FILE_NUM,TRAN_ID,BACK_REF_TRAN_ID"
).split(",")
C = {name: i for i, name in enumerate(COLS)}


def rows(zip_path):
    p = subprocess.Popen(["unzip", "-p", zip_path], stdout=subprocess.PIPE)
    for line in p.stdout:
        line = line.decode("latin-1").rstrip("\n")
        if line:
            yield line.split("|")


def money(s):
    try:
        return float(s or 0)
    except ValueError:
        return 0.0


def load_members():
    members = json.load(open(os.path.join(ROOT, "data", "members.json")))["members"]
    by_fec = {}
    for m in members:
        for f in m["fecIds"]:
            by_fec[f] = m["bioguide"]
    return members, by_fec


def load_leadership(members_by_bioguide):
    """Leadership PAC id -> sponsoring member bioguide (first current-member sponsor)."""
    committees = json.load(open(os.path.join(ROOT, "data", "committees.json")))["committees"]
    out = {}
    for c in committees:
        if c.get("kind") != "leadership-pac":
            continue
        for s in c.get("sponsors") or []:
            b = s.get("bioguide")
            if b and b in members_by_bioguide:
                out[c["id"]] = b
                break
    return out


def main(cycle):
    yy = str(cycle)[2:]
    members, by_fec = load_members()
    by_bioguide = {m["bioguide"]: m for m in members}
    leadership = load_leadership(by_bioguide)

    # Committee master: type and designation per committee.
    cm = {}
    for r in rows(os.path.join(CACHE, f"cm{yy}.zip")):
        cm[r[0]] = {"name": r[1], "dsgn": r[8], "type": r[9], "cand": r[14] if len(r) > 14 else ""}

    # Candidate-committee linkage: a current member's principal (P) and
    # authorized (A) committees this cycle, as fec.ts does.
    campaign_of = {}  # committee id -> bioguide
    for r in rows(os.path.join(CACHE, f"ccl{yy}.zip")):
        cand, cmte, dsgn = r[0], r[3], r[5]
        if dsgn in ("P", "A") and cand in by_fec:
            campaign_of[cmte] = by_fec[cand]

    # weball: total disbursements per member (summed over their candidate ids,
    # which overcounts members with two ids; fine for a coverage check).
    weball_disb = collections.defaultdict(float)
    for r in rows(os.path.join(CACHE, f"weball{yy}.zip")):
        b = by_fec.get(r[0])
        if b:
            weball_disb[b] += money(r[7])

    st = collections.defaultdict(lambda: collections.Counter())
    s = collections.Counter()
    seen_sub = set()
    dup_sub = 0
    # (cmte, rpt_yr, rpt_tp) -> set of file numbers and amendment indicators
    report_files = collections.defaultdict(set)
    report_amndt = collections.defaultdict(set)
    report_dollars = collections.Counter()
    # (cmte, tran_id) duplicates across file numbers: originals kept next to amendments
    tran_files = collections.defaultdict(set)
    tran_dollars = collections.Counter()
    dates = []
    member_disb = collections.defaultdict(float)  # bioguide -> non-memo $ from campaign committees
    member_rows_n = 0
    out = open(os.path.join(CACHE, f"member_rows{yy}.tsv"), "w")
    out.write("\t".join(["role", "bioguide"] + COLS) + "\n")

    for r in rows(os.path.join(CACHE, f"oppexp{yy}.zip")):
        if len(r) < 25:
            s["short_rows"] += 1
            continue
        amt = money(r[C["TRANSACTION_AMT"]])
        memo = r[C["MEMO_CD"]] == "X"
        cmte = r[C["CMTE_ID"]]
        info = cm.get(cmte)
        ctype = info["type"] if info else "?"
        dsgn = info["dsgn"] if info else "?"
        kind = "leadership-pac" if dsgn == "D" else ctype
        s["rows"] += 1
        s["dollars"] += amt
        if amt < 0:
            s["negative_rows"] += 1
            s["negative_dollars"] += amt
        st["form"][r[C["FORM_TP_CD"]]] += 1
        st["form_dollars"][r[C["FORM_TP_CD"]]] += amt
        st["kind_rows"][kind] += 1
        st["kind_dollars"][kind] += amt
        st["amndt"][r[C["AMNDT_IND"]]] += 1
        st["rpt_tp"][r[C["RPT_TP"]]] += 1
        st["rpt_yr"][r[C["RPT_YR"]]] += 1
        st["line"][r[C["LINE_NUM"]]] += 1
        st["line_dollars"][r[C["LINE_NUM"]]] += amt
        st["entity"][r[C["ENTITY_TP"]] or "(blank)"] += 1
        st["entity_dollars"][r[C["ENTITY_TP"]] or "(blank)"] += amt
        pgi = r[C["TRANSACTION_PGI"]]
        st["pgi"][pgi[:1] or "(blank)"] += 1
        cat = r[C["CATEGORY"]] or "(blank)"
        st["category_rows"][cat] += 1
        st["category_dollars"][cat] += amt
        if r[C["CATEGORY_DESC"]]:
            st["category_desc"][cat + " " + r[C["CATEGORY_DESC"]]] += 1
        if memo:
            s["memo_rows"] += 1
            s["memo_dollars"] += amt
            if r[C["BACK_REF_TRAN_ID"]]:
                s["memo_with_backref_rows"] += 1
                s["memo_with_backref_dollars"] += amt
            st["memo_kind_dollars"][kind] += amt
        else:
            s["nonmemo_rows"] += 1
            s["nonmemo_dollars"] += amt
            st["nonmemo_kind_dollars"][kind] += amt
            st["nonmemo_category_dollars"][cat] += amt
            purpose = r[C["PURPOSE"]].upper()
            if "MEMO" in purpose or "CREDIT CARD" in purpose or "SEE BELOW" in purpose:
                s["parent_like_rows"] += 1
                s["parent_like_dollars"] += amt
        d = r[C["TRANSACTION_DT"]]
        if len(d) == 10:
            dates.append(d[6:] + d[:2] + d[3:5])
        sub = r[C["SUB_ID"]]
        if sub in seen_sub:
            dup_sub += 1
        seen_sub.add(sub)
        key = (cmte, r[C["RPT_YR"]], r[C["RPT_TP"]])
        report_files[key].add(r[C["FILE_NUM"]])
        report_amndt[key].add(r[C["AMNDT_IND"]])
        report_dollars[key] += amt
        tid = r[C["TRAN_ID"]]
        if tid:
            tk = (cmte, tid)
            tran_files[tk].add(r[C["FILE_NUM"]])
            tran_dollars[tk] += amt

        role = None
        b = campaign_of.get(cmte)
        if b:
            role = "campaign"
        elif cmte in leadership:
            role, b = "leadership", leadership[cmte]
        if role:
            member_rows_n += 1
            st[f"{role}_rows"]["n"] += 1
            st[f"{role}_dollars"]["memo" if memo else "nonmemo"] += amt
            if role == "campaign" and not memo:
                member_disb[b] += amt
            out.write("\t".join([role, b] + [x.replace("\t", " ") for x in r[:25]]) + "\n")
    out.close()

    # Amendments: reports present under more than one file number.
    multi = [(k, v) for k, v in report_files.items() if len(v) > 1]
    multi_dollars = sum(report_dollars[k] for k, _ in multi)
    both = sum(1 for k in report_amndt if len(report_amndt[k]) > 1)
    tran_multi = [(k, v) for k, v in tran_files.items() if len(v) > 1]
    tran_multi_dollars = sum(tran_dollars[k] for k, _ in tran_multi)
    dates.sort()

    # Coverage against weball's total disbursements.
    cov = []
    for b, w in weball_disb.items():
        if w > 0:
            cov.append(member_disb.get(b, 0) / w)
    cov.sort()
    stats = {
        "cycle": cycle,
        "summary": dict(s),
        "sub_id_duplicates": dup_sub,
        "reports": len(report_files),
        "reports_with_multiple_file_nums": len(multi),
        "reports_with_multiple_file_nums_dollars": multi_dollars,
        "reports_with_mixed_amndt_ind": both,
        "tran_ids_in_multiple_files": len(tran_multi),
        "tran_ids_in_multiple_files_dollars": tran_multi_dollars,
        "tran_multi_examples": [[k[0], k[1], sorted(v)] for k, v in tran_multi[:10]],
        "date_min": dates[0] if dates else None,
        "date_p01": dates[len(dates) // 100] if dates else None,
        "date_p99": dates[len(dates) * 99 // 100] if dates else None,
        "date_max": dates[-1] if dates else None,
        "members_with_campaign_committee": len(set(campaign_of.values())),
        "campaign_committees": len(campaign_of),
        "leadership_pacs": len(leadership),
        "member_rows_written": member_rows_n,
        "coverage_vs_weball_median": cov[len(cov) // 2] if cov else None,
        "coverage_vs_weball_p10": cov[len(cov) // 10] if cov else None,
        "coverage_vs_weball_p90": cov[len(cov) * 9 // 10] if cov else None,
        "coverage_total": sum(member_disb.values()) / sum(weball_disb.values()) if weball_disb else None,
        "weball_disb_total": sum(weball_disb.values()),
        "oppexp_member_campaign_nonmemo_total": sum(member_disb.values()),
    }
    for k, v in st.items():
        stats[k] = dict(v.most_common(60))
    json.dump(stats, open(os.path.join(CACHE, f"stats{yy}.json"), "w"), indent=1)
    print(json.dumps({k: v for k, v in stats.items() if not isinstance(v, dict) or len(v) < 12}, indent=1))


if __name__ == "__main__":
    for c in sys.argv[1:] or ["2026"]:
        main(int(c))
