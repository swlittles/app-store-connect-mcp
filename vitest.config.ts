import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["test/setup.ts"],
    exclude: ["node_modules", "dist", process.env.ASC_LIVE_TEST ? "" : "test/live/**"].filter(Boolean),
  },
});
