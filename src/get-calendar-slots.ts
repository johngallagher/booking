import { google } from "googleapis";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");
const REDIRECT_PORT = 3001;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

const ACCOUNTS = ["kingofkerning@gmail.com", "john@synapticmishap.co.uk"];

export interface CalendarSlot {
  date: string;
  startTime: string;
  endTime: string;
  recurring: boolean;
  account: string;
}

function tokenPath(account: string) {
  return path.join(process.cwd(), `token-${account}.json`);
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

async function authorize(account: string) {
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

async function getSlotsForAccount(account: string): Promise<CalendarSlot[]> {
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
    q: "[TBC] Tennis",
  });

  return (response.data.items ?? [])
    .filter((e) => e.summary === "[TBC] Tennis")
    .map((e) => {
      const start = new Date(e.start!.dateTime ?? e.start!.date!);
      const end = new Date(e.end!.dateTime ?? e.end!.date!);
      return {
        date: start.toISOString().split("T")[0],
        startTime: start.toTimeString().slice(0, 5),
        endTime: end.toTimeString().slice(0, 5),
        recurring: !!e.recurringEventId,
        account,
      };
    });
}

export async function getCalendarSlots(): Promise<CalendarSlot[]> {
  const results: CalendarSlot[] = [];
  for (const account of ACCOUNTS) {
    results.push(...await getSlotsForAccount(account));
  }
  return results.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}

async function main() {
  const slots = await getCalendarSlots();
  console.log(`Found ${slots.length} [TBC] Tennis slot(s) in the next 14 days:`);
  console.log(JSON.stringify(slots, null, 2));
}

main().catch(console.error);
