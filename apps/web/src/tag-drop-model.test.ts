import { describe, expect, it } from "vitest";

import { labelInsertionIndexAtY } from "./tag-drop-model";

describe("tag drop model", () => {
  it("uses only the vertical position and clamps outside the list to head or tail", () => {
    const rows = [
      { top: 100, height: 40 },
      { top: 143, height: 40 },
      { top: 186, height: 40 },
    ];
    const viewport = { top: 90, height: 156 };

    expect(labelInsertionIndexAtY(rows, -500, viewport)).toBe(0);
    expect(labelInsertionIndexAtY(rows, 119, viewport)).toBe(0);
    expect(labelInsertionIndexAtY(rows, 121, viewport)).toBe(1);
    expect(labelInsertionIndexAtY(rows, 164, viewport)).toBe(2);
    expect(labelInsertionIndexAtY(rows, 900, viewport)).toBe(3);
  });

  it("uses the scrolled list viewport for global head and tail insertion", () => {
    const rows = Array.from({ length: 24 }, (_, index) => ({
      top: -116 + index * 43,
      height: 40,
    }));
    const viewport = { top: 100, height: 120 };

    expect(labelInsertionIndexAtY(rows, 10, viewport)).toBe(0);
    expect(labelInsertionIndexAtY(rows, 170, viewport)).toBe(7);
    expect(labelInsertionIndexAtY(rows, 250, viewport)).toBe(24);
  });
});
