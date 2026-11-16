import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "./scripts/sitemap.ts";

export default defineConfig({
  // Canonical links and Open Graph URLs are absolute against this.
  site: process.env.SITE_URL ?? "https://contributions.fyi",
  trailingSlash: "always",
  integrations: [react(), sitemap()],
});
