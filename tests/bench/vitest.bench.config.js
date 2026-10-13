import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Phase D1 benchmark runner — deliberately separate from the test configs:
// include only *.bench.js so the normal suites (root tests/**/*.test.* and
// tests/**/*.test.*) never collect the benchmark.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.bench.js"],
    exclude: ["**/node_modules/**"],
    testTimeout: 120000,
    hookTimeout: 30000,
    silent: false,
  },
  resolve: {
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../../src") + "/" },
    ],
  },
});
