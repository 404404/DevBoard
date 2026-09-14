---
name: manage-lark-taskboard
description: 当智能体通过 taskctl 管理 lark-taskboard 任务、项目上下文、Codex 执行、进度证据、待验收交接或 Git 收尾时使用；尤其适用于要求完成、继续、标记 done 或提交代码的场景。
---

# 管理飞书任务看板

所有自动化操作统一通过 `taskctl` 执行。它从私有运行时描述文件中发现本机回环服务，并调用受支持的 HTTP 接口。禁止直接读写任务看板的 SQLite 数据库。

## 适用版本与运行入口

本技能对应仓库当前的 `packages/taskctl/src/index.ts` 及本机管理接口。先运行实际使用环境中的 `--help`，确认该环境支持所需命令。本地源码已更新，不代表已安装且正在运行的应用也已更新。

```bash
node packages/taskctl/dist/cli.js --help
node packages/taskctl/dist/cli.js health
```

CLI 读取 `LARK_TASKBOARD_DATA_DIR/run/runtime.json`，未配置时使用当前目录下的 `.data/run/runtime.json`。能力令牌只用于本机回环 HTTP 认证，不得输出或复制到评论中。本机可使用 `node packages/taskctl/dist/cli.js --help` 查看命令，并将数据目录指向目标部署。

`context` 识别的是 CLI 进程的工作目录。返回空的项目匹配结果时，使用 `project list` 返回的项目 ID、名称和根目录确认目标，不得把空匹配理解为项目不存在。项目由 Codex Desktop 同步，CLI 不提供项目创建、注册、修改或归档。

除帮助文本外，输出为 JSON；退出码 0 表示成功、1 表示服务或运行错误、2 表示用法错误。HTTP 202 只表示操作已受理，必须查询最终状态。

## 负责人和评论身份

- 从飞书窗口创建任务时，负责人由服务端绑定为当前已认证的飞书用户；不能通过请求参数替换为其他人。
- 负责人候选仅包含当前已登录且通过飞书验证的用户；不允许指派给其他账号或清空负责人。手工登记、名字、管理员角色或外观合法的 `user_id` 都不是认证依据。
- 真实用户统一使用 `identity: {kind: "feishu", tenantKey, userId}`；不得用 actor UUID、应用 open_id、候选顺序或操作系统用户名推断用户。CLI 创建任务前先执行 `auth status`；已有有效会话时直接使用。仅在没有有效会话时执行 `auth login --label TEXT`，请用户在返回的看板链接核对验证码并确认，再执行 `auth complete`。`auth status` 返回当前已验证身份；新任务默认自分配，若显式指定，使用 `--assignee USER_ID --tenant TENANT_KEY` 且必须匹配当前用户。`project options.currentIdentity` 的 service 身份不能作为人类负责人。
- 评论只有飞书用户评论与 Codex 执行事件两种来源。禁止以本机管理用户发进度评论。
- `member audit` 可只读核查身份验证依据及历史任务、评论引用。`unverified` 表示证据不足，不等于已证明虚构。历史记录不擅自删除或改成其他用户。

## 强制门禁

- 实现成功不等于用户验收通过。
- 测试通过不等于用户验收通过。
- 管理者的要求、截止时间、发布窗口或“完成工作”的指令，都不等于用户验收通过。
- 未获得用户明确验收时，任务状态最高只能到 `in_review`（待验收）。
- 未获得用户审查差异后明确要求提交的指令时，不得执行 `git commit`。
- 未获得当前用户明确验收时，不得把任务标记为 `done`（已完成），也不得代替用户声称已验收。

只有当前用户明确表达“验收通过”或“审核通过，提交 Git”等意思，才构成相应操作的授权。授权缺失或含糊时，停在待验收交接阶段。验收通过与允许提交 Git 是两项独立授权。当前 `done` 生命周期可能自动提交 Git 并清理工作树；对会触发这些操作的任务，调用完成接口前必须已有覆盖这些副作用的授权，不能先完成再决定是否允许提交。

## 必须遵循的流程

复制以下检查清单，按顺序完成：

```text
- [ ] 读取本机上下文
- [ ] 读取任务和主会话状态
- [ ] 选择启动或继续，避免创建重复会话
- [ ] 在 Codex 最终回复中汇总结果和证据，同步到任务评论区
- [ ] 执行验证并保留证据
- [ ] 重新读取任务版本
- [ ] 最多移到 in_review（待验收）
- [ ] 获得用户明确验收后才能标记 done；提交还需明确授权
```

### 1. 先读取上下文

如果编译后的 CLI 入口不存在，先构建仓库中的 CLI，然后读取上下文：

