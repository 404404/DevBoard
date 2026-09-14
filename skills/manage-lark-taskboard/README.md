# manage-lark-taskboard

Lark-Codex 随包的 Codex Skill，用于查询和管理飞书任务看板。操作指南为 [SKILL.md](SKILL.md)，执行入口为 [scripts/taskctl.sh](scripts/taskctl.sh)。

安装 DMG 后，在首次启动提示选择“安装到 Codex”，或打开“应用设置 → Agent Skill”进行安装。默认位置是 `~/.agents/skills/manage-lark-taskboard`，安装内容仅为 `SKILL.md` 和 `scripts/`；这份仓库 README 不进入技能安装目录。

应用升级后可在卡片中更新技能或重新检查状态。用户修改不会自动覆盖，只有明确选择“使用随包版本”后才替换；符号链接、其他工具管理的目录、旧 `~/.codex/skills` 或 `$CODEX_HOME/skills` 中的同名技能，需回原位置或管理器处理。

文件安装成功后，在 Codex 技能列表中确认是否识别；按需强制重新加载技能或在方便时重新打开 Codex，在新任务中使用 `$manage-lark-taskboard`。不要为核验中断已有 Codex 会话。

技能包装器仅使用应用内置的 Node 与 taskctl，保留调用者的工作目录；不需要源码检出、全局 Node、npm 或开发构建。首次写入看板仍需真实飞书身份配对，安装技能不代表已完成授权。
