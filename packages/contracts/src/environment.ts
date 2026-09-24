/** Translate published configuration keys only at the input boundary.
 * Current values, including empty strings, always win. Never mutate the caller. */
export function normalizeCodexBoardEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const normalized = { ...environment };
  for (const [published, internal] of [
    ["DEVBOARD_PUBLIC_ORIGIN", "CODEXBOARD_ORIGIN"],
    ["DEVBOARD_TRUST_PROXY", "CODEXBOARD_TRUST_PROXY"],
    ["DEVBOARD_DATA_DIR", "CODEXBOARD_DATA_DIR"],
    ["DEVBOARD_SSH_IDENTITY_DIR", "CODEXBOARD_SSH_IDENTITY_DIR"],
    ["DEVBOARD_HOST", "CODEXBOARD_HOST"],
    ["DEVBOARD_PORT", "CODEXBOARD_PORT"],
  ] as const) {
    if (normalized[internal] === undefined && environment[published] !== undefined) {
      normalized[internal] = environment[published];
    }
    delete normalized[published];
  }
  for (const prefix of ["LARK_CODEX_", "LARK_TASKBOARD_"]) {
    for (const [key, value] of Object.entries(environment)) {
      if (!key.startsWith(prefix)) continue;
      const current = `CODEXBOARD_${key.slice(prefix.length)}`;
      if (normalized[current] === undefined) normalized[current] = value;
      delete normalized[key];
    }
  }
  return normalized;
}
