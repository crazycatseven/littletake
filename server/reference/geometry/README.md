# 参考图几何：云端 / 本地 SAM + 本地 VGGT

当前流程：原始帧 → SAM 3.1（默认 Meta API，可选本地）→ 本地 VGGT 深度与相机 → 地面对齐与粗代理 → 同机位渲染检查。

`SAM_PROVIDER=cloud|local` 选择提供方，未设置时为 `cloud`。HTTP 请求的 `provider` 和 Python 命令的 `--sam-provider` 可单次覆盖；Python 命令读取进程环境变量，Node 后端也读取 `.env.local`。云端网页后端与 Python 验证入口共用 `server/reference/sam/service.ts`，官方 `@meta-sam/parser` 解码输出；本地共用 `sam_local.py`。两者保持相同的来源帧与 mask 格式，提供方失败直接报错。VGGT 继续本地运行。主 Agent 已有 SAM 原始帧工具；VGGT 与粗代理反算尚未自动接入 Agent，造型和遮挡仍需优化。

## Agent 选帧与分割

对话中的 **+ Reference** 接受图片或片段；Reference video 中选片也会关联当前对话。`src/reference/frames.ts` 复用切镜检测，并在每个选定镜头内比较少量避开边界的候选；先保留清晰度较高的一帧，再补时间上分开的候选，总计最多六帧。切镜超过六个镜头时保留第一个和较长镜头，省略数量明确提供给 Agent。清晰度只是一条启发式，不保证场景覆盖完整；最终语义选帧由 Agent 完成。

`server/reference/sam/tools.ts` 提供 `read_reference_frame`、`request_reference_frame` 和 `segment_reference`。原始联系表附带 frameId、镜头序号、实际解码时间、请求时间和缩放尺寸。布局优先完整、少遮挡的视角；动作比较同一镜头的不同时刻。候选不足时，Agent 说明原因并申请最多两个额外时间点，浏览器从原视频解码后恢复同一回合。Mediabunny 的实际 timestamp 随帧保存，不能把请求的 4.900s 冒充为实际帧时间。

同一回合最多一次补帧和一次场景视图补充，总计最多三次后端请求；每次最多十二次 Muse 调用，回合共用最多四次新增 SAM 尝试，失败也计入。缓存按 frameId、概念、阈值和实际提供方匹配，同请求重复失败不会再次付费。原始 SAM 输出、mask、报错和原图引用保存在请求诊断中，模型只接收结构化测量与叠加图。

原视频、候选和额外帧保存在当前浏览器的 IndexedDB，按现有对话 UUID 关联，不改变项目 schema。换对话不会混用来源；刷新后仍可补指定时间帧。解除关联或换参考不会删除旧来源。项目 JSON 不包含参考媒体，跨设备需重新附加；诊断导出包含该次调用实际使用的帧。输出的 overlayColor 只表示 mask 的伪彩，不能作为物体材质色。归一化框仍在完整原图坐标中，没有把 SAM 结果当成真实深度或绝对尺寸。

## SAM 服务接口

云端沿用服务器的 `MODEL_API_KEY`（环境变量或 `.env.local`），固定模型 `sam-3.1`；`MUSE_MODEL` 不影响分割。云端 Node 后端仅需 `npm install`，不需要 Python、CUDA 或本地模型权重。

- `GET /api/segmentation`：查看默认提供方和两种方式的配置状态，不调用模型、不返回密钥。配置存在不表示当前空闲显存足够。
- `POST /api/segmentation`：一次图片/概念请求；输入 PNG data URL、短名词概念和可选置信度阈值。

```json
{
  "imageDataUrl": "data:image/png;base64,...",
  "prompt": "person",
  "threshold": 0.5
}
```

云端 POST 最多一次上游请求，不自动重试。云端图片没有额外的人为物体数量上限。输入限制为 4.1 MB JSON 与 1600 万像素。返回每个实例的原图半开框、模型分数、框内二值 PNG，以及响应 ID、实际用量与原始模型输出。API 返回的 mask 是框内局部图；Python 会把它贴回完整来源帧，保留现有 `segmentation.json` 和 `masks/*.png` 格式。空匹配是正常结果。阈值只过滤有模型分数的实例，缺失分数不当成零。

