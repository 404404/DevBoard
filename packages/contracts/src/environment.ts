/** Translate published configuration keys only at the input boundary.
 * Current values, including empty strings, always win. Never mutate the caller. */
export function normalizeCodexBoardEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const normalized = { ...environment };
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
