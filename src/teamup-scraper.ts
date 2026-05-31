import { chromium, type Page } from "playwright";
import * as fs from "fs";

const SCHEDULE_BASE = "https://goteamup.com/p/4993559-tribe-ormeau/c/schedule";
const LOGIN_URL = "https://goteamup.com/login/";

export interface GymSession {
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  spotsAvailable: number;
}

const EXCLUDED = ["hyrox", "high rocks", "progress review"];

export function isExcluded(name: string): boolean {
  const lower = name.toLowerCase();
  return EXCLUDED.some((kw) => lower.includes(kw));
}

function toLocalDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Normalise "9:00am" or "09:00" to "09:00"
function parseTime(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(am|pm)?$/i);
  if (!m) return raw.trim();
  let h = parseInt(m[1], 10);
  const min = m[2];
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === "pm" && h < 12) h += 12;
  if (meridiem === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");

  // Step 1: email
  await page.fill('input[type="email"]', email);
  await Promise.race([
    page.click('button:has-text("Next")'),
    page.click('button[type="submit"]'),
  ]).catch(() => page.keyboard.press("Enter"));

  // Step 2: password (some flows show it on the same page, others reveal it)
  await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]').catch(() => page.keyboard.press("Enter"));

  await page.waitForFunction(() => !window.location.href.includes("/login"), {
    timeout: 15000,
  });
  console.log("Logged in to TeamUp");
}

async function parseSessionsForDay(page: Page, date: string): Promise<GymSession[]> {
  const url = `${SCHEDULE_BASE}?startdate=${date}&enddate=${date}&date=${date}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");

  // Wait for session content or empty-state indicator
  await page
    .waitForSelector(
      [
        ".class-listing__item",
        ".classlist li",
        ".class-item",
        '[class*="ClassList"] li',
        "li.cs-class",
        '[class*="class-listing"]',
        '[class*="no-classes"]',
        '[class*="no-results"]',
        ".empty",
      ].join(", "),
      { timeout: 8000 }
    )
    .catch(() => {});

  if (process.env.TEAMUP_DEBUG) {
    const html = await page.content();
    fs.writeFileSync(`teamup-debug-${date}.html`, html);
    await page.screenshot({ path: `teamup-debug-${date}.png`, fullPage: true });
    console.log(`Debug files saved for ${date}`);
  }

  return page.evaluate((date: string) => {
    const SELECTORS = [
      ".class-listing__item",
      ".classlist li",
      ".class-item",
      "li.cs-class",
      '[class*="ClassList"] li',
      '[class*="class-listing-item"]',
    ];

    let items: Element[] = [];
    for (const sel of SELECTORS) {
      items = Array.from(document.querySelectorAll(sel));
      if (items.length > 0) break;
    }

    if (items.length === 0) return [];

    return items.flatMap((item) => {
      const nameEl = item.querySelector(
        '.classname, .class-name, [class*="class-name"], [class*="classname"], h3, h4, strong'
      );
      const name = nameEl?.textContent?.trim() ?? "";
      if (!name) return [];

      const timeEl = item.querySelector(
        '.time, [class*="time"], [class*="schedule-time"], [class*="class-time"], time'
      );
      const timeText = timeEl?.textContent?.trim() ?? "";
      const timeMatch = timeText.match(
        /(\d{1,2}:\d{2}(?:\s?[ap]m)?)\s*[-–]\s*(\d{1,2}:\d{2}(?:\s?[ap]m)?)/i
      );
      const startRaw = timeMatch?.[1] ?? "";
      const endRaw = timeMatch?.[2] ?? "";

      const spotsEl = item.querySelector(
        '[class*="spot"], [class*="space"], [class*="avail"], [class*="capacity"]'
      );
      const spotsText = spotsEl?.textContent ?? "";
      const spotsMatch = spotsText.match(/(\d+)/);
      const spotsAvailable = spotsMatch ? parseInt(spotsMatch[1], 10) : 1;

      return [{ name, date, startRaw, endRaw, spotsAvailable }];
    });
  }, date).then((raw) =>
    raw
      .filter((s) => s.startRaw)
      .map((s) => ({
        name: s.name,
        date: s.date,
        startTime: parseTime(s.startRaw),
        endTime: parseTime(s.endRaw),
        spotsAvailable: s.spotsAvailable,
      }))
  );
}

export async function getAllSessions(page: Page): Promise<GymSession[]> {
  const email = process.env.TEAMUP_EMAIL;
  const password = process.env.TEAMUP_PASSWORD;
  if (!email || !password) throw new Error("TEAMUP_EMAIL and TEAMUP_PASSWORD must be set");

  await login(page, email, password);

  const today = new Date();
  const allSessions: GymSession[] = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const date = toLocalDateString(d);

    const sessions = await parseSessionsForDay(page, date);
    const filtered = sessions.filter((s) => !isExcluded(s.name));
    console.log(`${date}: ${sessions.length} session(s), ${filtered.length} after filter`);
    allSessions.push(...filtered);
  }

  return allSessions;
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
