import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";

import type { CreateProjectCommand, ProjectView } from "@codexboard/contracts";
import { createProject } from "./api";
import { Notice } from "./notification-center";
import { userErrorMessage } from "./user-error";
import { X } from "./icons";

export function ProjectCreateDialog({
  open,
  csrfToken,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onCreated: (project: ProjectView) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [projectKey, setProjectKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const mutation = useMutation({
    mutationFn: (input: CreateProjectCommand) => createProject(input, csrfToken),
    onSuccess: (project) => {
      setProjectKey("");
      setName("");
      setDescription("");
      onCreated(project);
    },
  });

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate({
      projectKey: projectKey.trim().toUpperCase(),
      name: name.trim(),
      description,
    });
  };

  return (
    <dialog
      ref={dialog}
      className="tag-manager-backdrop execution-settings-backdrop"
      aria-labelledby="project-create-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!mutation.isPending) onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !mutation.isPending) onClose();
      }}
    >
      <section className="tag-manager-dialog execution-settings-dialog">
        <header>
          <div>
            <span className="execution-settings-mark" aria-hidden="true">
              ◈
            </span>
            <h2 id="project-create-title">新建 Project</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            <X />
          </button>
        </header>
        {mutation.isError ? (
          <Notice
            message={userErrorMessage(mutation.error, "项目创建失败，请检查 Project Key。")}
            eventKey={mutation.error}
          />
        ) : null}
        <form className="execution-settings-form" onSubmit={submit}>
          <label>
            <span>Project Key</span>
            <input
              autoFocus
              required
              minLength={1}
              maxLength={5}
              pattern="[A-Za-z]{1,5}"
              value={projectKey}
              onChange={(event) => setProjectKey(event.target.value.toUpperCase())}
              placeholder="DEV"
            />
            <small>1 到 5 个英文字母，用于生成 Task 编号。</small>
          </label>
          <label>
            <span>名称</span>
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>描述</span>
            <textarea
              maxLength={20_000}
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <footer className="execution-settings-actions">
            <button
              className="button"
              type="button"
              disabled={mutation.isPending}
              onClick={onClose}
            >
              取消
            </button>
            <button className="button button--primary" type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "创建中…" : "创建 Project"}
            </button>
          </footer>
        </form>
      </section>
    </dialog>
  );
}
