// Where campaigns' money goes: itemized operating expenditures from the FEC
// bulk "oppexp" files, for current members' campaign committees and their
// leadership PACs, summed by purpose bucket and by vendor.
// https://www.fec.gov/campaign-finance-data/operating-expenditures-file-description/
//
// Three rules, measured in design/disbursements/README.md:
// - Memo rows (MEMO_CD = X) itemize another row, a credit card bill or a
//   payroll run, so they're left out of totals; where they point at their
//   parent they stand in for it in the vendor lists, so "American Express"
//   isn't anyone's top vendor.
// - The file holds processed reports, with an amendment replacing what it
//   amends, except for a few committees whose original sits next to it:
//   where one report's transaction ids recur under a higher file number, the
//   lower one goes.
// - The file runs weeks to months behind e-filing, so each committee carries
//   the date of its newest payment, for the page to say "reported through".
import fs from "fs";
import readline from "readline";
import { spawn } from "child_process";
import type { Legislator } from "../lib/legislators.js";
import { fecBulk } from "../lib/download.js";
import { titleCase } from "../lib/names.js";
import { normalizeVendor, vendorSlug, sentenceCase, vendorDisplayName, VENDOR_MIN, VENDOR_MIN_PAYERS, STAFF_LABEL, type Bucket } from "../lib/spending.js";
import type { CommitteeRecord } from "./build.js";

/** A payee in a committee's top-vendor list. */
export interface VendorLine {
  name: string;
  /** The vendor's page here, if it has one (data.vendors). */
  vendor?: string;
  amount: number;
  /** The purpose most of the money was filed under. */
  purpose?: string;
  /** Mostly paid by card or through a payroll service, and itemized in memo rows. */
  itemized?: boolean;
}

export interface SpendingSummary {
  /** Itemized operating expenditures, net of refunds and voids, whole dollars. */
  total: number;
  /** The newest payment date on file, YYYY-MM-DD. */
  through?: string;
  buckets: Partial<Record<Bucket, number>>;
  /** The biggest payees, pass-throughs resolved to what they paid. */
  vendors: VendorLine[];
  /** Distinct payees. */
  payees: number;
  /** Paid to the candidate (ENTITY_TP CAN), usually travel reimbursements. */
  candidate?: { amount: number; purposes: string[] };
  /** Paid to individuals other than the candidate: staff, by name in the filings, rolled up here. */
  individuals?: number;
}

export interface MemberSpending {
  byCycle: Record<number, SpendingSummary>;
  /** The campaign committees counted, by cycle. */
  committees: Record<number, string[]>;
}

export interface LeadershipPacSpending {
  byCycle: Record<
    number,
    SpendingSummary & {
      /** From the PAC summary file (webk): everything it spent, what it gave other committees, independent expenditures. */
      disbursements: number;
      contributions: number;
      independent: number;
      /** The summary's coverage end, YYYY-MM-DD. */
      coverage?: string;
    }
  >;
}

export interface VendorPayer {
  /** A member's bioguide id, or a leadership PAC's committee id. */
  id: string;
  kind: "member" | "leadership-pac";
  total: number;
  byCycle: Record<number, number>;
  purpose?: string;
}

export interface Vendor {
  id: string;
  name: string;
  total: number;
  byCycle: Record<number, number>;
  /** Largest first. */
  payers: VendorPayer[];
  buckets: Partial<Record<Bucket, number>>;
  /** The purposes filed for payments to it, largest first. */
  purposes: { text: string; amount: number }[];
  /** Mostly a card or payroll company: what's here is the part its payers didn't itemize. */
  passThrough?: boolean;
  /** The spellings it was filed under, as normalized, when more than one. */
  aliases?: string[];
}

export interface DisbursementsData {
  generatedAt: string;
  cycles: number[];
  members: Record<string, MemberSpending>;
  leadershipPacs: Record<string, LeadershipPacSpending>;
  /** Vendors with a page: paid VENDOR_MIN or more by VENDOR_MIN_PAYERS or more committees over the cycles. */
  vendors: Vendor[];
}

