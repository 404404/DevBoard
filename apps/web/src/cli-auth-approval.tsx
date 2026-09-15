import { userErrorMessage } from "./user-error";
import type { SessionView } from "@codexboard/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approveCliRequest, readCliRequest } from "./cli-auth-api";

export function CliAuthApproval({
  requestId,
  session,
}: {
  readonly requestId: string;
  readonly session: SessionView;
}) {
  const client = useQueryClient();
  const queryKey = ["cli-auth-request", requestId] as const;
  const request = useQuery({
    queryKey,
    queryFn: () => readCliRequest(requestId),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 5_000 : false),
  });
  const approval = useMutation({
    mutationFn: () => approveCliRequest(requestId, session.csrfToken),
    onSuccess: (data) => {
      client.setQueryData(queryKey, data);
    },
  });
  const identity = session.actor.identity;
  const data = request.data;
  const expired = data?.status === "expired";
  const canApprove = identity.kind === "feishu" && data?.status === "pending" && !expired;
  const error = approval.error ?? request.error;
  return (
    <main className="session-state" aria-labelledby="cli-auth-heading">
      <h1 id="cli-auth-heading">授权 taskctl 登录</h1>
      <p>当前用户：{session.actor.name}</p>
      {identity.kind === "feishu" ? (
        <p>
          企业：{identity.tenantKey} · 用户：{identity.userId}
        </p>
      ) : (
        <p role="alert">请使用飞书用户身份登录后授权。</p>
      )}
      {request.isPending && <p role="status">正在读取登录请求…</p>}
      {data && (
        <>
          <p>
            CLI 名称：<strong>{data.label}</strong>
          </p>
          <p>
            核对码：<strong>{data.verificationCode}</strong>
          </p>
          <p>
            请确认名称和核对码与刚才发起登录的终端一致。授权后，该 CLI 可在 8
            小时内以你的身份访问看板，并受你的项目权限约束；可通过 taskctl auth logout 撤销。
          </p>
          <p>
            此请求截止时间：
            <time dateTime={data.expiresAt}>{new Date(data.expiresAt).toLocaleString()}</time>
          </p>
          {expired ? (
            <p role="status">登录请求已过期，请在终端重新运行 taskctl auth login。</p>
          ) : data.status === "approved" || data.status === "claimed" ? (
            <p role="status">
              已授权，请回到终端运行 <code>taskctl auth complete</code>。
            </p>
          ) : null}
        </>
      )}
      {error && <p role="alert">{userErrorMessage(error, "授权失败，请重试。")}</p>}
      {canApprove && (
        <button
          className="button button--primary"
          type="button"
          disabled={approval.isPending}
          onClick={() => approval.mutate()}
        >
          {approval.isPending ? "正在授权…" : "确认授权此 CLI"}
        </button>
      )}
      <a href="/">返回任务看板</a>
    </main>
  );
}
