import { generateTallyExcel } from "./tally-excel";

const mockInvoices = [
    {
        invoiceNumber: "INV-2026-001",
        invoiceDate: "2026-08-10",
        vendorName: "Shree Ganesh Enterprises",
        vendorGstin: "27AAAPL1234C1ZV",
        taxableAmount: 25000,
        cgst: 2250,
        sgst: 2250,
        igst: 0,
        totalAmount: 29500,
    },
    {
        invoiceNumber: "INV-2026-002",
        invoiceDate: "2026-08-12",
        vendorName: "Tech Cloud Solutions",
        vendorGstin: "29BBBPK9876D1Z5",
        taxableAmount: 40000,
        cgst: 0,
        sgst: 0,
        igst: 7200,
        totalAmount: 47200,
    },
];

async function run() {
    await generateTallyExcel(mockInvoices, "./tally-import-sample.xlsx");
    console.log("🎉 Test passed! Check tally-import-sample.xlsx in your root folder.");
}

run();