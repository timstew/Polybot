import { test, expect } from "@playwright/test";

test.describe("Watchlist page", () => {
  test("loads and shows watchlist heading", async ({ page }) => {
    await page.goto("/watchlist");
    await expect(page.locator("h1")).toContainText("Watchlist");
  });

  test("shows summary stat cards", async ({ page }) => {
    await page.goto("/watchlist");
    // Should show the 4 summary cards even if watchlist is empty
    await expect(page.locator("text=Watching")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator("text=Profitable")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator("text=Avg Win Rate")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator("text=Best Today")).toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe("Watchlist: add from dashboard and verify snapshot", () => {
  // Pick the first bot from the dashboard and add it to the watchlist,
  // then verify it appears on the watchlist page with snapshot data.

  let addedWallet: string;

  test("add bot to watchlist from dashboard", async ({ page }) => {
    await page.goto("/");
    // Wait for bot rankings table to load
    await page.locator("table tbody tr").first().waitFor({ timeout: 15_000 });

    // Find a wallet link to get the address
    const firstWalletLink = page
      .locator("table tbody tr a[href*='/wallet/0x']")
      .first();
    const href = await firstWalletLink.getAttribute("href");
    expect(href).toBeTruthy();
    addedWallet = href!.replace("/wallet/", "");

    // Click the binoculars button (Add to watchlist) in the same row
    const row = page.locator("table tbody tr").first();
    const watchlistBtn = row.locator("button").filter({
      has: page.locator("svg.lucide-binoculars"),
    });

    // If the bot is already on the watchlist, it'll show a check icon instead
    const isAlreadyWatchlisted = await row
      .locator("svg.lucide-check")
      .isVisible();
    if (isAlreadyWatchlisted) {
      // Bot already on watchlist — skip add, just verify it's there
      test.skip();
      return;
    }

    await expect(watchlistBtn).toBeVisible({ timeout: 5_000 });
    await watchlistBtn.click();

    // After clicking, the binoculars should be replaced by a check icon
    await expect(row.locator("svg.lucide-check").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("watchlist page shows the added bot with snapshot data", async ({
    page,
  }) => {
    // Navigate to watchlist page
    await page.goto("/watchlist");
    await expect(page.locator("h1")).toContainText("Watchlist");

    // Wait for the watchlist table to load
    const table = page.locator("table");
    await expect(table).toBeVisible({ timeout: 15_000 });

    // Should have at least one row
    const rows = table.locator("tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });

    // At least one entry should have a category badge (not "unknown")
    // and some P&L data (snapshot was taken on add)
    const firstRowText = await rows.first().textContent();
    expect(firstRowText).toBeTruthy();

    // Check that at least one row has numeric profit data (not all dashes)
    const allRowsText = await table.locator("tbody").textContent();
    // Should contain dollar amounts or percentages from snapshots
    expect(allRowsText).toMatch(/\$[\d,]+|[\d.]+%/);
  });

  test("watchlist entry has non-empty category", async ({ page }) => {
    await page.goto("/watchlist");
    const table = page.locator("table");
    await expect(table).toBeVisible({ timeout: 15_000 });
    await table.locator("tbody tr").first().waitFor({ timeout: 15_000 });

    // Category badges should exist — look for known categories
    const badges = table.locator("tbody .inline-flex, tbody [class*='badge']");
    const count = await badges.count();
    if (count > 0) {
      const badgeText = await badges.first().textContent();
      // Should be a real category, not "unknown"
      expect(badgeText?.toLowerCase()).not.toBe("unknown");
    }
  });

  test("Watching count reflects entries", async ({ page }) => {
    await page.goto("/watchlist");
    // Wait for data to load
    await expect(page.locator("text=Watching")).toBeVisible({
      timeout: 10_000,
    });
    // The "Watching" label is inside a Card — find the Card ancestor
    const watchingCard = page
      .locator("text=Watching")
      .locator("xpath=ancestor::*[contains(@class,'rounded-')]")
      .first();
    const cardText = await watchingCard.textContent();
    // Should contain a digit (the count)
    expect(cardText).toMatch(/\d/);
  });
});

test.describe("Watchlist: remove entry", () => {
  test("can remove a bot from watchlist", async ({ page }) => {
    await page.goto("/watchlist");
    const table = page.locator("table");

    // Only run if there are entries
    const visible = await table.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    const rows = table.locator("tbody tr");
    const rowCount = await rows.count().catch(() => 0);
    if (rowCount === 0) {
      test.skip();
      return;
    }

    // Click the remove button (trash icon) on the last row
    const lastRow = rows.last();
    const removeBtn = lastRow.locator("button").filter({
      has: page.locator("svg.lucide-trash-2, svg.lucide-x"),
    });
    if (await removeBtn.isVisible()) {
      await removeBtn.click();
      // Row count should decrease or empty state should show
      if (rowCount === 1) {
        // Should show empty state
        await expect(
          page.locator("text=/no bots|empty|add.*watchlist/i"),
        ).toBeVisible({
          timeout: 5_000,
        });
      } else {
        await expect(rows).toHaveCount(rowCount - 1, { timeout: 5_000 });
      }
    }
  });
});
