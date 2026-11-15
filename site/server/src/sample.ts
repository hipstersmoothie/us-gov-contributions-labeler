// Render cards to files to look at, and time them:
//   node server/src/sample.ts out-dir member/S000033 pac/C00504530 ...
//   node server/src/sample.ts out-dir --bench 200   (random cards, timing only)
import fs from "node:fs";
import path from "node:path";
import { createRenderer } from "./render.ts";

const [outDir = "og-samples", ...keys] = process.argv.slice(2);
const site = path.resolve(import.meta.dirname, "../..");
const renderer = createRenderer(path.join(site, "server/data"), path.join(site, "public/photos"));
fs.mkdirSync(outDir, { recursive: true });

if (keys[0] === "--bench") {
  const all = JSON.parse(fs.readFileSync(path.join(site, "server/data/cards.json"), "utf8")).cards as Record<string, unknown>;
  const pick = Object.keys(all).sort(() => Math.random() - 0.5).slice(0, Number(keys[1] ?? 100));
  await renderer.render(renderer.card(pick[0]!)!); // warm up
  const times: Record<string, number[]> = {};
  const sizes: Record<string, number[]> = {};
  for (const key of pick) {
    const t = performance.now();
    const png = await renderer.render(renderer.card(key)!);
    const type = key.split("/")[0]!;
    (times[type] ??= []).push(performance.now() - t);
    (sizes[type] ??= []).push(png.length);
  }
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const max = (xs: number[]) => Math.max(...xs);
  for (const type of Object.keys(times))
    console.log(`${type.padEnd(13)} n=${String(times[type]!.length).padStart(3)}  median ${med(times[type]!).toFixed(0)}ms  max ${max(times[type]!).toFixed(0)}ms  median ${(med(sizes[type]!) / 1024).toFixed(0)}KB  max ${(max(sizes[type]!) / 1024).toFixed(0)}KB`);
} else {
  for (const key of keys) {
    const card = renderer.card(key);
    if (!card) {
      console.log(`no card for ${key}`);
      continue;
    }
    const t = performance.now();
    const png = await renderer.render(card);
    const file = path.join(outDir, `${key.replace(/\//g, "-")}.png`);
    fs.writeFileSync(file, png);
    console.log(`${file}  ${(performance.now() - t).toFixed(0)}ms  ${(png.length / 1024).toFixed(0)}KB`);
  }
}
