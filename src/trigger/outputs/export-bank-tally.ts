import "dotenv/config";
import { google } from "googleapis";
import ExcelJS from "exceljs";
import path from "node:path";

export async function exportApprovedBankToTally(spreadsheetId: string) {
    console.log("📥 Fetching approved bank transactions from Google Sheets...");

    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "'Bank Transactions'!A2:H",
    });

    const rows = response.data.values ?? [];
    const approvedIndices: number[] = [];
    const approvedRows: any[][] = [];

    rows.forEach((row, idx) => {
        const status = (row[0] || "").toLowerCase();
        if (status.includes("approved") || status.includes("🟢")) {
            approvedIndices.push(idx + 2); // 1-based index + header row offset
            approvedRows.push(row);
        }
    });

    if (approvedRows.length === 0) {
        console.log("⚠️ No rows marked 'Approved' found in 'Bank Transactions'.");
        return;
    }

    console.log(`📊 Found ${approvedRows.length} approved transactions. Generating Tally Excel...`);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Tally Bank Vouchers");

    worksheet.columns = [
        { header: "Voucher Date", key: "date", width: 15 },
        { header: "Voucher Type", key: "type", width: 15 },
        { header: "Bank Account", key: "bankAccount", width: 25 },
        { header: "Particulars / Ledger", key: "ledger", width: 30 },
        { header: "Amount (INR)", key: "amount", width: 15 },
        { header: "Narration", key: "narration", width: 40 },
    ];
    worksheet.getRow(1).font = { bold: true };

    approvedRows.forEach((r) => {
        const date = r[1] || "";
        const description = r[2] || "";
        const debit = Number(r[3]) || 0;
        const credit = Number(r[4]) || 0;
        const ledger = r[5] || "Unclassified";

        const isDrawings = ledger === "Proprietor Drawings";
        const isPayment = isDrawings || debit > 0;
        const amount = isDrawings ? (debit || credit) : isPayment ? debit : credit;
        const voucherType = isPayment ? "Payment" : "Receipt";
        const partyLedger = isDrawings ? "Drawings A/c" : ledger;

        worksheet.addRow({
            date,
            type: voucherType,
            bankAccount: "Kotak Bank A/c",
            ledger: partyLedger,
            amount,
            narration: description,
        });
    });

    const outputPath = path.join(process.cwd(), "tally-bank-vouchers-ready.xlsx");
    await workbook.xlsx.writeFile(outputPath);
    console.log(`🎉 Excel generated successfully at: ${outputPath}`);

    // Mark exported rows as "🔵 Exported" in Google Sheets
    console.log("📝 Updating status to '🔵 Exported' in Google Sheets...");
    const updateData = approvedIndices.map((rowNum) => ({
        range: `'Bank Transactions'!A${rowNum}`,
        values: [["🔵 Exported"]],
    }));

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data: updateData,
        },
    });

    console.log(`✅ Marked ${approvedIndices.length} rows as '🔵 Exported'.`);
}

if (process.env.GOOGLE_SPREADSHEET_ID) {
    exportApprovedBankToTally(process.env.GOOGLE_SPREADSHEET_ID);
} else {
    console.error("❌ GOOGLE_SPREADSHEET_ID not found in .env");
}