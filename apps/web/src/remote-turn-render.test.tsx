import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { RemoteThread } from "@codexboard/contracts";
import { RemoteTurnContent } from "./remote-turn";
import { splitRemoteTurn } from "./remote-turn-model";

type Turn = RemoteThread["turns"][number];
const question: Turn["items"][number] = {
  id: "question",
  type: "agentMessage",
  text: "Which repository?",
  detail: "",
  asyncQuestions: [{ id: "q", title: "Which repository?", options: [], answer: "repo" }],
};
const progress = {
  id: "progress",
  type: "agentMessage",
  phase: "commentary",
  text: "Following up",
  detail: "",
};
const final = {
  id: "final",
  type: "agentMessage",
  phase: "final_answer",
  text: "Done",
  detail: "",
};
const turn: Turn = {
  id: "turn",
  status: "inProgress",
  diff: "diff content received before completion",
  error: "",
  items: [question, progress],
};
function render(value: Turn, showActivityStatus = true) {
  return renderToStaticMarkup(
    <RemoteTurnContent
      turn={value}
      showActivityStatus={showActivityStatus}
      changes={<aside>review-diff</aside>}
      renderItem={(item, _action, after) => (
        <article key={item.id} data-item={item.id}>
          {item.text}
          {after}
        </article>
      )}
    />,
  );
}

it.each([false, true])(
  "hides an in-progress diff even with a final answer (final=%s)",
  (hasFinal) => {
    const value = { ...turn, items: hasFinal ? [...turn.items, final] : turn.items };
    expect(render(value)).not.toContain("review-diff");
    // Waiting for input suppresses the activity indicator, not the running state.
    expect(render(value, false)).not.toContain("review-diff");
    const completed = render({ ...value, status: "completed" });
    expect(completed.match(/review-diff/g)).toHaveLength(1);
    expect(completed.indexOf("review-diff")).toBeGreaterThan(completed.indexOf("Following up"));
  },
);
it.each(["interrupted", "failed"])("retains review access after a turn ends as %s", (status) => {
  expect(render({ ...turn, status })).toContain("review-diff");
});
it("does not treat an unknown status as a completed turn", () => {
  expect(render({ ...turn, status: "" })).not.toContain("review-diff");
});
it.each(["inProgress", "completed"])(
  "returns answered questions to chronological progress (%s)",
  (status) => {
    const value = { ...turn, status, items: [question, progress, final] };
    const parts = splitRemoteTurn(value);
    expect(parts.progress.map((i) => i.id)).toEqual(["question", "progress"]);
    expect(parts.final.map((i) => i.id)).toEqual(["final"]);
    const html = render(value);
    expect(html.indexOf('data-item="question"')).toBeLessThan(html.indexOf('data-item="progress"'));
    expect(html.match(/data-item="question"/g)).toHaveLength(1);
  },
);
it("keeps partially answered questions accessible until every question is answered", () => {
  const pending = {
    ...question,
    asyncQuestions: [
      ...question.asyncQuestions!,
      { id: "q2", title: "Which branch?", options: [], answer: null },
    ],
  };
  const parts = splitRemoteTurn({ ...turn, items: [pending, progress] });
  expect(parts.progress.map((i) => i.id)).toEqual(["progress"]);
  expect(parts.final.map((i) => i.id)).toEqual(["question"]);
});
it("keeps answered questions visible when an interrupted turn is reloaded", () => {
  const html = render({ ...turn, status: "interrupted", items: [question] });
  expect(html).toContain('<details class="remote-progress" open="">');
});
it("never promotes answered questions through legacy or explicit final-answer detection", () => {
  for (const phase of [undefined, "final_answer"]) {
    const parts = splitRemoteTurn({
      ...turn,
      status: "completed",
      items: [
        { ...final, phase: undefined },
        { ...question, phase },
      ],
    });
    expect(parts.final.map((i) => i.id)).toEqual(["final"]);
    expect(parts.progress.map((i) => i.id)).toEqual(["question"]);
  }
});
