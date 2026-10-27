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

### AI Understanding

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Muse integration** | Video input, scene understanding and structured scene proposals. | Done |
| **P0** | **Tool Calling & Harness** | Model context, scene tools, execution, validation and feedback loops. | Todo |
| **P2** | **Vision adapters** | SAM 3.1 Segmentation for reference images/video through Meta Model API. | Todo |
| **P2** | **SAM 3D Body service** | Separate model deployment and inference for human 3D pose estimation from reference frames. | Todo |

### Authoring

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Scene & project model** | A shared editable representation of objects, actions, cameras and timing, with project storage. | Partial |
| **P0** | **Desktop editor** | Mouse/keyboard tools for direct scene editing. | Done |
| **P0** | **AI scene editing** | Edit layout, objects, motion and cameras through Muse text instructions and scene tools. | Todo |
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
| **P0** | **Proxy asset system** | Low-poly geometry, asset recipes and semantic descriptions. | Partial |
| **P1** | **Asset library & templates** | Reusable proxy assets, categories and prepared scenes. | Todo |
| **P1** | **AI asset composition** | Compose missing proxy objects from simple 3D parts. | Todo |

### Rendering

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Three.js runtime** | Scene rendering, camera evaluation and synchronized playback. | Done |
| **P0** | **Previs rendering & export** | Render and export proxy frames and animation as visual guidance for final video generation. | Todo |

### Deployment

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Vercel deployment** | Publish an HTTPS desktop web demo with Git-based production and preview deployments. | Done |

## Development

```sh
npm install
npm run dev
```

`npm test` checks scene data, motion interpolation and undo/redo. `npm run build` produces the deployable app in `dist/`.

Vercel deploys `main` to production and creates previews for other branches and pull requests.

The studio includes six primitives, transform tools, an independent shot preview, start/end motion tracks, local saves, JSON export and reference-video import. The in-app **Shortcuts** panel lists navigation controls. AI scene editing and previs image/video export remain planned.

Storage currently keeps one active scene in this browser, with scene JSON import/export. A project library and multiple scenes per project are not implemented yet.

For video analysis, copy `.env.example` to `.env.local` and set `MODEL_API_KEY` and `MUSE_MODEL`. Vite serves the same `/api/reference` handler locally that Vercel runs in production. Model credentials are server-side environment variables.

Provider adapters live in `server/ai/`; the video-analysis workflow and validated scene conversion live in `server/reference/`. The editor consumes ordinary `SceneDocument` data. Replacing the AI provider requires an adapter and a factory entry, without changing the editor.

Reference import currently accepts MP4/WebM clips of 1–60 seconds, up to 3 MB. It builds a coarse single-shot draft with separate objects, basic motion and a camera. Review it before replacing the current scene; Undo restores the previous scene. Geometry, depth and motion are AI estimates, with simplifications shown in the review.
