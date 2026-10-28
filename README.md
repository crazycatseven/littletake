# LittleTake

> LittleTake lets anyone build and animate editable low-poly proxy scenes to guide AI models in creating videos.

A project for the **Meta Global AI Developer Hackathon**.

Live demo: [littletake.vercel.app](https://littletake.vercel.app).

## Why

AI video models are powerful, but describing actions, camera movement, and relationships between objects through long prompts remains difficult. LittleTake lets everyday creators express those intentions through an editable 3D scene and a rough performance.

## Creator Flow

![LittleTake creator flow](docs/assets/creator-flow.png)

Reference clips are analyzed into editable proxy scenes; scenes can also be created manually. Proxy animation provides visual guidance for AI video generation.

Demo input: **The Grand Budapest Hotel — Interview with Zero**, source 0:33–0:45. The [original selected clip](public/demo/grand-budapest-zero/input.mp4), [web copy](public/demo/grand-budapest-zero/input-web.mp4) and [source metadata](public/demo/grand-budapest-zero/source.json) are included in the repository. Load the web copy with **Reference video → Load demo clip**.

## Features

Desktop scope: mouse/keyboard authoring, text prompts and reference clips.

**Current scope, before November 2026:** Generated and edited assets use local storage. The cloud demo assumes a single shared user. Durable cloud asset storage and account separation are deferred.

### AI Understanding

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Muse integration** | Video input, scene understanding and structured scene proposals. | Done |
| **P0** | **Tool Calling & Harness** | Conversation context, native asset function calls, bounded expert tasks and atomic preview/apply. | Partial |
| **P2** | **Vision adapters** | SAM 3.1 Segmentation for reference images/video through Meta Model API. | Todo |
| **P2** | **SAM 3D Body service** | Separate model deployment and inference for human 3D pose estimation from reference frames. | Todo |

### Authoring

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Scene & project model** | Multiple scenes per project, camera-owned framing and motion, shots bound to one camera and a range of shared scene time. | Done |
| **P0** | **Desktop editor** | Mouse/keyboard tools for direct scene editing. | Done |
| **P0** | **AI scene editing** | Saved Muse conversations; build sets from an empty project and preview edits across scenes, objects, cameras and shots. | Done |
| **P0** | **Motion & camera authoring** | Basic object/character motion and independent camera moves. | Done |
| **P1** | **Advanced timing authoring** | Refine timing, sequencing and synchronization across actions and cameras. | Todo |

### Generation

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Muse Video generation** | Combine proxy previs and creative prompts to guide final video generation; validate Muse Video reference-input and API support. | Todo |
| **P2** | **Look-frame generation** | Image-model integration for visual direction before video generation. | Todo |

### Assets

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Proxy asset system** | Compound geometry recipes, stable asset versions, independent instances and semantic parts. | Partial |
| **P1** | **Asset library & templates** | Persistent local library, 12 built-in character/vehicle/prop/primitive assets, generated assets and reusable instances; prepared scenes remain planned. | Partial |
| **P1** | **AI asset composition** | Dedicated Muse expert composes, renders, inspects and registers missing compound proxies. | Partial |

### Rendering

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Three.js runtime** | Scene rendering, camera evaluation and synchronized playback. | Done |
| **P0** | **Previs rendering & export** | Render and export proxy frames and animation as visual guidance for final video generation. | Todo |

### Deployment

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Vercel deployment** | Publish an HTTPS desktop web demo with Git-based production and preview deployments. | Done |

Deferred Todo:

- [ ] Multi-account support: sign-in, per-account project management and private asset libraries.
- [ ] Durable cloud asset storage and synchronization.

## Development

```sh
npm install
npm run dev
```

`npm test` checks scene data, motion interpolation and undo/redo. `npm run build` produces the deployable app in `dist/`.

Vercel deploys `main` to production and creates previews for other branches and pull requests.

The studio includes six primitives, transform tools, an independent shot preview, start/end motion tracks, local saves, JSON export, reference-video import and conversational Muse scene editing. The in-app **Shortcuts** panel lists navigation controls. Previs image/video export remains planned.

Storage keeps one active project in this browser, containing multiple physical scenes and multiple Muse conversations. Each conversation has separate messages and a saved draft; all conversations work on the same project. The scene and shot selectors choose the current context; each message records its scene, shot and selection. Use the conversation title to switch chats and **+** to start a new one. **Muse / Inspector** switches the right panel. Refresh restores the project, including chat history. An interrupted response is saved for an explicit retry.

**Export project** includes every scene, camera, shot, conversation and referenced asset definition. Scene exports containing assets are portable single-scene project files. **Open scene / project** restores a project, or adds a standalone scene to the current project. The scene menu also provides **Export current scene** and **New empty project** (downloads the existing project first). New scenes start empty; Muse can propose a complete set from a description. v1 scene/project files migrate automatically, including camera motion and chat receipts. Reusable assets live in the local server library; cloud sync remains planned. Clearing browser storage removes local history; export a project to keep a portable copy.

The saved model uses **Project → Scenes**, and each scene owns **Objects, Cameras and Shots**. Cameras own their transform, field of view and motion; each shot references one camera and a range of scene time. **Add Shot** reuses the selected camera, then the active shot's camera, then the scene's first camera; it creates a camera only when none exists. Shots sharing a camera also share its framing and motion. Use **Duplicate shot and camera** for independent framing. Remove or reassign a camera's shots before deleting it. Actors, props and cameras use absolute scene seconds. Shot ranges may overlap, and playback previews the selected shot's range. Changing a scene's duration preserves action timing and rejects ranges that would no longer fit.

Core integration: `validateDocument` in `src/model.ts` validates/migrates a scene; `validateProjectContent` in `src/project/model.ts` validates `{name, scenes, assets?}`. `applyProjectOperations` in `src/scene-edit/operations.ts` applies a maximum of 64 explicitly scoped operations atomically to a copy. Each operation carries `sceneId`; object, camera and shot IDs are unique within that scene. Invalid references, duplicate IDs or out-of-range motion reject the whole batch. Current bounds are 24 scenes per project, 100 objects / 128 cameras / 100 shots per scene, and 1–60 seconds per scene.

Each Muse turn replays that conversation's user/assistant history with the latest project. Questions can receive text-only replies; edits appear as a preview with **Before / After**, **Discard** and **Apply changes**. Scene edits and undo invalidate older previews. Switching conversations, scenes or shots stops an in-flight response. Retry and Update preview return to the original scene and shot context. Each scene-edit API request allows up to 12 model calls shared by the director and asset expert, at most 8 director tool rounds, and one final-plan correction. A chat turn can make one additional API request for scene views (at most 24 calls across both requests). Each expert job allows at most 4 calls: construction, an optional validation correction, rendered inspection and an optional revision inspection. Network/provider failures and failed expert jobs never restart automatically. Conversations exceeding 200 history messages or 120,000 history characters remain saved and readable, but require a new conversation to continue. Model context uses message replay with `store: false`; encrypted reasoning replay is not part of this version.

Scene editing uses JSON output with a supplied schema, followed by strict local schema validation and an atomic project preview. Each request includes the current scene/entity IDs and actual object counts. Explicit Chinese/English object totals such as “最多 10 个物体”, “剩 9 个物体”, “at most 10 objects” and “exactly 3 objects” are bound to scenes and checked against the full proposed result, including floors and people but excluding cameras/shots and internal asset parts. A compound asset instance counts as one object. Missing or failed checks receive the same single correction attempt. These are per-request constraints; implicit counts in a list of props and arbitrary natural-language constraints are not deterministic checks.

**Download diagnostics** exports this conversation's messages/application receipts and each request's original input, model request, raw output, parsed proposal, native tool calls/results and validation/provider errors, including rejected correction attempts. Inputs are saved to IndexedDB before inference; responses are saved before showing a preview. Records survive refresh on this browser and origin, independently of project localStorage. Headers and API credentials are never included. Export diagnostics separately from **Export project** to retain them outside this browser; clearing site data removes both stores.

For video analysis, copy `.env.example` to `.env.local` and set `MODEL_API_KEY` and `MUSE_MODEL`. Vite serves the same `/api/reference` handler locally that Vercel runs in production. Model credentials are server-side environment variables.

Provider adapters live in `server/ai/`; the video-analysis workflow and validated scene conversion live in `server/reference/`. The editor consumes ordinary `SceneDocument` data. Replacing the AI provider requires an adapter and a factory entry, without changing the editor.

Reference import currently accepts MP4/WebM clips of 1–60 seconds, up to 3 MB. It builds a coarse single-shot draft with separate objects, basic motion and a camera bound to the shot. Review it before adding it as a new scene; Undo removes that addition. Geometry, depth and motion are AI estimates, with simplifications shown in the review.

### Asset library and modeling expert

`src/assets/` owns editable asset recipes, geometry, bounds, the library panel and the independent asset workshop. `server/assets/` owns persistence, the dedicated expert, its rendered inspections and the director tools: `search_assets`, `read_asset`, `generate_asset`, `get_asset_job`, `instantiate_asset`. The director searches and inspects reusable assets first. Only a missing asset is delegated to the expert. The generation expert sees its own brief and geometry, renders front/side/isometric views using the same Three.js primitives as the stage, and must approve the inspected recipe before registration. Program checks prove data consistency and report measurements; they do not prove that a model looks correct.

The local library persists ready definitions and complete expert job histories under `.littletake/assets/`, or `LITTLETAKE_ASSET_DIR`, excluded from Git. Vercel uses the runtime's temporary directory by default because its application filesystem is read-only ([runtime documentation](https://vercel.com/docs/functions/runtimes)); that cache is temporary and is not shared reliably between function instances. No durable cloud library is configured. Instances reference an immutable asset ID/version and own their transform, tint, components and motion. Referenced definitions are embedded once per project so saved/exported projects remain renderable and their assets reusable without the server cache. Locally, registered assets remain reusable after discarding a scene preview or undoing an instance. Expert failures retain their input, raw replies and errors but do not register an asset or alter the scene.

### Asset editing mode

**保存为资产** on a scene object publishes its geometry, components and motion to the same server library used by the modeling expert. A successful save is immediately reusable in other projects connected to that library, including after restarting the local server. **我的资产** includes generated and edited assets without requiring a special tag. Unsaved workshop drafts remain browser-local until **保存新版本** publishes them.

Open **编辑资产** on an instance, or **打开资产编辑器** on a library card. Asset mode stays inside the existing studio shell: the left Hierarchy shows asset parts, the right Inspector edits the selection, and the center viewport isolates the asset. Header, sidebar widths, timeline and status bar keep their positions. A viewport breadcrumb returns to the scene with its previous selection and camera view; the scene timeline is inactive while editing the asset. This isolated draft is not a project scene. It provides add/duplicate/remove, parent assignment, numeric transforms, move/rotate/size handles, colors and joint limits/pivots. Bounds and front/side/isometric geometry renders update with the draft. Joint sliders and movement/hinge component trials reset without recording motion. Part sizes scale only their mesh; children inherit position/rotation, not mesh dimensions. Joint axes and pivots are expressed inside the already-rotated part's local frame. Revisions preserve the asset origin rather than recentering every edit.

The **资产专家** tab has its own saved conversation. A revision request replays the last 16 messages alongside the authoritative draft. Its four native tools are `read_asset_draft`, `edit_asset`, `measure_asset` and `render_asset`; `edit_asset` uses the same atomic reducer as manual edits. Measurements include actual joint/cylinder axes, and rendering can trial joint angles. The expert must inspect the latest edited revision before reporting approval. Each request is bounded to 8 model calls with no automatic provider retry. Results are staged for **采用 / 放弃**, never auto-published. Failed jobs retain the intermediate draft and raw requests, tool results and errors; **查看未完成草稿** explicitly identifies a draft that has not received final expert evaluation.

**保存新版本** publishes an immutable revision, then optionally updates the selected instance or every project instance referencing the base version. Instance transforms, tint, motion and component overrides remain unchanged. Those reference updates use project undo/redo; the saved library revision remains available. Concurrent conflicting revisions return 409; an identical retry returns the existing revision. Drafts, proposals and asset conversations persist separately per asset ID/version in browser storage; **导出草稿** downloads that state separately from the project. Project export includes referenced saved asset definitions, not unsaved workshop drafts or server job history.

The workshop uses `components/model.ts` and `performance/motion.ts` for `asset.template`. Component defaults can be edited and tested here. Both manual placement and director asset tools retain component defaults and recorded motion when creating independent scene instances. Saving a scene instance as an asset also preserves its construction parameters and modifiers.

The asset [construction toolkit](src/assets/toolkit/README.md) adds reusable groups, ordered Mirror/Array modifiers, parameter expressions and anchor connections inside the existing prefab Inspector. Both Muse specialists use the same evaluator as the stage and measurements. Saved recipes retain source relationships; generated copies can be detached individually or baked together.

CPU asset previews use per-pixel depth testing. Generation reviews include rest and articulated trial poses, and revision tools can render explicit joint angles. See the [complete real-Muse acceptance flow and portable project](docs/verification/asset-toolkit.md).
