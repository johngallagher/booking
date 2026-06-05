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
}

export function isExcluded(name: string): boolean {
  const lower = name.toLowerCase();
  return gymSchedule.excludedSessions.some((kw) => lower.includes(kw));
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

  const raw = await page.evaluate(() => {
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

      return [{ name, date: datePart, startTime, spotsText }];
    });
  });

  const sessions: GymSession[] = raw.map((s) => ({
    name: s.name,
    date: s.date,
    startTime: s.startTime,
    endTime: addHour(s.startTime),
    spotsAvailable: parseSpots(s.spotsText),
  }));

  const before = sessions.length;
  const filtered = sessions.filter((s) => !isExcluded(s.name) && s.spotsAvailable > 0);
  console.log(`${before} raw session(s), ${filtered.length} after filtering excluded/full`);
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
