import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run tests from source directories; build outputs (dist/) contain
    // compiled copies of the same test files.
    exclude: ["**/node_modules/**", "**/dist/**", "**/cypress/**", "**/.{idea,git,cache,output,temp}/**"],
  },
});
