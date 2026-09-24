# macOS Desktop (deprecated)

The former Tauri app is not a supported DevBoard deployment or release target. Its v0.1.11 guide is retained as [migration history](README-v0.1.11-archive.md) only; do not use its local Codex, Caddy, FRP, workspace, or DMG workflow for current installs.

Current installations use the container control plane: see the repository [Docker Compose deployment guide](../../docs/reverse-proxy.md) and [architecture overview](../../docs/architecture.md). This directory is excluded from the Docker image and primary CI/release workflows. Desktop packaging is disabled.
