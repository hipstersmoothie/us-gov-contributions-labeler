"""The closer look at current members' spending: vendors, purposes, samples.

Reads member_rows<yy>.tsv (from scan.py), webk<yy>.zip (PAC summaries),
pas2<yy>.zip, cm<yy>.zip and data/members.json. Writes vendors<yy>.json and
prints the tables used in design/disbursements/README.md.

Run: python3 src/scripts/disbursements/vendors.py 2026 [2024]
"""
import collections
import json
import os
import random
import re
import sys

from scan import CACHE, COLS, ROOT, money, rows

SAMPLE = {
    "T000250": "John Thune (Senate majority leader)",
    "M001238": "Sarah McBride (House freshman, DE-AL)",
    "S001176": "Steve Scalise (Eye of the Tiger PAC)",
}

SUFFIX = re.compile(
    r"\b(INC|INCORPORATED|LLC|L\.L\.C|LTD|LIMITED|CORP|CORPORATION|CO|COMPANY|LP|L\.P|LLP|PLLC|PC|P\.C|PA|GROUP)\b\.?"
)
PUNCT = re.compile(r"[^A-Z0-9& ]+")
SPACES = re.compile(r"\s+")


def normalize(name):
    n = name.upper().replace("&AMP;", "&")
    n = re.sub(r"\bD/?B/?A\b.*$", "", n)  # keep the legal name, drop "DBA ..."
    n = PUNCT.sub(" ", n)
    n = SUFFIX.sub(" ", n)
    n = re.sub(r"^THE ", "", n.strip())
    return SPACES.sub(" ", n).strip()


# Purpose buckets, first match wins. Checked against a sample by hand.
BUCKETS = [
    ("fees (processing)", r"PROCESSING|MERCHANT|TRANSACTION FEE|CARD FEE|CREDIT CARD FEE|SERVICE FEE|ACTBLUE|WINRED|ANEDOT|STRIPE|PAYPAL|BANK FEE|BANK (SERVICE|CHARGE)|WIRE FEE|EARMARK FEE|CONDUIT"),
    ("pass-through", r"CREDIT CARD (PAYMENT|BILL|STATEMENT|CHARGES|EXPENSES)|CREDIT CARD$|SEE (ATTACHED |BELOW )?MEMO|SEE MEMO|ITEMIZED BELOW|SEE BELOW|REIMBURSE|PAYROLL (SERVICE|FEE)|AMEX|AMERICAN EXPRESS"),
    ("legal/compliance", r"LEGAL|ATTORNEY|LAW\b|COMPLIANCE|ACCOUNT|AUDIT|BOOKKEEP|TREASURER|FEC (REPORT|COMPLIANCE)|CPA"),
    ("advertising/media", r"\bAD\b|ADS\b|ADVERT|MEDIA|TV\b|TELEVISION|RADIO|DIGITAL (AD|BUY|MARKET|PLACEMENT)|PLACEMENT|PRODUCTION|VIDEO|BILLBOARD|ONLINE AD|FACEBOOK|META PLATFORMS|GOOGLE AD|CABLE|BROADCAST|COMMUNICATIONS? (SERVICE|CONSULT)"),
    ("fundraising", r"FUNDRAIS|FUND-?RAIS|SOLICIT|DIRECT MAIL|TELEMARKET|PHONE BANK|LIST (RENTAL|ACQUISITION)|DONOR|EMAIL (LIST|MARKETING|SERVICE)|TEXT(ING)? (MESSAG|SERVICE)|SMS|P2P|CALL TIME"),
    ("polling/research", r"POLL|SURVEY|RESEARCH|DATA (SERVICE|ANALYTIC|FILE)|VOTER (FILE|DATA)|ANALYTICS|MODELING"),
    ("consulting", r"CONSULT|STRATEG|ADVIS|GENERAL CONSULT|FIELD (CONSULT|SERVICE)|CAMPAIGN (MANAGEMENT|SERVICE)"),
    ("payroll/staff", r"SALARY|SALARIES|PAYROLL|WAGE|STIPEND|CAMPAIGN MANAGER|HEALTH (INS|CARE|BENEFIT)|401|RETIREMENT|PAYROLL TAX|FICA|BENEFIT|COMPENSATION|STAFF"),
    ("taxes/government", r"\bTAX|IRS\b|TREASURY|FILING FEE|STATE OF|SECRETARY OF STATE|DEPARTMENT OF"),
    ("travel", r"TRAVEL|AIRFARE|AIRLINE|FLIGHT|HOTEL|LODGING|UBER|LYFT|TAXI|MILEAGE|RENTAL CAR|CAR RENTAL|PARKING|TOLL|AMTRAK|TRAIN|PER DIEM|DELTA|UNITED|SOUTHWEST|AMERICAN AIR|HERTZ|AVIS|MARRIOTT|HILTON|HYATT"),
    ("events/food", r"EVENT|CATER|VENUE|FOOD|BEVERAGE|MEAL|LUNCH|DINNER|BREAKFAST|RECEPTION|RESTAURANT|ENTERTAINMENT|TICKET|ROOM RENTAL|FACILITY|BANQUET|GOLF|COFFEE"),
    ("printing/mail/postage", r"PRINT|POSTAGE|MAIL|SHIPPING|STAMPS|USPS|FEDEX|UPS\b|SIGNAGE|\bSIGNS?\b|YARD SIGN|LITERATURE|STICKER|BUTTON|T-SHIRT|SHIRT|MERCH|SWAG|PROMOTIONAL"),
    ("rent/office/tech", r"RENT|OFFICE|UTILIT|PHONE|TELEPHONE|CELL|INTERNET|SOFTWARE|SUBSCRIPTION|WEB|DOMAIN|HOSTING|EMAIL|TECH|IT SERVICE|SUPPLIES|EQUIPMENT|COMPUTER|INSURANCE|STORAGE|FURNITURE|CLEANING|SECURITY|ZOOM|SLACK|MICROSOFT|GOOGLE|ADOBE|APPLE|AMAZON|VERIZON|AT&T|COMCAST|DUES|MEMBERSHIP"),
    ("contributions/donations/transfers", r"CONTRIBUTION|DONATION|TRANSFER|SPONSORSHIP|TABLE|TICKETS? (TO|FOR)|IN-KIND|EARMARK"),
    ("refunds", r"REFUND|RETURN|VOID|REIMBURSEMENT TO|OVERPAYMENT"),
    ("field/canvass", r"CANVASS|FIELD|DOOR|GOTV|TURNOUT|VOTER (CONTACT|REGISTRATION|OUTREACH)|ORGANIZ|PETITION|SIGNATURE"),
]
BUCKET_RE = [(b, re.compile(p)) for b, p in BUCKETS]


