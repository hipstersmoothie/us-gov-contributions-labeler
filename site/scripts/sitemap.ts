// Writes sitemap.xml, a sitemap index with one sitemap per section of the site
// (members, organizations, PACs…; each far under the 50,000-URL limit), and a
// robots.txt pointing to it, from the pages the build actually wrote.
//
// Left out: the 404 page, search results, redirects (/races/, and a
// candidate's page once they're a member), and the HTML fragments pages load
// on demand (robots.txt keeps crawlers out of those; site/server sends
// X-Robots-Tag: noindex with them and the /data/ files).
//
// Each page's <lastmod> is when its text last changed, not when the data was
// last refreshed: search engines ignore a lastmod that moves on every page
// every week. The build fingerprints each page's title, description and
// <main> text, and compares them with the fingerprints of the build that's
// live now, from its data/pages.json. A page whose text is the same keeps its
// date; a new or changed one gets this build's. The pages that changed (and
// the ones that went away) are listed there too, for site/server to send to
// IndexNow once this build is live (see server/src/indexnow.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration, AstroIntegrationLogger } from "astro";

const SKIP = /^(fragments\/|404\/?$|search\/$)/;

/** data/pages.json: each page's fingerprint and lastmod, and what this build changed. */
export interface PagesManifest {
  builtAt: string;
  /** Path (no leading slash) → [fingerprint, lastmod]. */
  pages: Record<string, [string, string]>;
  /** Pages that are new or changed since the live build, and pages it had that this one doesn't. */
  changed: string[];
  removed: string[];
}

/** When the data was last refreshed, without parsing all of members.json. */
function dataDate() {
  const fd = fs.openSync(path.resolve(process.cwd(), "../data/members.json"), "r");
  const head = Buffer.alloc(200);
  fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  return head.toString().match(/"generatedAt":\s*"([^"]+)"/)?.[1];
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** A page that only points somewhere else (a meta refresh in its first bytes). */
function isRedirect(out: string, p: string) {
  try {
    const fd = fs.openSync(path.join(out, p, "index.html"), "r");
    const head = Buffer.alloc(400);
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    return head.toString().includes('http-equiv="refresh"');
  } catch {
    return false;
  }
}

/**
 * What a reader sees of a page: its title, description and the text of
 * <main>, without markup, scripts or the island props in attributes. The
 * footer's "Data as of" date, the JSON-LD and the hashed asset URLs change
 * with every build or code change, so they're left out.
 */
export function fingerprint(html: string) {
  const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
  const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
  const start = html.indexOf("<main");
  const end = html.lastIndexOf("</main>");
  const main = start >= 0 && end > start ? html.slice(start, end) : html;
  const text = main
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(`${title}\n${description}\n${text}`).digest("base64url").slice(0, 16);
}

/** The live build's manifest, from PREVIOUS_PAGES (a URL or a file) or the site itself. */
async function previousManifest(site: URL, logger: AstroIntegrationLogger): Promise<PagesManifest | undefined> {
  const from = process.env.PREVIOUS_PAGES ?? new URL("data/pages.json", site).href;
  try {
    if (!/^https?:/.test(from)) return JSON.parse(fs.readFileSync(from, "utf8"));
    const res = await fetch(from, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as PagesManifest;
  } catch (err) {
    logger.warn(`No previous data/pages.json (${from}: ${(err as Error).message}); every page dated by the data`);
    return undefined;
  }
}

export default function sitemap(): AstroIntegration {
  let site: URL;
  return {
    name: "sitemap",
    hooks: {
      "astro:config:done": ({ config }) => {
        site = new URL(config.site ?? "https://contributions.fyi");
      },
      "astro:build:done": async ({ pages, dir, logger }) => {
        const out = fileURLToPath(dir);
        const builtAt = new Date().toISOString();
        const previous = await previousManifest(site, logger);
        // Without the live build's fingerprints, nothing says which pages changed.
        const fallback = dataDate() ?? builtAt;
        const manifest: PagesManifest = { builtAt, pages: {}, changed: [], removed: [] };
        const sections = new Map<string, string[]>();
        for (const { pathname } of pages) {
          const p = pathname.replace(/^\//, "");
          // Pages only (they all end in a slash); not the JSON endpoints.
          if (!(p === "" || p.endsWith("/")) || SKIP.test(p)) continue;
          if ((p === "races/" || p.startsWith("candidates/")) && isRedirect(out, p)) continue;
          const print = fingerprint(fs.readFileSync(path.join(out, p, "index.html"), "utf8"));
          const before = previous?.pages[p];
          const lastmod = !previous ? fallback : before?.[0] === print ? before[1] : builtAt;
          manifest.pages[p] = [print, lastmod];
          if (!before || before[0] !== print) manifest.changed.push(p);
          const section = p.includes("/") && p.indexOf("/") < p.length - 1 ? p.slice(0, p.indexOf("/")) : "pages";
          if (!sections.has(section)) sections.set(section, []);
          sections.get(section)!.push(p);
        }
        manifest.removed = Object.keys(previous?.pages ?? {}).filter((p) => !manifest.pages[p]);

        const index: string[] = [];
        for (const [section, paths] of [...sections].sort()) {
          const file = `sitemap-${section}.xml`;
          const body = paths
            .sort()
            .map((p) => `<url><loc>${escape(new URL(p, site).href)}</loc><lastmod>${manifest.pages[p]![1]}</lastmod></url>`)
            .join("\n");
          fs.writeFileSync(
            path.join(out, file),
            `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
          );
          // A sitemap's lastmod is its newest page's.
          const newest = paths.map((p) => manifest.pages[p]![1]).sort().at(-1);
          index.push(`<sitemap><loc>${new URL(file, site).href}</loc><lastmod>${newest}</lastmod></sitemap>`);
        }
        fs.writeFileSync(
          path.join(out, "sitemap.xml"),
          `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${index.join("\n")}\n</sitemapindex>\n`
        );
        fs.writeFileSync(
          path.join(out, "robots.txt"),
          `User-agent: *\nDisallow: /fragments/\n\nSitemap: ${new URL("sitemap.xml", site).href}\n`
        );
        fs.mkdirSync(path.join(out, "data"), { recursive: true });
        fs.writeFileSync(path.join(out, "data/pages.json"), JSON.stringify(manifest));
        const total = Object.keys(manifest.pages).length;
        logger.info(
          `sitemap.xml: ${total.toLocaleString()} pages in ${sections.size} sitemaps; robots.txt; ` +
            (previous
              ? `${manifest.changed.length.toLocaleString()} changed and ${manifest.removed.length.toLocaleString()} removed since the live build`
              : "no live build to compare with")
        );
      },
    },
  };
}
