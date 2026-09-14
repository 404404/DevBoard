import { useState } from "react";
import type { RemoteAction, RemoteThread } from "@lark-taskboard/contracts";
import { remoteErrorMessage } from "./remote-api";
import { MarkdownContent } from "./markdown";
import { RemoteEditIcon, RemoteQuestionIcon } from "./remote-message-icons";
import { RemoteNotice } from "./remote-notice";
import "./remote-message-actions.css";

type Item = RemoteThread["turns"][number]["items"][number];
type Submit = (action: RemoteAction) => Promise<unknown>;
export function RemoteAsyncQuestions({
  item,
  disabled,
  onSubmit,
}: {
  item: Item;
  disabled: boolean;
  onSubmit: Submit;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const questions = item.asyncQuestions ?? [];
  const unanswered = questions.filter((q) => q.answer === null);
  if (!questions.length) return null;
  return (
    <div className="remote-async-questions">
      {!open && unanswered.map((q) => <MarkdownContent key={q.id} markdown={q.title} />)}
      {questions
        .filter((q) => q.answer !== null)
        .map((q) => (
          <div className="remote-question-answer" key={q.id}>
            <small>已回答 · {q.title}</small>
            <p>{q.answer}</p>
          </div>
        ))}
      {!!unanswered.length &&
        (!open ? (
          <button
            className="remote-answer-button"
            aria-expanded={false}
            onClick={() => setOpen(true)}
          >
            <RemoteQuestionIcon />
            回答问题
          </button>
        ) : (
          <form
            className="remote-question-form"
            aria-label="回答问题"
            onSubmit={async (event) => {
              event.preventDefault();
              if (disabled || unanswered.some((q) => !values[q.id]?.trim())) return;
              setError("");
              try {
                await onSubmit({
                  type: "answer",
                  itemId: item.id,
                  answers: Object.fromEntries(unanswered.map((q) => [q.id, values[q.id]!.trim()])),
                });
                setOpen(false);
              } catch (reason) {
                setError(remoteErrorMessage(reason));
              }
            }}
          >
            <div className="remote-question-form-heading">
              <RemoteQuestionIcon />
              <strong>回答问题</strong>
            </div>
            {unanswered.map((q) => (
              <fieldset key={q.id} disabled={disabled}>
                <legend>{q.title}</legend>
                {q.options.map((option) => (
                  <label className="remote-option" key={option}>
                    <input
                      type="radio"
                      name={q.id}
                      checked={values[q.id] === option}
                      onChange={() => setValues((v) => ({ ...v, [q.id]: option }))}
                    />
                    <span>{option}</span>
                  </label>
                ))}
                <textarea
                  aria-label={q.title}
                  placeholder="输入回答，也可填写选项之外的内容"
                  maxLength={10000}
                  rows={3}
                  value={values[q.id] ?? ""}
                  onChange={(event) => setValues((v) => ({ ...v, [q.id]: event.target.value }))}
                />
              </fieldset>
            ))}
            {error && <RemoteNotice role="alert">{error}</RemoteNotice>}
            <div className="remote-message-action-buttons">
              <button type="button" disabled={disabled} onClick={() => setOpen(false)}>
                取消
              </button>
              <button
                type="submit"
                disabled={disabled || unanswered.some((q) => !values[q.id]?.trim())}
              >
                {disabled ? "正在提交…" : "提交回答"}
              </button>
            </div>
          </form>
        ))}
    </div>
  );
}
export function RemoteEditMessage({
  text,
  candidate,
  disabled,
  onSubmit,
}: {
  text: string;
  candidate: NonNullable<RemoteThread["editableMessage"]>;
  disabled: boolean;
  onSubmit: Submit;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState("");
  if (!editing)
    return (
      <button
        className="remote-edit-message"
        aria-label="编辑消息"
        title="编辑消息"
        onClick={() => {
          setDraft(text);
          setError("");
          setEditing(true);
        }}
        disabled={disabled}
      >
        <RemoteEditIcon />
      </button>
    );
  return (
    <form
      className="remote-message-edit"
      aria-label="编辑已发送消息"
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || !draft.trim()) return;
        setError("");
        try {
          await onSubmit({
            type: "edit",
            turnId: candidate.turnId,
            editToken: candidate.token,
            text: draft,
          });
          setEditing(false);
        } catch (reason) {
          setError(remoteErrorMessage(reason));
        }
      }}
    >
      <textarea
        aria-label="编辑消息内容"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={4}
        maxLength={100000}
        disabled={disabled}
      />
      <small>保存后替换这条消息并重新执行，保留原附件。</small>
      {error && <RemoteNotice role="alert">{error}</RemoteNotice>}
      <div className="remote-message-action-buttons">
        <button type="button" onClick={() => setEditing(false)} disabled={disabled}>
          取消
        </button>
        <button type="submit" disabled={disabled || !draft.trim()}>
          保存并重新执行
        </button>
      </div>
    </form>
  );
}
