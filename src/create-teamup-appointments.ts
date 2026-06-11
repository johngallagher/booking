import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";
import { chromium } from "playwright";
import { authorize } from "./get-calendar-slots";
import { getAllSessions, scheduleUrlForDate, type GymSession } from "./teamup-scraper";
import { gymSchedule, exerciseCalendarId, workspaceUser } from "./config";
import { withRetry, sleep } from "./calendar-retry";

const KING_ACCOUNT = "kingofkerning@gmail.com";

// ── Time window filter ────────────────────────────────────────────────────────

// "YYYY-MM-DD" denotes a London-local calendar date, and the day of week for
// a calendar date doesn't depend on timezone, so parse as UTC.
function isSaturday(date: string): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 6;
}

function isWithinSchedule(session: GymSession): boolean {
  return (
    isSaturday(session.date) ||
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

// ── Invite response handling ──────────────────────────────────────────────────

function kingResponse(event: calendar_v3.Schema$Event): string | undefined {
  return event.attendees?.find((a) => a.email === KING_ACCOUNT)?.responseStatus ?? undefined;
}

function isDeclinedTombstone(event: calendar_v3.Schema$Event): boolean {
  return !!event.description?.startsWith("DECLINED");
}

function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// ── Calendar helpers ──────────────────────────────────────────────────────────

function sessionMatchesEvent(session: GymSession, event: calendar_v3.Schema$Event): boolean {
  // Match on name as well as start time so two different classes running in
  // the same slot (e.g. BOX-TEC and Smash HIIT) are treated as distinct events
  return (
    event.summary === eventSummary(session) &&
    !!event.start?.dateTime?.startsWith(`${session.date}T${session.startTime}`)
  );
}

function eventSummary(session: GymSession): string {
  return `Gym: ${session.name}`;
}

function eventDescription(session: GymSession): string {
  return `Book now: ${session.bookingUrl ?? scheduleUrlForDate(session.date)}`;
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
      description: eventDescription(session),
      attendees: [{ email: KING_ACCOUNT }],
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
  console.log(`${windowed.length} within schedule window (before ${gymSchedule.morningEndBy} or from ${gymSchedule.eveningStartFrom}, or any time on Saturday)`);

  const authKing = await authorize(KING_ACCOUNT, workspaceUser);
  const calKing = google.calendar({ version: "v3", auth: authKing });
  const { exerciseId: calendarId, otherItems } = await getCalendars(calKing);

  const lookahead = new Date(now);
  lookahead.setDate(now.getDate() + 14);

  const busyPeriods = await getBusyPeriods(calKing, otherItems, now, lookahead);
  const sessions = windowed.filter((s) => {
    if (conflictsWithBusy(s, busyPeriods)) {
      console.log(`Skipped (conflict): ${eventSummary(s)} @ ${s.date} ${s.startTime}–${s.endTime}`);
      return false;
    }
    return true;
  });
  console.log(`${sessions.length} session(s) after conflict check`);
  for (const s of sessions) {
    console.log(`  - ${eventSummary(s)} @ ${s.date} ${s.startTime}–${s.endTime} (${s.spotsAvailable} spot(s))`);
  }
  const existingEvents = await getExistingGymEvents(calKing, calendarId, 14);

  // Declined invites become tombstones: drop the attendee so the event leaves
  // King's calendar, but keep it here so the session isn't re-invited next run
  for (const event of existingEvents) {
    if (kingResponse(event) === "declined") {
      await withRetry(() => calKing.events.patch({
        calendarId,
        eventId: event.id!,
        sendUpdates: "none",
        requestBody: { attendees: [], description: "DECLINED" },
      }));
      event.attendees = [];
      event.description = "DECLINED";
      await sleep(500);
      console.log(`Declined: ${event.summary} @ ${event.start?.dateTime} (invite removed)`);
    }
  }

  // Rest days: an accepted session blocks other invites that day and the next
  const restDates = new Set<string>();
  for (const event of existingEvents) {
    if (kingResponse(event) === "accepted") {
      const date = event.start?.dateTime?.slice(0, 10);
      if (date) {
        restDates.add(date);
        restDates.add(nextDay(date));
        console.log(`Rest day: ${date} and ${nextDay(date)} (accepted ${event.summary} @ ${event.start?.dateTime})`);
      }
    }
  }

  // Delete stale gym events (no longer available, out of window, now
  // conflicting, or falling on a rest day). Accepted sessions are never
  // deleted; declined tombstones stay while the session is still offered.
  let deleted = 0;
  for (const event of existingEvents) {
    if (kingResponse(event) === "accepted") continue;
    const stale = !sessions.some((s) => sessionMatchesEvent(s, event));
    const onRestDay =
      restDates.has(event.start?.dateTime?.slice(0, 10) ?? "") && !isDeclinedTombstone(event);
    if (stale || onRestDay) {
      await withRetry(() => calKing.events.delete({ calendarId, eventId: event.id!, sendUpdates: "none" }));
      await sleep(500);
      console.log(`Deleted: ${event.summary} @ ${event.start?.dateTime}${!stale && onRestDay ? " (rest day)" : ""}`);
      deleted++;
    }
  }

  // Create events for sessions not already in the calendar
  let created = 0;
  let skipped = 0;
  let rested = 0;
  let updated = 0;
  for (const session of sessions) {
    if (restDates.has(session.date)) {
      console.log(`Rested: ${eventSummary(session)} @ ${session.date} ${session.startTime}–${session.endTime}`);
      rested++;
      continue;
    }
    const existingEvent = existingEvents.find((event) => sessionMatchesEvent(session, event));
    if (existingEvent) {
      // Older events were created before booking links were captured (or before
      // the link's `e=` id was available) — refresh the description so the
      // calendar entry always points at the correct booking modal.
      const desiredDescription = eventDescription(session);
      if (
        session.bookingUrl &&
        !isDeclinedTombstone(existingEvent) &&
        existingEvent.description !== desiredDescription
      ) {
        await withRetry(() => calKing.events.patch({
          calendarId,
          eventId: existingEvent.id!,
          sendUpdates: "none",
          requestBody: { description: desiredDescription },
        }));
        await sleep(500);
        console.log(`Updated link: ${eventSummary(session)} @ ${session.date} ${session.startTime}–${session.endTime}`);
        updated++;
      } else {
        console.log(`Already exists: ${eventSummary(session)} @ ${session.date} ${session.startTime}–${session.endTime}`);
      }
      skipped++;
      continue;
    }
    await createGymEvent(calKing, calendarId, session);
    await sleep(500);
    console.log(`Created: ${eventSummary(session)} @ ${session.date} ${session.startTime}–${session.endTime}`);
    created++;
  }

  console.log(`\nDone: ${created} created, ${updated} link(s) updated, ${skipped} already existed, ${rested} skipped (rest day), ${deleted} deleted`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
