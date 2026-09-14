import { expect, it } from "vitest";
import { highlightReviewLine } from "./remote-review-highlight";
it("escapes code before applying syntax spans and leaves unsupported languages as text", () => {
  const html = highlightReviewLine('const image = "<img src=x onerror=alert(1)>";', "app.ts");
  expect(html).toContain("hljs-keyword");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(highlightReviewLine("<script>text</script>", "plain.txt")).toBeNull();
});
