import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { notifications, notify, type NotificationTone } from "./notifications";
import { SfSymbol } from "./sf-symbol";

/** Announces each new result once, including retries producing the same message. */
export function Notice({
  message,
  tone = "error",
  eventKey,
}: {
  readonly message: string | null | undefined;
  readonly tone?: NotificationTone;
  readonly eventKey?: unknown;
}) {
  const id = useId();
  useEffect(() => {
    if (message) notify(message, tone, id);
  }, [message, tone, eventKey, id]);
  return null;
}

export function NotificationCenter() {
  const items = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);
  const host = useRef<HTMLDivElement>(null);
  const [portalHost, setPortalHost] = useState<Element>(document.body);
  useLayoutEffect(() => {
    const updateHost = () => {
      // Nodes outside a modal dialog are inert, even when their popover is visible.
      const dialogs = [...document.querySelectorAll("dialog:modal")];
      setPortalHost(dialogs.at(-1) ?? document.body);
    };
    updateHost();
    const observer = new MutationObserver(updateHost);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = host.current;
    // A closing dialog may be removed before the observer moves this portal.
    if (!element?.isConnected) return;
    // Use the top layer so messages also appear above native modal dialogs.
    if (element.matches(":popover-open")) element.hidePopover();
    if (items.length) element.showPopover();
  }, [items, portalHost]);
  return createPortal(
    <div ref={host} popover="manual" className="notification-center" aria-label="操作提示">
      {items.map((item) => (
        <div
          key={item.id}
          className={`notification notification--${item.tone}`}
          role={item.tone === "error" ? "alert" : "status"}
          aria-atomic="true"
          onMouseEnter={() => notifications.pause(item.id)}
          onMouseLeave={() => notifications.resume(item.id)}
        >
          <SfSymbol
            name={
              item.tone === "success"
                ? "checkmark.circle.fill"
                : item.tone === "error"
                  ? "exclamationmark.triangle"
                  : "lightbulb"
            }
            size={18}
          />
          <span>{item.message}</span>
        </div>
      ))}
    </div>,
    portalHost,
  );
}
