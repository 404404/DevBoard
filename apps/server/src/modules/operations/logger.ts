import type { Writable } from "node:stream";

import type { LogLevel } from "../../config.js";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-taskctl-session']",
  "req.body.claimSecret",
  "req.headers['x-csrf-token']",
  "req.headers['x-runtime-capability']",
  "res.headers['set-cookie']",
  "authorization",
  "cookie",
  "csrfToken",
  "claimSecret",
  "capabilityToken",
  "appSecret",
  "tunnelToken",
  "token",
  "secret",
] as const;

export function createLoggerOptions(
  level: LogLevel,
  component: "public-http" | "local-admin",
  stream?: Writable,
) {
  return {
    level,
    base: { component },
    redact: { paths: [...REDACT_PATHS], censor: "[REDACTED]" },
    ...(stream ? { stream } : {}),
  };
}
