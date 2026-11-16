// Writes sitemap.xml, a sitemap index with one sitemap per section of the site
// (members, organizations, PACs…; each far under the 50,000-URL limit), and a
// robots.txt pointing to it, from the pages the build actually wrote.
//
// Left out: the 404 page, search results, and the HTML fragments pages load
// on demand (robots.txt keeps crawlers out of those; site/server sends
// X-Robots-Tag: noindex with them and the /data/ files).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

const SKIP = /^(fragments\/|404\/?$|search\/$)/;

/** When the data was last refreshed, without parsing all of members.json. */
function dataDate() {
  const fd = fs.openSync(path.resolve(process.cwd(), "../data/members.json"), "r");
  const head = Buffer.alloc(200);
  fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  return head.toString().match(/"generatedAt":\s*"([^"]+)"/)?.[1];
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export default function sitemap(): AstroIntegration {
  let site: URL;
  return {
    name: "sitemap",
    hooks: {
      "astro:config:done": ({ config }) => {
        site = new URL(config.site ?? "https://contributions.fyi");
      },
      "astro:build:done": ({ pages, dir, logger }) => {
        const out = fileURLToPath(dir);
        const lastmod = dataDate();
        const sections = new Map<string, string[]>();
        for (const { pathname } of pages) {
          const p = pathname.replace(/^\//, "");
          // Pages only (they all end in a slash); not the JSON endpoints.
          if (!(p === "" || p.endsWith("/")) || SKIP.test(p)) continue;
          const section = p.includes("/") && p.indexOf("/") < p.length - 1 ? p.slice(0, p.indexOf("/")) : "pages";
          if (!sections.has(section)) sections.set(section, []);
          sections.get(section)!.push(new URL(p, site).href);
        }

        const mod = lastmod ? `<lastmod>${lastmod}</lastmod>` : "";
        const index: string[] = [];
        for (const [section, urls] of [...sections].sort()) {
          const file = `sitemap-${section}.xml`;
          const body = urls.sort().map((u) => `<url><loc>${escape(u)}</loc>${mod}</url>`).join("\n");
          fs.writeFileSync(
            path.join(out, file),
            `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
          );
          index.push(`<sitemap><loc>${new URL(file, site).href}</loc>${mod}</sitemap>`);
        }
        fs.writeFileSync(
          path.join(out, "sitemap.xml"),
          `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${index.join("\n")}\n</sitemapindex>\n`
        );
        fs.writeFileSync(
          path.join(out, "robots.txt"),
          `User-agent: *\nDisallow: /fragments/\n\nSitemap: ${new URL("sitemap.xml", site).href}\n`
        );
        const total = [...sections.values()].reduce((s, u) => s + u.length, 0);
        logger.info(`sitemap.xml: ${total.toLocaleString()} pages in ${sections.size} sitemaps; robots.txt`);
      },
    },
  };
}
