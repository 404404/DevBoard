export interface VerticalRect {
  readonly top: number;
  readonly height: number;
}

export function labelInsertionIndexAtY(
  rows: readonly VerticalRect[],
  centerY: number,
  viewport: VerticalRect,
): number {
  if (centerY < viewport.top) return 0;
  if (centerY > viewport.top + viewport.height) return rows.length;
  const firstAfterPointer = rows.findIndex((row) => centerY < row.top + row.height / 2);
  return firstAfterPointer < 0 ? rows.length : firstAfterPointer;
}
