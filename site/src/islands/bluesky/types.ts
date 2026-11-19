// Row shapes for the Bluesky hub's islands. Short keys on the labels: cards
// are served per state from /data/bluesky/<state>.json.

export interface CardLabel {
  /** s = sector, c = contributor, d = donor makeup (small donors, home state) */
  k: "s" | "c" | "d";
  n: string;
  h?: string;
}

export interface CardRow {
  id: string;
  name: string;
  party: "D" | "R" | "I";
  chamber: "house" | "senate";
  state: string;
  seat: string;
  /** -1 for senators, 0 for at-large; for sorting. */
  district: number;
  /** The rest only for members on Bluesky. */
  handle?: string;
  avatar?: string;
  followers?: number;
  labels?: CardLabel[];
  /** Other accounts beyond the main one. */
  more?: number;
}

export interface Face {
  id?: string;
  name: string;
  party: "D" | "R" | "I";
  avatar?: string;
}
