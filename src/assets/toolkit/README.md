# 资产构建工具包

编辑器、资产专家、片场和 CPU 预览共用 `evaluateAsset`。资产保存源部件和可选 `construction`，生成结果不回写源数据。原有纯部件资产继续使用同一求值入口。

| 模块 | 职责 |
| --- | --- |
| `schema.ts` | 部件、组、参数、关联、锚点、约束与修改器的数据合同 |
| `expression.ts`、`dependencies.ts` | 有界算术与跨参数／部件／锚点依赖，检测循环和缺失引用 |
| `mirror.ts`、`array.ts` | 独立计算复制变换，保持修改器顺序 |
| `evaluate.ts`、`transforms.ts` | 展开子树、稳定生成 ID、真实反射与坐标变换 |
| `edits.ts` | 共享原子操作：分组、参数修改、解除关联、复制、应用构建结果 |
| `inspector.ts`、`inspector.css` | 现有 Inspector 内的控件；不持有另一份几何状态 |
| `instructions.ts` | 生成专家与编辑专家共用的模型说明 |

## 操作

在资产根节点调整参数；在部件或组上添加 Mirror / Array。组可包含多个基础体、子组和关节，轮组只需维护一份源定义。Hierarchy 中复制结果标注镜像轴或阵列序号。点击复制结果后可回到源部件，或将这一份解除关联。普通复制会复制当前求值后的完整子树。修改器可以开关、排序和移除。

参数关联控制的位置、旋转或尺寸字段会显示计算值并锁定对应直接编辑轴。根节点可创建锚点；部件的“锚点连接”支持吸附，以及将一根梁的指定局部轴连接到两个端点。解除数值关联／锚点连接时保留当前计算结果。修改器和参数编辑沿用草稿保存、撤销、专家方案预览和固定 ID 的资产保存与关联实例同步。

## 坐标与求值

米、Y 向上、+Z 向前；XZ 用于水平四角镜像。基础体 `size` 只影响网格，组和子部件不继承网格尺寸。Mirror 以资产原点或指定源部件的完整坐标系为参考，保留反射手性。Array 的 count 包含原件，offset 是目标局部坐标的中心间距；可用表达式设置间距，也可叠加阵列形成网格。两者都复制整棵子树，关节保持独立 ID。

算术仅支持数字、引用、括号和 `+ - * /`，不执行 JavaScript。参数引用如 `width / 2`；源字段如 `parts.base.size.x`；锚点的资产坐标如 `anchors.top.y`。含连字符的 ID 用 `{parts.part-id.size.x}`。表达式最多 240 字符／128 token，依赖深度最多 256。参数范围、缺失引用、循环依赖、同字段多重驱动和非有限结果会拒绝整个编辑批次。

源字段关联使用父级局部坐标。锚点位置相对其所属源部件；attach 的 offset 相对锚点坐标系。span 将两个端点转换到目标父坐标系，再计算目标中心、旋转和轴向长度。圆柱梁通常使用 Y 轴。新生成资产的居中／贴地保存在 construction.offset 中；后续修改保留原点。

生成 ID 由源 ID、修改器 ID 和复制轴／序号组成。参数变化不改变 ID。解除关联只冻结所选复制结果的子树，其他副本继续关联；应用全部构建结果后删除参数关系并生成可编辑独立部件。镜像坐标系下关节角度仍是局部角度；测量输出的旋转轴是轴向量，可能与圆柱几何轴反向共线。

求值预算为 2048 个节点（包含组），单个 Array 的数量为 1–128。它限制计算开销，不代表场景物体数限制。超额操作原子拒绝，不截断或静默丢部件。本工具包操作组合基础体，不提供 Blender 的顶点焊接、裁切、曲面或布尔建模。

## 验证

`fixtures/trolley.ts` 根据实际酒店行李车构建：7 个源节点展开为 16 个几何部件和 4 个组。`toolkit.test.ts` 的两条长流程覆盖连续尺寸修改、落地与连接、转动／平移参考系镜像、带子部件的关节反射、阵列顺序、解除关联、资产保存、库复用、项目导出重开、循环依赖和计算预算。运行：

```sh
npx tsx --test src/assets/toolkit/toolkit.test.ts server/assets/*.test.ts
npm run build
```

程序提供实际几何测量和渲染证据，资产专家／用户作最终造型评价。真实 Muse 记录位于 `output/verification/asset-toolkit/`；4 次请求完成参数修改、Group + Array 防滑条、测量、非零轮子姿态渲染和最终评估。浏览器保存的后续人工修改没有包含在该次专家评估中。

## Blender 参考

参考的是职责划分和求值语义，自行实现适合组合基础体的工具包：

- [Dependency Graph](https://developer.blender.org/docs/features/core/depsgraph/)：源数据与求值结果分离，渲染读取后者。
- [Mirror 实现](https://github.com/blender/blender/blob/main/source/blender/modifiers/intern/MOD_mirror.cc)：独立修改器、参考对象变换依赖、按轴计算。
- [Modifier types](https://github.com/blender/blender/blob/main/source/blender/modifiers/MOD_modifiertypes.hh)：按修改器类型组织实现。