const TOP_VENDORS = 10;
const ALIASES_FILE = "data/vendor-aliases.json";

// Purpose buckets, first match wins; checked against a 60-row sample by hand
// (design/disbursements/README.md §7).
const PURPOSE_BUCKETS: [Bucket, RegExp][] = [
  ["fees", /PROCESSING|MERCHANT|TRANSACTION FEE|CARD FEE|CREDIT CARD FEE|SERVICE FEE|ACTBLUE|WINRED|ANEDOT|STRIPE|PAYPAL|BANK FEE|BANK (SERVICE|CHARGE)|WIRE FEE|EARMARK FEE|CONDUIT/],
  ["passthrough", /CREDIT CARD (PAYMENT|BILL|STATEMENT|CHARGES|EXPENSES)|CREDIT CARD$|SEE (ATTACHED |BELOW )?MEMO|SEE MEMO|ITEMIZED BELOW|SEE BELOW|REIMBURSE|PAYROLL (SERVICE|FEE)|AMEX|AMERICAN EXPRESS/],
  ["legal", /LEGAL|ATTORNEY|LAW\b|COMPLIANCE|ACCOUNT|AUDIT|BOOKKEEP|TREASURER|FEC (REPORT|COMPLIANCE)|CPA/],
  ["ads", /\bAD\b|ADS\b|ADVERT|MEDIA|TV\b|TELEVISION|RADIO|DIGITAL (AD|BUY|MARKET|PLACEMENT)|PLACEMENT|PRODUCTION|VIDEO|BILLBOARD|ONLINE AD|FACEBOOK|META PLATFORMS|GOOGLE AD|CABLE|BROADCAST|COMMUNICATIONS? (SERVICE|CONSULT)/],
  ["fundraising", /FUNDRAIS|FUND-?RAIS|SOLICIT|DIRECT MAIL|TELEMARKET|PHONE BANK|LIST (RENTAL|ACQUISITION)|DONOR|EMAIL (LIST|MARKETING|SERVICE)|TEXT(ING)? (MESSAG|SERVICE)|SMS|P2P|CALL TIME|CAGING/],
  ["polling", /POLL|SURVEY|RESEARCH|DATA (SERVICE|ANALYTIC|FILE)|VOTER (FILE|DATA)|ANALYTICS|MODELING/],
  ["consulting", /CONSULT|STRATEG|ADVIS|FIELD (CONSULT|SERVICE)|CAMPAIGN (MANAGEMENT|SERVICE)/],
  ["staff", /SALARY|SALARIES|PAYROLL|WAGE|STIPEND|CAMPAIGN MANAGER|HEALTH (INS|CARE|BENEFIT)|401|RETIREMENT|FICA|BENEFIT|COMPENSATION|STAFF|COMMISSION/],
  ["taxes", /\bTAX|IRS\b|TREASURY|FILING FEE|STATE OF|SECRETARY OF STATE|DEPARTMENT OF/],
  ["travel", /TRAVEL|AIRFARE|AIRLINE|FLIGHT|HOTEL|LODGING|UBER|LYFT|TAXI|MILEAGE|RENTAL CAR|CAR RENTAL|PARKING|TOLL|AMTRAK|TRAIN|PER DIEM|DELTA|UNITED|SOUTHWEST|AMERICAN AIR|HERTZ|AVIS|MARRIOTT|HILTON|HYATT/],
  ["events", /EVENT|CATER|VENUE|FOOD|BEVERAGE|MEAL|LUNCH|DINNER|BREAKFAST|RECEPTION|RESTAURANT|ENTERTAINMENT|TICKET|ROOM RENTAL|FACILITY|BANQUET|GOLF|COFFEE/],
  ["mail", /PRINT|POSTAGE|MAIL|SHIPPING|STAMPS|USPS|FEDEX|UPS\b|SIGNAGE|\bSIGNS?\b|YARD SIGN|LITERATURE|STICKER|BUTTON|T-SHIRT|SHIRT|MERCH|SWAG|PROMOTIONAL/],
  ["office", /RENT|OFFICE|UTILIT|PHONE|TELEPHONE|CELL|INTERNET|SOFTWARE|SUBSCRIPTION|WEB|DOMAIN|HOSTING|EMAIL|TECH|IT SERVICE|SUPPLIES|EQUIPMENT|COMPUTER|INSURANCE|STORAGE|FURNITURE|CLEANING|SECURITY|ZOOM|SLACK|MICROSOFT|GOOGLE|ADOBE|APPLE|AMAZON|VERIZON|AT&T|COMCAST|DUES|MEMBERSHIP|TELECONFERENC/],
  ["contributions", /CONTRIBUTION|DONATION|TRANSFER|SPONSORSHIP|TABLE|TICKETS? (TO|FOR)|IN-KIND|EARMARK/],
  ["refunds", /REFUND|RETURN|VOID|REIMBURSEMENT TO|OVERPAYMENT/],
  ["field", /CANVASS|FIELD|DOOR|GOTV|TURNOUT|VOTER (CONTACT|REGISTRATION|OUTREACH)|ORGANIZ|PETITION|SIGNATURE/],
];
// Where the purpose says nothing, the payee often does.
const PAYEE_BUCKETS: [Bucket, RegExp][] = [
  ["fees", /ACTBLUE|WINRED|ANEDOT|STRIPE|PAYPAL|NGP|DEMOCRACY ENGINE/],
  ["travel", /AIRLINES?|HOTEL|MARRIOTT|HILTON|HYATT|UBER|LYFT|AMTRAK|DELTA AIR|UNITED AIR|SOUTHWEST|AMERICAN AIR/],
  ["mail", /USPS|POSTMASTER|POSTAL|FEDEX|\bUPS\b/],
  ["staff", /PAYCHEX|GUSTO|ADP\b|PAYCOM|PAYLOCITY|JUSTWORKS|TRINET|INTUIT PAYROLL/],
  ["passthrough", /AMERICAN EXPRESS|AMEX|CHASE CARD|CAPITAL ONE|BREX|RAMP\b/],
  ["taxes", /IRS|INTERNAL REVENUE|DEPT OF REVENUE|DEPARTMENT OF REVENUE|TREASURY/],
];

