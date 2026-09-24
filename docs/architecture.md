# DevBoard 架构

> 部署基线：DevBoard 作为单容器 Control Plane 运行。本文以容器 + 外部反向代理 + SSH Host 为准；Tauri Desktop 是 legacy，不属于主要运行或发布路径。

DevBoard 是 Project-centric AI Coding Orchestration Board。Project、Task、Milestone、Run、Approval、Artifact 与 Timeline 属于控制面；Codex、Cursor、Grok Build、OpenCode 通过 Provider 适配器作为执行层。

## 运行关系

```text
Web / Feishu H5
      -> Project Control Plane
      -> Execution Router
      -> Execution Profile
      -> Provider + Connection
      -> Run / Events / Approvals
```

- `Project` 是 DevBoard 的 canonical source，不依赖 Codex Desktop 项目文件。
- `Task` 是工作项，不等于 Agent Thread。
- `Run` 是一次执行，保存 Provider session、Connection、Workspace、状态、事件和审批。
- `ExecutionProfile` 组合 Provider、Connection、默认模型/模式/effort 与 Workspace root。
- `WorkspaceMapping` 把 Project 和 Connection 映射到该机器上的绝对路径。
- Web 与 Feishu H5 使用同一套身份、任务、Run、Approval 和 SSE 事件服务。

## Channel 与公共入口

Web 和 Feishu 是同一控制面的两个 Channel。DevBoard 只提供 HTTP API 与静态 Web；TLS 和公网入口由外部标准反向代理负责。`DEVBOARD_PUBLIC_ORIGIN` 必须显式配置，`DEVBOARD_TRUST_PROXY` 仅信任明确的代理 IP/CIDR。Admin API 仍只监听容器 loopback，Compose 不发布其端口。详见 [反向代理部署](./reverse-proxy.md)。

## 主机边界

```text
Browser / Feishu -> External HTTPS Proxy -> DevBoard Container
                                           -> SSH -> Docker Host / Remote Host
```

容器不是执行节点。Project 是数据库实体；实际目录只通过 `WorkspaceMapping(Project, SSH Connection) -> absolute remote path` 指定。生产模式中的旧本地 ProjectRegistry、Git 面板和 Git 收尾入口现为 fail-closed，直到它们完整接入远程映射；不得将容器 `localhost` 或容器文件系统当作用户主机。

## 兼容边界

现有 `@codexboard/*` 包名、CodexBoard 数据目录和内部 Bundle ID 暂时保留，作为升级兼容边界；用户可见名称和新打包产物使用 DevBoard。
