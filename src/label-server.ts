// The labeler service Bluesky talks to. Labels are added and removed by
// `pnpm sync-labels`, through this server's emitEvent endpoint.
import { LabelerServer } from "@skyware/labeler";
import { DID, PORT, SIGNING_KEY } from "./constants.js";

const server = new LabelerServer({
  did: DID,
  signingKey: SIGNING_KEY,
  dbPath: process.env.DB_PATH ?? "labels.db",
});

server.app.listen({ port: PORT, host: "::" }, (error, address) => {
  if (error) console.error(error);
  else console.log(`Labeler server listening on ${address}`);
});
