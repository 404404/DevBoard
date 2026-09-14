# taskctl 命令参考

`node packages/taskctl/dist/cli.js --help` 可以在服务未运行时查看全部命令。
构建：`npm run build -w @lark-taskboard/taskctl`。运行时从
`LARK_TASKBOARD_DATA_DIR/run/runtime.json` 读取本机管理地址和能力令牌；默认数据目录为当前目录下的 `.data`。
所有业务操作通过受保护的本机 HTTP 接口执行，结果保持 JSON 格式。退出码：0 成功、1 服务或运行错误、2 用法错误。

| 功能                   | 命令                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| 工作目录和项目识别     | `context`                                                                                |
| 健康、备份             | `health`、`backup create`                                                                |
| 项目及开发上下文       | `project list`、`project scan ID`                                                        |
| 项目概览、任务创建选项 | `project dashboard ID`、`project options ID`                                             |
| 任务                   | `issue list/get/create/update/move/reassign/archive/restore/delete/read`                 |
| 异步完成或取消         | `lifecycle request TASK_ID --version N --status done或canceled`、`lifecycle get TASK_ID` |
| 评论                   | `comment add/update/delete`，用户代理评论署登录用户；执行结果自动署 Codex                |
| 父子、阻塞与相关任务   | `relation add/delete`                                                                    |
| 附件                   | `attachment upload/download/delete`                                                      |
| Codex 执行与详情       | `job list/get/start/continue/cancel`                                                     |
| 审批与输入             | `interaction list/respond`                                                               |
| 全局标签               | `label list/create/update/delete/order`                                                  |
| Git 分支与工作树       | `git list/create/delete --project ID`                                                    |
| 增量事件               | `events list --project ID --after REVISION --limit 100`                                  |
| 身份只读审计           | `member audit`                                                                           |

具体必填参数以 `--help` 为准。项目由 Codex 同步，CLI 不提供项目创建、注册、更新和归档。
`issue get` 返回任务工作区，包含评论、附件、关联、活动和执行信息。
`issue read` 标记当前已登录飞书用户的已读状态。

## 任务与版本

```bash
node packages/taskctl/dist/cli.js issue get TASK_ID
node packages/taskctl/dist/cli.js issue update TASK_ID --version 3 --due null --labels "" --description ""
node packages/taskctl/dist/cli.js issue archive TASK_ID --version 4
node packages/taskctl/dist/cli.js issue restore TASK_ID --version 5
```

更新时 `--start null`、`--due null`、`--context null` 清空对应字段。负责人不能清空。
`--labels ""` 清空标签，`--description ""` 清空描述。未传入的字段保持不变。
版本必须来自最近一次读取；409 冲突后重新读取并决定后续操作，CLI 不自动重试。

`issue move ... --status done` 和 `canceled` 等待生命周期操作结束。
`lifecycle request` 提交后立即返回操作状态，可用 `lifecycle get` 查询阶段和错误。
完成、取消、删除和 Git 操作都保留现有业务限制；`done` 仍须用户明确验收。
归档隐藏任务；恢复也适用于恢复已取消任务；删除不可由 `restore` 撤销。

## 评论

用户可以要求 Codex 通过已经配对授权的 CLI 会话代写评论，作者固定为该会话的飞书用户：

```bash
node packages/taskctl/dist/cli.js comment add --task TASK_ID --body "补充这项需求"
node packages/taskctl/dist/cli.js comment add --task TASK_ID --body "附上资料" --attachments ATTACHMENT_ID
node packages/taskctl/dist/cli.js comment update COMMENT_ID --version 1 --body "修改后的需求"
node packages/taskctl/dist/cli.js comment delete COMMENT_ID --version 2
```

评论写入需要有效飞书用户会话，只有本机能力令牌时不能写入。命令不接受自定义作者或 `source` 参数；修改、删除遵守评论归属、版本和执行状态限制。Codex 执行进度与结果由执行事件自动同步并署 Codex，不通过这些用户评论命令补写。同步延迟时先检查执行状态，不手工伪造结果评论。

## 任务附件与关联

```bash
node packages/taskctl/dist/cli.js attachment upload --task TASK_ID --file evidence.txt
node packages/taskctl/dist/cli.js relation add --task TASK_ID --target OTHER_ID --type blocks
node packages/taskctl/dist/cli.js relation delete RELATION_ID --task TASK_ID
```

