import "dotenv/config";
import { google } from "googleapis";
import { tasks } from "@trigger.dev/sdk";
import type { parseInvoice } from "../trigger/tasks/parse-invoice";

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

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
];

async function findAndTriggerInvoice() {
  try {
    // 1. Find Client_Invoices_Raw folder
    console.log("🔍 Finding Client_Invoices_Raw folder...\n");

    const folderResponse = await drive.files.list({
      q: "name = 'Client_Invoices_Raw' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: "files(id, name, mimeType)",
      pageSize: 10,
    });

    const folders = folderResponse.data.files ?? [];

    if (folders.length === 0) {
      throw new Error(
        "Client_Invoices_Raw folder not found. Ensure the folder exists in Google Drive and is shared with your service account email."
      );
    }

    const folder = folders[0];

    console.log(`✅ Folder found: ${folder.name}`);
    console.log(`🆔 Folder ID: ${folder.id}\n`);

    // 2. Find files inside the folder
    console.log("🔍 Looking for invoice files...\n");

    const filesResponse = await drive.files.list({
      q: `'${folder.id}' in parents and trashed = false`,
      fields: "files(id, name, mimeType, size)",
      orderBy: "createdTime",
      pageSize: 50,
    });

    const files = filesResponse.data.files ?? [];

    if (files.length === 0) {
      throw new Error("No files found inside Client_Invoices_Raw.");
    }

    console.log(`✅ Found ${files.length} file(s).\n`);

    // 3. Find a supported invoice
    const invoiceFile = files.find(
      (file) =>
        file.id &&
        file.mimeType &&
        ALLOWED_MIME_TYPES.includes(file.mimeType)
    );

    if (!invoiceFile || !invoiceFile.id) {
      throw new Error(
        "No supported invoice found. Supported types: PDF, PNG, JPEG."
      );
    }

    console.log(`📄 Invoice: ${invoiceFile.name}`);
    console.log(`📦 Type: ${invoiceFile.mimeType}`);
    console.log(`🆔 File ID: ${invoiceFile.id}\n`);

    // 4. Download invoice
    console.log("⬇️ Downloading invoice...");

    const downloadResponse = await drive.files.get(
      {
        fileId: invoiceFile.id,
        alt: "media",
      },
      {
        responseType: "arraybuffer",
      }
    );

    const buffer = Buffer.from(downloadResponse.data as ArrayBuffer);

    console.log(`✅ Download successful!`);
    console.log(`📏 Downloaded bytes: ${buffer.length}\n`);

    // 5. Convert to Base64
    const base64Data = buffer.toString("base64");

    console.log("🔤 Base64 conversion successful!");
    console.log(`📦 Base64 length: ${base64Data.length}\n`);

    // 6. Trigger parse-invoice
    console.log("⚡ Triggering parse-invoice...");

    const handle = await tasks.trigger<typeof parseInvoice>("parse-invoice", {
      base64Data,
      filename: invoiceFile.name ?? "invoice",
    });

    console.log("✅ parse-invoice triggered successfully!");
    console.log(`🆔 Run ID: ${handle.id}`);
  } catch (error) {
    console.error("\n❌ Invoice pipeline failed:");
    console.error(error);
  }
}

findAndTriggerInvoice();