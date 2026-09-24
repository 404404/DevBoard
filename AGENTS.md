# DevBoard repository guidance

DevBoard is a containerized Project Control Plane. Docker Compose is the primary deployment and release path; the old macOS Tauri source is deprecated and is not part of the supported runtime or release workflow.

## Architecture boundaries

- Web and Feishu/Lark are channels over the same API, Run, approval, and event state.
- Project, Milestone, Task, Run, Provider, Connection, Execution Profile, and Workspace Mapping are separate domain concepts. A Run is one execution; a Provider describes the agent protocol; a Connection describes an SSH Host.
- The container serves HTTP/API, Web assets, SQLite, attachments, backups, SSE, approvals, and provider adapters. It does not contain or launch Codex, Cursor, Grok Build, OpenCode, FRP, or Caddy.
- Every execution Host, including the Docker Host, is reached over SSH. Do not treat container `localhost`, `process.cwd()`, `homedir()`, or container filesystem checks as remote workspace state.
- Production workspace and Git/worktree operations must use `Project → WorkspaceMapping → SSH Connection`. Incomplete operations must fail closed; never substitute local container Git or filesystem access.
- Do not introduce a DevBoard Worker as part of this architecture.

## Secrets and network security

- SSH private keys are injected by the container runtime from a read-only identity directory. The database stores only a safe `identityRef`; APIs and logs must never return private-key bytes or arbitrary host paths. SSH Agent is optional and must fail explicitly when unavailable.
- Persist DevBoard-managed `known_hosts` under `/var/lib/devboard/ssh`. Scanned host keys are candidates only; trust requires explicit user confirmation. Host-key changes fail closed. Never use `StrictHostKeyChecking=no`.
- Production must use an explicitly configured HTTPS Public Origin and explicitly trusted proxy IP/CIDRs. Never trust all proxies or derive production origin from request headers.
- Keep the public API and loopback-only Admin API separate. Do not publish the Admin API, mount the Docker socket, use privileged mode, or mount a user's home/Codex state into the container.
- Do not commit `.env`, runtime data, SQLite files, attachments, backups, host-specific `known_hosts`, SSH keys, Feishu secrets, or tokens. When reporting a suspected secret, report only its path and type, never its value.
- If an old data directory contains `frpc.toml`, preserve the user's file but do not read, validate, start, or delete it.

## Development and verification

- Read [README.md](README.md), [architecture.md](docs/architecture.md), [execution-platform.md](docs/execution-platform.md), [reverse-proxy.md](docs/reverse-proxy.md), and [container-acceptance.md](docs/container-acceptance.md) for current behavior.
- Run relevant tests plus `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm run build`. Validate every supported Compose variant and shell script. Report checks that could not run as `NOT RUN`; never claim a local check or fixture is real-host acceptance.
- Do not hide failures with `continue-on-error`, `|| true`, skipped tests, weakened assertions, or warning-only downgrades. Fix the cause and rerun the gate.
- Preserve user data and unrelated worktree changes. Never delete or replace persistent volumes, databases, backups, credentials, or deployment files without clear authorization and a verified target.
- Preview deployment is manual and requires a published immutable image digest plus the explicitly configured protected `preview` environment. Never guess host, port, user, SSH key, known-host key, or deployment path.

## Deprecated sources

`apps/desktop/` and the old `manage-codexboard` taskctl Skill are retained only for migration/audit context. Do not use their local Codex, local workspace, Caddy, FRP, or DMG behavior as a current product assumption. Do not add them to the main CI or release path.
