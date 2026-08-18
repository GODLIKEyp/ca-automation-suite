import { task, logger } from "@trigger.dev/sdk";
import Papa from "papaparse";
import { z } from "zod";
import { google } from "googleapis";
import { extractResponseText, getGenaiClient } from "../lib/gemini";
import { decryptPdf } from "../lib/pdf";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
export const transactionSchema = z.object({
  date: z.string().default(""),
  description: z.string().default(""),
  debit: z.number().nonnegative().default(0),
  credit: z.number().nonnegative().default(0),
  mappedTallyLedger: z.string().default("Unclassified"),
});

export const bankStatementOutputSchema = z.object({
  transactions: z.array(transactionSchema),
  spreadsheetUrl: z.string().optional(),
});

export type Transaction = z.infer<typeof transactionSchema>;
export type BankStatementOutput = z.infer<typeof bankStatementOutputSchema>;

export const bankStatementPayloadSchema = z.object({
  statementPdfBase64: z.string().optional(),
  rawCsvText: z.string().optional(),
  filename: z.string().optional(),
  pdfPassword: z.string().optional(),
});

export type BankStatementPayload = z.infer<typeof bankStatementPayloadSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseCsvText(rawCsvText: string): Papa.ParseResult<Record<string, string>> {
  return Papa.parse<Record<string, string>>(rawCsvText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });
}

function pickColumn(row: Record<string, string>, candidates: string[]): string {
  for (const c of candidates) {
    if (row[c] !== undefined && row[c] !== null) return row[c].trim();
  }
  return "";
}

function parseAmount(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[₹$,\s]/g, "").replace(/[()]/g, "-");
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function normalizeRow(
  row: Record<string, string>
): { date: string; description: string; debit: number; credit: number } | null {
  const date = pickColumn(row, ["date", "txn_date", "transaction_date", "value_date"]);
  const description = pickColumn(row, [
    "description",
    "narration",
    "particulars",
    "details",
    "remark",
  ]);
  const debitRaw = pickColumn(row, ["debit", "withdrawal", "dr", "withdrawal_amt"]);
  const creditRaw = pickColumn(row, ["credit", "deposit", "cr", "deposit_amt"]);
  const amountRaw = pickColumn(row, ["amount"]);

  let debit = parseAmount(debitRaw);
  let credit = parseAmount(creditRaw);

  if (!debit && !credit && amountRaw) {
    debit = parseAmount(amountRaw);
  }

  if (!date && !description) return null;
  return {
    date: date || "",
    description: description || "",
    debit,
    credit,
  };
}

/**
 * Appends transactions to Google Sheets under 'Bank Transactions' tab
 */
