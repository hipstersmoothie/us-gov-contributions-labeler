// Card data -> PNG: satori lays the card out as SVG with the site's fonts,
// resvg rasterizes it.
import fs from "node:fs";
import path from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { cardTree, HEIGHT, WIDTH, type Assets } from "./cards.ts";
import type { Card, CardsFile } from "./types.ts";

const SERVER_DIR = path.resolve(import.meta.dirname, "..");

// Static instances of the site's variable fonts (satori can't read variable
// fonts or WOFF2), cut with fontTools from site/public/fonts.
type Weight = 400 | 500 | 600 | 700 | 800;
const FONTS: { name: string; file: string; weights: Weight[] }[] = [
  { name: "Libre Franklin", file: "libre-franklin", weights: [400, 500, 600, 700, 800] },
  { name: "Source Serif 4", file: "source-serif-4", weights: [400, 600, 700] },
];
const fonts = FONTS.flatMap((f) =>
  f.weights.flatMap((weight) =>
    ["latin", "latin-ext"].map((subset) => ({
      name: f.name,
      weight,
      style: "normal" as const,
      data: fs.readFileSync(path.join(SERVER_DIR, "fonts", `${f.file}-${subset}-${weight}.woff`)),
    }))
  )
);

export interface Renderer {
  version: string;
  card(key: string): Card | undefined;
  render(card: Card): Promise<Buffer>;
}

/**
 * @param dataDir  where scripts/og-cards.ts wrote cards.json and logo.svg
 * @param photoDir the official portraits (dist/photos)
 */
export function createRenderer(dataDir: string, photoDir: string): Renderer {
  const file: CardsFile = JSON.parse(fs.readFileSync(path.join(dataDir, "cards.json"), "utf8"));
  const logo = `data:image/svg+xml;base64,${fs.readFileSync(path.join(dataDir, "logo.svg")).toString("base64")}`;
  const cycleRange = file.cycleRange;
  return {
    version: file.version,
    card: (key) => (Object.hasOwn(file.cards, key) ? file.cards[key] : undefined),
    async render(card) {
      const assets: Assets = { logo, cycleRange };
      if (card.type === "member" && card.photo) {
        const p = path.join(photoDir, `${card.photo}.jpg`);
        if (fs.existsSync(p)) assets.photo = `data:image/jpeg;base64,${(await fs.promises.readFile(p)).toString("base64")}`;
      }
      // satori's types want React elements; the plain {type, props} tree is what it reads.
      const svg = await satori(cardTree(card, assets) as unknown as Parameters<typeof satori>[0], { width: WIDTH, height: HEIGHT, fonts });
      return new Resvg(svg, { fitTo: { mode: "width", value: WIDTH }, font: { loadSystemFonts: false } }).render().asPng();
    },
  };
}
