import { expect, it } from "vitest";
import { defaultRemotePresets, readComposerOptions } from "./remote-composer-model";
it("uses Astra medium for empty or corrupt saved preferences", () => {
  for (const saved of [null, "{}", "broken", "null"])
    expect(readComposerOptions(saved)).toMatchObject({
      model: "gpt-6-astra",
      effort: "medium",
      selectionMode: "default",
      serviceTier: null,
    });
});
it("keeps explicit selections from the previous preference format", () => {
  expect(
    readComposerOptions(JSON.stringify({ model: "other", effort: "high", approvalMode: "ask" })),
  ).toMatchObject({ model: "other", effort: "high", selectionMode: "model", approvalMode: "ask" });
  expect(
    readComposerOptions(
      JSON.stringify({
        model: "gpt-6-astra",
        effort: "high",
        serviceTier: "priority",
        selectionMode: "model",
      }),
    ),
  ).toMatchObject({ selectionMode: "model", serviceTier: "priority" });
});

it("uses the Desktop six-step recommendation order and excludes unsupported combinations", () => {
  const models = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"].map((id) => ({
    id,
    name: id,
    efforts: ["low", "medium", "high", "xhigh", "ultra"],
    defaultEffort: "medium",
    serviceTiers: [],
  }));
  expect(defaultRemotePresets(models)).toEqual([
    { model: "gpt-5.6-terra", effort: "low" },
    { model: "gpt-5.6-sol", effort: "low" },
    { model: "gpt-5.6-sol", effort: "medium" },
    { model: "gpt-6-astra", effort: "low" },
    { model: "gpt-6-astra", effort: "medium" },
    { model: "gpt-6-astra", effort: "xhigh" },
  ]);
  expect(defaultRemotePresets([{ ...models[0]!, efforts: ["medium"] }])).toEqual([
    { model: "gpt-6-astra", effort: "medium" },
  ]);
});
