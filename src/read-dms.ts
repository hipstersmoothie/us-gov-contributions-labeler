// Dump the labeler account's DMs so suggestions/corrections can be reviewed.
//
// Needs an app password created with "Allow access to your direct messages".
//
// Writes (both gitignored, they contain private messages):
//   dms.local.md          - readable digest of every conversation
//   dm-leads.local.json   - accounts mentioned in messages, picked up by discover.ts
import "dotenv/config";
import fs from "fs";
import { AtpAgent, ChatBskyConvoDefs } from "@atproto/api";

const identifier = process.env.BSKY_IDENTIFIER ?? "did:plc:ylmdlijvrvgbe4md6v4dyce6";
const password = process.env.BSKY_DM_APP_PASSWORD;

if (!password) {
  console.error("Set BSKY_DM_APP_PASSWORD (an app password with DM access) in .env");
  process.exit(1);
}

const agent = new AtpAgent({ service: "https://bsky.social" });
await agent.login({ identifier, password });
const chat = agent.withProxy("bsky_chat", "did:web:api.bsky.chat");

const convos = [];
let cursor: string | undefined;
do {
  const res = await chat.chat.bsky.convo.listConvos({ limit: 100, cursor });
  convos.push(...res.data.convos);
  cursor = res.data.cursor;
} while (cursor);

console.log(`${convos.length} conversations`);

const leads = new Set<string>();
const PROFILE_URL = /bsky\.app\/profile\/([a-zA-Z0-9.:-]+)/g;
const AT_HANDLE = /@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/g;

let digest = `# DMs for ${identifier}\n\nGenerated ${new Date().toISOString()}\n`;

for (const convo of convos) {
  const others = convo.members.filter((m) => m.did !== agent.session!.did);
  const handles = Object.fromEntries(convo.members.map((m) => [m.did, m.handle]));

  const messages = [];
  let msgCursor: string | undefined;
  do {
    const res = await chat.chat.bsky.convo.getMessages({
      convoId: convo.id,
      limit: 100,
      cursor: msgCursor,
    });
    messages.push(...res.data.messages);
    msgCursor = res.data.cursor;
  } while (msgCursor);

  digest += `\n## ${others.map((m) => `@${m.handle}`).join(", ")}\n\n`;

  for (const m of messages.reverse()) {
    if (!ChatBskyConvoDefs.isMessageView(m)) continue;

    const from = handles[m.sender.did] ?? m.sender.did;
    digest += `- **${from}** (${m.sentAt.slice(0, 10)}): ${m.text.replace(/\n/g, " ")}\n`;

    // Only mine messages from other people, not our own replies.
    if (m.sender.did === agent.session!.did) continue;

    for (const facet of m.facets ?? []) {
      for (const f of facet.features as { did?: string; uri?: string }[]) {
        if (f.did) leads.add(f.did);
        if (f.uri) for (const [, actor] of f.uri.matchAll(PROFILE_URL)) leads.add(actor!);
      }
    }
    for (const [, actor] of m.text.matchAll(PROFILE_URL)) leads.add(actor!);
    for (const [, handle] of m.text.matchAll(AT_HANDLE)) leads.add(handle!.toLowerCase());
  }
}

fs.writeFileSync("dms.local.md", digest);
fs.writeFileSync("dm-leads.local.json", JSON.stringify([...leads], null, 2) + "\n");
console.log(`Wrote dms.local.md and ${leads.size} leads to dm-leads.local.json`);
