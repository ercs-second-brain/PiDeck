import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The shared package resolves straight to its TypeScript sources so the
 * webapp dev server and build never depend on `packages/shared/dist`
 * existing first. Types resolve the same way via `tsconfig.json` paths.
 */
const sharedAlias: Record<string, string> = {
  "@agentskiss/shared": fileURLToPath(
    new URL("../../packages/shared/src/index.ts", import.meta.url),
  ),
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: sharedAlias,
  },
  build: {
    // Static output the daemon will serve (wired up in issue #9).
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
