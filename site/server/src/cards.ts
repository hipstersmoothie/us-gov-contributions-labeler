// The link-preview card templates: 1200×630, in the site's editorial style.
// Satori lays these out (flexbox only), so every element with more than one
// child is a flex container.
//
// Bluesky shows the card at roughly 350–600px wide, a third to a half of its
// drawn size, so nothing here is set smaller than 22px and the one number
// the card is about is the biggest thing on it. Party is never color alone:
// every party fill sits next to its letter or name.
import type { Bar, BillCard, CandidateCard, Card, CommitteeCard, CountryCard, DonorCard, MemberCard, OrgCard, PacCard, PageCard, Party, RaceCard, SectorCard, Split, Target, TravelCard } from "./types.ts";

export const WIDTH = 1200;
export const HEIGHT = 630;

// Light-theme tokens from global.css.
const C = {
  page: "#f9f9f7",
  text: "#121212",
  secondary: "#4f4e4a",
  muted: "#6b6a65",
  hairline: "#dfded8",
  grid: "#e9e8e2",
  bar: "#121212",
  barMuted: "#8a8983",
  context: "#d6d5ce",
  support: "#4a3aa7",
  oppose: "#eb6834",
  D: "#2a78d6",
  I: "#1baf7a",
  R: "#e34948",
} as const;
const SANS = "Libre Franklin";
const SERIF = "Source Serif 4";
const PARTY_NAMES: Record<Party, string> = { D: "Democrats", I: "Independents", R: "Republicans" };

export interface Assets {
  /** The wordmark as a data: URL. */
  logo: string;
  /** A member's portrait as a data: URL, if there is one. */
  photo?: string;
  cycleRange: string;
}

// --- a tiny element helper -------------------------------------------------------

type Style = Record<string, string | number>;
export interface Node {
  type: string;
  props: { style?: Style; children?: Child | Child[]; [k: string]: unknown };
}
type Child = Node | string | null | undefined | false;

function h(type: string, style: Style, ...children: Child[]): Node {
  const kids = children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false);
  const flex: Style = kids.length > 1 || kids.some((k) => typeof k !== "string") || style.alignItems || style.justifyContent ? { display: "flex" } : {};
  return { type, props: { style: { ...flex, ...style }, children: kids.length === 1 ? kids[0] : kids } };
}
const div = (style: Style, ...children: Child[]) => h("div", style, ...children);
const img = (src: string, style: Style): Node => ({ type: "img", props: { src, style, width: style.width, height: style.height } });
/** One line of text that ends in an ellipsis instead of overflowing. */
const line = (text: string, style: Style) =>
  div({ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", ...style }, text);

// --- formatting --------------------------------------------------------------------

export function money(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: Math.abs(n) >= 1000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(n) >= 1000 ? 1 : 0,
  }).format(n);
}
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
/** "More PAC money than 82% of senators", from the member's rank in their
 *  chamber. The percentage is always of the peers on the far side of them. */
function comparison(c: MemberCard) {
  const one = c.peers.replace(/s$/, "");
  if (c.rank === 1) return `The most PAC money of any ${one}`;
  if (c.rank === c.of) return `The least PAC money of any ${one}`;
  const above = (c.rank - 1) / (c.of - 1);
  if (above >= 0.4 && above <= 0.6) return `About as much PAC money as the typical ${one}`;
  return above < 0.5
    ? `More PAC money than ${Math.round((1 - above) * 100)}% of ${c.peers}`
    : `Less PAC money than ${Math.round(above * 100)}% of ${c.peers}`;
}
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// --- shared pieces ---------------------------------------------------------------------

function frame(assets: Assets, footLeft: string, body: Node, span = assets.cycleRange) {
  return div(
    { width: WIDTH, height: HEIGHT, flexDirection: "column", background: C.page, color: C.text, fontFamily: SANS },
    // The party split from the banner and the site card: the brand, not data.
    div({ height: 10, width: "100%" }, div({ flex: 1, background: C.D }), div({ flex: 1, background: C.R })),
    div({ flex: 1, flexDirection: "column", padding: "44px 64px 0" }, body),
    div(
      {
        margin: "0 64px",
        height: 84,
        borderTop: `1.5px solid ${C.hairline}`,
        alignItems: "center",
        justifyContent: "space-between",
      },
      img(assets.logo, { width: 247, height: 49 }),
      div({ fontSize: 22, fontWeight: 600, color: C.secondary }, `${footLeft}, ${span}`)
    )
  );
}

