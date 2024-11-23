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
      description: `This representative is funded by the "${industry}" industry.\n\nThe organizations themselves did not donate, rather the money came from the organizations' PACs, their individual members or employees or owners, and those individuals' immediate families. Organization totals include subsidiaries and affiliates.\n\nVisit https://www.opensecrets.org/campaign-expenditures/methodology to learn more.`,
    });
  }

  for (const contributor of value.contributors.slice(0, 3)) {
    await addUserLabel(key, {
      name: contributor,
      description: `This representative is funded by "${contributor}".\n\nThe organizations themselves did not donate, rather the money came from the organizations' PACs, their individual members or employees or owners, and those individuals' immediate families. Organization totals include subsidiaries and affiliates.\n\nVisit https://www.opensecrets.org/campaign-expenditures/methodology to learn more.`,
    });
  }
}

process.exit(0);
