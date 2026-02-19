import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL || "https://polybot-b5l.pages.dev",
    screenshot: "only-on-failure",
    // Cloudflare Access service token headers (set via env vars)
    extraHTTPHeaders: {
      ...(process.env.CF_ACCESS_CLIENT_ID && {
        "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET || "",
      }),
    },
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
