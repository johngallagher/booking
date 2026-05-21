import { google } from "googleapis";
import { chromium } from "playwright";
import { authorize } from "./get-calendar-slots";
import { getAllSlots, type AvailableCourt } from "./index";

const KING_ACCOUNT = "kingofkerning@gmail.com";
const JOHN_ACCOUNT = "john@synapticmishap.co.uk";
const EXERCISE_CALENDAR = "Exercise";

function isEveningOrWeekend(court: AvailableCourt): boolean {
  if (court.startTime >= "18:00") return true;
  const [year, month, day] = court.date.split("-").map(Number);
  const dow = new Date(year, month - 1, day).getDay();
  return dow === 0 || dow === 6;
}

async function getExerciseCalendarId(
  calendar: ReturnType<typeof google.calendar>
): Promise<string> {
  const res = await calendar.calendarList.list();
  const cal = (res.data.items ?? []).find((c) => c.summary === EXERCISE_CALENDAR);
  if (!cal?.id) throw new Error(`"${EXERCISE_CALENDAR}" calendar not found on ${KING_ACCOUNT}`);
  return cal.id;
}

async function getExistingEventStartTimes(
  calendar: ReturnType<typeof google.calendar>,
  calendarId: string,
  lookaheadDays: number
): Promise<Set<string>> {
  const now = new Date();
  const later = new Date(now);
  later.setDate(now.getDate() + lookaheadDays);

  const res = await calendar.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: later.toISOString(),
    singleEvents: true,
  });

  const starts = new Set<string>();
  for (const e of res.data.items ?? []) {
    if (e.start?.dateTime) starts.add(e.start.dateTime);
  }
  return starts;
}

async function createIndoorTennisEvent(
  calendar: ReturnType<typeof google.calendar>,
  calendarId: string,
  court: AvailableCourt
): Promise<void> {
  await calendar.events.insert({
    calendarId,
    sendUpdates: "all",
    requestBody: {
      summary: "Indoor Tennis",
      description: `Booking URL: ${court.bookingUrl}\nPrice: ${court.price}`,
      start: { dateTime: `${court.date}T${court.startTime}:00`, timeZone: "Europe/London" },
      end: { dateTime: `${court.date}T${court.endTime}:00`, timeZone: "Europe/London" },
      attendees: [{ email: KING_ACCOUNT }, { email: JOHN_ACCOUNT }],
    },
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const availableCourts = await getAllSlots(page);
  await browser.close();

  const eveningAndWeekendCourts = availableCourts.filter(isEveningOrWeekend);
  console.log(`${eveningAndWeekendCourts.length} evening/weekend court(s) found`);

  const auth = await authorize(KING_ACCOUNT);
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = await getExerciseCalendarId(calendar);
  const existingStarts = await getExistingEventStartTimes(calendar, calendarId, 7);

  let created = 0;
  let skipped = 0;

  for (const court of eveningAndWeekendCourts) {
    const startDateTime = `${court.date}T${court.startTime}:00+01:00`;
    const startDateTimeUtc = `${court.date}T${court.startTime}:00Z`;

    const alreadyExists =
      existingStarts.has(startDateTime) || existingStarts.has(startDateTimeUtc) ||
      [...existingStarts].some((s) => s.startsWith(`${court.date}T${court.startTime}`));

    if (alreadyExists) {
      skipped++;
      continue;
    }

    await createIndoorTennisEvent(calendar, calendarId, court);
    console.log(`Created: ${court.date} ${court.startTime}–${court.endTime} (${court.price})`);
    created++;
  }

  console.log(`\nDone: ${created} created, ${skipped} already existed`);
}

main().catch(console.error);
