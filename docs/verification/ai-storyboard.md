# AI storyboard verification — 2026-11-03

## Implemented behavior

The formal **Render → Storyboards → AI storyboard** flow generates one 2×2 sheet in one Muse Image request. Four moments and their actions are editable. The original image is saved and downloaded unchanged; individual export images are native-resolution crops. There are no per-panel enhancement calls or automatic grid-generation retries.

This is a shared feature for all projects. The prompt combines the creator's story, each moment's action, measured screen bounds and subject-relative camera direction. Appearance references define identity; proxy views define staging. Rigid proxy poses allow expressive articulation. Full-body framing and occlusion constraints apply to every scene, without scene-name conditions.

## Verified application flow

Used the production build and actual application service in isolated cloud-mode SQLite workspaces, with real Muse APIs:

- Generated and saved a 2048×1152 WebP sheet through Render, including bound Appearance References in the knight/dragon case.
- Compared the sheet with its four original proxy frames; changed a panel time and direction. The old image retained its original timestamps and export stayed disabled until regeneration.
- Refreshed the page and restarted the service. Saved settings and results resumed without another paid image request; the restored original download matched the provider bytes.
- Generated a real Muse video prompt from the sheet, illustrated opening, sampled motion and appearance references. Editable prompt text and exact timing survived export.
- Downloaded ZIP packages and parsed them with the application's public-package validator. The latest package is **1,673,510 bytes**: unchanged original sheet, four illustrated crops, four proxy sources, prompt and manifest. Times are **0, 2, 3.9583333333333335 and 5.958333333333333 seconds**.
- Opened saved sheets in Renders. Earlier per-panel drafts remain readable.
- Published and reopened a local reference snapshot containing the original sheet, opening image, prompt, appearance references and explicit panel times.
- Checked the interface at 1280×720. The sheet and download actions fit; moment editing and video-prompt sections are collapsible. Final browser console had no errors.

Generation and package checks use isolated test projects; no production project was edited.

## Cross-scene visual checks

The final sweep tested three different six-second scenes through the same shared prompt, alongside the earlier knight/dragon orbit, elevation and camera-distance comparisons.

| Case | Observed behavior and remaining limitations |
| --- | --- |
| Two-person conversation | Clothing and identities stay recognizable; gestures, reverse views and overhead framing appear. Full-body wording avoids the initial faded legs, but figures are still enlarged and a mostly hidden participant can be revealed. |
| Moving vehicle | One teal car remains recognizable across front, elevated and rear views. Road markers and broad distance changes are retained. Fine framing and set dressing still vary. |
| Three people behind a pillar and wall | Most pillar/wall geometry, reverse angle, overhead framing and partial occlusions survive. A fully hidden person was correctly omitted in one result but revealed in a repeat. Occlusion is **not reliably enforced**. |
| Knight/dragon action | Bent knees, defensive poses, torso turns and reactions replace repeated neutral poses. Rear and overhead views improve with measured viewing-side descriptions, but exact beats, subject scale and camera angles still drift. |

The latest sweep made **8 image attempts: 7 successes and 1 HTTP 401 caused by the test runner using the wrong credential variable**. The runner was corrected; production authentication was unchanged. Successful requests took roughly 11–23 seconds. One real brief call succeeded in 12.4 seconds. A persistent cap of eight image requests and one brief request prevents further generation from this test workspace. No automatic paid retries occurred.

Earlier bounded camera tests made 15 image attempts (14 successful and one HTTP 400), and the earlier integrated four-image test included both appearance references and action directions. The current evidence supports better coarse view guidance and more expressive acting, **not exact camera reconstruction or a guaranteed accuracy percentage**. Compare proxy remains available for review. Requested API dimensions do not guarantee output dimensions; the UI shows the actual resolution without a 4K claim.

## Corrected export and persistence issues

- A generated grid's divider was offset by 11 pixels. Native crop extraction now detects a clear seam near the midpoint, avoiding a strip from the previous panel while leaving the original sheet untouched.
- Refresh produced a false stale-result warning from negligible JPEG raster noise. New results compare frozen scene/camera/asset inputs. Legacy results tolerate only negligible pixel noise. Actual source, reference, timing or direction edits still invalidate the current sheet.
- Cancelled or failed generation retains the prior result. A save failure offers retry without making another paid image request.

## Automated validation

**37 focused tests passed**, and the production TypeScript/Vite build and `git diff --check` passed. The build reports the existing large-chunk warning.

```text
npx tsx --test src/look/ai-storyboard.test.ts tests/look.test.ts tests/brief.test.ts server/handoffs/workflow.test.ts src/appearance/workflow.test.ts
npx tsx --test src/project/storage.test.ts src/project/model.test.ts server/projects/rooms.test.ts server/projects/cloud.test.ts server/projects/collaboration.test.ts
npm run build
```

Coverage includes one-request grid generation, reference image order, duplicate clicks, cancellation, save retry, source invalidation, SQLite restart, archive round trips, short-shot repeated frames, unmodified image bytes, exact package timing and project/collaboration preservation.

## Evidence

- `output/verification/storyboard-generalization-20261103/`: three fixture projects, exact prompts and inputs, all image results, capped API log, `export-report.json`, and `render-final.png`. Test rooms: Dialogue `4R3PZWD679T2`, Vehicle `9HNA88RFB2ZQ`, Occlusion `7ZLVF94LX4CB` at `http://127.0.0.1:10570/` while the isolated server runs.
- `output/verification/camera-adherence-20261103/`: orbit/elevation/distance inputs and results, formal Render generation with appearance images, refreshed download and `render-restored-final.png`.
- `output/verification/storyboard-2x2-20261103/`: appearance/action integration, ZIP validation, Renders, reference sharing and restart verification.

These generated artifacts are local verification evidence and are excluded from Git. Release deployment evidence is stored separately under `output/verification/deploy-<commit>/` after activation.