export function classify(purpose: string, payee: string): Bucket {
  const p = purpose.toUpperCase();
  for (const [bucket, re] of PURPOSE_BUCKETS) if (re.test(p)) return bucket;
  const n = payee.toUpperCase();
  for (const [bucket, re] of PAYEE_BUCKETS) if (re.test(n)) return bucket;
  return "other";
}

interface Row {
  committee: string;
  year: string;
  reportType: string;
  name: string;
  date?: string;
  amount: number;
  purpose: string;
  memo: boolean;
  entity: string;
  file: string;
  tran: string;
  backRef: string;
}

/** What a payment is counted as once pass-throughs are resolved. */
interface Line {
  name: string;
  amount: number;
  purpose: string;
  entity: string;
  /** From a memo row standing in for its parent. */
  viaMemo: boolean;
}

/** Stream the pipe-delimited rows of the single file inside a bulk zip. */
async function* rows(zip: string) {
  const child = spawn("unzip", ["-p", zip]);
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) if (line) yield line.split("|");
}

/** Dates are MM/DD/YYYY in these files, MMDDYYYY in the older ones. */
const fecDate = (d = "") =>
  /^\d\d\/\d\d\/\d{4}$/.test(d) ? `${d.slice(6)}-${d.slice(0, 2)}-${d.slice(3, 5)}` : /^\d{8}$/.test(d) ? `${d.slice(4)}-${d.slice(0, 2)}-${d.slice(2, 4)}` : undefined;
const slashDate = fecDate;

