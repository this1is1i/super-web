# 白色龙娘 · 首轮分层素材

本包是用于后续导入 Cubism 的粗分层原画，**不是已绑定的 Live2D 模型**。用户确认尚未安装 Cubism；当前未做编辑器实际导入验证。

## 文件

- `white-dragon-layers-v1.psd`：1248 × 1488，RGB、8 bit、透明底；7 个可见部件 + 1 个默认隐藏的原画对照层。
- `body.png`、`head.png`、`hair-left.png`、`hair-right.png`、`wing-left.png`、`wing-right.png`、`tail.png`：保留 ImageGen 输出的透明像素，不缩放、不裁剪。
- `composite-preview.png`：按 PSD 顺序和位置拼合的静态预览。
- `manifest.json`：从后到前的图层顺序、画布位置和建议转轴。转轴只是后续试绑参考，并未写入 PSD 变形器。
- `prompts.json`：各部件生成提示词。
- `/prototypes/white-dragon-layers.html`：逐层显隐、深浅底、原画对照和展开检查页面。通过项目服务器访问。

左右均指画面方向。各 PNG 尺寸略有差异，不能直接全部叠在 (0,0)；PSD 已按清单做整数位置对齐。

## 导入与继续制作

1. 安装 Cubism Editor 后，将 PSD 作为新模型导入。确认 7 个部件可见，原画对照保持隐藏；对照层只用于制作参考，不参与纹理图集和运行时导出。
2. 先处理边缘和重叠区域：生成式拆层与原画存在形状差异，少量边缘有杂色/半透明残留。当前只检查了静止拼合，没有验证大角度转动时露底。
3. 在这个版本的基础上精拆：脸底、刘海、眉、嘴、左右眼白/虹膜/高光/上下眼睑；脖子、左右臂/手和腿按动作需求拆开。**头部现在是一个整层，不能直接完成独立眨眼和口型。**
4. 再制作网格、变形器、参数、物理和纹理图集，最后由 Cubism 导出 `.moc3` 与配套文件。双翼、发束和尾巴虽已独立，仍需网格绑定才有自然弯曲。

## 验证与重建

已通过 PSD 读回检查：画布、图层名称、顺序、位置、隐藏状态和每层 RGBA 字节与源 PNG 一致。独立格式头检查为 PSD v1 / RGB / 8 bit。此验证不等价于 Cubism 导入或动画验收。

打包工具在 `tools/live2d`，依赖与游戏隔离。Windows PowerShell 进入该目录后：

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd test
npm.cmd run build
```

构建遇到与现有输出不同的 PSD 会拒绝覆盖。请先把手动编辑版本另存备份；不要把重新生成当作对手动编辑文件的增量更新。

来源：本会话 ImageGen 基于项目原创角色原画编辑生成。未复制社区鲸鱼娘素材。技术打包使用 ag-psd 与 pngjs，仅进行整数位置拼合和文件格式转换。
