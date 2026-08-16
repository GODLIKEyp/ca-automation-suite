import { google } from "googleapis";
import { generateTallyExcel, ParsedInvoiceData } from "./tally-excel";

export async function exportApprovedRowsToTally(
    spreadsheetId: string,
    outputFilePath: string = "./tally-import-ready.xlsx"
) {
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    // 1. Read all rows from the review sheet
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Sheet1!A2:K", // Skip row 1 (headers)
    });

    const rows = response.data.values || [];
    if (rows.length === 0) {
        console.log("⚠️ No rows found in the review sheet.");
        return { count: 0 };
    }

    const approvedInvoices: ParsedInvoiceData[] = [];
    const rowsToUpdateStatus: number[] = [];

    // 2. Flexible filter for approval
    rows.forEach((row, index) => {
        const rawStatus = (row[0] || "").toString().trim().toLowerCase();

        // Matches 'approved', 'approve', 'done', 'yes', or any string containing 'approv' or '🟢'
        const isApproved =
            rawStatus.includes("approv") ||
            rawStatus.includes("🟢") ||
            rawStatus === "done" ||
            rawStatus === "yes" ||
            rawStatus === "ok";

        if (isApproved) {
            approvedInvoices.push({
                invoiceDate: row[2] || "",
                invoiceNumber: row[3] || "",
                vendorName: row[4] || "",
                vendorGstin: row[5] || "",
                taxableAmount: parseFloat(row[6]) || 0,
                cgst: parseFloat(row[7]) || 0,
                sgst: parseFloat(row[8]) || 0,
                igst: parseFloat(row[9]) || 0,
                totalAmount: parseFloat(row[10]) || 0,
            });

            // Keep track of spreadsheet row index (1-based, +2 because of header + 0-index)
            rowsToUpdateStatus.push(index + 2);
        }
    });

    if (approvedInvoices.length === 0) {
        console.log("ℹ️ No approved rows ready for export.");
        return { count: 0 };
    }

    // 3. Generate the Tally Prime Excel File
    await generateTallyExcel(approvedInvoices, outputFilePath);

    // 4. Update the exported rows to 'Exported' so they aren't double-processed
    for (const rowNum of rowsToUpdateStatus) {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `Sheet1!A${rowNum}`,
            valueInputOption: "USER_ENTERED",
            requestBody: {
                values: [["Exported"]],
            },
        });
    }

    console.log(
        `✅ Successfully exported ${approvedInvoices.length} approved invoices to ${outputFilePath} and updated sheet statuses.`
    );
    return { count: approvedInvoices.length, filePath: outputFilePath };
}