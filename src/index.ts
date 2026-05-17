import { chromium, type Page } from "playwright";

const BASE_URL =
  "https://bookings.better.org.uk/location/indoor-tennis-centre-and-ozone-complex/tennis-court-indoor";

interface Slot {
  date: string;
  startTime: string;
  endTime: string;
  spaces: number;
  price: string;
  bookingUrl: string;
}

async function dismissCookies(page: Page) {
  const btn = await page.waitForSelector("#onetrust-accept-btn-handler", { state: "visible", timeout: 5000 });
  await btn.click();
}

async function getSlotsForDate(page: Page, date: string): Promise<Slot[]> {
  await page.goto(`${BASE_URL}/${date}/by-time`, { waitUntil: "domcontentloaded" });

  await page
    .waitForSelector('[aria-label^="Ad Hoc session"], [class*="FullyBooked"]', {
      timeout: 10000,
    })
    .catch(() => {});

  return page.evaluate((date: string) => {
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        'a[aria-label^="Ad Hoc session"][href*="/slot/"]'
      )
    );

    return links.map((link) => {
      const card = link.closest('[class*="ByTimeListComponent__Wrap"]');
      const timeText =
        card
          ?.querySelector('[class*="ClassCardComponent__ClassTime"]')
          ?.textContent?.trim() ?? "";
      const [startTime = "", endTime = ""] = timeText.split(" - ");
      const price =
        card
          ?.querySelector('[class*="ClassCardComponent__Price"]')
          ?.textContent?.trim() ?? "";
      const spaces = parseInt(
        card?.querySelector("[spaces]")?.getAttribute("spaces") ?? "0",
        10
      );

      return { date, startTime, endTime, spaces, price, bookingUrl: link.href };
    });
  }, date);
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  const allSlots: Slot[] = [];
  const today = new Date();

  const d = new Date(today);
  d.setDate(today.getDate() + 0);
  const date = d.toISOString().split("T")[0];
  await page.goto(`${BASE_URL}/${date}/by-time`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);

  for (let i = 0; i < 7; i++) {
    d.setDate(today.getDate() + i);
    const date = d.toISOString().split("T")[0];
    const slots = await getSlotsForDate(page, date);
    allSlots.push(...slots);
    console.log(`${date}: ${slots.length} available slot(s)`);
  }

  console.log("\nAll available slots:");
  console.log(JSON.stringify(allSlots, null, 2));

  await browser.close();
}

main().catch(console.error);
