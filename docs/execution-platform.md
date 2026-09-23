# DevBoard 执行平台

DevBoard 把项目、任务、执行配置和一次实际执行统一到同一个控制面。任务是业务对象，Run 是一次可追踪的执行，Provider 负责调用具体 Agent，Connection 是 SSH Host，Execution Profile 将 Provider、Connection 和默认参数组合起来。容器不安装 Agent CLI；所有项目目录与 Git 命令都必须属于 SSH Host。

## 核心对象

| 对象 | 作用 |
| --- | --- |
| Project / Task | 项目与待办任务；Task 可以关联 Milestone。 |
| Connection | SSH Host 连接方式：主机、端口、用户、key/agent 认证与可信主机密钥引用；不保存私钥内容。 |
| Execution Profile | Provider + SSH Connection + 默认模型/模式/推理强度。 |
| Workspace Mapping | Project 到 SSH Host 上绝对路径的映射；路径只在目标 Host 上检查。 |
| Run | 一次执行的状态、Provider session、错误、事件和审批记录。 |
| Milestone | 一组任务的交付边界与完成度。 |

Provider 与 Connection 是有意分离的：Provider 表示协议，Connection 表示运行主机。所有当前执行连接都通过 SSH，不提供容器本地执行模式。

## Provider 适配器

当前注册的 Provider 为 Codex、Cursor、Grok 和 OpenCode。注册表先返回能力与健康状态，再由适配器负责创建 session、流式事件、审批、用户输入、取消和恢复。

- Codex：SSH stdio 启动 `codex app-server`，Codex 登录状态留在远端主机。
- Cursor：使用 `agent acp`。
- Grok：使用 `grok agent stdio`。
- OpenCode：使用 `opencode acp`。

Provider 不会因为出现在下拉框中就被标记为在线。Connection 测试会实际执行本机 `--version` 或通过严格 SSH 检查目标命令；不可用时返回未安装、认证、主机密钥或离线错误。

## Connection 类型

唯一 Connection 类型为 `ssh_host`。执行 Docker Host 上的 CLI 也通过 SSH；Docker Desktop 环境可将 `host.docker.internal` 作为连接地址。Linux 可使用 `host-gateway` 映射、LAN IP 或 DNS hostname。

SSH 使用 `BatchMode=yes`、`StrictHostKeyChecking=yes`，不会接受密码交互或自动信任新主机密钥。首次扫描只显示算法和 SHA256 fingerprint；用户确认后才写入 `/var/lib/devboard/ssh/known_hosts`。密钥变化会阻止连接。Identity File 由 Compose 只读挂载到受控目录，Connection 数据库只存 `identityRef`；私钥内容和任意绝对路径都不会进入 API。也支持经过 socket 可用性检查的 SSH Agent，不会静默回退。

## Run 生命周期

典型流程为：

```text
queued -> starting -> running -> succeeded
                         |-> waiting_approval -> running
                         |-> waiting_input    -> running
                         |-> failed / canceled / interrupted / disconnected
```

Provider 的增量消息写入 `run_events`，Run 的最终状态只由服务层推进。终态 Run 不会被迟到的 Provider 消息重新打开；取消时会解除尚未完成的审批等待，并把待处理审批标记为 canceled。

审批和用户输入都使用同一套安全边界：请求详情递归脱敏、长度受限，响应必须校验 Run、Approval 所属关系和当前 pending 状态。拒绝、取消、输入和批准都会留下事件与操作者身份。

## HTTP 接口

主要接口位于 `/api/v1`：

- `GET/POST /execution/settings`、`/execution/connections`、`/execution/profiles`、`/projects/:projectId/workspace-mappings`
- `GET/POST /projects/:projectId/milestones`
- `GET /tasks/:taskId/runs`
- `POST /tasks/:taskId/runs/start`
- `GET /runs/:runId`、`POST /runs/:runId/cancel`、`POST /runs/:runId/continue`
- `GET /runs/:runId/approvals`
- `POST /runs/:runId/approvals/:approvalId/respond`

写操作继续使用现有 CSRF、登录身份和项目访问控制；秘密字段不会通过这些接口回显。

## 生产模式隔离与迁移状态

生产配置中，历史 ProjectRegistry、Git 管理及任务收尾服务会拒绝执行容器本地路径操作。新 Workspace Mapping 的存在不代表所有旧 Git/worktree/UI 路径都已迁移；这些能力应在完成 SSH connection resolver 后再启用。此边界用于避免容器误读同名但不同位置的 `localhost` 路径。

## Docker Host 与远端 Linux

两种场景采用相同的 Host 模型：目标机运行 sshd、Git 与所选 Provider CLI；DevBoard 容器用 SSH 连接后，在目标机工作目录中启动 Codex app-server 或 ACP stdio 进程。Docker Host 也不例外，不把容器内 `localhost` 当作宿主机。

远端 Provider 登录、私钥与项目文件均留在 SSH Host；DevBoard 通过严格验证的 SSH stdio transport 执行命令，不要求安装 DevBoard Worker、开放远端 TCP 端口或挂载用户的 `~/.codex`。

## 数据与安全边界

- Connection/Profile/Run/Approval/事件均落到 SQLite；迁移会把旧 Job 和 Interaction 关联到 Run 历史。
- Provider payload 只保存有限、递归脱敏的数据；token、secret、authorization、私钥和环境变量不会进入事件。
- SSH 命令通过参数数组构造，远端工作区使用 shell 单引号转义；不会把用户输入拼进未转义的命令。
- 所有执行都必须经过已启用的 Profile、可用的 Connection 和可解析的 Workspace；服务层不信任前端传来的 Provider 状态。
