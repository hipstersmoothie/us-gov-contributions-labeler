"""Relevance of 2023-2026 527 data to current members of Congress.

 4a  Schedule B expenditures naming members / their committees (recipient or purpose)
 4c  527s connected to members (org name, officers, related entities)

Writes .cache/irs527/member_sched_b_matches.json, member_527s.json.
Run after parse.py and orgs.py:  python3 src/scripts/irs527/members.py
"""
import csv, json, os, re, sys, collections, unicodedata

sys.path.insert(0, os.path.dirname(__file__))
from names import normalize_org
from orgs import load_reports, dedupe, latest_8871, money, YEARS, CACHE, ROOT

csv.field_size_limit(10**9)
SUFFIX = {"JR", "SR", "II", "III", "IV"}


def pnorm(s):
    s = unicodedata.normalize("NFD", (s or "").upper())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^A-Z0-9 ]", " ", s.replace("-", " ").replace("'", ""))
    return re.sub(r"\s+", " ", s).strip()


def member_index():
    members = json.load(open(os.path.join(ROOT, "data", "members.json")))["members"]
    site = json.load(open(os.path.join(ROOT, "data", "committees.json")))["committees"]
    # campaign committees via FEC linkage, leadership PACs via site sponsors
    cm = {}
    for f in ("cm24.txt", "cm26.txt"):
        for line in open(os.path.join(CACHE, f), encoding="latin-1"):
            p = line.split("|")
            cm[p[0]] = p[1]
    cand_cmte = collections.defaultdict(set)
    for f in ("ccl24.txt", "ccl26.txt"):
        for line in open(os.path.join(CACHE, f), encoding="latin-1"):
            p = line.split("|")
            cand_cmte[p[0]].add(p[3])
    lpac = collections.defaultdict(set)
    for c in site:
        for s in c.get("sponsors") or []:
            if s.get("bioguide"):
                lpac[s["bioguide"]].add(c["name"])
    out = []
    for m in members:
        raw = m["name"]
        nick = re.findall(r'"([^"]+)"', raw)
        base = re.sub(r'"[^"]+"', " ", raw).split(",")[0]
        toks = pnorm(base).split()
        toks = [t for t in toks if t not in SUFFIX]
        firsts = [t for t in toks[:-1] if len(t) > 1]
        first = firsts[0] if firsts else toks[0]
        last = toks[-1]
        # two-word surnames joined by hyphen in pnorm: OCASIO CORTEZ -> last=CORTEZ, keep compound for matching
        compound = None
        if "-" in base.split()[-1]:
            compound = pnorm(base.split()[-1])
        fn = {first} | {pnorm(n) for n in nick}
        cmtes = set()
        for fid in m.get("fecIds", []):
            for cid in cand_cmte.get(fid, ()):
                if cid in cm:
                    cmtes.add(cm[cid])
        cmtes |= lpac.get(m["bioguide"], set())
        out.append({
            "bioguide": m["bioguide"], "name": raw, "state": m["state"], "chamber": m["chamber"], "party": m["party"],
            "first": sorted(fn), "last": compound or last,
            "committees": sorted(cmtes),
            "cmteNorm": sorted({normalize_org(c) for c in cmtes if len(normalize_org(c)) > 6}),
        })
    return out


def full_name_rx(mm):
    firsts = "|".join(re.escape(f) for f in mm["first"])
    return re.compile(rf"\b({firsts})\b(?: [A-Z]{{1,2}})?(?: [A-Z]+)? {re.escape(mm['last'])}\b")


CAMPAIGN_RX = re.compile(r"\b(FOR|FRIENDS|COMMITTEE|CAMPAIGN|ELECT|PAC|VICTORY|CONGRESS|SENATE|LEADERSHIP)\b")
OFFICE_RX = r"(CONGRESS(MAN|WOMAN)?|U ?S SENATE|US SENATOR|SENATOR|SEN|REP|REPRESENTATIVE|CD ?\d+|\d+(ST|ND|RD|TH) (CONGRESSIONAL )?DISTRICT)"


