"""Org-level summary for 2023-2026 8872 money, with amendments de-duplicated,
scope classification and FEC overlap.

Writes .cache/irs527/orgs_2023_2026.json and dedupe stats; prints the top orgs.
Run after parse.py:  python3 src/scripts/irs527/orgs.py
"""
import csv, json, os, re, sys, collections

sys.path.insert(0, os.path.dirname(__file__))
from names import normalize_org

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CACHE = os.path.join(ROOT, ".cache", "irs527")
csv.field_size_limit(10**9)
YEARS = ("2023", "2024", "2025", "2026")


def money(s):
    try:
        return float(s or 0)
    except ValueError:
        return 0.0


def load_reports():
    rows = list(csv.DictReader(open(os.path.join(CACHE, "reports.tsv")), delimiter="\t", quoting=csv.QUOTE_NONE))
    return rows


def dedupe(reports):
    """An amended 8872 replaces the whole report for the same org and period.
    Keep the most recently filed report per (EIN, begin, end)."""
    best = {}
    for r in reports:
        k = (r["ein"], r["begin"], r["end"])
        cur = best.get(k)
        if cur is None or (r["inserted"], int(r["form_id"])) > (cur["inserted"], int(cur["form_id"])):
            best[k] = r
    return best


def latest_8871():
    by_ein = {}
    for line in open(os.path.join(CACHE, "orgs.jsonl")):
        o = json.loads(line)
        cur = by_ein.get(o["ein"])
        if cur is None or (o["inserted"], int(o["form_id"])) > (cur["inserted"], int(cur["form_id"])):
            # keep EAINs/officers seen on any filing
            if cur:
                o["E_all"] = cur.get("E_all", []) + o["E"]
            by_ein[o["ein"]] = o
        else:
            cur["E_all"] = cur.get("E_all", []) + o["E"]
    for o in by_ein.values():
        o["E_all"] = sorted({tuple(e) for e in o.get("E_all", []) + o["E"]})
    return by_ein


STATE_RX = re.compile(
    r"GOVERNOR|ATTORNEYS? GENERAL|\bAG\b|LEGISLAT|STATE SENATE|STATE HOUSE|\bASSEMBLY|SECRETAR(Y|IES) OF STATE|"
    r"JUDICIA|JUDGE|SUPREME COURT|JUSTICE|BALLOT|PROPOSITION|\bPROP\b|INITIATIVE|REFERENDUM|AMENDMENT|"
    r"COUNTY|\bCITY\b|MAYOR|SCHOOL BOARD|MUNICIPAL|\bLOCAL\b|DISTRICT ATTORNEY|SHERIFF|COUNCIL|TOWNSHIP|"
    r"STATE (LEVEL|AND LOCAL|OFFICE|CANDIDATES|ELECTIONS?|RACES?|LEGISLATIVE|REPRESENTATIVE)|NON-?FEDERAL|"
    r"STATE[- ]WIDE|TREASURER|COMPTROLLER|LIEUTENANT|REDISTRICTING|COMMISSIONER|ALDERM",
    re.I,
)
FED_RX = re.compile(
    r"\bCONGRESS|U\.?S\.? SENATE|UNITED STATES SENATE|U\.?S\.? HOUSE|FEDERAL (CANDIDATES|ELECTIONS?|OFFICE)|"
    r"PRESIDEN",
    re.I,
)


def scope(o):
    """Rough scope: 'state/local', 'federal', 'mixed', 'unclear'."""
    if not o:
        return "unclear", "no 8871"
    text = f"{o['name']} {o['purpose']}"
    eain_states = {e[1] for e in o["E_all"] if e[1]}
    s = bool(STATE_RX.search(text))
    f = bool(FED_RX.search(text))
    if o["exempt8872"] == "1" or o["exempt990"] == "1":
        return "state/local", "8871 claims state/local exemption"
    if eain_states and eain_states != {"FD"} and not f:
        return "state/local", "state election authority id: " + ",".join(sorted(eain_states))
    if s and not f:
        return "state/local", "name/purpose"
    if f and not s:
        return "federal", "name/purpose"
    if f and s:
        return "mixed", "name/purpose"
    return "unclear", ""


def load_fec_names():
    site = json.load(open(os.path.join(ROOT, "data", "committees.json")))["committees"]
    site_by_norm = collections.defaultdict(list)
    for c in site:
        for nm in {c["name"], c.get("connectedOrg") or ""}:
            n = normalize_org(nm)
            if n and len(n) > 3:
                site_by_norm[n].append(c["id"])
    all_by_norm = collections.defaultdict(set)
    for f in ("cm24.txt", "cm26.txt"):
        for line in open(os.path.join(CACHE, f), encoding="latin-1"):
            p = line.split("|")
            n = normalize_org(p[1])
            if n and len(n) > 3:
                all_by_norm[n].add(p[0])
    return site_by_norm, all_by_norm, {c["id"]: c for c in site}


