# CA Practice Automation Suite

Production-ready backend for Indian chartered-accountancy practices. Five distinct Trigger.dev v3 tasks cover the everyday document & data heavy lifting: invoice OCR, GSTR-2B reconciliation, bank-to-Tally ledger mapping, capital-gains extraction, and an automated client nudge bot.

---

## Architecture

```
                                ┌────────────────────────────────────┐
                                │  Trigger.dev v3 Worker             │
                                │  (this repo, src/trigger/tasks/*)  │
   Caller  ──── payload ─────▶  │                                    │
                                │  1. parse-invoice                  │  ──▶ Gemini 2.5 Flash Vision
                                │  2. reconcile-gstr2b               │      (structured JSON)
                                │  3. parse-bank-statement           │
                                │  4. extract-capital-gains          │
                                │  5. dispatch-document-nudge        │  ──▶ Twilio/Wati webhook
                                │                                    │
                                └────────────────────────────────────┘
                                              │
                                              ▼
                                Validated JSON + audit metadata
```

| Concern | Choice |
|---|---|
| Long-running, retryable API calls | **Trigger.dev v3** — retries, queueing, observability, concurrency limits baked in. |
| OCR + classification | **Google Gemini 2.5 Flash** vision — cheap, fast, JSON-mode capable. |
| Output safety | All model output is `JSON.parse`d then **Zod**-validated. Bad model output → task throws → Trigger.dev retries. |
| Deterministic tasks (reconcile) | Pure TS, no LLM. Catches the 90% of mismatches that don't need a model. |
| Idempotency | Tasks take a payload object that can be replayed safely. |

---

## File layout

```
.
├── trigger.config.ts                       # Trigger.dev v3 config (project + dirs + retries)
├── src/
│   └── trigger/
│       ├── index.ts                        # Barrel re-export of all tasks (for the bundler)
│       ├── lib/gemini.ts                   # Shared Gemini client + image-part resolver
│       └── tasks/
│           ├── parse-invoice.ts            # Task 1
│           ├── reconcile-gstr2b.ts         # Task 2
│           ├── parse-bank-statement.ts     # Task 3
│           ├── extract-capital-gains.ts    # Task 4
│           └── dispatch-document-nudge.ts  # Task 5
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

---

## Quick start

```bash
# 1. Install
npm install

# 2. Configure secrets
cp .env.example .env
# edit .env → fill in TRIGGER_SECRET_KEY and GEMINI_API_KEY

