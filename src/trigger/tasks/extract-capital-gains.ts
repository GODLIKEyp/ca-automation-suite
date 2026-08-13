import { task, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import { extractResponseText, getGenaiClient } from "../lib/gemini";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
export const tradeSchema = z.object({
  symbol: z.string().default(""),
  buyDate: z.string().default(""),
  sellDate: z.string().default(""),
  netProfitLoss: z.number().default(0),
});

export const capitalGainsOutputSchema = z.object({
  shortTermCapitalGains: z.number().default(0),
  longTermCapitalGains: z.number().default(0),
  totalDividends: z.number().default(0),
  trades: z.array(tradeSchema).default([]),
});

export type CapitalGainsOutput = z.infer<typeof capitalGainsOutputSchema>;

export const extractCapitalGainsPayloadSchema = z.object({
  statementBase64: z.string().min(1),
  brokerName: z.string().min(1),
});

export type ExtractCapitalGainsPayload = z.infer<typeof extractCapitalGainsPayloadSchema>;

// ---------------------------------------------------------------------------
// Broker-specific prompt hints
// ---------------------------------------------------------------------------
function brokerHint(broker: string): string {
  const b = broker.toLowerCase();
  if (b.includes("zerodha")) {
    return "This is a Zerodha Console P&L statement. It contains sections for Equity, F&O, and Commodity. Each trade row includes Symbol, Buy Date, Sell Date, Qty, Buy Value, Sell Value, Realised P&L. Sum STCG (equity held <12 months) and LTCG (held ≥12 months) separately. Include equity dividends in totalDividends.";
  }
  if (b.includes("groww")) {
    return "This is a Groww Capital Gains statement. Trades list Symbol, Buy Date, Sell Date, Holding Period, Profit/Loss. STCG = held ≤12 months, LTCG = held >12 months. Dividend income is reported in a separate section.";
  }
  if (b.includes("upstox")) {
    return "This is an Upstox P&L report. Trades include Symbol, Buy Date, Sell Date, Quantity, Buy Price, Sell Price, and Realised P&L. Equity STCG (held <12 months) and LTCG (held ≥12 months) are reported. Dividends may be in a separate section.";
  }
  return `This is a ${broker} broker capital gains statement. Extract trades and classify gains by holding period.`;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------
export const extractCapitalGains = task({
  id: "extract-capital-gains",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
    randomize: true,
  },
  run: async (
    payload: ExtractCapitalGainsPayload
  ): Promise<CapitalGainsOutput> => {
    const safe = extractCapitalGainsPayloadSchema.parse(payload);
    logger.info("extract-capital-gains: start", {
      broker: safe.brokerName,
      hasBase64: !!safe.statementBase64,
    });

    const base64 = safe.statementBase64.replace(/^data:[^;]+;base64,/, "");
    const hint = brokerHint(safe.brokerName);

    const prompt = `You are an expert tax-parsing assistant for Indian brokers.
${hint}

From the attached PDF/image, extract:
  1. All closed trades (symbol, buyDate ISO-8601, sellDate ISO-8601, netProfitLoss as a number).
  2. Total realised short-term capital gains (held ≤ 12 months).
  3. Total realised long-term capital gains (held > 12 months).
  4. Total dividends received during the period.

Return ONLY JSON matching the schema below — no markdown, no commentary.

JSON SCHEMA:
{
  "shortTermCapitalGains": number,
  "longTermCapitalGains": number,
  "totalDividends": number,
  "trades": [
    { "symbol": "string", "buyDate": "YYYY-MM-DD", "sellDate": "YYYY-MM-DD", "netProfitLoss": number }
  ]
}`;

    const genai = getGenaiClient();
    const response = await genai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { data: base64, mimeType: "application/pdf" } },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        temperature: 0.1,
        topP: 0.8,
      },
    });

    const text = extractResponseText(response);
    if (!text) {
      throw new Error("extract-capital-gains: Gemini returned empty response.");
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch (err) {
      logger.error("extract-capital-gains: non-JSON output", {
        text,
        err: String(err),
      });
      throw new Error("extract-capital-gains: model output failed JSON.parse.");
    }

    const validated = capitalGainsOutputSchema.parse(parsedJson);

    // Server-side sanity check: sum of trade-level P&L should match combined STCG + LTCG within tolerance.
    const tradeSum = validated.trades.reduce(
      (acc, t) => acc + (Number(t.netProfitLoss) || 0),
      0
    );
    const totals = validated.shortTermCapitalGains + validated.longTermCapitalGains;
    const drift = Math.abs(tradeSum - totals);
    if (drift > 1.0) {
      logger.warn("extract-capital-gains: trade sum vs totals drift", {
        tradeSum,
        totals,
        drift,
      });
    }

    logger.info("extract-capital-gains: complete", {
      trades: validated.trades.length,
      stcg: validated.shortTermCapitalGains,
      ltcg: validated.longTermCapitalGains,
      dividends: validated.totalDividends,
    });
    return validated;
  },
});
