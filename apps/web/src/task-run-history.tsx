import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
  ExecutionApprovalDecisionSchema,
  type ExecutionApprovalDecision,
} from "@codexboard/contracts";

import {
  cancelRun,
  continueTaskRun,
  createRemoteWorkspaceMapping,
  createWorkspaceMapping,
  listExecutionProfiles,
  readProjectDefaultProfile,
  setProjectDefaultProfile,
  listRunApprovals,
  listTaskRuns,
  listWorkspaceMappings,
  respondToRunApproval,
  startTaskRun,
} from "./api";
import { QueryNotice } from "./query-notice";

function statusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "starting":
      return "启动中";
    case "running":
      return "执行中";
    case "waiting_approval":
      return "等待审批";
    case "waiting_input":
      return "等待输入";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "canceled":
      return "已取消";
    case "interrupted":
      return "已中断";
    case "disconnected":
      return "连接中断";
    default:
      return status;
  }
}

interface TaskRunHistoryProps {
  readonly taskId: string;
  readonly projectId: string;
  readonly csrfToken: string;
  readonly canExecute: boolean;
  readonly canManageProject: boolean;
  readonly mutationsEnabled: boolean;
}

function activeStatus(status: string): boolean {
  return ["queued", "starting", "running", "waiting_approval", "waiting_input"].includes(status);
}

