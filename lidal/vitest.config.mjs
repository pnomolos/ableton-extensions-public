import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/spec/**/*.test.mjs"],
    globals: false,
    environment: "node",
  },
});
