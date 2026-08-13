// Trigger.dev discovers tasks via directory scan configured in trigger.config.ts.
// This barrel re-exports every task so the build pipeline can statically
// detect them and the SDK can bundle each worker.

export { parseInvoice } from "./tasks/parse-invoice";
export { reconcileGstr2b } from "./tasks/reconcile-gstr2b";
export { parseBankStatement } from "./tasks/parse-bank-statement";
export { extractCapitalGains } from "./tasks/extract-capital-gains";
export { dispatchDocumentNudge } from "./tasks/dispatch-document-nudge";
