# DevBoard

<img src="assets/brand/codexboard.png" alt="DevBoard" width="112" />

**简体中文** · [English](README.en.md)

项目控制面：在一个 Web 看板中管理项目、里程碑、任务与远程执行。

**用户指南** · [给 Agent 的操作指南](AGENTS.md)

DevBoard 是运行在 Docker 中的项目控制面。容器提供 Web、API、SQLite、飞书/Lark、Run 与审批；Codex、Cursor、Grok Build、OpenCode 通过 SSH 在 Connection Host 上执行。生产环境的旧 Git/worktree 管理和任务 Git 收尾目前 fail-closed，尚未接入远端 Workspace Mapping。浏览器和飞书使用同一看板与 Run。

主要部署方式为 Docker Compose；镜像目标为 `ghcr.io/404404/devboard`，支持 `linux/amd64` 与 `linux/arm64`。

## 访问方式

|          | Web                      | 飞书                         |
| -------- | ------------------------ | ---------------------------- |
| 打开方式 | 桌面或移动浏览器         | 飞书桌面端或移动端           |
| 登录身份 | Web 账号                 | 自建应用可用范围内的飞书用户 |
| 配置要求 | 外部 HTTPS reverse proxy | 飞书自建应用与外部 HTTPS     |

两种方式可同时启用，共用同一控制面、项目与 Run。

## 可以做什么

- 按项目管理任务，通过仪表盘、看板和列表查看工作，维护状态、优先级、标签、评论和附件。
- 从任务中发起或继续 Codex 执行，查看进度、执行结果和需要你处理的审批。
- 在桌面或移动浏览器中用独立账号访问看板，无需登录飞书；也支持飞书桌面端与移动端。
- 在本机创建、停用 Web 账号或重置密码；Web 用户可作为任务负责人并以自己的身份评论。
- 配置 SSH Host、Provider、Execution Profile 与远程 Workspace Mapping。
- 通过 Web 或飞书查看同一 Run 的事件并处理审批。
- 从手机发送附件和图片、补充执行所需信息，并查看同一 Run 的事件与审批。
- 通过 Web 或飞书统一管理任务与远端 Run；容器不提供本机项目目录语义的 taskctl。

容器不安装 coding CLI，也不挂载 Docker Host 的项目目录或 `~/.codex`。项目路径按 `Project → WorkspaceMapping → SSH Host` 解析。

当前生产模式已阻止旧本机 Git/worktree 和 Git 收尾逻辑访问容器文件系统；这些旧入口需要完成 SSH Workspace Mapping 接线后才会恢复。请勿把旧 Desktop 项目路径或容器内同名目录当作可执行 Workspace。

## 界面预览

### 飞书 · 桌面端与移动端

在飞书自建应用中管理任务。飞书和 Web 使用同一看板、Run 状态、事件与审批。

<table>
  <tr><th>桌面看板</th><th>移动看板</th></tr>
  <tr>
    <td align="center"><a href="docs/images/desktop-taskboard.png"><img src="docs/images/desktop-taskboard.png" alt="桌面看板" width="340" /></a></td>
    <td align="center"><a href="docs/images/mobile-taskboard.png"><img src="docs/images/mobile-taskboard.png" alt="移动看板" height="200" /></a></td>
  </tr>
</table>

### Web · 桌面与移动浏览器

通过 HTTPS 和本机创建的 Web 账号登录。点击缩略图可查看大图。

<table>
  <tr><th>桌面浏览器</th><th>移动浏览器</th></tr>
  <tr>
    <td align="center"><a href="docs/images/web-desktop-redacted.png"><img src="docs/images/web-desktop-redacted.png" alt="桌面浏览器" width="420" /></a></td>
    <td align="center"><a href="docs/images/web-mobile-redacted.png"><img src="docs/images/web-mobile-redacted.png" alt="移动浏览器" height="220" /></a></td>
  </tr>
</table>

## Docker 部署

需要 Docker Engine、Docker Compose，以及一个已准备外部 HTTPS reverse proxy 的域名。执行节点（包括 Docker Host 本机）需要 SSH server、Git 和所选 Provider CLI；这些程序不安装在 DevBoard 容器中。

```sh
cp .env.example .env
mkdir -p secrets/ssh
chmod 700 secrets secrets/ssh
# 编辑 .env：设置 DEVBOARD_PUBLIC_ORIGIN 与实际 reverse proxy 的 DEVBOARD_TRUST_PROXY
docker compose config
docker compose up -d
docker compose ps
```

Compose 默认只发布 `127.0.0.1:47823`，适用于同机 reverse proxy；LAN 上的代理请按 [部署指南](docs/reverse-proxy.md)设置 `DEVBOARD_BIND_ADDRESS` 并限制防火墙。外部代理负责 TLS，DevBoard 生产环境要求显式 HTTPS `DEVBOARD_PUBLIC_ORIGIN`。`DEVBOARD_TRUST_PROXY` 只填写实际代理 IP/CIDR，不能信任所有来源。

