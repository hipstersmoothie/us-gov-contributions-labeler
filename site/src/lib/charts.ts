// Chart specs for Observable Plot. Pure functions from data to Plot options,
// so the same spec renders at build time (static SVG, the no-JS fallback) and
// again in the browser at the container's width with the interactive tip.
//
// Colors are CSS custom properties from global.css, so one SVG follows the
// light/dark theme without re-rendering.
import * as Plot from "@observablehq/plot";
import { money, surname } from "./format";

export interface Ctx {
  width: number;
  /** Client render: add tip marks. */
  interactive: boolean;
}

export const PARTY_COLOR = { D: "var(--party-d)", I: "var(--party-i)", R: "var(--party-r)" } as const;
export const PARTY_NAME = { D: "Democrat", I: "Independent", R: "Republican" } as const;
type Party = keyof typeof PARTY_COLOR;

const FONT = "var(--sans)";

/** Shared chrome: transparent, editorial sans, recessive axes. */
function base(ctx: Ctx, extra: Plot.PlotOptions): Plot.PlotOptions {
  return {
    width: ctx.width,
    style: { fontFamily: FONT, fontSize: "12px", color: "var(--text-secondary)", background: "transparent", overflow: "visible" },
    ...extra,
  };
}

const halo = { stroke: "var(--page)", strokeWidth: 4, paintOrder: "stroke" } as const;
/** Plot's fontWeight is a constant, so emphasized rows get their own text mark. */
function weighted<T>(data: T[], strong: (d: T) => boolean, options: Plot.TextOptions, weights: [number, number] = [700, 500]) {
  return [
    Plot.text(data.filter(strong), { ...options, fontWeight: weights[0] }),
    Plot.text(data.filter((d) => !strong(d)), { ...options, fontWeight: weights[1] }),
  ];
}

/** Single-line labels that end in an ellipsis instead of running off a narrow chart. */
const fit = (px: number, fontSize = 13) => ({ lineWidth: Math.max(px, 40) / fontSize, textOverflow: "ellipsis" as const });
const tickMoney = (d: number) => (d === 0 ? "$0" : money(d, true));
const compactTicks = (w: number) => (w < 480 ? 4 : 7);

// --- beeswarm -----------------------------------------------------------------

export interface SwarmPoint {
  id: string;
  name: string;
  party: Party;
  /** Facet lane, e.g. "House" / "Senate" or a party name. */
  lane: string;
  value: number;
  detail: string;
  /** Highlighted (party color); others draw as gray context when `context` is set. */
  hi?: boolean;
  /** Profile to open when the dot is clicked. */
  href?: string;
}
export interface SwarmData {
  points: SwarmPoint[];
  lanes: string[];
  /** Point ids to label directly. */
  labels: string[];
  /** Draw a median rule per lane. */
  medians?: boolean;
  /** Gray out points that aren't `hi`. */
  context?: boolean;
  xLabel: string;
  /** Shared x maximum, so separate swarms (small multiples) line up. */
  xMax?: number;
}

