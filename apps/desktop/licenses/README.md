# 第三方许可补件

这些文件仅补足上游 npm 和 Cargo 发行包未携带的第三方许可正文，不授予或选择 Lark-Codex 自身的许可证。构建时读取本地副本，不联网获取。

Cargo 补件的逐版本来源、完整性校验和适用条件见 [cargo/supplements.json](cargo/supplements.json)，每个仓库快照目录有独立 README。Cargo 包的正文直接来自本机锁定版本 registry；只有缺失正文的包使用固定上游 commit 补件。生成的 npm 和 Cargo 索引分别位于运行包的 `licenses/npm/index.json` 和 `licenses/cargo/index.json`。

## abstract-logging 2.0.1

- 包来源：`https://registry.npmjs.org/abstract-logging/-/abstract-logging-2.0.1.tgz`。
- [上游 v2.0.1 README 的 License 部分](https://github.com/jsumners/abstract-logging/blob/v2.0.1/Readme.md) 明确链接至作者的 MIT 许可服务；npm 包自身只有该链接，没有许可正文。
- 补件来源：[作者提供的纯文本原文](https://jsumners.mit-license.org/license.txt)。
- 核对日期：2026-09-14。该服务按访问年份呈现版权年份；副本保留本次返回的 `2026`，不推测或改写为 npm 版本的发布日期。
- [LICENSE](abstract-logging-2.0.1/LICENSE) 保留上游纯文本全文，仅补齐文件末尾换行。构建仅对 `abstract-logging@2.0.1` 且声明为 `MIT` 的包使用此补件；版本变化需重新核实。

fastdom 1.0.12 和 strictdom 1.0.1 的完整 MIT 许可已在各自 npm 包的 README 中，构建会保留这些原文件，无需补件。
