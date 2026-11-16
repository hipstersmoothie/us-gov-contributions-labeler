"""Build data/irs527.json for the site: what organizations with a page here
gave to political organizations that report to the IRS (Form 8872, Schedule
A) in 2023-2026, mostly state-level groups, and members' legal defense funds.

Run after parse.py, orgs.py and scope.py (see design/irs527/README.md):
    python3 src/scripts/irs527/build.py

Contributors are matched to organizations by normalized name, only when the
contributor looks like an organization (a business suffix or an employer of
N/A). Every recipient is labeled by what kind of group it is (scope.py).
"""
import csv, json, os, re, sys, collections, datetime

sys.path.insert(0, os.path.dirname(__file__))
from names import normalize_org
from orgs import load_reports, dedupe, money, CACHE, ROOT, YEARS
from scope import classify
from donors import ORG_HINT

csv.field_size_limit(10**9)

# Members' own funds, checked by hand: the name and the 8871's purpose both
# name the member. ("Menendez Legal Defense Fund" is former Sen. Bob
# Menendez's, not Rep. Rob Menendez's.)
LEGAL_FUNDS = {
    "393779941": "S001150",  # Senator Schiff Legal Defense Fund
    "412957681": "K000377",  # Senator Mark Kelly Legal Defense Fund
    "412944603": "S001208",  # Senator Slotkin Legal Defense Fund
    "854330214": "B000490",  # The Sanford Bishop 2020 Legal Expense Trust
}

# What a group is, in the words the pages use.
def kind(category, note, state):
    if category == "national state-level":
        return {
            "governors' races": "Governors' races",
            "attorney general races": "Attorneys general races",
            "state legislative races": "State legislative races",
            "judicial / prosecutor races": "Judicial and prosecutor races",
        }.get(note, "State offices")
    return {
        "single-state group": f"State politics ({state})" if state else "One state's politics",
        "union/business nonfederal account": "Union or trade group's state account",
        "national ideological/party-building": "Candidate training and turnout",
        "conduit": "Passed on to state candidates (ActBlue)",
        "legal defense fund": "Legal defense fund",
        "other state/local": f"State or local politics ({state})" if state else "State or local politics",
        "federal (small)": "Federal candidates",
    }.get(category, "Other political group")


STATE_LEVEL = {"national state-level", "single-state group", "union/business nonfederal account", "conduit", "other state/local"}

# ActBlue Technical Services files as a 527, so the processing fees campaigns
# and PACs pay it show up as contributions. They aren't gifts.
EXCLUDE = {"270160261"}

# Names too generic to identify one organization.
GENERIC = {"AMERICA", "AMERICAN", "NATIONAL", "UNITED", "STATE", "PEOPLE", "VICTORY", "LEADERSHIP", "FUTURE"}


