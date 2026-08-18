import "dotenv/config";
import { google } from "googleapis";
import { tasks } from "@trigger.dev/sdk";
import type { parseBankStatement } from "../trigger/tasks/parse-bank-statement";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { decryptPdf } from "../trigger/lib/pdf";

const credentialsPath = path.resolve(
    __dirname,
    "../../credentials/google-drive-service-account.json"
);

const credentials = JSON.parse(
    readFileSync(credentialsPath, "utf-8")
);

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});

const drive = google.drive({ version: "v3", auth });

async function findAndTriggerBankStatement() {
    try {
        console.log("🔍 Scanning for bank statements in Google Drive...");

        let folderId: string | undefined;
        const folderRes = await drive.files.list({
        q: "name = 'Bank Transactions' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
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
    let pdfBase64 = buffer.toString("base64");

    const rl = createInterface({ input, output });

    try {
        const password = await rl.question(
            "🔐 Enter PDF password (leave blank if none): "
        );

        if (password) {
            console.log("🔓 Decrypting PDF...");

            pdfBase64 = await decryptPdf(
                pdfBase64,
                password
            );

            console.log("✅ PDF decrypted successfully.");
        }
    } finally {
        rl.close();
    }

    payload = {
        statementPdfBase64: pdfBase64,
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