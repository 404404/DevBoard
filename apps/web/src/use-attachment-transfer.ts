import { userErrorMessage } from "./user-error";
import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";

function containsFiles(data: DataTransfer): boolean {
  return (
    Array.from(data.types).includes("Files") ||
    Array.from(data.items).some((item) => item.kind === "file")
  );
}

function transferredFiles(data: DataTransfer): File[] {
  const items = Array.from(data.items).filter((item) => item.kind === "file");
  if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory))
    throw new Error("暂不支持文件夹，请选择其中的文件。");
  return data.files.length
    ? Array.from(data.files)
    : items.flatMap((item) => {
        const file = item.getAsFile();
        return file ? [file] : [];
      });
}

/** Accept only file transfers; ordinary text paste and text dragging stay native. */
export function useAttachmentTransfer({
  enabled,
  onFiles,
  unavailableMessage = "当前无法添加附件。",
}: {
  enabled: boolean;
  onFiles: (files: File[]) => void;
  unavailableMessage?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const depth = useRef(0);
  const accept = (data: DataTransfer) => {
    if (!enabled) {
      setError(unavailableMessage);
      return;
    }
    try {
      const files = transferredFiles(data);
      if (files.length) {
        setError("");
        onFiles(files);
      }
    } catch (error) {
      setError(userErrorMessage(error, "无法读取附件，请重试。"));
    }
  };
  return {
    dragging: enabled && dragging,
    error,
    handlers: {
      onPaste(event: ClipboardEvent<HTMLElement>) {
        if (!containsFiles(event.clipboardData)) return;
        event.preventDefault();
        event.stopPropagation();
        accept(event.clipboardData);
      },
      onDragEnter(event: DragEvent<HTMLElement>) {
        if (!containsFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current += 1;
        if (enabled) setDragging(true);
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        if (!containsFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = enabled ? "copy" : "none";
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (!containsFiles(event.dataTransfer)) return;
        event.stopPropagation();
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        depth.current = 0;
        setDragging(false);
        if (!containsFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        accept(event.dataTransfer);
      },
    },
  };
}
