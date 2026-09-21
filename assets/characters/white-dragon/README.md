# 星际 Codex 娘 · 白色龙娘试作

用户选择：Q 版星际 Codex 娘，白色龙娘形象。此处的 Codex 娘是本项目角色概念昵称，不是官方角色设定。

## 当前产物

- `idle.png`：内置 ImageGen 生成的单层透明原画。
- `blink.png`：基于原画编辑的闭眼帧。
- `/prototypes/white-dragon.html`：独立网页试作，展示两帧眨眼、整体呼吸轻摆、鼠标视差和招呼动作。当前游戏入口保持原样。
- `prompt.txt`：原画完整生成提示词。
- `layers-v1/white-dragon-layers-v1.psd`：首轮粗分层 PSD，7 个可见部件与隐藏原画层，另附透明 PNG、清单和读回校验工具。
- `/prototypes/white-dragon-layers.html`：分层素材检查页面；具体导入方法和限制见 [分层说明](layers-v1/README.md)。
- `layers-v2/white-dragon-layers-v2.psd`：新增脸底、前发、双眼各 4 层、双眉和两种嘴形，共 21 层；[V2 说明](layers-v2/README.md)记录精修缺口。
- `/prototypes/white-dragon-layers.html?v=2`：V2 五官分层预览，支持嘴形互斥切换和虹膜裁剪。
- `layers-v3/`：保留 V2 五官拆分并加入躯干精修候选；[V3 说明](layers-v3/README.md)列出仍待处理的四肢层。
- `/prototypes/white-dragon-layers.html?v=3`：V3 躯干候选预览。

**这还不是 Live2D Cubism 模型。** 目前没有 `.cmo3`、`.moc3`、`.model3.json`、纹理图集或独立部件网格。PNG 切帧和 CSS 整体形变只能用来验证角色在网页中的观感，不能替代转头、口型、尾巴及头发的独立绑定。两帧生成图可能有细微像素差异。

## 下一阶段分层清单

V2 已将脸底、前发、眼白、虹膜、上下眼睑、嘴和双眉独立成层。接下来需要精修透明边缘和眼睑贴合，独立虹膜高光与口腔部件，按动作需求继续拆分后发、躯干服装、披肩、左右上臂与前臂、手、腿与靴、脖子及左右耳与角。生成式拆层带有比例与轮廓变化，不是原画的逐像素复原。

建议首批参数：`ParamAngleX/Y/Z`、`ParamBodyAngleX`、`ParamBreath`、`ParamEyeLOpen/ROpen`、`ParamEyeBallX/Y`、`ParamMouthOpenY`，另设尾巴、侧发与翅膀物理参数。先做自然待机、短促开心、思考三组动作，再接入实际对局事件。

导出验收：在 Cubism 中完成网格和变形器绑定，检查极限角度露底，生成纹理图集并导出 `.moc3`、`.model3.json`、`.physics3.json` 和动作文件。网页接入使用匹配导出版本的 SDK；不能通过手写一个 JSON 将单层 PNG 变成 `.moc3`。

用户已确认尚未安装 Cubism Editor，本轮先交付分层素材；未安装或购买编辑器及模型。

## 来源

原画与闭眼帧：本会话内置 ImageGen，2026-09-19。没有复制鲸鱼娘项目的图片、提示词或设计规范。

- 社区鲸鱼娘参考（用于确认最初提及的对象，用户随后选择白色龙娘）：https://github.com/Neko3000/deepseek-whalechan
- Cubism 官方模型导出说明：https://docs.live2d.com/en/cubism-editor-manual/export-moc3-motion3-files/
