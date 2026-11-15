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
export function shortSector(name: string) {
  return name
    .replace("Finance, Insurance & Real Estate", "Finance & real estate")
    .replace("Communications & Technology", "Tech & communications")
    .replace("Energy & Natural Resources", "Energy")
    .replace("Ideological & Single-Issue", "Ideological")
    .replace("Party & Candidate Committees", "Party & candidates");
}

/** "Nancy Pelosi" -> "Pelosi", keeping suffixes off. */
export function surname(name: string) {
  return name.replace(/,? (Jr\.|Sr\.|II|III|IV)$/, "").split(" ").at(-1)!;
}
