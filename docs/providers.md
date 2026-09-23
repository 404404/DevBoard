# DevBoard Providers

Provider 只描述如何与 Agent 的机器协议通信；Connection 描述进程运行在哪里。Provider 不读取或复制第三方私有 credential 文件，健康检查失败时显示真实的未安装、需要认证、离线或协议错误状态。

| Provider | SSH Host command | Protocol | Streaming | Approval/Input | Cancel | Models |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | `codex app-server` over SSH stdio | Codex JSON-RPC | Yes | Yes | Yes | Yes |
| Cursor | `agent acp` over SSH stdio | ACP | Yes | ACP capability | Yes | ACP capability |
| Grok Build | `grok agent stdio` over SSH stdio | ACP | Yes | ACP capability | Yes | ACP capability |
| OpenCode | `opencode acp` over SSH stdio | ACP | Yes | ACP capability | Yes | ACP capability |

## Codex

Codex runs only on the selected SSH Host and uses `codex app-server --listen stdio://`, reusing the Codex JSON-RPC client. Authentication remains on the Host; DevBoard does not mount or parse the Host's `~/.codex` directory.

## ACP Providers

Cursor、Grok Build 和 OpenCode share `AcpClient`, JSONL transport, and the SSH boundary; they do not parse TUI output. Complete the official login on the target Host. Missing binaries or authentication must be reported as unavailable rather than presented as ready.

## 限制

Provider 的模型、reasoning effort、mode 和 permission 能力不假设相同，UI 应根据返回的 capability 显示；不支持的参数会在 Run 启动前明确失败，不会静默忽略。远程第一阶段不安装 DevBoard Worker，不开放远端 TCP 端口。
