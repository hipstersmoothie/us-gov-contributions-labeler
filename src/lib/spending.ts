// What campaigns spend money on: the purpose buckets and vendor-name rules
// shared by the disbursements ingest and the site.

/** A purpose bucket, from the filed purpose text (see classify in the ingest). */
export type Bucket =
  | "ads"
  | "fundraising"
  | "consulting"
  | "staff"
  | "fees"
  | "legal"
  | "mail"
  | "office"
  | "polling"
  | "events"
  | "travel"
  | "taxes"
  | "field"
  | "contributions"
  | "refunds"
  | "passthrough"
  | "other";

/** A vendor gets a page once members' campaigns and leadership PACs, over the cycles, paid it this much... */
export const VENDOR_MIN = 250_000;
/** ...from at least this many committees. */
export const VENDOR_MIN_PAYERS = 5;

/** The one line a campaign's payments to individuals (staff, by name in the filings) roll up into. */
export const STAFF_LABEL = "Staff and other individuals";

/** In display order, biggest buckets for a typical campaign first. */
export const BUCKETS: { key: Bucket; label: string; short: string }[] = [
  { key: "ads", label: "Advertising and media", short: "Ads" },
  { key: "fundraising", label: "Fundraising: consultants, direct mail, lists, texting", short: "Fundraising" },
  { key: "consulting", label: "Strategy and general consulting", short: "Consulting" },
  { key: "staff", label: "Payroll and staff", short: "Staff" },
  { key: "fees", label: "Payment processing and bank fees", short: "Fees" },
  { key: "legal", label: "Legal, compliance and accounting", short: "Legal" },
  { key: "mail", label: "Printing, mail and postage", short: "Printing" },
  { key: "office", label: "Rent, office and technology", short: "Office" },
  { key: "polling", label: "Polling and research", short: "Polling" },
  { key: "events", label: "Events and food", short: "Events" },
  { key: "travel", label: "Travel", short: "Travel" },
  { key: "field", label: "Canvassing and field", short: "Field" },
  { key: "taxes", label: "Taxes and filing fees", short: "Taxes" },
  { key: "contributions", label: "Contributions, sponsorships and transfers", short: "Contributions" },
  { key: "refunds", label: "Refunds", short: "Refunds" },
  { key: "passthrough", label: "Card and payroll payments not itemized", short: "Card payments" },
  { key: "other", label: "Unclear", short: "Other" },
];
export const BUCKET_LABEL = Object.fromEntries(BUCKETS.map((b) => [b.key, b.label])) as Record<Bucket, string>;
export const BUCKET_SHORT = Object.fromEntries(BUCKETS.map((b) => [b.key, b.short])) as Record<Bucket, string>;

const SUFFIX = /\b(INC|INCORPORATED|LLC|L ?L ?C|LTD|LIMITED|CORP|CORPORATION|CO|COMPANY|LP|L ?P|LLP|PLLC|PC|P ?C|PA|GROUP)\b\.?/g;

/**
 * One key per vendor across the spellings filers use: "AISLE 518 STRATEGIES
 * LLC" and "Aisle 518 Strategies, LLC." meet here. Legal suffixes, "DBA ..."
 * and a leading "The" go; "&" and digits stay.
 */
export function normalizeVendor(name: string) {
  return name
    .toUpperCase()
    .replace(/&AMP;/g, "&")
    .replace(/\bD\/?B\/?A\b.*$/, "")
    .replace(/[^A-Z0-9& ]+/g, " ")
    .replace(SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^THE /, "")
    .replace(/( ?&| AND)$/, "");
}

// Names title-casing gets wrong: brands with their own casing, and acronyms.
const BRANDS: Record<string, string> = {
  Actblue: "ActBlue", Winred: "WinRed", Ngp: "NGP", Van: "VAN", Skdknickerbocker: "SKDKnickerbocker", Skdk: "SKDK", Usps: "USPS",
  Dccc: "DCCC", Nrcc: "NRCC", Dscc: "DSCC", Nrsc: "NRSC", Gop: "GOP", Llc: "LLC", Mvar: "MVAR", Ax: "AX", Tag: "TAG", Hsp: "HSP",
  Mdi: "MDI", Rjc: "RJC", Cmdi: "CMDI", Dlcc: "DLCC", Pdp: "PDP", Adp: "ADP", Att: "AT&T", Usa: "USA", Dc: "DC", Nyc: "NYC",
  Fedex: "FedEx", Paypal: "PayPal", Youtube: "YouTube", Linkedin: "LinkedIn", Iheartmedia: "iHeartMedia", Mailchimp: "Mailchimp",
  Onmessage: "OnMessage", Al: "AL", Ezcater: "ezCater", Gmmb: "GMMB", Ngpvan: "NGP VAN", Cmg: "CMG", Dspolitical: "DSPolitical",
  Ebay: "eBay", Ipromote: "iPromote", Istock: "iStock", Mccann: "McCann", Mcdonald: "McDonald", Mckinsey: "McKinsey",
};
/** A vendor as filed, "ACTBLUE TECHNICAL SERVICES, LLC" -> "ActBlue Technical Services, LLC". */
export function vendorDisplayName(filed: string, titleCase: (s: string) => string) {
  const cased = filed === filed.toUpperCase() ? titleCase(filed.replace(/\s+/g, " ").trim()) : filed.replace(/\s+/g, " ").trim();
  return cased
    .replace(/\b[A-Z][a-z]+\b/g, (w) => BRANDS[w] ?? w)
    .replace(/,?\s+(Inc|LLC|L\.L\.C\.|Llc|Ltd|Corp|Co|Lp|L\.P\.|LLP|Llp|PLLC|Pllc|PC|P\.C\.)\.?$/i, "")
    .replace(/\s+(Inc|LLC|Llc)\.?(?=,|$)/g, "")
    .replace(/^The /, "");
}

/** The URL slug for a vendor key: "AISLE 518 STRATEGIES" -> "aisle-518-strategies". */
export function vendorSlug(key: string) {
  return key.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Short words in purposes that stay upper case when the rest is sentence-cased.
const KEEP = new Set(["TV", "IT", "FEC", "GOTV", "SMS", "P2P", "IRS", "ADA", "CPA", "PAC", "DC", "NY", "CA", "TX", "FL", "AV", "PO", "LLC", "ID", "VIP", "RSVP", "URL", "DJ", "PR", "HR", "JFC", "NRCC", "DCCC", "NRSC", "DSCC", "Q1", "Q2", "Q3", "Q4"]);

/** "MEDIA BUY - TV" as filed -> "Media buy - TV"; mixed-case text is kept. */
export function sentenceCase(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || t !== t.toUpperCase()) return t;
  return t
    .toLowerCase()
    .split(" ")
    .map((w, i) => {
      const up = w.toUpperCase();
      if (KEEP.has(up)) return up;
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w;
    })
    .join(" ");
}
