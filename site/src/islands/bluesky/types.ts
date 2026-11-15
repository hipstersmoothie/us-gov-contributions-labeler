// Row shapes for the Bluesky hub's islands. Short keys on the labels: every
// member's card is serialized into the hub page.

export interface CardLabel {
  /** s = sector, c = contributor */
  k: "s" | "c";
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
