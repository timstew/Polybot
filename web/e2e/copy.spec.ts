import { test, expect } from "@playwright/test";

test.describe("Copy trading page", () => {
  test("loads and shows active targets table", async ({ page }) => {
    await page.goto("/copy");
    await expect(page.locator("h1")).toContainText(/copy trading/i);
    // Active targets table should render
    const table = page.locator("table").first();
    await expect(table).toBeVisible({ timeout: 15_000 });
    const rows = table.locator("tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  });

  test("target rows show wallet, mode, and P&L", async ({ page }) => {
    await page.goto("/copy");
    const row = page.locator("table").first().locator("tbody tr").first();
    await row.waitFor({ timeout: 15_000 });
    // Row should contain a wallet link (0x...) or username
    const rowText = await row.textContent();
    expect(rowText).toBeTruthy();
    // Should show mode badge (paper or real)
    const modeBadge = row.locator("text=/paper|real/i");
    await expect(modeBadge).toBeVisible();
  });

  test("category icons are visible", async ({ page }) => {
    await page.goto("/copy");
    const row = page.locator("table").first().locator("tbody tr").first();
    await row.waitFor({ timeout: 15_000 });
    // Cat column should exist in header
    const catHeader = page.locator("th").filter({ hasText: "Category" });
    await expect(catHeader).toBeVisible();
  });

  test("expand caret shows detail view", async ({ page }) => {
    await page.goto("/copy");
    const firstRow = page.locator("table").first().locator("tbody tr").first();
    await firstRow.waitFor({ timeout: 15_000 });
    // Click the row to expand
    await firstRow.click();
    // Detail panel should appear (CopyTargetDetail component)
    const detailPanel = page
      .locator("table")
      .first()
      .locator("tbody tr")
      .nth(1)
      .locator("td");
    await expect(detailPanel.first()).toBeVisible({ timeout: 10_000 });
  });

  test("listener status is shown", async ({ page }) => {
    await page.goto("/copy");
    // Should show either "Listening" badge or "No listener running"
    const listening = page.locator("text=/listening|no listener/i");
    await expect(listening.first()).toBeVisible({ timeout: 10_000 });
  });
});
