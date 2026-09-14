import { validateRemoteApprovalContent } from "@lark-codex/contracts";
import { useState } from "react";
import type { RemoteAction, RemoteApproval, RemoteApprovalContent } from "@lark-codex/contracts";
import { RemoteNotice } from "./remote-notice";

export function RemoteApprovalForm({
  approval,
  requestId,
  disabled,
  onRespond,
}: {
  approval: RemoteApproval;
  requestId: string | number;
  disabled: boolean;
  onRespond: (action: RemoteAction) => void;
}) {
  const [error, setError] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>({});
  const setValue = (name: string, value: string) =>
    setValues((previous) => ({ ...previous, [name]: value }));
  const fieldValue = (name: string) => (Object.hasOwn(values, name) ? values[name] : undefined);
  const respond = (choice: string) => {
    const content: RemoteApprovalContent = {};
    if (!["decline", "cancel"].includes(choice))
      for (const f of approval.fields) {
        const value =
          fieldValue(f.name) ??
          (f.required && (f.type === "array" || (f.type === "string" && !f.options))
            ? ""
            : undefined);
        if (
          value === undefined ||
          (value === "" &&
            ((f.options && f.type !== "array") ||
              ["number", "integer", "boolean"].includes(f.type)))
        )
          continue;
        content[f.name] =
          f.options && f.type !== "array"
            ? f.options[Number(value)]!
            : f.type === "boolean"
              ? value === "true"
              : f.type === "integer" || f.type === "number"
                ? Number(value)
                : f.type === "array"
                  ? value.split("\n").filter((line) => line.length > 0)
                  : value;
      }
    if (!["decline", "cancel"].includes(choice) && approval.schema) {
      try {
        validateRemoteApprovalContent(approval.schema, content);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "请检查填写内容");
        return;
      }
    }
    setError(undefined);
    onRespond({
      type: "respond",
      requestId,
      approvalToken: approval.token!,
      approvalChoice: choice,
      content,
    });
  };
  return (
    <section className="remote-approval remote-general-approval" aria-label={approval.title}>
      <p className="remote-eyebrow">请求授权</p>
      <h3>{approval.title}</h3>
      {approval.details && <pre className="remote-command">{approval.details}</pre>}
      {approval.blockedReason && <RemoteNotice>{approval.blockedReason}</RemoteNotice>}
      {approval.url && (
        <a
          className="remote-authorization-link"
          href={approval.url}
          target="_blank"
          rel="noreferrer noopener"
        >
          打开授权网站
        </a>
      )}
      {error && <RemoteNotice role="alert">{error}</RemoteNotice>}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const submitter = (event.nativeEvent as SubmitEvent)
            .submitter as HTMLButtonElement | null;
          const choice = submitter?.value;
          if (choice && !disabled) respond(choice);
        }}
      >
        {approval.fields.map((f) => (
          <label className="remote-authorization-field" key={f.name}>
            <span>
              {f.label}
              {f.required && <small aria-hidden="true">（必填）</small>}
            </span>
            {f.description && <small>{f.description}</small>}
            {f.type === "boolean" && !f.options ? (
              <select
                aria-label={f.label}
                required={f.required}
                value={fieldValue(f.name) ?? ""}
                onChange={(e) => setValue(f.name, e.target.value)}
                disabled={disabled}
              >
                <option value="">请选择</option>
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            ) : f.options && f.type !== "array" ? (
              <select
                aria-label={f.label}
                required={f.required}
                value={fieldValue(f.name) ?? ""}
                onChange={(e) => setValue(f.name, e.target.value)}
                disabled={disabled}
              >
                <option value="">请选择</option>
                {f.options.map((v, i) => (
                  <option key={i} value={String(i)}>
                    {f.optionLabels?.[i] ?? String(v)}
                  </option>
                ))}
              </select>
            ) : f.type === "array" ? (
              <>
                <small>每行填写一项{f.options ? `，可选：${f.options.join("、")}` : ""}</small>
                <textarea
                  aria-label={f.label}
                  required={f.required}
                  value={fieldValue(f.name) ?? ""}
                  onChange={(e) => setValue(f.name, e.target.value)}
                  maxLength={10000}
                  disabled={disabled}
                />
              </>
            ) : (
              <input
                aria-label={f.label}
                required={f.required}
                type={f.secret ? "password" : f.type === "string" ? "text" : "number"}
                step={f.type === "integer" ? 1 : "any"}
                value={fieldValue(f.name) ?? ""}
                onChange={(e) => setValue(f.name, e.target.value)}
                maxLength={10000}
                autoComplete="off"
                disabled={disabled}
              />
            )}
          </label>
        ))}
        <div className="remote-approval-actions">
          {approval.choices.map((choice) => (
            <div className="remote-authorization-choice" key={choice.id}>
              {choice.detail && <pre className="remote-command">{choice.detail}</pre>}
              <button
                type="submit"
                value={choice.id}
                formNoValidate={["decline", "cancel"].includes(choice.id)}
                disabled={disabled || !approval.token}
                className={choice.id === "accept" ? "remote-approve" : "remote-decline"}
              >
                {choice.label}
              </button>
            </div>
          ))}
        </div>
      </form>
    </section>
  );
}
