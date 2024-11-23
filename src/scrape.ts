import "dotenv/config";

import { chromium } from "playwright";
import { AtpAgent } from "@atproto/api";
import fs from "fs";
import { HandleResolver } from "@atproto/identity";

const agent = new AtpAgent({ service: "https://bsky.social" });
const outputFile = "contributions.json";
const baseurl = "https://www.opensecrets.org/search";
const currentOutput = fs.readFileSync(outputFile, "utf8");
const map = JSON.parse(currentOutput || "{}");
const browser = await chromium.launch({ headless: false });

async function scrapeOpenData(name: string) {
  const page = await browser.newPage();
  try {
    const url = `${baseurl}?q=${encodeURIComponent(name)}`;

    await page.goto(url);
    await page.waitForTimeout(3000);
    await page
      .locator(".gsc-resultsRoot .gsc-result a")
      .first()
      .scrollIntoViewIfNeeded();
    await page.locator(".gsc-resultsRoot .gsc-result a").first().click();

    await page.goto(`${page.url()}&cycle=CAREER&type=I`);

    const industryCells = page.locator(
      "#industries ~ * table tbody tr td:first-child"
    );
    await industryCells.first().waitFor();
    const industries = await industryCells.allTextContents();

    const contributorCells = page.locator(
      "#contributors ~ * table tbody tr td:first-child"
    );
    const contributors = await contributorCells.allTextContents();

    return {
      industries: industries.slice(0, 5).map((i) => i.trim()),
      contributors: contributors.slice(0, 5).map((i) => i.trim()),
    };
  } catch (error) {
    console.error("An error occurred:", error);
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

  for (const representative of response.data.items) {
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

  // response.data.displayName = "Bernie Sanders";
  if (!response.data.displayName) {
    console.log(`No display name for ${handle}`);
    return;
  }

  const contributions = await scrapeOpenData(response.data.displayName);

  console.log(contributions);
  map[did] = contributions;
  fs.writeFileSync(outputFile, JSON.stringify(map, null, 2));
  await agent.logout();
}

// scrapeDataForList(`at://${process.env.DID}/app.bsky.graph.list/3lbgx3lqlwk2d`);

scrapeDataForHandle("timkaine.bsky.social");