```bash
npm run build -w @lark-taskboard/taskctl
node packages/taskctl/dist/cli.js context
```

执行任何修改前，确认返回的工作目录和项目。然后读取任务及其执行记录：

```bash
node packages/taskctl/dist/cli.js issue get TASK_ID
node packages/taskctl/dist/cli.js job list --task TASK_ID
```

仅使用上述读取结果中的 ID 和当前版本。不得猜测项目、任务、版本或会话。

### 临时文件目录

本任务所有临时文件（下载附件、测试产物、临时脚本与中间输出）统一写入当前任务执行工作目录下的 `.tmp/taskboard/<任务 UUID>/`。

- 提示词只有 `TEMP-004` 等任务编号时，先通过 `project list` 确认项目，再用 `issue list --project ID` 匹配任务编号，取得真实任务 UUID 后执行 `issue get`；不得用任务编号或标题替代 UUID。
- 目录根以当前执行记录的 `workContext.cwd` 为准，并与当前 Codex 工作目录核对；不要使用 CLI 容器中的 `/app` 或其他任务的目录。执行记录缺失或目录不一致时先确认，不猜测路径。
- 所有可指定输出位置的下载、测试、脚本均使用该目录；附件下载命令中的既定路径也必须属于此目录。
- 此目录会在任务完成收尾时清理。需要保留的源码、文档和交付成果不得放入其中；需要留存的验证证据按本技能上传为任务附件。

### 2. 保留主会话

先看 `issue get TASK_ID` 返回的 `data.task.codexThreadState`，再结合 `job list` 中的 `taskThreadId` 和状态判断。

- `draft` 或 `started`：已有主会话，使用 `job continue --task TASK_ID`。
- 明确为 `none` 且没有主会话：使用 `job start --task TASK_ID`。
- **执行列表为空不等于没有主会话。** 当前创建任务会先创建、保存并绑定草稿会话，因此新任务通常用 `continue` 发送第一轮消息。
- 已有 `queued`、`running`、`waiting_approval`、`waiting_input` 或 `canceling` 执行：先查询或处理当前执行，不再重复提交。
- 当前智能体正在处理同一个任务时，只记录和推进当前工作，不再通过 `job continue` 启动另一轮重复工作。

```bash
node packages/taskctl/dist/cli.js job continue --task TASK_ID --prompt "根据已记录的证据继续处理。"
node packages/taskctl/dist/cli.js job get JOB_ID
node packages/taskctl/dist/cli.js interaction list --job JOB_ID
node packages/taskctl/dist/cli.js interaction respond INTERACTION_ID --decision accept
node packages/taskctl/dist/cli.js interaction respond INTERACTION_ID --decision input --answers '{"question_id":["回答内容"]}'
```

交互决定支持 `accept`、`decline`、`cancel`、`input`；只回应当前待处理请求，并以实际问题 ID 构造输入。`job cancel JOB_ID` 停止一次执行，不等于把整个任务设为 `canceled`。

当前模型回合通过 Codex Desktop 的 owner/follower IPC 执行。短时辅助进程用于创建空会话和必要管理操作；桌面未加载时由桥接器打开深链接并等待连接。连接失败后先检查已有任务及执行状态，保留原会话，不自行启动独立 App Server 执行模型回合，也不重建任务。更多细节见 [桌面会话桥接说明](../../docs/codex-session-bridge.md)。

### 3. 记录进度和证据

在当前 Taskboard 绑定的 Codex 主会话中，用最终回复汇总结果和验证证据。Taskboard 仅将 `codex.agent_message` 中 `phase: final_answer` 的内容以 Codex 来源显示到评论区，同一执行事件按事件标识去重。执行前说明和中途进度（`commentary`）仅保留在 Codex 对话与执行记录中，不作为评论返回；缺少明确阶段标记的旧消息也不投影为评论。无需另行发表评论。

进度回复包含实际已实现的内容、已执行的验证及结果、剩余工作；交接回复包含改动范围、验证证据和已知限制。只报告实际执行和观察到的结果，不编造证据，也不将测试通过写成用户已验收。

用户明确要求代发、修改或删除评论时，先用 `auth status` 确认已授权的真实飞书会话，再调用 `taskctl comment add/update/delete`。服务端固定使用该飞书用户作为作者，修改与删除仅限本人评论。没有有效会话时先完成 `auth login` / `auth complete`，不能用本机管理身份代替。不得通过修改昵称、正文署名、伪造作者参数或直接操作数据库冒充作者。执行结果继续由原 `final_answer` 事件显示为 Codex，不用评论命令重复发布。

