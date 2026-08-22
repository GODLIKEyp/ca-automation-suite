import "dotenv/config";
import { google } from "googleapis";
import { tasks } from "@trigger.dev/sdk";
import type { parseBankStatement } from "../trigger/tasks/parse-bank-statement";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
    decryptPdf,
    INVALID_PDF_PASSWORD,
    PDF_DECRYPTOR_UNAVAILABLE,
    PDF_PASSWORD_REQUIRED,
} from "../trigger/lib/pdf";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Resolve credentials: Check local JSON file first, otherwise fallback to .env
const localCredentialsPath = path.resolve(
    __dirname,
    "../../credentials/google-drive-service-account.json"
);

let credentials: any;

if (existsSync(localCredentialsPath)) {
    credentials = JSON.parse(readFileSync(localCredentialsPath, "utf-8"));
} else if (
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY
) {
    credentials = {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    };
} else {
    throw new Error(
        "Missing Google Drive credentials. Provide GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY in .env, or place credentials at credentials/google-drive-service-account.json"
    );
}

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/spreadsheets",
    ],
});

const drive = google.drive({ version: "v3", auth });

async function findAndTriggerBankStatement() {
    try {
        console.log("🔍 Scanning for bank statements in Google Drive...");

        let folderId: string | undefined;
        const folderRes = await drive.files.list({
            q: "(name = 'Client_Bank_Statements_Raw' or name = 'Bank Transactions') and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            fields: "files(id, name)",
            pageSize: 1,
        });

        if (folderRes.data.files && folderRes.data.files.length > 0) {
            folderId = folderRes.data.files[0].id!;
            console.log(
                `📁 Found folder: ${folderRes.data.files[0].name} (${folderId})`
            );
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
                f.name?.toLowerCase().includes("kotak") ||
                f.mimeType === "text/csv" ||
                f.mimeType === "application/pdf"
        );

        if (!statementFile || !statementFile.id) {
            console.log(
                "⚠️ No bank statement found. Place a PDF or CSV file in Google Drive."
            );
            return;
        }

        console.log(
            `📄 Found statement: ${statementFile.name} (${statementFile.mimeType})`
        );
        console.log("⬇️ Downloading statement...");

        const download = await drive.files.get(
            { fileId: statementFile.id, alt: "media" },
            {
                responseType:
                    statementFile.mimeType === "text/csv" ? "text" : "arraybuffer",
            }
        );

        let payload: {
            rawCsvText?: string;
            statementPdfBase64?: string;
            filename: string;
        };

        if (
            statementFile.mimeType === "text/csv" ||
            statementFile.name?.endsWith(".csv")
        ) {
            payload = {
                rawCsvText: download.data as string,
                filename: statementFile.name ?? "statement.csv",
            };
        } else {
            const buffer = Buffer.from(download.data as ArrayBuffer);
            let pdfBase64 = buffer.toString("base64");

            const rl = createInterface({ input, output });
            let password = "";

            try {
                const rawPassword = await rl.question(
                    "🔐 Enter PDF password (leave blank if none): "
                );
                password = rawPassword.trim();
            } finally {
                rl.close();
            }

            if (password) {
                console.log("🔓 Decrypting PDF...");
                try {
                    pdfBase64 = await decryptPdf(pdfBase64, password);
                    console.log("✅ PDF decrypted successfully.");
                } catch (err: any) {
                    if (err.message === INVALID_PDF_PASSWORD) {
                        console.error(
                            "\n❌ Incorrect Password: The bank statement rejected the password."
                        );
                        console.error("👉 For Kotak: Use your 8-9 digit CRN, or uppercase PAN.");
                        console.error("👉 For HDFC/ICICI: Use Customer ID or Name+DDMM.");
                        return;
                    } else if (err.message === PDF_DECRYPTOR_UNAVAILABLE) {
                        console.error(
                            "\n❌ qpdf binary is not installed on this machine."
                        );
                        console.error("👉 Run: brew install qpdf");
                        return;
                    } else if (err.message === PDF_PASSWORD_REQUIRED) {
                        console.error(
                            "\n❌ This PDF is password protected, but no password was supplied."
                        );
                        return;
                    }
                    throw err;
                }
            }

            payload = {
                statementPdfBase64: pdfBase64,
                filename: statementFile.name ?? "statement.pdf",
            };
        }

        console.log("⚡ Triggering parse-bank-statement task...");
        const handle = await tasks.trigger<typeof parseBankStatement>(
            "parse-bank-statement",
            payload
        );

        console.log("✅ parse-bank-statement triggered successfully!");
        console.log(`🆔 Run ID: ${handle.id}`);
    } catch (err) {
        console.error("❌ Bank statement watcher failed:", err);
    }
}

findAndTriggerBankStatement();