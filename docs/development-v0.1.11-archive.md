# Archived v0.1.11 development and Desktop operations guide — not current deployment guidance

[用户指南](../README.md) · [Agent 操作指南](../AGENTS.md)

> 本文保留了 v0.1.11 macOS Desktop 工作流的历史说明，不适用于当前产品部署。下方 Desktop/本机执行章节只用于迁移排查，不得作为当前实现或部署指引。当前部署入口是 [Docker 与反向代理指南](reverse-proxy.md)；生产项目与 Git 路径只在 SSH Host 上解析。

本文面向持有源码的开发者。下方命令均在源码仓库根目录执行；安装发布版无需克隆源码或执行构建命令。

DevBoard 是以 Docker Compose 运行的 Project Control Plane。容器负责 HTTP、Web、飞书、SQLite、Runs、事件与审批；Agent CLI、Git 和项目工作目录位于 SSH Host。

## 源码开发环境

- Node.js 22+
- npm 10+

普通部署用户无需安装 Node.js 或 npm；Tauri Desktop 源码已弃用，仅保留迁移参考。

## 开发命令

```bash
npm install
CODEXBOARD_DATA_DIR="$PWD/.data" npm run dev
```

- Web：<http://localhost:5173>
- API：<http://localhost:47823/api/health>
- 本机管理监听器：`127.0.0.1:47824`（仅接受运行时 capability，不向浏览器开放）

上述开发命令显式使用仓库内独立的 `.data`，避免连接已安装应用的数据目录。服务成功启动后会生成权限为 `0600` 的 `.data/run/runtime.json`。本地工具通过该文件发现业务/管理端口和短期运行时 capability；不要复制、提交或记录其中内容。

生产中的项目工作区属于 SSH Host，必须通过 `Project → WorkspaceMapping → Connection` 解析。开发模式保留的本地 ProjectRegistry 不代表生产容器可以访问这些路径；不要将远端路径交给本地 `fs` 或 `git`。

业务端提供项目列表、项目看板、任务详情及任务创建、编辑、移动、归档和恢复接口。所有写请求都需要有效会话、`X-CSRF-Token` 与 `Idempotency-Key`；编辑、移动、归档和恢复还必须携带当前 `expectedVersion`，版本冲突会返回 `VERSION_CONFLICT` 和可安全重试的当前任务摘要。

Run 通过 SSH 在目标 Host 启动 Codex App Server 或 ACP stdio 进程。SQLite 持久化 Run、事件、审批和远端 session 标识。容器重启后无法证明远端 CLI 是否仍在执行时，Run 标记为 `interrupted`，不自动重放 prompt；必须由用户明确 Continue 或 Retry。

Codex 协议基线固定为 `codex-cli 0.154.0`，`npm run codex:protocol:check` 会重新生成官方 Schema 并检查所用方法和决定是否漂移。可用 `CODEXBOARD_CODEX_COMMAND` 覆盖应用测试环境的可执行文件；协议检查使用 PATH 中的 `codex`。

`GET /api/v1/events?projectId=<id>&afterRevision=<revision>` 返回项目范围的修订事件页；带 `Accept: text/event-stream` 时建立 SSE。浏览器重连可通过 `Last-Event-ID` 补读断线期间的修订；收到 `refresh-required` 表示游标已超出历史窗口或领先于当前数据库，必须全量刷新项目数据。SSE 使用注释心跳和 `cursor` 事件推进没有项目变更时的全局游标，并禁用代理缓冲。

事件历史窗口、心跳、重试和慢连接写超时可分别通过 `CODEXBOARD_EVENT_HISTORY_LIMIT`、`CODEXBOARD_SSE_HEARTBEAT_MS`、`CODEXBOARD_SSE_RETRY_MS` 和 `CODEXBOARD_SSE_WRITE_TIMEOUT_MS` 调整。

首次启动会自动执行数据库迁移，也可以显式运行：

```bash
npm run db:migrate
```

现有数据库在应用新迁移前会自动生成 `pre-migration-*` 一致性备份。运行中的服务可通过 `docker exec` 在容器内调用 ops CLI；在线备份通过未发布的 loopback Admin API 请求服务内备份执行器：

```bash
docker compose exec -T devboard node apps/server/dist/ops.js backup
```

备份校验可在容器内执行：

```bash
docker compose exec -T devboard node apps/server/dist/ops.js verify /var/lib/devboard/backups/<backup-id>
```

备份包含 SQLite 一致性快照、附件副本和 SHA-256 清单。恢复会替换持久数据，必须先停止服务、核实备份与目标卷，并遵循当前版本支持的恢复流程；不要在运行中的容器上直接覆盖 SQLite 文件。

