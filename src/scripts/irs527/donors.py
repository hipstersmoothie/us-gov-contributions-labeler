"""4b: Schedule A contributors (2023-2026, amendments de-duplicated) that match the
site's organizations (data/organizations.json) or large donors (data/donors.json).

Writes .cache/irs527/donor_matches.json.
Run after parse.py and orgs.py:  python3 src/scripts/irs527/donors.py
"""
import csv, json, os, re, sys, collections

sys.path.insert(0, os.path.dirname(__file__))
from names import normalize_org
from orgs import load_reports, dedupe, money, CACHE, ROOT
from members import pnorm, SUFFIX

csv.field_size_limit(10**9)


def person_key(raw):
    """'MARCUS, BERNARD' / 'Bernard Marcus' / 'Mr. Bernard J Marcus Jr' -> ('BERNARD', 'MARCUS')."""
    raw = re.sub(r"\b(MR|MRS|MS|DR|HON)\.?\s", " ", raw, flags=re.I)
    if "," in raw:
        last, rest = raw.split(",", 1)
        lt = [t for t in pnorm(last).split() if t not in SUFFIX]
        ft = [t for t in pnorm(rest).split() if t not in SUFFIX and len(t) > 1]
        if lt and ft:
            return ft[0], lt[-1]
        return None
    t = [x for x in pnorm(raw).split() if x not in SUFFIX]
    if len(t) < 2:
        return None
    return t[0], t[-1]


ORG_HINT = re.compile(r"\b(INC|LLC|CORP|CORPORATION|COMPANY|CO|ASSOCIATION|ASSN|UNION|FUND|PAC|COMMITTEE|PARTNERS|GROUP|TRUST|FOUNDATION|COUNCIL|BANK|SERVICES|INDUSTRIES|LP|LLP|PLC|HOLDINGS|INTERNATIONAL|AMERICA|NATIONAL|STATE|PARTY|FEDERATION|LOCAL|COALITION|ALLIANCE|INSTITUTE|SOCIETY|ENERGY|HEALTH|USA)\b")


def main():
    site_orgs = json.load(open(os.path.join(ROOT, "data", "organizations.json")))["organizations"]
    donors = json.load(open(os.path.join(ROOT, "data", "donors.json")))["donors"]
    org_by_norm = {}
    for o in site_orgs:
        n = normalize_org(o["name"])
        if len(n) >= 4:
            org_by_norm.setdefault(n, o)
        lob = (o.get("lobbying") or {}).get("client")
        if lob and len(normalize_org(lob)) >= 4:
            org_by_norm.setdefault(normalize_org(lob), o)
    donor_org = {}
    donor_person = collections.defaultdict(list)
    for d in donors:
        if d["type"] == "individual":
            k = person_key(d["name"])
            if k:
                donor_person[k].append(d)
        else:
            n = normalize_org(d["name"])
            if len(n) >= 4:
                donor_org.setdefault(n, d)

    reports = load_reports()
    keep = {r["form_id"] for r in dedupe(reports).values()}
    orgs = {g["ein"]: g for g in json.load(open(os.path.join(CACHE, "orgs_2023_2026.json")))}

    org_hits = collections.defaultdict(lambda: {"total": 0.0, "rows": 0, "to": collections.Counter()})
    donor_hits = collections.defaultdict(lambda: {"total": 0.0, "rows": 0, "to": collections.Counter()})
    samples = []
    total_rows = total_amt = 0
    with open(os.path.join(CACHE, "sched_a.tsv")) as f:
        for r in csv.DictReader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            if r["form_id"] not in keep:
                continue
            amt = money(r["amount"])
            total_rows += 1
            total_amt += amt
            name = r["name"]
            looks_org = bool(ORG_HINT.search(name.upper())) or r["employer"].upper() in ("N/A", "NA", "")
            n = normalize_org(name)
            o = org_by_norm.get(n) if looks_org else None
            if o:
                h = org_hits[o["id"]]
                h["total"] += amt
                h["rows"] += 1
                h["to"][r["org"]] += amt
                if amt >= 100000 and len(samples) < 400:
                    samples.append({"kind": "organization", "id": o["id"], "contributor": name, "to": r["org"], "amount": amt, "date": r["date"]})
            d = donor_org.get(n) if looks_org else None
            if not d and not ORG_HINT.search(name.upper()):
                k = person_key(name)
                for cand in donor_person.get(k, []) if k else []:
                    if cand.get("state") == r["state"]:
                        d = cand
                        break
            if d:
                h = donor_hits[d["id"]]
                h["total"] += amt
                h["rows"] += 1
                h["to"][r["org"]] += amt
                if amt >= 100000 and len(samples) < 800:
                    samples.append({"kind": "donor-" + d["type"], "id": d["id"], "contributor": name, "to": r["org"], "amount": amt, "date": r["date"]})

    def pack(h, meta):
        out = []
        for k, v in sorted(h.items(), key=lambda kv: -kv[1]["total"]):
            out.append({"id": k, "name": meta[k]["name"], "total": v["total"], "rows": v["rows"],
                        "to": [{"org": a, "total": b} for a, b in v["to"].most_common(5)]})
        return out

    org_meta = {o["id"]: o for o in site_orgs}
    don_meta = {d["id"]: d for d in donors}
    res = {
        "scheduleA_rows": total_rows, "scheduleA_total": total_amt,
        "organizations": pack(org_hits, org_meta), "donors": pack(donor_hits, don_meta), "samples": samples,
    }
    json.dump(res, open(os.path.join(CACHE, "donor_matches.json"), "w"), indent=1)
    print("Schedule A rows (deduped 2023-26):", total_rows, round(total_amt))
    for kind in ("organizations", "donors"):
        lst = res[kind]
        print(f"{kind}: matched {len(lst)}, ${sum(x['total'] for x in lst):,.0f}")
        for x in lst[:25]:
            print(f"   {x['total']:>13,.0f} {x['name'][:40]:40} -> {', '.join(t['org'][:30] for t in x['to'][:3])}")
    by_type = collections.Counter()
    by_type_n = collections.Counter()
    for x in res["donors"]:
        t = don_meta[x["id"]]["type"]
        by_type[t] += x["total"]
        by_type_n[t] += 1
    print("donor matches by type:", dict(by_type_n), {k: round(v) for k, v in by_type.items()})


if __name__ == "__main__":
    main()
