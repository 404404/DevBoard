import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

const threshold = 64;

export function RemotePullRefresh({
  children,
  onRefresh,
}: {
  children: ReactNode;
  onRefresh: () => Promise<unknown>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useEffectEvent(onRefresh);

  useEffect(() => {
    const element = container.current!;
    let start: { x: number; y: number } | undefined;
    let pull = 0;
    let locked = false;
    let disposed = false;
    const reset = () => {
      start = undefined;
      pull = 0;
      setDistance(0);
    };
    const begin = (event: TouchEvent) => {
      reset();
      if (locked || element.scrollTop > 0 || event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      start = { x: touch.clientX, y: touch.clientY };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1 || element.scrollTop > 0) return reset();
      const touch = event.touches[0]!;
      const dy = touch.clientY - start.y;
      const dx = Math.abs(touch.clientX - start.x);
      if (dy < 0 || dx > Math.max(10, dy)) return reset();
      if (dy < 10) {
        pull = 0;
        setDistance(0);
        return;
      }
      // Own only a downward drag at the top; normal scrolling remains native.
      if (!event.cancelable) return reset();
      event.preventDefault();
      pull = Math.min(96, dy * 0.5);
      setDistance(pull);
    };
    const end = () => {
      const ready = pull >= threshold && !locked;
      reset();
      if (!ready) return;
      locked = true;
      setRefreshing(true);
      void refresh().finally(() => {
        locked = false;
        if (!disposed) setRefreshing(false);
      });
    };
    element.addEventListener("touchstart", begin, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end);
    element.addEventListener("touchcancel", reset);
    element.dataset.pullRefreshReady = "true";
    return () => {
      disposed = true;
      element.removeEventListener("touchstart", begin);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", reset);
      delete element.dataset.pullRefreshReady;
    };
  }, []);

  return (
    <div className="remote-list-body" ref={container} aria-busy={refreshing}>
      <div
        className="remote-pull-indicator"
        style={{ height: refreshing ? threshold : distance }}
        role="status"
      >
        {(refreshing || distance > 0) && (
          <>
            {refreshing && <span className="remote-status-spinner" aria-hidden="true" />}
            <span>{refreshing ? "刷新中…" : distance >= threshold ? "松开刷新" : "下拉刷新"}</span>
          </>
        )}
      </div>
      {children}
    </div>
  );
}