def main():
    members = member_index()
    by_cmte = collections.defaultdict(list)
    for mm in members:
        for c in mm["cmteNorm"]:
            by_cmte[c].append(mm["bioguide"])
    rxs = [(mm, full_name_rx(mm)) for mm in members]
    # surname + office word in purpose, e.g. "MAILER OPPOSING REP SMITH"
    surname_rx = {mm["bioguide"]: re.compile(rf"\b{OFFICE_RX} (?:[A-Z]+ )?{re.escape(mm['last'])}\b|\b{re.escape(mm['last'])} (FOR|4) (CONGRESS|SENATE)\b") for mm in members if len(mm["last"]) >= 4}
    mby = {mm["bioguide"]: mm for mm in members}
    # quick prefilter: any member last name token
    lasts = {mm["last"] for mm in members}
    by_last = collections.defaultdict(list)
    for mm, rx in rxs:
        by_last[mm["last"]].append((mm, rx))
    # token -> last name key (compound surnames keyed by their final token)
    last_key = {l.split()[-1]: l for l in by_last}
    last_rx = re.compile(r"\b(" + "|".join(sorted(map(re.escape, lasts), key=len, reverse=True)) + r")\b")

    reports = load_reports()
    keep = {r["form_id"] for r in dedupe(reports).values()}
    rep_year = {r["form_id"]: (r["end"] or r["begin"])[:4] for r in reports}
    orgs = {g["ein"]: g for g in json.load(open(os.path.join(CACHE, "orgs_2023_2026.json")))}

    matches = []
    rows_scanned = 0
    with open(os.path.join(CACHE, "sched_b.tsv")) as f:
        rd = csv.DictReader(f, delimiter="\t", quoting=csv.QUOTE_NONE)
        for r in rd:
            if r["form_id"] not in keep:
                continue
            rows_scanned += 1
            rn = pnorm(r["name"])
            pu = pnorm(r["purpose"])
            hit = []
            ncm = normalize_org(r["name"])
            if ncm in by_cmte:
                for b in by_cmte[ncm]:
                    hit.append((b, "recipient=member committee"))
            toks = set(rn.split()) | set(pu.split())
            found = {last_key[t] for t in toks if t in last_key}
            if found:
                for mm, rx in (x for l in found for x in by_last[l]):
                    b = mm["bioguide"]
                    if any(h[0] == b for h in hit):
                        continue
                    if rx.search(rn):
                        kind = "recipient name (campaign-like)" if CAMPAIGN_RX.search(rn) else "recipient name (person)"
                        hit.append((b, kind))
                    elif rx.search(pu):
                        hit.append((b, "purpose names member"))
                    elif b in surname_rx and surname_rx[b].search(pu):
                        hit.append((b, "purpose surname+office"))
            for b, kind in hit:
                mm = mby[b]
                g = orgs.get(r["ein"], {})
                matches.append({
                    "bioguide": b, "member": mm["name"], "memberState": mm["state"], "how": kind,
                    "org": r["org"], "ein": r["ein"], "orgScope": g.get("scope"), "recipient": r["name"],
                    "recipientState": r["state"], "amount": money(r["amount"]), "date": r["date"],
                    "purpose": r["purpose"], "year": rep_year.get(r["form_id"]), "form_id": r["form_id"],
                    "sched_id": r["sched_id"], "stateMatch": r["state"] == mm["state"],
                })
    json.dump(matches, open(os.path.join(CACHE, "member_sched_b_matches.json"), "w"), indent=1)
    print("B rows scanned (deduped 2023-26):", rows_scanned, flush=True)
    by_how = collections.defaultdict(lambda: [0, 0.0, set()])
    for x in matches:
        k = (x["how"], x["stateMatch"])
        by_how[k][0] += 1
        by_how[k][1] += x["amount"]
        by_how[k][2].add(x["bioguide"])
    for k, v in sorted(by_how.items()):
        print(k, v[0], round(v[1]), len(v[2]))

    # 4c: 527s connected to members (all filers ever, flag 2023-26 activity)
    o8871 = latest_8871()
    conn = []
    for ein, o in o8871.items():
        on = pnorm(o["name"])
        people = [(pnorm(d[0]), d[1]) for d in o["D"]] + [(pnorm(x[0]), x[1]) for x in o["R"]]
        non = normalize_org(o["name"])
        toks = set(on.split())
        for pn, _ in people:
            toks |= set(pn.split())
        cands = [x for l in {last_key[t] for t in toks if t in last_key} for x in by_last[l]]
        cands += [(mby[b], None) for b in by_cmte.get(non, [])]
        seen = set()
        for mm, rx in cands:
            if mm["bioguide"] in seen:
                continue
            seen.add(mm["bioguide"])
            rx = rx or full_name_rx(mm)
            how = None
            if rx.search(on):
                how = "org name"
            elif non in mm["cmteNorm"]:
                how = "same name as member's FEC committee"
            else:
                for pn, title in people:
                    if rx.fullmatch(pn) or rx.search(pn) and len(pn.split()) <= 4:
                        how = f"officer/related: {title}"
                        break
            if not how:
                continue
            g = orgs.get(ein)
            conn.append({
                "bioguide": mm["bioguide"], "member": mm["name"], "memberState": mm["state"], "how": how,
                "ein": ein, "org": o["name"], "orgState": o["state"], "purpose": o["purpose"][:200],
                "established": o["established"], "lastFiled8871": o["inserted"][:10],
                "receipts2023_26": g["receipts"] if g else 0, "spending2023_26": g["spending"] if g else 0,
                "stateMatch": o["state"] == mm["state"],
            })
    conn.sort(key=lambda x: -x["receipts2023_26"])
    json.dump(conn, open(os.path.join(CACHE, "member_527s.json"), "w"), indent=1)
    print("member-connected candidates:", len(conn), "state-match:", sum(c["stateMatch"] for c in conn),
          "with 2023-26 money:", sum(1 for c in conn if c["receipts2023_26"] or c["spending2023_26"]))
    for c in conn[:60]:
        print(f"{c['receipts2023_26']:>11,.0f} {c['member'][:24]:24} {c['memberState']} | {c['org'][:50]:50} {c['orgState']} | {c['how'][:30]} | {c['purpose'][:70]}")


if __name__ == "__main__":
    main()
