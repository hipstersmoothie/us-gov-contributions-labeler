// Link-preview images. The build doesn't render them: scripts/og-cards.ts
// writes one small card record per page (server/data/cards.json, before
// `astro build`), and site/server renders a card into a PNG the first time a
// crawler asks for it.
//
// The URL carries a hash of the cards' contents and templates, so a build with
// new numbers, names or a new design gets new URLs and each image can be cached
// forever.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { altText } from "../../server/src/cards.ts";
import type { Card, CardsFile } from "../../server/src/types.ts";

const TEMPLATE_DIR = path.resolve(process.cwd(), "server/src");
const CARDS_FILE = path.resolve(process.cwd(), "server/data/cards.json");

/** Hash of everything a card image is drawn from: the cards, and the code that draws them. */
export function ogVersion(cards: CardsFile["cards"]) {
  const hash = crypto.createHash("sha256").update(JSON.stringify(cards));
  for (const file of fs.readdirSync(TEMPLATE_DIR).sort()) hash.update(fs.readFileSync(path.join(TEMPLATE_DIR, file)));
  return hash.digest("hex").slice(0, 10);
}

export type OgType = Card["type"];

// Without cards.json (`astro dev` before a build) every page uses the site card.
const file: CardsFile | undefined = fs.existsSync(CARDS_FILE) ? JSON.parse(fs.readFileSync(CARDS_FILE, "utf8")) : undefined;

/** A page's preview image and its alt text, if it has a card. */
export function ogImage(type: OgType, id: string) {
  const card = file?.cards[`${type}/${id}`];
  if (!file || !card) return undefined;
  return { src: `/og/${file.version}/${type}/${encodeURIComponent(id)}.png`, alt: altText(card) };
}