/**
 * Drop originals left next to their amendments: within one report (year and
 * type) filed under several file numbers, where the transaction ids of a
 * lower file number recur in a higher one, keep only the highest.
 */
function dedupeAmendments(list: Row[]) {
  const byReport = new Map<string, Map<string, Set<string>>>();
  for (const r of list) {
    const report = `${r.year}|${r.reportType}`;
    let files = byReport.get(report);
    if (!files) byReport.set(report, (files = new Map()));
    files.get(r.file)?.add(r.tran) ?? files.set(r.file, new Set([r.tran]));
  }
  const drop = new Set<string>();
  for (const [report, files] of byReport) {
    if (files.size < 2) continue;
    const ordered = [...files.keys()].sort((a, b) => Number(b) - Number(a));
    const newest = files.get(ordered[0]!)!;
    for (const file of ordered.slice(1)) {
      const trans = files.get(file)!;
      if ([...trans].some((t) => newest.has(t))) drop.add(`${report}|${file}`);
    }
  }
  return drop.size ? list.filter((r) => !drop.has(`${r.year}|${r.reportType}|${r.file}`)) : list;
}

/**
 * The payments a committee's rows amount to: non-memo rows, with each one that
 * has memo children (a card bill, a payroll run) replaced by its children,
 * capped at the parent's amount so the total can't move.
 */
function resolve(list: Row[]): Line[] {
  const children = new Map<string, Row[]>();
  for (const r of list) {
    if (!r.memo || !r.backRef) continue;
    const key = `${r.file}|${r.backRef}`;
    children.get(key)?.push(r) ?? children.set(key, [r]);
  }
  const out: Line[] = [];
  for (const r of list) {
    if (r.memo) continue;
    const kids = children.get(`${r.file}|${r.tran}`)?.filter((k) => k.amount > 0);
    if (!kids?.length || r.amount <= 0) {
      out.push({ name: r.name, amount: r.amount, purpose: r.purpose, entity: r.entity, viaMemo: false });
      continue;
    }
    const sum = kids.reduce((s, k) => s + k.amount, 0);
    const scale = sum > r.amount ? r.amount / sum : 1;
    for (const k of kids) out.push({ name: k.name, amount: k.amount * scale, purpose: k.purpose, entity: k.entity, viaMemo: true });
    if (sum < r.amount) out.push({ name: r.name, amount: r.amount - sum, purpose: r.purpose, entity: r.entity, viaMemo: false });
  }
  return out;
}

const STAFF = STAFF_LABEL;

