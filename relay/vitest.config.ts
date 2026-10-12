import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { SINGLE_BROWSER_ENABLED: "false" } },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
  },
});
