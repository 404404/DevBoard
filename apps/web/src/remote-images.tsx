import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { SfSymbol } from "./sf-symbol";
import type { RemoteItem } from "./remote-turn-model";

export function RemoteImages({ threadId, item }: { threadId: string; item: RemoteItem }) {
  const [selected, setSelected] = useState<{ url: string; name: string }>();
  const [failed, setFailed] = useState<number[]>([]);
  if (!item.images?.length) return null;
  return (
    <>
      <div className="remote-image-gallery">
        {item.images.map((image) => {
          const url = `/api/v1/remote/threads/${encodeURIComponent(threadId)}/images/${encodeURIComponent(item.id)}/${image.index}`;
          return (
            <button
              key={image.index}
              className="remote-image-thumb"
              type="button"
              aria-label={`查看图片 ${image.name}`}
              disabled={failed.includes(image.index)}
              onClick={() => {
                setSelected({ url, name: image.name });
              }}
            >
              {failed.includes(image.index) ? (
                <span>
                  图片暂不可用
                  <br />
                  {image.name}
                </span>
              ) : (
                <img
                  src={url}
                  alt={image.name}
                  loading="lazy"
                  onError={() => setFailed((current) => [...current, image.index])}
                />
              )}
            </button>
          );
        })}
      </div>
      {selected && <ImagePreview image={selected} onClose={() => setSelected(undefined)} />}
    </>
  );
}

export function RemoteAttachmentImage({ id, name }: { id: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);
  const url = `/api/v1/remote/uploads/${encodeURIComponent(id)}/preview`;
  return (
    <>
      <button
        className="remote-attachment-image"
        type="button"
        aria-label={`查看图片 ${name}`}
        onClick={() => setPreview(true)}
      >
        {failed ? <span>图片</span> : <img src={url} alt={name} onError={() => setFailed(true)} />}
      </button>
      {preview && <ImagePreview image={{ url, name }} onClose={() => setPreview(false)} />}
    </>
  );
}

function ImagePreview({
  image,
  onClose,
}: {
  image: { url: string; name: string };
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const finish = useRef(onClose);
  const gesture = useRef<{ id: number; x: number; y: number } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    finish.current = onClose;
  }, [onClose]);
  useEffect(() => {
    // Keep the modal outside the keyboard-sized composer and never transform
    // the native dialog itself: an offscreen top-layer modal blocks the page.
    const element = dialog.current!;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    element.showModal();
    return () => {
      element.close();
    };
  }, []);
  useEffect(() => {
    if (!closing) return;
    // A parent poll/render must not restart the close timer.
    const timer = setTimeout(
      () => {
        dialog.current?.close();
        finish.current();
      },
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200,
    );
    return () => clearTimeout(timer);
  }, [closing]);
  const reset = () => {
    gesture.current = null;
    setDragging(false);
    setOffset({ x: 0, y: 0 });
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const start = gesture.current;
    if (!start || start.id !== event.pointerId) return;
    const down = event.clientY - start.y;
    if (down >= 60 && Math.hypot(event.clientX - start.x, down) >= 100) setClosing(true);
    else setOffset({ x: 0, y: 0 });
    gesture.current = null;
    setDragging(false);
  };
  return createPortal(
    <dialog
      ref={dialog}
      className={`remote-image-dialog${closing ? " is-closing" : ""}`}
      aria-label="图片预览"
      onCancel={(event) => {
        event.preventDefault();
        setClosing(true);
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        className="remote-image-surface"
        data-dragging={dragging}
        style={{ backgroundColor: `rgba(0, 0, 0, ${1 - Math.min(offset.y / 400, 0.7)})` }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || closing) {
            reset();
            return;
          }
          gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const start = gesture.current;
          if (!start || start.id !== event.pointerId) return;
          setOffset({ x: event.clientX - start.x, y: Math.max(0, event.clientY - start.y) });
        }}
        onPointerUp={end}
        onPointerCancel={reset}
        onLostPointerCapture={() => {
          if (gesture.current) reset();
        }}
      >
        <img
          src={image.url}
          alt={image.name}
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${1 - Math.min(offset.y / 1000, 0.3)})`,
          }}
        />
      </div>
      <button
        className="remote-image-close"
        type="button"
        aria-label="关闭图片预览"
        onClick={() => setClosing(true)}
      >
        <SfSymbol name="xmark" />
      </button>
    </dialog>,
    document.body,
  );
}