function swarm(d: SwarmData, ctx: Ctx): Plot.PlotOptions {
  const narrow = ctx.width < 520;
  const r = narrow ? 2.4 : 3.3;
  const marginLeft = 8;
  const marginRight = narrow ? 12 : 24;
  const max = d.xMax ?? Math.max(...d.points.map((p) => p.value), 1);
  const plotWidth = ctx.width - marginLeft - marginRight;

  // Lane height from the densest column: dots in a 2r-wide bin pile up
  // roughly hexagonally, so ~1.8r of height per dot, split above and below.
  const laneHeight = (lane: string) => {
    const bins = new Map<number, number>();
    for (const p of d.points) {
      if (p.lane !== lane) continue;
      const b = Math.floor(((p.value / max) * plotWidth) / (2 * r));
      bins.set(b, (bins.get(b) ?? 0) + 1);
    }
    const peak = Math.max(...bins.values(), 1);
    return Math.max(peak * 2 * r * 0.95 + 4 * r, 40);
  };
  // The swarm is centered in its lane; 2 × 22px keeps the lane title and
  // median label clear of the dots.
  const laneH = Math.max(...d.lanes.map(laneHeight)) + 44;
  const height = laneH * d.lanes.length + 30;

  // In context mode the highlighted member is drawn larger, on top.
  const radius = (p: SwarmPoint) => (d.context && p.hi ? r * 1.9 : r);
  const sorted = [...d.points].sort((a, b) => Number(!!a.hi) - Number(!!b.hi));
  const fill = (p: SwarmPoint) => (d.context && !p.hi ? "var(--context)" : PARTY_COLOR[p.party]);
  // Direct labels: alternate above/below the dot when two would collide.
  const xPx = (v: number) => (v / max) * plotWidth;
  const placed = new Map<string, "above" | "below">();
  for (const lane of d.lanes) {
    const mine = d.points
      .filter((p) => p.lane === lane && d.labels.includes(p.id))
      .sort((a, b) => b.value - a.value);
    let last: { x: number; side: "above" | "below" } | undefined;
    for (const p of mine) {
      const side = last && last.x - xPx(p.value) < 120 && last.side === "above" ? "below" : "above";
      placed.set(p.id, side);
      last = { x: xPx(p.value), side };
    }
  }
  const label = (side: "above" | "below") => (p: SwarmPoint) =>
    placed.get(p.id) === side ? `${surname(p.name)} ${money(p.value, true)}` : null;
  const dodge = (o: Record<string, unknown>) =>
    Plot.dodgeY({ anchor: "middle", padding: 0.6, x: "value", fy: "lane", r: radius, ...o } as Plot.DodgeYOptions);

  const medians = d.medians
    ? d.lanes.map((lane) => {
        const v = d.points.filter((p) => p.lane === lane).map((p) => p.value).sort((a, b) => a - b);
        return { lane, value: v[Math.floor(v.length / 2)] ?? 0 };
      })
    : [];

  return base(ctx, {
    height,
    marginLeft,
    marginRight,
    marginTop: 4,
    marginBottom: 26,
    x: { domain: [0, max], nice: true, label: null, tickFormat: tickMoney, ticks: compactTicks(ctx.width) },
    fy: { domain: d.lanes, axis: null, padding: 0.08 },
    marks: [
      Plot.gridX({ stroke: "var(--grid)", strokeOpacity: 1, ticks: compactTicks(ctx.width) }),
      Plot.axisX({ ticks: compactTicks(ctx.width), tickFormat: tickMoney, tickSize: 0, tickPadding: 8 }),
      Plot.text(d.lanes, {
        fy: (l) => l,
        frameAnchor: "top-left",
        text: (l) => l.toUpperCase(),
        fontWeight: 700,
        fontSize: 11,
        fill: "var(--text-primary)",
        dx: 2,
        dy: 2,
        ...halo,
      }),
      Plot.text(medians, {
        x: "value",
        fy: "lane",
        frameAnchor: "top",
        dy: 4,
        dx: 4,
        textAnchor: "start",
        text: (m) => `Median ${money(m.value, true)}`,
        fill: "var(--text-secondary)",
        fontSize: 11,
        ...halo,
      }),
      Plot.dot(
        sorted,
        dodge({
          fill,
          stroke: "var(--page)",
          strokeWidth: (p: SwarmPoint) => (p.hi && d.context ? 2 : 0.75),
          channels: { Member: "name", Detail: "detail", Amount: (p: SwarmPoint) => money(p.value) },
          tip: ctx.interactive
            ? { format: { x: false, fy: false, r: false, fill: false, stroke: false, strokeWidth: false, Member: true, Detail: true, Amount: true } }
            : undefined,
        })
      ),
      Plot.ruleX(medians, { x: "value", fy: "lane", stroke: "var(--text-primary)", strokeWidth: 1, insetTop: 18, insetBottom: 4 }),
      // Same dodge over the same points, so each label lands on its dot.
      ...(["above", "below"] as const).map((side) =>
        Plot.text(
          sorted,
          dodge({
            text: label(side),
            textAnchor: "end",
            lineAnchor: side === "above" ? "bottom" : "top",
            dx: -2,
            dy: side === "above" ? -r * 1.9 - 2 : r * 1.9 + 2,
            fill: "var(--text-primary)",
            fontWeight: 600,
            fontSize: 12,
            ...halo,
          })
        )
      ),
    ],
  });
}

// --- ranked bars (one series) ---------------------------------------------------

