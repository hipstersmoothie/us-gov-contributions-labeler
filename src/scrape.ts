import "dotenv/config";

import { chromium } from "playwright";
import { AtpAgent } from "@atproto/api";
import fs from "fs";
import { DidResolver, HandleResolver } from "@atproto/identity";

const agent = new AtpAgent({ service: "https://bsky.social" });
const outputFile = "contributions.json";
const baseurl = "https://www.opensecrets.org/search";
const currentOutput = fs.readFileSync(outputFile, "utf8");
const map = JSON.parse(currentOutput || "{}");

async function scrapeOpenData(name: string) {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  try {
    let url = `${baseurl}?q=${encodeURIComponent(name)}`;

    await page.goto(url);
    await page
      .getByRole("link", { name: " - Campaign" })
      .first()
      .click({ timeout: 10000 });

    const industryCells = page.locator(
      "#industries ~ * table tbody tr td:first-child"
    );

    await industryCells.first().waitFor();
    const industries = await industryCells.allTextContents();

    const contributorCells = page.locator(
      "#contributors ~ * table tbody tr td:first-child"
    );

    await contributorCells.first().waitFor();
    const contributors = await contributorCells.allTextContents();

    return { industries, contributors: contributors.slice(0, 5) };
  } catch (error) {
    try {
      let url = `${baseurl}?q=${encodeURIComponent(name)}`;

      await page.goto(url);
      await page.waitForTimeout(1500);
      await page.locator(".gsc-result a").first().click();
      await page.click(".StickyFilters-cycle", {
        force: true,
      });
      await page.locator('.select-items div:has-text("Career")').click();

      const industryCells = page.locator("table tbody tr td:first-child");

      await industryCells.first().waitFor();
      const industries = await industryCells.allTextContents();

      return { industries: industries.slice(0, 5), contributors: [] };
    } catch (error) {
      console.error("An error occurred:", error);
    }
  } finally {
    await page.close();
  }
}

async function scrapeDataForList(list: string) {
  await agent.login({
    identifier: "us-gov-funding.bsky.social",
    password: process.env.LABELER_PASSWORD!,
  });
  const response = await agent.app.bsky.graph.getList({
    list,
  });

  const startIndex = response.data.items.findIndex(
    (i) => i.subject.displayName === "Joaquin Castro"
  );
  const items = response.data.items.slice(startIndex);

  for (const representative of items) {
    if (!representative.subject.displayName) {
      console.log(`No display name for ${representative.subject.handle}`);
      continue;
    }

    if (map[representative.subject.handle]) {
      console.log(`Already scraped ${representative.subject.displayName}`);
      continue;
    }

    console.log(`Getting data for ${representative.subject.displayName}...`);

    const contributions = await scrapeOpenData(
      representative.subject.displayName
    );

    console.log(contributions);
    map[representative.subject.handle] = contributions;
    fs.writeFileSync(outputFile, JSON.stringify(map, null, 2));
  }

  await agent.logout();
  // await browser.close();
}

async function scrapeDataForHandle(handle: string) {
  await agent.login({
    identifier: "us-gov-funding.bsky.social",
    password: process.env.LABELER_PASSWORD!,
  });

  const hdlres = new HandleResolver({});
  const did = await hdlres.resolve(handle);

  console.log(`Resolving ${handle} to ${did}`);

  if (!did) {
    console.log(`No DID for ${handle}`);
    return;
  }

  const response = await agent.getProfile({
    actor: did,
  });

  if (!response.data.displayName) {
    console.log(`No display name for ${handle}`);
    return;
  }

  const contributions = await scrapeOpenData(response.data.displayName);

  console.log(contributions);
  map[handle] = contributions;
  fs.writeFileSync(outputFile, JSON.stringify(map, null, 2));
  await agent.logout();
}

// scrapeDataForList(
//   "at://did:plc:u36ag7zrabppftv6kolaedtf/app.bsky.graph.list/3lbbvkxjbk52e"
// );

// scrapeOpenData("Pat Ryan").then(console.log);

scrapeDataForHandle("wyden.senate.gov");