def bucket(purpose, name=""):
    p = purpose.upper()
    for b, rx in BUCKET_RE:
        if rx.search(p):
            return b
    # Fall back on the payee for well-known kinds.
    n = name.upper()
    if re.search(r"ACTBLUE|WINRED|ANEDOT|STRIPE|PAYPAL|NGP|ANEDOT", n):
        return "fees (processing)"
    if re.search(r"AIRLINES?|HOTEL|MARRIOTT|HILTON|HYATT|UBER|LYFT|AMTRAK|DELTA AIR|UNITED AIR|SOUTHWEST|AMERICAN AIR", n):
        return "travel"
    if re.search(r"USPS|POSTMASTER|POSTAL|FEDEX|\bUPS\b", n):
        return "printing/mail/postage"
    if re.search(r"PAYCHEX|GUSTO|ADP\b|PAYCOM|PAYLOCITY|JUSTWORKS|TRINET|INTUIT PAYROLL", n):
        return "payroll/staff"
    if re.search(r"IRS|INTERNAL REVENUE|DEPT OF REVENUE|DEPARTMENT OF REVENUE|TREASURY", n):
        return "taxes/government"
    return "other/unclear"


CATEGORY_NAMES = {
    "001": "Administrative/salary/overhead", "002": "Travel", "003": "Solicitation and fundraising",
    "004": "Advertising", "005": "Polling", "006": "Campaign materials", "007": "Campaign events",
    "008": "Transfers", "009": "Loan repayments", "010": "Refunds of contributions",
    "011": "Political contributions", "012": "Donations",
}

SUFFIXES = {"JR", "JR.", "SR", "SR.", "II", "III", "IV"}


