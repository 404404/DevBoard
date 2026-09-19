# Windows 自动构建与测试

本阶段在 GitHub Actions 的 `windows-2022` x64 环境建立兼容性基线。工作流运行于 `feature/windows-ci` 分支推送、面向 `main` 的 Pull Request，以及手动触发。测试分支不自动合并、不发布 Release，也不替换现有 macOS 应用。

首次运行通过推送测试分支触发。GitHub 的 **Run workflow** 按钮通常要求工作流已在默认分支；保留 `workflow_dispatch` 供后续采用，不为显示按钮而将测试分支提前合并。

## 检查范围

| 作业                                     | 实际检查                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Node and web build                       | 使用 Node 22.23.2、`npm ci` 和锁文件，构建 contracts、taskctl、server、web；执行类型检查及 ESLint |
| contracts / taskctl / server / web tests | 各工作区完整 Vitest 测试，不通过排除 Windows 失败用例取得绿灯                                     |
| scripts tests                            | `scripts/` 下完整 Node 测试，显式展开文件列表，避免依赖 shell 通配符                              |
| desktop-scripts tests                    | 桌面脚本完整 Node 测试，包含 Chromium 和 WebKit 界面检查                                          |
| Desktop Rust compilation                 | 使用 Cargo 锁文件检查桌面程序及测试目标，记录 Windows 编译阻断                                    |

每个测试组独立运行，一个组失败不会取消其他组。失败保留非零退出码，工作流总状态也会失败。不能把“工作流成功启动”或“网页构建通过”解释为 Windows 桌面版已适配。

检出前关闭运行器的 Git 自动换行转换，保留仓库原始字节，避免带固定哈希的上游许可证被转换为 CRLF 后产生无关的校验失败。

Node 脚本测试使用 120 秒的测试超时；挂起或遗留句柄按失败记录到 JUnit，不强制将未退出的测试算作通过。Vitest 使用各工作区原有超时。外层作业另有时限，防止兼容性问题长期占用运行器。

本阶段不运行需要真实 Codex 的 `codex:protocol:check`，不启动真实任务、不使用飞书凭据，不运行依赖 Unix 模拟桌面的整体 `test:e2e`。Windows 安装包、运行时组件分发、标准用户权限与 ACL、真实 Codex 会话和安装更新验收属于后续阶段。GitHub Windows 运行器以管理员运行，不能代替普通 Windows 11 用户的权限验收。

## 产物与结果

在仓库 **Actions → Windows compatibility baseline** 查看具体提交的运行记录：

- `windows-x64-node-web-build-<commit>`：四个工作区编译结果及 `build-info.json`。它不包含 Node、生产依赖或桌面启动器，不是可安装或独立运行的 Windows 发行包。
- `windows-x64-tests-<suite>-<commit>`：JUnit 报告、标准输出、标准错误和带平台信息的 `result.json`。
- `windows-x64-desktop-check-<commit>`：Rust 工具链版本、编译日志和退出状态。

产物保留 14 天。安装依赖或作业超时可能导致报告不完整，此时以作业日志和失败状态为准。测试结果中的 skip 来自现有测试本身；新工作流没有按平台过滤测试。

## 本地复现

在项目根目录执行：

```sh
npm ci --no-audit --no-fund
npm run build
npm run typecheck
npm run lint
node scripts/run-ci-tests.mjs contracts
node scripts/run-ci-tests.mjs taskctl
node scripts/run-ci-tests.mjs server
node scripts/run-ci-tests.mjs web
node scripts/run-ci-tests.mjs scripts
```

桌面脚本测试还需安装 Playwright Chromium 和 WebKit。设置 `PLAYWRIGHT_BROWSERS_PATH` 为绝对缓存路径，再使用同一环境运行 `npx --no-install playwright install chromium webkit` 和 `node scripts/run-ci-tests.mjs desktop-scripts`。测试执行器隔离用户配置目录，避免读取本机 Codex 配置。

Rust 检查命令：

```sh
cargo check --locked --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml
```

在 macOS 上运行同一组命令只提供 macOS 证据。Windows 结论必须对应实际 Windows Actions 运行记录。

## 2026-09-19 实际基线

测试提交：`641676e746ba16722354749a81a4d00c86d8e6ec`。完整记录见 [Windows Actions 运行 35420294000](https://github.com/RocYan98/CodexBoard/actions/runs/35420294000)。平台元数据确认为 `win32` / `x64` / Node `v22.23.2`，整体结论为 **failure**。

| 检查            | 通过 | 失败 | 跳过 |
| --------------- | ---: | ---: | ---: |
| contracts       |   49 |    0 |    0 |
| web             |  204 |    0 |    0 |
| taskctl         |   97 |    6 |    0 |
| server          |  510 |   98 |    1 |
| scripts         |   33 |   69 |    0 |
| desktop-scripts |  144 |   79 |    0 |

以上按 JUnit 的 testcase 记录统计。Node 脚本的失败包含超时及其连带取消，不代表相同数量的独立缺陷；服务端日志还记录了未处理异步错误，需要结合标准输出和标准错误分析。

四个 Node/Web 工作区构建、类型检查和 ESLint 均通过。Windows 上测试执行器自身 8 项回归全部通过，包括非零退出码、失败报告、挂起测试和遗留句柄。六组测试报告、编译日志及构建产物共 8 个 artifact 已上传。

桌面 Rust 检查返回 101，首个阻断为 `icons/icon.ico` 缺失，停在 `tauri-build`。该结果尚未覆盖项目中 Unix 专用 Rust 源码的后续编译错误。没有生成 Windows 桌面安装包。

首次运行暴露了两项测试设施问题：Windows 检出转换换行导致上游许可证哈希不匹配，以及脚本失败后遗留句柄阻止报告完成。当前提交分别通过保留仓库字节和测试超时解决；复测中许可证校验已通过，脚本组在约 121 秒后以失败状态输出完整报告。没有屏蔽失败测试或放宽产品权限保护。

后续适配优先项：

1. Windows 凭据和数据权限策略：现有 `0600/0700` 与所有者检查需要对应的 Windows 安全实现。
2. Git 路径等价性、盘符路径与 CLI cwd 校验，以及附件命令的执行端路径和 shell 语法。
3. Codex Desktop IPC、Unix socket、进程停止和 POSIX 启动包装器。
4. 将 `/private/tmp`、macOS 临时目录别名和固定正斜杠等测试夹具改为明确的平台语义，保留安全断言。
5. Windows 图标、桌面资源及 Rust 平台模块；之后验证安装更新与真实 Codex 会话。备份入口、浏览器超时等其他失败仍需分别复现定位。
