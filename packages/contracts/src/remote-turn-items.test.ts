import { expect, it } from "vitest";
import { remoteTurnItems } from "./remote-turn-items.js";
const input = [
  { type: "text", text: "刚发送的内容" },
  { type: "localImage", path: "/tmp/image.png" },
];
it("shows confirmed turn input before activity while the user item is still missing", () => {
  const activity = { id: "working", type: "agentMessage", text: "正在处理" };
  const turn = {
    turnId: "turn",
    params: { input, clientUserMessageId: "sent" },
    items: [activity],
  };
  expect(remoteTurnItems(turn)).toEqual([
    { type: "userMessage", id: "remote-input:turn", clientId: "sent", content: input },
    activity,
  ]);
  expect(turn.items).toEqual([activity]);
});
it("uses the hydrated user item once and keeps later steering in place", () => {
  const user = { type: "userMessage", id: "real", clientId: "sent", content: input };
  const steer = { type: "userMessage", id: "later", clientId: "other", content: input };
  const activity = { id: "working", type: "agentMessage", text: "正在处理" };
  const turn = {
    turnId: "turn",
    params: { input, clientUserMessageId: "sent" },
    items: [activity, user, steer],
  };
  expect(remoteTurnItems(turn)).toEqual([user, activity, steer]);
  expect(remoteTurnItems({ ...turn, items: [activity, steer] })).toHaveLength(3);
});
it("leaves older turns and opening steering records intact", () => {
  const items = [
    { type: "steeringUserMessage", id: "steer", serverUserMessageId: "opening", input },
  ];
  expect(remoteTurnItems({ items })).toEqual(items);
  expect(
    remoteTurnItems({
      turnId: "turn",
      params: { input },
      items,
      itemsPagination: { openingUserMessageId: "opening" },
    }),
  ).toEqual(items);
});
