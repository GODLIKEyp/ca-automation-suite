/**
 * Indian statutory tax & audit thresholds for bank-statement classification.
 *
 * Centralised so future Finance Act amendments require editing *this file only*;
 * the audit engine in `parse-bank-statement.ts` reads everything from here.
 *
 * Keyed by Financial Year (e.g. `"FY2025-26"`); falls back to `default`.
 */

export interface CashDisallowanceRule {
  section: string;
  /** "Cash payment > ₹X triggers tax disallowance under this section." */
  limit: number;
  /** Narration tokens that imply cash/self/ATM withdrawal. */
  keywords: string[];
}

export interface CashReceiptRule {
  section: string;
  /** "Cash receipt ≥ ₹X attracts penalty." */
  limit: number;
  /** Narration tokens that indicate cash was received or deposited. */
  keywords: string[];
}

export interface TdsRule {
  section: string;
  /** Lower threshold above which TDS may apply (single payment, not aggregate). */
  limit: number;
  /** Narration tokens that indicate the section's typical payee category. */
  keywords: string[];
}

export interface TdsRentRule {
  section: string;
  limit: number;
  /** Mapped ledger that triggers this rule. */
  ledger: string;
}

export interface TaxRules {
  cashDisallowance: CashDisallowanceRule;
  cashReceipt: CashReceiptRule;
  tdsContractor: TdsRule;
  tdsProfessional: TdsRule;
  tdsRent: TdsRentRule;
  /** Transactions at/above this amount are checked for round-sum patterns. */
  roundSumThreshold: number;
  /** Narration tokens that flag a transaction as personal lifestyle spend
   *  (auto-reclassified to Proprietor Drawings as a deterministic safety net). */
  lifestyleKeywords: string[];
}

/**
 * Rule set per Financial Year. Add a new `"FYyyyy-yy"` entry to override
 * thresholds/sections for a specific year; the audit engine picks the entry
 * whose key matches the `financialYear` arg, falling back to `default`.
 */
export const TAX_RULES: Record<string, TaxRules> = {
  // Current / default rule set — keep this in sync with the latest Finance Act.
  default: {
    cashDisallowance: {
      section: "Sec 40A(3)",
      limit: 10_000,
      keywords: ["cash", "self", "atm", "cash wdl"],
    },
    cashReceipt: {
      section: "Sec 269ST",
      limit: 200_000,
      keywords: ["cash", "deposit", "ctr"],
    },
    tdsContractor: {
      section: "Sec 194C",
      limit: 30_000,
      keywords: ["contract", "freight", "maintenance", "advertis"],
    },
    tdsProfessional: {
      section: "Sec 194J",
      limit: 30_000,
      keywords: ["consult", "legal", "advocate", "professional", "technical"],
    },
    tdsRent: {
      section: "Sec 194-I",
      limit: 50_000,
      ledger: "Office Rent",
    },
    roundSumThreshold: 100_000,
    lifestyleKeywords: [
      "swiggy", "zomato", "blinkit", "zepto",
      "netflix", "prime", "amazon", "myntra",
      "school", "hospital", "jewelry", "jeweller",
    ],
  },

  // FY-specific overrides — uncomment and edit when thresholds or sections
  // change under a new Finance Act.
  //
  // "FY2024-25": { ...same shape as `default`... },
  // "FY2025-26": { ...same shape as `default`... },
};

export function resolveTaxRules(financialYear?: string): TaxRules {
  if (financialYear && TAX_RULES[financialYear]) {
    return TAX_RULES[financialYear];
  }
  return TAX_RULES.default;
}
