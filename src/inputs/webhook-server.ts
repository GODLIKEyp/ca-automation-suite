import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { tasks } from "@trigger.dev/sdk";

// ---------------------------------------------------------------------------
// Webhook payload schema
// Must match parse-invoice.ts input
// ---------------------------------------------------------------------------
const webhookPayloadSchema = z.object({
  imageUrl: z.string().url().optional(),
  base64Data: z.string().optional(),
  filename: z.string().optional(),
}).refine(
  (data) => data.imageUrl || data.base64Data,
  {
    message: "Either imageUrl or base64Data is required.",
  }
);

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------
const app = new Hono();

// Health check
app.get("/", (c) => {
  return c.json({
    success: true,
    message: "CA Automation Suite webhook server is running",
  });
});

// ---------------------------------------------------------------------------
// Invoice webhook
// ---------------------------------------------------------------------------
app.post("/webhook/invoice", async (c) => {
  try {
    const body = await c.req.json();

    const payload = webhookPayloadSchema.parse(body);

    console.log("📥 Invoice received:", {
      filename: payload.filename,
      hasImageUrl: !!payload.imageUrl,
      hasBase64Data: !!payload.base64Data,
    });

    // Trigger existing Trigger.dev task
    const handle = await tasks.trigger("parse-invoice", {
      imageUrl: payload.imageUrl,
      base64Data: payload.base64Data,
      filename: payload.filename,
    });

    console.log("⚡ parse-invoice triggered:", handle.id);

    return c.json({
      success: true,
      message: "Invoice processing started",
      runId: handle.id,
    });
  } catch (error) {
    console.error("❌ Webhook error:", error);

    if (error instanceof z.ZodError) {
      return c.json(
        {
          success: false,
          error: "Invalid webhook payload",
          details: error.errors,
        },
        400
      );
    }

    return c.json(
      {
        success: false,
        error: "Failed to process invoice",
      },
      500
    );
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const port = Number(process.env.PORT ?? 3001);

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`🚀 Webhook server running on http://localhost:${info.port}`);
    console.log(`📄 Invoice endpoint: POST http://localhost:${info.port}/webhook/invoice`);
  }
);