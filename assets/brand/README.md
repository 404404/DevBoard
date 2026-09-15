# CodexBoard 品牌资源

最终采用白色方形底板，深石墨色结形、白色描边卡片和薄荷绿完成卡片。Logo 内部不包含产品文字。

- `codexboard-source.png`：内置 imagegen 从用户选定白底视觉稿提取的原始图像。
- `codexboard.png`：1024 × 1024 应用主图，RGBA 编码，白色底板为不透明像素。
- 桌面主图：`apps/desktop/src-tauri/icons/icon.png`。
- 桌面界面图：`apps/desktop/ui/icon.png`，256 × 256。
- Web：`apps/web/public/codexboard.png`、`favicon.png` 和 `apple-touch-icon.png`。

生成方式：内置 imagegen 编辑；之后用 macOS 图像工具缩放并转换为打包所需格式。

最终图像提示词：

> Produce a square application icon extracted from this approved image. ONLY the exact dark knot and three bottom task cards artwork, centered on SOLID PURE WHITE (#FFFFFF) background filling the ENTIRE canvas. NO text, NO wordmark, NO label, NO shadow, NO rounded outer tile border, NO checkerboard, NO transparency simulation, NO texture. Preserve the exact knot geometry and original relative size/positions/overlap of the three cards, mint green center card with dark checkmark and line, two white cards with dark graphite outlines and inner lines. Artwork occupies 76% of square canvas height, centered with equal white padding. This is an extraction and color-preserving cleanup, NOT a new design. Deliver square high quality PNG.
