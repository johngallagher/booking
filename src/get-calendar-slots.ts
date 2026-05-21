import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import type { TimeSlot } from "./types";

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");
const REDIRECT_PORT = 3001;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

const ACCOUNTS = ["kingofkerning@gmail.com", "john@synapticmishap.co.uk"];

export interface PlannedTennisSlot extends TimeSlot {
  recurring: boolean;
  account: string;
}

function tokenPath(account: string) {
  return path.join(process.cwd(), `token-${account}.json`);
}

function toLocalDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function overlaps(slot: PlannedTennisSlot, event: calendar_v3.Schema$Event): boolean {
  if (event.start?.date) {
    // All-day event: end date is exclusive in the Google Calendar API
    return slot.date >= event.start.date && slot.date < event.end!.date!;
  }
  const slotStart = new Date(`${slot.date}T${slot.startTime}`);
  const slotEnd = new Date(`${slot.date}T${slot.endTime}`);
  const eventStart = new Date(event.start!.dateTime!);
  const eventEnd = new Date(event.end!.dateTime!);
  return slotStart < eventEnd && slotEnd > eventStart;
}

async function getNewToken(
  oAuth2Client: InstanceType<typeof google.auth.OAuth2>,
  account: string
) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    login_hint: account,
  });

  console.log(`Opening browser to authorize ${account}...`);
  const { exec } = await import("child_process");
  exec(`open "${authUrl}"`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, REDIRECT_URI);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        res.end("Authorization failed. You can close this tab.");
        server.close();
        reject(new Error(`OAuth error: ${error}`));
      } else if (code) {
        res.end("Authorization successful! You can close this tab.");
        server.close();
        resolve(code);
      }
    });
    server.listen(REDIRECT_PORT, () =>
      console.log(`Waiting for authorization on port ${REDIRECT_PORT}...`)
    );
  });

  const { tokens } = await oAuth2Client.getToken({ code, redirect_uri: REDIRECT_URI });
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(tokenPath(account), JSON.stringify(tokens));
  console.log(`Token saved for ${account}`);
}

export async function authorize(account: string) {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const { client_id, client_secret } = credentials.installed ?? credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

  const tPath = tokenPath(account);
  if (fs.existsSync(tPath)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(tPath, "utf8")));
  } else {
    await getNewToken(oAuth2Client, account);
  }

  return oAuth2Client;
}

async function getSlotsForAccount(account: string): Promise<PlannedTennisSlot[]> {
  const auth = await authorize(account);
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const twoWeeksLater = new Date(now);
  twoWeeksLater.setDate(now.getDate() + 14);

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: twoWeeksLater.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = response.data.items ?? [];

  const tennisSlots = events
    .filter((e) => e.summary === "[TBC] Tennis")
    .map((e) => {
      const start = new Date(e.start!.dateTime ?? e.start!.date!);
      const end = new Date(e.end!.dateTime ?? e.end!.date!);
      return {
        date: toLocalDateString(start),
        startTime: start.toTimeString().slice(0, 5),
        endTime: end.toTimeString().slice(0, 5),
        recurring: !!e.recurringEventId,
        account,
      };
    });

  const busyEvents = events.filter(
    (e) => e.summary !== "[TBC] Tennis" && e.transparency !== "transparent"
  );

  return tennisSlots.filter((slot) => !busyEvents.some((e) => overlaps(slot, e)));
}

export async function getPlannedTennisSlots(): Promise<PlannedTennisSlot[]> {
  const results: PlannedTennisSlot[] = [];
  for (const account of ACCOUNTS) {
    results.push(...await getSlotsForAccount(account));
  }
  return results.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}

async function main() {
  const slots = await getPlannedTennisSlots();
  console.log(`Found ${slots.length} free [TBC] Tennis slot(s) in the next 14 days:`);
  console.log(JSON.stringify(slots, null, 2));
}

main().catch(console.error);
