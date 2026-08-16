// Temporary diagnostic — NOT a permanent file. Delete with `rm tmp/test-sheet-sync.ts`.
// 1. Load .env from the project root (read-only — does not modify any source).
// 2. List sheet tabs in GOOGLE_SPREADSHEET_ID.
// 3. Append a dummy invoice row to a tab we discover, fallback to create+append.
// 4. Print exact error/success so we can see where the pipeline breaks.

import "dotenv/config";
import path from "node:path";
import { google } from "googleapis";

// Load .env explicitly from the project root (this script is run via tsx from project root).
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(process.cwd(), ".env") });

const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;

if (!spreadsheetId) {
  console.error("❌ GOOGLE_SPREADSHEET_ID missing in .env");
  process.exit(1);
}
if (!clientEmail || !privateKeyRaw) {
  console.error("❌ GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY missing in .env");
  process.exit(1);
}

console.log("📄 Spreadsheet ID:", spreadsheetId);
console.log("📧 Service Account:", clientEmail);

const privateKey = privateKeyRaw.includes("\\n")
  ? privateKeyRaw.replace(/\\n/g, "\n")
  : privateKeyRaw;

const auth = new google.auth.GoogleAuth({
  credentials: { client_email: clientEmail, private_key: privateKey },
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
});

const sheets = google.sheets({ version: "v4", auth });

async function main() {
  console.log("\n🔍 Step 1: Listing tabs in the spreadsheet...");
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tabs = (meta.data.sheets ?? []).map((s) => ({
    title: s.properties?.title ?? "",
    sheetId: s.properties?.sheetId ?? 0,
    rowCount: s.properties?.gridProperties?.rowCount ?? 0,
    colCount: s.properties?.gridProperties?.columnCount ?? 0,
  }));
  console.log("✅ Tabs found:", tabs.length);
  for (const t of tabs) console.log(`   - "${t.title}" (id=${t.sheetId}, ${t.rowCount}×${t.colCount})`);

  const preferred = ["Review Queue", "INVOICE DATA", "Sheet1", "Sheet 1"];
  let targetTitle = preferred.find((n) => tabs.some((t) => t.title === n));
  if (!targetTitle) {
    targetTitle = tabs[0]?.title ?? "Sheet1";
  }
  console.log(`\n🎯 Target tab for append: "${targetTitle}"`);

  console.log("\n🔍 Step 2: Reading first 3 rows of the target tab...");
  try {
    const head = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${targetTitle}'!A1:M3`,
    });
    console.log("   First 3 rows:");
    for (const r of head.data.values ?? []) console.log("     ", r);
  } catch (e: any) {
    console.log("   ⚠️  Could not read first 3 rows:", e?.message ?? e);
  }

  console.log("\n🧪 Step 3: Appending a diagnostic dummy row...");
  const dummyRow = [
    "🟡 Pending Review",
    "✅ Balanced (DIAGNOSTIC)",
    "2026-08-16",
    `DIAG-${Date.now()}`,
    "DIAGNOSTIC Vendor (ignore me)",
    "27AAACM1234F1Z8",
    1000,
    90,
    90,
    0,
    1180,
    "Purchase",
    "https://example.com/diagnostic",
  ];
  const appendResult = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${targetTitle}'!A:M`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [dummyRow] },
  });
  console.log("✅ Append response:");
  console.log("   updatedRange:", appendResult.data.updates?.updatedRange);
  console.log("   updatedRows :", appendResult.data.updates?.updatedRows);
  console.log("   updatedCols :", appendResult.data.updates?.updatedColumns);
  console.log("   updatedCells:", appendResult.data.updates?.updatedCells);

  console.log("\n🎉 Diagnostic complete. Open your sheet and look for the DIAG-* row.");
}

main().catch((err) => {
  console.error("\n❌ Diagnostic failed:");
  if (err?.response?.data) {
    console.error("   status:", err.response.status);
    console.error("   statusText:", err.response.statusText);
    console.error("   body:", JSON.stringify(err.response.data, null, 2));
  } else {
    console.error(err);
  }
  process.exit(1);
});
