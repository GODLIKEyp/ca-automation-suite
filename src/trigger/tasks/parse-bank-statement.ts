import { task, logger } from "@trigger.dev/sdk/v3";
import Papa from "papaparse";
import { z } from "zod";
import { extractResponseText, getGenaiClient } from "../lib/gemini";

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
});

export type Transaction = z.infer<typeof transactionSchema>;
export type BankStatementOutput = z.infer<typeof bankStatementOutputSchema>;

export const bankStatementPayloadSchema = z.object({
  statementPdfBase64: z.string().optional(),
  rawCsvText: z.string().optional(),
});

export type BankStatementPayload = z.infer<typeof bankStatementPayloadSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Crude but effective: pull out header row + data rows from a CSV text dump.
 * Returns columns and rows as parallel arrays.
 */
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

/**
 * Normalize a transaction into the canonical shape expected by the categorizer.
 */
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
    const a = parseAmount(amountRaw);
    // Without a sign we default to debit (outflow).
    debit = a;
  }

  if (!date && !description) return null;
  return {
    date: date || "",
    description: description || "",
    debit,
    credit,
  };
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
      // PDF path — let Gemini do the heavy lifting.
      const pdfPart = safe.statementPdfBase64!.replace(/^data:[^;]+;base64,/, "");
      const prompt = `Extract every transaction from this bank statement PDF.
Return JSON: { "rows": [{ "date": "YYYY-MM-DD", "description": "...", "debit": number, "credit": number }] }
Use 0 for missing debit/credit. ISO-8601 dates. No commentary, JSON only.`;
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
Given the following array of bank transactions, return a JSON object with key "transactions"
preserving the original order. For each row, fill "mappedTallyLedger" using a Tally-compliant
ledger head (e.g., "Conveyance Expense", "Fuel Expense", "Telephone Expense",
"Office Rent", "Salaries & Wages", "Bank Charges", "Interest Received", "Sales - Domestic",
"Purchase - Domestic", "TDS Receivable", "GST Payable", "Capital Introduced", "Unclassified").
Round debit/credit to 2 decimals; keep date & description as-is.

Bank transactions:
${JSON.stringify(batch, null, 2)}

Return ONLY JSON of shape: { "transactions": [ { "date": "...", "description": "...", "debit": number, "credit": number, "mappedTallyLedger": "..." } ] }`;

      const response = await genai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0.1 },
      });
      const text = extractResponseText(response);
      const json = JSON.parse(text || "{}");
      const txs = Array.isArray(json.transactions) ? json.transactions : [];

      for (const t of txs) {
        const parsed = transactionSchema.parse({
          date: t.date ?? "",
          description: t.description ?? "",
          debit: Number(t.debit ?? 0) || 0,
          credit: Number(t.credit ?? 0) || 0,
          mappedTallyLedger: t.mappedTallyLedger ?? "Unclassified",
        });
        out.push(parsed);
      }
    }

    logger.info("parse-bank-statement: complete", {
      totalTransactions: out.length,
    });
    return { transactions: out };
  },
});
