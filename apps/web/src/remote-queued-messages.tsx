import { useRef, useState } from "react";
import type { RemoteThread } from "@lark-codex/contracts";
import { SfSymbol } from "./sf-symbol";

type Queue = NonNullable<RemoteThread["queue"]>;
type Message = Queue["messages"][number];
export function RemoteQueuedMessages({
  queue,
  disabled,
  canSteer,
  hasDraft,
  onAction,
}: {
  queue: Queue;
  disabled: boolean;
  canSteer: boolean;
  hasDraft: boolean;
  onAction: (operation: "take" | "cancel" | "steer", message: Message) => Promise<void>;
}) {
  const menu = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<Message | null>(null);
  const close = () => {
    menu.current?.close();
    setSelected(null);
  };
  const act = (operation: "take" | "cancel" | "steer") => {
    if (selected) void onAction(operation, selected);
    close();
  };
  return (
    <>
      {queue.messages.map((message) => (
        <article className="remote-queued-message" key={message.id} aria-label="排队消息">
          <div className="remote-queued-label">
            <SfSymbol name="text.append" />
            <span>{message.pausedReason ? "已暂停" : "排队中"}</span>
            <button
              aria-label={`排队消息选项：${message.text.slice(0, 60)}`}
              disabled={disabled}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setSelected(message);
                if (menu.current) {
                  const width = Math.min(260, window.innerWidth - 32);
                  menu.current.style.left = `${Math.max(16, Math.min(window.innerWidth - width - 16, box.right - width))}px`;
                  menu.current.style.top = `${Math.max(70, Math.min(window.innerHeight - 215, box.top - 170))}px`;
                  menu.current.showModal();
                }
              }}
            >
              <SfSymbol name="ellipsis" />
            </button>
          </div>
          <div className="remote-queued-bubble">{message.text}</div>
          {!!message.attachments?.length && (
            <small>{message.attachments.map((file) => file.name).join("、")}</small>
          )}
          {message.pausedReason && <small>{message.pausedReason}</small>}
        </article>
      ))}
      <dialog
        className="remote-queue-menu"
        aria-label="排队消息操作"
        ref={menu}
        onCancel={close}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const box = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < box.left ||
              event.clientX > box.right ||
              event.clientY < box.top ||
              event.clientY > box.bottom
            )
              close();
          }
        }}
      >
        <p>{selected?.text}</p>
        <button
          disabled={disabled || !selected?.canEdit || hasDraft}
          title={hasDraft ? "请先发送或清空当前草稿" : undefined}
          onClick={() => act("take")}
        >
          <SfSymbol name="pencil" />
          编辑消息
        </button>
        <button
          disabled={disabled || !canSteer || !selected?.canSteer}
          onClick={() => act("steer")}
        >
          <SfSymbol name="arrow.turn.down.right" />
          改为引导
        </button>
        <button className="remote-queue-cancel" disabled={disabled} onClick={() => act("cancel")}>
          <SfSymbol name="trash" />
          取消消息
        </button>
      </dialog>
    </>
  );
}