def main():
    reports = load_reports()
    best = dedupe(reports)
    keep = {r["form_id"] for r in best.values()}
    in_range = [r for r in reports if (r["end"] or r["begin"])[:4] in YEARS]
    kept_range = [r for r in in_range if r["form_id"] in keep]
    stats = {
        "reports_2023_2026": len(in_range),
        "amended_flag_2023_2026": sum(r["amended"] == "1" for r in in_range),
        "reports_after_dedupe": len(kept_range),
        "receipts_raw": sum(money(r["total_a"]) for r in in_range),
        "receipts_dedup": sum(money(r["total_a"]) for r in kept_range),
        "spending_raw": sum(money(r["total_b"]) for r in in_range),
        "spending_dedup": sum(money(r["total_b"]) for r in kept_range),
        "by_year": {},
    }
    for y in YEARS:
        rr = [r for r in kept_range if (r["end"] or r["begin"])[:4] == y]
        stats["by_year"][y] = {
            "reports": len(rr),
            "orgs": len({r["ein"] for r in rr}),
            "receipts": sum(money(r["total_a"]) for r in rr),
            "spending": sum(money(r["total_b"]) for r in rr),
        }
    # Overlapping periods that aren't exact duplicates (e.g. monthly + quarterly) can double count.
    by_ein = collections.defaultdict(list)
    for r in kept_range:
        by_ein[r["ein"]].append((r["begin"], r["end"], money(r["total_a"])))
    overlap_eins = 0
    overlap_money = 0.0
    for ein, ps in by_ein.items():
        ps.sort()
        for (b1, e1, a1), (b2, e2, a2) in zip(ps, ps[1:]):
            if b2 and e1 and b2 <= e1:
                overlap_eins += 1
                overlap_money += min(a1, a2)
                break
    stats["eins_with_overlapping_periods"] = overlap_eins
    stats["overlap_receipts_upper_bound"] = overlap_money

    o8871 = latest_8871()
    site_by_norm, all_by_norm, site = load_fec_names()

    orgs = {}
    for r in kept_range:
        e = r["ein"]
        g = orgs.setdefault(e, {"ein": e, "name": r["name"], "receipts": 0.0, "spending": 0.0, "reports": 0, "byYear": {}})
        g["receipts"] += money(r["total_a"])
        g["spending"] += money(r["total_b"])
        g["reports"] += 1
        y = (r["end"] or r["begin"])[:4]
        g["byYear"][y] = g["byYear"].get(y, 0) + money(r["total_a"])
        if r["inserted"] > g.get("_ins", ""):
            g["_ins"], g["name"] = r["inserted"], r["name"]
    for e, g in orgs.items():
        g.pop("_ins", None)
        o = o8871.get(e)
        g["has8871"] = bool(o)
        if o:
            g["name8871"] = o["name"]
            g["state"] = o["state"]
            g["purpose"] = o["purpose"][:300]
            g["eain"] = [list(x) for x in o["E_all"]]
            g["exempt8872"] = o["exempt8872"]
            g["exempt990"] = o["exempt990"]
            g["related"] = o["R"][:10]
        g["scope"], g["scopeWhy"] = scope(o)
        names = {g["name"]} | ({o["name"]} if o else set())
        site_ids, fec_ids = set(), set()
        for nm in names:
            n = normalize_org(nm)
            site_ids |= set(site_by_norm.get(n, []))
            fec_ids |= all_by_norm.get(n, set())
        g["siteCommittees"] = sorted(site_ids)
        g["fecCommittees"] = sorted(fec_ids)[:10]
        g["fdEain"] = any(x[1] == "FD" for x in g.get("eain", []))
    out = sorted(orgs.values(), key=lambda g: -g["receipts"])
    json.dump(out, open(os.path.join(CACHE, "orgs_2023_2026.json"), "w"), indent=1)
    json.dump(stats, open(os.path.join(CACHE, "dedupe_stats.json"), "w"), indent=1)
    print(json.dumps(stats, indent=1))
    tot = sum(g["receipts"] for g in out)
    print("orgs with 2023-26 reports", len(out), "receipts", round(tot))
    sc = collections.Counter()
    for g in out:
        sc[g["scope"]] += g["receipts"]
    print({k: f"{v/tot:.1%}" for k, v in sc.items()})
    fec_site = [g for g in out if g["siteCommittees"]]
    fec_any = [g for g in out if g["fecCommittees"]]
    print("match site committees:", len(fec_site), round(sum(g["receipts"] for g in fec_site)))
    print("match any FEC committee name:", len(fec_any), round(sum(g["receipts"] for g in fec_any)))
    print("FD EAIN:", sum(g["fdEain"] for g in out))
    for g in out[:70]:
        print(f"{g['receipts']/1e6:8.1f} {g['spending']/1e6:8.1f} {g['scope'][:6]:6} {g.get('state','')} {g['name'][:60]:60} site={','.join(g['siteCommittees'][:2])} fec={','.join(g['fecCommittees'][:2])} | {g.get('purpose','')[:110]}")


if __name__ == "__main__":
    main()
