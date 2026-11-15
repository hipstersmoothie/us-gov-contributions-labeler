// Pure formatters, shared by build-time pages and client-side charts.

export function money(amount: number, compact = false) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: compact && Math.abs(amount) >= 1000 ? 1 : 0,
    notation: compact ? "compact" : "standard",
  }).format(amount);
}

/** Table figures: exact under $100K, compact above, so columns stay narrow. */
export const moneyAuto = (amount: number) => money(amount, Math.abs(amount) >= 100_000);

export function percent(part: number, whole: number) {
  if (!whole) return "–";
  const pct = (part / whole) * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

/** "Finance, Insurance & Real Estate" reads fine; a few labels need a shorter form in charts. */
export { shortSector } from "../../../src/lib/labels.ts";

/** "Nancy Pelosi" -> "Pelosi", keeping suffixes off. */
export function surname(name: string) {
  return name.replace(/,? (Jr\.|Sr\.|II|III|IV)$/, "").split(" ").at(-1)!;
}

/** FEC candidate names, "OZ, MEHMET DR" -> "Mehmet Oz", "JOHNSON, RONALD EDWARD MR II" -> "Ronald Edward Johnson II". */
export function candidateName(raw: string) {
  const [last = "", rest = ""] = raw.split(",").map((s) => s.trim());
  const tokens = rest.split(/\s+/).filter(Boolean);
  const isSuffix = (t: string) => /^(JR|SR|II|III|IV)\.?$/i.test(t);
  const isTitle = (t: string) => /^(MR|MRS|MS|DR|SEN|REP|HON|GOV|REV)\.?$/i.test(t);
  const titleCase = (w: string) =>
    w.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase()).replace(/\bMc([a-z])/g, (_, c: string) => "Mc" + c.toUpperCase());
  const first = tokens.filter((t) => !isSuffix(t) && !isTitle(t)).map(titleCase);
  const suffix = tokens.filter(isSuffix).map((t) => (/^(jr|sr)/i.test(t) ? titleCase(t.replace(/\.?$/, ".")) : t.toUpperCase()));
  return [...first, titleCase(last), ...suffix].join(" ").replace(/\s+/g, " ").trim() || raw;
}

/** FEC party codes as a tag letter, where one applies. */
export const partyCode = (code?: string) => ({ DEM: "D", REP: "R", IND: "I", NPA: "I", UN: "I" } as Record<string, string>)[code ?? ""];
