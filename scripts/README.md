# Scripts

此目录包含遗留 Desktop bridge、应用辅助模块和开发工具。容器化 DevBoard 不启动 Desktop IPC bridge；相关脚本仅为兼容和迁移保留。

## 运行模块

| 文件                                                    | 用途                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `run-codex-app-server.mjs`                              | 遗留 Desktop bridge 入口；容器化服务不导入或启动              |
| `codex-session-bridge.mjs`                              | 遗留的请求路由、鉴权与 Desktop 会话桥接                       |
| `codex-desktop-loader.mjs`、`codex-desktop-session.mjs` | 遗留 Desktop 加载、owner/follower IPC 和会话生命周期          |
| `codex-project-snapshot.mjs`                            | 可选的旧版 Codex Desktop 项目快照导入工具；不属于容器运行依赖 |
| `codex-remote-image.mjs`、`codex-remote-upload.mjs`     | Remote 图片读取与附件上传                                     |
| `codex-remote-queue.mjs`、`codex-remote-review.mjs`     | 待发消息队列与只读代码审查                                    |
| `codex-task-progress.mjs`、`codex-thread-title.mjs`     | 任务进度与对话标题同步                                        |
| `git-origin-reader.mjs`                                 | Git 来源读取                                                  |

## 开发与验证工具

| 文件或命令                                                  | 用途                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `check-codex-protocol.mjs` / `npm run codex:protocol:check` | 检查 Codex CLI 版本和协议清单                                                                                 |
| `run-e2e.mjs` / `npm run test:e2e`                          | 用临时数据目录及回环端口运行 Playwright，结束后清理临时数据                                                   |
| `fake-codex-app-server.mjs`                                 | E2E 的模拟 Codex App Server，不连接真实用户会话                                                               |
| `fake-codex-desktop.mjs`                                    | 遗留的 Desktop IPC 测试 fixture；容器化 E2E 不启动它                                                          |
| `*.test.mjs` / `npm run test:scripts`                       | 桥接及脚本回归测试                                                                                            |
| `generate-sf-symbol-assets.m`                               | 在 macOS 上用 AppKit 重新生成前端 SF Symbols 资源，见 [资源说明](../apps/web/src/assets/sf-symbols/README.md) |

Desktop 源码保留作 legacy/deprecated 兼容，不属于主要运行和发布路径。数据库迁移和备份操作由 `apps/server/src/migrate.ts`、`apps/server/src/ops.ts` 提供，命令见 [根目录说明](../README.md)。
