import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TaskBranchProperty } from "./task-branch-property";

it.each([true, false])("renders a branch picker only when writable=%s", (writable) => {
  const html = renderToStaticMarkup(
    <TaskBranchProperty
      value=""
      label="main"
      writable={writable}
      options={[{ value: "", label: "main" }]}
      onChange={() => {}}
    />,
  );
  expect(html.includes('aria-haspopup="listbox"')).toBe(writable);
  expect(html.includes("<button")).toBe(writable);
  expect(html).toContain("main");
});
