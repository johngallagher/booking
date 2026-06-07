import { chromium, type Page } from "playwright";
import * as fs from "fs";
import { gymSchedule } from "./config";

const SCHEDULE_BASE = "https://goteamup.com/p/4993559-tribe-ormeau/c/schedule";
const LOGIN_URL = "https://goteamup.com/login/";

export interface GymSession {
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  spotsAvailable: number;
  bookingUrl?: string;
}

function allowedSessions(): string[] {
  const { activeMembership, memberships } = gymSchedule;
  if (activeMembership === "sgpt") {
    return [...memberships.boxing.sessions, ...memberships.sgpt.extraSessions];
  }
  return memberships.boxing.sessions;
}

export function isAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  return allowedSessions().some((s) => s.toLowerCase() === lower);
}

function toLocalDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addHour(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const newH = (h + 1) % 24;
  return `${String(newH).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseSpots(text: string): number {
  // "Full 12/12" → 0, "11/12" → 1, "7" → 7, "0/1" → 0
  const full = text.match(/full/i);
  if (full) return 0;
  const fraction = text.match(/(\d+)\/(\d+)/);
  if (fraction) return parseInt(fraction[2], 10) - parseInt(fraction[1], 10);
  const simple = text.match(/(\d+)/);
  if (simple) return parseInt(simple[1], 10);
  return 1;
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");

  // Step 1: email
  await page.fill('input[type="email"]', email);
  await Promise.race([
    page.click('button:has-text("Next")').catch(() => {}),
    page.click('button[type="submit"]').catch(() => {}),
  ]);

  // Step 2: password (may appear on same page or after transition)
  try {
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  } catch {
    // Already on password screen
  }
  await page.fill('input[type="password"]', password);
  await page.keyboard.press("Enter");

  await page.waitForFunction(() => !window.location.href.includes("/login"), {
    timeout: 15000,
  });
  console.log("Logged in to TeamUp");
}

// Clicking the list-level "Book" button opens a details modal and pushes a
// `?...&e=<id>` URL via client-side routing — without booking the class.
// Only the modal's internal "Book now" button actually books, and we never touch it.
async function closeBookingModal(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);
  if (/[?&]e=\d+/.test(page.url())) {
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  }
  await page.waitForSelector(".schedule-event-container", { timeout: 10000 }).catch(() => {});
}

async function extractBookingUrl(page: Page, session: GymSession): Promise<string | undefined> {
  try {
    const timeEls = page.locator(`time[datetime="${session.date}T${session.startTime}:00"]`);
    const count = await timeEls.count();
    for (let i = 0; i < count; i++) {
      const container = timeEls.nth(i).locator("xpath=following-sibling::*[1]");
      const name = (
        (await container.locator(".eventitem-name h6, h6.title").textContent().catch(() => "")) ?? ""
      )
        .replace(/<!---->/g, "")
        .trim();
      if (name.toLowerCase() !== session.name.toLowerCase()) continue;

      await container.getByRole("button", { name: "Book", exact: true }).click({ timeout: 5000 });
      await page.waitForURL(/[?&]e=\d+/, { timeout: 10000 });
      const url = page.url();
      await closeBookingModal(page);
      return url;
    }
  } catch (err) {
    console.log(
      `Could not extract booking URL for "${session.name}" @ ${session.date} ${session.startTime}: ${err}`
    );
    await closeBookingModal(page);
  }
  return undefined;
}

export async function getAllSessions(page: Page): Promise<GymSession[]> {
  const email = process.env.TEAMUP_EMAIL;
  const password = process.env.TEAMUP_PASSWORD;
  if (!email || !password) throw new Error("TEAMUP_EMAIL and TEAMUP_PASSWORD must be set");

  await login(page, email, password);

  const today = new Date();
  const endD = new Date(today);
  endD.setDate(today.getDate() + 6);
  const startStr = toLocalDateString(today);
  const endStr = toLocalDateString(endD);

  // One load covers the full 7-day window
  const url = `${SCHEDULE_BASE}?startdate=${startStr}&enddate=${endStr}&date=${startStr}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");

  // Wait for schedule items to appear
  await page
    .waitForSelector(".schedule-event-container", { timeout: 10000 })
    .catch(() => {});

  if (process.env.TEAMUP_DEBUG) {
    await page.screenshot({ path: `teamup-debug-${startStr}.png`, fullPage: true });
    fs.writeFileSync(`teamup-debug-${startStr}.html`, await page.content());
    console.log(`Debug files saved for ${startStr}`);
  }

  const debug = !!process.env.TEAMUP_DEBUG;

  const raw = await page.evaluate((debug: boolean) => {
    const containers = Array.from(document.querySelectorAll(".schedule-event-container"));

    return containers.flatMap((container) => {
      // The <time> element is the direct previous sibling
      const timeEl = container.previousElementSibling as HTMLElement | null;
      if (timeEl?.tagName !== "TIME") return [];

      const datetime = timeEl.getAttribute("datetime") ?? "";
      // datetime = "2026-06-01T05:00:00"
      const [datePart, timePart] = datetime.split("T");
      if (!datePart || !timePart) return [];
      const startTime = timePart.slice(0, 5); // "05:00"

      const titleEl = container.querySelector(".eventitem-name h6, h6.title");
      const name = (titleEl?.textContent ?? "").replace(/<!---->/g, "").trim();
      if (!name) return [];

      // Spots: icon class is i-fas-user (available) or i-fas-users (full)
      const spotsEl = container.querySelector(".i-fas-user, .i-fas-users")?.closest("p");
      const spotsText = (spotsEl?.textContent ?? "").trim();

      // Look for any link/element carrying a booking event id (e.g. href="...?e=12345" or data-* attrs)
      let bookingHref: string | null = null;
      let sampleHtml: string | null = null;
      if (debug) {
        const link = container.querySelector<HTMLAnchorElement>('a[href*="e="], a[href*="event"]');
        bookingHref = link?.getAttribute("href") ?? null;
        sampleHtml = container.outerHTML.slice(0, 4000);
      }

      return [{ name, date: datePart, startTime, spotsText, bookingHref, sampleHtml }];
    });
  }, debug);

  const sessions: GymSession[] = raw.map((s) => ({
    name: s.name,
    date: s.date,
    startTime: s.startTime,
    endTime: addHour(s.startTime),
    spotsAvailable: parseSpots(s.spotsText),
  }));

  const before = sessions.length;
  const filtered = sessions.filter((s) => isAllowed(s.name) && s.spotsAvailable > 0);
  console.log(`${before} raw session(s), ${filtered.length} after filtering excluded/full`);

  for (const session of filtered) {
    session.bookingUrl = await extractBookingUrl(page, session);
  }

  if (debug) {
    console.log("\n── DEBUG: all raw sessions ──");
    for (const s of raw) {
      console.log(
        `${s.date} ${s.startTime} | "${s.name}" | spots="${s.spotsText}" | allowed=${isAllowed(s.name)} | href=${s.bookingHref ?? "none"}`
      );
    }
    const withHref = raw.find((s) => s.bookingHref);
    if (withHref?.sampleHtml) {
      console.log("\n── DEBUG: sample container HTML (with booking href) ──");
      console.log(withHref.sampleHtml);
    } else if (raw[0]?.sampleHtml) {
      console.log("\n── DEBUG: sample container HTML (first session, no href found) ──");
      console.log(raw[0].sampleHtml);
    }
  }

  return filtered;
}

async function main() {
  const browser = await chromium.launch({ headless: process.env.CI === "true" });
  const page = await browser.newPage();

  const sessions = await getAllSessions(page);
  console.log("\nAll available sessions:");
  console.log(JSON.stringify(sessions, null, 2));

  await browser.close();
}

if (require.main === module) main().catch(console.error);