export function TaskRunHistory(props: TaskRunHistoryProps) {
  const queryClient = useQueryClient();
  const [profileId, setProfileId] = useState("");
  const profileInitialized = useRef(false);
  const [continuationRunId, setContinuationRunId] = useState<string | null>(null);
  const [workspaceDraft, setWorkspaceDraft] = useState<{ key: string; value: string } | null>(null);
  const [runOptionsDraft, setRunOptionsDraft] = useState<{
    profileId: string;
    model: string;
    reasoningEffort: string;
    mode: string;
    permissionMode: string;
  } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [inputDrafts, setInputDrafts] = useState<Record<string, string>>({});
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const runs = useQuery({
    queryKey: ["task-runs", props.taskId],
    queryFn: () => listTaskRuns(props.taskId),
    refetchInterval: 3_000,
  });
  const profiles = useQuery({
    queryKey: ["execution-profiles"],
    queryFn: listExecutionProfiles,
    enabled: props.canExecute,
  });
  const projectDefault = useQuery({
    queryKey: ["project-execution-profile", props.projectId],
    queryFn: () => readProjectDefaultProfile(props.projectId),
    enabled: props.canExecute,
  });
  const selectedProfile =
    profiles.data?.find((profile) => profile.id === profileId) ??
    profiles.data?.find((profile) => profile.id === projectDefault.data?.profileId);
  const mappings = useQuery({
    queryKey: ["workspace-mappings", props.projectId],
    queryFn: () => listWorkspaceMappings(props.projectId),
    enabled: props.canExecute,
  });
  const selectedMapping = mappings.data?.find(
    (mapping) => mapping.connectionId === selectedProfile?.connectionId,
  );
  const workspaceKey = `${selectedProfile?.connectionId ?? ""}\u0000${selectedMapping?.path ?? ""}`;
  const workspace =
    workspaceDraft?.key === workspaceKey ? workspaceDraft.value : (selectedMapping?.path ?? "");
  const setWorkspace = (value: string) => setWorkspaceDraft({ key: workspaceKey, value });
  const runOptions =
    selectedProfile && runOptionsDraft?.profileId === selectedProfile.id
      ? runOptionsDraft
      : {
          profileId: selectedProfile?.id ?? "",
          model: selectedProfile?.defaultModel ?? "",
          reasoningEffort: selectedProfile?.defaultReasoningEffort ?? "",
          mode: selectedProfile?.defaultMode ?? "",
          permissionMode: "",
        };
  const updateRunOptions = (patch: Partial<Omit<typeof runOptions, "profileId">>) => {
    if (!selectedProfile) return;
    setRunOptionsDraft((current) => ({
      profileId: selectedProfile.id,
      model:
        current?.profileId === selectedProfile.id
          ? current.model
          : (selectedProfile.defaultModel ?? ""),
      reasoningEffort:
        current?.profileId === selectedProfile.id
          ? current.reasoningEffort
          : (selectedProfile.defaultReasoningEffort ?? ""),
      mode:
        current?.profileId === selectedProfile.id
          ? current.mode
          : (selectedProfile.defaultMode ?? ""),
      permissionMode: current?.profileId === selectedProfile.id ? current.permissionMode : "",
      ...patch,
    }));
  };
  const model = runOptions.model;
  const reasoningEffort = runOptions.reasoningEffort;
  const mode = runOptions.mode;
  const permissionMode = runOptions.permissionMode;
  const setModel = (value: string) => updateRunOptions({ model: value });
  const setReasoningEffort = (value: string) => updateRunOptions({ reasoningEffort: value });
  const setMode = (value: string) => updateRunOptions({ mode: value });
  const setPermissionMode = (value: string) => updateRunOptions({ permissionMode: value });
  useEffect(() => {
    if (profileInitialized.current || projectDefault.isPending || !profiles.data?.length) return;
    setProfileId(projectDefault.data?.profileId ?? profiles.data[0]?.id ?? "");
    profileInitialized.current = true;
  }, [profiles.data, projectDefault.data?.profileId, projectDefault.isPending]);
  const activeRun = runs.data?.find((run) => activeStatus(run.status));
  const continuationRun = runs.data?.find((run) => run.id === continuationRunId);
  const approvals = useQuery({
    queryKey: ["run-approvals", activeRun?.id],
    queryFn: () => listRunApprovals(activeRun?.id ?? ""),
    enabled: Boolean(
      activeRun &&
      (activeRun.status === "waiting_approval" || activeRun.status === "waiting_input"),
    ),
    refetchInterval: 1_000,
  });
  const start = useMutation({
    mutationFn: () =>
      startTaskRun(
        props.taskId,
        {
          executionProfileId: profileId || null,
          prompt: prompt.trim(),
          model: model.trim() || null,
          reasoningEffort: reasoningEffort.trim() || null,
          mode: mode.trim() || null,
          permissionMode: permissionMode.trim() || null,
        },
        props.csrfToken,
      ),
    onSuccess: () => {
      setPrompt("");
      setContinuationRunId(null);
      void queryClient.invalidateQueries({ queryKey: ["task-runs", props.taskId] });
    },
  });
  const continueRun = useMutation({
    mutationFn: () => continueTaskRun(continuationRunId ?? "", prompt.trim(), props.csrfToken),
    onSuccess: () => {
      setPrompt("");
      setContinuationRunId(null);
      void queryClient.invalidateQueries({ queryKey: ["task-runs", props.taskId] });
    },
  });
  const setDefault = useMutation({
    mutationFn: (nextProfileId: string | null) =>
      setProjectDefaultProfile(props.projectId, nextProfileId, props.csrfToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["project-execution-profile", props.projectId],
      });
    },
  });
  const saveMapping = useMutation({
    mutationFn: () =>
      createWorkspaceMapping(
        props.projectId,
        {
          connectionId: selectedProfile?.connectionId ?? "",
          path: workspace.trim(),
          isDefault: true,
        },
        props.csrfToken,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspace-mappings", props.projectId] });
    },
  });
  const createMapping = useMutation({
    mutationFn: () =>
      createRemoteWorkspaceMapping(
        props.projectId,
        {
          connectionId: selectedProfile?.connectionId ?? "",
          path: workspace.trim(),
          isDefault: true,
        },
        props.csrfToken,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspace-mappings", props.projectId] });
    },
  });
  const cancel = useMutation({
    mutationFn: (runId: string) => cancelRun(runId, props.csrfToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task-runs", props.taskId] });
    },
  });
  const respond = useMutation({
    mutationFn: (input: {
      readonly approvalId: string;
      readonly decision: ExecutionApprovalDecision;
    }) =>
      respondToRunApproval(activeRun?.id ?? "", input.approvalId, input.decision, props.csrfToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task-runs", props.taskId] });
      void queryClient.invalidateQueries({ queryKey: ["run-approvals", activeRun?.id] });
    },
  });

  const submitInput = (approvalId: string) => {
    const raw = inputDrafts[approvalId]?.trim() ?? "";
    try {
      const answers = JSON.parse(raw) as unknown;
      const decision = ExecutionApprovalDecisionSchema.parse({ type: "input", answers });
      setInputErrors((previous) => ({ ...previous, [approvalId]: "" }));
      respond.mutate({ approvalId, decision });
    } catch {
      setInputErrors((previous) => ({ ...previous, [approvalId]: "请输入有效的 answers JSON" }));
    }
  };

  if (runs.isPending) return <p className="task-run-history__empty">正在加载执行记录…</p>;
  if (runs.isError) {
    return (
      <QueryNotice
        error={runs.error}
        fallback="执行记录暂时无法加载。"
        refreshing={runs.isFetching}
        onRetry={() => void runs.refetch()}
      />
    );
  }

  const canStart =
    props.mutationsEnabled &&
    props.canExecute &&
    Boolean(continuationRun?.providerThreadId || profileId || projectDefault.data?.profileId) &&
    Boolean(
      continuationRun?.providerThreadId ||
      (selectedMapping && workspace.trim() === selectedMapping.path),
    ) &&
    Boolean(prompt.trim()) &&
    !activeRun;
  const pendingApprovals =
    approvals.data?.filter((approval) => approval.status === "pending") ?? [];

  return (
    <section className="task-run-history" aria-labelledby="task-run-history-title">
      <header>
        <div>
          <h2 id="task-run-history-title">Run 控制台</h2>
          <p>统一启动 Provider、查看事件，并处理审批</p>
        </div>
        <button
          className="button"
          type="button"
          disabled={runs.isFetching}
          onClick={() => void runs.refetch()}
        >
          {runs.isFetching ? "刷新中…" : "刷新"}
        </button>
      </header>

      <div className="task-run-launch">
        <label>
          <span>Execution Profile</span>
          <select
            value={profileId}
            disabled={
              !props.mutationsEnabled ||
              !props.canExecute ||
              profiles.isPending ||
              Boolean(activeRun)
            }
            onChange={(event) => setProfileId(event.target.value)}
          >
            <option value="">
              使用项目默认（{projectDefault.data?.profileId ? "已配置" : "未配置"}）
            </option>
            {(profiles.data ?? [])
              .filter((profile) => profile.enabled)
              .map((profile) => (
                <option value={profile.id} key={profile.id}>
                  {profile.name} · {profile.providerKind} · {profile.connectionName}
                </option>
              ))}
          </select>
          <div className="task-run-launch__profile-actions">
            <button
              className="button"
              type="button"
              disabled={
                !profileId || !props.canManageProject || setDefault.isPending || Boolean(activeRun)
              }
              onClick={() => setDefault.mutate(profileId || null)}
            >
              {projectDefault.data?.profileId === profileId ? "项目默认" : "设为项目默认"}
            </button>
            {continuationRun ? (
              <button className="button" type="button" onClick={() => setContinuationRunId(null)}>
                取消 Continue
              </button>
            ) : null}
          </div>
        </label>
        {continuationRun ? (
          <p className="task-run-history__continuation">
            将继续 {continuationRun.executionProfileName ?? continuationRun.providerKind} 的已有
            session。
          </p>
        ) : null}
        <label>
          <span>项目 Workspace Mapping</span>
          <input
            value={workspace}
            disabled={!props.mutationsEnabled || !props.canExecute || Boolean(activeRun)}
            onChange={(event) => setWorkspace(event.target.value)}
            placeholder="例如 /home/user/projects/project"
          />
        </label>
        <div className="task-run-launch__workspace-actions">
          <small>
            {selectedMapping
              ? `新 Run 将使用 ${selectedProfile?.connectionName} 上已保存的远端路径：${selectedMapping.path}`
              : "请先为所选 SSH Connection 保存或创建远端 Workspace Mapping；未映射路径不能启动 Run。"}
          </small>
          <button
            className="button button--compact"
            type="button"
            disabled={
              !props.mutationsEnabled ||
              !props.canManageProject ||
              !selectedProfile?.connectionId ||
              !workspace.trim().startsWith("/") ||
              saveMapping.isPending ||
              Boolean(activeRun)
            }
            onClick={() => saveMapping.mutate()}
          >
            {saveMapping.isPending ? "保存中…" : "保存 Workspace Mapping"}
          </button>
          <button
            className="button button--compact"
            type="button"
            disabled={
              !props.mutationsEnabled ||
              !props.canManageProject ||
              !selectedProfile?.connectionId ||
              !workspace.trim().startsWith("/") ||
              createMapping.isPending ||
              Boolean(activeRun)
            }
            onClick={() => {
              const confirmed = window.confirm(
                `将在 ${selectedProfile?.connectionName ?? "SSH Host"} 上创建目录并绑定到当前项目：\n\n${workspace.trim()}`,
              );
              if (confirmed) createMapping.mutate();
            }}
          >
            {createMapping.isPending ? "远端创建中…" : "远端创建目录并映射"}
          </button>
        </div>
        {saveMapping.isError || createMapping.isError ? (
          <small className="task-run-history__error">
            {saveMapping.error instanceof Error
              ? saveMapping.error.message
              : createMapping.error instanceof Error
                ? createMapping.error.message
                : "Workspace Mapping 保存失败，请检查远端 SSH 和绝对路径。"}
          </small>
        ) : null}
        {selectedProfile?.capabilities.models ? (
          <label>
            <span>Model</span>
            <input
              value={model}
              disabled={!props.mutationsEnabled || !props.canExecute || Boolean(activeRun)}
              onChange={(event) => setModel(event.target.value)}
              placeholder="Provider 模型 ID（可选）"
            />
          </label>
        ) : null}
        {selectedProfile?.capabilities.modes ? (
          <label>
            <span>Mode</span>
            <input
              value={mode}
              disabled={!props.mutationsEnabled || !props.canExecute || Boolean(activeRun)}
              onChange={(event) => setMode(event.target.value)}
              placeholder="Provider mode（可选）"
            />
          </label>
        ) : null}
        {selectedProfile?.capabilities.reasoningEffort ? (
          <label>
            <span>Reasoning / effort</span>
            <input
              value={reasoningEffort}
              disabled={!props.mutationsEnabled || !props.canExecute || Boolean(activeRun)}
              onChange={(event) => setReasoningEffort(event.target.value)}
              placeholder="例如 medium（可选）"
            />
          </label>
        ) : null}
        {selectedProfile?.capabilities.permissionModes ? (
          <label>
            <span>Permission mode</span>
            <select
              value={permissionMode}
              disabled={!props.mutationsEnabled || !props.canExecute || Boolean(activeRun)}
              onChange={(event) => setPermissionMode(event.target.value)}
            >
              <option value="">Provider default</option>
              <option value="default">Default</option>
              <option value="read-only">Read only</option>
              <option value="workspace-write">Workspace write</option>
              <option value="danger-full-access">Danger full access</option>
            </select>
          </label>
        ) : null}
        <label className="task-run-launch__prompt">
          <span>Prompt</span>
          <textarea
            value={prompt}
            disabled={!props.mutationsEnabled || !props.canExecute || Boolean(activeRun)}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="告诉 Provider 这次 Run 要完成什么"
            rows={3}
          />
        </label>
        <button
          className="button button--primary"
          type="button"
          disabled={!canStart || start.isPending || continueRun.isPending}
          onClick={() => (continuationRun ? continueRun.mutate() : start.mutate())}
        >
          {start.isPending || continueRun.isPending
            ? "启动中…"
            : continuationRun
              ? "继续 Run"
              : "启动 Run"}
        </button>
        {profiles.isError ? (
          <p className="task-run-history__error">执行配置加载失败，请到设置中检查。</p>
        ) : null}
        {start.isError || continueRun.isError ? (
          <p className="task-run-history__error">
            执行失败，请检查 Workspace、Connection、Provider 状态或 session 是否仍可恢复。
          </p>
        ) : null}
      </div>

      {activeRun ? (
        <div className="task-run-active">
          <div>
            <strong>{activeRun.executionProfileName ?? activeRun.providerKind}</strong>
            <span>{statusLabel(activeRun.status)}</span>
          </div>
          <button
            className="button"
            type="button"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(activeRun.id)}
          >
            {cancel.isPending ? "取消中…" : "取消 Run"}
          </button>
        </div>
      ) : null}

      {pendingApprovals.length ? (
        <div className="task-run-approvals" aria-label="待处理审批">
          <h3>待处理审批</h3>
          {pendingApprovals.map((approval) => (
            <article key={approval.id}>
              <p>{approval.summary}</p>
              <small>{approval.type}</small>
              <div>
                {approval.type === "user_input" ? (
                  <>
                    <label className="task-run-history__input-label">
                      Answers JSON
                      <textarea
                        rows={3}
                        value={inputDrafts[approval.id] ?? ""}
                        placeholder={'{"question-id":["answer"]}'}
                        onChange={(event) =>
                          setInputDrafts((previous) => ({
                            ...previous,
                            [approval.id]: event.target.value,
                          }))
                        }
                      />
                    </label>
                    {inputErrors[approval.id] ? (
                      <small className="task-run-history__error">{inputErrors[approval.id]}</small>
                    ) : null}
                    <button
                      className="button button--primary"
                      type="button"
                      disabled={respond.isPending}
                      onClick={() => submitInput(approval.id)}
                    >
                      提交输入
                    </button>
                  </>
                ) : (
                  <button
                    className="button button--primary"
                    type="button"
                    disabled={respond.isPending}
                    onClick={() =>
                      respond.mutate({ approvalId: approval.id, decision: { type: "approve" } })
                    }
                  >
                    允许
                  </button>
                )}
                <button
                  className="button"
                  type="button"
                  disabled={respond.isPending}
                  onClick={() =>
                    respond.mutate({
                      approvalId: approval.id,
                      decision: { type: "reject", reason: "用户拒绝" },
                    })
                  }
                >
                  拒绝
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={respond.isPending}
                  onClick={() =>
                    respond.mutate({ approvalId: approval.id, decision: { type: "cancel" } })
                  }
                >
                  取消
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {!runs.data.length ? (
        <p className="task-run-history__empty">这个任务还没有通用执行记录。</p>
      ) : (
        <ol className="task-run-history__list">
          {runs.data.map((run) => (
            <li key={run.id}>
              <div className="task-run-history__run">
                <div>
                  <strong>{run.executionProfileName ?? run.providerKind}</strong>
                  <small>
                    {run.connectionName ?? "未绑定连接"} · {run.workspace ?? "未记录工作区"}
                  </small>
                </div>
                <div>
                  <span>{statusLabel(run.status)}</span>
                  {run.providerThreadId && !activeStatus(run.status) ? (
                    <button
                      className="button button--compact"
                      type="button"
                      onClick={() => {
                        setContinuationRunId(run.id);
                        setProfileId(run.executionProfileId ?? "");
                        setWorkspace(run.workspace ?? "");
                        setModel(run.model ?? "");
                        setReasoningEffort(run.reasoningEffort ?? "");
                        setMode(run.mode ?? "");
                        setPermissionMode(run.permissionMode ?? "");
                      }}
                    >
                      继续
                    </button>
                  ) : null}
                  {run.status === "interrupted" && !run.providerThreadId ? (
                    <button
                      className="button button--compact"
                      type="button"
                      disabled={!props.mutationsEnabled || !props.canExecute || Boolean(activeRun)}
                      onClick={() => {
                        setContinuationRunId(null);
                        setProfileId(run.executionProfileId ?? "");
                        setWorkspace(run.workspace ?? "");
                        setModel(run.model ?? "");
                        setReasoningEffort(run.reasoningEffort ?? "");
                        setMode(run.mode ?? "");
                        setPermissionMode(run.permissionMode ?? "");
                        setPrompt("");
                      }}
                    >
                      新建 Retry
                    </button>
                  ) : null}
                </div>
              </div>
              {run.status === "interrupted" ? (
                <p className="task-run-history__error">
                  服务重启后 Run 未自动重放。
                  {run.providerThreadId
                    ? "可显式 Continue；若远端 session 不可恢复，请新建 Retry。"
                    : "请检查上轮影响后输入新的 prompt 并启动 Retry。"}
                </p>
              ) : null}
              {run.errorSummary ? (
                <p className="task-run-history__error">{run.errorSummary}</p>
              ) : null}
              {run.events.length ? (
                <ul className="task-run-history__events">
                  {run.events.slice(-4).map((event) => (
                    <li key={event.id}>
                      <span>{event.type}</span>
                      <p>{event.summary}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="task-run-history__empty">暂无事件</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