云端 HTTP 接口是无状态的；文件缓存与续跑由下面的验证入口维护。HTTP 也接受 `"provider":"local"`，在配置了本地环境的服务器执行；输入和诊断保存在 `.littletake/geometry/runs/sam-http-*`，回执 ID 对应该目录。本地模式没有上游 API 请求，Vercel 上返回不可用。现有接口处理参考帧，视频工作流先提取帧；整段视频原生跟踪尚未接入。

## 验证入口

Python 使用本机 uv 环境。已有环境使用 `--no-sync`，避免运行时重新安装 CUDA wheel。

```powershell
npm install
uv sync --project server/reference/geometry --python 3.12
uv run --no-sync --project server/reference/geometry python server/reference/geometry/run.py extract --video public/demo/grand-budapest-zero/input-web.mp4 --frame-index 60 --run .littletake/geometry/runs/new-reference
uv run --no-sync --project server/reference/geometry python server/reference/geometry/run.py segment --run .littletake/geometry/runs/new-reference --max-api-calls 8 --concepts person door counter "potted plant" floor wall
```

第 60 帧的来源时间戳约 2.544 秒。任意图片也可通过 `extract --image path/to/image` 转为同一格式。

每个 run 的 `sam-api-budget.json` 保存不可自动重置的调用上限，默认 8 次，包含失败或状态不明的尝试。发送前先保存预留；并发执行同一 run 会停止。成功概念逐项保存，中断后只运行剩余概念。输入、阈值或提供方不同必须使用新 run；不会覆盖旧的本地 SAM 测量或混充为 API 结果。

`sam-api-calls/*.json` 保留每次原始请求引用、提供方输出、用量和错误，密钥不进入记录。完整缓存可在无密钥、无 GPU 的环境下复用。没有调用余量就先停止，不自动提高上限。

```powershell
uv run --no-sync --project server/reference/geometry python server/reference/geometry/run.py serve --run .littletake/geometry/runs/new-reference --port 4186
```

只完成分割时显示原图与 mask。完成布局后显示深度、粗代理、俯视图和真实遮挡测量；打开页面不会调用任何模型。

## 可选本地 SAM

```powershell
uv sync --project server/reference/geometry --python 3.12 --extra sam
uv run --no-sync --project server/reference/geometry python server/reference/geometry/run.py prepare --model sam3
uv run --no-sync --project server/reference/geometry python server/reference/geometry/run.py segment --sam-provider local --run .littletake/geometry/runs/local-reference --concepts person door counter "potted plant" floor wall
```

先用 `extract` 创建 `local-reference`，再运行分割。可在 `.env.local` 设置 `SAM_PROVIDER=local` 作为 HTTP 默认，或在命令行设置同名环境变量。默认云端不需要安装 `sam` 扩展或下载 SAM 权重；本地准备使用固定源码与 checkpoint 版本，需要已有 Hugging Face 访问权限。

本地仅加载准备好的离线文件，默认至少 16 GiB 空闲显存。每次命令加载一次模型、顺序处理所有概念；HTTP 每次请求启动一次本地命令，目前不是常驻模型服务。使用官方 multiplex predictor，当前配置每个概念最多 16 个实例，云端图片接口不受此配置影响。运行目录锁防止同一帧被重复处理，本地模型锁防止多个进程同时加载。切换提供方需要新 run，完整缓存复用不加载模型、不调用 API。

## 本地 VGGT

只有显式执行 `prepare` 才下载 VGGT 源码与权重：

```powershell
uv run --no-sync --project server/reference/geometry python server/reference/geometry/run.py prepare
uv run --no-sync --project server/reference/geometry python server/reference/geometry/run.py depth --run .littletake/geometry/runs/new-reference
uv run --no-sync --project server/reference/geometry python server/reference/geometry/run.py layout --run .littletake/geometry/runs/new-reference
```

默认原始 `facebook/VGGT-1B` 权重限研究用途；商业权重需获得访问权限并显式选择 `prepare --vggt-repo facebook/VGGT-1B-Commercial`。推理只读已准备的缓存，默认至少 16 GiB 空闲显存，不中断其他工作负载。可显式用 `--depth-device cpu`。

`all` 顺序运行所选 SAM、复用或计算 VGGT、生成布局；支持同样的 `--sam-provider`、`--concepts` 和 `--max-api-calls`。后一个上限只用于云端。测量来源和配置不同不会自动覆盖。

双帧实验在两个新的 run 中保存相同来源图片，再执行：

