import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SF_SYMBOL_SIZES } from "./sf-symbol-names";
import { SfSymbol } from "./sf-symbol";

describe("SfSymbol", () => {
  it.each(SF_SYMBOL_SIZES)("renders the supported %ipx size", (size) => {
    const html = renderToStaticMarkup(createElement(SfSymbol, { name: "magnifyingglass", size }));

    expect(html).toContain(`--sf-symbol-size:${size}px`);
    expect(html).toContain("background-color:currentColor");
  });

  it("is decorative unless an accessible label is supplied", () => {
    const decorative = renderToStaticMarkup(createElement(SfSymbol, { name: "magnifyingglass" }));
    const labelled = renderToStaticMarkup(
      createElement(SfSymbol, { name: "trash", label: "彻底删除任务" }),
    );

    expect(decorative).toContain('aria-hidden="true"');
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="彻底删除任务"');
    expect(labelled).not.toContain('aria-hidden="true"');
  });

  it("renders the review eye symbol", () => {
    const html = renderToStaticMarkup(createElement(SfSymbol, { name: "eye" }));
    expect(html).toContain("eye.png");
  });
});