function kicker(text: string, extra?: Node) {
  return div(
    { alignItems: "center", gap: 14, marginBottom: 10 },
    extra,
    line(text.toUpperCase(), { fontSize: 22, fontWeight: 700, letterSpacing: "0.07em", color: C.secondary, maxWidth: 1000 })
  );
}

/** Serif headline that steps down in size as the name gets longer. */
function title(text: string, width: number, sizes: [number, number, number, number] = [68, 60, 50, 42]) {
  const n = text.length * (1072 / width);
  const size = n <= 24 ? sizes[0] : n <= 36 ? sizes[1] : n <= 60 ? sizes[2] : sizes[3];
  return div(
    {
      display: "block",
      fontFamily: SERIF,
      fontWeight: 600,
      fontSize: size,
      lineHeight: 1.08,
      letterSpacing: "-0.01em",
      lineClamp: 2,
      maxWidth: width,
    },
    text
  );
}

function partyChip(p: Party, size = 34) {
  return div(
    {
      display: "flex",
      width: size,
      height: size,
      borderRadius: 4,
      background: C[p],
      color: C.text,
      fontSize: size * 0.62,
      fontWeight: 800,
      alignItems: "center",
      justifyContent: "center",
    },
    p
  );
}

/** The big figure: "$4.2M", with what it is under it. */
function stat(value: string, label: string, sub?: string, size = 92) {
  return div(
    { flexDirection: "column" },
    div({ fontSize: size, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1 }, value),
    div({ display: "block", fontSize: 27, fontWeight: 500, color: C.secondary, marginTop: 12, lineHeight: 1.3, maxWidth: 380 }, label),
    sub ? div({ display: "block", fontSize: 24, fontWeight: 600, color: C.text, marginTop: 12, lineHeight: 1.3, maxWidth: 380 }, sub) : null
  );
}

function sectionLabel(text: string) {
  return div({ fontSize: 20, fontWeight: 700, letterSpacing: "0.07em", color: C.muted, marginBottom: 8 }, text.toUpperCase());
}

/** Ranked bars, labeled above, in the site's single-series black. */
function bars(rows: Bar[], width: number, opts: { rowHeight?: number; max?: number; format?: (n: number) => string } = {}) {
  const max = opts.max ?? Math.max(...rows.map((r) => r.value), 1);
  const rowH = opts.rowHeight ?? 74;
  return div(
    { flexDirection: "column", width },
    ...rows.map((r) =>
      div(
        { flexDirection: "column", height: rowH, justifyContent: "center" },
        div(
          { alignItems: "center", gap: 10 },
          r.party ? partyChip(r.party, 26) : null,
          line(r.label, { fontSize: 24, fontWeight: 600, maxWidth: width - (r.party ? 36 : 0) - (r.note ? 110 : 0) }),
          r.note ? div({ fontSize: 22, color: C.muted, fontWeight: 500 }, r.note) : null
        ),
        div(
          { alignItems: "center", marginTop: 6, gap: 10 },
          div({ width: Math.max(4, (r.value / max) * (width - 120)), height: 16, background: C.bar, borderRadius: "0 3px 3px 0" }),
          div({ fontSize: 22, color: C.secondary, fontWeight: 600 }, (opts.format ?? money)(r.value))
        )
      )
    )
  );
}

/** A 100% bar of money by recipient party, each part named in text under it. */
function splitBar(split: Split, width: number) {
  const total = split.D + split.I + split.R;
  const parts = (["D", "I", "R"] as Party[]).filter((p) => split[p] > 0);
  const share = (p: Party) => (split[p] / total < 0.01 ? "<1%" : `${pct(split[p], total)}%`);
  const label = (p: Party) => `${share(p)} ${PARTY_NAMES[p]}`;
  return div(
    { flexDirection: "column", width },
    div(
      { height: 30, width, borderRadius: 3, overflow: "hidden" },
      ...parts.map((p, i) =>
        div({ width: (split[p] / total) * width, height: 30, background: C[p], borderLeft: i ? `2px solid ${C.page}` : "none" })
      )
    ),
    div(
      { justifyContent: "space-between", marginTop: 10, fontSize: 24, fontWeight: 700 },
      split.D > 0 ? div({ alignItems: "center", gap: 8 }, partyChip("D", 26), label("D")) : div({}),
      // Independents sit between the ends, smaller, so the two big shares keep their room.
      split.I > 0 ? div({ alignItems: "center", gap: 8, fontSize: 21, fontWeight: 600, color: C.secondary }, partyChip("I", 22), `${share("I")} Ind.`) : null,
      split.R > 0 ? div({ alignItems: "center", gap: 8 }, label("R"), partyChip("R", 26)) : div({})
    )
  );
}

