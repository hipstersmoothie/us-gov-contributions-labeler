"""One pass over the IRS Political Organization full data file (Forms 8871/8872).

Writes compact extracts under .cache/irs527/:
  orgs.jsonl       every 8871 (one line per filing) with its D/R/E children
  reports.tsv      every 8872 header
  sched_a.tsv      Schedule A rows whose parent 8872 period ends 2023-2026
  sched_b.tsv      Schedule B rows whose parent 8872 period ends 2023-2026
  parse_stats.json counts by record type, malformed lines, per-year totals

Run: python3 src/scripts/irs527/parse.py
"""
import json, os, sys, collections

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "..")
CACHE = os.path.normpath(os.path.join(ROOT, ".cache", "irs527"))
SRC = os.path.join(CACHE, "FullDataFile.txt")

EXPECT = {"1": 44, "D": 14, "R": 14, "E": 6, "2": 50, "A": 18, "B": 18, "H": 5, "F": 5}
KEEP_YEARS = {"2023", "2024", "2025", "2026"}


def money(s):
    try:
        return float(s.strip() or 0)
    except ValueError:
        return 0.0


def main():
    stats = collections.Counter()
    bad = collections.Counter()
    by_year = collections.defaultdict(lambda: collections.Counter())
    orgs = open(os.path.join(CACHE, "orgs.jsonl"), "w")
    reps = open(os.path.join(CACHE, "reports.tsv"), "w")
    sa = open(os.path.join(CACHE, "sched_a.tsv"), "w")
    sb = open(os.path.join(CACHE, "sched_b.tsv"), "w")
    reps.write("form_id\tein\tname\tbegin\tend\tinitial\tamended\tfinal\tqtr\tmonth\ttotal_a\ttotal_b\tinserted\n")
    sa.write("form_id\tsched_id\tein\torg\tname\tcity\tstate\temployer\tamount\toccupation\tagg_ytd\tdate\n")
    sb.write("form_id\tsched_id\tein\torg\tname\tcity\tstate\temployer\tamount\toccupation\tdate\tpurpose\n")

    cur_org = None
    cur_rep = None  # (form_id, year)

    def flush_org():
        if cur_org:
            orgs.write(json.dumps(cur_org) + "\n")

    def clean(s):
        return s.replace("\t", " ").replace("\r", " ").strip()

    with open(SRC, "r", encoding="latin-1", newline="\n") as f:
        for line in f:
            line = line.rstrip("\r\n")
            t = line[:2]
            rt = t[0] if len(t) == 2 and t[1] == "|" else None
            if rt not in EXPECT:
                bad["no-record-type"] += 1
                continue
            p = line.split("|")
            stats[rt] += 1
            n = EXPECT[rt]
            if len(p) < n:
                bad[f"{rt}-short-{len(p)}"] += 1
                # '1' records truncated after PURPOSE are still usable
                if not (rt == "1" and len(p) >= 40):
                    continue
                p += [""] * (n - len(p))
            elif len(p) > n:
                bad[f"{rt}-long-{len(p)}"] += 1
                continue
            if rt == "1":
                flush_org()
                cur_org = {
                    "form_id": p[2], "initial": p[3], "amended": p[4], "final": p[5], "ein": p[6].strip(),
                    "name": p[7].strip(), "city": p[10], "state": p[11], "email": p[14], "established": p[15],
                    "custodian": p[16], "contact": p[23], "exempt8872": p[36], "exempt_state": p[37],
                    "exempt990": p[38], "purpose": p[39].strip(), "material_change": p[40], "inserted": p[41],
                    "D": [], "R": [], "E": [],
                }
            elif rt in "DRE":
                if cur_org is None or cur_org["form_id"] != p[1]:
                    bad[f"{rt}-orphan"] += 1
                    continue
                if rt == "D":
                    cur_org["D"].append([p[5].strip(), p[6].strip()])
                elif rt == "R":
                    cur_org["R"].append([p[5].strip(), p[6].strip()])
                else:
                    cur_org["E"].append([p[3].strip(), p[4].strip()])
            elif rt == "2":
                # 0 type,1 form,2 id,3 begin,4 end,5 init,6 amend,7 final,8 chg,9 name,10 ein ...
                begin, end = p[3], p[4]
                yr = end[:4] if end else begin[:4]
                cur_rep = (p[2], yr)
                by_year[yr]["reports"] += 1
                by_year[yr]["amended"] += p[6] == "1"
                by_year[yr]["total_a_hdr"] += money(p[45])
                by_year[yr]["total_b_hdr"] += money(p[47])
                reps.write("\t".join(clean(x) for x in [p[2], p[10], p[9], begin, end, p[5], p[6], p[7], p[39], p[40], p[45], p[47], p[48]]) + "\n")
            elif rt in "AB":
                if cur_rep is None or cur_rep[0] != p[1]:
                    bad[f"{rt}-orphan"] += 1
                    continue
                yr = cur_rep[1]
                amt = money(p[13])
                by_year[yr][f"{rt}_rows"] += 1
                by_year[yr][f"{rt}_amount"] += amt
                if yr in KEEP_YEARS:
                    if rt == "A":
                        sa.write("\t".join(clean(x) for x in [p[1], p[2], p[4], p[3], p[5], p[8], p[9], p[12], p[13], p[14], p[15], p[16]]) + "\n")
                    else:
                        sb.write("\t".join(clean(x) for x in [p[1], p[2], p[4], p[3], p[5], p[8], p[9], p[12], p[13], p[14], p[15], p[16]]) + "\n")
    flush_org()
    for fh in (orgs, reps, sa, sb):
        fh.close()
    out = {"records": stats, "malformed": bad, "byYear": {k: by_year[k] for k in sorted(by_year)}}
    json.dump(out, open(os.path.join(CACHE, "parse_stats.json"), "w"), indent=1)
    print(json.dumps({"records": stats, "malformed": bad}, indent=1))


if __name__ == "__main__":
    main()
