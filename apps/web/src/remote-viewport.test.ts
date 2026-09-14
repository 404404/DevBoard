import { describe, expect, it } from "vitest";

import { fitRemoteViewport } from "./remote-viewport";

describe("fitRemoteViewport", () => {
  it("reserves the warning row from a full-height visual viewport", () => {
    expect(fitRemoteViewport({ top: 44, bottom: 844 }, { offsetTop: 0, height: 844 })).toEqual({
      top: 0,
      fixedTop: 44,
      height: 800,
    });
  });

  it("limits the remote page to the visible area above an on-screen keyboard", () => {
    expect(fitRemoteViewport({ top: 44, bottom: 844 }, { offsetTop: 0, height: 500 })).toEqual({
      top: 0,
      fixedTop: 44,
      height: 456,
    });
  });

  it("positions the remote page inside a panned Safari visual viewport", () => {
    expect(fitRemoteViewport({ top: 44, bottom: 844 }, { offsetTop: 120, height: 500 })).toEqual({
      top: 76,
      fixedTop: 120,
      height: 500,
    });
  });
});

describe("keyboard viewport transitions", () => {
  it("ignores stale panning after the WebView has resized its layout", () => {
    expect(fitRemoteViewport({ top: 0, bottom: 430 }, { offsetTop: 320, height: 430 })).toEqual({
      top: 0,
      fixedTop: 0,
      height: 430,
    });
  });

  it("clamps transient overshoot without collapsing the visible content", () => {
    expect(fitRemoteViewport({ top: 0, bottom: 844 }, { offsetTop: 600, height: 500 })).toEqual({
      top: 344,
      fixedTop: 344,
      height: 500,
    });
  });

  it("preserves the top inset when the keyboard viewport reports an old height", () => {
    expect(fitRemoteViewport({ top: 44, bottom: 430 }, { offsetTop: 320, height: 844 })).toEqual({
      top: 0,
      fixedTop: 44,
      height: 386,
    });
  });
});
