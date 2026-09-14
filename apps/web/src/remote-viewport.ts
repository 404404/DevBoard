interface VerticalBounds {
  readonly top: number;
  readonly bottom: number;
}

interface VisualViewportBounds {
  readonly offsetTop: number;
  readonly height: number;
}

export interface RemoteViewportLayout {
  readonly top: number;
  readonly fixedTop: number;
  readonly height: number;
}

export function fitRemoteViewport(
  container: VerticalBounds,
  viewport: VisualViewportBounds,
): RemoteViewportLayout {
  // WKWebView can resize the layout viewport before clearing its keyboard pan.
  // Never apply an offset that would push the visible viewport past the container.
  const height = Math.max(0, Math.min(viewport.height, container.bottom));
  const offsetTop = Math.max(0, Math.min(viewport.offsetTop, container.bottom - height));
  const fixedTop = Math.max(container.top, offsetTop);
  const visibleBottom = Math.min(container.bottom, offsetTop + height);
  return {
    top: Math.max(0, fixedTop - container.top),
    fixedTop,
    height: Math.max(0, visibleBottom - fixedTop),
  };
}
