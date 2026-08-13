import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_ca_automation_suite",
  dirs: ["./src/trigger"],
  runtime: "node",
  machine: "small-1x",
  retries: {
    // Default retry policy applied to every task unless overridden.
    // Tuned for external API resilience (Gemini Vision, Twilio, etc.).
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 5_000,
      maxTimeoutInMs: 60_000,
      factor: 2,
      randomize: true,
    },
  },
  build: {
    autoDetectAliases: true,
    keepNames: true,
  },
});
