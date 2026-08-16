import "dotenv/config";
import { appendInvoiceToReviewQueue } from "./google-sheets";
import { exportApprovedRowsToTally } from "./export-approved";

async function testPipeline() {
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

    if (!spreadsheetId) {
        console.error("❌ GOOGLE_SPREADSHEET_ID missing in .env");
        return;
    }

    console.log("1️⃣ Appending a test invoice to your Google Sheet...");
    await appendInvoiceToReviewQueue(spreadsheetId, {
        invoiceNumber: "LIVE-TEST-101",
        invoiceDate: "2026-08-14",
        vendorName: "Maharashtra Tech Distributors",
        vendorGstin: "27AAACM1234F1Z8",
        taxableAmount: 10000,
        cgst: 900,
        sgst: 900,
        igst: 0,
        totalAmount: 11800,
    });

    console.log("🎉 Row appended! Check your Google Sheet in browser.");
}

testPipeline();