# 白色龙娘 · V3 躯干候选

V3 保留 V2 的 21 层五官分拆，并增加一层 ImageGen 躯干精修候选。最终 PSD 共 24 层，手臂、手和腿仍由 V1 身体层作为保底显示。由于本轮图像生成额度耗尽，不能可靠生成剩余肢体层，因此没有把错位的临时图放进 PSD。

## 当前新增

- `torso-refined.png`：移除手臂、手、腿后的躯干制服候选，包含衣领、披肩、腰带、裙摆和挂饰；叠在 V1 身体层上方，保留 V1 的四肢。
- `iris-clean-left.png`、`iris-clean-right.png`：去除白色高光的虹膜试验层，默认隐藏。预览页可以单独打开检查，但当前默认仍使用 V2 的虹膜，以保持角色眼神不变。
- `manifest.json`：V1/V2 引用、躯干层位置和隐藏试验层。
- `composite-preview.png`：V3 默认拼合预览。

打开 [V3 预览](../../../prototypes/white-dragon-layers.html?v=3) 可以检查躯干层、五官和隐藏试验层。V1 与 V2 仍可从页面上方切换。

## 当前明确保留的工作

手臂、手、左腿、右腿、颈部还没有独立 PNG；V1 身体层继续可见，所以 V3 不会丢失完整角色。下一轮应以 V1 身体层为参照分别拆出袖子、手、裤腿和靴子，随后再把 V1 保底层隐藏。肢体拆分完成前，不建议开始大幅身体弯曲或手势绑定。

本轮没有修改玩法代码，也没有生成 `.cmo3`、`.moc3` 或模型绑定文件。PSD 仍按 RGB / 8 bit / 透明底生成；生成式素材存在边缘和比例变化，需在 Cubism 中建模前由美术做一次边缘清理。

## 验证

```powershell
cd tools/live2d
npm.cmd test
node build-psd.js layers-v3 --preview-only
node build-psd.js layers-v3
```

打包器先读回所有图层的名称、顺序、位置、显隐、剪贴标志和 RGBA 字节，再写入 PSD；已有不同 PSD 会拒绝覆盖。当前 V3 预览已成功读回 24 层，`rgbaRoundTrip` 为 `identical`。
