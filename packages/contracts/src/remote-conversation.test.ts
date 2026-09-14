import { expect, it } from "vitest";
import {
  remoteAsyncQuestions,
  remoteQuestionAnswers,
  remoteEditableTurn,
} from "./remote-conversation.js";
const question = {
  id: "call-1",
  type: "agentMessage",
  delivery: "async",
  text: "问题",
  questions: [{ title: "入口？", options: ["相册", "文件"] }, { title: "大小？" }],
};
it("matches Desktop question ids and keeps free-text questions", () => {
  expect(remoteAsyncQuestions(question)).toEqual([
    { id: '["request_user_input_async","call-1",0]', title: "入口？", options: ["相册", "文件"] },
    { id: '["request_user_input_async","call-1",1]', title: "大小？", options: [] },
  ]);
  expect(remoteAsyncQuestions({ ...question, questions: undefined })).toEqual([
    { id: "call-1", title: "问题", options: [] },
  ]);
});
it("only accepted replies to real question ids become answers across turns", () => {
  const id = remoteAsyncQuestions(question)[0]!.id;
  const reply = (status: string, answer: string) => ({
    type: "steeringUserMessage",
    status,
    input: [
      {
        type: "text",
        text:
          "<send_user_message_question_reply>\n" +
          JSON.stringify([{ questionItemId: id, question: "入口？", answer }]) +
          "\n</send_user_message_question_reply>",
      },
    ],
  });
  const state = {
    turns: [{ items: [question, reply("accepted", "相册"), reply("rejected", "wrong")] }],
  };
  expect(remoteQuestionAnswers(state).get(id)).toBe("相册");
});
it("offers only the latest real opening message when no turn is running", () => {
  const state = {
    turns: [
      {
        turnId: "a",
        status: "interrupted",
        params: {
          input: [
            { type: "text", text: "原消息" },
            { type: "localImage", path: "/image.png" },
          ],
        },
        items: [],
      },
    ],
  };
  expect(remoteEditableTurn(state)).toMatchObject({ turnId: "a", itemId: "remote-input:a" });
  expect(
    remoteEditableTurn({ turns: [...state.turns, { turnId: "b", status: "inProgress" }] }),
  ).toBeNull();
  expect(
    remoteEditableTurn({
      turns: [
        ...state.turns,
        { turnId: "b", params: { input: [{ type: "text", text: "新消息" }] } },
      ],
    }),
  ).toMatchObject({ turnId: "b" });
});