如果最终回复完成后通过 `issue get TASK_ID` 发现该回复尚未出现在评论区，检查当前执行和连接状态，报告同步尚未确认；不要切换到 `comment add` 补发。恢复连接后由原事件通道处理同步。未确认同步成功时，不声称证据已持久保存。

如果当前对话不是该任务绑定的主会话，不声称回复会自动进入任务评论区；先确认任务与主会话映射，并在当前对话说明缺少同步上下文。不得通过重复启动任务或伪造评论弥补。

### 4. 交接待验收前执行验证

先运行与改动相关的专项测试，再运行仓库的完整检查。修改任务状态前检查代码差异：

```bash
npm run verify
npm run test:e2e
git diff --check
git status --short
```

**如果任何必需检查失败，任务应保持当前的活跃或阻塞状态，并在 Codex 最终回复中记录具体失败，由执行事件同步。不得将任务移到 `in_review`（待验收）。**

这是智能体的流程门禁；本机接口不会替智能体验证测试日志。已有基线失败也不自动豁免：应记录当前结果、基线对照和影响范围。该条不等于停止所有工作，仍可继续诊断和完成不受影响的内容。用户明确修改本次要求时按其授权范围执行，不把单次授权扩展到其他任务。

### 5. 重新读取版本，最多移到待验收

执行进程或其他客户端可能改变任务版本。修改状态前立即重新读取：

```bash
node packages/taskctl/dist/cli.js issue get TASK_ID
node packages/taskctl/dist/cli.js issue move TASK_ID --version CURRENT_VERSION --status in_review
```

修改状态后，在 Codex 最终回复中给出交接说明，包含改动范围、验证证据和已知限制，由同一执行事件通道同步。随后停止收尾操作，请用户审查。

## 用户明确验收后

1. 重新读取任务、执行记录和差异，确认验收范围与 Git 收尾授权。
2. 核实任务处于 `in_review`、没有活跃执行，也没有未执行评论；这些是当前服务端的完成条件。
3. 执行适用的最终验证，并使用最新任务版本提交完成操作。
4. 查询生命周期直到结束，报告 `status`、`phase`、`errorSummary`、`commitSha` 和 `notes` 中实际返回的结果。
5. 服务已完成 Git 提交时，不再额外执行一次 `git commit`；需要单独提交的操作仍须明确授权。

```bash
node packages/taskctl/dist/cli.js issue get TASK_ID
node packages/taskctl/dist/cli.js lifecycle request TASK_ID --version CURRENT_VERSION --status done
node packages/taskctl/dist/cli.js lifecycle get TASK_ID
```

`lifecycle request` 异步返回，状态包括 `pending`、`running`、`failed`、`succeeded`、`abandoned`；阶段包括 `checking`、`canceling`、`committing`、`cleaning`、`completed`。只有 `succeeded` 才表示收尾成功。`issue move ... --status done` 使用同一生命周期并等待结果，不是仅修改状态字段的捷径。

完成流程可能提交任务目录中的改动、保存 Git 归档引用，并按既有保护条件清理工作树和分支。不要在流程前手工删除它需要检查的目录。只清理已确认属于本次工作的临时产物，不删除用户文件。

对一个任务的验收，不授权提交无关改动，也不代表其他任务已验收。

## 取消、归档、恢复与永久删除

- 停止一次执行：`job cancel JOB_ID`，随后查询 `job get JOB_ID` 确认结果。
- 取消整个任务：`lifecycle request TASK_ID --version N --status canceled`，再用 `lifecycle get` 查询。取消流程会处理活跃执行；当前实现不走完成流程的 Git 提交与清理分支。
- 归档：`issue archive TASK_ID --version N` 隐藏任务，保留记录。
- 恢复：`issue restore TASK_ID --version N` 可恢复归档任务，也可恢复已取消任务，具体结果以服务返回为准。
- 永久删除：`issue delete TASK_ID --version N`。服务要求任务为 `done` 或 `canceled`、未归档、无活跃执行，并校验版本；删除过程中会归档关联的 Codex 会话。

永久删除不能通过 `restore` 撤销。用户只要求清空或删除任务时，不应为了满足删除条件而把任务标记为 `done`；在其授权范围内采用取消流程，再读取最新版本删除。批量操作也应逐项读取版本和检查结果，不能复用最初列表中的旧版本。

## 不得作为绕过规则的理由

