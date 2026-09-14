# Codex 桌面执行桥接

远程页读取既有对话只使用 Desktop follower，不使用下面的辅助读取路径。安装和日常使用见[用户指南](../README.md)。

看板的模型回合统一由 Codex Desktop 执行。`thread/resume`、`turn/start`、`turn/interrupt` 只通过桌面的 owner/follower IPC，不再尝试用独立 App Server 恢复或执行会话。

创建空对话时仍使用短时 `codex app-server --listen stdio://`：`thread/start` → `thread/section/move`（`sectionId: null`）持久化 → 关闭创建进程并等待退出 → 返回原 Thread ID 和 cwd。命名、读取和归档使用短时辅助进程；目录创建、模型列表及 Git 管理所需的 `command/exec` 走受限控制通道。其他 RPC 拒绝转发，通知也不能绕过回合路由。

首次发送或继续执行先发现桌面 owner。没有就绪的 owner 时，macOS 通过参数数组执行 `/usr/bin/open codex://threads/<uuid>`，然后重新发现并订阅，整个加载阶段最多等待 20 秒。加载器只重试连接，不发送或重发回合。新建 ID 在加载之前已经返回；桌面加载失败可用原 ID 重试，不需要另建对话。实际回合请求保留独立的 5 秒响应截止时间。

正常完成、取消或断开看板连接时只结束 IPC 跟随，不终止桌面。辅助操作的 20 秒截止时间之外预留最多 5 秒关闭子进程；不删除锁文件，不移动历史文件。同一连接对同一 Thread 的操作串行，避免重复连接和释放/恢复竞态。重新连接后的取消会绑定指定 Turn ID，并等待该原回合的明确终态。

桥接为审批请求重写临时 RPC ID，将答复送回原桌面订阅，避免多会话请求 ID 冲突。生产入口使用回环 WebSocket 和 Capability Token，拒绝浏览器 Origin；本地托管入口使用权限为 `0600` 的 Unix Socket。

## 兼容边界

实测基于本机 Codex CLI / Desktop 0.153.4。IPC 是内部版本化接口：状态流版本 11，启动回合版本 2，针对指定 Turn ID 的取消版本 4。兼容 legacy `turns` 和 canonical `turnHistory.history.entitiesByKey`，按 revision 应用 Immer patches。桌面升级造成协议不兼容时明确失败，不回退到独立模型进程。

桌面尚未就绪会返回可重试的连接错误；忙碌会拒绝重复启动。回合提交或审批送达结果不明时不自动重发，`taskboard/sessionLost` 使作业以 `CODEX_OUTCOME_UNKNOWN` 结束。原始诊断不会直接暴露给用户。自动深链接加载要求桥接运行在 macOS 用户会话中；容器应连接 macOS 宿主桥，不能在容器内加载桌面应用。锁屏、冷启动和多窗口并发行为仍需后续验收。

## 验证与发布

回归测试覆盖创建后写锁释放、原 ID 桌面接续、加载一次与有界失败、审批 ID 隔离、取消恢复及 Token/Origin 检查。浏览器 E2E 使用隔离的模拟 Desktop IPC 服务，不访问用户桌面。

当前桌面版由后端通过 `embedded-bridge.ts` 加载 `run-codex-app-server.mjs` 的桥接入口，应用统一管理后端、Caddy 与 frpc。执行 `npm run build:desktop` 将后端、桥接模块及所需 Node 依赖一起放入应用，替换整个 `Lark-Codex.app` 完成更新；不再使用独立 launchd 桥接或容器镜像更新流程。具体安装和验证见 [桌面应用说明](../apps/desktop/README.md)。

更新前确认没有执行中或等待审批/输入的看板作业，再正常退出 Lark-Codex、替换应用并重新启动。保留 Application Support 下的配置、数据库与附件，不关闭 Codex Desktop 或迁移其会话。桥接改动需要重新构建并替换应用，仅修改源码目录不会更新已安装版本。

## 对话评论

`codex.agent_message` 事件保存完整文本，执行日志摘要仍限制为 2,000 字。任务工作区从去重事件生成只读 Codex 评论，支持 Markdown/Mermaid 和实时刷新；历史事件回退使用摘要，旧日志中已经截断的部分无法恢复。普通用户评论限制为 100,000 字。

## 临时任务的目录契约

旧版在 `$CODEX_HOME/taskboard/recent/<uuid>` 创建目录，但桌面不会仅凭名称 `recent` 判断无项目任务。0.153.4 根据持久化归属或 `Documents/Codex/YYYY-MM-DD/<name>` 目录布局识别 projectless；缺失标识的外部会话可能按项目上下文恢复。

新临时任务在 `LARK_TASKBOARD_TEMPORARY_PROJECT_ROOT/YYYY-MM-DD/task-<uuid>` 中创建，页面顶部也使用同一根目录。桌面应用从当前用户主目录推导 `~/Documents/Codex`，创建任务时自动创建所需目录，不读取 `production.env` 中的路径配置，不再从 `CODEX_HOME` 推导。源码开发可使用 `LARK_TASKBOARD_TEMPORARY_PROJECT_ROOT` 覆盖默认根目录；项目任务仍使用项目的执行目录。

既有任务继续使用已绑定的工作目录，不强制搬移用户文件。