export interface BarRow {
  label: string;
  value: number;
  href?: string;
  note?: string;
}
export interface BarsData {
  rows: BarRow[];
  /** Row indexes drawn in the emphasis ink and labeled in bold. */
  emphasize?: number[];
  /** Denominator for the "% of total" in the tooltip. */
  total?: number;
}

function bars(d: BarsData, ctx: Ctx): Plot.PlotOptions {
  const rows = d.rows.map((r, i) => ({ ...r, i, em: d.emphasize?.includes(i) ?? false }));
  const step = 38;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const ys = rows.map((r) => r.i);
  return base(ctx, {
    height: rows.length * step + 4,
    marginTop: 4,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    x: { domain: [0, max * (ctx.width < 480 ? 1.32 : 1.18)], axis: null },
    y: { domain: ys, axis: null, paddingInner: 0, paddingOuter: 0 },
    marks: [
      // Label above the bar (reads like a news table, and long names never get squeezed).
      ...weighted(rows, (r) => r.em, {
        x: 0,
        y: "i",
        dy: -1,
        lineAnchor: "bottom",
        textAnchor: "start",
        text: (r: (typeof rows)[number]) => (r.note ? `${r.label}  ·  ${r.note}` : r.label),
        href: "href",
        fill: "var(--text-primary)",
        fontSize: 13,
        ...fit(ctx.width - 8),
      }),
      Plot.barX(rows, {
        x: "value",
        y: "i",
        insetTop: step / 2 + 3,
        insetBottom: 5,
        fill: (r) => (r.em ? "var(--bar-strong)" : "var(--bar)"),
        rx2: 3,
        channels: { Name: "label", Amount: (r) => money(r.value) },
        tip: ctx.interactive
          ? {
              format: { x: false, y: false, fill: false, Name: true, Amount: true },
              ...(d.total ? { channels: { Share: (r: BarRow) => `${Math.round((r.value / d.total!) * 100)}%` } } : {}),
            }
          : undefined,
      }),
      Plot.text(rows, {
        x: "value",
        y: "i",
        dy: 9,
        dx: 5,
        textAnchor: "start",
        text: (r) => money(r.value, true),
        fill: "var(--text-secondary)",
        fontVariant: "tabular-nums",
        fontSize: 12,
      }),
    ],
  });
}

// --- stacked bars -----------------------------------------------------------------

export interface StackSeries {
  key: string;
  label: string;
  color: string;
  /** Ink for a label set inside this fill. */
  ink: string;
}
export interface StackedData {
  series: StackSeries[];
  rows: { label: string; href?: string; values: Record<string, number> }[];
  /** "share": every bar fills 100%. "amount": bars share one money scale. */
  mode: "share" | "amount";
  /** Print each segment's share inside it where it fits (default true). */
  insideLabels?: boolean;
}

