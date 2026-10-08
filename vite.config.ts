import { defineConfig } from "vitest/config";
export default defineConfig({
  root: "frontend",
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
  test: { include: ["../tests/**/*.test.ts"] },
});
