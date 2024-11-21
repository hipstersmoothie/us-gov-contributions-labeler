import fs from "fs";
import { addUserLabel } from "./label-server.js";

const data = fs.readFileSync("contributions.json", "utf8");
const map = JSON.parse(data);

await new Promise((resolve) => setTimeout(resolve, 1000));

for (const [key, value] of Object.entries(map) as [
  string,
  { industries: string[]; contributors: string[] }
][]) {
  console.log(`Adding labels for ${key}`);

  for (const industry of value.industries.slice(0, 3)) {
    await addUserLabel(key, {
      name: industry,
      description: `This representative is funded by the "${industry}" industry.`,
    });
  }

  for (const contributor of value.contributors.slice(0, 3)) {
    await addUserLabel(key, {
      name: contributor,
      description: `This representative has funded by "${contributor}"`,
    });
  }
}
