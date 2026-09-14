import { QueryNotice } from "./query-notice";
import type { SessionView } from "@lark-codex/contracts";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "./icons";
import type { ReactNode } from "react";

import { restoreOrCreateSession } from "./auth-session";

const sessionQueryKey = ["session"] as const;

function useSession() {
  return useQuery({
    queryKey: sessionQueryKey,
    queryFn: restoreOrCreateSession,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function SessionGate({
  children,
}: {
  readonly children: (session: SessionView) => ReactNode;
}) {
  const session = useSession();

  if (session.isPending) {
    return (
      <main className="session-state" aria-live="polite">
        <LoaderCircle className="spin" aria-hidden="true" />
        <h1>正在进入任务看板</h1>
        <p>正在确认飞书身份并同步本地数据。</p>
      </main>
    );
  }

  if (session.isError && !session.data) {
    return (
      <main className="session-recovery" aria-label="任务看板">
        <h1>任务看板</h1>
        <QueryNotice
          error={session.error}
          fallback="暂时无法进入看板，请重试。"
          refreshing={session.isFetching}
          onRetry={() => void session.refetch()}
        />
      </main>
    );
  }

  return (
    <>
      {session.isError && (
        <QueryNotice
          error={session.error}
          refreshing={session.isFetching}
          onRetry={() => void session.refetch()}
        />
      )}
      {session.data && children(session.data)}
    </>
  );
}
