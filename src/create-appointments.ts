import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";
import { chromium } from "playwright";
import { authorize } from "./get-calendar-slots";
import { getAllSlots, type AvailableCourt } from "./index";
import { tennisSchedule, exerciseCalendarId } from "./config";
import { withRetry, sleep } from "./calendar-retry";

const KING_ACCOUNT = "kingofkerning@gmail.com";

function isEveningOrWeekend(court: AvailableCourt): boolean {
  if (court.startTime >= "18:00") return true;
  const [year, month, day] = court.date.split("-").map(Number);
  const dow = new Date(year, month - 1, day).getDay();
  return dow === 0 || dow === 6;
}

function courtMatchesEvent(court: AvailableCourt, event: calendar_v3.Schema$Event): boolean {
  return !!event.start?.dateTime?.startsWith(`${court.date}T${court.startTime}`);
}

async function getExistingIndoorTennisEvents(
  calendar: ReturnType<typeof google.calendar>,
  calendarId: string,
  lookaheadDays: number
): Promise<calendar_v3.Schema$Event[]> {
  const now = new Date();
  const later = new Date(now);
  later.setDate(now.getDate() + lookaheadDays);

  const res = await withRetry(() => calendar.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: later.toISOString(),
    singleEvents: true,
  }));

  return (res.data.items ?? []).filter((e) => e.summary === tennisSchedule.sessionName);
}

async function createIndoorTennisEvent(
  calendar: ReturnType<typeof google.calendar>,
  calendarId: string,
  court: AvailableCourt
): Promise<void> {
  await withRetry(() => calendar.events.insert({
    calendarId,
    sendUpdates: "none",
    requestBody: {
      summary: tennisSchedule.sessionName,
      attendees: [{ email: KING_ACCOUNT }],
      description: `Booking URL: ${court.bookingUrl}\nPrice: ${court.price}`,
      start: { dateTime: `${court.date}T${court.startTime}:00`, timeZone: "Europe/London" },
      end: { dateTime: `${court.date}T${court.endTime}:00`, timeZone: "Europe/London" },
      status: "tentative",
      transparency: "transparent",
    },
  }));
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const availableCourts = await getAllSlots(page);
  await browser.close();

  const filteredCourts = availableCourts.filter(isEveningOrWeekend);
  console.log(`${filteredCourts.length} evening/weekend court(s) found`);

  const auth = await authorize(KING_ACCOUNT);
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = exerciseCalendarId;
  const existingEvents = await getExistingIndoorTennisEvents(calendar, calendarId, 7);

  // Delete events that are no longer in the available courts list (skip already-booked ones)
  let deleted = 0;
  for (const event of existingEvents) {
    if (event.description?.startsWith("BOOKED")) continue;
    if (!filteredCourts.some((court) => courtMatchesEvent(court, event))) {
      await withRetry(() => calendar.events.delete({ calendarId, eventId: event.id!, sendUpdates: "none" }));
      await sleep(500);
      console.log(`Deleted: ${event.start?.dateTime} (no longer available)`);
      deleted++;
    }
  }

  // Create events for courts not already in the calendar
  let created = 0;
  let skipped = 0;
  for (const court of filteredCourts) {
    if (existingEvents.some((event) => courtMatchesEvent(court, event))) {
      skipped++;
      continue;
    }
    await createIndoorTennisEvent(calendar, calendarId, court);
    await sleep(500);
    console.log(`Created: ${court.date} ${court.startTime}–${court.endTime} (${court.price})`);
    created++;
  }

  console.log(`\nDone: ${created} created, ${skipped} already existed, ${deleted} deleted`);
}

if (require.main === module) main().catch(console.error);
