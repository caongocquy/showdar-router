import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${resolve(repoRoot, "src")}/` },
      { find: /^open-sse\//, replacement: `${resolve(repoRoot, "open-sse")}/` },
      { find: "open-sse", replacement: resolve(repoRoot, "open-sse") },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{js,mjs}"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/build/**"],
  },
});