async function appendTransactionsToGoogleSheet(
  spreadsheetId: string,
  transactions: Transaction[]
) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const tabName = "Bank Transactions";

  // 1. Ensure 'Bank Transactions' tab and headers exist
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetExists = meta.data.sheets?.some(
      (s) => s.properties?.title === tabName
    );

    if (!sheetExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: { title: tabName },
              },
            },
          ],
        },
      });

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${tabName}'!A1:G1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [
            [
              "STATUS",
              "DATE",
              "DESCRIPTION",
              "DEBIT (WITHDRAWAL)",
              "CREDIT (DEPOSIT)",
              "MAPPED TALLY LEDGER",
              "AUDIT CHECK",
            ],
          ],
        },
      });
    }
  } catch (err) {
    logger.warn("Sheet setup warning:", { error: err });
  }

  // 2. Format rows
  const rows = transactions.map((t) => [
    "🟡 Pending Review",
    t.date,
    t.description,
    t.debit > 0 ? t.debit : "",
    t.credit > 0 ? t.credit : "",
    t.mappedTallyLedger,
    t.mappedTallyLedger === "Unclassified" ? "⚠️ Needs Classification" : "✅ Classified",
  ]);

  // 3. Append to sheet
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tabName}'!A:G`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------
export const parseBankStatement = task({
  id: "parse-bank-statement",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: BankStatementPayload): Promise<BankStatementOutput> => {
    const safe = bankStatementPayloadSchema.parse(payload);
    if (!safe.rawCsvText && !safe.statementPdfBase64) {
      throw new Error("parse-bank-statement: provide rawCsvText or statementPdfBase64.");
    }
    logger.info("parse-bank-statement: start", {
      hasCsv: !!safe.rawCsvText,
      hasPdf: !!safe.statementPdfBase64,
      filename: safe.filename,
    });

    // ---------- 1. Pull raw rows ----------
    let rawRows: { date: string; description: string; debit: number; credit: number }[] = [];

    if (safe.rawCsvText) {
      const parsed = parseCsvText(safe.rawCsvText);
      if (parsed.errors.length) {
        logger.warn("parse-bank-statement: CSV parse warnings", {
          errors: parsed.errors.slice(0, 5),
        });
      }
      rawRows = parsed.data
        .map(normalizeRow)
        .filter((r): r is NonNullable<typeof r> => r !== null);
        } else {
      let pdfPart = safe.statementPdfBase64!.replace(
        /^data:[^;]+;base64,/,
        ""
      );

      try {
  logger.info(
    "parse-bank-statement: checking PDF protection"
  );

  pdfPart = await decryptPdf(
    pdfPart,
    safe.pdfPassword
  );

  logger.info(
    "parse-bank-statement: PDF ready for Gemini"
  );
} catch (error) {
  if (
    error instanceof Error &&
    error.message === "PDF_PASSWORD_REQUIRED"
  ) {
    throw new Error(
      "PDF_PASSWORD_REQUIRED: This bank statement is password protected. Please provide the PDF password."
    );
  }

  if (
    error instanceof Error &&
    error.message === "INVALID_PDF_PASSWORD"
  ) {
    throw new Error(
      "INVALID_PDF_PASSWORD: The PDF password is incorrect."
    );
  }

  throw error;
}

      const prompt = `Extract every transaction from this bank statement PDF.
Return JSON: { "rows": [{ "date": "YYYY-MM-DD", "description": "...", "debit": number, "credit": number }] }
Use 0 for missing debit/credit. ISO-8601 dates. Return ONLY JSON.`;
      
      const genai = getGenaiClient();
      const response = await genai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { data: pdfPart, mimeType: "application/pdf" } },
            ],
          },
        ],
        config: { responseMimeType: "application/json", temperature: 0.1 },
      });
      const text = extractResponseText(response);
      const json = JSON.parse(text || "{}");
      const rows = Array.isArray(json.rows) ? json.rows : [];
      rawRows = rows
        .map((r: any) => ({
          date: String(r.date ?? ""),
          description: String(r.description ?? ""),
          debit: Number(r.debit ?? 0) || 0,
          credit: Number(r.credit ?? 0) || 0,
        }))
        .filter((r: { date: string; description: string }) => r.date || r.description);
    }

    if (!rawRows.length) {
      logger.info("parse-bank-statement: no rows detected");
      return { transactions: [] };
    }

    // ---------- 2. Categorize via Gemini (batched) ----------
    const BATCH_SIZE = 50;
    const genai = getGenaiClient();
    const out: Transaction[] = [];

    for (let i = 0; i < rawRows.length; i += BATCH_SIZE) {
      const batch = rawRows.slice(i, i + BATCH_SIZE);
      const prompt = `You are a Tally Prime ledger-mapping assistant.
Given the following array of bank transactions, return a JSON object with key "transactions" preserving the original order.
For each row, fill "mappedTallyLedger" with standard Tally ledger heads (e.g., "Office Rent", "Salaries & Wages", "Bank Charges", "Interest Received", "Sales - Domestic", "Purchase - Domestic", "Telephone Expense", "Fuel Expense", "TDS Receivable", "GST Payable", "Unclassified").
Round debit/credit to 2 decimals; keep date & description as-is.

Bank transactions:
${JSON.stringify(batch, null, 2)}

Return ONLY JSON: { "transactions": [ { "date": "...", "description": "...", "debit": number, "credit": number, "mappedTallyLedger": "..." } ] }`;

      const response = await genai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0.1 },
      });
      const text = extractResponseText(response);
      const json = JSON.parse(text || "{}");
      const txs = Array.isArray(json.transactions) ? json.transactions : [];

      for (const t of txs) {
        out.push(
          transactionSchema.parse({
            date: t.date ?? "",
            description: t.description ?? "",
            debit: Number(t.debit ?? 0) || 0,
            credit: Number(t.credit ?? 0) || 0,
            mappedTallyLedger: t.mappedTallyLedger ?? "Unclassified",
          })
        );
      }
    }

    // ---------- 3. Append to Google Sheets ----------
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    if (spreadsheetId && out.length > 0) {
      logger.info("parse-bank-statement: syncing to Google Sheets...", { spreadsheetId });
      await appendTransactionsToGoogleSheet(spreadsheetId, out);
      logger.info("parse-bank-statement: Google Sheets sync complete");
    }

    logger.info("parse-bank-statement: complete", { totalTransactions: out.length });
    return {
      transactions: out,
      spreadsheetUrl: spreadsheetId
        ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
        : undefined,
    };
  },
});