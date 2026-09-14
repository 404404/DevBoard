import { expect, it } from "vitest";
import { desktopRemoteView } from "../src/modules/codex/remote-view.js";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
it("projects asynchronous questions and keeps answered state from Desktop replies", () => {
  const qid = '["request_user_input_async","question",0]';
  const view = desktopRemoteView({
    id,
    turns: [
      {
        turnId: "one",
        status: "completed",
        items: [
          {
            id: "question",
            type: "agentMessage",
            delivery: "async",
            text: "请提供入口",
            questions: [{ title: "入口？", options: ["相册", "文件"] }],
          },
          {
            id: "reply",
            type: "steeringUserMessage",
            status: "accepted",
            input: [
              {
                type: "text",
                text:
                  "<send_user_message_question_reply>\n" +
                  JSON.stringify([{ questionItemId: qid, question: "入口？", answer: "相册" }]) +
                  "\n</send_user_message_question_reply>",
              },
            ],
          },
        ],
      },
    ],
  });
  expect(view.turns[0]!.items[0]!.asyncQuestions).toEqual([
    { id: qid, title: "入口？", options: ["相册", "文件"], answer: "相册" },
  ]);
  expect(view.turns[0]!.items[1]!.text).toBe("入口？\n相册");
  expect(JSON.stringify(view)).not.toContain("send_user_message_question_reply");
});
it("publishes a fingerprint only for the latest editable message without leaking its raw input", () => {
  const view = desktopRemoteView({
    id,
    turns: [
      {
        turnId: "stopped",
        status: "interrupted",
        params: {
          input: [
            { type: "text", text: "改这里" },
            { type: "localImage", path: "/private/image.png" },
          ],
        },
        items: [],
      },
    ],
  });
  expect(view.editableMessage).toMatchObject({
    turnId: "stopped",
    itemId: "remote-input:stopped",
    token: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(JSON.stringify(view)).not.toContain("/private/image.png");
});
