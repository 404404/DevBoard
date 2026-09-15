/** Preserve existing browser preferences while writing only the current brand. */
export function readCodexBoardStorage(
  storage: Pick<Storage, "getItem">,
  key: string,
): string | null {
  return (
    storage.getItem(`codexboard:${key}`) ??
    storage.getItem(`lark-codex:${key}`) ??
    storage.getItem(`lark-taskboard:${key}`)
  );
}
