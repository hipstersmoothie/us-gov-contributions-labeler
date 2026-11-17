// The rules that decide whether a race shows a winner: run with pnpm test:races.
import assert from "node:assert/strict";
import { reconcile, isOfficialUrl, type Claim } from "../ingest/races.js";
const state = (w: string[], status: Claim["status"] = "certified"): Claim => ({ status, winners: w, source: `src-${status}-${w}` });
assert.equal(reconcile([], true).status, "upcoming");
assert.equal(reconcile([], false).status, "pending");
assert.deepEqual(reconcile([state(["A"])], false).winners, ["A"]);
const agree = reconcile([state(["A"]), state(["A"], "sworn-in")], false);
assert.equal(agree.status, "certified"); assert.equal(agree.confirmedBy?.length, 1);
const clash = reconcile([state(["A"]), state(["B"], "sworn-in")], false);
assert.equal(clash.status, "pending"); assert.ok(clash.conflict);
assert.equal(reconcile([state(["A", "B"], "runoff")], false).status, "runoff");
assert.equal(reconcile([state(["A", "B"], "runoff"), state(["B"], "sworn-in")], false).status, "sworn-in");
assert.equal(reconcile([state(["A", "B"], "runoff"), state(["C"], "sworn-in")], false).status, "pending");
assert.ok(isOfficialUrl("https://sos.wyo.gov/x.pdf")); assert.ok(isOfficialUrl("https://www.votecnmi.gov.mp/a")); assert.ok(isOfficialUrl("https://www.enr-scvotes.org/SC/1"));
assert.ok(!isOfficialUrl("http://sos.wyo.gov/x")); assert.ok(!isOfficialUrl("https://apnews.com/x")); assert.ok(!isOfficialUrl("https://ballotpedia.org/x")); assert.ok(!isOfficialUrl("https://evil.gov.example.com/"));
console.log("reconcile and source rules: all assertions pass");
