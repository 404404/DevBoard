import { AlertTriangle, RotateCcw } from "./icons";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
  readonly failed: boolean;
}

export class ErrorBoundary extends Component<{ readonly children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Taskboard render failure", error.name, info.componentStack);
  }

  override render() {
    if (this.state.failed) {
      return (
        <main className="fatal-state">
          <AlertTriangle aria-hidden="true" />
          <h1>界面遇到错误</h1>
          <p>数据没有被修改。重新载入页面后可继续工作。</p>
          <button className="button button--primary" onClick={() => window.location.reload()}>
            <RotateCcw aria-hidden="true" />
            重新载入
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
