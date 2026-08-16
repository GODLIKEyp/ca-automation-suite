import { google } from "googleapis";
import path from "node:path";

const KEY_FILE = path.join(
  process.cwd(),
  "credentials",
  "google-drive-service-account.json"
);

const auth = new google.auth.GoogleAuth({
  keyFile: KEY_FILE,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});

const drive = google.drive({
  version: "v3",
  auth,
});

async function testDriveConnection() {
  try {
    const response = await drive.files.list({
      q: "trashed = false",
      pageSize: 20,
      fields: "files(id, name, mimeType)",
    });

    const files = response.data.files ?? [];

    console.log("\n✅ Google Drive connection successful!\n");

    if (files.length === 0) {
      console.log("No files found.");
      return;
    }

    console.log("Files accessible to the service account:\n");

    for (const file of files) {
      console.log(`${file.name} | ${file.id} | ${file.mimeType}`);
    }
  } catch (error) {
    console.error("\n❌ Google Drive connection failed:");
    console.error(error);
  }
}

testDriveConnection();