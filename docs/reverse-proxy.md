# Docker deployment and reverse proxy

DevBoard is the control plane. The container serves standard HTTP and the built Web UI; TLS termination, certificates, DNS, and public ingress belong to an external reverse proxy. DevBoard does not start Caddy or FRP, and it does not infer its public URL from a request header.

## Start the container

```sh
cp .env.example .env
mkdir -p secrets/ssh
chmod 700 secrets secrets/ssh
docker compose config
docker compose up -d
docker compose ps
```

Set `DEVBOARD_PUBLIC_ORIGIN` to the final HTTPS URL before exposing the service. The production Server refuses to start without an explicit HTTPS Public Origin. Keep `DEVBOARD_TRUST_PROXY` empty until the actual proxy source address is known. Then set it to an exact IP or narrow CIDR, for example `172.20.0.1/32`; do not use `*`, `0.0.0.0/0`, or trust forwarded headers from arbitrary clients. Fastify only honors forwarded protocol/host/client-IP metadata from those configured addresses.

For Feishu, create `secrets/feishu-credentials.json` as `{"appId":"cli_...","appSecret":"..."}`, make it readable only by the container's non-root UID (`1000`) with mode `0600`, then start with `-f compose.feishu.yaml`. The file is mounted read-only and excluded from the image build context. Without the override, Web account mode is used.

By default Compose publishes `127.0.0.1:47823` for a reverse proxy on the same host. The container itself listens on `0.0.0.0:47823`. If the proxy runs on another LAN machine, set `DEVBOARD_BIND_ADDRESS` to the Docker host's LAN address, or deliberately use `0.0.0.0` with a host firewall rule restricting access to the proxy. Do not publish container port `47824`: the Admin API remains bound to container loopback and is not part of the public service.

Data is stored in the named `devboard-data` volume at `/var/lib/devboard` (SQLite, attachments, backups, runtime state, and managed `known_hosts`). The container runs as a non-root user with a read-only root filesystem, no added capabilities, no privileged mode, no Docker socket, and no host project-directory mount. Only the dedicated `./secrets/ssh/identities` directory is mounted read-only; never mount a user's whole home directory or `~/.codex`/`~/.cursor`.

## Reverse-proxy requirements

The proxy should:

- terminate public TLS and forward ordinary HTTP to `http://<docker-host>:47823`;
- preserve the public `Host` header and send `X-Forwarded-Proto`, `X-Forwarded-Host`, and `X-Forwarded-For`;
- forward the original client address consistently with the exact `DEVBOARD_TRUST_PROXY` allowlist;
- disable response buffering and caching for Server-Sent Events, allow long-lived responses, and use a read timeout of at least several minutes;
- pass `text/event-stream` responses through without compression or buffering that delays event delivery. WebSocket support is not required for the DevBoard Web UI.

The SSE endpoint is `/api/v1/events`. A reverse proxy returning HTTP 200 for the main page is not sufficient validation: confirm an authenticated browser session, live event delivery, and HTTPS cookies. `/api/health` checks the HTTP server, SQLite, migrations, and event subsystem; remote SSH Host availability is intentionally not part of container liveness.

### Lucky

Configure an HTTPS domain such as `https://devboard.example.com` in Lucky, terminate TLS there, and set the upstream to `http://<docker-host>:47823`. Preserve `Host` and forward the standard `X-Forwarded-*` headers. Disable buffering/caching on `/api/v1/events` and set a long read timeout. Lucky is a standard external reverse proxy here; no DevBoard-specific integration or TCP/FRP forwarding is used.

### Nginx example

```nginx
location /api/v1/events {
    proxy_pass http://127.0.0.1:47823;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}

location / {
    proxy_pass http://127.0.0.1:47823;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Restrict the container's published port to the proxy at the firewall. Configure the exact proxy source seen by the container in `DEVBOARD_TRUST_PROXY`; an overly broad allowlist lets clients spoof HTTPS and client IP headers.

The optional `compose.reverse-proxy-example.yaml` adds a separate Nginx TLS terminator for small deployments and proxy testing; it is not part of the default Compose stack. Create `secrets/nginx/` and supply its certificate files as `secrets/nginx/fullchain.pem` and `secrets/nginx/privkey.pem`, then start with:

```sh
docker compose -f compose.yaml -f compose.reverse-proxy-example.yaml up -d
```

That example listens on `127.0.0.1:47824` (HTTPS) and trusts only its fixed private-network address. The DevBoard service still listens on container port `47823`; Admin API port `47824` remains loopback-only inside the DevBoard container and is not published. If another ingress sits in front of this Nginx, it must forward the original `Host` and terminate TLS upstream; Nginx deliberately sets `X-Forwarded-Proto` from its own connection scheme rather than trusting an arbitrary client header.

### Caddy example

```caddyfile
devboard.example.com {
    reverse_proxy 127.0.0.1:47823 {
        flush_interval -1
    }
}
```

Caddy handles TLS externally. Keep DevBoard's Public Origin set to the same `https://devboard.example.com` value and configure the observed Caddy-to-container source IP explicitly as trusted.

## SSH execution Hosts

Every execution node, including the machine running Docker, is an SSH Host. For Docker Desktop, `host.docker.internal` is a convenient connection host. On Docker Engine for Linux, Compose adds the same name via `host-gateway` where supported; otherwise use the host's LAN address, bridge gateway, or DNS name. Ensure SSH is enabled on that host and install the selected coding CLI there.

DevBoard never creates, uploads, or stores SSH private keys. Put dedicated identity files on the Docker host under `./secrets/ssh/identities/`; Compose mounts only this directory read-only at `/run/devboard/ssh/identities`. Set `DEVBOARD_SSH_IDENTITY_DIR` to that container path. Connections store a catalog `identityRef` (the safe file name), never an absolute path or key bytes. The Web form shows only usable identities and public metadata. Files must be regular, non-symlink files with owner-readable permissions and no group/other permissions; use mode `0600`:

```sh
mkdir -p secrets/ssh/identities
chown 1000:1000 secrets/ssh/identities secrets/ssh/identities/devboard_ed25519
chmod 700 secrets/ssh/identities
chmod 600 secrets/ssh/identities/devboard_ed25519
```

If host UID mapping or Docker Desktop prevents this file mount, use a platform-supported SSH Agent socket instead. Then start with the provided override:

```sh
SSH_AUTH_SOCK="$SSH_AUTH_SOCK" docker compose \
  -f compose.yaml -f compose.ssh-agent.yaml up -d
```

The socket must be visible to the Docker daemon; Docker Desktop may require a platform-specific socket bridge, so use the mounted identity catalog if direct forwarding is unavailable. Agent forwarding must be configured; DevBoard never silently falls back from a missing agent and reports an unavailable socket explicitly. Encrypted keys should be loaded into an SSH agent. Confirm the displayed SHA256 Host Key fingerprint against a trusted channel before selecting “Confirm and trust”. Changed host keys are blocked; DevBoard will not overwrite them automatically. SSH private-key contents must not be placed in `.env` or any environment variable.

All project workspace paths and Git/Provider operations must be interpreted on their selected Connection Host. A DevBoard container path is never a project workspace path. No CLI installation or coding-agent credential directory is required inside the DevBoard image.

## Operations

```sh
docker compose logs -f devboard
docker compose exec devboard node -e "fetch('http://127.0.0.1:47823/api/health').then(async r => console.log(await r.text()))"
docker compose pull
docker compose up -d
```

Keep the data volume and SSH secret files in backups with appropriate access control. Replacing the container image must not replace `/var/lib/devboard`.