/** Spending for and against: violet supporting, orange opposing, both named. */
function outsideRows(rows: Target[], width: number) {
  const max = Math.max(...rows.flatMap((r) => [r.support, r.oppose]), 1);
  const barW = (v: number) => Math.max(v > 0 ? 4 : 0, (v / max) * (width - 300));
  const side = (v: number, color: string, word: string) =>
    v > 0
      ? div(
          { alignItems: "center", gap: 10, height: 26 },
          div({ fontSize: 20, fontWeight: 700, color: C.secondary, width: 112 }, word),
          div({ width: barW(v), height: 14, background: color, borderRadius: "0 3px 3px 0" }),
          div({ fontSize: 22, fontWeight: 600, color: C.secondary }, money(v))
        )
      : null;
  return div(
    { flexDirection: "column", width, gap: 14 },
    ...rows.map((r) =>
      div(
        { flexDirection: "column" },
        div({ gap: 10, alignItems: "baseline" }, line(r.label, { fontSize: 24, fontWeight: 600, maxWidth: width - 120 }), r.note ? div({ fontSize: 22, color: C.muted }, r.note) : null),
        side(r.support, C.support, "Supporting"),
        side(r.oppose, C.oppose, "Opposing")
      )
    )
  );
}

/** Header plus a left stat column and a right chart column. */
function twoColumn(head: Node, left: Node, right: Node | null, leftWidth = 400) {
  return div(
    { flexDirection: "column", flex: 1 },
    head,
    div({ flex: 1, alignItems: "center", gap: 56 }, div({ width: leftWidth, flexShrink: 0 }, left), right)
  );
}

// --- the templates -------------------------------------------------------------------------

function member(c: MemberCard, a: Assets) {
  const photoW = 236;
  const photoH = Math.round(photoW * (275 / 225));
  const colW = 1072 - photoW - 48;
  const portrait = a.photo
    ? img(a.photo, { width: photoW, height: photoH, objectFit: "cover", borderRadius: 4 })
    : div(
        { width: photoW, height: photoH, background: C.context, alignItems: "center", justifyContent: "center", fontFamily: SERIF, fontSize: 88, fontWeight: 600, color: C.secondary, borderRadius: 4 },
        c.name
          .split(" ")
          .filter((w) => /^[A-Z]/.test(w))
          .map((w) => w[0])
          .slice(0, 2)
          .join("")
      );
  const right = c.sectors.length
    ? div({ flexDirection: "column" }, sectionLabel("PAC money by sector"), bars(c.sectors.slice(0, 3), colW - 330 - 40))
    : null;
  return frame(
    a,
    "PAC contributions from FEC filings",
    div(
      { gap: 48, flex: 1 },
      div({ flexDirection: "column", paddingTop: 6 }, portrait),
      div(
        { flexDirection: "column", width: colW },
        kicker(`${c.partyName} · ${c.seat}`, partyChip(c.party)),
        title(c.name, colW, [64, 56, 48, 42]),
        div(
          { flex: 1, alignItems: "center", gap: 40 },
          div(
            { width: 330, flexShrink: 0 },
            stat(money(c.pac), "from PACs", c.pac > 0 ? comparison(c) : undefined, 84)
          ),
          right
        )
      )
    )
  );
}

function organization(c: OrgCard, a: Assets) {
  const right =
    c.total > 0
      ? div(
          { flexDirection: "column", gap: 26 },
          div({ flexDirection: "column" }, sectionLabel("Split by party"), splitBar(c.split, 600)),
          c.top.length ? div({ flexDirection: "column" }, sectionLabel("Top recipients"), recipients(c.top, 600)) : null
        )
      : null;
  return frame(
    a,
    "PAC contributions from FEC filings",
    twoColumn(
      div({ flexDirection: "column" }, kicker(["Organization", c.sector].filter(Boolean).join(" · ")), title(c.name, 1072)),
      stat(money(c.total), c.total > 0 ? `from its PACs to ${plural(c.members, "member", "members")} of Congress` : "from its PACs to current members of Congress"),
      right
    )
  );
}

