---
name: manage-codexboard
description: Deprecated v0.1.11 taskctl integration. Do not use for current containerized SSH Runs; use the DevBoard Web UI or Feishu/Lark channel.
---

# Deprecated

This Skill and its old taskctl/Job workflow are not supported by the containerized DevBoard Control Plane. Do not invoke the bundled Desktop CLI, infer a local workspace from `cwd`, or start execution through the legacy Codex Desktop bridge.

Use DevBoard Web or Feishu/Lark for project, task, Run, approval, and continuation operations. All channels share the same server-side Run state. For deployment and backup operations, follow the repository [development and operations guide](../../docs/development.md) and [container acceptance guide](../../docs/container-acceptance.md).

The v0.1.11 instructions remain in [SKILL-v0.1.11-archive.md](SKILL-v0.1.11-archive.md) for migration history only; they are not current operating instructions.
