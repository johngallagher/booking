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

// Schedule UI link showing just the given day (the page supports day-level
// navigation via query params, but not scrolling to a specific time)
export function scheduleUrlForDate(date: string): string {
  return `${SCHEDULE_BASE}?startdate=${date}&enddate=${date}&date=${date}`;
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

export async function getAllSessions(page: Page): Promise<GymSession[]> {
  const email = process.env.TEAMUP_EMAIL;
  const password = process.env.TEAMUP_PASSWORD;
  if (!email || !password) throw new Error("TEAMUP_EMAIL and TEAMUP_PASSWORD must be set");

  await login(page, email, password);

  const today = new Date();
  const debug = !!process.env.TEAMUP_DEBUG;
  const raw: RawScraped[] = [];

  // The schedule page renders one week per load, so fetch two consecutive
  // week windows to cover the full 14-day lookahead
  for (const offset of [0, 7]) {
    const startD = new Date(today);
    startD.setDate(today.getDate() + offset);
    const endD = new Date(startD);
    endD.setDate(startD.getDate() + 6);
    const startStr = toLocalDateString(startD);
    const endStr = toLocalDateString(endD);

    const url = `${SCHEDULE_BASE}?startdate=${startStr}&enddate=${endStr}&date=${startStr}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // Wait for schedule items to appear
    await page
      .waitForSelector(".schedule-event-container", { timeout: 10000 })
      .catch(() => {});

    if (debug) {
      await page.screenshot({ path: `teamup-debug-${startStr}.png`, fullPage: true });
      fs.writeFileSync(`teamup-debug-${startStr}.html`, await page.content());
      console.log(`Debug files saved for ${startStr}`);
    }

    const pageSessions = await scrapeVisibleSessions(page, debug);

    // For sessions we'd actually create an event for, click through to the
    // booking modal to capture its URL (which includes the `e=<id>` event
    // id), so the calendar event can link straight to it.
    for (const s of pageSessions) {
      if (isAllowed(s.name) && parseSpots(s.spotsText) > 0) {
        s.bookingUrl = await captureBookingUrl(page, s.scrapeIdx, debug);
      }
    }

    raw.push(...pageSessions);
  }
  return finishSessions(raw, debug);
}

// Clicks a session's "Book" button to open its details modal, which TeamUp
// reflects in the URL as an `e=<id>` query param, then closes the modal
// without interacting with anything inside it (so nothing gets booked).
async function captureBookingUrl(page: Page, scrapeIdx: number, debug: boolean): Promise<string | undefined> {
  const button = page.locator(`[data-scrape-idx="${scrapeIdx}"] .cta button`).first();
  try {
    await button.scrollIntoViewIfNeeded({ timeout: 5000 });
    await button.click({ timeout: 5000 });
    await page.waitForURL((url: URL) => url.searchParams.has("e"), { timeout: 5000 });
    const bookingUrl = page.url();
    await page.keyboard.press("Escape");
    await page.waitForURL((url: URL) => !url.searchParams.has("e"), { timeout: 2000 }).catch(() => {});
    return bookingUrl;
  } catch (err) {
    if (debug) console.log(`Could not capture booking URL for item ${scrapeIdx}: ${err}`);
    await page.keyboard.press("Escape").catch(() => {});
    return undefined;
  }
}

type RawScraped = {
  name: string;
  date: string;
  startTime: string;
  datetimeRaw: string;
  spotsText: string;
  scrapeIdx: number;
  bookingUrl?: string;
  bookingHref: string | null;
  sampleHtml: string | null;
};

function scrapeVisibleSessions(page: Page, debug: boolean): Promise<RawScraped[]> {
  return page.evaluate((debug: boolean) => {
    // tsx/esbuild's keepNames option wraps named const functions (e.g. `get` below)
    // in calls to a `__name` helper. That helper isn't defined in the page context
    // when this function is serialized for page.evaluate, so polyfill it here.
    (globalThis as Record<string, unknown>).__name ??= (fn: unknown) => fn;

    const containers = Array.from(document.querySelectorAll(".schedule-event-container")) as HTMLElement[];

    // Slot-header <time> elements live alongside (not inside) event containers —
    // exclude <time> elements nested within a container (e.g. "Registration closed" times).
    const timeEls = Array.from(document.querySelectorAll("time[datetime]")).filter(
      (t) => !t.closest(".schedule-event-container")
    ) as HTMLElement[];

    // TeamUp's <time datetime="..."> values are in UTC; convert to Europe/London
    // local time so displayed times match what the site shows the user.
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });

    let scrapeIdx = 0;

    return containers.flatMap((container) => {
      // Multiple sessions can share one <time> header, and DOM order doesn't always
      // match visual order in the schedule's grid layout — so find the nearest <time>
      // header positioned at or above this container in the same column, by geometry
      // rather than by walking previousElementSibling.
      const containerRect = container.getBoundingClientRect();
      let timeEl: HTMLElement | null = null;
      let bestTop = -Infinity;
      for (const t of timeEls) {
        const r = t.getBoundingClientRect();
        const sameColumn = r.left < containerRect.right && r.right > containerRect.left;
        if (sameColumn && r.top <= containerRect.top + 1 && r.top > bestTop) {
          bestTop = r.top;
          timeEl = t;
        }
      }
      if (!timeEl) return [];

      const datetimeRaw = timeEl.getAttribute("datetime") ?? "";
      const d = new Date(datetimeRaw);
      if (isNaN(d.getTime())) return [];

      const parts = fmt.formatToParts(d);
      const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
      const datePart = `${get("year")}-${get("month")}-${get("day")}`;
      const startTime = `${get("hour")}:${get("minute")}`; // "08:00" in Europe/London

      // A single container can stack multiple events sharing the same time
      // slot (e.g. BOX-TEC and SGPT both at 7am), each as its own
      // .calendar-event card — process every one, not just the first.
      const eventEls = Array.from(container.querySelectorAll(".calendar-event"));
      const items = eventEls.length > 0 ? eventEls : [container];

      return items.flatMap((item) => {
        const titleEl = item.querySelector(".eventitem-name h6, h6.title");
        const name = (titleEl?.textContent ?? "").replace(/<!---->/g, "").trim();
        if (!name) return [];

        // Spots: icon class is i-fas-user (available) or i-fas-users (full)
        const spotsEl = item.querySelector(".i-fas-user, .i-fas-users")?.closest("p");
        const spotsText = (spotsEl?.textContent ?? "").trim();

        // Look for any link/element carrying a booking event id (e.g. href="...?e=12345" or data-* attrs)
        let bookingHref: string | null = null;
        let sampleHtml: string | null = null;
        if (debug) {
          const link = item.querySelector<HTMLAnchorElement>('a[href*="e="], a[href*="event"]');
          bookingHref = link?.getAttribute("href") ?? null;
          sampleHtml = item.outerHTML.slice(0, 4000);
        }

        const idx = scrapeIdx++;
        item.setAttribute("data-scrape-idx", String(idx));

        return [{ name, date: datePart, startTime, datetimeRaw, spotsText, scrapeIdx: idx, bookingHref, sampleHtml }];
      });
    });
  }, debug);
}

function finishSessions(raw: RawScraped[], debug: boolean): GymSession[] {
  const sessions: GymSession[] = raw.map((s) => ({
    name: s.name,
    date: s.date,
    startTime: s.startTime,
    endTime: addHour(s.startTime),
    spotsAvailable: parseSpots(s.spotsText),
    bookingUrl: s.bookingUrl,
  }));

  const before = sessions.length;
  const filtered = sessions.filter((s) => isAllowed(s.name) && s.spotsAvailable > 0);
  console.log(`${before} raw session(s), ${filtered.length} after filtering excluded/full`);

  if (debug) {
    console.log("\n── DEBUG: all raw sessions ──");
    for (const s of raw) {
      console.log(
        `${s.date} ${s.startTime} (raw datetime="${s.datetimeRaw}") | "${s.name}" | spots="${s.spotsText}" | allowed=${isAllowed(s.name)} | href=${s.bookingHref ?? "none"}`
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
  try {
    const page = await browser.newPage();

    const sessions = await getAllSessions(page);
    console.log("\nAll available sessions:");
    console.log(JSON.stringify(sessions, null, 2));
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
