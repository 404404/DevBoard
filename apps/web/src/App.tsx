import { CliAuthApproval } from "./cli-auth-approval";
import { SessionGate } from "./auth";
import { MobileWorkspace } from "./mobile-remote";
import { ErrorBoundary } from "./error-boundary";
import { NotificationCenter } from "./notification-center";

export function App() {
  const taskctlLogin =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("taskctlLogin");
  return (
    <ErrorBoundary>
      <div className="application-viewport">
        <div className="application-content">
          <NotificationCenter />
          <SessionGate>
            {(session) =>
              taskctlLogin ? (
                <CliAuthApproval requestId={taskctlLogin} session={session} />
              ) : (
                <MobileWorkspace session={session} />
              )
            }
          </SessionGate>
        </div>
      </div>
    </ErrorBoundary>
  );
}