def main():
    site_orgs = json.load(open(os.path.join(ROOT, "data", "organizations.json")))["organizations"]
    org_by_norm = {}
    for o in site_orgs:
        for n in [o["name"], (o.get("lobbying") or {}).get("client")]:
            k = normalize_org(n) if n else ""
            if len(k) >= 4 and k not in GENERIC:
                org_by_norm.setdefault(k, o)

    groups = {g["ein"]: g for g in json.load(open(os.path.join(CACHE, "orgs_2023_2026.json")))}
    for g in groups.values():
        g["category"], g["categoryNote"] = classify(g)

    keep = {r["form_id"] for r in dedupe(load_reports()).values() if r["end"][:4] in YEARS}

    by_org = collections.defaultdict(lambda: {"total": 0.0, "years": collections.Counter(), "to": collections.Counter(), "names": collections.Counter()})
    fund_rows = collections.defaultdict(list)
    with open(os.path.join(CACHE, "sched_a.tsv")) as f:
        for r in csv.DictReader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            if r["form_id"] not in keep:
                continue
            amt = money(r["amount"])
            if r["ein"] in LEGAL_FUNDS:
                fund_rows[r["ein"]].append(r)
            name = r["name"]
            looks_org = bool(ORG_HINT.search(name.upper())) or r["employer"].upper() in ("N/A", "NA", "")
            if not looks_org or amt <= 0:
                continue
            o = org_by_norm.get(normalize_org(name))
            # A group's own nonfederal account giving to itself isn't a gift.
            if not o or r["ein"] not in groups or r["ein"] in EXCLUDE or normalize_org(groups[r["ein"]]["name"]) == normalize_org(name):
                continue
            h = by_org[o["id"]]
            h["total"] += amt
            h["years"][r["date"][:4]] += amt
            h["to"][r["ein"]] += amt
            h["names"][name] += amt

    out_orgs = {}
    used = set()
    for oid, h in by_org.items():
        if h["total"] < 1000:
            continue
        to = h["to"].most_common()
        top = [{"ein": e, "total": round(t)} for e, t in to[:12]]
        used.update(e for e, _ in to[:12])
        out_orgs[oid] = {
            "total": round(h["total"]),
            "groups": len(to),
            "byYear": {y: round(v) for y, v in sorted(h["years"].items()) if y in YEARS},
            "to": top,
            # How the contributor was written, for checking the match.
            "filedAs": [n for n, _ in h["names"].most_common(3)],
        }

    funds = []
    for ein, bioguide in LEGAL_FUNDS.items():
        g = groups.get(ein)
        if not g or g["receipts"] <= 0:
            continue
        rows = fund_rows[ein]
        contributors = collections.Counter()
        split = collections.Counter()
        for r in rows:
            name = r["name"].strip()
            if re.search(r"below threshold|unitemized", name, re.I):
                split["unitemized"] += money(r["amount"])
                continue
            contributors[name] += money(r["amount"])
            committee = re.search(r"\b(PAC|POLITICAL ACTION|COMMITTEE|FOR CONGRESS|FOR SENATE|FOR AMERICA|VICTORY|FUND)\b", name, re.I)
            split["committees" if committee else "organizations" if ORG_HINT.search(name.upper()) else "individuals"] += money(r["amount"])
        funds.append({
            "bioguide": bioguide,
            "ein": ein,
            "name": g["name"],
            "receipts": round(g["receipts"]),
            "spending": round(g["spending"]),
            "contributors": len(contributors),
            # Itemized contributions by who gave: PACs and campaign committees,
            # other organizations, people; plus small gifts reported as a lump.
            "split": {k: round(v) for k, v in split.items()},
        })
        used.add(ein)

    out_groups = {}
    for ein in sorted(used):
        g = groups[ein]
        out_groups[ein] = {
            "name": g["name"],
            "kind": kind(g["category"], g["categoryNote"], g.get("state", "")),
            "category": g["category"],
            # Works on state and local races (not federal, not unclear).
            "state": g.get("state", ""),
            "stateLevel": g["category"] in STATE_LEVEL,
            "receipts": round(g["receipts"]),
        }

    header = open(os.path.join(CACHE, "FullDataFile.txt"), encoding="latin-1").readline().split("|") if os.path.exists(os.path.join(CACHE, "FullDataFile.txt")) else []
    transmitted = header[1] if len(header) > 1 else ""
    res = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "transmitted": f"{transmitted[:4]}-{transmitted[4:6]}-{transmitted[6:8]}" if len(transmitted) == 8 else "",
        "years": list(YEARS),
        "groups": out_groups,
        "organizations": dict(sorted(out_orgs.items(), key=lambda kv: -kv[1]["total"])),
        "legalFunds": funds,
    }
    json.dump(res, open(os.path.join(ROOT, "data", "irs527.json"), "w"), separators=(",", ":"))
    total = sum(o["total"] for o in out_orgs.values())
    state = sum(t["total"] for o in out_orgs.values() for t in o["to"] if out_groups[t["ein"]]["stateLevel"])
    shown = sum(t["total"] for o in out_orgs.values() for t in o["to"])
    print(f"organizations {len(out_orgs)}, ${total:,.0f}; of the top 12 recipients each (${shown:,.0f}), to state-level groups {state / shown:.1%}; groups {len(out_groups)}; legal funds {len(funds)}")


if __name__ == "__main__":
    main()
