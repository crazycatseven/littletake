# 空间操作

`methods.ts` 提供 `inspectSpatial(project, query)` 和 `solveSpatial(project, operation)`。两者不修改输入、不调用模型、不创建渲染器。`geometry.ts` 与正式场景共用网格构建，`schema.ts` 是参数合同的唯一来源。场景编辑通过已有 `applyProjectOperations` 原子应用结果，沿用预览、应用、撤销和项目保存。

| 操作 | 参数和行为 |
| --- | --- |
| `place_on` | `id`, `supportId`（null 为 Y=0 地面）, `horizontal: keep/center`, `clearance`；用底部采样与指定支撑面的网格射线计算高度 |
| `place_relative` | `id`, `referenceId`, `frame`, `side: left/right/above/below/front/back`, `gap`；按实际顶点投影后的边缘间距移动单轴 |
| `face_target` | `id`, `targetId`, `forward: +z/-z/+x/-x`；绕世界 Y 轴朝向目标中心，保留原有倾斜 |
| `align_objects` | `objectIds`, `referenceId`, `frame`, `axis: x/y/z`, `edge: min/center/max` |
| `distribute_objects` | `objectIds`, `frame`, `axis`, `spacing: centers/gaps`；保留两端，计算等中心距或等边缘间距 |
| `attach_anchor` | `id`, `anchor`, `targetId`, `targetAnchor`, `offset`, `frame`；一次性对齐两个锚点 |
| `follow_path` | `id`, `points`, `start`, `duration`, `orientation: keep/tangent`, `forward`, `replaceMotion`；世界坐标中的物体原点路径，匀速折线，保留转折点并在转弯前补一个朝向关键点 |

编辑器里选中物体后点 **Draw path on floor**，在地面上拖一笔即生成 `follow_path`（`sketch.ts`）：笔画先按 5 cm 容差简化、超过 120 点时等距重采样，物体保持当前原点高度并沿路径转向；从播放头开始，按物体移动组件的速度（默认 1.4 m/s）计时，场景剩余时间不够时加速到场景结束。已有运动会被明确替换，可撤销。Esc 取消。

选中相机时按钮变为 **Draw camera move on floor**：相机保持当前高度，在它所属镜头的时间范围内匀速走完这条线（不属于当前镜头时从播放头到场景结束），并始终对准开始时画面中心附近的物体（人物对准胸口高度，物体移动时跟着转）；画面里没有物体时保持当前朝向的注视点。结果是采样运动，可撤销。

每个操作包含 `sceneId` 和场景时间 `time`；除 `follow_path` 外还需指定 `scope: static/whole_motion`。`static` 拒绝已有动画；`whole_motion` 将同一个刚体变换应用到完整轨迹及中间采样，不改时间。替换已有轨迹必须明确设置 `replaceMotion=true`。所有关系计算一次，不建立持续依赖。

坐标单位为米、旋转为度。`frame` 为 `{kind:"world"}`、`{kind:"object",id}` 或 `{kind:"camera",id}`（相机或镜头 ID），均使用刚性坐标轴，不继承参照物缩放。世界和物体坐标 +Z 为前；相机坐标 +Z 朝向观察者、-Z 深入画面，X/Y 为画面右/上。`offset` 沿指定坐标轴，长度为米。

每个物体都有 `@origin`、`@center`、`@bottom`、`@top` 锚点，后三者来自世界包围盒。prefab 还提供自身的命名锚点。查询返回世界锚点、世界及指定坐标系的包围盒、边缘间距、底部射线下方的支撑面和间隙。

## HTTP 和 Agent

`POST /api/spatial`，请求体：

```ts
// 查询。precedingOperations 可省略，表示从当前项目计算。
{ action: 'inspect', project, precedingOperations: [],
  query: { sceneId: 'lobby', time: 0, objectIds: ['vase', 'table'], frame: {kind: 'world'} } }

// 解算，返回 updates 和 observations；不写入项目或资产库。
{ action: 'solve', project, precedingOperations: [], operation: {
  type: 'place_on', sceneId: 'lobby', time: 0, scope: 'static',
  id: 'vase', supportId: 'table', horizontal: 'center', clearance: 0
} }
```

响应带 `ok`、`applied:false`。成功时 `result` 包含计算结果；失败返回 HTTP 400 和具体 `error`，原始项目不变。调用方可将原操作放进正常场景编辑方案，经预览后应用。

Muse 原生工具为 `inspect_spatial` 和 `preview_spatial`。两者支持从原始项目开始的完整 `precedingOperations`，也可引用当前请求中 `instantiate_asset` 返回的 `place_asset` 回执，因此可以检查尚未应用的新场景和新资产实例。工具调用不累计改动；最终方案包含完整前序操作及所选空间操作。失败测量作为普通工具结果返回，供 Agent 修改参数。

Agent 的动画预览只返回起止姿态和中间关键点数量；完整轨迹由应用程序保留，避免反复把采样数据放进模型上下文。

## 判断范围和验证

包围盒相交只是粗查，不证明网格穿插。底部射线只测采样位置，不证明物理稳定性。`follow_path` 不自动避障；改朝向会改变轮廓，后续间距操作应按最终姿态计算。视觉相似度、颜色与氛围由参考画面和专家评估。

两条离线流程覆盖 HTTP 解算、旋转和缩放后的 prefab、真实支撑面、相机坐标、锚点、匀速路径、完整动画搬移、原子失败、保存重开、撤销，以及模拟 Muse 的资产读取和多轮工具调用。运行：`npx tsx --test src/spatial/workflow.test.ts`。测试不调用付费 API 或本地模型。
