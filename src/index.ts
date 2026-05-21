import { chromium, type Page } from "playwright";
import type { TimeSlot } from "./types";

export { TimeSlot };

const BASE_URL =
  "https://bookings.better.org.uk/location/indoor-tennis-centre-and-ozone-complex/tennis-court-indoor";

export interface AvailableCourt extends TimeSlot {
  spaces: number;
  price: string;
  bookingUrl: string;
}

function toLocalDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function dismissCookies(page: Page) {
  const btn = await page.waitForSelector("#onetrust-accept-btn-handler", { state: "visible", timeout: 5000 });
  await btn.click();
}

export async function getAllSlots(page: Page): Promise<AvailableCourt[]> {
  const today = new Date();
  const allSlots: AvailableCourt[] = [];

  const firstDate = toLocalDateString(today);
  await page.goto(`${BASE_URL}/${firstDate}/by-time`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);

  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const date = toLocalDateString(d);

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
