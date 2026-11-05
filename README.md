# LittleTake

> The scene is the prompt.

Build and animate an editable low-poly scene, then use it to direct AI video.

Built for the **Meta Global AI Developer Hackathon** by Zhening Zhu, Qingxuan Yan and Xiang Chang. Powered by Muse.

**Try it:** [littletake.crazycat.ai](https://littletake.crazycat.ai)

## Why

AI video models are powerful, but describing actions, camera movement and the relationships between objects through long prompts is hard. LittleTake lets everyday creators show those intentions with an editable 3D scene and a rough performance.

![LittleTake creator flow](docs/assets/creator-flow.png)

## What you can do

- **Describe a scene.** Muse builds characters, a set, cameras and shots from a sentence. Every edit is a preview you can compare and apply.
- **Start from a reference.** Turn a clip, storyboard or sketch into an editable proxy scene.
- **Perform the shot.** Edit keyframes, or record objects and cameras live with Pilot. Muse can refine a take.
- **Direct the look.** Attach appearance references and generate storyboards with Muse Image.
- **Hand it off.** Export PNG frames, WebM previs and a video brief for an AI video model, then import the finished video.
- **Step inside.** Experimental [WebXR](docs/webxr.md) for working in the scene in VR.

## How it uses Meta models

| Model | Used for |
| --- | --- |
| Muse Spark | Scene design, the tool-calling director, the asset expert, visual review and video briefs |
| Muse Image | Scene concepts and AI storyboards |
| SAM | Segmenting objects in reference frames |

## Run locally

Requires Node.js 24 or newer.

```sh
npm install
cp .env.example .env.local   # then set MODEL_API_KEY
npm run dev
```

On Windows, run `setup.bat` once, set `MODEL_API_KEY` in `.env.local`, then run `run.bat`.

```sh
npm test                     # run the tests
npm run build && npm start   # run the production server
```

## Project layout

| Path | Contents |
| --- | --- |
| `src/` | The editor |
| `server/` | The application server and Muse workflows |
| `api/` | Serverless API entry points |
| `public/` | Static assets and examples |
| `docs/` | Documentation |

More detail: [deployment and storage](server/app/README.md), [spatial operations](src/spatial/README.md), [script components](src/scripts/README.md), [asset toolkit](src/assets/toolkit/README.md), [local geometry tools](server/reference/geometry/README.md).