关联类型为 `parent`、`child`、`blocks`、`blocked_by`、`related`。父任务可有多个子任务，每个子任务仍只能有一个父任务，且不能形成循环。
附件删除使用 `attachment delete ATTACHMENT_ID`。

## 标签、Git 与事件

```bash
node packages/taskctl/dist/cli.js label create --name 缺陷
node packages/taskctl/dist/cli.js label order --ids LABEL_ID_2,LABEL_ID_1
node packages/taskctl/dist/cli.js git list --project PROJECT_ID
node packages/taskctl/dist/cli.js git create --project PROJECT_ID --kind branch --branch feature/example --base main
node packages/taskctl/dist/cli.js git create --project PROJECT_ID --kind worktree --branch feature/example --directory example --existing true
node packages/taskctl/dist/cli.js events list --project PROJECT_ID --after 0 --limit 100
```

标签排序需提供完整标签 ID 顺序。Git 删除必须传入当前 `--head SHA`，并指定 `--branch` 和/或 `--path`，受未提交修改、任务占用等既有检查保护。Git 和备份沿用现有接口行为，不保证重复提交幂等；CLI 不自动重试。
事件使用分页 JSON，下一页使用返回的 `cursorRevision`；遇到 `historyTruncated` 或 `cursorAhead` 时重新读取看板。此命令不保持 SSE 连接。

## 身份与只读审计

真实用户统一表示为 `{ "kind": "feishu", "tenantKey": "企业标识", "userId": "用户标识" }`；任务返回 `assigneeIdentity` / `creatorIdentity`，人员摘要返回 `identity`。人类身份不再使用 actor UUID 或应用级 open_id。

创建任务前，在 CLI 发起配对并由飞书看板中的当前用户确认：

```bash
node packages/taskctl/dist/cli.js auth login --label "我的 Codex"
# 在返回的看板链接核对验证码并确认
node packages/taskctl/dist/cli.js auth complete
node packages/taskctl/dist/cli.js auth status
node packages/taskctl/dist/cli.js issue create --project PROJECT_ID --title "待办任务"
node packages/taskctl/dist/cli.js auth logout
```

任何通过飞书登录验证的账号均可直接操作同一看板，不需要管理员初始化或成员登记。新任务负责人固定为当前会话的飞书用户；可以省略负责人参数，显式使用 `--assignee USER_ID --tenant TENANT_KEY` 时只能提交当前登录用户。不能指定其他用户或使用 `--assignee null` 清空负责人。更新其他字段时省略负责人，原有真实负责人保持不变。

CLI 凭据独立保存在当前用户私有目录中，权限为 0600；不会读取或复制飞书客户端 token。登录请求 10 分钟过期，会话 8 小时过期，服务重启后需重新登录。失效凭据不会降级为管理身份；可 `auth logout` 清除。每次请求重新检查会话和真实飞书登录证据。能力令牌保留为本机连接认证，不能代替用户登录。

任务写操作（包括评论、依赖关系、附件、执行、审批和标签）必须携带有效飞书会话。凭据缺失时服务端返回 401，不会回退为本机服务身份；运行环境重新部署导致凭据文件消失时同样拒绝写入。本机健康查询等运维操作仍可使用能力令牌。

负责人候选只包含当前已登录的飞书用户。用户身份、姓名和头像只能来自服务端成功验证的飞书登录，CLI 不提供创建或预登记用户的命令。旧 `member bootstrap` 命令和成员初始化接口已移除。`member audit` 仅只读返回 `identities`，包含身份来源、验证证据及历史引用数量，不输出凭证，也不会创建或修改用户。

飞书应用需开通「获取用户 user ID」（`contact:user.employee_id:readonly`）；迁移还需以原应用身份读取通讯录，并确保数据权限覆盖旧用户。参考[飞书应用配置文档](https://open.larkenterprise.com/document/quick-start-of-personnel-and-attendance-management-system/step-1-create-and-configure-an-application)和[获取单个用户信息](https://open.feishu.cn/document/server-docs/contact-v3/user/get)。

升级到数据库 v21 前，服务使用原飞书应用凭证验证企业与旧 open_id 对应的 user_id，再备份和迁移。缺少 user_id 权限、租户不符、映射不完整或重复都会停止迁移；不会猜测或删除用户。升级后接口字段发生变化，旧 CLI 和旧请求格式需同时更新。
