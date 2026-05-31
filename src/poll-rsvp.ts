import { google } from "googleapis";
import { authorize } from "./get-calendar-slots";

const KING_ACCOUNT = "kingofkerning@gmail.com";
const EXERCISE_CALENDAR = "Exercise";
const GITHUB_REPO = process.env.GITHUB_REPO!;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;

async function getExerciseCalendarId(
  calendar: ReturnType<typeof google.calendar>
): Promise<string> {
  const res = await calendar.calendarList.list();
  const cal = (res.data.items ?? []).find((c) => c.summary === EXERCISE_CALENDAR);
  if (!cal?.id) throw new Error(`"${EXERCISE_CALENDAR}" calendar not found`);
  return cal.id;
}

async function getAcceptedUnbookedEvents(
  calendar: ReturnType<typeof google.calendar>,
  calendarId: string
) {
  const now = new Date();
  const later = new Date(now);
  later.setDate(now.getDate() + 14);

  const res = await calendar.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: later.toISOString(),
    singleEvents: true,
  });

  return (res.data.items ?? []).filter((e) => {
    if (e.summary !== "Indoor Tennis") return false;
    if (e.description?.startsWith("BOOKED")) return false;
    const myAttendee = (e.attendees ?? []).find((a) => a.email === KING_ACCOUNT);
    return myAttendee?.responseStatus === "accepted";
  });
}

function extractBookingUrl(description: string | null | undefined): string | null {
  const match = description?.match(/^Booking URL: (.+)$/m);
  return match?.[1]?.trim() ?? null;
}

async function markEventAsBooked(
  calendar: ReturnType<typeof google.calendar>,
  calendarId: string,
  eventId: string,
  currentDescription: string
): Promise<void> {
  await calendar.events.patch({
    calendarId,
    eventId,
    sendUpdates: "none",
    requestBody: { description: `BOOKED\n${currentDescription}` },
  });
}

async function triggerBookingWorkflow(bookingUrl: string): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/court.tennis.book.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { booking_url: bookingUrl } }),
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to dispatch workflow: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const auth = await authorize(KING_ACCOUNT);
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = await getExerciseCalendarId(calendar);
  const events = await getAcceptedUnbookedEvents(calendar, calendarId);

  console.log(`Found ${events.length} accepted, unbooked Indoor Tennis event(s)`);

  for (const event of events) {
    const bookingUrl = extractBookingUrl(event.description);
    if (!bookingUrl) {
      console.warn(`No booking URL found in event "${event.summary}" (${event.id})`);
      continue;
    }

    await markEventAsBooked(calendar, calendarId, event.id!, event.description ?? "");
    console.log(`Marked as BOOKED: ${event.start?.dateTime}`);

    await triggerBookingWorkflow(bookingUrl);
    console.log(`Dispatched book-tennis-court workflow for: ${bookingUrl}`);
  }
}

main().catch((err) => {
  console.error("poll-rsvp failed:", err.message);
  process.exit(1);
});
