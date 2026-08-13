import { task, logger } from "@trigger.dev/sdk/v3";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
export const gstr2bRowSchema = z.object({
  gstin: z.string().min(1),
  invoiceNumber: z.string().min(1),
  amount: z.number().nonnegative(),
});

export const purchaseRegisterRowSchema = z.object({
  gstin: z.string().min(1),
  invoiceNumber: z.string().min(1),
  amount: z.number().nonnegative(),
});

export const reconcilePayloadSchema = z.object({
  gstr2bRows: z.array(gstr2bRowSchema).min(1),
  purchaseRegisterRows: z.array(purchaseRegisterRowSchema).min(1),
});

export type Gstr2bRow = z.infer<typeof gstr2bRowSchema>;
export type PurchaseRegisterRow = z.infer<typeof purchaseRegisterRowSchema>;
export type ReconcilePayload = z.infer<typeof reconcilePayloadSchema>;

const reconciledRowSchema = z.object({
  gstin: z.string(),
  invoiceNumber: z.string(),
  gstr2bAmount: z.number().optional(),
  purchaseRegisterAmount: z.number().optional(),
  difference: z.number().optional(),
});

export type ReconciledRow = z.infer<typeof reconciledRowSchema>;

export const reconcileOutputSchema = z.object({
  exactMatches: z.array(reconciledRowSchema),
  amountMismatches: z.array(
    reconciledRowSchema.extend({
      difference: z.number(),
    })
  ),
  missingIn2B: z.array(reconciledRowSchema),
  excessClaimed: z.array(reconciledRowSchema),
  summary: z.object({
    totalGstr2bRows: z.number(),
    totalPurchaseRegisterRows: z.number(),
    exactMatchesCount: z.number(),
    amountMismatchesCount: z.number(),
    missingIn2BCount: z.number(),
    excessClaimedCount: z.number(),
  }),
});

export type ReconcileOutput = z.infer<typeof reconcileOutputSchema>;

// ---------------------------------------------------------------------------
// Helpers — deterministic fuzzy matching
// ---------------------------------------------------------------------------
const AMOUNT_TOLERANCE = 0.05; // ₹0.05 to absorb rounding noise

/** Normalize GSTIN for comparison (uppercase, strip spaces). */
export function normalizeGstin(gstin: string): string {
  return gstin.trim().toUpperCase().replace(/\s+/g, "");
}

/** Normalize invoice number — uppercase, collapse whitespace, strip common noise. */
export function normalizeInvoiceNumber(inv: string): string {
  return inv
    .trim()
    .toUpperCase()
    .replace(/[\s/_-]+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

type Key = string;
const keyOf = (gstin: string, invoiceNumber: string): Key =>
  `${normalizeGstin(gstin)}::${normalizeInvoiceNumber(invoiceNumber)}`;

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------
export const reconcileGstr2b = task({
  id: "reconcile-gstr2b",
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 20_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: ReconcilePayload): Promise<ReconcileOutput> => {
    const safe = reconcilePayloadSchema.parse(payload);
    logger.info("reconcile-gstr2b: start", {
      gstr2bRows: safe.gstr2bRows.length,
      purchaseRegisterRows: safe.purchaseRegisterRows.length,
    });

    // Build keyed maps for O(1) lookup.
    const gstr2bMap = new Map<Key, Gstr2bRow>();
    for (const row of safe.gstr2bRows) {
      gstr2bMap.set(keyOf(row.gstin, row.invoiceNumber), row);
    }

    const prMap = new Map<Key, PurchaseRegisterRow>();
    for (const row of safe.purchaseRegisterRows) {
      prMap.set(keyOf(row.gstin, row.invoiceNumber), row);
    }

    const exactMatches: ReconciledRow[] = [];
    const amountMismatches: (ReconciledRow & { difference: number })[] = [];
    const missingIn2B: ReconciledRow[] = [];
    const seenInPr = new Set<Key>();

    // Walk the purchase register — it represents ITC the CA is claiming.
    for (const pr of safe.purchaseRegisterRows) {
      const key = keyOf(pr.gstin, pr.invoiceNumber);
      seenInPr.add(key);
      const gstr2b = gstr2bMap.get(key);

      if (!gstr2b) {
        // Claimed in PR but missing in 2B → risky ITC.
        missingIn2B.push({
          gstin: pr.gstin,
          invoiceNumber: pr.invoiceNumber,
          purchaseRegisterAmount: pr.amount,
        });
        continue;
      }

      const diff = Math.abs(gstr2b.amount - pr.amount);
      if (diff <= AMOUNT_TOLERANCE) {
        exactMatches.push({
          gstin: pr.gstin,
          invoiceNumber: pr.invoiceNumber,
          gstr2bAmount: gstr2b.amount,
          purchaseRegisterAmount: pr.amount,
          difference: 0,
        });
      } else {
        amountMismatches.push({
          gstin: pr.gstin,
          invoiceNumber: pr.invoiceNumber,
          gstr2bAmount: gstr2b.amount,
          purchaseRegisterAmount: pr.amount,
          difference: Number((gstr2b.amount - pr.amount).toFixed(2)),
        });
      }
    }

    // Anything in 2B but not seen in PR → excess claim opportunity OR unclaimed credit.
    // From the CA's perspective: vendor uploaded to 2B but PR is missing it.
    const excessClaimed: ReconciledRow[] = [];
    for (const g of safe.gstr2bRows) {
      const key = keyOf(g.gstin, g.invoiceNumber);
      if (!seenInPr.has(key)) {
        excessClaimed.push({
          gstin: g.gstin,
          invoiceNumber: g.invoiceNumber,
          gstr2bAmount: g.amount,
        });
      }
    }

    const output: ReconcileOutput = {
      exactMatches,
      amountMismatches,
      missingIn2B,
      excessClaimed,
      summary: {
        totalGstr2bRows: safe.gstr2bRows.length,
        totalPurchaseRegisterRows: safe.purchaseRegisterRows.length,
        exactMatchesCount: exactMatches.length,
        amountMismatchesCount: amountMismatches.length,
        missingIn2BCount: missingIn2B.length,
        excessClaimedCount: excessClaimed.length,
      },
    };

    logger.info("reconcile-gstr2b: complete", output.summary);
    return output;
  },
});
