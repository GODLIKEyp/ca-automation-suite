import "dotenv/config";
import { google } from "googleapis";

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  },
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
      console.log(
        "No files found. Ensure your target folder/files are shared with:",
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
      );
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