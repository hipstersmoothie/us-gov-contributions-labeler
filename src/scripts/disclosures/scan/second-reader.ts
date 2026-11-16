// A second, independent reading of scanned paper forms by Claude, to confirm
// what our reader got (scan/ptr.ts, scan/annual.ts) and to fill in rows it
// flagged. A row is only accepted when both readers agree; disagreements go to
// review instead of the site.
//
// The reports are public records used for news and public-interest
// dissemination (5 U.S.C. § 13107). Sending page images to the Anthropic API
// processes them; it doesn't publish them.
//
//   tsx src/scripts/disclosures/scan/second-reader.ts estimate   # pages and rough cost, no API calls
//   tsx src/scripts/disclosures/scan/second-reader.ts submit     # render pages, create batches
//   tsx src/scripts/disclosures/scan/second-reader.ts submit changed  # only pages whose rows changed since the last run
//   tsx src/scripts/disclosures/scan/second-reader.ts collect    # wait for batches, save readings
//
// Needs ANTHROPIC_API_KEY (in .env) or an `ant auth login` profile.
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "child_process";
import fs from "fs";
import { CACHE } from "../common.js";
import type { HouseFiling } from "../house-index.js";
import type { ScannedHolding } from "./annual.js";
import type { ScanPage, ScannedTrade } from "./ptr.js";
import { sameRow } from "./resolve.js";

const DIR = `${CACHE}/scan/second-reader`;
const MODEL = "claude-opus-5-5";
/** Long side of the rendered page; Claude downsizes larger images anyway. */
const LONG_SIDE = 1568;
/** Keep each batch well under the 256 MB request limit. */
const PER_BATCH = 120;

const OWNER = { type: "string", enum: ["SP", "DC", "JT", "blank", "unclear"] } as const;

const PTR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rows", "missed"],
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "owner", "transaction", "trade_date", "notified_date", "amount_column"],
        properties: {
          n: { type: "integer" },
          owner: OWNER,
          transaction: { type: "string", enum: ["purchase", "sale", "partial_sale", "exchange", "unclear"] },
          trade_date: { type: "string", description: "As written on the form (MM/DD/YY or MM/DD/YYYY), or 'unclear'." },
          notified_date: { type: "string", description: "As written on the form, or 'unclear'." },
          amount_column: { type: "string", enum: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "unclear"] },
        },
      },
    },
    missed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["asset", "trade_date"],
        properties: { asset: { type: "string" }, trade_date: { type: "string" } },
      },
    },
  },
} as const;

const ANNUAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "asset", "owner", "value_column"],
        properties: {
          n: { type: "integer" },
          asset: { type: "string", description: "The asset name as written, including handwriting." },
          owner: OWNER,
          value_column: { type: "string", enum: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "unclear"] },
        },
      },
    },
  },
} as const;

const SYSTEM = `You read scanned U.S. House financial disclosure forms and report exactly what is written or marked on them. Never guess: when a mark, digit or word can't be read with confidence, answer "unclear". A form's printed example row (Mega Corp, Simon & Schuster, ABC Hedge Fund, dated 2012-2020) is not a real row.`;

function ptrPrompt(names: string[]) {
  return `This is one page of a scanned House Periodic Transaction Report. Another reader found these trade rows on it, top to bottom:
${names.map((n, i) => `${i + 1}. ${n}`).join("\n")}

For each numbered row, read from the image:
- owner: the SP/DC/JT column (blank means the member);
- transaction: which box is marked. Some forms have separate Purchase, Sale, Partial Sale and Exchange boxes; others have Purchase, Sale and Exchange plus a "Partial Transaction" box, where Sale with Partial marked is partial_sale. Ignore any "Capital Gains Exceed $200" box;
- trade_date and notified_date, exactly as written;
- amount_column: the marked amount column, A ($1,001-$15,000), B ($15,001-$50,000), C ($50,001-$100,000), D ($100,001-$250,000), E ($250,001-$500,000), F ($500,001-$1,000,000), G ($1,000,001-$5,000,000), H ($5,000,001-$25,000,000), I ($25,000,001-$50,000,000), J (over $50,000,000), K (spouse or dependent child asset over $1,000,000). Use the column's printed letter or range, not its position.

Return one entry per numbered row, using its number as n. Under missed, list any trade rows on the page that aren't in the list.`;
}

