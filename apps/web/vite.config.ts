import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Existing development launch profiles can keep their old variable names.
const webPort = Number.parseInt(
  process.env.CODEXBOARD_WEB_PORT ??
    process.env.LARK_CODEX_WEB_PORT ??
    process.env.LARK_TASKBOARD_WEB_PORT ??
    "5173",
  10,
);
const apiProxyTarget =
  process.env.CODEXBOARD_WEB_API_TARGET ??
  process.env.CODEXBOARD_WEB_API_TARGET ??
  "http://127.0.0.1:47823";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@codexboard/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    maxWorkers: 2,
  },
});
