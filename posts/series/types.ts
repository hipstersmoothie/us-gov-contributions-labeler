/** A post a series wants made. The key is what makes it happen once. */
export interface Draft {
  /** Stable and unique across every series: "member-elect:2026:H6WY00217", "bsky:C001130". */
  key: string;
  series: SeriesName;
  text: string;
  /** Site path the post's link card points at: "/races/2026/wy-at-large/". */
  link: string;
  /** Overrides for the link card; otherwise the page's own og:title and og:description. */
  title?: string;
  description?: string;
  /** Text the linked page has to contain before this goes out, so a post never beats the site's deploy. */
  expect?: string;
  /** Handles mentioned in the text, with their DIDs. */
  mentions?: Record<string, string>;
  /** Lower goes first, within a series and across them. */
  priority: number;
}

export const SERIES = {
  "member-elect": { dailyCap: 4 },
  "new-on-bluesky": { dailyCap: 3 },
} as const;
export type SeriesName = keyof typeof SERIES;
