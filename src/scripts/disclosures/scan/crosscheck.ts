// Cross-check trades against the same member's year-end holdings: a company
// whose last 2025 trade was a full sale shouldn't be held on December 31, and
// one last bought should be. E-filed members give the baseline (how often this
// holds when the data is right; partial lots, other accounts and funds blur
// it), so machine-read trades can be judged against that rather than 100%.
//
//   tsx src/scripts/disclosures/scan/crosscheck.ts
import fs from "fs";

interface Row { cik?: number; kind: string; date: string; tx: string; owner: string; scanned?: boolean; name: string; docUrl: string }
const data = JSON.parse(fs.readFileSync("site/src/data/holdings.json", "utf8")) as {
  members: Record<string, { holdings: { cik?: number; kind: string; min: number; owner: string }[]; trades: Row[]; annual?: unknown }>;
};

const tally = { efiled: { agree: 0, total: 0 }, scanned: { agree: 0, total: 0 } };
const contradictions: { bioguide: string; name: string; tx: string; date: string; docUrl: string }[] = [];
for (const [bioguide, m] of Object.entries(data.members)) {
  if (!m.annual || !m.holdings.length) continue;
  // Per owner: families often hold the same stock in several accounts (a
  // spouse's, a child's trust), and a sale in one says nothing about another.
  const key = (cik: number | undefined, owner: string) => `${cik}:${owner}`;
  const held = new Set(m.holdings.filter((h) => h.cik && h.min > 0).map((h) => key(h.cik, h.owner)));
  // The last trade in 2025 per company and owner, single-company stock only.
  const last = new Map<string, Row>();
  for (const t of m.trades.filter((t) => t.cik && t.kind === "stock" && t.date >= "2025-01-01" && t.date <= "2025-12-31")) {
    const prev = last.get(key(t.cik, t.owner));
    if (!prev || t.date >= prev.date) last.set(key(t.cik, t.owner), t);
  }
  for (const t of last.values()) {
    const expectHeld = t.tx === "Bought" ? true : t.tx === "Sold" ? false : undefined;
    if (expectHeld === undefined) continue; // partial sales and exchanges say nothing either way
    const bucket = t.scanned ? tally.scanned : tally.efiled;
    bucket.total++;
    if (held.has(key(t.cik, t.owner)) === expectHeld) bucket.agree++;
    else if (t.scanned) contradictions.push({ bioguide, name: t.name, tx: t.tx, date: t.date, docUrl: t.docUrl });
  }
}
const pct = (b: { agree: number; total: number }) => `${b.agree} of ${b.total} (${((b.agree / b.total) * 100).toFixed(1)}%)`;
console.log(`last 2025 trade agrees with year-end holdings: e-filed ${pct(tally.efiled)}; machine-read ${pct(tally.scanned)}`);
fs.writeFileSync(".cache/disclosures/scan/contradictions.json", JSON.stringify(contradictions, null, 1));
console.log(`${contradictions.length} machine-read trades contradict year-end holdings (saved for review)`);
