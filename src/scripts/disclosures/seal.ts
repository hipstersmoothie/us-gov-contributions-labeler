// Encrypt the built holdings file for the public repo:
// site/src/data/holdings.json -> data/holdings.json.enc (gzip, then AES-256-GCM).
//
// The parsed disclosures aren't redistributed (5 U.S.C. § 13107; see
// design/holdings/README.md), but the website builds from this repo. So the
// repo carries ciphertext, and the key lives only in .env and as the website
// service's HOLDINGS_KEY variable on Railway. site/scripts/open-holdings.ts
// decrypts it at build time.
//
//   tsx src/scripts/disclosures/seal.ts
import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import zlib from "zlib";

const key = process.env.HOLDINGS_KEY;
if (!key) throw new Error("HOLDINGS_KEY isn't set (a base64 32-byte key, in .env)");
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
const body = Buffer.concat([cipher.update(zlib.gzipSync(fs.readFileSync("site/src/data/holdings.json"))), cipher.final()]);
// Layout: 12-byte IV, 16-byte auth tag, ciphertext.
fs.writeFileSync("data/holdings.json.enc", Buffer.concat([iv, cipher.getAuthTag(), body]));
console.log(`data/holdings.json.enc: ${(fs.statSync("data/holdings.json.enc").size / 1e6).toFixed(1)} MB`);
