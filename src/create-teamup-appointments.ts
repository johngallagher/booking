import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";
import { chromium } from "playwright";
import { authorize } from "./get-calendar-slots";
import { getAllSessions, type GymSession } from "./teamup-scraper";
import { gymSchedule, exerciseCalendarId } from "./config";
import { withRetry, sleep } from "./calendar-retry";

const KING_ACCOUNT = "kingofkerning@gmail.com";

// ── Time window filter ────────────────────────────────────────────────────────

function isWithinSchedule(session: GymSession): boolean {
  return (
    session.endTime <= gymSchedule.morningEndBy ||
    session.startTime >= gymSchedule.eveningStartFrom
  );
}

// ── Timezone-aware date helpers ───────────────────────────────────────────────

function londonOffset(date: string): string {
  // Returns "+01:00" (BST) or "+00:00" (GMT) for a YYYY-MM-DD date string
  const d = new Date(`${date}T12:00:00Z`);
  const tz =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/London",
      timeZoneName: "shortOffset",
    })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = tz.match(/GMT([+-])(\d{1,2})/);
  if (!m) return "+00:00";
  return `${m[1]}${String(parseInt(m[2])).padStart(2, "0")}:00`;
}

function sessionToDate(session: GymSession, field: "startTime" | "endTime"): Date {
  return new Date(`${session.date}T${session[field]}:00${londonOffset(session.date)}`);
}

// ── Conflict detection (FreeBusy across all calendars except Exercise) ────────

async function getBusyPeriods(
  calendar: ReturnType<typeof google.calendar>,
  calendarItems: Array<{ id: string }>,
  from: Date,
  to: Date
): Promise<Array<{ start: Date; end: Date }>> {
  if (calendarItems.length === 0) return [];

  const res = await withRetry(() => calendar.freebusy.query({
    requestBody: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: calendarItems },
  }));

  return Object.values(res.data.calendars ?? {}).flatMap(
    (cal) => (cal.busy ?? []).map((b) => ({ start: new Date(b.start!), end: new Date(b.end!) }))
  );
}

function conflictsWithBusy(
  session: GymSession,
  busyPeriods: Array<{ start: Date; end: Date }>
): boolean {
  const start = sessionToDate(session, "startTime");
  const end = sessionToDate(session, "endTime");
  return busyPeriods.some((b) => start < b.end && end > b.start);
}

// ── Calendar helpers ──────────────────────────────────────────────────────────

function sessionMatchesEvent(session: GymSession, event: calendar_v3.Schema$Event): boolean {
  return !!event.start?.dateTime?.startsWith(`${session.date}T${session.startTime}`);
}

function eventSummary(session: GymSession): string {
  return `Gym: ${session.name}`;
}

async function getCalendars(
  calendar: ReturnType<typeof google.calendar>
): Promise<{ exerciseId: string; otherItems: Array<{ id: string }> }> {
  const res = await withRetry(() => calendar.calendarList.list());
  const items = res.data.items ?? [];
  return {
    exerciseId: exerciseCalendarId,
    otherItems: items.filter((c) => c.id !== exerciseCalendarId).map((c) => ({ id: c.id! })),
  };
}

async function getExistingGymEvents(
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

  return (res.data.items ?? []).filter((e) => e.summary?.startsWith("Gym: "));
}

async function createGymEvent(
  calendar: ReturnType<typeof google.calendar>,
  calendarId: string,
  session: GymSession
): Promise<void> {
  await withRetry(() => calendar.events.insert({
    calendarId,
    sendUpdates: "none",
    requestBody: {
      summary: eventSummary(session),
      start: { dateTime: `${session.date}T${session.startTime}:00`, timeZone: "Europe/London" },
      end: { dateTime: `${session.date}T${session.endTime}:00`, timeZone: "Europe/London" },
      status: "tentative",
      transparency: "transparent",
    },
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({ headless: true });
  let rawSessions: GymSession[];
  try {
    const page = await browser.newPage();
    rawSessions = await getAllSessions(page);
  } finally {
    await browser.close();
  }

  const now = new Date();
  // TeamUp returns the full week view including past days — discard sessions that have already started
  const allSessions = rawSessions.filter(s => sessionToDate(s, "startTime") > now);

  console.log(`${allSessions.length} session(s) from TeamUp`);

  const windowed = allSessions.filter(isWithinSchedule);
  console.log(`${windowed.length} within schedule window (before ${gymSchedule.morningEndBy} or from ${gymSchedule.eveningStartFrom})`);

  const authKing = await authorize(KING_ACCOUNT);
  const calKing = google.calendar({ version: "v3", auth: authKing });
  const { exerciseId: calendarId, otherItems } = await getCalendars(calKing);

  const lookahead = new Date(now);
  lookahead.setDate(now.getDate() + 7);

  const busyPeriods = await getBusyPeriods(calKing, otherItems, now, lookahead);
  const sessions = windowed.filter((s) => {
    if (conflictsWithBusy(s, busyPeriods)) {
      console.log(`Skipped (conflict): ${eventSummary(s)} @ ${s.date} ${s.startTime}–${s.endTime}`);
      return false;
    }
    return true;
  });
  console.log(`${sessions.length} session(s) after conflict check`);
  const existingEvents = await getExistingGymEvents(calKing, calendarId, 7);

  // Delete stale gym events (no longer available, out of window, or now conflicting)
  let deleted = 0;
  for (const event of existingEvents) {
    if (!sessions.some((s) => sessionMatchesEvent(s, event))) {
      await withRetry(() => calKing.events.delete({ calendarId, eventId: event.id!, sendUpdates: "none" }));
      await sleep(500);
      console.log(`Deleted: ${event.summary} @ ${event.start?.dateTime}`);
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
    await createGymEvent(calKing, calendarId, session);
    await sleep(500);
    console.log(`Created: ${eventSummary(session)} @ ${session.date} ${session.startTime}–${session.endTime}`);
    created++;
  }

  console.log(`\nDone: ${created} created, ${skipped} already existed, ${deleted} deleted`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