```powershell
uv run --no-sync --project server/reference/geometry python server/reference/geometry/run.py depth --run path/to/first-run --context-runs path/to/second-run
```

每个目录得到各自的深度、相机和共同输入帧 ID，加载和推理耗时属于整组。没有将独立局部布局注册成统一多视图场景。

## 坐标和质量

原图、去黑边输入和映射记录在 `frame.json`；浮点相机 Z-depth、像素内参和 OpenCV world-to-camera 外参记录在 `geometry.npz/json`。布局 Y 向上，默认相对尺度；`--known-height 物体ID:米数` 只接受明确已知且完整可见的高度，不自动假定人物身高。

地面须通过明确的 floor 区域拟合；失败时保留观测并停止。深度只覆盖可见表面，包围盒并不恢复隐藏体积。原生 scene v3 导出的居中 FOV 相机与完整内参的偏差记录在 `sceneExport.principalPointOffsetPixels`，精确对比以报告相机为准。

`layout.json`、`cloud.json` 与 `scene.json` 保存估计；`scene.json` 是单场景数据。实际 WebGL 渲染写入 `restored.png`、`top-down.png` 与 `rendered-measurements.json`，layout ID 必须对应当前布局。轮廓 IoU 和坐标回投一致性不能代替视觉验收。

## 离线消融与实测

`benchmark.py` 只复用测量，不调用模型。四组共用候选框、VGGT 相机与标注地面，仅改变前景范围（框 / mask）和前景深度（统一 / 逐像素），不等于去掉整个 SAM/VGGT，也不是 Agent 完整流程的对照。

```powershell
uv run --no-sync --project server/reference/geometry python server/reference/geometry/benchmark.py build --manifest path/to/annotations.json --run path/to/results
uv run --no-sync --project server/reference/geometry python server/reference/geometry/run.py serve --run path/to/results --port 4185
uv run --no-sync --project server/reference/geometry python server/reference/geometry/benchmark.py summarize --run path/to/results
```

逐个打开各组报告完成真实渲染后再汇总。缺失物体的可见框 IoU 记零；相对深度差不超过 2% 记无法分辨。框和前后顺序由 Codex 从 RGB 粗标，尚未经人工复核；地面间隙仍依赖估计地面。

历史本地实验在 `.littletake/geometry/benchmarks/budapest-20261029/`，保存三帧、四组消融与双帧负面结果。14 组独立前后关系中 13 组正确、1 组无法分辨；固定单帧深度，mask 的框 IoU 为 0.472，边界框为 0.394。同两帧联合推理的框匹配略好，但前后正确从 8/9 降至 7/9，不默认多帧更优。旧的源码证据保存在该实验的 `local-source/`，旧权重和输出未删除。

API 实测在 `.littletake/geometry/runs/meta-sam-budapest-20261029/`：六个概念均成功，17 个候选 mask；请求与解析合计约 10 秒，含验证客户端启动和保存约 14 秒。六次图片请求按当时价格估算 US$0.015。与同帧本地测量按类别匹配的平均 mask IoU 约 0.968，仅说明这一帧的结果接近，不证明两个服务版本完全等价。缓存复用没有新增请求或加载 PyTorch；已复用保存的 VGGT 完成布局和渲染。

双提供方接入后，使用同帧实际调用本地 HTTP 接口，`person` 得到 9 个实例；云端和本地完整缓存均复用成功。并发本地请求返回 409，取消请求后终止本次 Python 进程树，未残留对应模型进程。检查记录在 `.littletake/geometry/provider-selection-verification.json`；本轮没有新增云端付费调用。

## 回归检查

```powershell
npx tsx --test server/reference/sam/workflow.test.ts
uv run --no-sync --project server/reference/geometry python -m unittest discover -s server/reference/geometry -p test_geometry.py
```

两条完整流程覆盖官方 mask 解码、坐标贴回、空结果、稀疏 ID、云端无额外物体数量上限、默认云端与显式本地选择、失败不切换提供方、凭据隔离、调用上限、断点续跑、缓存隔离、并发锁、原子保存，以及几何格式、尺度和渲染回执。测试不调用付费模型。

官方文档：[SAM API](https://dev.meta.ai/docs/sam/overview)、[分割格式与解码](https://dev.meta.ai/docs/sam/client-libraries)、[价格](https://dev.meta.ai/docs/pricing-rate-limits)、[VGGT](https://github.com/facebookresearch/vggt)。