/** Compact list of members with party letter, seat and amount. */
function recipients(rows: Bar[], width: number) {
  return div(
    { flexDirection: "column", width, gap: 8 },
    ...rows.map((r) =>
      div(
        { alignItems: "center", gap: 10, height: 34 },
        r.party ? partyChip(r.party, 26) : null,
        line(r.label, { fontSize: 24, fontWeight: 600, maxWidth: width - (r.party ? 36 : 0) - (r.note ? 150 : 0) - 110 }),
        r.note ? div({ fontSize: 22, color: C.muted }, r.note) : null,
        div({ flex: 1 }),
        div({ fontSize: 24, fontWeight: 600, color: C.secondary }, money(r.value))
      )
    )
  );
}

function pac(c: PacCard, a: Assets) {
  const outside = c.support + c.oppose;
  const sections: Node[] = [];
  if (c.total > 0) sections.push(div({ flexDirection: "column" }, sectionLabel(outside > 0 ? `Gave ${money(c.total)}, by party` : "Split by party"), splitBar(c.split, 600)));
  if (c.targets.length) {
    sections.push(
      div({ flexDirection: "column" }, sectionLabel("Outside spending on members"), outsideRows(c.targets.slice(0, c.total > 0 ? 1 : 2), 600))
    );
  }
  const left =
    outside > 0
      ? div(
          { flexDirection: "column", gap: 22 },
          stat(money(outside), "in outside spending on members of Congress", undefined, 84),
          div(
            { flexDirection: "column", gap: 6, fontSize: 24, fontWeight: 600 },
            c.support > 0 ? div({ alignItems: "center", gap: 10 }, div({ width: 18, height: 18, background: C.support, borderRadius: 2 }), `${money(c.support)} supporting`) : null,
            c.oppose > 0 ? div({ alignItems: "center", gap: 10 }, div({ width: 18, height: 18, background: C.oppose, borderRadius: 2 }), `${money(c.oppose)} opposing`) : null
          )
        )
      : c.opponents && c.total === 0
        ? stat(money(c.opponents.support + c.opponents.oppose), "spent in races against current members")
        : stat(money(c.total), c.total > 0 ? `to ${plural(c.members, "member", "members")} of Congress` : "to current members of Congress");
  return frame(
    a,
    outside > 0 ? "Contributions and outside spending from FEC filings" : "PAC contributions from FEC filings",
    twoColumn(
      div({ flexDirection: "column" }, kicker([c.kind, c.sector].filter(Boolean).join(" · ")), title(c.name, 1072)),
      left,
      sections.length ? div({ flexDirection: "column", gap: 24 }, ...sections) : null
    )
  );
}

function donor(c: DonorCard, a: Assets) {
  return frame(
    a,
    "Donations from FEC filings",
    twoColumn(
      div({ flexDirection: "column" }, kicker(c.about ? `Big donor · ${c.about}` : "Big donor"), title(c.name, 1072)),
      stat(money(c.total), `to ${plural(c.groups, "super PAC or outside group", "super PACs and outside groups")}`),
      c.gifts.length ? div({ flexDirection: "column" }, sectionLabel("Gave the most to"), bars(c.gifts.slice(0, 3), 600)) : null
    )
  );
}

function sector(c: SectorCard, a: Assets) {
  return frame(
    a,
    "PAC contributions from FEC filings",
    twoColumn(
      div({ flexDirection: "column" }, kicker("Sector"), title(c.name, 1072)),
      stat(money(c.total), `from ${plural(c.orgs, "organization's", "organizations'")} PACs to ${plural(c.members, "member", "members")} of Congress`),
      div(
        { flexDirection: "column", gap: 26 },
        div({ flexDirection: "column" }, sectionLabel("Split by party"), splitBar(c.split, 600)),
        c.top.length ? div({ flexDirection: "column" }, sectionLabel("Gave the most"), recipients(c.top, 600)) : null
      )
    )
  );
}

