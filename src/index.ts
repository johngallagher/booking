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

async function getAllSlots(page: Page): Promise<Slot[]> {
  const today = new Date();
  const allSlots: Slot[] = [];

  const firstDate = today.toISOString().split("T")[0];
  await page.goto(`${BASE_URL}/${firstDate}/by-time`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);

  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const date = d.toISOString().split("T")[0];

    await page.goto(`${BASE_URL}/${date}/by-time`, { waitUntil: "domcontentloaded" });

    await page
      .waitForSelector(
        '[aria-label^="Ad Hoc session"], [class*="FullyBooked"], :text-is("No results were found at this centre.")',
        { timeout: 10000 }
      )
      .catch(() => {});

    const slots = await page.evaluate((date: string) => {
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

    console.log(`${date}: ${slots.length} available slot(s)`);
    allSlots.push(...slots);
  }

  return allSlots;
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  const allSlots = await getAllSlots(page);

  console.log("\nAll available slots:");
  console.log(JSON.stringify(allSlots, null, 2));

  await browser.close();
}

main().catch(console.error);
