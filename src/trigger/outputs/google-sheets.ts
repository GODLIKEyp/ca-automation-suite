import { google } from "googleapis";

export interface ParsedInvoiceData {
    invoiceNumber: string;
    invoiceDate: string;
    vendorName: string;
    vendorGstin: string;
    taxableAmount: number;
    cgst: number;
    sgst: number;
    igst: number;
    totalAmount: number;
    fileUrl?: string;
}

export const REVIEW_QUEUE_HEADERS = [
    "STATUS",
    "AUDIT CHECK",
    "DATE",
    "INVOICE NO",
    "VENDOR NAME",
    "VENDOR GSTIN",
    "TAXABLE AMOUNT",
    "CGST",
    "SGST",
    "IGST",
    "TOTAL AMOUNT",
    "LEDGER HEAD",
    "FILE LINK",
];

export const REVIEW_QUEUE_TAB = "Sheet1";

/**
 * Resolve the target sheet tab. If the requested tab doesn't exist,
 * create it with the canonical header row so the rest of the pipeline
 * can keep appending without manual setup.
 *
 * Returns the resolved tab title.
 */
export async function ensureReviewQueueTab(
    spreadsheetId: string,
    preferredTitle: string = REVIEW_QUEUE_TAB
): Promise<string> {
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const existing = (meta.data.sheets ?? []).map(
        (s) => s.properties?.title ?? ""
    );

    if (existing.includes(preferredTitle)) {
        return preferredTitle;
    }

    // Try the first existing tab as a fallback before creating a new one.
    if (existing.length > 0 && existing[0]) {
        return existing[0];
    }

    // Truly empty spreadsheet — add a fresh tab with headers.
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
            requests: [
                {
                    addSheet: {
                        properties: { title: preferredTitle },
                    },
                },
            ],
        },
    });
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${preferredTitle}'!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [REVIEW_QUEUE_HEADERS] },
    });
    return preferredTitle;
}

export async function appendInvoiceToReviewQueue(
    spreadsheetId: string,
    invoice: ParsedInvoiceData
) {
    // Resolve the target tab name first (creates with headers if missing).
    const tabTitle = await ensureReviewQueueTab(spreadsheetId);

    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    // 1. Math Balance Check: Taxable + Taxes == Total
    const calculatedTotal =
        invoice.taxableAmount + invoice.cgst + invoice.sgst + invoice.igst;
    const diff = Math.abs(calculatedTotal - invoice.totalAmount);
    const isMathBalanced = diff < 1.0;

    // 2. GSTIN Format Check (Standard 15-character Indian GSTIN pattern)
    const cleanGstin = (invoice.vendorGstin || "").trim().toUpperCase();
    const isValidGstin =
        cleanGstin.length === 15 &&
        /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(cleanGstin);

    // 3. Mandatory Fields Check
    const hasRequiredFields =
        Boolean(invoice.invoiceNumber && invoice.invoiceNumber.trim()) &&
        Boolean(invoice.invoiceDate && invoice.invoiceDate.trim()) &&
        invoice.totalAmount > 0;

    // 4. Determine Status & Audit Reason
    let auditStatus = "✅ Balanced";
    let initialStatus = "🟡 Pending Review";

    if (!isMathBalanced) {
        auditStatus = `❌ Tax Mismatch (Diff: ₹${diff.toFixed(2)})`;
        initialStatus = "🔴 Flagged Error";
    } else if (!hasRequiredFields) {
        auditStatus = "❌ Missing Required Fields";
        initialStatus = "🔴 Flagged Error";
    } else if (invoice.vendorGstin && !isValidGstin) {
        auditStatus = "⚠️ Invalid GSTIN Format";
        initialStatus = "🔴 Flagged Error";
    }

    const rowValues = [
        initialStatus,
        auditStatus,
        invoice.invoiceDate,
        invoice.invoiceNumber,
        invoice.vendorName,
        invoice.vendorGstin,
        invoice.taxableAmount,
        invoice.cgst,
        invoice.sgst,
        invoice.igst,
        invoice.totalAmount,
        "Purchase",
        invoice.fileUrl || "N/A",
    ];

    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `'${tabTitle}'!A:M`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
            values: [rowValues],
        },
    });

    console.log(
        `✅ Appended invoice ${invoice.invoiceNumber || "UNKNOWN"} to "${tabTitle}" with status: ${initialStatus} (${auditStatus})`
    );
}