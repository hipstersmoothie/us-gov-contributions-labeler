import { defineConfig } from "astro/config";

export default defineConfig({
  // Set SITE_URL when deploying so canonical links and the sitemap are absolute.
  site: process.env.SITE_URL,
  trailingSlash: "always",
});
