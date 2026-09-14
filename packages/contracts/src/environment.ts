/** Normalize the legacy brand only at environment boundaries, without changing
 * the caller's object. A configured new value (including an empty string) wins. */
export function normalizeLarkCodexEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const normalized = { ...environment };
  for (const [key, value] of Object.entries(environment)) {
    if (!key.startsWith("LARK_TASKBOARD_")) continue;
    const current = `LARK_CODEX_${key.slice("LARK_TASKBOARD_".length)}`;
    if (normalized[current] === undefined) normalized[current] = value;
    delete normalized[key];
  }
  return normalized;
}
