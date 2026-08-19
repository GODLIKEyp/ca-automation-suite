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
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheets = google.sheets({ version: "v4", auth });
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "'Bank Transactions'!A2:H",
    });

    const rows = response.data.values ?? [];
    const approvedRows = rows.filter((r) => r[0]?.includes("Approved") || r[0]?.includes("🟢"));

    if (approvedRows.length === 0) {
        console.log("⚠️ No rows marked '🟢 Approved' found in 'Bank Transactions'.");
        return;
    }

    console.log(`📊 Processing ${approvedRows.length} approved transactions for Tally...`);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Tally Bank Vouchers");

    worksheet.columns = [
        { header: "Voucher Date", key: "date", width: 15 },
        { header: "Voucher Type", key: "type", width: 15 },
        { header: "Bank Account (Dr/Cr)", key: "bankAccount", width: 25 },
        { header: "Particulars / Ledger", key: "ledger", width: 30 },
        { header: "Amount (INR)", key: "amount", width: 15 },
        { header: "Narration", key: "narration", width: 40 },
    ];

    approvedRows.forEach((r) => {
        const date = r[1] || "";
        const description = r[2] || "";
        const debit = Number(r[3]) || 0;
        const credit = Number(r[4]) || 0;
        const ledger = r[5] || "Unclassified";
        const auditFlags = r[6] || "";
        const auditRiskLevel = r[7] || "LOW";

        const isDrawings = ledger === "Proprietor Drawings";
        const isPayment = isDrawings || debit > 0;
        const amount = isDrawings ? debit || credit : isPayment ? debit : credit;
        const voucherType = isPayment ? "Payment" : "Receipt";
        const partyLedger = isDrawings ? "Drawings A/c" : ledger;

        if (auditRiskLevel === "HIGH") {
            console.warn(
                `⚠️ Exporting HIGH-risk approved row: ${description} [${auditFlags}]`
            );
        }

        worksheet.addRow({
            date,
            type: voucherType,
            bankAccount: "HDFC Bank A/c",
            ledger: partyLedger,
            amount,
            narration: description,
        });
    });

    const outputPath = path.join(process.cwd(), "tally-bank-vouchers-ready.xlsx");
    await workbook.xlsx.writeFile(outputPath);
    console.log(`🎉 Export complete! Generated Tally file: ${outputPath}`);
}

