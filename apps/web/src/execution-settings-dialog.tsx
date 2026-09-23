import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ConnectionView,
  CreateConnectionCommand,
  CreateExecutionProfileCommand,
  ExecutionProfileView,
  UpdateConnectionCommand,
  UpdateExecutionProfileCommand,
} from "@codexboard/contracts";
import {
  createExecutionConnection,
  createExecutionProfile,
  deleteExecutionConnection,
  deleteExecutionProfile,
  readExecutionSettings,
  scanSSHHostKeys,
  testExecutionConnection,
  trustSSHHostKey,
  updateExecutionConnection,
  updateExecutionProfile,
} from "./api";
import { QueryNotice } from "./query-notice";
import { Notice } from "./notification-center";
import { userErrorMessage } from "./user-error";
import { X } from "./icons";

function healthLabel(status: string): string {
  switch (status) {
    case "ready":
      return "可用";
    case "authentication_required":
      return "需要登录";
    case "not_installed":
      return "未安装";
    case "offline":
      return "离线";
    case "error":
      return "错误";
    default:
      return "未检查";
  }
}

export function ExecutionSettingsDialog({
  csrfToken,
  onClose,
}: {
  readonly csrfToken: string;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const [name, setName] = useState("SSH Host");
  const [authMode, setAuthMode] = useState<"identity_file" | "agent">("identity_file");
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [port, setPort] = useState("");
  const [identityRef, setIdentityRef] = useState("");
  const [scannedHostKeys, setScannedHostKeys] = useState<{
    readonly connectionId: string;
    readonly keys: readonly { readonly algorithm: string; readonly fingerprint: string; readonly trusted: boolean }[];
  } | null>(null);
  const [profileName, setProfileName] = useState("SSH Codex");
  const [profileProviderKind, setProfileProviderKind] = useState("codex");
  const [profileConnectionId, setProfileConnectionId] = useState("");
  const [profileDefaultModel, setProfileDefaultModel] = useState("");
  const [profileDefaultMode, setProfileDefaultMode] = useState("");
  const [profileDefaultReasoningEffort, setProfileDefaultReasoningEffort] = useState("");
  const query = useQuery({
    queryKey: ["execution-settings"],
    queryFn: readExecutionSettings,
    refetchInterval: 15_000,
  });
  const createProfile = useMutation({
    mutationFn: (input: CreateExecutionProfileCommand) =>
      createExecutionProfile(input, csrfToken),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["execution-settings"] });
      setProfileName("SSH Codex");
      setProfileDefaultModel("");
      setProfileDefaultMode("");
      setProfileDefaultReasoningEffort("");
    },
  });
  const create = useMutation({
    mutationFn: (input: CreateConnectionCommand) =>
      createExecutionConnection(input, csrfToken),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["execution-settings"] });
      setName("SSH Host");
      setHost("");
      setUsername("");
      setPort("");
      setIdentityRef("");
      setAuthMode("identity_file");
    },
  });

  const invalidateSettings = () => void queryClient.invalidateQueries({ queryKey: ["execution-settings"] });
  const toggleConnection = useMutation({
    mutationFn: (connection: ConnectionView) =>
      updateExecutionConnection(
        connection.id,
        { expectedVersion: connection.version, enabled: !connection.enabled },
        csrfToken,
      ),
    onSuccess: invalidateSettings,
  });
  const editConnection = useMutation({
    mutationFn: (input: { connection: ConnectionView; patch: UpdateConnectionCommand }) =>
      updateExecutionConnection(input.connection.id, input.patch, csrfToken),
    onSuccess: invalidateSettings,
  });
  const testConnection = useMutation({
    mutationFn: (connection: ConnectionView) => testExecutionConnection(connection.id, csrfToken),
    onSuccess: invalidateSettings,
  });
  const scanHostKeys = useMutation({
    mutationFn: (connection: ConnectionView) => scanSSHHostKeys(connection.id, csrfToken),
    onSuccess: (keys, connection) => setScannedHostKeys({ connectionId: connection.id, keys }),
  });
  const trustHostKey = useMutation({
    mutationFn: (input: { connection: ConnectionView; fingerprint: string }) =>
      trustSSHHostKey(input.connection.id, input.fingerprint, csrfToken),
    onSuccess: async (trusted, input) => {
      setScannedHostKeys((current) => current?.connectionId !== input.connection.id ? current : {
        ...current,
        keys: current.keys.map((key) => key.fingerprint === trusted.fingerprint ? trusted : key),
      });
      await queryClient.invalidateQueries({ queryKey: ["execution-settings"] });
    },
  });
  const removeConnection = useMutation({
    mutationFn: (connection: ConnectionView) => deleteExecutionConnection(connection.id, csrfToken),
    onSuccess: invalidateSettings,
  });
  const toggleProfile = useMutation({
    mutationFn: (profile: ExecutionProfileView) =>
      updateExecutionProfile(
        profile.id,
        { expectedVersion: profile.version, enabled: !profile.enabled },
        csrfToken,
      ),
    onSuccess: invalidateSettings,
  });
  const editProfile = useMutation({
    mutationFn: (input: { profile: ExecutionProfileView; patch: UpdateExecutionProfileCommand }) =>
      updateExecutionProfile(input.profile.id, input.patch, csrfToken),
    onSuccess: invalidateSettings,
  });
  const removeProfile = useMutation({
    mutationFn: (profile: ExecutionProfileView) => deleteExecutionProfile(profile.id, csrfToken),
    onSuccess: invalidateSettings,
  });

  const promptConnectionEdit = (connection: ConnectionView) => {
    const nextName = window.prompt("连接名称", connection.name);
    if (nextName === null || !nextName.trim()) return;
    const patch: UpdateConnectionCommand = { expectedVersion: connection.version, name: nextName.trim() };
    const host = window.prompt("SSH Host", connection.host ?? "");
    const username = window.prompt("SSH 用户名", connection.username ?? "");
    const port = window.prompt("SSH 端口（留空使用默认）", connection.port?.toString() ?? "");
    if (host === null || username === null || port === null) return;
    patch.host = host.trim() || null;
    patch.username = username.trim() || null;
    patch.port = port.trim() ? Number(port) : null;
    editConnection.mutate({ connection, patch });
  };

  const promptProfileEdit = (profile: ExecutionProfileView) => {
    const nextName = window.prompt("Execution Profile 名称", profile.name);
    if (nextName === null || !nextName.trim()) return;
    const model = profile.capabilities.models
      ? window.prompt("默认模型（留空清除）", profile.defaultModel ?? "")
      : profile.defaultModel ?? "";
    const mode = profile.capabilities.modes
      ? window.prompt("默认模式（留空清除）", profile.defaultMode ?? "")
      : profile.defaultMode ?? "";
    const effort = profile.capabilities.reasoningEffort
      ? window.prompt("默认 reasoning / effort（留空清除）", profile.defaultReasoningEffort ?? "")
      : profile.defaultReasoningEffort ?? "";
    if (model === null || mode === null || effort === null) return;
    editProfile.mutate({
      profile,
      patch: {
        expectedVersion: profile.version,
        name: nextName.trim(),
        defaultModel: typeof model === "string" ? model.trim() || null : null,
        defaultMode: typeof mode === "string" ? mode.trim() || null : null,
        defaultReasoningEffort: typeof effort === "string" ? effort.trim() || null : null,
      },
    });
  };

  const profileConnections = (query.data?.connections ?? []).filter(
      (connection) => connection.enabled,
  );

  useEffect(() => {
    const availableConnections = (query.data?.connections ?? []).filter(
      (connection) => connection.enabled,
    );
    if (!availableConnections.some((connection) => connection.id === profileConnectionId))
      setProfileConnectionId(availableConnections[0]?.id ?? "");
  }, [profileConnectionId, profileProviderKind, query.data?.connections]);

  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);

  const selectedProvider = query.data?.providers.find((provider) => provider.kind === profileProviderKind);

  const submitProfile = (event: FormEvent) => {
    event.preventDefault();
    if (!profileConnectionId) return;
    createProfile.mutate({
      name: profileName.trim(),
      providerKind: profileProviderKind,
      connectionId: profileConnectionId,
      defaultModel: profileDefaultModel.trim() || null,
      defaultMode: profileDefaultMode.trim() || null,
      defaultReasoningEffort: profileDefaultReasoningEffort.trim() || null,
      environmentRefs: [],
      enabled: true,
    });
  };


  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({
      name: name.trim(),
      type: "ssh_host",
      host: host.trim(),
      port: port.trim() ? Number(port) : null,
      username: username.trim(),
      authMode,
      identityRef: authMode === "identity_file" ? identityRef || null : null,
      capabilities: { providerExecutables: [], protocolModes: [] },
      enabled: true,
    });
  };

  return (
    <dialog
      ref={dialog}
      className="tag-manager-backdrop execution-settings-backdrop"
      aria-labelledby="execution-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!create.isPending && !createProfile.isPending) onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !create.isPending && !createProfile.isPending) onClose();
      }}
    >
      <section className="tag-manager-dialog execution-settings-dialog">
        <header>
          <div>
            <span className="execution-settings-mark" aria-hidden="true">
              ◈
            </span>
            <h2 id="execution-settings-title">执行器与连接</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭执行器设置"
            disabled={create.isPending || createProfile.isPending}
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        {query.isPending ? <p className="execution-settings-empty">正在检查 Provider…</p> : null}
        {query.isError ? (
          <QueryNotice
            error={query.error}
            fallback="执行器设置暂时无法加载。"
            refreshing={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {createProfile.error ? (
          <Notice
            message={userErrorMessage(createProfile.error, "执行配置创建失败，请检查 Provider 和连接。")}
            eventKey={createProfile.error}
          />
        ) : null}
        {create.error ? (
          <Notice
            message={userErrorMessage(create.error, "连接创建失败，请检查配置。")}
            eventKey={create.error}
          />
        ) : null}
        {toggleConnection.error || editConnection.error || testConnection.error || removeConnection.error || scanHostKeys.error || trustHostKey.error ? (
          <Notice
            message={userErrorMessage(
              toggleConnection.error ?? editConnection.error ?? testConnection.error ?? removeConnection.error ?? scanHostKeys.error ?? trustHostKey.error,
              "连接管理操作失败，请刷新后重试。",
            )}
            eventKey={toggleConnection.error ?? editConnection.error ?? testConnection.error ?? removeConnection.error ?? scanHostKeys.error ?? trustHostKey.error}
          />
        ) : null}
        {toggleProfile.error || editProfile.error || removeProfile.error ? (
          <Notice
            message={userErrorMessage(
              toggleProfile.error ?? editProfile.error ?? removeProfile.error,
              "Execution Profile 管理操作失败，请刷新后重试。",
            )}
            eventKey={toggleProfile.error ?? editProfile.error ?? removeProfile.error}
          />
        ) : null}
        {query.data ? (
          <>
            <section className="execution-settings-section" aria-labelledby="provider-status-title">
              <div className="execution-settings-section-title">
                <h3 id="provider-status-title">Provider 状态</h3>
                <button
                  className="button"
                  type="button"
                  disabled={query.isFetching}
                  onClick={() => void query.refetch()}
                >
                  {query.isFetching ? "检查中…" : "刷新"}
                </button>
              </div>
              <ul className="execution-provider-list">
                {query.data.providers.map((provider) => (
                  <li key={provider.kind}>
                    <div>
                      <strong>{provider.displayName}</strong>
                      <small>{provider.kind}</small>
                    </div>
                    <span
                      className={
                        provider.health.status === "ready"
                          ? "execution-health execution-health--ready"
                          : "execution-health"
                      }
                    >
                      {healthLabel(provider.health.status)}
                    </span>
                    <p>{provider.health.message ?? "Provider 已通过能力探测。"}</p>
                  </li>
                ))}
              </ul>
            </section>
            <section className="execution-settings-section" aria-labelledby="connection-list-title">
              <h3 id="connection-list-title">Connections</h3>
              <ul className="execution-connection-list">
                {query.data.connections.map((connection) => (
                  <li key={connection.id}>
                    <div>
                      <strong>{connection.name}</strong>
                      <small>
                        {connection.host ?? "Host 未配置"} · {connection.username ?? "User 未配置"} · {connection.authMode}
                        {connection.authMode === "identity_file" && connection.identityRef
                          ? ` · ${connection.identityRef}`
                          : ""}
                      </small>
                    </div>
                    <span>{connection.status}</span>
                    <label className="execution-credential-select">
                      SSH Credential
                      <select
                        aria-label={`${connection.name} SSH Credential`}
                        value={
                          connection.authMode === "agent"
                            ? "agent"
                            : `identity:${connection.identityRef ?? ""}`
                        }
                        disabled={editConnection.isPending}
                        onChange={(event) => {
                          const selected = event.target.value;
                          const patch: UpdateConnectionCommand = { expectedVersion: connection.version };
                          if (selected === "agent") {
                            patch.authMode = "agent";
                            patch.identityRef = null;
                          } else if (selected.startsWith("identity:")) {
                            const selectedRef = selected.slice("identity:".length);
                            if (!selectedRef) return;
                            patch.authMode = "identity_file";
                            patch.identityRef = selectedRef;
                          } else {
                            return;
                          }
                          editConnection.mutate({ connection, patch });
                        }}
                      >
                        {connection.authMode === "identity_file" && !connection.identityRef ? (
                          <option value="identity:">请选择 Identity</option>
                        ) : null}
                        {connection.authMode === "identity_file" &&
                        connection.identityRef &&
                        !query.data.sshIdentities.some(
                          (identity) => identity.id === connection.identityRef,
                        ) ? (
                          <option value={`identity:${connection.identityRef}`} disabled>
                            {connection.identityRef}（未找到）
                          </option>
                        ) : null}
                        {query.data.sshIdentities.map((identity) => (
                          <option
                            key={identity.id}
                            value={`identity:${identity.id}`}
                            disabled={!identity.usable}
                          >
                            {identity.id}{identity.algorithm ? ` · ${identity.algorithm}` : ""}
                            {identity.usable
                              ? ""
                              : `（不可用：${identity.warning ?? "检查失败"}）`}
                          </option>
                        ))}
                        <option value="agent" disabled={!query.data.sshAgentAvailable}>
                          SSH Agent{query.data.sshAgentAvailable ? "" : "（不可用）"}
                        </option>
                      </select>
                    </label>
                    <div className="execution-settings-actions">
                      <button
                        className="button button--compact"
                        type="button"
                        disabled={editConnection.isPending}
                        onClick={() => promptConnectionEdit(connection)}
                      >
                        编辑
                      </button>
                      <button
                        className="button button--compact"
                        type="button"
                        disabled={testConnection.isPending}
                        onClick={() => testConnection.mutate(connection)}
                      >
                        {testConnection.isPending ? "检查中…" : "测试"}
                      </button>
                      <button
                        className="button button--compact"
                        type="button"
                        disabled={scanHostKeys.isPending || !connection.host}
                        onClick={() => scanHostKeys.mutate(connection)}
                      >
                        {scanHostKeys.isPending ? "扫描中…" : "扫描 Host Key"}
                      </button>
                      <button
                        className="button button--compact"
                        type="button"
                        disabled={toggleConnection.isPending}
                        onClick={() => toggleConnection.mutate(connection)}
                      >
                        {connection.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        className="button button--compact"
                        type="button"
                        disabled={removeConnection.isPending}
                        onClick={() => {
                          if (window.confirm("删除这个连接？正在使用它的 Execution Profile 会阻止删除。")) {
                            removeConnection.mutate(connection);
                          }
                        }}
                      >
                        删除
                      </button>
                    </div>
                    {scannedHostKeys?.connectionId === connection.id ? (
                      <div className="execution-host-key-list">
                        <p>请先在目标主机可信终端核对指纹，再确认信任；扫描结果本身不会自动受信任。</p>
                        {scannedHostKeys.keys.length === 0 ? <p>没有获取到 Host Key，请检查 DNS/TCP。</p> : null}
                        {scannedHostKeys.keys.map((key) => (
                          <div key={key.fingerprint}>
                            <code>{key.algorithm} · {key.fingerprint}</code>
                            {key.trusted ? <span>已信任</span> : (
                              <button
                                className="button button--compact"
                                type="button"
                                disabled={trustHostKey.isPending}
                                onClick={() => {
                                  const confirmed = window.confirm(
                                    `确认已通过可信渠道核对 ${connection.host} 的 ${key.algorithm} 指纹：\n\n${key.fingerprint}\n\n只有确认指纹匹配后才继续。`,
                                  );
                                  if (confirmed) trustHostKey.mutate({ connection, fingerprint: key.fingerprint });
                                }}
                              >
                                确认并信任
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
            <section className="execution-settings-section" aria-labelledby="profile-list-title">
              <h3 id="profile-list-title">Execution Profiles</h3>
              <ul className="execution-profile-list">
                {query.data.profiles.map((profile) => (
                  <li key={profile.id}>
                    <div>
                      <strong>{profile.name}</strong>
                      <small>
                        {profile.providerKind} · {profile.connectionName}
                      </small>
                    </div>
                    <span>{profile.enabled ? "启用" : "停用"}</span>
                    <div className="execution-settings-actions">
                      <button
                        className="button button--compact"
                        type="button"
                        disabled={editProfile.isPending}
                        onClick={() => promptProfileEdit(profile)}
                      >
                        编辑
                      </button>
                      <button
                        className="button button--compact"
                        type="button"
                        disabled={toggleProfile.isPending}
                        onClick={() => toggleProfile.mutate(profile)}
                      >
                        {profile.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        className="button button--compact"
                        type="button"
                        disabled={removeProfile.isPending}
                        onClick={() => {
                          if (window.confirm("删除这个 Execution Profile？运行中的任务会阻止删除。")) {
                            removeProfile.mutate(profile);
                          }
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
            <section className="execution-settings-section">
              <h3>添加连接</h3>
              <form className="execution-connection-form" onSubmit={submit}>
                <label>
                  名称
                  <input value={name} maxLength={160} required onChange={(event) => setName(event.target.value)} />
                </label>
                <button
                  className="button button--compact"
                  type="button"
                  onClick={() => {
                    setName("Docker Host");
                    setHost("host.docker.internal");
                    setPort("22");
                  }}
                >
                  使用 Docker Host 模板
                </button>
                <label>
                  SSH Host
                  <input value={host} maxLength={255} required onChange={(event) => setHost(event.target.value)} placeholder="host.docker.internal 或远端 DNS/IP" />
                </label>
                <label>
                  用户名
                  <input value={username} maxLength={160} required onChange={(event) => setUsername(event.target.value)} />
                </label>
                <label>
                  SSH 端口
                  <input type="number" min="1" max="65535" value={port} placeholder="22" onChange={(event) => setPort(event.target.value)} />
                </label>
                <label>
                  认证方式
                  <select
                    value={authMode}
                    onChange={(event) => {
                      const mode = event.target.value as "identity_file" | "agent";
                      setAuthMode(mode);
                      if (mode === "agent") setIdentityRef("");
                    }}
                  >
                    <option value="identity_file">Identity File（推荐）</option>
                    <option value="agent" disabled={!query.data.sshAgentAvailable}>
                      SSH Agent{query.data.sshAgentAvailable ? "" : "（未检测到可用 Agent）"}
                    </option>
                  </select>
                </label>
                {authMode === "identity_file" ? (
                  <label>
                    Identity Catalog
                    <select
                      value={identityRef}
                      required
                      onChange={(event) => setIdentityRef(event.target.value)}
                    >
                      <option value="">选择已挂载的 SSH Identity</option>
                      {(query.data.sshIdentities ?? []).map((identity) => (
                        <option key={identity.id} value={identity.id} disabled={!identity.usable}>
                          {identity.name}{identity.algorithm ? ` · ${identity.algorithm}` : ""}
                          {identity.fingerprint ? ` · ${identity.fingerprint}` : ""}
                          {identity.usable ? "" : `（不可用：${identity.warning ?? "检查失败"}）`}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : <p>Agent 模式使用容器运行环境显式注入的 SSH_AUTH_SOCK；DevBoard 不读取或保存 Agent 私钥。</p>}
                <button className="button button--primary" type="submit" disabled={create.isPending || createProfile.isPending}>
                  {create.isPending ? "保存中…" : "保存连接"}
                </button>
              </form>
            </section>
            <section className="execution-settings-section">
              <h3>添加 Execution Profile</h3>
              <form className="execution-connection-form" onSubmit={submitProfile}>
                <label>
                  名称
                  <input value={profileName} maxLength={160} required onChange={(event) => setProfileName(event.target.value)} />
                </label>
                <label>
                  Provider
                  <select value={profileProviderKind} onChange={(event) => setProfileProviderKind(event.target.value)}>
                    {(query.data.providers ?? []).map((provider) => (
                      <option value={provider.kind} key={provider.kind}>
                        {provider.displayName} ({provider.kind})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Connection
                  <select value={profileConnectionId} required onChange={(event) => setProfileConnectionId(event.target.value)}>
                    <option value="">选择连接</option>
                    {profileConnections.map((connection) => (
                      <option value={connection.id} key={connection.id}>
                        {connection.name} · {connection.type}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedProvider?.capabilities.models ? (
                  <label>
                    默认模型
                    <input value={profileDefaultModel} maxLength={200} placeholder="Provider 模型 ID" onChange={(event) => setProfileDefaultModel(event.target.value)} />
                  </label>
                ) : null}
                {selectedProvider?.capabilities.modes ? (
                  <label>
                    默认模式
                    <input value={profileDefaultMode} maxLength={80} placeholder="Provider mode" onChange={(event) => setProfileDefaultMode(event.target.value)} />
                  </label>
                ) : null}
                {selectedProvider?.capabilities.reasoningEffort ? (
                  <label>
                    默认 reasoning / effort
                    <input value={profileDefaultReasoningEffort} maxLength={80} placeholder="例如 medium" onChange={(event) => setProfileDefaultReasoningEffort(event.target.value)} />
                  </label>
                ) : null}
                <button className="button button--primary" type="submit" disabled={create.isPending || createProfile.isPending || !profileConnectionId}>
                  {createProfile.isPending ? "保存中…" : "保存 Execution Profile"}
                </button>
              </form>
            </section>
          </>
        ) : null}
      </section>
    </dialog>
  );
}
