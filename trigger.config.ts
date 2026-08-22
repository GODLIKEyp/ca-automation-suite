import { aptGet } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_azdmbbttjmferpnbhgxt",
  dirs: ["./src/trigger"],
  runtime: "node",
  maxDuration: 300,
  build: {
    extensions: [aptGet({ packages: ["qpdf"] })],
  },
});