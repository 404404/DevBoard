import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SfSymbol } from "./sf-symbol";
import { Notice } from "./notification-center";
import { formatBytes, attachmentFileExtension } from "./task-create-model";
import "./attachment-card.css";

type CardProps = {
  name: string;
  size: number;
  imageUrl?: string | undefined;
  onPreview?: (() => void) | undefined;
  downloadUrl?: string | undefined;
  onRemove?: (() => void) | undefined;
  removeDisabled?: boolean | undefined;
  removeLabel?: string | undefined;
  error?: string | undefined;
};

export function AttachmentCard({
  name,
  size,
  imageUrl,
  onPreview,
  downloadUrl,
  onRemove,
  removeDisabled,
  removeLabel,
  error,
}: CardProps) {
  const [preview, setPreview] = useState(false);
  const [failed, setFailed] = useState(false);
  const content = (
    <>
      {imageUrl && !failed ? (
        <img src={imageUrl} alt={name} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="attachment-card-icon">{attachmentFileExtension(name)}</span>
      )}
      <span className="attachment-card-text">
        <strong title={name}>{name}</strong>
        <small>
          {formatBytes(size)}
          {error ? " · 上传失败" : ""}
        </small>
      </span>
    </>
  );
  return (
    <article className="attachment-card" data-error={Boolean(error)}>
      {imageUrl ? (
        <a
          href={imageUrl}
          role="button"
          className="attachment-card-open"
          aria-label={`查看图片 ${name}`}
          onClick={(event) => {
            event.preventDefault();
            if (onPreview) onPreview();
            else setPreview(true);
          }}
          onKeyDown={(event) => {
            if (event.key === " ") {
              event.preventDefault();
              event.currentTarget.click();
            }
          }}
        >
          {content}
        </a>
      ) : downloadUrl ? (
        <a className="attachment-card-open" href={downloadUrl}>
          {content}
        </a>
      ) : (
        <div className="attachment-card-open">{content}</div>
      )}
      {onRemove && (
        <button
          className="attachment-card-remove"
          type="button"
          aria-label={removeLabel ?? `删除附件 ${name}`}
          disabled={removeDisabled}
          onClick={onRemove}
        >
          <SfSymbol name="xmark" size={14} />
        </button>
      )}
      {preview && imageUrl && (
        <ImagePreview
          name={name}
          imageUrl={imageUrl}
          downloadUrl={downloadUrl}
          onClose={() => setPreview(false)}
        />
      )}
      {error && <Notice message={`${name}：${error}`} />}
    </article>
  );
}

export function FileAttachmentCard({
  file,
  ...props
}: Omit<CardProps, "name" | "size" | "imageUrl"> & { file: File }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const next = URL.createObjectURL(file);
    // The object URL is an external resource owned by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return <AttachmentCard {...props} name={file.name} size={file.size} imageUrl={url} />;
}

function ImagePreview({
  name,
  imageUrl,
  downloadUrl,
  onClose,
}: {
  readonly name: string;
  readonly imageUrl: string;
  readonly downloadUrl: string | undefined;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="attachment-preview"
      aria-label={`预览图片 ${name}`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="attachment-preview-content">
        <header>
          <strong>{name}</strong>
          <button
            autoFocus
            className="icon-button"
            type="button"
            aria-label="关闭图片预览"
            onClick={onClose}
          >
            <SfSymbol name="xmark" size={18} />
          </button>
        </header>
        {failed ? (
          <Notice message="图片加载失败，可下载后查看。" />
        ) : (
          <img src={imageUrl} alt={name} onError={() => setFailed(true)} />
        )}
        {downloadUrl && (
          <a className="button" href={downloadUrl} download={name}>
            下载原图
          </a>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
