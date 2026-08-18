import "dotenv/config";
import { google } from "googleapis";
import { tasks } from "@trigger.dev/sdk";
import type { parseBankStatement } from "../trigger/tasks/parse-bank-statement";

const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});

const drive = google.drive({ version: "v3", auth });

async function findAndTriggerBankStatement() {
    try {
        console.log("🔍 Scanning for bank statements in Google Drive...");

        let folderId: string | undefined;
        const folderRes = await drive.files.list({
            q: "name = 'Client_Bank_Statements_Raw' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            fields: "files(id, name)",
            pageSize: 1,
        });

        if (folderRes.data.files && folderRes.data.files.length > 0) {
            folderId = folderRes.data.files[0].id!;
            console.log(`📁 Found folder: Client_Bank_Statements_Raw (${folderId})`);
        }

        const query = folderId
            ? `'${folderId}' in parents and trashed = false`
            : "trashed = false and (mimeType = 'application/pdf' or mimeType = 'text/csv')";

        const filesRes = await drive.files.list({
            q: query,
            fields: "files(id, name, mimeType)",
            pageSize: 20,
        });

        const files = filesRes.data.files ?? [];
        const statementFile = files.find(
            (f) =>
                f.name?.toLowerCase().includes("bank") ||
                f.name?.toLowerCase().includes("statement") ||
                f.mimeType === "text/csv" ||
                f.mimeType === "application/pdf"
        );

        if (!statementFile || !statementFile.id) {
            console.log("⚠️ No bank statement found. Place a PDF or CSV file in Google Drive.");
            return;
        }

        console.log(`📄 Found statement: ${statementFile.name} (${statementFile.mimeType})`);
        console.log("⬇️ Downloading statement...");

        const download = await drive.files.get(
            { fileId: statementFile.id, alt: "media" },
            { responseType: statementFile.mimeType === "text/csv" ? "text" : "arraybuffer" }
        );

        let payload: { rawCsvText?: string; statementPdfBase64?: string; filename: string };

        if (statementFile.mimeType === "text/csv" || statementFile.name?.endsWith(".csv")) {
            payload = {
                rawCsvText: download.data as string,
                filename: statementFile.name ?? "statement.csv",
            };
        } else {
            const buffer = Buffer.from(download.data as ArrayBuffer);
            payload = {
                statementPdfBase64: buffer.toString("base64"),
                filename: statementFile.name ?? "statement.pdf",
            };
        }

        console.log("⚡ Triggering parse-bank-statement task...");
        const handle = await tasks.trigger<typeof parseBankStatement>("parse-bank-statement", payload);

        console.log("✅ parse-bank-statement triggered successfully!");
        console.log(`🆔 Run ID: ${handle.id}`);
    } catch (err) {
        console.error("❌ Bank statement watcher failed:", err);
    }
}

findAndTriggerBankStatement();