## 旧版 Desktop 部署（已弃用）

以下生产部署、端口设置、本机 Codex、macOS 桌面、DMG 与签名说明仅供排查旧安装目录，不是当前安装流程。新的部署步骤请使用 [Docker 与反向代理指南](reverse-proxy.md)。

<!-- Legacy v0.1.11 Desktop details retained below for data-migration reference. -->

## 旧版 v0.1.11 部署细节（不再支持）

通过 DevBoard 应用管理服务，配置保存在 Application Support 目录。飞书 App ID 与 App Secret 保存在 `secrets/feishu-credentials.json`；公共访问模式可选择内置 FRP、外部反向代理或本机访问。内置 FRP 从 `secrets/frpc.toml` 读取入口，外部反向代理使用明确填写的 Public Origin，本机模式不启动 Caddy 或 frpc。数据、证书和密钥路径由应用自动生成。配置示例见 `deploy/desktop/`。详见 [公共访问模式](public-access.md) 和 [外部反向代理](external-reverse-proxy.md)。

在应用「连接配置」页面保存 App ID、App Secret、公共访问模式和对应配置；「端口设置」页面管理后端、本机管理、Codex 桥接和 Caddy 本机端口。本机四个端口保存在自动部署目录的 `ports.json`，内置 FRP 的服务端口沿用 `frpc.toml` 的 `serverPort`，端口页面不显示或修改该值。修改 Caddy 端口时，仅内置 FRP 模式同步对应隧道的 `localPort`。内部路径和桥接参数由应用生成；外部反向代理负责公网 TLS，本机模式不启动 Caddy 或 frpc。

保存配置只更新本地文件，实际内容变化后才提示「立即重启」或「稍后手动重启」；内容未变时显示「配置未更改」，不新增重启提醒。选择稍后时，运行中的服务继续使用原配置；下次重启后才启用已保存的配置。启动时读取已有配置不会被视为修改。

应用面向已安装 Codex 的用户，直接使用本机 Codex 状态。macOS 临时任务目录由当前用户主目录自动推导为 `~/Documents/Codex`，创建临时任务时自动创建所需目录，无需手工设置。

任何通过飞书登录验证的账号都可以直接使用同一看板，无需管理员初始化、成员登记或项目授权。用户身份仅由服务端成功验证的飞书登录产生，不提供手工创建用户的入口。新任务负责人固定为当前登录的飞书用户，详情显示任务实际负责人；不能指定其他用户或清空负责人。安装与构建步骤见 [桌面应用说明](../apps/desktop/README.md)。

## 评论执行与任务收尾

评论作者只显示真实飞书用户或 Codex。用户在看板直接评论，或要求 Codex 通过已授权的 taskctl 会话代写评论，都署该飞书用户；Codex 执行过程和结果由执行事件自动同步并署 Codex。调用方不能自行指定作者，也不能通过普通评论接口伪造 Codex 结果。

评论在 Codex 成功结束后按提交时的版本确认“已执行”。运行中编辑过的评论、新评论和失败或取消的评论继续保留为待执行。取消后再次执行会发送当前有效评论和被替代版本的说明，并要求检查上轮已产生的文件改动；取消不会自动回滚文件。

任务详情的“取消任务”会先等待 Codex 停止。“任务完成”检查待执行评论和活动执行后，只读取 Git 状态：main 主工作树任务要求 Git 干净；独立工作树或分支任务还要求任务工作树目录、Git worktree 登记与任务分支均已删除。检查包含已暂存、未暂存和未跟踪文件，不把忽略文件当成脏状态；不自动提交、删除任何文件或写入 Git 引用，也不依赖交付记录、合并证明。非 Git 任务保留原文件。

任务分支从已保存的开发上下文、相同工作目录的执行信息或历史检查快照读取，不从目录名猜测。失败检查不会阻止用户管理 Git 资源，重试时重新读取真实状态，包括旧版失败的收尾请求。点击完成后详情页保持显示检查进度；只有操作成功且任务状态更新为已完成时才返回看板，失败留在详情页显示原因。Git 检查在后台以只读命令执行，无需通过 Codex 发起执行。

## 质量检查

```bash
npm run verify
npm run test:e2e
npm run codex:protocol:check
node --test apps/desktop/scripts/*.test.mjs
```

上述测试使用模拟服务和独立测试数据；`npm test` 会先构建测试所需的共享协议与 CLI。工作区允许列表在启动服务时从 Codex Desktop 项目列表读取。

## 本机命令行

运行 `node packages/taskctl/dist/cli.js --help` 查看命令。完整参数与操作示例见 [taskctl 命令参考](taskctl.md)。

## macOS 桌面应用