function annualPrompt(names: string[]) {
  return `This is one page of Schedule A (assets) of a scanned House annual financial disclosure report. Another reader found these asset rows on it, top to bottom (names may be misread, especially handwriting):
${names.map((n, i) => `${i + 1}. ${n}`).join("\n")}

For each numbered row, read from the image the asset name as written, the owner (SP/DC/JT column; blank means the member), and which Block B "Value of Asset" column is marked: A None, B $1-$1,000, C $1,001-$15,000, D $15,001-$50,000, E $50,001-$100,000, F $100,001-$250,000, G $250,001-$500,000, H $500,001-$1,000,000, I $1,000,001-$5,000,000, J $5,000,001-$25,000,000, K $25,000,001-$50,000,000, L over $50,000,000, M spouse or dependent child asset over $1,000,000. Return one entry per numbered row, using its number as n.`;
}

interface PageJob {
  id: string;
  kind: "ptr" | "annual";
  docId: string;
  year: number;
  page: number;
  rotation: number;
  names: string[];
}

/** Every scanned page with rows on it: trade-report pages, and Schedule A pages with any flagged row. */
function jobs(): PageJob[] {
  const out: PageJob[] = [];
  const rotation = (docId: string, page: number) => {
    const line = fs.readFileSync(`${CACHE}/scan/${docId}.jsonl`, "utf8").split("\n")[page];
    return line ? (JSON.parse(line) as ScanPage).rotation : 0;
  };
  const ptrs = JSON.parse(fs.readFileSync(`${CACHE}/scan/ptrs.json`, "utf8")) as { filing: HouseFiling; trades: ScannedTrade[] }[];
  for (const d of ptrs) {
    const pages = [...new Set(d.trades.map((t) => t.page))];
    for (const page of pages)
      out.push({
        id: `p-${d.filing.docId}-${page}`,
        kind: "ptr",
        docId: d.filing.docId,
        year: d.filing.year,
        page,
        rotation: rotation(d.filing.docId, page),
        names: d.trades.filter((t) => t.page === page).map((t) => t.asset || "(no name read)"),
      });
  }
  const annuals = JSON.parse(fs.readFileSync(`${CACHE}/scan/annuals.json`, "utf8")) as { filing: HouseFiling; holdings: ScannedHolding[] }[];
  for (const d of annuals) {
    const flagged = new Set(d.holdings.filter((h) => h.doubts.length).map((h) => h.page));
    for (const page of flagged)
      out.push({
        id: `a-${d.filing.docId}-${page}`,
        kind: "annual",
        docId: d.filing.docId,
        year: d.filing.year,
        page,
        rotation: rotation(d.filing.docId, page),
        names: d.holdings.filter((h) => h.page === page).map((h) => h.asset || "(no name read)"),
      });
  }
  return out;
}

function render(job: PageJob) {
  // Keyed by rotation too: a page the analyzer later turns needs a new image.
  const png = `${DIR}/pages/${job.id}-r${job.rotation}.png`;
  if (!fs.existsSync(png)) {
    fs.mkdirSync(`${DIR}/pages`, { recursive: true });
    execFileSync(`${CACHE}/scan/render`, [`${CACHE}/house/pdf/${job.docId}.pdf`, String(job.page), String(job.rotation), String(LONG_SIDE), png]);
  }
  return fs.readFileSync(png).toString("base64");
}

function request(job: PageJob): Anthropic.Messages.BatchCreateParams.Request {
  return {
    custom_id: job.id,
    params: {
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: job.kind === "ptr" ? PTR_SCHEMA : ANNUAL_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: render(job) } },
            { type: "text", text: job.kind === "ptr" ? ptrPrompt(job.names) : annualPrompt(job.names) },
          ],
        },
      ],
    },
  };
}

const command = process.argv[2];
fs.mkdirSync(DIR, { recursive: true });