# 3. Run locally (opens Trigger.dev dashboard)
npx trigger.dev@latest dev
```

### Where to get the secrets

| Var | Where |
|---|---|
| `TRIGGER_SECRET_KEY` | https://cloud.trigger.dev → project → **Settings → API Keys** → *Create dev key* |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| `MESSAGING_PROVIDER` | `twilio` or `wati` (defaults to `simulated` if unset) |
| `MESSAGING_CHANNEL` | `whatsapp` or `sms` |

> Project ref `proj_ca_automation_suite` in `trigger.config.ts` is a placeholder. The CLI will create or link the matching project on first `dev` / `deploy`.

---

## The 5 Tasks

### 1. `parse-invoice` — Multi-Vendor Invoice Parser

**Input**

```ts
{
  imageUrl?: "https://...",
  base64Data?: "data:image/png;base64,...",
  filename?: "bill.png"
}
```

**Output**

```ts
{
  vendorName: string,
  vendorGstin: string,
  invoiceNumber: string,
  invoiceDate: "YYYY-MM-DD",
  taxableAmount: number,
  cgst: number,
  sgst: number,
  igst: number,
  totalAmount: number,
  lineItems: [
    { description: string, quantity: number, price: number, total: number }
  ]
}
```

LLM-bulletproof: prompt forces `responseMimeType: "application/json"`, then Zod-validates with safe defaults.

### 2. `reconcile-gstr2b` — GSTR-2B vs Purchase Register Matcher

**Input**

```ts
{
  gstr2bRows:             [{ gstin, invoiceNumber, amount }],
  purchaseRegisterRows:   [{ gstin, invoiceNumber, amount }]
}
```

**Output**

```ts
{
  exactMatches:     [...],   // ± ₹0.05 tolerance
  amountMismatches: [...],   // { gstr2bAmount, purchaseRegisterAmount, difference }
  missingIn2B:      [...],   // claimed in PR but absent from 2B → risky ITC
  excessClaimed:    [...],   // present in 2B but absent from PR → claim opportunity
  summary: { ...counts }
}
```

Pure deterministic. Normalizes GSTIN & invoice numbers (uppercase, whitespace, common separators) before keying. ₹0.05 tolerance absorbs rounding noise.

### 3. `parse-bank-statement` — Bank → Tally Ledger Mapper

**Input**

```ts
{
  rawCsvText?: "...",
  statementPdfBase64?: "..."
}
```

**Output**

```ts
{
  transactions: [
    { date: "YYYY-MM-DD", description, debit: number, credit: number, mappedTallyLedger: string }
  ]
}
```

CSV path uses `papaparse` → header detection → Gemini batches of 50 to map descriptions to Tally ledger heads ("Fuel/HPCL" → `Conveyance Expense`, etc.). PDF path sends raw bytes to Gemini and lets it parse + categorize in one shot.

### 4. `extract-capital-gains` — Broker P&L Extractor

**Input**

```ts
{
  statementBase64: "data:application/pdf;base64,...",
  brokerName: "Zerodha" | "Groww" | "Upstox"
}
```

**Output**

```ts
{
  shortTermCapitalGains: number,
  longTermCapitalGains: number,
  totalDividends: number,
  trades: [
    { symbol: string, buyDate: "YYYY-MM-DD", sellDate: "YYYY-MM-DD", netProfitLoss: number }
  ]
}
```

Brokers get distinct prompt hints tailored to their P&L statement layout. Server-side drift check logs if `Σ trades ≈ STCG + LTCG` diverges by more than ₹1.

### 5. `dispatch-document-nudge` — Client Reminder Bot

**Input**

```ts
{
  clientName: "Rohit Sharma",
  phoneNumber: "+919876543210",
  pendingDocumentType: "Form 16 / TDS Certificate",
  dueDate: "2026-08-30"
}
```

**Output**

```ts
{
  success: true,
  recipient: "+919876543210",
  sentTimestamp: "2026-08-11T08:42:15.123Z",
  messagePayload: "Namaste Rohit Sharma,\n\nThis is a gentle reminder ...",
  channel: "whatsapp" | "sms",
  provider: "twilio" | "wati" | "simulated",
  providerResponseId: "SM-..."
}
```

Default provider is `simulated` (no real outbound call — perfect for CI). Set `MESSAGING_PROVIDER=twilio` (or `wati`) + add a 3-line `fetch` in `dispatchWebhook()` to go live.

---

## Retry / resilience policy

| Setting | Default | Per-task overrides |
|---|---|---|
| `maxAttempts` | 3 | `reconcile-gstr2b`: 2 · `dispatch-document-nudge`: 4 |
| `minTimeoutInMs` | 5 000 | `reconcile-gstr2b`: 2 000 · `dispatch-document-nudge`: 3 000 |
| `maxTimeoutInMs` | 60 000 | `reconcile-gstr2b`: 20 000 · `dispatch-document-nudge`: 30 000 |
| `factor` | 2 | — |
| `randomize` (jitter) | true | — |

Tuned for transient failures of Gemini / messaging APIs.

---

## Testing flows

### A. Local dashboard

```bash
npx trigger.dev@latest dev
```

Open the dashboard, pick any of the 5 tasks, paste a payload, hit **Run**.

### B. Programmatic trigger

```ts
import { tasks } from "@trigger.dev/sdk";

await tasks.trigger("parse-invoice", { imageUrl: "https://example.com/inv.png" });
await tasks.trigger("reconcile-gstr2b", { gstr2bRows: [...], purchaseRegisterRows: [...] });
await tasks.trigger("parse-bank-statement", { rawCsvText: "Date,Description,Debit\n..." });
await tasks.trigger("extract-capital-gains", {
  statementBase64: "data:application/pdf;base64,...",
  brokerName: "Zerodha",
});
await tasks.trigger("dispatch-document-nudge", {
  clientName: "Rohit",
  phoneNumber: "+919876543210",
  pendingDocumentType: "Form 16",
  dueDate: "2026-08-30",
});
```

### C. Bank-statement watcher prerequisites

Password-protected PDF bank statements are decrypted with [QPDF](https://qpdf.sourceforge.io/). Install it before running the standalone watcher locally, and make sure it is available on your `PATH`:

```bash
# macOS
brew install qpdf
```

Then run:

```bash
npx tsx src/inputs/bank-watcher.ts
```

The Trigger worker image installs QPDF during deployment. If the watcher reports `PDF_DECRYPTOR_UNAVAILABLE`, install QPDF locally; it does not mean that the supplied password is invalid.

### D. Deploy to Trigger.dev cloud

```bash
npx trigger.dev@latest deploy
```

Triggers then run in the cloud worker, not locally.

---

## Security

- `.env` is gitignored. Never commit `TRIGGER_SECRET_KEY` or `GEMINI_API_KEY`.
- Raw model outputs are logged **with errors only**, not the full PDF/PII bytes.
- Phone numbers are echoed in trace metadata (required for debugging) — strip before sharing externally if you handle sensitive clients.

---

## License

MIT
