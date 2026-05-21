import { chromium } from "playwright";

const BOOKING_URL = process.env.BOOKING_URL!;
const BETTER_EMAIL = process.env.BETTER_EMAIL!;
const BETTER_PASSWORD = process.env.BETTER_PASSWORD!;
const CARD_CVC = process.env.CARD_CVC!;
const DRY_RUN = process.env.DRY_RUN === "true";

async function bookCourt(bookingUrl: string) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(bookingUrl, { waitUntil: "domcontentloaded" });

    const cookieBtn = page.locator("#onetrust-accept-btn-handler");
    if (await cookieBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cookieBtn.click();
    }

    await page.locator('button[data-testid="login"]').click();
    await page.locator("#username").fill(BETTER_EMAIL);
    await page.locator("#password").fill(BETTER_PASSWORD);
    await page.locator('button[data-testid="log-in"]').click();

    await page.waitForSelector("#cvv", { timeout: 30000 });

    const cvvVisible = await page.locator("#cvv").isVisible();
    const payVisible = await page.locator('button[aria-label="Pay now"]').isVisible();

    if (!cvvVisible || !payVisible) {
      throw new Error(`Payment screen incomplete — CVV visible: ${cvvVisible}, Pay button visible: ${payVisible}`);
    }

    if (DRY_RUN) {
      console.log(`DRY RUN: would have booked court. Checkout URL: ${page.url()}`);
      return;
    }

    await page.locator("#cvv").fill(CARD_CVC);
    await page.locator('button[aria-label="Pay now"]').click();
    await page.waitForURL(/confirmation|receipt|success/, { timeout: 30000 });
    console.log(`Booking confirmed. Confirmation URL: ${page.url()}`);
  } finally {
    await browser.close();
  }
}

bookCourt(BOOKING_URL).catch((err) => {
  console.error("Booking failed:", err.message);
  process.exit(1);
});
