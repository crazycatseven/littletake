# LittleTake

> LittleTake lets anyone build and animate editable low-poly proxy scenes to guide AI models in creating videos.

A project for the **Meta Global AI Developer Hackathon**.

## Why

AI video models are powerful, but describing actions, camera movement, and relationships between objects through long prompts remains difficult. LittleTake lets everyday creators express those intentions through an editable 3D scene and a rough performance.

## Creator Flow

![LittleTake creator flow](docs/assets/creator-flow.png)

Reference clips are analyzed into editable proxy scenes; scenes can also be created manually. Proxy animation provides visual guidance for AI video generation.

## Features

Desktop scope: mouse/keyboard authoring, text prompts and reference clips.

### AI Understanding

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Muse integration** | Video input, scene understanding and structured scene proposals. | Todo |
| **P0** | **Tool Calling & Harness** | Model context, scene tools, execution, validation and feedback loops. | Todo |
| **P2** | **Vision adapters** | SAM 3.1 Segmentation for reference images/video through Meta Model API. | Todo |
| **P2** | **SAM 3D Body service** | Separate model deployment and inference for human 3D pose estimation from reference frames. | Todo |

### Authoring

| P | Module | Scope | Status |
| --- | --- | --- | --- |
| **P0** | **Scene & project model** | A shared editable representation of objects, actions, cameras and timing, with project storage. | Done |
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
| **P0** | **Vercel deployment** | Publish an HTTPS desktop web demo with Git-based production and preview deployments. | Todo |

## Development

```sh
npm install
npm run dev
```

`npm test` checks scene data, motion interpolation and undo/redo. `npm run build` produces the deployable app in `dist/`.

The studio includes six primitives, transform tools, an independent shot preview, start/end motion tracks, local saves and JSON export. The in-app **Shortcuts** panel lists navigation controls. AI integration and previs image/video export remain planned.
