import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";
import { chromium } from "playwright";
import { authorize } from "./get-calendar-slots";
import { getAllSessions, type GymSession } from "./teamup-scraper";

const KING_ACCOUNT = "kingofkerning@gmail.com";
const JOHN_ACCOUNT = "john@synapticmishap.co.uk";
const EXERCISE_CALENDAR = "Exercise";

function sessionMatchesEvent(session: GymSession, event: calendar_v3.Schema$Event): boolean {
  return !!event.start?.dateTime?.startsWith(`${session.date}T${session.startTime}`);
}

function eventSummary(session: GymSession): string {
  return `Gym: ${session.name}`;
}

async function getExerciseCalendarId(
  calendar: ReturnType<typeof google.calendar>
): Promise<string> {
  const res = await calendar.calendarList.list();
  const cal = (res.data.items ?? []).find((c) => c.summary === EXERCISE_CALENDAR);
  if (!cal?.id) throw new Error(`"${EXERCISE_CALENDAR}" calendar not found on ${KING_ACCOUNT}`);
  return cal.id;
}

async function getExistingGymEvents(
  calendar: ReturnType<typeof google.calendar>,
  calendarId: string,
  lookaheadDays: number
): Promise<calendar_v3.Schema$Event[]> {
  const now = new Date();
  const later = new Date(now);
  later.setDate(now.getDate() + lookaheadDays);

  const res = await calendar.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: later.toISOString(),
    singleEvents: true,
  });

  return (res.data.items ?? []).filter((e) => e.summary?.startsWith("Gym: "));
}

async function createGymEvent(
  calendar: ReturnType<typeof google.calendar>,
  calendarId: string,
  session: GymSession
): Promise<void> {
  await calendar.events.insert({
    calendarId,
    sendUpdates: "all",
    requestBody: {
      summary: eventSummary(session),
      start: { dateTime: `${session.date}T${session.startTime}:00`, timeZone: "Europe/London" },
      end: { dateTime: `${session.date}T${session.endTime}:00`, timeZone: "Europe/London" },
      attendees: [{ email: KING_ACCOUNT }, { email: JOHN_ACCOUNT }],
    },
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const sessions = await getAllSessions(page);
  await browser.close();

  console.log(`${sessions.length} TeamUp session(s) found`);

  const auth = await authorize(KING_ACCOUNT);
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = await getExerciseCalendarId(calendar);
  const existingEvents = await getExistingGymEvents(calendar, calendarId, 7);

  // Delete stale gym events no longer in the schedule
  let deleted = 0;
  for (const event of existingEvents) {
    if (!sessions.some((s) => sessionMatchesEvent(s, event))) {
      await calendar.events.delete({ calendarId, eventId: event.id!, sendUpdates: "all" });
      console.log(`Deleted: ${event.summary} @ ${event.start?.dateTime} (no longer available)`);
      deleted++;
    }
  }

  // Create events for sessions not already in the calendar
  let created = 0;
  let skipped = 0;
  for (const session of sessions) {
    if (existingEvents.some((event) => sessionMatchesEvent(session, event))) {
      skipped++;
      continue;
    }
    await createGymEvent(calendar, calendarId, session);
    console.log(`Created: ${eventSummary(session)} @ ${session.date} ${session.startTime}–${session.endTime}`);
    created++;
  }

  console.log(`\nDone: ${created} created, ${skipped} already existed, ${deleted} deleted`);
}

if (require.main === module) main().catch(console.error);
