# Container deployment acceptance

The `Verify` workflow runs formatting, lint, typecheck, Codex protocol compatibility, unit/migration tests, E2E, build, and `docker compose config` for the default, SSH Agent, Feishu, and optional Nginx Compose variants. The `Container` workflow builds and runs both `linux/amd64` and `linux/arm64` images before publishing.

Each architecture smoke starts a fresh production-mode, non-root container with a read-only root filesystem. It checks direct health, HTTPS through a disposable Nginx reverse proxy, Web/auth bootstrap, rejection of a forged direct `X-Forwarded-Proto`, required health checks, absence of bundled coding CLIs/FRP/Caddy, and that the Admin API is not published. Through the authenticated HTTPS proxy it creates a temporary Web account and Project, exercises Task creation, live SSE, and `Last-Event-ID` replay, and checks `Secure` cookies and SSE buffering headers. It also writes Project, Task, Comment, Attachment metadata and attachment payload into SQLite/the data volume, restarts the container, then tests:

```text
Container A -> online backup -> post-backup mutation -> stop A
            -> offline docker-run restore -> Container B -> verify restored state
```

The SSH integration job builds an isolated OpenSSH host with Git and a fake Codex App Server. A short-lived CI identity is generated for that job only. The test exercises the real `SSHProcessTransport` and `CodexProvider` path (version discovery, session creation/resume, streaming, approval response, and completion), plus untrusted/changed host-key refusal and incorrect-key rejection. It uses no production key, Codex login, Feishu credential, or OpenAI account. The fixture is not evidence that a real user's host, CLI authentication, reverse proxy, or Feishu app is configured.

## Local, non-mutating checks

Compose configuration can be checked without starting services:

```sh
docker compose --env-file .env.example config --quiet
SSH_AUTH_SOCK=/tmp/devboard-agent.sock docker compose --env-file .env.example \
  -f compose.yaml -f compose.ssh-agent.yaml config --quiet
docker compose --env-file .env.example -f compose.yaml -f compose.feishu.yaml config --quiet
docker compose --env-file .env.example \
  -f compose.yaml -f compose.reverse-proxy-example.yaml config --quiet
```

After a real deployment, `deploy/scripts/verify-deployment.sh` checks direct container health, liveness, Compose health, and confirms that the DevBoard Admin API port is not published. Set `DEVBOARD_PUBLIC_URL=https://...` to check the Web assets, auth bootstrap, health and public reverse-proxy reachability over HTTPS. It reports only pass/fail facts and does not log response bodies or credentials.

`deploy/scripts/verify-host.sh` performs read-only DNS/TCP, strict known-host, SSH authentication, OS/architecture, Git, and CLI discovery checks. Configure its `DEVBOARD_SSH_*` inputs using an existing catalog identity reference or an accessible SSH Agent. It does not trust an unknown key, modify `known_hosts`, prompt for a passphrase, invoke a provider run, or print private-key contents. Unknown or changed keys are hard failures that must be resolved through DevBoard's explicit trust flow.

## Preview deployment

`.github/workflows/deploy-preview.yml` is manual-only (`workflow_dispatch`) and uses the protected GitHub `preview` environment. It requires an allowlisted GHCR image reference pinned with `@sha256:…` (digest-only or tag-plus-digest). The Container workflow can be manually dispatched on the reviewed feature branch; after its amd64, arm64, and SSH acceptance jobs pass, it publishes an immutable `sha-<commit>` tag and reports the digest. Configure these environment secrets before dispatch:

- `DEVBOARD_PREVIEW_HOST`
- `DEVBOARD_PREVIEW_PORT`
- `DEVBOARD_PREVIEW_USER`
- `DEVBOARD_PREVIEW_SSH_PRIVATE_KEY`
- `DEVBOARD_PREVIEW_SSH_KNOWN_HOSTS` (pre-verified server key; CI does not use trust-on-first-use)
- `DEVBOARD_PREVIEW_PATH` (absolute directory containing `compose.yaml` and `.env`)

For an existing deployment, the remote script requires the current container to be healthy, creates and verifies an online backup before pulling, then records the old tag/digest, pulls and starts only the `devboard` service, and waits for container health and API health checks. A first install skips the existing-container backup. It never runs `compose down`, removes the data volume, or automatically downgrades after a failed deployment. On failure it prints a manual rollback candidate and warns that an older application may not support a database schema already migrated by the new image. The GHCR package must be pullable by the preview host (public package or host-managed registry credentials).

## Remaining real-environment acceptance

These checks require user-owned infrastructure and cannot be truthfully passed by CI fixtures:

- Docker Host SSH from the real DevBoard container, remote Linux SSH, and their host-key approval;
- actual Codex authentication and a real remote Codex Run with streaming/approval/continue;
- Lucky or another public TLS proxy, secure browser login/cookies, and SSE buffering/reconnect behavior;
- real Feishu callback, H5 login, and one shared Web/Feishu Run;
- final browser UI observation on the selected deployment.

The SSH fixture validates the transport and provider protocol adapter only. It does not validate the repository's still-incomplete production WorkspaceMapping-to-remote Git/worktree integration; this limitation remains explicitly fail-closed.
