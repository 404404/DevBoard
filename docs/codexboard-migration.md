# CodexBoard → DevBoard 迁移说明

当前产品名称统一为 **DevBoard**，发布仓库为 `404404/DevBoard`。`CodexBoard` 仅保留在运行时兼容边界中，避免升级时丢失已有数据、浏览器会话和 Agent Skill。

| 项目           | 新名称                                      |
| -------------- | ------------------------------------------- |
| macOS 应用     | `DevBoard.app`；升级器也接受旧的 `CodexBoard.app`        |
| 主程序         | `codexboard-desktop`                        |
| Bundle ID      | `cn.rocyan.codexboard.desktop`              |
| npm 命名空间   | `@codexboard/*`                             |
| 环境变量       | `CODEXBOARD_*`                              |
| 随包技能       | `manage-codexboard`                         |
| 默认数据目录   | `~/Library/Application Support/CodexBoard/`（稳定兼容路径） |
| CLI 会话目录   | `~/.config/codexboard/`                     |
| 浏览器存储前缀 | `codexboard:`                               |
| 发布仓库       | `404404/DevBoard`                            |

## 升级与数据保留

安装新版前正常退出旧应用，保留完整数据目录。DevBoard 继续使用 `~/Library/Application Support/CodexBoard/` 作为稳定数据路径。新版首次启动会原子移动唯一的旧版默认目录（`Lark-Codex` 或更早的 `Lark Codex Taskboard`），数据库、WAL、附件、配置与权限一起保留。检测到新旧目录同时存在、符号链接或旧进程持锁时停止迁移，不合并、不覆盖。

源码 checkout 路径由用户或宿主管理，应用不重命名已有项目工作目录、不接管 Codex 会话。

## v0.1.11 到容器控制面

当前主部署是 Docker Compose，不再启动 FRP、Caddy child process 或本机 Codex bridge。升级时保留原数据与 `frpc.toml` 等文件，但新服务忽略它们；不要把 Desktop 上的本地 Codex Profile 映射成容器 localhost。无法自动确认 SSH Host 的旧本机 Profile 应显示为“Configuration Required”，待用户创建 Docker Host SSH Connection 后再关联。不要把 `~/.codex`、`~/.cursor` 或 SSH 私钥目录作为容器运行的必需挂载。

如果升级的是曾试用过的 SSH Connection 草案版本，旧 Connection 中保存的 Identity File 绝对路径不会自动转换成 `identityRef`。数据库迁移会移除旧路径、停用该 key-based Connection 并标记为 `Configuration Required`；请先在 Compose 中挂载受控 Identity Catalog，再从 Web 下拉框重新选择身份。不会从旧路径读取或复制私钥。

旧数据库中的 projects、tasks、comments、attachments、identities、labels 与历史执行记录由 SQLite migration 保留。实际远程目录应由 `Project -> WorkspaceMapping -> SSH Connection` 建立；容器路径不会作为 Project 的 canonical workspace。

## 必要的旧名称引用

旧品牌仅保留在兼容边界及相应测试和本说明中：

- 环境变量输入接受 `LARK_CODEX_*` 和 `LARK_TASKBOARD_*`；新变量优先，其次为最近一代旧变量。显式空值也优先，随后由配置校验拒绝。
- CLI 读取匹配当前服务的旧授权记录；显式的新记录、包括无效记录，不回退。退出授权会清理对应作用域的全部代际记录。
- 浏览器偏好读取两代旧键，写入只使用新键。Cookie 不混用不同代际的身份与 CSRF，退出时清理全部代际的 Cookie。
- 更新包保留 `lark-codex-desktop` 和 `taskboard-desktop` 两个小型转发入口；主程序接收旧更新重启标记并等待实例锁释放。更新签名公钥不变，发布脚本可以读取旧目录中的既有签名密钥，不复制密钥进仓库。
- 已安装的 `manage-lark-codex` 或 `manage-lark-taskboard` 技能由原管理工具处理，避免覆盖用户修改或安装重复技能。
- 现有 `manage-codexboard` 技能名称、`@codexboard/*` 包名和 `CODEXBOARD_*` 环境变量继续有效；它们是稳定接口，不随可见品牌改名。
- 旧任务附件命令的默认数据路径可在目录已完成迁移后解析到新版；命令中的旧应用安装路径仍要求对应应用路径可用。历史任务内容不会被批量改写，建议使用新版 taskctl 重新查询附件。

飞书产品本身的 SDK 地址、客户端标识与 User-Agent 中的 `Lark` 保留，它们不是本项目的旧名称。

## 图标

最终图标包含不透明白色方形底板、深色结形及薄荷绿卡片。桌面、网页、收藏图标及文档使用同一图源；资源与生成说明见 [品牌资源](../assets/brand/README.md)。
