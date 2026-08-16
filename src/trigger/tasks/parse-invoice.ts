import { task, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import { extractResponseText, getGenaiClient, resolveImagePart } from "../lib/gemini";
import { appendInvoiceToReviewQueue } from "../outputs/google-sheets";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
export const lineItemSchema = z.object({
  description: z.string().default(""),
  quantity: z.number().nonnegative().default(0),
  price: z.number().nonnegative().default(0),
  total: z.number().nonnegative().default(0),
});

export const invoiceSchema = z.object({
  vendorName: z.string().default(""),
  vendorGstin: z.string().default(""),
  invoiceNumber: z.string().default(""),
  invoiceDate: z.string().default(""),
  taxableAmount: z.number().nonnegative().default(0),
  cgst: z.number().nonnegative().default(0),
  sgst: z.number().nonnegative().default(0),
  igst: z.number().nonnegative().default(0),
  totalAmount: z.number().nonnegative().default(0),
  lineItems: z.array(lineItemSchema).default([]),
});

export type Invoice = z.infer<typeof invoiceSchema>;

export const parseInvoicePayloadSchema = z.object({
  imageUrl: z.string().url().optional(),
  base64Data: z.string().optional(),
  filename: z.string().optional(),
});

export type ParseInvoicePayload = z.infer<typeof parseInvoicePayloadSchema>;

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------
export const parseInvoice = task({
  id: "parse-invoice",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: ParseInvoicePayload): Promise<Invoice> => {
    const safe = parseInvoicePayloadSchema.parse(payload);
    logger.info("parse-invoice: start", {
      hasUrl: !!safe.imageUrl,
      hasBase64: !!safe.base64Data,
      filename: safe.filename,
    });

    const { data, mimeType } = await resolveImagePart(safe);

    const prompt = `You are an OCR + accounts-payable assistant for Indian GST invoices.
Extract the following fields from the image/PDF and return ONLY a JSON object matching the schema below.
- Strings default to "" if missing.
- Numbers default to 0 if missing.
- Dates must be ISO-8601 (YYYY-MM-DD).
- Round all monetary values to 2 decimal places.
- Capture every visible line item.

=== JSON SCHEMA ===
{
  "vendorName": "string",
  "vendorGstin": "string",
  "invoiceNumber": "string",
  "invoiceDate": "YYYY-MM-DD",
  "taxableAmount": number,
  "cgst": number,
  "sgst": number,
  "igst": number,
  "totalAmount": number,
  "lineItems": [
    { "description": "string", "quantity": number, "price": number, "total": number }
  ]
}

Return ONLY the JSON. No markdown, no commentary.`;

    const genai = getGenaiClient();
    const response = await genai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { data, mimeType } },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        temperature: 0.1,
        topP: 0.8,
      },
    });

    const rawText = extractResponseText(response);
    if (!rawText) {
      throw new Error("parse-invoice: Gemini returned empty response.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      logger.error("parse-invoice: non-JSON output", { rawText, err: String(err) });
      throw new Error("parse-invoice: model output failed JSON.parse.");
    }

    const validated = invoiceSchema.parse(parsed);
    logger.info("parse-invoice: success", {
      invoiceNumber: validated.invoiceNumber,
      totalAmount: validated.totalAmount,
      lineItems: validated.lineItems.length,
    });

    // Automatically push parsed invoice to Google Sheet review queue.
    // If the sync fails, log it AND re-throw so Trigger.dev marks the run
    // as FAILED — silent failures here were the root cause of the
    // "triggered but no rows" symptom.
    if (process.env.GOOGLE_SPREADSHEET_ID) {
      try {
        await appendInvoiceToReviewQueue(process.env.GOOGLE_SPREADSHEET_ID, {
          invoiceNumber: validated.invoiceNumber,
          invoiceDate: validated.invoiceDate,
          vendorName: validated.vendorName,
          vendorGstin: validated.vendorGstin,
          taxableAmount: validated.taxableAmount,
          cgst: validated.cgst,
          sgst: validated.sgst,
          igst: validated.igst,
          totalAmount: validated.totalAmount,
          fileUrl: safe.imageUrl || safe.filename,
        });
        logger.info("parse-invoice: synced to Google Sheet review queue", {
          spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
          invoiceNumber: validated.invoiceNumber,
        });
      } catch (syncErr) {
        const msg = `Google Sheet sync failed for invoice ${validated.invoiceNumber}: ${String(syncErr)}`;
        logger.error("parse-invoice: failed to sync to Google Sheet", {
          err: String(syncErr),
          invoiceNumber: validated.invoiceNumber,
        });
        // Re-throw so the run is marked FAILED in Trigger.dev.
        throw new Error(msg);
      }
    }

    return validated;
  },
});