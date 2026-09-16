import { expect, it } from "vitest";
import { desktopUserEvent } from "../src/modules/execution/desktop-user-events.js";

it("uses a stable message key for steering and canonical copies", () => {
  const content = [{ type: "text", text: "补充" }];
  const steering = desktopUserEvent(
    {
      type: "steeringUserMessage",
      id: "steer",
      clientUserMessageId: "client",
      status: "accepted",
      content,
    },
    "thread",
  );
  const canonical = desktopUserEvent(
    { type: "userMessage", id: "user", clientId: "client", content },
    "thread",
  );
  expect(steering?.cursor).toBe(canonical?.cursor);
  expect(steering?.safePayload?.text).toBe("补充");
});
it("does not import rejected, empty, or non-user messages", () => {
  for (const raw of [
    null,
    { id: "x", type: "userMessage", content: [] },
    {
      id: "x",
      type: "steeringUserMessage",
      status: "rejected",
      input: [{ type: "text", text: "not sent" }],
    },
    { id: "x", type: "agentMessage", text: "not user" },
  ])
    expect(desktopUserEvent(raw, "thread")).toBeNull();
});
it("preserves user images through authenticated routes without exposing local file paths", () => {
  const result = desktopUserEvent(
    {
      type: "userMessage",
      id: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "localImage", path: "/private/picture.png" },
      ],
    },
    "thread",
  );
  expect(result?.safePayload?.text).toBe(
    "看图\n![图片 1](/api/v1/remote/threads/thread/images/user/0)",
  );
});
