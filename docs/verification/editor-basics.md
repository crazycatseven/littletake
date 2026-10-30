# Editor basics integration verification

Verified locally on 2026-10-27 using the production editor at `http://localhost:4176/`, separate from the user's `127.0.0.1` browser storage. No model inference, commit or push was performed.

## Automated checks

`npm run build` passed. Vite reports the existing large main-bundle advisory; the video encoder is a separate dynamically loaded chunk.

`npx tsx --test tests/model.test.ts tests/scene-edit.test.ts src/project/*.test.ts src/placement/*.test.ts src/performance/*.test.ts src/components/*.test.ts` passed **37/37** tests. The visibility workflow covers batch undo/redo, project serialization/reopen, retained recorded motion and pivot components, and preservation through unrelated scene operations.

## Production browser workflows

- Ctrl-click and Shift-range Hierarchy selection; batch Hide; one Undo restores the whole batch. Hidden rows remain selectable, with disabled transforms and an explicit export exclusion count. Refresh restores visibility.
- H hides selected objects; Alt+H restores all. The existing Hierarchy right-click **Create Independent Prefab…** entry remains available. Object rows retain their prefab drag data; eye controls are separate, non-draggable siblings.
- Align X Left with Performer, hidden Low plinth and Sculpture selected: Sculpture is the last visible selection and remains fixed. Performer and both motion endpoints move by **+3.609 m**. The hidden plinth, unselected asset, camera and shot remain unchanged. Downloaded project files before and after one Undo have identical scenes.
- Numeric rotation is reflected in Local axes. Actual viewport dragging with a **1 m** translation snap ends at X=4. The snap increment applies immediately when edited.
- PNG at 1920×1080 is generated, previewed and downloaded. WebM uses the shot's **1.00–3.50 s** scene range and excludes the hidden plinth. Media inspection confirms:

| Output | Codec | Frames | Duration |
| --- | --- | --- | --- |
| 1920×1080, 24 fps | VP9 | 60 | 2.500000 s |
| 1280×720, 30 fps | VP9 | 75 | 2.500000 s |

- The video's decoded first frame matches the separately rendered scene-time 1.00 s PNG, with mean RGB absolute error below 1.3/255 from video compression/color conversion. The last frame shows the evaluated actor and camera movement. No editor grid, selection ring or gizmo is present.
- Cancel produces no partial download; the same dialog successfully exports again. Export leaves the live scene and playhead intact. Browser console reports no application errors during these workflows.

Local screenshots, downloaded files and before/after projects are in `output/verification/editor-basics/` (ignored by Git). Video encoding requires a WebCodecs-capable browser on localhost or HTTPS. On insecure remote HTTP, the dialog explains the requirement; PNG export remains available.
