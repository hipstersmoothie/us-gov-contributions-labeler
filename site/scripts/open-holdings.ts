// Decrypt ../data/holdings.json.enc into src/data/holdings.json before the
// build, when HOLDINGS_KEY is set (see src/scripts/disclosures/seal.ts). Without
// the key the site builds without the investments pages' data.
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";

const key = process.env.HOLDINGS_KEY;
const sealed = "../data/holdings.json.enc";
if (!key || !fs.existsSync(sealed)) {
  console.log(`open-holdings: ${key ? "no sealed file" : "no HOLDINGS_KEY"}; building without investments data`);
} else {
  const raw = fs.readFileSync(sealed);
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const json = zlib.gunzipSync(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]));
  fs.mkdirSync("src/data", { recursive: true });
  fs.writeFileSync("src/data/holdings.json", json);
  console.log(`open-holdings: wrote src/data/holdings.json (${(json.length / 1e6).toFixed(1)} MB)`);
}
