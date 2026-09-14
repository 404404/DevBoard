import { defineConfig, devices } from "@playwright/test";

const publicPort = Number.parseInt(process.env.LARK_CODEX_PORT ?? "47823", 10);
const webPort = Number.parseInt(process.env.LARK_CODEX_WEB_PORT ?? "5173", 10);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "iphone-webkit",
      testMatch: [
        "remote-composer.spec.ts",
        "remote-conversation-actions.spec.ts",
        "remote-navigation.spec.ts",
        "remote-approvals.spec.ts",
        "remote-turn-diff.spec.ts",
        "remote-review.spec.ts",
        "remote-controls.spec.ts",
        "remote-recovery.spec.ts",
        "board-error-notice.spec.ts",
        "remote-notice.spec.ts",
        "remote-pull-refresh.spec.ts",
      ],
      use: { ...devices["iPhone 13"] },
    },
  ],
  webServer: [
    {
      command: "npm run build -w @lark-codex/contracts && npx tsx apps/server/src/main.ts",
      url: `http://127.0.0.1:${publicPort}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npm run dev:web",
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