/** The committee's seats as a hemicycle, Democrats from the left. */
function hemicycleSvg(c: CommitteeCard, width: number) {
  const unit = width / 2.1;
  const r = Math.min(Math.max(4, c.gap * unit * 0.4), 16);
  const height = Math.round(unit * 1.02 + r + 8);
  const dots = c.seats
    .map((s) => {
      const cx = width / 2 + s.x * unit;
      const cy = height - r - 6 - s.y * unit;
      const ring = s.lead ? `<circle cx="${cx}" cy="${cy}" r="${r + 3.5}" fill="none" stroke="${C.text}" stroke-width="2.5"/>` : "";
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C[s.party]}" stroke="${C.page}" stroke-width="1.5"/>${ring}`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${dots}</svg>`;
  return img(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, { width, height });
}

function committee(c: CommitteeCard, a: Assets) {
  const n = c.seats.length;
  const peers = c.chamber === "Senate" ? "all senators" : c.chamber === "House" ? "all House members" : "all of Congress";
  const leanRows = c.lean
    ? div(
        { flexDirection: "column", gap: 6, marginTop: 22 },
        div({ display: "block", fontSize: 24, fontWeight: 600, lineHeight: 1.3 }, `Top sector: ${c.lean.sector}`),
        div({ display: "block", fontSize: 24, color: C.secondary, lineHeight: 1.3 }, `${Math.round(c.lean.share * 100)}% of members' PAC money, vs. ${Math.round(c.lean.base * 100)}% for ${peers}`)
      )
    : null;
  const W = 470;
  const chart =
    n > 1
      ? div(
          { flexDirection: "column", width: W },
          hemicycleSvg(c, W),
          div(
            { justifyContent: "space-between", marginTop: 12, fontSize: 24, fontWeight: 700 },
            c.counts.D ? div({ alignItems: "center", gap: 8 }, partyChip("D", 26), `${c.counts.D} ${c.counts.D === 1 ? "Democrat" : "Democrats"}`) : div({}),
            c.counts.R ? div({ alignItems: "center", gap: 8 }, `${c.counts.R} ${c.counts.R === 1 ? "Republican" : "Republicans"}`, partyChip("R", 26)) : div({})
          ),
          c.counts.I ? div({ justifyContent: "center", marginTop: 6, fontSize: 22, fontWeight: 600, color: C.secondary }, `and ${c.counts.I} ${c.counts.I === 1 ? "independent" : "independents"}`) : null
        )
      : null;
  return frame(
    a,
    "PAC contributions from FEC filings",
    twoColumn(
      div(
        { flexDirection: "column" },
        kicker(c.parent ? `Subcommittee · ${c.parent}` : `${c.chamber} committee · ${plural(n, "member", "members")}`),
        title(c.name, 1072, [60, 54, 46, 40])
      ),
      div({ flexDirection: "column" }, stat(money(c.total), `from PACs to its ${plural(n, "member", "members")}`, undefined, 84), leanRows),
      chart,
      500
    )
  );
}

/** A vote by party: a 100% bar per party, yes in black and no in gray, the
 *  same as the bill page. Party is named in text beside its letter. */
function voteRows(rows: BillCard["vote"]["rows"], width: number) {
  return div(
    { flexDirection: "column", width, gap: 16 },
    ...rows.map((r) => {
      const total = r.yes + r.no + r.other || 1;
      return div(
        { flexDirection: "column" },
        div(
          { alignItems: "center", gap: 10 },
          partyChip(r.party, 26),
          div({ fontSize: 24, fontWeight: 700 }, `${PARTY_NAMES[r.party]} ${r.yes}–${r.no}`),
          r.note ? div({ fontSize: 21, fontWeight: 500, color: C.muted }, r.note) : null
        ),
        div(
          { height: 22, width, marginTop: 8, borderRadius: 3, overflow: "hidden" },
          r.yes ? div({ width: (r.yes / total) * width, height: 22, background: C.bar }) : null,
          r.no ? div({ width: (r.no / total) * width, height: 22, background: C.barMuted, borderLeft: r.yes ? `2px solid ${C.page}` : "none" }) : null,
          r.other ? div({ width: (r.other / total) * width, height: 22, background: C.context, borderLeft: `2px solid ${C.page}` }) : null
        )
      );
    })
  );
}

function bill(c: BillCard, a: Assets) {
  const W = 560;
  const lobbying =
    c.top.length > 0
      ? div(
          { flexDirection: "column", marginTop: 22 },
          div({ fontSize: 24, fontWeight: 700 }, `${plural(c.lobbying, "organization", "organizations")} lobbied on it`),
          ...c.top.slice(0, 2).map((t) =>
            div(
              { alignItems: "center", gap: 10, marginTop: 6 },
              line(t.label, { fontSize: 23, fontWeight: 500, color: C.secondary, maxWidth: 300 }),
              div({ fontSize: 21, color: C.muted }, `${t.reports} ${t.reports === 1 ? "report" : "reports"}`)
            )
          )
        )
      : div({ fontSize: 24, fontWeight: 600, color: C.secondary, marginTop: 22 }, "No lobbying reports name it");
  return frame(
    a,
    "Votes and lobbying reports",
    twoColumn(
      div({ flexDirection: "column" }, kicker([c.label, c.policyArea].filter(Boolean).join(" · ")), title(c.name, 1072, [60, 54, 46, 40])),
      div(
        { flexDirection: "column" },
        div({ display: "block", fontSize: 50, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.05 }, c.status),
        div({ display: "block", fontSize: 24, fontWeight: 500, color: C.secondary, marginTop: 10, lineHeight: 1.3 }, `${c.vote.chamber} vote, ${c.vote.date}: ${c.vote.pattern.toLowerCase()}`),
        lobbying
      ),
      div(
        { flexDirection: "column" },
        sectionLabel(`${c.vote.chamber} vote by party · yes–no`),
        voteRows(c.vote.rows, W),
        div(
          { gap: 18, marginTop: 14, fontSize: 20, fontWeight: 600, color: C.secondary },
          div({ alignItems: "center", gap: 8 }, div({ width: 16, height: 16, background: C.bar, borderRadius: 2 }), "Yes"),
          div({ alignItems: "center", gap: 8 }, div({ width: 16, height: 16, background: C.barMuted, borderRadius: 2 }), "No"),
          div({ alignItems: "center", gap: 8 }, div({ width: 16, height: 16, background: C.context, borderRadius: 2 }), "Didn't vote")
        )
      ),
      430
    ),
    c.congress
  );
}

function country(c: CountryCard, a: Assets) {
  const W = 600;
  const right = c.principals.length
    ? div(
        { flexDirection: "column", width: W },
        sectionLabel("Principals and their US agents"),
        ...c.principals.slice(0, 4).map((p) =>
          div(
            { flexDirection: "column", borderTop: `1.5px solid ${C.hairline}`, paddingTop: 10, paddingBottom: 12 },
            line(p.label, { fontSize: 25, fontWeight: 600, maxWidth: W }),
            line(p.note, { fontSize: 22, color: C.muted, marginTop: 2, maxWidth: W })
          )
        )
      )
    : null;
  return frame(
    a,
    "Foreign agents from FARA filings",
    twoColumn(
      div({ flexDirection: "column" }, kicker("Foreign lobbying"), title(c.name, 1072)),
      stat(
        c.active.toLocaleString(),
        c.active === 1 ? "foreign principal with US agents registered now" : "foreign principals with US agents registered now",
        `${plural(c.registrants, "US registrant", "US registrants")}${c.ended ? ` · ${c.ended.toLocaleString()} ended` : ""}`
      ),
      right
    ),
    c.span
  );
}

function page(c: PageCard, a: Assets) {
  const W = 520;
  let right: Node | null = null;
  if (c.bars?.length) {
    right = div(
      { flexDirection: "column" },
      c.barsTitle ? sectionLabel(c.barsTitle) : null,
      c.bars.some((b) => b.party) ? recipients(c.bars, W) : bars(c.bars, W)
    );
  } else if (c.stats?.length) {
    right = div(
      { flexDirection: "column", gap: 18 },
      ...c.stats.map((s) =>
        div(
          { alignItems: "baseline", gap: 16, borderBottom: `1.5px solid ${C.hairline}`, paddingBottom: 12, width: W },
          div({ fontSize: 56, fontWeight: 800, width: 200, letterSpacing: "-0.02em" }, s.value),
          div({ fontSize: 26, fontWeight: 600, color: C.secondary }, s.label)
        )
      )
    );
  } else if (c.lines?.length) {
    right = div(
      { flexDirection: "column", gap: 22, width: W },
      ...c.lines.map((l) =>
        div(
          { flexDirection: "column", borderLeft: `5px solid ${C.bar}`, paddingLeft: 18 },
          div({ fontSize: 30, fontWeight: 800 }, l.strong),
          div({ display: "block", fontSize: 24, color: C.secondary, marginTop: 4, lineHeight: 1.3 }, l.text)
        )
      )
    );
  }
  return frame(
    a,
    c.foot ?? "Campaign finance from FEC filings",
    div(
      { flex: 1, gap: 56 },
      div(
        { flexDirection: "column", width: 1072 - W - 56, justifyContent: "center" },
        kicker(c.kicker),
        title(c.title, 1072 - W - 56, [60, 54, 50, 46]),
        div({ display: "block", fontFamily: SERIF, fontSize: 27, lineHeight: 1.35, color: C.secondary, marginTop: 20 }, c.dek)
      ),
      div({ flexDirection: "column", justifyContent: "center", flex: 1 }, right)
    ),
    c.span
  );
}

/** A sponsor's trips, or all of them: the count big, then whose offices. */
function travel(c: TravelCard, a: Assets) {
  const W = 520;
  const trips = (n: number) => `${n.toLocaleString()} ${n === 1 ? "trip" : "trips"}`;
  const right = c.bars?.length
    ? div({ flexDirection: "column" }, c.barsTitle ? sectionLabel(c.barsTitle) : null, bars(c.bars, W, { format: trips, rowHeight: 70 }))
    : null;
  const [first, ...rest] = c.stats;
  return frame(
    a,
    "Privately sponsored travel",
    div(
      { flex: 1, gap: 56 },
      div(
        { flexDirection: "column", width: right ? 1072 - W - 56 : 1072, justifyContent: "center" },
        kicker(c.kicker),
        title(c.title, right ? 1072 - W - 56 : 1072, [56, 50, 46, 40]),
        first ? div({ marginTop: 22 }, stat(first.value, first.label, undefined, 80)) : null,
        rest.length
          ? div(
              { gap: 28, marginTop: 18 },
              ...rest.map((s) =>
                div(
                  { flexDirection: "column" },
                  div({ fontSize: 36, fontWeight: 800, letterSpacing: "-0.01em" }, s.value),
                  div({ fontSize: 21, fontWeight: 600, color: C.secondary, marginTop: 2 }, s.label)
                )
              )
            )
          : null
      ),
      right ? div({ flexDirection: "column", justifyContent: "center", flex: 1 }, right) : null
    ),
    c.span
  );
}

/** A race: up to three candidates, each with what they raised and outside spending on them. */
function race(c: RaceCard, a: Assets) {
  const rows = c.candidates.slice(0, 3);
  const max = Math.max(...rows.map((r) => r.raised), 1);
  const width = 1072;
  const mini = (v: number, color: string, word: string) =>
    v > 0
      ? div(
          { alignItems: "center", gap: 8 },
          div({ width: 14, height: 14, background: color, borderRadius: 2 }),
          div({ fontSize: 21, fontWeight: 600, color: C.secondary, whiteSpace: "nowrap" }, `${money(v)} ${word}`)
        )
      : null;
  return frame(
    a,
    "Campaign money and outside spending from FEC filings",
    div(
      { flexDirection: "column", flex: 1 },
      kicker(c.kicker),
      title(c.name, width, [64, 56, 48, 42]),
      div({ display: "block", fontSize: 24, fontWeight: 600, color: C.secondary, marginTop: 10 }, c.status),
      div(
        { flexDirection: "column", flex: 1, justifyContent: "center", gap: rows.length > 2 ? 14 : 22 },
        ...rows.map((r) =>
          div(
            { flexDirection: "column" },
            div(
              { alignItems: "center", gap: 10 },
              r.party ? partyChip(r.party, 28) : null,
              line(r.label, { fontSize: 26, fontWeight: 700, maxWidth: 560 }),
              r.note ? div({ fontSize: 22, color: C.muted, fontWeight: 500 }, r.note) : null
            ),
            div(
              { alignItems: "center", gap: 14, marginTop: 6 },
              div({ width: Math.max(4, (r.raised / max) * 420), height: 16, background: C.bar, borderRadius: "0 3px 3px 0" }),
              div({ fontSize: 22, fontWeight: 600, color: C.secondary, whiteSpace: "nowrap" }, r.raised > 0 ? `${money(r.raised)} raised` : "No money reported"),
              mini(r.support, C.support, "for"),
              mini(r.oppose, C.oppose, "against")
            )
          )
        )
      )
    ),
    c.span
  );
}

/** A candidate who isn't a member: what they raised, by source. */
function candidate(c: CandidateCard, a: Assets) {
  const initials = c.name
    .split(" ")
    .filter((w) => /^[A-Z]/.test(w))
    .map((w) => w[0])
    .slice(0, 2)
    .join("");
  const colW = 1072 - 180 - 48;
  return frame(
    a,
    "Campaign money from FEC filings",
    div(
      { gap: 48, flex: 1 },
      div(
        { width: 180, height: 220, background: C.context, alignItems: "center", justifyContent: "center", fontFamily: SERIF, fontSize: 72, fontWeight: 600, color: C.secondary, borderRadius: 4, marginTop: 6 },
        initials
      ),
      div(
        { flexDirection: "column", width: colW },
        kicker(`${c.partyName} · ${c.seat}`, c.party ? partyChip(c.party) : undefined),
        title(c.name, colW, [64, 56, 48, 42]),
        div({ display: "block", fontSize: 24, fontWeight: 600, color: C.secondary, marginTop: 8 }, c.status),
        div(
          { flex: 1, alignItems: "center", gap: 40 },
          div({ width: 300, flexShrink: 0 }, stat(c.raised > 0 ? money(c.raised) : "–", "raised for the campaign", undefined, 84)),
          c.sources.some((s) => s.value > 0) ? div({ flexDirection: "column" }, sectionLabel("By source"), bars(c.sources.filter((s) => s.value > 0), colW - 300 - 40, { rowHeight: 66 })) : null
        )
      )
    ),
    c.span
  );
}

export function cardTree(card: Card, assets: Assets): Node {
  switch (card.type) {
    case "member":
      return member(card, assets);
    case "organization":
      return organization(card, assets);
    case "pac":
      return pac(card, assets);
    case "donor":
      return donor(card, assets);
    case "sector":
      return sector(card, assets);
    case "committee":
      return committee(card, assets);
    case "bill":
      return bill(card, assets);
    case "country":
      return country(card, assets);
    case "page":
      return page(card, assets);
    case "travel":
      return travel(card, assets);
    case "race":
      return race(card, assets);
    case "candidate":
      return candidate(card, assets);
  }
}

/** Alt text that says what the card shows, for og:image:alt. */
export function altText(card: Card): string {
  switch (card.type) {
    case "member":
      return `${card.name} (${card.party}), ${card.seat}: ${money(card.pac)} from PACs${card.sectors.length ? `, most from ${card.sectors.map((s) => s.label).slice(0, 2).join(" and ")}` : ""}.`;
    case "organization":
    case "sector": {
      const t = card.split.D + card.split.I + card.split.R;
      return `${card.name}: ${money(card.total)} to members of Congress, ${pct(card.split.D, t)}% to Democrats and ${pct(card.split.R, t)}% to Republicans.`;
    }
    case "pac":
      return `${card.name}: ${money(card.total)} to members of Congress${card.support + card.oppose ? `, ${money(card.support)} in outside spending supporting members and ${money(card.oppose)} opposing them` : ""}.`;
    case "donor":
      return `${card.name}: ${money(card.total)} to super PACs and outside groups${card.gifts[0] ? `, most to ${card.gifts[0].label}` : ""}.`;
    case "committee":
      return `${card.name}: ${card.counts.D} Democrats and ${card.counts.R} Republicans, who took ${money(card.total)} from PACs.`;
    case "bill":
      return `${card.label}, ${card.name}: ${card.status}. ${card.vote.chamber} vote by party: ${card.vote.rows
        .map((r) => `${PARTY_NAMES[r.party]} ${r.yes}–${r.no}`)
        .join(", ")}. ${card.lobbying.toLocaleString()} organizations reported lobbying on it.`;
    case "country":
      return `Foreign lobbying, ${card.name}: ${plural(card.active, "foreign principal", "foreign principals")} with US agents registered under FARA now, through ${plural(card.registrants, "registrant", "registrants")}.`;
    case "page":
      return `${card.title}. ${card.dek}`;
    case "travel":
      return `${card.title}: ${card.dek}`;
    case "race":
      return `${card.name}, ${card.kicker.replace(/ ·.*/, "")}: ${card.candidates.map((x) => `${x.label}${x.party ? ` (${x.party})` : ""} raised ${money(x.raised)}`).join("; ")}. ${card.status}.`;
    case "candidate":
      return `${card.name}${card.party ? ` (${card.party})` : ""}, ${card.seat}: raised ${money(card.raised)}. ${card.status}.`;
  }
}
