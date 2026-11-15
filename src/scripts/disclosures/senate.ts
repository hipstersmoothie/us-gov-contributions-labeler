// Senate eFD (efdsearch.senate.gov): agree to the use restrictions, list
// senators' reports, and fetch report pages.
//
// The site asks every visitor to affirm "I understand the prohibitions on
// obtaining and use of financial disclosure reports" (5 U.S.C. § 13107)
// before searching. We post that affirmation because this project's use is
// within them (no commercial use, no credit ratings, no fundraising).
import fs from "fs";
import path from "path";
import { CACHE, USER_AGENT } from "./common.js";

const BASE = "https://efdsearch.senate.gov";
// Several seconds apart, one honest user agent, no retries: the search
// endpoint has answered automated requests with 503s.
const INTERVAL_MS = 5000;

let cookies = new Map<string, string>();
let csrf = "";
let last = 0;

async function pace() {
  const wait = last + INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

async function request(url: string, init: RequestInit = {}) {
  await pace();
  const res = await fetch(BASE + url, {
    ...init,
    redirect: "manual",
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      Referer: `${BASE}/search/`,
      ...(init.headers ?? {}),
    },
  });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(";");
    const [k, v] = kv!.split("=");
    cookies.set(k!, v!);
  }
  return res;
}

export async function agree() {
  const home = await (await request("/search/home/")).text();
  const token = home.match(/name="csrfmiddlewaretoken" value="([^"]+)"/)?.[1];
  if (!token) throw new Error("No agreement form on eFD home");
  const res = await request("/search/home/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ prohibition_agreement: "1", csrfmiddlewaretoken: token }),
  });
  if (res.status !== 302) throw new Error(`Agreement returned ${res.status}`);
  csrf = cookies.get("csrftoken") ?? token;
}

export interface SenateReport {
  first: string;
  last: string;
  office: string;
  title: string;
  url: string;
  kind: "annual" | "ptr" | "paper" | "extension" | "other";
  filed: string;
}

/** Report types: 7 annual, 11 PTR, 10 extension? (see the search form). Filer type 1 = senator. */
export async function search(params: {
  reportTypes: number[];
  start: string; // MM/DD/YYYY
  end: string;
}): Promise<SenateReport[]> {
  const out: SenateReport[] = [];
  for (let start = 0; ; start += 100) {
    const body = new URLSearchParams({
      draw: "1",
      start: String(start),
      length: "100",
      report_types: `[${params.reportTypes.join(",")}]`,
      filer_types: "[1]",
      submitted_start_date: `${params.start} 00:00:00`,
      submitted_end_date: `${params.end} 23:59:59`,
      candidate_state: "",
      senator_state: "",
      office_id: "",
      first_name: "",
      last_name: "",
      "order[0][column]": "4",
      "order[0][dir]": "desc",
    });
    const res = await request("/search/report/data/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRFToken": csrf,
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });
    if (!res.ok) throw new Error(`search ${res.status}: ${(await res.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 600)}`);
    const json = (await res.json()) as { recordsTotal: number; data: string[][] };
    for (const [first, last, office, link, filed] of json.data) {
      const url = link!.match(/href="([^"]+)"/)?.[1] ?? "";
      const title = link!.replace(/<[^>]+>/g, "").trim();
      const kind = url.includes("/paper/")
        ? "paper"
        : url.includes("/ptr/")
          ? "ptr"
          : url.includes("/annual/")
            ? "annual"
            : url.includes("/extension")
              ? "extension"
              : "other";
      out.push({ first: first!, last: last!, office: office!, title, url, kind, filed: filed! });
    }
    if (start + 100 >= json.recordsTotal) break;
  }
  return out;
}

/** A report page, cached. */
export async function reportPage(url: string): Promise<string> {
  const file = path.join(CACHE, "senate", url.replace(/^\/search\/view\//, "").replace(/\/$/, "") + ".html");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  if (!csrf) await agree();
  const res = await request(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const html = await res.text();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  return html;
}
