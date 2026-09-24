# Development and operations

DevBoard is a containerized Project Control Plane. The container owns the HTTP API, Web assets, Feishu/Lark integration, SQLite, attachments, backups, Runs, events, approvals, and provider adapters. Coding CLIs, Git, and project workspaces live on SSH Hosts.

## Local development

Requirements: Node.js 22+, npm, and Docker Compose for container checks.

```sh
npm ci
CODEXBOARD_DATA_DIR="$PWD/.data" npm run dev
```

The development Web app is served at `http://localhost:5173`; the API health endpoint is `http://localhost:47823/api/health`. The Admin API listens only on `127.0.0.1:47824`. Use isolated test data; do not point development tools at an installed or production data volume.

Useful checks:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run codex:protocol:check
npm run test
npm run test:e2e
npm run build
docker compose --env-file .env.example config --quiet
```

Also validate `compose.ssh-agent.yaml`, `compose.feishu.yaml`, and `compose.reverse-proxy-example.yaml` with the base Compose file. Container and disposable SSH acceptance run in GitHub Actions; see [container-acceptance.md](container-acceptance.md).

## Data and operations

Production data lives in the `/var/lib/devboard` volume. Keep it across image upgrades. Never mount the Docker socket, a user's home directory, `~/.codex`, or `~/.cursor` into DevBoard. SSH identities are injected read-only from the host; only catalog references are stored in SQLite. The writable managed `known_hosts` file is separate from that identity directory.

Run administrative backup operations inside the container. The Admin API remains loopback-only and is not published:

```sh
docker compose exec -T devboard node apps/server/dist/ops.js backup
docker compose exec -T devboard node apps/server/dist/ops.js verify /var/lib/devboard/backups/<backup-id>
```

Backups include a consistent SQLite snapshot, attachments, and a SHA-256 manifest. Restore replaces persistent data; stop the service, validate the selected backup, and follow the documented recovery procedure before restoring. Never overwrite a live SQLite database or remove the data volume as part of an image update.

## Current boundaries

Production project paths are absolute paths in the target SSH Host's view and must be resolved through `Project → WorkspaceMapping → Connection`. Do not use local `fs`, `git`, `process.cwd()`, or `localhost` as a substitute for remote host operations. Any production Git/worktree operation not yet routed through SSH must fail closed.

Production requires an explicit HTTPS `DEVBOARD_PUBLIC_ORIGIN`. Trust only the actual reverse proxy's explicit IP/CIDR using `DEVBOARD_TRUST_PROXY`; do not infer the public origin from request headers. TLS termination and SSE buffering/timeouts are configured at the external proxy. See [reverse-proxy.md](reverse-proxy.md).

The old Tauri Desktop and its v0.1.11 instructions are deprecated. They are not part of the primary build, CI, image, or release workflow. Old `frpc.toml` data is preserved during migration but is not read or started. See [codexboard-migration.md](codexboard-migration.md).