Tauri 应用打开时启动服务，关闭窗口后保留菜单栏并继续运行，彻底退出时停止服务。当前支持 Apple Silicon，详见 [桌面应用说明](../apps/desktop/README.md)。

## 项目目录与发布范围

| 目录                                       | 用途                                                                |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `apps/desktop/`                            | Tauri 桌面界面、服务管理与 macOS 打包脚本                           |
| `apps/server/`、`apps/web/`                | 后端服务与飞书 H5 前端                                              |
| `packages/contracts/`、`packages/taskctl/` | 共享协议与命令行客户端                                              |
| `scripts/`                                 | 桥接运行模块、开发与验证工具，详见 [脚本索引](../scripts/README.md) |
| `deploy/desktop/`                          | 不含真实凭据的配置示例                                              |
| `e2e/`、各模块测试文件                     | 回归测试源码，保留用于后续维护                                      |
| `docs/`                                    | 功能与开发说明；公开发布不含个人记忆、历史验收或部署记录            |
| `skills/manage-codexboard/`                | 通过 taskctl 管理看板的配套 Skill                                   |

执行 `npm run build:desktop` 生成 `apps/desktop/dist/DevBoard.app`。发布只分发构建后的应用，不复制整个工作目录。当前脚本不自动生成 DMG，也尚未配置 Developer ID 签名和公证，详见 [构建与分发](../apps/desktop/README.md#构建)。

`node_modules/`、各包 `dist/`、桌面 `.cache/` 和 Rust `target/` 是依赖或可重建产物；`coverage/`、`test-results/`、`playwright-report/` 是测试输出。仓库 `.data/` 和应用的 `~/Library/Application Support/CodexBoard/` 可能包含实际数据库、附件与凭据，不属于通用缓存清理范围，也不应随应用分发。

## 发布带应用内更新的 macOS 版本

应用使用 Tauri 更新器，更新地址固定为 GitHub 最新正式 Release 的 `latest.json`。安装包中的公钥校验更新归档的签名；更新签名与 Apple Developer ID 签名、公证相互独立。

发布前同步修改根 `package.json`、`apps/desktop/src-tauri/Cargo.toml` 和 `apps/desktop/src-tauri/tauri.conf.json` 的应用版本。新版本号必须高于已发布版本。保持应用 identifier 和更新公钥不变。

发布者的更新私钥保存在源码仓库外，默认位置为 `~/.config/codexboard/release/updater.key`，权限为 `0600`，相邻 `.pub` 文件须与应用配置一致。此私钥不得加入仓库、安装包、日志或 GitHub Release；丢失后无法继续为已安装应用签发它所信任的更新。更换公钥需要另行安排兼容迁移。

在 Apple Silicon Mac 上执行：

```sh
npm ci
npm run verify
npm run release:desktop
```

`release:desktop` 会构建应用、归一化本机构建路径、附带许可证，生成并验证 DMG、签名更新归档和 `latest.json`。它会用与更新器相同的算法验证签名，并确认篡改归档无法通过验证。签名验证工具仅用于构建，不进入安装包。

可用 `TAURI_SIGNING_PRIVATE_KEY_PATH` 指定其他仓库外私钥路径；有密码的私钥可通过 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 提供密码，不要把密码写进命令历史。`CODEXBOARD_RELEASE_NOTES_FILE` 可指定 UTF-8 更新说明文件。

每个版本的 Release 必须附带同一次构建的五个文件：

- `DevBoard-版本号-macos-arm64.dmg`
- 对应 `.dmg.sha256`
- `DevBoard-版本号-macos-arm64.app.tar.gz`
- 对应 `.app.tar.gz.sig`
- `latest.json`

将该版本标记为 GitHub 的 Latest Release，且不要标记为 pre-release，否则 `/releases/latest/download/latest.json` 不会指向它。可在标题和说明中注明产品仍处于预览阶段。发布后核对 `latest.json` 的版本、下载地址、签名与实际附件一致；不要混用不同构建的签名或归档。

普通用户初次安装下载 DMG；应用内更新器使用 `.app.tar.gz`。更新器先下载并验证，只有用户确认安装后才停止本机服务、替换应用并重启；数据目录继续保留。下载失败可重试，无法自动安装时可使用同版本 DMG 手动替换。

## 界面字体与控件规范

新增或修改功能时，沿用项目已有字体层级和公共控件样式。字体家族继承全局设置；按钮使用 `.button` / `.icon-button`，控件文字使用 `var(--control-font-size)`，不要为同类操作另设字号。标题、正文和辅助信息参照所在页面的既有层级，避免直接使用浏览器默认字号。图片预览等通过 Portal 渲染的弹窗也须显式复用这些样式，并验证桌面和窄屏布局。
