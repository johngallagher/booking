import { google } from "googleapis";
import { authorize } from "./get-calendar-slots";
import { tennisSchedule, exerciseCalendarId, workspaceUser } from "./config";
import { withRetry, sleep } from "./calendar-retry";

const KING_ACCOUNT = "kingofkerning@gmail.com";

// One-time migration: delete bot-created events that were made by the plain
// service account (identified by having no attendees) so the sync scripts can
// recreate them as invites from the Workspace user. Booked tennis slots are
// left alone.

async function main() {
  const auth = await authorize(KING_ACCOUNT, workspaceUser);
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const later = new Date(now);
  later.setDate(now.getDate() + 14);

  const res = await withRetry(() => calendar.events.list({
    calendarId: exerciseCalendarId,
    timeMin: now.toISOString(),
    timeMax: later.toISOString(),
    singleEvents: true,
  }));

  const events = (res.data.items ?? []).filter(
    (e) =>
      (e.summary?.startsWith("Gym: ") || e.summary === tennisSchedule.sessionName) &&
      !e.description?.startsWith("BOOKED") &&
      !e.attendees?.length
  );

  console.log(`${events.length} bot-created event(s) without invites to delete`);
  for (const event of events) {
    await withRetry(() => calendar.events.delete({
      calendarId: exerciseCalendarId,
      eventId: event.id!,
      sendUpdates: "none",
    }));
    await sleep(500);
    console.log(`Deleted: ${event.summary} @ ${event.start?.dateTime}`);
  }

  console.log("Done");
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
