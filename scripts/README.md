# Scripts

此目录同时包含应用运行所需的桥接模块和开发工具。桌面构建按运行模块清单复制，开发工具和测试保留在源码仓库中。

## 运行模块

| 文件                                                    | 用途                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `run-codex-app-server.mjs`                              | 导出后端内嵌桥接入口，同时支持独立桥接调试；桌面生产环境由后端导入，无需另装 launchd 服务 |
| `codex-session-bridge.mjs`                              | 请求路由、鉴权与 Desktop 会话桥接                                                         |
| `codex-desktop-loader.mjs`、`codex-desktop-session.mjs` | Desktop 加载、owner/follower IPC 和会话生命周期                                           |
| `codex-project-snapshot.mjs`                            | 项目状态读取与快照写入，也用于 `npm run dev:project-sync`                                 |
| `codex-remote-image.mjs`、`codex-remote-upload.mjs`     | Remote 图片读取与附件上传                                                                 |
| `codex-remote-queue.mjs`、`codex-remote-review.mjs`     | 待发消息队列与只读代码审查                                                                |
| `codex-task-progress.mjs`、`codex-thread-title.mjs`     | 任务进度与对话标题同步                                                                    |
| `git-origin-reader.mjs`                                 | Git 来源读取                                                                              |

## 开发与验证工具

| 文件或命令                                                  | 用途                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `check-codex-protocol.mjs` / `npm run codex:protocol:check` | 检查 Codex CLI 版本和协议清单                                                                                 |
| `run-e2e.mjs` / `npm run test:e2e`                          | 用临时数据目录及回环端口运行 Playwright，结束后清理临时数据                                                   |
| `fake-codex-app-server.mjs`、`fake-codex-desktop.mjs`       | E2E 的模拟 Codex 与 Desktop IPC，不连接真实用户会话                                                           |
| `*.test.mjs` / `npm run test:scripts`                       | 桥接及脚本回归测试                                                                                            |
| `generate-sf-symbol-assets.m`                               | 在 macOS 上用 AppKit 重新生成前端 SF Symbols 资源，见 [资源说明](../apps/web/src/assets/sf-symbols/README.md) |

桌面构建和桌面专用测试位于 `apps/desktop/scripts/`，入口为 `npm run build:desktop` 和 `node --test apps/desktop/scripts/*.test.mjs`。数据库迁移和备份操作由 `apps/server/src/migrate.ts`、`apps/server/src/ops.ts` 提供，命令见 [根目录说明](../README.md)。