首次配置顺序：启动 Compose → 配置 HTTPS reverse proxy 与 Public Origin → 配置飞书 App（可选）→ 创建 SSH Host 并人工确认 Host Key 指纹 → 检测远端 Provider → 创建 Execution Profile → 创建/映射项目远端 Workspace。macOS Docker Host 推荐 `host.docker.internal`；Linux Docker Engine 可用 Compose 提供的 `host-gateway` 映射，或填写 Host LAN IP/DNS。

SQLite、附件、备份、运行状态和受信任 `known_hosts` 保存在 `/var/lib/devboard` 持久化卷。升级镜像不会替换这些数据。旧 macOS Desktop 已弃用，不再作为主要发行物。

## 日常使用

在 DevBoard 创建 Project 和 Task，为每个 SSH Host 配置该 Project 的绝对 Workspace Mapping，再选择 Execution Profile 启动 Run。Run 的状态、事件、审批和 Continue 在 Web 与飞书中共享。更换 Codex/Cursor/Grok/OpenCode Host 不会改变 Project 或 Task。

## 容器内运维命令

备份和验证等运维命令可在容器内通过 `docker exec` 运行；Admin API 仍只监听容器 loopback，不会发布到 Host：

```sh
docker compose exec -T devboard node apps/server/dist/ops.js backup
docker compose exec -T devboard node apps/server/dist/ops.js verify /var/lib/devboard/backups/<backup-id>
# Web 账号密码由 TTY 隐藏读取，不进入命令参数、环境变量或输出
docker compose exec -it devboard node apps/server/dist/ops.js web-account create --username alice --name "Alice"
docker compose exec -T devboard node apps/server/dist/ops.js web-account list
```

旧 `manage-codexboard` Skill/taskctl 依赖 macOS Desktop、本机 cwd 和旧 Job/Git 模型，已弃用，不适用于当前 SSH Run 部署。备份及恢复前请阅读 [运维说明](docs/development.md)。

## 让 Agent 协助安装与配置

需要 Agent 协助部署时，把本仓库的 [AGENTS.md](AGENTS.md)交给它，并说明你要完成的事情，例如：

> 请阅读 AGENTS.md，帮我用 Docker Compose 部署 DevBoard，配置外部 HTTPS reverse proxy 和 SSH Host。需要我核对 Host Key 或在飞书后台确认的步骤，请明确告诉我。

reverse proxy 和 SSH key 配置见 [部署指南](docs/reverse-proxy.md)。不要把 Private Key、App Secret、Web 密码或 runtime capability 写入聊天、命令行参数或 Issue。

## 更新与数据

更新镜像并保留数据卷；升级前可先执行上方的在线备份命令：

```text
docker compose pull
docker compose up -d
```

SQLite、附件和备份位于 Compose named volume `devboard-data`，不要在升级时删除该卷。恢复数据前先使用受支持的备份/恢复运维命令，并确认目标数据目录。

## 访问安全

知道域名不代表能读取看板数据。未登录请求受保护，Web 账号必须由本机创建，飞书入口由飞书身份登录验证。HTTPS 用于加密传输，不能代替账号授权。请妥善保管密码并按需停用账号，不要把域名本身当作访问限制。

## 常见问题

| 现象                        | 先检查什么                                                                        |
| --------------------------- | --------------------------------------------------------------------------------- |
| 容器不能健康启动            | `docker compose logs devboard`；检查 Public Origin、SQLite 持久卷和 migration     |
| Web 登录/secure cookie 失败 | 检查 HTTPS Public Origin、保留的 Host 与实际代理地址是否在 `DEVBOARD_TRUST_PROXY` |
| SSE 没有实时更新            | 关闭 `/api/v1/events` 的代理 buffering/cache，增加 read timeout                   |
| SSH Host 测试失败           | 分别检查 DNS/TCP、Host Key 确认、SSH Agent socket/Identity File 及远端 sshd       |
| Provider 未检测到           | 在目标 SSH Host 安装对应 CLI；DevBoard 镜像不包含这些 CLI                         |
| Workspace/Git 状态不正确    | 核对该项目到所选 Connection 的远端绝对路径映射，不要检查容器内同名路径            |
| 飞书凭据检查通过但登录失败  | 检查 user ID 权限、可信域名、redirect URL、应用发布和可用范围，再从飞书实际登录   |

反馈问题时，请提供 image tag、架构、复现步骤和经过脱敏的日志。不要公开 App Secret、SSH Private Key、登录令牌或完整数据目录。

## 源码与技术资料

开发者可查阅 [架构总览](docs/architecture.md)、[执行平台说明](docs/execution-platform.md)、[Provider 说明](docs/providers.md)、[Docker/reverse proxy 部署](docs/reverse-proxy.md)、[容器验收与预览部署](docs/container-acceptance.md)和 [开发与运维参考](docs/development.md)。旧 Desktop/taskctl 说明只为迁移留档。
