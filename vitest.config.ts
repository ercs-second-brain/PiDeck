import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve @agentskiss/shared straight to its TypeScript sources so a
    // fresh clone (`pnpm install && pnpm test`) never depends on
    // packages/shared/dist existing first (issue #136). The webapp's vite
    // config already aliases the same way.
    alias: {
      "@agentskiss/shared": fileURLToPath(
        new URL("./packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    // Only run tests from source directories; build outputs (dist/) contain
    // compiled copies of the same test files.
    exclude: ["**/node_modules/**", "**/dist/**", "**/cypress/**", "**/.{idea,git,cache,output,temp}/**"],
  },
});
