import { google } from "googleapis";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");
const REDIRECT_PORT = 3001;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

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

async function main() {
  await authorize("kingofkerning@gmail.com");
  console.log("Google Calendar authorised for kingofkerning@gmail.com");
}

if (require.main === module) main().catch(console.error);
