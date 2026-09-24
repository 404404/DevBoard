# Public access

DevBoard exposes standard HTTP from its application container. An external reverse proxy owns TLS, DNS, certificates, and public ingress. Public production deployments require an explicit HTTPS `DEVBOARD_PUBLIC_ORIGIN` and an explicit trusted-proxy allowlist (`DEVBOARD_TRUST_PROXY`, exact addresses or CIDRs only).

Compose binds `127.0.0.1:47823` by default for a proxy on the same host. The application listens on `0.0.0.0:47823` inside the container. The Admin API remains on container loopback and must not be published.

FRP configuration is not read or started. If an old data directory contains `frpc.toml`, DevBoard leaves the file untouched and ignores it.

For install steps, host binding for a remote LAN proxy, forwarded-header trust, HTTPS cookies, SSE buffering/timeouts, and Lucky/Nginx/Caddy examples, see [reverse-proxy.md](reverse-proxy.md).