function stacked(d: StackedData, ctx: Ctx): Plot.PlotOptions {
  const narrow = ctx.width < 520;
  const flat = d.rows.flatMap((row, i) => {
    const total = d.series.reduce((s, x) => s + (row.values[x.key] ?? 0), 0);
    return d.series.map((s) => ({
      i,
      row: row.label,
      href: row.href,
      key: s.key,
      series: s.label,
      color: s.color,
      ink: s.ink,
      value: row.values[s.key] ?? 0,
      total,
      share: total ? (row.values[s.key] ?? 0) / total : 0,
    }));
  });
  const totals = d.rows.map((row, i) => ({ i, total: flat.filter((f) => f.i === i).reduce((s, f) => s + f.value, 0) }));
  const max = Math.max(...totals.map((t) => t.total), 1);
  const step = d.mode === "share" ? 48 : 40;
  const plotW = ctx.width - (narrow ? 50 : 70);
  const xMax = d.mode === "share" ? 1 : max;
  const xField = d.mode === "share" ? "share" : "value";
  const stackOpts = { x: xField, y: "i", z: "key", order: d.series.map((s) => s.key) } as const;

  // Inside-segment labels only where they fit with padding; the tooltip and
  // table carry the rest.
  const inside = (f: (typeof flat)[number]) => {
    if (d.insideLabels === false) return null;
    const px = ((d.mode === "share" ? f.share : f.value) / xMax) * plotW;
    const text = `${Math.round(f.share * 100)}%`;
    return px > text.length * 7.5 + 14 ? text : null;
  };

  return base(ctx, {
    height: d.rows.length * step + 4,
    marginTop: 4,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: d.mode === "amount" ? (narrow ? 50 : 70) : 0,
    x: { domain: [0, xMax], axis: null },
    y: { domain: d.rows.map((_, i) => i), axis: null, paddingInner: 0, paddingOuter: 0 },
    marks: [
      Plot.text(d.rows, {
        x: 0,
        y: (_, i) => i,
        dy: 19 - step / 2,
        lineAnchor: "bottom",
        textAnchor: "start",
        text: "label",
        href: "href",
        fill: "var(--text-primary)",
        fontWeight: 500,
        fontSize: 13,
        ...fit(ctx.width - 8),
      }),
      Plot.barX(
        flat,
        Plot.stackX({
          ...stackOpts,
          fill: "color",
          insetTop: 23,
          insetBottom: step - 23 - (d.mode === "share" ? 22 : 14),
          insetLeft: 1,
          insetRight: 1,
          channels: { Group: "row", Series: "series", Amount: (f) => money(f.value), Share: (f) => `${Math.round(f.share * 100)}%` },
          tip: ctx.interactive
            ? { format: { x: false, y: false, z: false, fill: false, Group: true, Series: true, Amount: true, Share: true } }
            : undefined,
        })
      ),
      Plot.text(
        flat,
        Plot.stackX({
          ...stackOpts,
          dy: d.mode === "share" ? 12 : 10,
          text: inside,
          fill: "ink",
          fontSize: 11,
          fontWeight: 600,
        })
      ),
      ...(d.mode === "amount"
        ? [
            Plot.text(totals, {
              x: "total",
              y: "i",
              dy: 10,
              dx: 6,
              textAnchor: "start",
              text: (t) => money(t.total, true),
              fill: "var(--text-secondary)",
              fontSize: 12,
            }),
          ]
        : []),
    ],
  });
}

// --- dumbbell: committee vs Congress ---------------------------------------------

export interface DumbbellData {
  rows: { label: string; href?: string; a: number; b: number }[];
  aLabel: string;
  bLabel: string;
}

function dumbbell(d: DumbbellData, ctx: Ctx): Plot.PlotOptions {
  const narrow = ctx.width < 520;
  const step = 38;
  const rows = d.rows.map((r, i) => ({ ...r, i }));
  const max = Math.max(...rows.flatMap((r) => [r.a, r.b]), 0.01);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const ticks = narrow ? 4 : 6;
  const marginRight = narrow ? 40 : 54;
  const xPx = (v: number) => (v / max) * (ctx.width - 12 - marginRight);
  type Row = (typeof rows)[number];
  const valueStyle = { fill: "var(--text-primary)", fontSize: 12, ...halo } as const;
  const dot = (key: "a" | "b") => ({
    x: key,
    y: "i",
    r: 5,
    dy: 9,
    channels: { Sector: "label", [d.aLabel]: (r: (typeof rows)[number]) => pct(r.a), [d.bLabel]: (r: (typeof rows)[number]) => pct(r.b) },
    tip: ctx.interactive ? { format: { x: false, y: false, Sector: true, [d.aLabel]: true, [d.bLabel]: true } } : undefined,
  });
  return base(ctx, {
    height: rows.length * step + 30,
    marginTop: 4,
    marginBottom: 26,
    marginLeft: 12,
    marginRight,
    x: { domain: [0, max], nice: true, label: null, tickFormat: (v: number) => pct(v), ticks },
    y: { domain: rows.map((r) => r.i), axis: null, paddingInner: 0, paddingOuter: 0 },
    marks: [
      Plot.gridX({ stroke: "var(--grid)", strokeOpacity: 1, ticks }),
      Plot.axisX({ ticks, tickFormat: (v: number) => pct(v), tickSize: 0, tickPadding: 8 }),
      ...weighted(rows, (r) => r.i === 0, {
        frameAnchor: "left",
        y: "i",
        dy: -1,
        lineAnchor: "bottom",
        textAnchor: "start",
        text: "label",
        href: "href",
        fill: "var(--text-primary)",
        fontSize: 13,
        ...fit(ctx.width - marginRight - 12),
        ...halo,
      }),
      Plot.link(rows, { x1: "b", x2: "a", y1: "i", y2: "i", dy: 9, stroke: "var(--baseline)", strokeWidth: 2 }),
      Plot.dot(rows, { ...dot("b"), fill: "var(--page)", stroke: "var(--text-muted)", strokeWidth: 2 }),
      Plot.dot(rows, { ...dot("a"), fill: "var(--bar-strong)", stroke: "var(--page)", strokeWidth: 2 }),
      // The committee value sits beside the filled dot, on its outer side.
      ...weighted(
        rows.filter((r) => r.a >= r.b || xPx(r.a) < 44),
        (r) => r.i === 0,
        { x: (r: Row) => Math.max(r.a, r.b), y: "i", dy: 9, dx: 10, textAnchor: "start", text: (r: Row) => pct(r.a), ...valueStyle },
        [700, 400]
      ),
      ...weighted(
        rows.filter((r) => r.a < r.b && xPx(r.a) >= 44),
        (r) => r.i === 0,
        { x: "a", y: "i", dy: 9, dx: -10, textAnchor: "end", text: (r: Row) => pct(r.a), ...valueStyle },
        [700, 400]
      ),
      // Callout on the biggest sector, when there's room.
      ...(!narrow && rows[0] && rows[0].a > rows[0].b
        ? [
            Plot.text([rows[0]], {
              x: "a",
              y: "i",
              dy: -1,
              lineAnchor: "bottom",
              textAnchor: "end",
              text: (r) => `${pct(r.a)} of committee members' PAC money, vs. ${pct(r.b)} for ${d.bLabel === "Congress" ? "Congress" : `the ${d.bLabel}`}`,
              fill: "var(--text-primary)",
              fontSize: 12,
              fontStyle: "italic",
              ...halo,
            }),
          ]
        : []),
    ],
  });
}

