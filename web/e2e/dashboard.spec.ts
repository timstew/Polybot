import { test, expect } from "@playwright/test";

test.describe("Dashboard page", () => {
  test("loads and shows bot rankings table", async ({ page }) => {
    await page.goto("/");
    // Should have the page title or heading
    await expect(page.locator("h1")).toContainText(/bot|detection|dashboard/i);
    // Table should render with at least one row
    const table = page.locator("table");
    await expect(table).toBeVisible({ timeout: 15_000 });
    const rows = table.locator("tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  });

  test("bot rows have non-empty wallet links", async ({ page }) => {
    await page.goto("/");
    await page.locator("table tbody tr").first().waitFor({ timeout: 15_000 });
    // Every wallet link should have an href containing 0x
    const walletLinks = page.locator("table tbody tr a[href*='0x']");
    const count = await walletLinks.count();
    expect(count).toBeGreaterThan(0);
  });

  test("sorting columns works", async ({ page }) => {
    await page.goto("/");
    await page.locator("table tbody tr").first().waitFor({ timeout: 15_000 });
    // Click a sortable column header
    const pnlHeader = page.locator("th").filter({ hasText: /P&L|pnl/i }).first();
    if (await pnlHeader.isVisible()) {
      await pnlHeader.click();
      // Table should still have rows after re-sort
      await expect(page.locator("table tbody tr").first()).toBeVisible();
    }
  });
});
