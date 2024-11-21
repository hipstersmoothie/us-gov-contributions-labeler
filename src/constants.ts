import "dotenv/config";

export const HANDLE = "@us-government-contributions.bsky.social";
export const DID = (process.env.DID ?? "") as `did:${string}`;
export const SIGNING_KEY = process.env.SIGNING_KEY ?? "";
export const PORT = Number(process.env.PORT ?? 4001);
