/** Preserve existing browser preferences while writing only the current brand. */
export function readLarkCodexStorage(
  storage: Pick<Storage, "getItem">,
  key: string,
): string | null {
  return storage.getItem(`lark-codex:${key}`) ?? storage.getItem(`lark-taskboard:${key}`);
}
