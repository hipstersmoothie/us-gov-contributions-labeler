import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "./scripts/sitemap.ts";

export default defineConfig({
  // Canonical links and Open Graph URLs are absolute against this.
  site: process.env.SITE_URL ?? "https://contributions.fyi",
  trailingSlash: "always",
  // The site's CSS is ~6 KB gzipped: in each page's <head> it costs less than
  // the render-blocking request for a stylesheet, which on a phone's
  // connection is the slowest step before first paint.
  build: { inlineStylesheets: "always" },
  integrations: [react(), sitemap()],
});
