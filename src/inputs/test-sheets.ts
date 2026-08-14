import { appendInvoiceToSheet } from "../services/google-sheets";

async function main() {
  await appendInvoiceToSheet({
    vendorName: "TEST VENDOR",
    vendorGstin: "TEST-GSTIN",
    invoiceNumber: "TEST-001",
    invoiceDate: "2026-08-14",
    taxableAmount: 1000,
    cgst: 90,
    sgst: 90,
    igst: 0,
    totalAmount: 1180,
  });

  console.log("🎉 Google Sheets test completed!");
}

main().catch((error) => {
  console.error("❌ Google Sheets test failed:");
  console.error(error);
});