if (command === "estimate") {
  const all = jobs();
  const rows = all.reduce((s, j) => s + j.names.length, 0);
  // ~1,600 image tokens and ~300 prompt tokens in; ~60 tokens out per row plus thinking.
  const inTok = all.length * 1900;
  const outTok = rows * 60 + all.length * 1500;
  const cost = (inTok * 4 + outTok * 20) / 1e6 / 2; // Opus 5.5 rates, halved by the Batches API
  console.log(`${all.filter((j) => j.kind === "ptr").length} trade-report pages, ${all.filter((j) => j.kind === "annual").length} Schedule A pages, ${rows} rows`);
  console.log(`about ${(inTok / 1e6).toFixed(1)}M input and ${(outTok / 1e6).toFixed(1)}M output tokens: roughly $${cost.toFixed(0)} through the Batches API`);
} else if (command === "pilot") {
  // A few pages synchronously, to check the output before a full batch:
  //   second-reader.ts pilot p-8220906-40 p-9116211-3
  const client = new Anthropic();
  const wanted = new Set(process.argv.slice(3));
  for (const job of jobs().filter((j) => wanted.has(j.id))) {
    const { params } = request(job);
    const message = await client.messages.create(params as Anthropic.MessageCreateParamsNonStreaming);
    const text = message.content.find((b) => b.type === "text");
    console.log(`== ${job.id} (${message.stop_reason}; ${message.usage.input_tokens} in, ${message.usage.output_tokens} out)`);
    console.log(text?.type === "text" ? text.text : "(no text)");
  }
} else if (command === "submit") {
  const client = new Anthropic();
  let all = jobs();
  if (process.argv[3] === "changed") {
    // After the reader improves, re-read only the pages whose row list moved:
    // readings line up with rows by position.
    const old = new Map((JSON.parse(fs.readFileSync(`${DIR}/jobs.json`, "utf8")) as PageJob[]).map((j) => [j.id, j]));
    all = all.filter((j) => {
      const prev = old.get(j.id);
      return !prev || prev.names.length !== j.names.length || prev.names.some((n, i) => !sameRow(n, j.names[i]!));
    });
    fs.writeFileSync(`${DIR}/pending-jobs.json`, JSON.stringify(all));
    console.log(`${all.length} pages changed`);
  } else fs.writeFileSync(`${DIR}/jobs.json`, JSON.stringify(all));
  const batches: string[] = [];
  for (let i = 0; i < all.length; i += PER_BATCH) {
    const batch = await client.messages.batches.create({ requests: all.slice(i, i + PER_BATCH).map(request) });
    batches.push(batch.id);
    console.log(`batch ${batch.id}: ${Math.min(PER_BATCH, all.length - i)} pages`);
  }
  fs.writeFileSync(`${DIR}/batches.json`, JSON.stringify(batches));
} else if (command === "collect") {
  const client = new Anthropic();
  const batches = JSON.parse(fs.readFileSync(`${DIR}/batches.json`, "utf8")) as string[];
  // Merged over earlier readings, so a partial re-read keeps the rest.
  const readings: Record<string, unknown> = fs.existsSync(`${DIR}/readings.json`) ? JSON.parse(fs.readFileSync(`${DIR}/readings.json`, "utf8")) : {};
  let refused = 0, failed = 0;
  for (const id of batches) {
    for (;;) {
      const b = await client.messages.batches.retrieve(id);
      if (b.processing_status === "ended") break;
      console.log(`${id}: ${b.request_counts.processing} still processing`);
      await new Promise((r) => setTimeout(r, 60_000));
    }
    for await (const result of await client.messages.batches.results(id)) {
      if (result.result.type !== "succeeded") {
        failed++;
        continue;
      }
      const message = result.result.message;
      // Policy declines come back as a successful response with no reading.
      if (message.stop_reason === "refusal") {
        refused++;
        continue;
      }
      const text = message.content.find((b) => b.type === "text");
      if (text?.type === "text") readings[result.custom_id] = JSON.parse(text.text);
    }
  }
  fs.writeFileSync(`${DIR}/readings.json`, JSON.stringify(readings));
  if (fs.existsSync(`${DIR}/pending-jobs.json`)) {
    const jobsById = new Map((JSON.parse(fs.readFileSync(`${DIR}/jobs.json`, "utf8")) as PageJob[]).map((j) => [j.id, j]));
    for (const j of JSON.parse(fs.readFileSync(`${DIR}/pending-jobs.json`, "utf8")) as PageJob[]) jobsById.set(j.id, j);
    fs.writeFileSync(`${DIR}/jobs.json`, JSON.stringify([...jobsById.values()]));
    fs.rmSync(`${DIR}/pending-jobs.json`);
  }
  console.log(`${Object.keys(readings).length} pages read; ${refused} declined; ${failed} errored or expired`);
} else {
  console.log("usage: second-reader.ts estimate | submit | collect");
}
