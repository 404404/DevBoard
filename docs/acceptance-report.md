# DevBoard 自动化验收报告

验收日期：2026-09-24

## Git

| 项目                    | 结果                                                |
| ----------------------- | --------------------------------------------------- |
| Branch                  | `feature/devboard-execution-platform`               |
| PR base                 | `main` @ `180eafbf405ba31247fd28e110d94fd9b7b71a85` |
| 本报告所验收的代码 SHA  | `9b7a1bbbe42df0225f4cb2d99fcafc5272f3b2ab`          |
| 工作树（该 SHA 验收时） | clean；分支远端 SHA 一致                            |

本报告作为代码验收后的文档提交；CI 结果链接指向上表所列代码 SHA。

## Verify

[Verify run #35984370109](https://github.com/404404/DevBoard/actions/runs/35984370109) — **PASS**，head SHA 与验收 SHA 一致。

| Gate                                                 | 结果                                                  |
| ---------------------------------------------------- | ----------------------------------------------------- |
| Compose 默认配置及 SSH Agent / Feishu / 反代 variant | PASS                                                  |
| format                                               | PASS                                                  |
| lint                                                 | PASS                                                  |
| typecheck                                            | PASS                                                  |
| Codex protocol compatibility                         | PASS                                                  |
| v0.1.11 与 SSH identity migration                    | PASS                                                  |
| Unit                                                 | PASS：644 passed；3 skipped                           |
| E2E                                                  | PASS：210 passed；1 documented skip；0 failed / flaky |
| Build                                                | PASS                                                  |

三个 unit skip 均有明确边界：一个仅适用于 macOS 的路径测试在 Linux runner 上跳过；两个 SSH/Codex tests 在本 workflow 的独立 Container SSH integration job 中实际运行。唯一 E2E skip 是使用 CDP 原生触摸注入的 Chromium 专用用例；WebKit 的合成下拉刷新、滚动与取消行为均执行并通过。

## Container

[Container PR run #35984370102](https://github.com/404404/DevBoard/actions/runs/35984370102) — **PASS**。`linux/amd64` 与 `linux/arm64` 均完成镜像 build 和完整 smoke。

[手动发布 run #35985479324](https://github.com/404404/DevBoard/actions/runs/35985479324) — **PASS**。两个架构 smoke、Disposable SSH Host + Codex protocol 和 GHCR publish 均成功；release job 因本次不是版本 tag 而按设计跳过。

已实际覆盖：非 root、read-only root filesystem、容器健康检查、HTTP 与 HTTPS 反代、Web auth/Secure Cookie、安全拒绝伪造 `X-Forwarded-Proto`、SSE 与 replay、SQLite/migration/event health、Admin API 不发布、重启持久化、在线备份、变更后恢复、SSH host-key/auth 检查及 fake Codex stdio 的 session/resume、streaming、approval 与 completion。

## GHCR image

- Repository：`ghcr.io/404404/devboard`
- SHA build tag：`ghcr.io/404404/devboard:sha-9b7a1bb`（部署建议固定下方 OCI digest；tag 本身未配置 registry-level immutability）
- Branch tag：`ghcr.io/404404/devboard:feature-devboard-execution-platform`
- OCI index digest：`sha256:a55ef86c1590663d6e9e015f674add60871cefd85745efd186d12b1f23d07a8a`
- Architectures：`linux/amd64`、`linux/arm64`
- Platform manifest digests：amd64 `sha256:5bdb54ae686b8d5697c22a701649ad8bed805f941b293fe6a11a0917612136b6`；arm64 `sha256:0b1c3ef1446d597d26cfbb4bd8f5a65814bbd869ec90aaaa0ec33efebc9c69dd`
- Local image size（`docker image inspect`）：amd64 `456,596,589` bytes；arm64 `477,215,743` bytes。

该 tag 可匿名读取 OCI manifest；manifest 明确包含 amd64 和 arm64。已用 OCI index digest 对正式 `compose.yaml`、SSH Agent、Feishu、反代四个 Compose variant 分别执行 `docker compose config --quiet`，全部通过；没有启动或修改部署服务。

## Preview deployment

**NOT RUN** — `PREVIEW_DEPLOYMENT_BLOCKED_BY_MISSING_EXTERNAL_CONFIGURATION`。

GitHub 当前没有 `preview` Environment，仓库 Secret 列表也为空。请先创建 `preview` Environment 并配置以下 Environment secrets，随后才能安全执行手动部署：

- `DEVBOARD_PREVIEW_HOST`
- `DEVBOARD_PREVIEW_PORT`
- `DEVBOARD_PREVIEW_USER`
- `DEVBOARD_PREVIEW_SSH_PRIVATE_KEY`
- `DEVBOARD_PREVIEW_SSH_KNOWN_HOSTS`（预先核验的 host key）
- `DEVBOARD_PREVIEW_PATH`

未猜测目标主机、未使用测试 SSH key，也未放宽 host-key validation。

## Remaining manual acceptance / known limitation

- 在实际 DevBoard 容器中测试 Docker Host 和 Remote Linux 的 SSH、明确 host-key trust，以及远端 Codex CLI 的实际登录与无副作用 Run。
- 对真实部署确认 Lucky/其他 HTTPS 反代、浏览器登录与 SSE 长连接；验证真实飞书 callback、H5 登录及与 Web 共享同一 Run。
- 在目标环境完成真实浏览器 UX 验收。
- **WorkspaceMapping 到远端 Git/worktree 的生产集成仍未完成**；当前 disposable SSH fixture 只证明 SSH transport 与 Codex protocol adapter，不证明真实远端 workspace 生命周期。该限制保持 fail-closed，不应把 fixture 结果解读为真实远端项目执行已验收。
