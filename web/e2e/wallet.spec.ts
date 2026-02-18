import { test, expect } from "@playwright/test";

// Use a known active copy target wallet for testing
const TEST_WALLET = "0x2ba9075a4393227d4f1bee910725a6706de0b078";

test.describe("Wallet detail page", () => {
  test("loads without 404", async ({ page }) => {
    const response = await page.goto(`/wallet/${TEST_WALLET}`);
    expect(response?.status()).toBe(200);
  });

  test("shows username in heading", async ({ page }) => {
    await page.goto(`/wallet/${TEST_WALLET}`);
    const heading = page.locator("h1");
    await expect(heading).toBeVisible({ timeout: 15_000 });
    // Should show a username, not just "Wallet"
    const text = await heading.textContent();
    expect(text).toBeTruthy();
    // Username should eventually load (not stay as just "Wallet")
    await expect(heading).not.toHaveText("Wallet", { timeout: 15_000 });
  });

  test("shows P&L card", async ({ page }) => {
    await page.goto(`/wallet/${TEST_WALLET}`);
    // Profit & Loss card should be visible
    await expect(
      page.locator("text=/Profit.*Loss/i").first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("shows portfolio card", async ({ page }) => {
    await page.goto(`/wallet/${TEST_WALLET}`);
    await expect(
      page.locator("text=/Portfolio/i").first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("shows activity card", async ({ page }) => {
    await page.goto(`/wallet/${TEST_WALLET}`);
    await expect(
      page.locator("text=/Activity/i").first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("wallet links from copy page resolve to 200", async ({ page }) => {
    await page.goto("/copy");
    const firstRow = page.locator("table").first().locator("tbody tr").first();
    await firstRow.waitFor({ timeout: 15_000 });
    // Find the first wallet link in the table
    const walletLink = page.locator("table").first().locator("a[href*='/wallet/']").first();
    if (await walletLink.isVisible()) {
      const href = await walletLink.getAttribute("href");
      expect(href).toContain("/wallet/0x");
      // Navigate and check it's not a 404
      const response = await page.goto(href!);
      expect(response?.status()).toBe(200);
      // Should render the wallet page, not an error
      await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });
    }
  });
});
