import { describe, expect, it } from "vitest";

import {
  appendAttachmentFiles,
  attachmentFileExtension,
  fitDialogRectToContent,
  isCompactTaskDialogViewport,
  maximizeDialogRect,
  moveItemToInsertionIndex,
  filterTaskRelationCandidates,
  relationCandidateState,
  selectedLabelNamesInCatalogOrder,
  toggleSelectedLabelId,
  priorityBarStates,
  resizeDialogRect,
} from "./task-create-model";

describe("task creation interaction model", () => {
  it("resizes from every edge while preserving viewport and minimum bounds", () => {
    const start = { left: 200, top: 160, width: 704, height: 304 };
    const bounds = { width: 1200, height: 800, padding: 32, minWidth: 560, minHeight: 300 };

    const everyDirection = [
      ["n", 0, -40, { left: 200, top: 120, width: 704, height: 344 }],
      ["s", 0, 40, { left: 200, top: 160, width: 704, height: 344 }],
      ["e", 40, 0, { left: 200, top: 160, width: 744, height: 304 }],
      ["w", -40, 0, { left: 160, top: 160, width: 744, height: 304 }],
      ["ne", 40, -40, { left: 200, top: 120, width: 744, height: 344 }],
      ["nw", -40, -40, { left: 160, top: 120, width: 744, height: 344 }],
      ["se", 40, 40, { left: 200, top: 160, width: 744, height: 344 }],
      ["sw", -40, 40, { left: 160, top: 160, width: 744, height: 344 }],
    ] as const;
    for (const [edge, deltaX, deltaY, expected] of everyDirection) {
      expect(resizeDialogRect(start, edge, deltaX, deltaY, bounds)).toEqual(expected);
    }

    expect(resizeDialogRect(start, "e", 120, 0, bounds)).toEqual({
      left: 200,
      top: 160,
      width: 824,
      height: 304,
    });
    expect(resizeDialogRect(start, "nw", -500, -500, bounds)).toEqual({
      left: 32,
      top: 32,
      width: 872,
      height: 432,
    });
    expect(resizeDialogRect(start, "w", 400, 0, bounds)).toEqual({
      left: 344,
      top: 160,
      width: 560,
      height: 304,
    });
    expect(resizeDialogRect(start, "se", 900, 900, bounds)).toEqual({
      left: 200,
      top: 160,
      width: 968,
      height: 608,
    });
  });

  it("maximizes inside the safe viewport and leaves the custom rectangle unchanged", () => {
    const custom = { left: 240, top: 180, width: 704, height: 304 };
    expect(maximizeDialogRect({ width: 1440, height: 900, padding: 32 })).toEqual({
      left: 32,
      top: 32,
      width: 1376,
      height: 836,
    });
    expect(custom).toEqual({ left: 240, top: 180, width: 704, height: 304 });
  });

  it("fits dynamic content above the manual height baseline without leaving the viewport", () => {
    const baseline = { left: 300, top: 200, width: 704, height: 304 };
    const bounds = { width: 1440, height: 900, padding: 32 };

    expect(fitDialogRectToContent(baseline, 392, bounds)).toEqual({
      left: 300,
      top: 200,
      width: 704,
      height: 392,
    });
    expect(fitDialogRectToContent(baseline, 280, bounds)).toEqual(baseline);
    expect(
      fitDialogRectToContent({ left: 300, top: 500, width: 704, height: 360 }, 480, bounds),
    ).toEqual({ left: 300, top: 388, width: 704, height: 480 });
    expect(fitDialogRectToContent(baseline, 1_000, bounds)).toEqual({
      left: 300,
      top: 32,
      width: 704,
      height: 836,
    });
  });

  it("appends later file selections while rejecting every oversized file independently", () => {
    const first = { name: "first.txt", size: 100, type: "text/plain" };
    const second = { name: "second.png", size: 200, type: "image/png" };
    const tooLarge = { name: "huge.zip", size: 1_001, type: "application/zip" };

    const result = appendAttachmentFiles([first], [second, tooLarge], 1_000);
    expect(result.accepted).toEqual([first, second]);
    expect(result.rejected).toEqual([{ file: tooLarge, reason: "文件超过 1000 B 上限" }]);
  });

  it("moves a label across several positions only when the drop index is committed", () => {
    const labels = ["a", "b", "c", "d"];
    expect(moveItemToInsertionIndex(labels, "a", 4)).toEqual(["b", "c", "d", "a"]);
    expect(moveItemToInsertionIndex(labels, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(labels).toEqual(["a", "b", "c", "d"]);
  });

  it("lights priority bars from the shortest side with a stable three-bar model", () => {
    expect(priorityBarStates("high")).toEqual([true, true, true]);
    expect(priorityBarStates("medium")).toEqual([true, true, false]);
    expect(priorityBarStates("low")).toEqual([true, false, false]);
    expect(priorityBarStates("none")).toEqual([false, false, false]);
  });

  it("uses fullscreen layout for narrow or short viewports", () => {
    expect(isCompactTaskDialogViewport({ width: 390, height: 844 })).toBe(true);
    expect(isCompactTaskDialogViewport({ width: 844, height: 390 })).toBe(true);
    expect(isCompactTaskDialogViewport({ width: 1280, height: 800 })).toBe(false);
  });

  it("shows a safe short extension for non-image attachment thumbnails", () => {
    expect(attachmentFileExtension("brief.txt")).toBe("TXT");
    expect(attachmentFileExtension("archive.tar.gz")).toBe("GZ");
    expect(attachmentFileExtension("README")).toBe("FILE");
    expect(attachmentFileExtension("payload.reallylongextension")).toBe("REALL");
  });

  it("maps selected label ids to the current global catalog order and names", () => {
    const catalog = [
      { id: "b", name: "开发" },
      { id: "a", name: "产品" },
      { id: "c", name: "验收" },
    ];
    expect(selectedLabelNamesInCatalogOrder(catalog, ["c", "missing", "b"])).toEqual([
      "开发",
      "验收",
    ]);
  });

  it("keeps label selection unique and enforces the task contract limit", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `label-${String(index)}`);
    expect(toggleSelectedLabelId(twenty, "label-20")).toEqual(twenty);
    expect(toggleSelectedLabelId(twenty, "label-0")).toEqual(twenty.slice(1));
    expect(toggleSelectedLabelId(["label-1"], "label-2")).toEqual(["label-1", "label-2"]);
  });

  it("filters current-project relation candidates by identifier or title", () => {
    const candidates = [
      { id: "1", identifier: "TASK-001", title: "修复登录问题" },
      { id: "2", identifier: "TASK-002", title: "Prepare release" },
      { id: "3", identifier: "OPS-003", title: "排查部署失败" },
    ];

    expect(filterTaskRelationCandidates(candidates, "task-002")).toEqual([candidates[1]]);
    expect(filterTaskRelationCandidates(candidates, " 部署 ")).toEqual([candidates[2]]);
    expect(filterTaskRelationCandidates(candidates, "RELEASE")).toEqual([candidates[1]]);
    expect(filterTaskRelationCandidates(candidates, "")).toEqual(candidates);
  });

  it("keeps the selected parent or child removable while disabling conflicting candidates", () => {
    const selection = {
      parentTaskId: "task-a",
      childTaskIds: ["task-b"],
      relatedTaskIds: ["task-c"],
    };

    expect(relationCandidateState("parent", "task-a", selection)).toEqual({
      selected: true,
      disabled: false,
    });
    expect(relationCandidateState("parent", "task-d", selection)).toEqual({
      selected: false,
      disabled: true,
    });
    expect(relationCandidateState("child", "task-b", selection)).toEqual({
      selected: true,
      disabled: false,
    });
    expect(relationCandidateState("child", "task-d", selection)).toEqual({
      selected: false,
      disabled: false,
    });
    expect(relationCandidateState("child", "task-a", selection)).toEqual({
      selected: false,
      disabled: true,
    });
  });

  it("allows related tasks to accumulate and selected related tasks to be removed", () => {
    const selection = {
      parentTaskId: "task-a",
      childTaskIds: ["task-b"],
      relatedTaskIds: ["task-c"],
    };

    expect(relationCandidateState("related", "task-c", selection)).toEqual({
      selected: true,
      disabled: false,
    });
    expect(relationCandidateState("related", "task-d", selection)).toEqual({
      selected: false,
      disabled: false,
    });
    expect(relationCandidateState("related", "task-a", selection)).toEqual({
      selected: false,
      disabled: true,
    });
  });
});
