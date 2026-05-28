import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Vitest — Layer A (pure-fn goldens, node env) + Layer B (state-machine /
// interaction tests with a hand-rolled chrome.* mock, jsdom env). No browser.*
// polyfill anywhere. DOM-dependent specs opt in with `// @vitest-environment jsdom`.
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve("src"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