function top<T>(map: Map<T, number>, n = Infinity) {
  return [...map].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export async function ingestDisbursements(legislators: Legislator[], cycles: number[], committees: CommitteeRecord[]): Promise<DisbursementsData> {
  const aliases: Record<string, string> = fs.existsSync(ALIASES_FILE) ? JSON.parse(fs.readFileSync(ALIASES_FILE, "utf8")) : {};
  const vendorKey = (name: string) => {
    const n = normalizeVendor(name);
    return aliases[n] ?? n;
  };

  const byFecId = new Map<string, string>();
  for (const l of legislators) for (const id of l.fec) byFecId.set(id, l.bioguide);
  // Leadership PACs with a current-member sponsor.
  const leadershipPacs = new Map<string, string>();
  for (const c of committees) {
    if (c.kind !== "leadership-pac") continue;
    const sponsor = c.sponsors?.find((s) => s.bioguide)?.bioguide;
    if (sponsor) leadershipPacs.set(c.id, sponsor);
  }

  const data: DisbursementsData = { generatedAt: new Date().toISOString(), cycles, members: {}, leadershipPacs: {}, vendors: [] };
  const today = data.generatedAt.slice(0, 10);
  // Across cycles, for the vendor pages.
  interface VendorAcc {
    byCycle: Map<number, number>;
    payers: Map<string, { kind: VendorPayer["kind"]; byCycle: Map<number, number>; purposes: Map<string, number> }>;
    buckets: Map<Bucket, number>;
    purposes: Map<string, number>;
    spellings: Map<string, number>;
  }
  const vendors = new Map<string, VendorAcc>();
  const vendorAcc = (key: string) => {
    let v = vendors.get(key);
    if (!v) vendors.set(key, (v = { byCycle: new Map(), payers: new Map(), buckets: new Map(), purposes: new Map(), spellings: new Map() }));
    return v;
  };
  // Where a member's top vendor isn't yet known to have a page: filled in at the end.
  const pending: { line: VendorLine; key: string }[] = [];

  for (const cycle of cycles) {
    const yy = String(cycle).slice(2);
    console.log(`Disbursements ${cycle}`);
    const [oppexp, ccl, webk] = await Promise.all([fecBulk(cycle, `oppexp${yy}.zip`), fecBulk(cycle, `ccl${yy}.zip`), fecBulk(cycle, `webk${yy}.zip`)]);

    // Members' campaign committees this cycle (principal and authorized), as fec.ts does.
    const memberOf = new Map<string, string>();
    for await (const r of rows(ccl)) {
      const [candId, , , cmteId, , designation] = r;
      const bioguide = byFecId.get(candId!);
      if (bioguide && (designation === "P" || designation === "A")) memberOf.set(cmteId!, bioguide);
    }
    const summaries = new Map<string, { disbursements: number; contributions: number; independent: number; coverage?: string }>();
    for await (const r of rows(webk)) {
      if (leadershipPacs.has(r[0]!)) {
        summaries.set(r[0]!, { disbursements: Number(r[12]) || 0, contributions: Number(r[22]) || 0, independent: Number(r[23]) || 0, coverage: slashDate(r[26]) });
      }
    }

    // Only the rows of committees we're counting are kept.
    const byCommittee = new Map<string, Row[]>();
    const lo = `${cycle - 1}-01-01`;
    const hi = `${cycle}-12-31`;
    let kept = 0;
    for await (const r of rows(oppexp)) {
      const committee = r[0]!;
      if (!memberOf.has(committee) && !leadershipPacs.has(committee)) continue;
      const date = fecDate(r[12]);
      const row: Row = {
        committee,
        year: r[2]!,
        reportType: r[3]!,
        name: r[8] ?? "",
        date: date && date >= lo && date <= hi ? date : undefined,
        amount: Number(r[13]) || 0,
        purpose: r[15] ?? "",
        memo: r[18] === "X",
        entity: r[20] ?? "",
        file: r[22] ?? "",
        tran: r[23] ?? "",
        backRef: r[24] ?? "",
      };
      byCommittee.get(committee)?.push(row) ?? byCommittee.set(committee, [row]);
      kept++;
    }

    // Sum each committee, then fold campaigns into their member.
    const summarize = (list: Row[], payer: { id: string; kind: VendorPayer["kind"] }): SpendingSummary => {
      const deduped = dedupeAmendments(list);
      const lines = resolve(deduped);
      const total = deduped.filter((r) => !r.memo).reduce((s, r) => s + r.amount, 0);
      // A payment dated after today is a typo in the filing.
      let through: string | undefined;
      for (const r of deduped) if (r.date && r.date <= today && (!through || r.date > through)) through = r.date;

      const buckets = new Map<Bucket, number>();
      const byVendor = new Map<string, { amount: number; purposes: Map<string, number>; viaMemo: number; spellings: Map<string, number> }>();
      const candidatePurposes = new Map<string, number>();
      let candidate = 0;
      let individuals = 0;
      let payees = 0;
      const names = new Set<string>();
      for (const l of lines) {
        const bucket = classify(l.purpose, l.name);
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + l.amount);
        if (l.entity === "CAN") {
          candidate += l.amount;
          if (l.purpose) candidatePurposes.set(sentenceCase(l.purpose), (candidatePurposes.get(sentenceCase(l.purpose)) ?? 0) + l.amount);
          continue;
        }
        if (l.entity === "IND") {
          individuals += l.amount;
          continue;
        }
        const key = vendorKey(l.name);
        if (!key) continue;
        names.add(key);
        let v = byVendor.get(key);
        if (!v) byVendor.set(key, (v = { amount: 0, purposes: new Map(), viaMemo: 0, spellings: new Map() }));
        v.amount += l.amount;
        if (l.viaMemo) v.viaMemo += l.amount;
        const purpose = sentenceCase(l.purpose);
        if (purpose) v.purposes.set(purpose, (v.purposes.get(purpose) ?? 0) + l.amount);
        v.spellings.set(l.name, (v.spellings.get(l.name) ?? 0) + l.amount);

        const acc = vendorAcc(key);
        acc.byCycle.set(cycle, (acc.byCycle.get(cycle) ?? 0) + l.amount);
        acc.buckets.set(bucket, (acc.buckets.get(bucket) ?? 0) + l.amount);
        if (purpose) acc.purposes.set(purpose, (acc.purposes.get(purpose) ?? 0) + l.amount);
        acc.spellings.set(l.name, (acc.spellings.get(l.name) ?? 0) + l.amount);
        let p = acc.payers.get(payer.id);
        if (!p) acc.payers.set(payer.id, (p = { kind: payer.kind, byCycle: new Map(), purposes: new Map() }));
        p.byCycle.set(cycle, (p.byCycle.get(cycle) ?? 0) + l.amount);
        if (purpose) p.purposes.set(purpose, (p.purposes.get(purpose) ?? 0) + l.amount);
      }
      payees = names.size + (candidate > 0 ? 1 : 0) + (individuals > 0 ? 1 : 0);

      const ranked = top(new Map([...byVendor].map(([k, v]) => [k, v.amount])), TOP_VENDORS).filter(([, amount]) => amount > 0);
      const lines_: VendorLine[] = ranked.map(([key, amount]) => {
        const v = byVendor.get(key)!;
        const line: VendorLine = {
          name: vendorDisplayName(top(v.spellings, 1)[0]![0], titleCase),
          amount: Math.round(amount),
          purpose: top(v.purposes, 1)[0]?.[0],
          itemized: v.viaMemo >= amount / 2 ? true : undefined,
        };
        pending.push({ line, key });
        return line;
      });
      // Staff rolled up into one line where they'd rank.
      if (individuals > 0) {
        lines_.push({ name: STAFF, amount: Math.round(individuals) });
        lines_.sort((a, b) => b.amount - a.amount);
        if (lines_.length > TOP_VENDORS && lines_.at(-1)!.name !== STAFF) lines_.pop();
        else if (lines_.length > TOP_VENDORS) lines_.splice(TOP_VENDORS - 1, 1);
      }

      return {
        total: Math.round(total),
        through,
        buckets: Object.fromEntries([...buckets].filter(([, v]) => Math.round(v) !== 0).map(([k, v]) => [k, Math.round(v)])),
        vendors: lines_,
        payees,
        candidate: candidate > 0 ? { amount: Math.round(candidate), purposes: top(candidatePurposes, 3).map(([p]) => p) } : undefined,
        individuals: individuals > 0 ? Math.round(individuals) : undefined,
      };
    };

    // A member with two campaigns in a cycle (a House seat and a Senate run) has both counted.
    const memberRows = new Map<string, { rows: Row[]; committees: string[] }>();
    for (const [committee, list] of byCommittee) {
      const bioguide = memberOf.get(committee);
      if (!bioguide) continue;
      let m = memberRows.get(bioguide);
      if (!m) memberRows.set(bioguide, (m = { rows: [], committees: [] }));
      m.rows.push(...list);
      m.committees.push(committee);
    }
    let members = 0;
    let memberTotal = 0;
    for (const [bioguide, { rows: list, committees: ids }] of memberRows) {
      const summary = summarize(list, { id: bioguide, kind: "member" });
      if (summary.total <= 0 && !summary.vendors.length) continue;
      const m = (data.members[bioguide] ??= { byCycle: {}, committees: {} });
      m.byCycle[cycle] = summary;
      m.committees[cycle] = ids.sort();
      members++;
      memberTotal += summary.total;
    }
    let pacs = 0;
    for (const [committee, list] of byCommittee) {
      if (!leadershipPacs.has(committee)) continue;
      const summary = summarize(list, { id: committee, kind: "leadership-pac" });
      const s = summaries.get(committee);
      if (summary.total <= 0 && !s?.disbursements) continue;
      const p = (data.leadershipPacs[committee] ??= { byCycle: {} });
      p.byCycle[cycle] = { ...summary, disbursements: Math.round(s?.disbursements ?? 0), contributions: Math.round(s?.contributions ?? 0), independent: Math.round(s?.independent ?? 0), coverage: s?.coverage };
      pacs++;
    }
    console.log(`  ${kept.toLocaleString()} rows for ${members} members' campaigns (${(memberTotal / 1e6).toFixed(0)}M) and ${pacs} leadership PACs`);
  }

  // Vendor pages: enough money from enough committees.
  const slugs = new Map<string, string>();
  const used = new Set<string>();
  const list: Vendor[] = [];
  for (const [key, acc] of vendors) {
    const total = [...acc.byCycle.values()].reduce((a, b) => a + b, 0);
    if (total < VENDOR_MIN || acc.payers.size < VENDOR_MIN_PAYERS) continue;
    let slug = vendorSlug(key) || "vendor";
    for (let i = 2; used.has(slug); i++) slug = `${vendorSlug(key)}-${i}`;
    used.add(slug);
    slugs.set(key, slug);
    const buckets = Object.fromEntries(top(acc.buckets).filter(([, v]) => Math.round(v) > 0).map(([k, v]) => [k, Math.round(v)])) as Partial<Record<Bucket, number>>;
    const passThrough = (buckets.passthrough ?? 0) > total / 2;
    const filed = top(acc.spellings).map(([s]) => s);
    const spellings = [...new Set(filed.map((s) => normalizeVendor(s)))].filter((s) => s !== key);
    list.push({
      id: slug,
      name: vendorDisplayName(filed[0]!, titleCase),
      total: Math.round(total),
      byCycle: Object.fromEntries([...acc.byCycle].map(([c, v]) => [c, Math.round(v)])),
      payers: [...acc.payers]
        .map(([id, p]): VendorPayer => ({
          id,
          kind: p.kind,
          total: Math.round([...p.byCycle.values()].reduce((a, b) => a + b, 0)),
          byCycle: Object.fromEntries([...p.byCycle].map(([c, v]) => [c, Math.round(v)])),
          purpose: top(p.purposes, 1)[0]?.[0],
        }))
        .filter((p) => p.total > 0)
        .sort((a, b) => b.total - a.total),
      buckets,
      purposes: top(acc.purposes, 8).map(([text, amount]) => ({ text, amount: Math.round(amount) })),
      passThrough: passThrough || undefined,
      aliases: spellings.length ? spellings.slice(0, 6) : undefined,
    });
  }
  list.sort((a, b) => b.total - a.total);
  data.vendors = list;
  for (const { line, key } of pending) {
    const slug = slugs.get(key);
    if (slug) line.vendor = slug;
  }

  // Spellings that look like one vendor split in two, for data/vendor-aliases.json.
  const big = list.slice(0, 500).map((v) => v.name.toUpperCase());
  const pairs: string[] = [];
  for (const a of big) for (const b of big) if (a !== b && b.startsWith(`${a} `)) pairs.push(`${a} ⊂ ${b}`);
  if (pairs.length) console.log(`  ${pairs.length} vendor names that are a prefix of another among the top 500 (check ${ALIASES_FILE}):\n    ${pairs.slice(0, 40).join("\n    ")}`);
  console.log(`Disbursements for ${Object.keys(data.members).length} members, ${Object.keys(data.leadershipPacs).length} leadership PACs, ${list.length} vendors with pages`);
  return data;
}