// --- histogram small multiples ------------------------------------------------------

export interface HistData {
  points: SwarmPoint[];
  lanes: string[];
  /** What a count means, e.g. "members". */
  unit: string;
}

/** A 1-2-5 step that gives roughly `n` bins over [0, max]. */
function niceStep(max: number, n: number) {
  const raw = max / n;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow;
}

function histogram(d: HistData, ctx: Ctx): Plot.PlotOptions {
  const narrow = ctx.width < 520;
  const max = Math.max(...d.points.map((p) => p.value), 1);
  const step = niceStep(max, narrow ? 8 : 14);
  // Bins are [a, b): a gift of exactly $25,000 counts in the $25K–$27.5K bin.
  const thresholds = Array.from({ length: Math.ceil(max / step) + 2 }, (_, i) => i * step);
  const medians = d.lanes.map((lane) => {
    const v = d.points.filter((p) => p.lane === lane).map((p) => p.value).sort((a, b) => a - b);
    return { lane, value: v[Math.floor(v.length / 2)] ?? 0 };
  });
  const opts = { x: "value", fy: "lane", fill: (p: SwarmPoint) => PARTY_COLOR[p.party], thresholds } as const;
  return base(ctx, {
    height: d.lanes.length * 120 + 30,
    marginTop: 4,
    marginLeft: 0,
    marginRight: 8,
    marginBottom: 26,
    x: { domain: [0, thresholds.at(-1)!], label: null, tickFormat: tickMoney, ticks: compactTicks(ctx.width) },
    y: { axis: null, insetTop: 34 },
    fy: { domain: d.lanes, axis: null, padding: 0.1 },
    marks: [
      Plot.axisX({ ticks: compactTicks(ctx.width), tickFormat: tickMoney, tickSize: 0, tickPadding: 8 }),
      Plot.ruleY([0], { stroke: "var(--baseline)" }),
      Plot.rectY(
        d.points,
        Plot.binX<Plot.RectYOptions>(
          { y: "count" },
          {
            ...opts,
            insetLeft: 1,
            insetRight: 1,
            tip: ctx.interactive
              ? { format: { fill: false, fy: false, x: (x: number) => money(x, true), y: (n: number) => `${n} ${d.unit}` } }
              : undefined,
          }
        )
      ),
      Plot.text(
        d.points,
        Plot.binX<Plot.TextOptions>(
          { y: "count", text: "count" },
          { x: "value", fy: "lane", thresholds, dy: -7, fill: "var(--text-secondary)", fontSize: 11, fontVariant: "tabular-nums" }
        )
      ),
      Plot.text(d.lanes, {
        fy: (l) => l,
        frameAnchor: "top-left",
        text: (l) => l.toUpperCase(),
        fontWeight: 700,
        fontSize: 11,
        fill: "var(--text-primary)",
        dy: 2,
        ...halo,
      }),
      Plot.ruleX(medians, { x: "value", fy: "lane", stroke: "var(--text-primary)", insetTop: 18 }),
      Plot.text(medians, {
        x: "value",
        fy: "lane",
        frameAnchor: "top",
        dy: 4,
        dx: 4,
        textAnchor: "start",
        text: (m) => `Median ${money(m.value, true)}`,
        fill: "var(--text-secondary)",
        fontSize: 11,
        ...halo,
      }),
    ],
  });
}

