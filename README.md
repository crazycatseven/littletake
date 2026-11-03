# LittleTake

> LittleTake lets anyone build and animate editable low-poly proxy scenes to guide AI models in creating videos.

A project for the **Meta Global AI Developer Hackathon**.

Live demo: [littletake.vercel.app](https://littletake.vercel.app).

Experimental WebXR: See [XR control](docs/webxr.md).

## Why

AI video models are powerful, but describing actions, camera movement, and relationships between objects through long prompts remains difficult. LittleTake lets everyday creators express those intentions through an editable 3D scene and a rough performance.

## Creator Flow

![LittleTake creator flow](docs/assets/creator-flow.png)

Reference clips, storyboard panels and sketches are analyzed into editable proxy scenes; drawn arrows become movement. Scenes can also be created manually. Proxy animation provides visual guidance for AI video generation.

Demo input: **The Grand Budapest Hotel — Interview with Zero**, source 0:33–0:45. The [original selected clip](public/demo/grand-budapest-zero/input.mp4), [web copy](public/demo/grand-budapest-zero/input-web.mp4) and [source metadata](public/demo/grand-budapest-zero/source.json) are included in the repository. Load the web copy with **Video or sketch → Load demo clip**.

## Features

Desktop scope: mouse/keyboard authoring, text prompts and reference clips.

**Storage:** Projects, generated results, conversations and reusable assets use one persistent application data directory. The production Node entry point serves the editor and APIs from a server with a durable disk. One shared workspace is supported; account separation remains deferred. See [application deployment](server/app/README.md).

### AI Understanding

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Muse integration** | Measured video observations, shared-set proposals and rendered reconstruction review. Visual acceptance pending. | Partial |
| **P0** | **Tool Calling & Harness** | Conversation context, native asset function calls, bounded expert tasks and atomic preview/apply. | Partial |
| **P2** | **Vision adapters** | Adaptive cut detection selects clear source frames; cached SAM measurements, face landmarks and rendered evidence guide Muse analysis. | Partial |
| **P2** | **Reference geometry** | Muse selects original frames, requests timestamps and calls SAM; default Meta API and optional local CUDA. The local editor also exposes on-demand VGGT depth/camera tools with persistent measurement reuse. Automatic layout recovery remains experimental. | Partial |
| **P2** | **SAM 3D Body service** | Optional local deployment and human pose inference endpoint. Real model/device acceptance remains pending. | Partial |

### Authoring

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Scene & project model** | Multiple scenes per project, camera-owned framing and motion, shots bound to one camera and a range of shared scene time. | Done |
| **P0** | **Desktop editor** | Mouse/keyboard tools for direct scene editing. | Done |
| **P0** | **AI scene editing** | Saved Muse conversations; build sets from an empty project and preview edits across scenes, objects, cameras and shots. | Done |
| **P0** | **Motion & camera authoring** | Property keyframes for transforms, camera FOV, pivot offsets and articulated parts; manual movement recording and independent camera moves. | Done |
| **P0** | **Local project workspace** | Server project lists, code sharing, one editing seat, independent conversations, SQLite autosave and portable project archives. | Done |
| **P1** | **Advanced timing authoring** | Refine timing, sequencing and synchronization across actions and cameras. | Todo |

### Generation

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Muse Video handoff** | Publish fixed shot references, prompts and previs for an official Muse conversation; import finished video. Public deployment and Muse reference ingestion still need validation. | Partial |
| **P0** | **Video brief & package** | Muse Spark reads timestamped storyboard pages, blocking and camera timing and writes an image-to-video prompt; download the first frame, storyboards, source stills and exact edited prompt. | Done |
| **P0** | **Look-frame generation** | Muse Image renders finished film stills from clean previs frames with the shot composition locked; the first approved frame anchors the look of later frames and shots. | Partial |

### Assets

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Proxy asset system** | Compound geometry recipes, stable asset IDs, independent instances and semantic parts. | Partial |
| **P1** | **Asset library & templates** | Persistent local library and folder tree, Hierarchy drag/create, 12 built-in assets, generated assets and reusable instances; prepared scenes remain planned. | Partial |
| **P1** | **AI asset composition** | Dedicated Muse expert composes, renders, inspects and registers missing compound proxies. | Partial |

### Rendering

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Three.js runtime** | Scene rendering, camera evaluation and synchronized playback. | Done |
| **P0** | **Previs rendering & export** | Clean PNG frames and current-shot WebM animation at 720p/1080p, 24/30 fps. | Done |

### Deployment

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Vercel deployment** | Publish an HTTPS desktop web demo with Git-based production and preview deployments. | Done |

Deferred Todo:

- [ ] Multi-account support: sign-in, per-account project management and private asset libraries.
- [ ] Deploy persistent application storage and migrate local projects.

## Development

On Windows, double-click `setup.bat` once, set `MODEL_API_KEY` in `.env.local`, then double-click `run.bat`. Setup preserves an existing configuration and does not prepare GPU models. Run prefers port 4176 and opens the actual URL; use `run.bat 4187` or `LITTLETAKE_PORT` for a fixed port. Browser projects belong to their URL, including its port.

```bat
setup.bat
run.bat
run.bat check
```

Local VGGT is optional and separate from the editor: `setup.bat vggt` prepares the Python 3.12/CUDA environment and cached source and weights without inference. It reuses compatible installed dependencies; otherwise it installs from the lockfile. `setup.bat sam` prepares optional local SAM; `setup.bat all` prepares both. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and Git before preparing local models. Existing prepared revisions are reused, and configuration/measurements remain intact. `run.bat check` verifies local files without loading a model. Setup pauses before closing; set `LITTLETAKE_NO_PAUSE=1` for terminal automation.

Configure `VGGT_MODEL_REPO`, `VGGT_DEVICE` and `LOCAL_MODEL_MIN_FREE_VRAM_GB` in `.env.local`. `run.bat` starts the editor and local `/api/depth` service together. After local model setup, Muse can use `estimate_reference_depth` on an attached reference frame. Startup checks files without loading PyTorch; a depth request starts the existing Python inference, then releases its GPU memory. The API shares the editor's port and stops with it. Repeated source/model requests reuse measurements from `.littletake/geometry/runs`, including after a restart. Local VGGT is unavailable on Vercel.

`run.bat geometry ...` still forwards the same [geometry CLI](server/reference/geometry/README.md) with configuration defaults; explicit CLI flags take precedence. For manual execution use `run.bat geometry depth --run path/to/measurement`.

Other platforms can use the normal npm commands:

```sh
npm install
npm run dev
```

`npm test` checks scene data, motion interpolation and undo/redo. `npm run build` produces the deployable app in `dist/`.

Vercel deploys `main` to production and creates previews for other branches and pull requests.

`npm run build && npm start` runs the production editor and persistent APIs together. Shot **Render → Prepare for Muse → Create reference link** publishes an immutable read-only reference page for a user to submit in Muse. **Import finished video** saves returned MP4/WebM output with its shot. Public sharing requires an externally reachable HTTPS deployment. See [server setup, migration and verification](server/app/README.md).

The studio includes six primitives, transform tools, an independent shot preview, editable property keyframes, local saves, JSON and PNG/WebM export, reference-video import and conversational Muse scene editing. The in-app **Shortcuts** panel lists navigation controls.

**Parenting:** drag an object or camera onto another Hierarchy row to make it a child; drop on the root strip to detach. Multi-selection moves the selected roots together. The Inspector's **Parent** field uses the same operation. Reparenting keeps the current world pose and existing motion; parent movement, rotation and scale then affect its children. Duplicate and delete include descendants, and Undo restores the entire edit. Parents and local animation are saved with the scene. Combinations of non-uniform scale and rotation that cannot preserve an animated pose are rejected without changing the scene. Prefab Mode supports the same drag-to-parent and drop-to-origin flow for source parts; generated modifier copies are edited through their source.

**Hierarchy visibility and placement:** Ctrl-click toggles selection; Shift-click selects a range. Row eyes and the Hide/Show toolbar support selected-object batches. **H** hides selected objects; **Alt+H** shows all. Hidden objects stay in the Hierarchy but are excluded from the viewport, shot preview, snapshots and exports. Visibility is saved with the object and supports undo. Hidden objects retain their motion and components, and are skipped by placement and surface snapping. The viewport **World/Local** control sets movement/rotation axes; **Snap** configures movement and rotation increments. **Align** matches world-space bounds to the last selected visible object, which remains fixed. Numeric batch placement and alignment move complete motion paths in one undo step.

**Pilot camera:** use **Pilot** in the shot preview or **Pilot camera** in a camera's Inspector. The main view shows that camera's clean 16:9 frame. Hold right mouse to look and use WASD to fly, Q/E to move down/up, scroll to adjust speed, and Shift to boost. **R** starts or stops a take from the current time; recording advances the scene and stops at the current shot's end. Review, retry or discard before **Keep take** writes position/rotation keys. Lens animation, other objects and keys outside the recorded range stay intact. Without recording, **Exit** or Esc accepts the current pose; an animated camera gets keys at the current time. **Discard position** (the trash button) exits without changing the project. Exiting restores the editor view.

**Editor layout:** camera and object controls offer Record and Exit directly. After recording, playback, Retake, Keep take and Refine with Muse are available; refinement keeps the take and attaches it to the conversation before sending. Timeline playback stays centered, while Timeline and Assets share the resizable bottom panel. Muse model details and diagnostic downloads live in Conversation options. VR appears only when supported.

**Recording timing:** before recording a camera or controlled object, choose **Real time** to retain pauses, or **While moving** to advance scene time only when the controlled pose or articulated parts change. While moving freezes all scene animation during pauses and shows **Waiting for movement**. Camera turns count as motion. The timing mode is pinned when a take starts; it changes no project schema and produces ordinary editable keys.

**Refine a performance:** use **Animation** in the Muse composer to search and attach one or more recorded takes from the current scene (up to eight). Each attachment shows its object or camera and time range; remove individual takes or use **Change** to adjust the selection. **Refine with Muse** after recording and the Timeline sparkles button remain quick single-take entries. The same workflow supports controlled objects, script controllers, camera Pilot and saved XR takes. Describe the intent and send: Muse receives timed scene images and local/world trajectories, can ask a clarifying question, and proposes smoothing or sparse path corrections. Multiple recordings are reviewed together, including actor/camera relationships and successive takes on one object. The combined candidate is rendered at matching times and views, then visually reviewed in one further model call; shared frames are deduplicated. Use **Before / After**, **Play selection**, then **Apply changes** or **Discard** for the whole selection. The selected takes and discussion survive project reopen, including earlier single-take conversations. Only each selected take's position/rotation channels change; duration, endpoints, surrounding keys, joints, scale, lens and unselected recordings are preserved. Apply is one undoable edit; scene changes during review invalidate the proposal. Enabled Follow Path must be disabled before refining root movement that it overrides. Sampled visual review does not certify continuous collision clearance.

Performance refinement verification: 24 targeted animation, conversation and collaboration workflow tests and production build passed after multi-take integration. A real Muse Contributor run reviewed two coordinated actor/camera recordings in two model calls using 14 original/candidate images generated with the existing CPU scene renderer. Browser interaction and final WebGL visual acceptance remain pending while local browser automation is disabled. This implementation is not yet deployed.

**Icons:** formal editor UI and XR action icons use the pinned Lucide package through `src/icons/`. Keyboard legends, units, scene geometry and timeline data markers retain their semantic drawing.

**Shot Export:** the preview panel's **Export** button opens a frozen scene snapshot. Still image exports a PNG at the current scene time; Video exports the current shot's time range as a silent WebM at 24 or 30 fps. Both support 1920×1080 and 1280×720 and omit editor overlays. Frames are evaluated at exact scene times independently of encoding speed. Cancel discards the unfinished file; completed output can be previewed and downloaded. Export does not change the scene or playhead. Video encoding requires WebCodecs on **localhost or HTTPS**; an unsupported browser or insecure remote address shows an explanation. PNG remains available. Implementation lives in `src/shot-export/`; browser and file verification is recorded in [editor basics verification](docs/verification/editor-basics.md).

The workspace stores multiple projects, each with a stable UUID. Local deployments save edits automatically to local SQLite; **Projects → Open from cloud** downloads a cloud project, and the header's **Upload to cloud** icon explicitly publishes local changes. The hosted site saves edits automatically to its cloud database. Normal editing has no save-status text. See [application storage and connection setup](server/app/README.md) for configuration and conflict behavior.

Each project contains multiple physical scenes and multiple Muse conversations. Each conversation has separate messages and a saved draft; all conversations work on the same project. The scene and shot selectors choose the current context; each message records its scene, shot and selection. Use the conversation title to switch chats and **+** to start a new one. **Muse / Inspector** switches the right panel. Refresh restores the project, including chat history. An interrupted response is saved for an explicit retry.

**Export project** includes every scene, camera, shot, conversation and referenced asset definition. Scene exports containing assets are portable single-scene project files. **Open scene / project** restores a project, or adds a standalone scene to the current project. The scene menu also provides **Export current scene** and **New empty project** (downloads the existing project first). New scenes start empty; Muse can propose a complete set from a description. v1 scene/project files migrate automatically, including camera motion and chat receipts. Reusable libraries stay on their workspace; referenced asset definitions travel with each project. Saved projects belong to the running service; changing browsers or clearing site data does not remove them. Export a project to keep a portable copy.

The saved model uses **Project → Scenes**, and each scene owns **Objects, Cameras and Shots**. **Assets / Scenes** lists the current project's scenes, with open, new and undoable delete actions; deleting a scene keeps reusable library assets. Cameras own their transform, field of view and motion; each shot references one camera and a range of scene time. **Add Shot** reuses the selected camera, then the active shot's camera, then the scene's first camera; it creates a camera only when none exists. Shots sharing a camera also share its framing and motion. Use **Duplicate shot and camera** for independent framing. Remove or reassign a camera's shots before deleting it. Actors, props and cameras use absolute scene seconds. Playback runs the whole scene and switches cameras at shot boundaries; overlapping ranges use the most recently started shot. Changing a scene's duration preserves action timing and rejects ranges that would no longer fit.

Core integration: `validateDocument` in `src/model.ts` validates/migrates a scene; `validateProjectContent` in `src/project/model.ts` validates `{name, scenes, assets?}`. `applyProjectOperations` in `src/scene-edit/operations.ts` applies a maximum of 64 explicitly scoped operations atomically to a copy. Each operation carries `sceneId`; object, camera and shot IDs are unique within that scene. Invalid references, duplicate IDs or out-of-range motion reject the whole batch. Current bounds are 24 scenes per project, 100 objects / 128 cameras / 100 shots per scene, and 1–60 seconds per scene.

Each Muse turn replays that conversation's user/assistant history with the latest project. Questions can receive text-only replies; edits appear as a preview with **Before / After**, **Discard** and **Apply changes**. Scene edits and undo invalidate older previews. Switching conversations, scenes or shots stops an in-flight response. Retry and Update preview return to the original scene and shot context. Each scene-edit API request allows up to 12 model calls shared by the director and asset expert, a stop after two consecutive tool rounds that only repeat earlier results or errors, and one final-plan correction. A chat turn can request one reference-frame extraction and one scene-view follow-up (at most three API requests and 36 Muse calls); its SAM tools share a separate four-attempt cap across those requests. Each expert job allows one construction attempt, one validation correction when needed, and at most three rendered review passes within the same shared call budget. A revised recipe is rendered again even when the reviewer marks that revision approved. Explicitly resuming a failed job creates a new job and preserves the failed original. Network/provider failures and failed expert jobs never restart automatically. Conversations exceeding 200 history messages or 120,000 history characters remain saved and readable, but require a new conversation to continue. Model context uses message replay with `store: false`; encrypted reasoning replay is not part of this version.

Scene editing uses JSON output with a supplied schema, followed by strict local schema validation and an atomic project preview. Each request includes the current scene/entity IDs and actual object counts. Explicit Chinese/English object totals such as “最多 10 个物体”, “剩 9 个物体”, “at most 10 objects” and “exactly 3 objects” are bound to scenes and checked against the full proposed result, including floors and people but excluding cameras/shots and internal asset parts. A compound asset instance counts as one object. Missing or failed checks receive the same single correction attempt. These are per-request constraints; implicit counts in a list of props and arbitrary natural-language constraints are not deterministic checks.

**Download diagnostics** exports this conversation's messages/application receipts and each request's original input, model request, raw output, parsed proposal, native tool calls/results and validation/provider errors, including rejected correction attempts. Inputs are saved as project outputs on the running service before inference; responses are saved before showing a preview. Records survive refresh and a change of browser, and travel with project archives. Headers and API credentials are never included. Diagnostics can also be downloaded separately.

For video analysis, copy `.env.example` to `.env.local` and set `MODEL_API_KEY` and `MUSE_MODEL`. Vite serves the same `/api/reference` handler locally that Vercel runs in production. Model credentials are server-side environment variables.

Provider adapters live in `server/ai/`; the video-analysis workflow and validated scene conversion live in `server/reference/`. The editor consumes ordinary `SceneDocument` data. Replacing the AI provider requires an adapter and a factory entry, without changing the editor.

Reference import accepts MP4/WebM clips of 1–60 seconds, up to 3 MB. The browser scans low-resolution frames locally using adaptive HSV differences, suppresses short exposure flashes, and records hard cuts plus fade-through-black intervals. Uploading a clip shows its shots and selected thumbnails before AI calls; clicking a thumbnail seeks to its exact source time. Each shot keeps a sharp representative frame. Shots with visible change add early/late evidence and distinct intermediate frames, up to 18 frames per clip. Every detected shot is represented; clips with more than 18 shots require a shorter excerpt. General dissolves are not reliably detected by this first version. Selection preserves presentation timestamps, frame indices and reasons in the project analysis checkpoint. SAM measures only selected frames that lack saved detections, with two concepts (people and faces) per atlas; empty results are cached too. Muse still reads the full video for motion between samples and must preserve the detected shot boundaries. The scanner adapts PySceneDetect's HSV/rolling-average method in TypeScript; its BSD license is included under public/licenses/. No Python service or paid inference is used for scanning. Muse identifies recurring characters and set pieces, then uses the existing scene-edit operations and asset tools to build one colored set with shared actor paths and shot cameras. Observation, scene construction and review use high reasoning. Before a native plan is accepted, render_scene inspects the exact operations across every shot using shared meshes, evaluated poses and depth-tested visible bounds. The director finalizes with scenePreviewId and operations=[]; the application retrieves that exact inspected candidate rather than trusting a retyped plan. Its CPU lighting is approximate; the final WebGL video review remains required. render_asset can inspect a particular instance/time, preserving its current joint curves before applying trial angles. Each construction/repair request shares the scene editor's 12-call budget with asset experts. Approved assets survive a budget stop; the client permits one continuation without regenerating them. A run permits up to four rendered reviews. Network/provider failures are retained without automatic retries.

Every revision is rendered against the same original pixels before approval. Paired stills verify framing; an 8 fps video covers the complete rendered timeline and camera cuts. Both original and rendered videos reach the independent reviewer. Source observations receive an independent identity and occlusion audit, including action-relevant supporting people. YuNet facial landmarks run locally in the browser at source resolution (up to 1280 pixels), constrain clear nose/eye direction and retain uncertain or missing measurements. The model and CPU WASM runtime load only during reference processing. Measured pixels and cut times remain fixed; the expert can correct mistaken identities, facing and framing while retaining those measurements. A depth-tested object-ID pass measures the actual visible body bounds, including clipping and occlusion. Geometry-only projections remain available for diagnosis. Numeric checks describe framing and potential occluders; the expert evaluates composition, motion, layout and color. Approval requires complete motion evidence and all quality scores of at least 8. A failed draft is retained for diagnostics and cannot replace the project. Reconstruction quality is still under verification. Canonical person prefabs provide 18 joint axes for head, torso, shoulders, limbs and wrists through the shared property-keyframe system. Loading their older 11-axis form preserves mesh geometry, old poses and animation while adding the missing axes at zero. `set_property_keys` replaces one complete scalar channel; static movable-part poses use `set_asset_joint`. An asset expert can create a clothing or prop variant from a previously read `baseAssetId`, preserving its joints and template. The director can replace an existing instance with a read/generated prefab using `set_asset`, retaining its ID, placement, root/joint keys, components and tint. Incompatible joint channels reject the whole edit. These capabilities do not establish reconstruction quality.

### Local project workspace

The hosted website is the main workspace: projects, assets, conversations and results save automatically to the cloud. **Projects** opens the Gallery with one cover per project, name search and sorting; click a card to enter the editor. No account is required. **Share** provides a code or link.

For local editing, use Node.js 24 or newer and run `run.bat` or `npm run dev` with `LITTLETAKE_MODE=local` and `LITTLETAKE_CLOUD_URL=https://littletake.crazycat.ai`. The Gallery shows cloud projects first; opening one downloads its snapshot to the local service. **Downloaded projects** lists those copies. Local edits, conversations, results and covers have **no autosave**. **Upload to cloud** or Ctrl/Cmd S manually uploads the current content under the same project ID; **Export project** keeps a portable file. Leaving without uploading warns before discarding changes. When the cloud version changed, choose **Replace cloud version** to overwrite it; an active cloud editor blocks replacement. The browser does not maintain a persistent project cache.

The editor's browser renders 640 × 360 WebP covers from the saved active scene at its shot's start, or an overview without a camera. The project service stores covers in SQLite and includes them in backups, copies, archives and cloud transfers. Gallery viewers load shared images without rendering scenes. Hosted projects refresh changed covers when returning to Gallery and at most every five minutes while idle; missing or stale covers refresh on opening the editor. Local covers refresh only during manual upload. Closing the page keeps the last uploaded image. Names and conversations do not trigger new images.

`server/projects/` stores project documents, rendered results and cumulative reference-call budgets in `.littletake/projects.sqlite`. Used asset definitions, all scenes, cameras, shots, property animation and conversations belong to the project document. Look directions, style references, anchor frames, look images, video briefs and reference-analysis checkpoints survive reopening. **Results** opens saved generated work and interrupted analyses. Completed analysis steps are retained; continuing always requires an explicit action. Closing the page cancels its active analysis and rendering.
One editor holds a 90-second lease, renewed every 20 seconds. Other participants view saved changes. Closing normally releases the seat; each page has its own identifier so a delayed old-page request cannot release or save over a reloaded page. Version checks reject stale documents. Unsent changes remain in page memory during a connection failure; keep the page open until saving succeeds, or export a copy. Retrying a create or save uses the original request identity. Hosted projects flush before switching; local editing asks before discarding unsaved changes. A manual upload first stages its snapshot locally, so a failed transfer can be retried without losing that version.

**Export project** downloads a `.littletake.zip` containing the document and all saved outputs. **Import project** restores that archive as a separate project. Older scene/project JSON files remain supported. Project documents are limited to 20 MB, each output to 64 MB, and an archive to 250 MB. Import validation and writes are atomic. Corrupt archives cannot replace an existing project. The SQLite online backup API includes committed WAL data.

Set `LITTLETAKE_DATA_DIR` to move the local data directory; the reusable library defaults to its `assets/` subdirectory. `LITTLETAKE_ASSET_DIR` may override the library location. Production use of these local services requires a persistent Node server. The static Vercel frontend alone does not provide this database.

Private-network HTTP links support editing, project codes, persistence and project archives. Video encoding and reference-video reconstruction need a browser secure context: use `localhost` or HTTPS. Set `LITTLETAKE_ALLOWED_HOSTS` when a development proxy uses a custom hostname.

Verification: `node --import tsx --test server/projects/rooms.test.ts src/project/storage.test.ts src/project/model.test.ts` covers migration, conversations, competing editors, late-page requests, retries, generated outputs, archive import/copy, restart, paid-call ceilings and backup restoration.

### Look frames

**Render → Prepare for Muse → Style reference frames (optional)** styles only the first, middle and last reference with Muse Image (`muse-image-1.0`, `POST /v1/images/edits`), at most three calls per click. Storyboard pages retain the original rendered composition and timing. The clean previs frame is always `@Image1`; each request also lists visible objects with their screen side and depth. With **Keep the look consistent** on, the first finished frame is reused as the scene's appearance reference and persists with the project. An optional style image guides palette and style. `server/look/` builds the request; `/api/look` reuses `MODEL_API_KEY`, accepts `MUSE_IMAGE_MODEL`, and bounds requests to 18 MB using 1280×720 JPEG frames and downscaled references.

### Object appearance references

Reference images live in the project's **Assets → References** folder, which appears automatically. Use **Import images** or drop PNG, JPEG or WebP files into Assets, then drag an image card onto an object to add and bind **Appearance Reference**. Existing images can also be dragged into the component in Inspector. Uploading through the component or dropping a file directly onto an object adds the image to the same folder. The first image is primary; use **Make primary** to change it, and **Appearance notes** to identify the intended subject and features. Each object accepts up to six images. Uploads are compressed in the browser to at most 1280 pixels and 600 KB per image; files over 20 MB are rejected.

Image cards show only the thumbnail and filename. Server uploads temporarily show byte progress over the thumbnail, followed by **Waiting for server…** until the server confirms the save. Failed uploads show **Upload failed** and **Retry** on that image; keep the page open to retry the retained file without creating a duplicate. Pending images cannot be dragged into objects until their upload succeeds. Component uploads show the same progress beside **Upload images**.

Muse receives the actual images with object IDs, names, primary/detail labels and notes. These guide identity and materials while the proxy still defines placement, size, pose and motion. Performance refinement and the asset expert receive the same bindings. **Render → Prepare for Muse** collects references for objects visible during the shot, includes them in prompt generation and optional styled frames, and exports them with `appearance-references.md` in the storyboard ZIP and shared reference page. Disabled components and hidden objects are excluded. Missing images block generation/export with an explanation; one request supports up to 16 distinct reference images.

Bindings are part of the project document; the References folder lists the project's stored image outputs. Dragging the same image onto multiple objects and duplicating objects reuse its image ID; bytes are stored once. Detaching a reference does not remove the image from Assets. Full project archives carry the images and bindings. Cloud projects use the existing server save path; local editing keeps changes in memory until manual upload or complete project export. Shared prefab templates do not carry project-specific references. Verification and remaining device coverage are recorded in [appearance reference verification](docs/verification/appearance-reference.md).

### Video brief and package

**Render** contains **Still image**, **Video** and **Prepare for Muse**. Preparation samples every 0.5 seconds plus the last frame inside the selected shot, builds 3×3 storyboard pages, and provides a separate 1920×1080 first frame. A four-second shot has nine frames on one page; longer shots paginate with continuous frame numbers and shot-relative timestamps. Capture runs in the user's browser on a frozen scene snapshot, yields between frames and supports cancellation. It makes no model calls. **Generate prompt** makes one Muse Spark call with all storyboard pages plus up to three individual opening/styled references, sampled object/camera poses, joints and timing. A 60-second shot is bounded to 121 source frames and 14 pages; `/api/brief` allows at most 17 images under 900 KB each and a 22 MB request.

The full editable prompt includes creative direction, camera movement, timed beats and explicit instructions to interpret the boards as successive moments of one continuous shot, excluding grids, labels and slideshows from the result. Edits save with the project; **Copy full prompt**, `brief.md`, the manifest and the public reference page use the exact same text. **Download storyboards & prompt** packages the opening image, pages, source stills and optional style references. Attach the first frame and all pages manually in Muse. The package has no input video; ordinary **Render → Video** remains available for WebM export. The editor does not call a video-generation API. Import the finished video when ready.

### Project script components

Muse can write, check and attach reusable JavaScript controllers. Script parameters appear in Inspector; control and recording use the existing performance workflow. Definitions save with the project and support checked hot reload. See [script authoring, storage and runtime](src/scripts/README.md).

### Asset library and modeling expert

The local reusable library uses stable prefab IDs and atomic file writes. Project documents embed the definitions they use; independent instances keep their placement, components and root/joint animation. The asset workshop and bounded expert share the same recipe and rendering implementation as the scene.

Each scene's optional `look` stores background, ground, ambient/key light and exposure. Open its card in **Assets / Scenes** to edit these in Inspector; Muse uses `set_scene_look`. Preview and exports share the same lighting. The local quality harness runs with `npx tsx src/reference/harness/server.ts` at port 4181. It preserves source frames, original proposals, calibrated renders, per-shot top views, per-round feedback and request diagnostics under `output/verification/reference-quality/`, with a persisted hard call ceiling. It can resume a saved run, compare raw/calibrated proposals without inference and play the original and reconstructed scene together.

CPU asset previews use per-pixel depth testing. Generation reviews include rest and articulated trial poses, and revision tools can render explicit joint angles. See the [complete real-Muse acceptance flow and portable project](docs/verification/asset-toolkit.md).

### Reference-frame geometry and spatial tools

Reference-frame segmentation uses `SAM_PROVIDER=cloud` by default. A prepared local CUDA installation can select `local` through `/api/segmentation` or the geometry CLI; [setup and benchmark instructions](server/reference/geometry/README.md) live with the module. The existing reference-video tracking and look-frame flows remain available.

Muse conversations accept an original image or clip through **+ Reference**. Loading a clip in **Video or sketch** shares it with the active conversation as well. The browser selects up to six candidates using cuts, sharpness and temporal coverage, retaining decoded timestamps. Muse inspects the contact sheet, reads chosen originals with `read_reference_frame`, and calls `segment_reference` for a short noun concept. It can use `request_reference_frame` to ask for up to two additional timestamps before continuing. These are original reference pixels, separate from rendered scene views.

Original reference media and segmentation observations are saved with their conversation as project outputs on the running service. Previous browser-only content is archived on the service before the old browser records are cleared. The portable project archive includes this media and supports later timestamp requests after import on another browser. Legacy JSON exports do not include media; request diagnostics contain the frames used for that request. Each user turn allows at most four new SAM attempts across frame and scene-view follow-ups, including failures. Matching cached observations are reused; provider failures are not automatically retried. SAM returns 2D masks and composition measurements; it does not establish depth or metric layout.

Agent safeguards apply to one task, not a cumulative development quota: the director stops after two consecutive tool rounds with no new successful observation, with twelve shared Muse calls per backend request. Completed observations and ready assets survive a stop; scene edits remain a reviewable proposal. Development verification records calls and errors without a lifetime call ceiling.

[Spatial operations](src/spatial/README.md) provide measured support placement, relative edge gaps, facing, alignment, distribution, anchors and paths through scene edits, Muse tools and `POST /api/spatial`. They share viewport geometry and the editor's whole-animation transform logic, preserving property key times, interpolation and takes.
### Optional background worker (paused)

The separate worker in `server/reference/jobs/` is retained from the advanced work. It is not used by the editor's foreground workflow and is not started by `npm run dev`. It has not been deployed. `npm run jobs` and `npm run verify:jobs` remain available for its isolated implementation and fixture verification; its optional URL, key and data directory are listed in `.env.example`.