def surname(full):
    parts = full.replace(",", "").split()
    while parts and parts[-1].upper() in SUFFIXES:
        parts.pop()
    return parts[-1].upper() if parts else ""


def main(cycle):
    yy = str(cycle)[2:]
    members = {m["bioguide"]: m for m in json.load(open(os.path.join(ROOT, "data", "members.json")))["members"]}
    cm = {r[0]: r[1] for r in rows(os.path.join(CACHE, f"cm{yy}.zip"))}
    # webk: PAC summaries. 12 TTL_DISB, 13 TRANF_TO_AFF, 22 CONTRIB_TO_OTHER_CMTE, 23 IND_EXP, 24 PTY_COORD_EXP
    webk = {}
    for r in rows(os.path.join(CACHE, f"webk{yy}.zip")):
        webk[r[0]] = {"disb": money(r[12]), "toAff": money(r[13]), "contrib": money(r[22]), "ie": money(r[23]), "coord": money(r[24]), "through": r[26]}
    # pas2 24K/24Z by committee, as a cross-check on CONTRIB_TO_OTHER_CMTE.
    pas24k = collections.Counter()
    for r in rows(os.path.join(CACHE, f"pas2{yy}.zip")):
        if r[5] in ("24K", "24Z") and "EARMARK" not in (r[20] or "").upper():
            pas24k[r[0]] += money(r[14])

    H = {c: i + 2 for i, c in enumerate(COLS)}
    f = open(os.path.join(CACHE, f"member_rows{yy}.tsv"))
    next(f)
    raw_names = set()
    norm_names = set()
    vend_dollars = collections.Counter()       # campaigns, non-memo
    vend_campaigns = collections.defaultdict(set)
    vend_purpose = collections.defaultdict(collections.Counter)
    vend_display = {}
    cat_dollars = collections.Counter()
    cat_rows = collections.Counter()
    bucket_dollars = collections.Counter()
    bucket_rows = collections.Counter()
    lp_bucket_dollars = collections.Counter()
    per_member = collections.defaultdict(lambda: collections.defaultdict(float))
    per_member_purpose = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
    member_total = collections.Counter()
    surname_hits = collections.defaultdict(list)
    can_rows = collections.Counter()
    can_dollars = collections.Counter()
    ind_dollars = 0.0
    ind_rows = 0
    lp_operating = collections.Counter()
    lp_bucket_by_pac = collections.defaultdict(collections.Counter)
    lp_sponsor = {}
    lp_vendors = collections.defaultdict(collections.Counter)
    memo_parent_dollars = 0.0
    memo_child_dollars = 0.0
    memo_child_backref = 0.0
    sample_purposes = []
    n = 0
    for line in f:
        r = line.rstrip("\n").split("\t")
        role, b = r[0], r[1]
        amt = money(r[H["TRANSACTION_AMT"]])
        memo = r[H["MEMO_CD"]] == "X"
        name = r[H["NAME"]]
        purpose = r[H["PURPOSE"]]
        norm = normalize(name)
        if memo:
            memo_child_dollars += amt
            if r[H["BACK_REF_TRAN_ID"]]:
                memo_child_backref += amt
            continue
        n += 1
        bk = bucket(purpose, name)
        if bk == "pass-through":
            memo_parent_dollars += amt
        if role == "campaign":
            raw_names.add(name.upper().strip())
            norm_names.add(norm)
            vend_dollars[norm] += amt
            vend_campaigns[norm].add(b)
            vend_purpose[norm][purpose.upper()[:40]] += amt
            vend_display.setdefault(norm, name)
            cat = r[H["CATEGORY"]] or "(blank)"
            cat_dollars[cat] += amt
            cat_rows[cat] += 1
            bucket_dollars[bk] += amt
            bucket_rows[bk] += 1
            per_member[b][norm] += amt
            per_member_purpose[b][norm][purpose.upper()[:40]] += amt
            member_total[b] += amt
            if random.random() < 0.0005:
                sample_purposes.append((bk, purpose[:60], name[:40], round(amt)))
            ent = r[H["ENTITY_TP"]]
            if ent == "IND":
                ind_dollars += amt
                ind_rows += 1
            if ent == "CAN":
                can_rows[b] += 1
                can_dollars[b] += amt
            m = members.get(b)
            if m:
                sn = surname(m["name"])
                if len(sn) >= 4 and re.search(r"\b" + re.escape(sn) + r"\b", name.upper()):
                    surname_hits[b].append((name, purpose[:50], round(amt), ent))
        else:
            cmte = r[H["CMTE_ID"]]
            lp_sponsor[cmte] = b
            lp_operating[cmte] += amt
            lp_bucket_dollars[bk] += amt
            lp_bucket_by_pac[cmte][bk] += amt
            lp_vendors[cmte][norm] += amt

    campaign_total = sum(vend_dollars.values())
    top_by_dollars = [
        {"vendor": vend_display[v].title(), "dollars": round(d), "campaigns": len(vend_campaigns[v]),
         "purpose": vend_purpose[v].most_common(1)[0][0].title()}
        for v, d in vend_dollars.most_common(50)
    ]
    top_by_campaigns = sorted(vend_campaigns.items(), key=lambda kv: -len(kv[1]))[:50]
    top_by_campaigns = [
        {"vendor": vend_display[v].title(), "campaigns": len(s), "dollars": round(vend_dollars[v]),
         "purpose": vend_purpose[v].most_common(1)[0][0].title()}
        for v, s in top_by_campaigns
    ]
    sizes = {
        "vendors": len(vend_dollars),
        ">=$1M": sum(1 for d in vend_dollars.values() if d >= 1_000_000),
        ">=$250k": sum(1 for d in vend_dollars.values() if d >= 250_000),
        ">=$100k": sum(1 for d in vend_dollars.values() if d >= 100_000),
        ">=10 campaigns": sum(1 for s in vend_campaigns.values() if len(s) >= 10),
        ">=25 campaigns": sum(1 for s in vend_campaigns.values() if len(s) >= 25),
        ">=$100k and >=5 campaigns": sum(1 for v, d in vend_dollars.items() if d >= 100_000 and len(vend_campaigns[v]) >= 5),
        "top50 share": sum(d for _, d in vend_dollars.most_common(50)) / campaign_total,
        "top500 share": sum(d for _, d in vend_dollars.most_common(500)) / campaign_total,
    }

    # Sample members: the three named plus two at random with 2026 money.
    random.seed(cycle)
    pool = [b for b in member_total if b not in SAMPLE and member_total[b] > 100_000]
    picks = dict(SAMPLE)
    for b in random.sample(pool, 2):
        picks[b] = members[b]["name"] + " (random)"
    samples = {}
    for b, label in picks.items():
        top = sorted(per_member[b].items(), key=lambda kv: -kv[1])[:10]
        samples[label] = {
            "total": round(member_total[b]),
            "top10": [
                {"vendor": vend_display.get(v, v).title(), "dollars": round(d),
                 "purpose": per_member_purpose[b][v].most_common(1)[0][0].title(),
                 "share": round(d / member_total[b], 3)}
                for v, d in top
            ],
        }

    # Payments where the payee carries the member's surname.
    sur = sorted(surname_hits.items(), key=lambda kv: -sum(h[2] for h in kv[1]))
    surname_out = {
        "members_with_hits": len(surname_hits),
        "rows": sum(len(v) for v in surname_hits.values()),
        "dollars": round(sum(h[2] for v in surname_hits.values() for h in v)),
        "top15": [
            {"member": members[b]["name"], "rows": len(h), "dollars": sum(x[2] for x in h),
             "examples": [list(x) for x in sorted(h, key=lambda x: -x[2])[:3]]}
            for b, h in sur[:15]
        ],
    }
    can_out = {
        "members": len(can_rows), "rows": sum(can_rows.values()), "dollars": round(sum(can_dollars.values())),
        "top10": [{"member": members[b]["name"], "rows": can_rows[b], "dollars": round(can_dollars[b])} for b, _ in can_dollars.most_common(10)],
    }

    # Leadership PACs: top 20 by total disbursements (webk), split.
    lps = []
    for cmte, b in lp_sponsor.items():
        w = webk.get(cmte)
        if not w:
            continue
        total = w["disb"]
        lps.append({
            "pac": cm.get(cmte, cmte).title(), "id": cmte, "sponsor": members[b]["name"],
            "disbursements": round(total),
            "contributions": round(w["contrib"]), "contributions_share": round(w["contrib"] / total, 3) if total else None,
            "pas2_24k": round(pas24k[cmte]),
            "independent_expenditures": round(w["ie"]), "transfers_to_affiliated": round(w["toAff"]),
            "operating_oppexp": round(lp_operating[cmte]), "operating_share": round(lp_operating[cmte] / total, 3) if total else None,
            "operating_buckets": {k: round(v) for k, v in lp_bucket_by_pac[cmte].most_common(5)},
            "top_vendors": [(vend_display.get(v, v).title(), round(d)) for v, d in lp_vendors[cmte].most_common(3)],
            "through": w["through"],
        })
    lps.sort(key=lambda x: -x["disbursements"])
    all_lp_total = sum(x["disbursements"] for x in lps)
    all_lp_contrib = sum(x["contributions"] for x in lps)
    all_lp_oper = sum(x["operating_oppexp"] for x in lps)

    out = {
        "cycle": cycle,
        "campaign_rows_nonmemo": n,
        "campaign_dollars_nonmemo": round(campaign_total),
        "members_with_rows": len(member_total),
        "memo": {"children_dollars": round(memo_child_dollars), "children_with_backref": round(memo_child_backref),
                 "parents_pass_through_dollars": round(memo_parent_dollars)},
        "names": {"raw": len(raw_names), "normalized": len(norm_names)},
        "individual_payees": {"rows": ind_rows, "dollars": round(ind_dollars), "share": round(ind_dollars / campaign_total, 3)},
        "category_dollars": {f"{k} {CATEGORY_NAMES.get(k, '')}".strip(): round(v) for k, v in cat_dollars.most_common()},
        "category_blank_share": round(cat_dollars["(blank)"] / campaign_total, 3),
        "purpose_buckets": {k: {"dollars": round(v), "share": round(v / campaign_total, 3), "rows": bucket_rows[k]} for k, v in bucket_dollars.most_common()},
        "leadership_purpose_buckets": {k: round(v) for k, v in lp_bucket_dollars.most_common()},
        "purpose_sample": sample_purposes[:60],
        "vendor_sizes": sizes,
        "top_vendors_by_dollars": top_by_dollars,
        "top_vendors_by_campaigns": top_by_campaigns,
        "samples": samples,
        "surname": surname_out,
        "candidate_payee": can_out,
        "leadership_pacs": {"n": len(lps), "disbursements": round(all_lp_total), "contributions": round(all_lp_contrib),
                            "contributions_share": round(all_lp_contrib / all_lp_total, 3) if all_lp_total else None,
                            "operating_oppexp": round(all_lp_oper), "operating_share": round(all_lp_oper / all_lp_total, 3) if all_lp_total else None,
                            "top20": lps[:20]},
    }
    json.dump(out, open(os.path.join(CACHE, f"vendors{yy}.json"), "w"), indent=1)
    print(json.dumps({k: v for k, v in out.items() if k not in ("top_vendors_by_dollars", "top_vendors_by_campaigns", "samples", "leadership_pacs", "purpose_sample", "surname")}, indent=1))
    print("\nTOP 50 VENDORS BY $")
    for v in top_by_dollars:
        print(f"  {v['dollars']:>12,}  {v['campaigns']:>3}  {v['vendor'][:40]:40} {v['purpose'][:35]}")
    print("\nTOP 50 VENDORS BY CAMPAIGNS")
    for v in top_by_campaigns:
        print(f"  {v['campaigns']:>3}  {v['dollars']:>12,}  {v['vendor'][:40]:40} {v['purpose'][:35]}")
    print("\nSAMPLES")
    for label, s in samples.items():
        print(f"  {label}: ${s['total']:,}")
        for v in s["top10"]:
            print(f"     {v['dollars']:>10,} {v['share']:5.1%}  {v['vendor'][:38]:38} {v['purpose'][:35]}")
    print("\nSURNAME HITS", json.dumps(surname_out, indent=1)[:4000])
    print("\nLEADERSHIP PACS", json.dumps(out["leadership_pacs"], indent=1)[:9000])
    print("\nPURPOSE SAMPLE")
    for s in sample_purposes[:60]:
        print("  ", s)


if __name__ == "__main__":
    for c in sys.argv[1:] or ["2026"]:
        main(int(c))