// --- diverging: support vs. oppose -------------------------------------------------

export interface DivergingData {
  rows: { label: string; href?: string; support: number; oppose: number }[];
}

function diverging(d: DivergingData, ctx: Ctx): Plot.PlotOptions {
  const narrow = ctx.width < 520;
  const step = 40;
  const rows = d.rows.map((r, i) => ({ ...r, i }));
  const max = Math.max(...rows.flatMap((r) => [r.support, r.oppose]), 1);
  const pad = narrow ? 1.45 : 1.25;
  const tip = (side: "support" | "oppose") =>
    ctx.interactive
      ? {
          channels: { Spender: "label", [side === "support" ? "Supporting" : "Opposing"]: (r: (typeof rows)[number]) => money(r[side]) },
          tip: { format: { x: false, y: false, Spender: true, Supporting: true, Opposing: true } },
        }
      : {};
  const value = (side: "support" | "oppose") =>
    Plot.text(
      rows.filter((r) => r[side] > 0),
      {
        x: (r) => (side === "support" ? r.support : -r.oppose),
        y: "i",
        dy: 9,
        dx: side === "support" ? 5 : -5,
        textAnchor: side === "support" ? "start" : "end",
        text: (r) => money(r[side], true),
        fill: "var(--text-secondary)",
        fontSize: 12,
      }
    );
  return base(ctx, {
    height: rows.length * step + 28,
    marginTop: 26,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    x: { domain: [-max * pad, max * pad], axis: null },
    y: { domain: rows.map((r) => r.i), axis: null, paddingInner: 0, paddingOuter: 0 },
    marks: [
      ...(["oppose", "support"] as const).map((side) =>
        Plot.text([side === "support" ? "SUPPORTING →" : "← OPPOSING"], {
          x: 0,
          dx: side === "support" ? 8 : -8,
          frameAnchor: "top",
          dy: -22,
          textAnchor: side === "support" ? "start" : "end",
          text: (t) => t,
          fontWeight: 700,
          fontSize: 11,
          fill: "var(--text-secondary)",
        })
      ),
      Plot.ruleX([0], { stroke: "var(--baseline)" }),
      Plot.text(rows, {
        x: 0,
        y: "i",
        dy: -1,
        lineAnchor: "bottom",
        textAnchor: "middle",
        text: "label",
        href: "href",
        fill: "var(--text-primary)",
        fontWeight: 500,
        fontSize: 13,
        ...fit(ctx.width - 8),
        ...halo,
      }),
      Plot.barX(rows, { x1: 0, x2: (r) => -r.oppose, y: "i", insetTop: 23, insetBottom: 3, fill: "var(--oppose)", rx1: 3, ...tip("oppose") }),
      Plot.barX(rows, { x1: 0, x2: "support", y: "i", insetTop: 23, insetBottom: 3, fill: "var(--support)", rx2: 3, ...tip("support") }),
      value("support"),
      value("oppose"),
    ],
  });
}

/** Plot labels each mark's <g> with its type ("dot", "bar"): noise to a screen
 *  reader, and not valid ARIA on a role-less <g>. The figure carries the label. */
export function stripMarkLabels(root: Element) {
  for (const g of root.querySelectorAll("g[aria-label]")) g.removeAttribute("aria-label");
}

export const charts = { swarm, bars, stacked, dumbbell, histogram, diverging } as const;
export type ChartName = keyof typeof charts;
