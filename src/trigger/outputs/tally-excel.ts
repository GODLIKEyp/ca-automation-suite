import ExcelJS from "exceljs";

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

export async function generateTallyExcel(
    approvedInvoices: ParsedInvoiceData[],
    outputPath: string
) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Purchase Vouchers");

    // Tally-compliant header structure
    worksheet.columns = [
        { header: "Voucher Date", key: "date", width: 15 },
        { header: "Voucher Type", key: "type", width: 15 },
        { header: "Voucher No", key: "vchNo", width: 15 },
        { header: "Supplier Invoice No", key: "invNo", width: 20 },
        { header: "Supplier Invoice Date", key: "invDate", width: 15 },
        { header: "Party Ledger Name", key: "party", width: 30 },
        { header: "Party GSTIN", key: "gstin", width: 20 },
        { header: "Taxable Amount", key: "taxable", width: 15 },
        { header: "CGST Amount", key: "cgst", width: 12 },
        { header: "SGST Amount", key: "sgst", width: 12 },
        { header: "IGST Amount", key: "igst", width: 12 },
        { header: "Total Invoice Amount", key: "total", width: 18 },
    ];

    // Make header bold
    worksheet.getRow(1).font = { bold: true };

    // Add rows
    approvedInvoices.forEach((inv) => {
        worksheet.addRow({
            date: inv.invoiceDate,
            type: "Purchase",
            vchNo: inv.invoiceNumber,
            invNo: inv.invoiceNumber,
            invDate: inv.invoiceDate,
            party: inv.vendorName,
            gstin: inv.vendorGstin,
            taxable: inv.taxableAmount,
            cgst: inv.cgst,
            sgst: inv.sgst,
            igst: inv.igst,
            total: inv.totalAmount,
        });
    });

    await workbook.xlsx.writeFile(outputPath);
    console.log(`🚀 Tally import sheet generated successfully at: ${outputPath}`);
}