| 理由                                 | 应当如何处理                                             |
| ------------------------------------ | -------------------------------------------------------- |
| “测试都通过了，所以任务已经完成。”   | 测试提供证据，用户负责验收。最多移到 `in_review`。       |
| “发布窗口快结束了。”                 | 时间压力不构成验收或提交授权。                           |
| “管理者让我发布。”                   | 仍需遵守仓库的用户审查门禁。                             |
| “我只标记 done，不提交代码。”        | `done` 本身就表示验收完成。未经授权，两项操作都不能做。  |
| “先提交，方便审查者查看稳定的差异。” | 直接审查工作区差异；获得明确授权后才能提交。             |
| “直接操作 SQLite 更快。”             | 这会绕过 HTTP 授权、事件、幂等和审计，应使用 `taskctl`。 |

## 停止条件

遇到以下情况，应停止相关操作并说明原因，不得自行猜测或绕过：

- 结合 `context` 与 `project list` 后仍无法确认目标项目；
- 运行时描述文件缺失或被拒绝；
- 任务或主会话不明确；
- 发生乐观锁版本冲突：暂停这次修改，重新读取并评估差异后再决定；
- 验证尚未完成；
- 缺少验收或提交授权。

## 命令与参数速查

完整参数以同环境的 `node packages/taskctl/dist/cli.js --help` 为准，示例见 [taskctl 命令参考](../../docs/taskctl.md)。下表中的斜线表示多个子命令，不是要原样输入的命令。

| 范围     | 命令与注意事项                                                                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 项目     | `project list`、`project scan ID`、`project dashboard ID`、`project options ID`；创建选项包含负责人候选项和开发上下文。                                                                                                                                |
| 任务     | `issue list --project ID`、`issue get ID`、`issue create/update/move`；`get` 返回任务工作区，包含评论、附件、关联、活动和执行摘要。                                                                                                                    |
| 重新分配 | `issue reassign ID --version N --project ID --mode single`；模式为 `single` 或 `origin_group`，仅用于符合服务条件的临时项目历史任务。                                                                                                                  |
| 已读     | `issue read ID` 使用已授权的 CLI 飞书会话，仅为该用户标记已读。                                                                                                                                                                                        |
| 评论     | 用户明确要求时使用 `comment add/update/delete`，作者固定为已授权会话的飞书用户。Codex 最终回复由执行事件同步，进度不进入评论区。                                                                                                                       |
| 关联     | `relation add --task ID --target ID --type TYPE`；类型为 `parent/child/blocks/blocked_by/related`；删除使用 `relation delete ID --task ID`。                                                                                                           |
| 附件     | `attachment upload --task ID --file PATH`；下载使用 `attachment download ID --output PATH`；删除使用 `attachment delete ID`。                                                                                                                          |
| 标签     | `label list/create/update/delete/order`；创建和修改用 `--name`，修改和删除还需 `--version`；排序用 `--ids ID,ID` 提供完整顺序。                                                                                                                        |
| Git      | `git list/create/delete --project ID`；创建分支需 `--kind branch --branch NAME --base NAME`；创建工作树需 `--kind worktree --branch NAME --directory NAME`，使用已有分支时传 `--existing true`。删除需当前 `--head SHA` 及 `--branch` 和/或 `--path`。 |
| 事件     | `events list --project ID --after REVISION --limit 100`；分页 JSON，不保持 SSE 连接。下一页用返回的 `cursorRevision`，游标失效时重新读取看板。                                                                                                         |
| 运维     | `health`、`backup create`；备份创建结果不等于已完成恢复演练。                                                                                                                                                                                          |
| 身份     | `auth status` 查看当前已验证身份；`member audit` 只读核查历史引用。任何通过飞书验证的账号均可操作看板，没有管理员初始化或手工创建用户入口。                                                                                                            |

### 验证附件

需要保留验证文件时，将其上传为任务附件，并在 Codex 回复中引用服务返回的附件信息：

```bash
node packages/taskctl/dist/cli.js attachment upload --task TASK_ID --file evidence.txt
```

不要为进度记录额外创建评论或待绑定评论附件。飞书用户的评论附件由用户在 Taskboard 中上传，附件 ID 必须来自实际读取或创建结果。

### 清空字段与冲突处理

负责人不能清空或改派其他人；普通更新省略负责人参数，保留任务实际负责人。

```bash
node packages/taskctl/dist/cli.js issue update TASK_ID --version CURRENT_VERSION --due null --labels "" --description ""
```

更新时使用字面值 `null` 清空 `--start`、`--due`、`--context`；使用空字符串清空 `--labels` 或 `--description`。未传入的字段保持不变。

CLI 每次修改调用生成新的幂等键，不会自动重试。结果不明确时先读取任务、执行或生命周期状态；重新运行同一条 CLI 命令不保证是同一个请求。Git 和备份操作也不承诺重复提交幂等。不得猜测 ID 或版本，不能因超时而重复创建任务或启动执行。
