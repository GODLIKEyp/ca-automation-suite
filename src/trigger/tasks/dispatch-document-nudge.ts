import { task, logger } from "@trigger.dev/sdk/v3";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
export const dispatchNudgePayloadSchema = z.object({
  clientName: z.string().min(1),
  phoneNumber: z
    .string()
    .min(8)
    .regex(/^[+\d\s()-]+$/, "phoneNumber must be a valid E.164-ish string"),
  pendingDocumentType: z.string().min(1),
  dueDate: z.string().min(1),
});

export type DispatchNudgePayload = z.infer<typeof dispatchNudgePayloadSchema>;

export const dispatchNudgeOutputSchema = z.object({
  success: z.boolean(),
  recipient: z.string(),
  sentTimestamp: z.string(),
  messagePayload: z.string(),
  channel: z.enum(["whatsapp", "sms"]),
  provider: z.enum(["twilio", "wati", "simulated"]),
  providerResponseId: z.string().optional(),
});

export type DispatchNudgeOutput = z.infer<typeof dispatchNudgeOutputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatIndianDate(iso: string): string {
  // Accepts YYYY-MM-DD or anything Date can parse.
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function buildMessage(p: DispatchNudgePayload): string {
  const due = formatIndianDate(p.dueDate);
  return [
    `Namaste ${p.clientName},`,
    "",
    `This is a gentle reminder from your chartered accountant's office.`,
    `We still haven't received the following document from your end:`,
    `   📄 ${p.pendingDocumentType}`,
    "",
    `Please share it on or before ${due} so we can finalise your filings on time.`,
    "If you have already sent it, kindly ignore this message.",
    "",
    "Thank you,",
    "Your CA's Office",
  ].join("\n");
}

/**
 * Simulated webhook dispatch. In production, swap with a real `fetch` to
 * Twilio / Wati / Gupshup. We keep the body shape close to those APIs so
 * the swap is one-liner.
 */
async function dispatchWebhook(
  channel: "whatsapp" | "sms",
  provider: "twilio" | "wati",
  phone: string,
  message: string
): Promise<{ ok: boolean; providerResponseId: string }> {
  if (provider === "twilio") {
    // Real call would be:
    //   POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
    //   Authorization: Basic base64(SID:token)
    //   body: { To: phone, From: channel==='whatsapp' ? 'whatsapp:+14155238886' : '+1XXX', Body: message }
    logger.info("dispatch-nudge: simulated Twilio call", { phone, channel });
    return { ok: true, providerResponseId: `SM-sim-${Date.now()}` };
  }
  // Wati
  // POST https://live-server.wati.io/api/v1/sendSessionMessage/{phone}?messageText=...
  logger.info("dispatch-nudge: simulated Wati call", { phone, channel });
  return { ok: true, providerResponseId: `WATI-sim-${Date.now()}` };
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------
export const dispatchDocumentNudge = task({
  id: "dispatch-document-nudge",
  retry: {
    maxAttempts: 4,
    minTimeoutInMs: 3_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: DispatchNudgePayload): Promise<DispatchNudgeOutput> => {
    const safe = dispatchNudgePayloadSchema.parse(payload);
    logger.info("dispatch-document-nudge: start", {
      client: safe.clientName,
      phone: safe.phoneNumber,
    });

    const message = buildMessage(safe);

    // Pick provider from env, default to simulated Twilio.
    const providerEnv = (process.env.MESSAGING_PROVIDER ?? "twilio").toLowerCase();
    const provider: "twilio" | "wati" | "simulated" =
      providerEnv === "wati"
        ? "wati"
        : providerEnv === "twilio"
        ? "twilio"
        : "simulated";

    const channel: "whatsapp" | "sms" =
      (process.env.MESSAGING_CHANNEL ?? "whatsapp").toLowerCase() === "sms"
        ? "sms"
        : "whatsapp";

    const sentTimestamp = new Date().toISOString();

    if (provider === "simulated") {
      logger.info("dispatch-document-nudge: simulated webhook", {
        channel,
        provider,
        phone: safe.phoneNumber,
      });
      return dispatchNudgeOutputSchema.parse({
        success: true,
        recipient: safe.phoneNumber,
        sentTimestamp,
        messagePayload: message,
        channel,
        provider: "simulated",
        providerResponseId: `SIM-${Date.now()}`,
      });
    }

    const result = await dispatchWebhook(channel, provider, safe.phoneNumber, message);
    const output: DispatchNudgeOutput = {
      success: result.ok,
      recipient: safe.phoneNumber,
      sentTimestamp,
      messagePayload: message,
      channel,
      provider,
      providerResponseId: result.providerResponseId,
    };
    return dispatchNudgeOutputSchema.parse(output);
  },
});
