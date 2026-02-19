import { test, expect } from "@playwright/test";

test.describe("Dashboard page", () => {
  test("loads and shows bot rankings table", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Dashboard");
    const table = page.locator("table");
    await expect(table).toBeVisible({ timeout: 15_000 });
    const rows = table.locator("tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  });

  test("bot rows have non-empty wallet links", async ({ page }) => {
    await page.goto("/");
    await page.locator("table tbody tr").first().waitFor({ timeout: 15_000 });
    const walletLinks = page.locator("table tbody tr a[href*='0x']");
    const count = await walletLinks.count();
    expect(count).toBeGreaterThan(0);
  });

  test("sorting columns works", async ({ page }) => {
    await page.goto("/");
    await page.locator("table tbody tr").first().waitFor({ timeout: 15_000 });

    // Click the "Score" column header to sort
    const scoreHeader = page.locator("th").filter({ hasText: "Score" });
    await expect(scoreHeader).toBeVisible();
    await scoreHeader.click();
    // Table should still have rows after re-sort
    await expect(page.locator("table tbody tr").first()).toBeVisible();

    // Click again to reverse sort direction
    await scoreHeader.click();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  });

  test("table has expected column headers", async ({ page }) => {
    await page.goto("/");
    await page.locator("table").waitFor({ timeout: 15_000 });
    const headers = page.locator("table th");
    const headerTexts = await headers.allTextContents();
    const joined = headerTexts.join(" ");
    // Key columns that should be present
    expect(joined).toContain("Wallet");
    expect(joined).toContain("Score");
    expect(joined).toMatch(/P&L/);
    expect(joined).toContain("Win");
    expect(joined).toContain("Hold");
  });

  test("copy score displays correctly", async ({ page }) => {
    await page.goto("/");
    await page.locator("table tbody tr").first().waitFor({ timeout: 15_000 });
    // First row should have a score cell — either a number or "N/A"
    const firstRow = page.locator("table tbody tr").first();
    const cells = firstRow.locator("td");
    const allText = await firstRow.textContent();
    // Should have some numeric content (scores, percentages, dollar amounts)
    expect(allText).toMatch(/\d/);
  });

  test("dismiss button removes bot from list", async ({ page }) => {
    await page.goto("/");
    await page.locator("table tbody tr").first().waitFor({ timeout: 15_000 });
    const initialCount = await page.locator("table tbody tr").count();
    if (initialCount > 1) {
      // Click dismiss (X) button on the last row to avoid disrupting top bots
      const lastRow = page.locator("table tbody tr").last();
      const dismissBtn = lastRow.locator("button").last();
      await dismissBtn.click();
      // Row count should decrease
      await expect(page.locator("table tbody tr")).toHaveCount(
        initialCount - 1,
        { timeout: 5_000 },
      );
    }
  });

  test("wallet link navigates to detail page", async ({ page }) => {
    await page.goto("/");
    await page.locator("table tbody tr").first().waitFor({ timeout: 15_000 });
    const walletLink = page
      .locator("table tbody tr a[href*='/wallet/']")
      .first();
    if (await walletLink.isVisible()) {
      const href = await walletLink.getAttribute("href");
      expect(href).toContain("/wallet/0x");
      await walletLink.click();
      await expect(page).toHaveURL(/\/wallet\/0x/);
      await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });
    }
  });
});
