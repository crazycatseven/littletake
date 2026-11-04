# Appearance Reference verification

Verified locally on 2026-11-03 in the formal editor at `http://127.0.0.1:4176/`, using an isolated imported copy named **QA Appearance References 2026-11-03**. No production project was changed, and this feature has not been committed, pushed or deployed.

## Automated checks

`npm run build` passed. The existing Vite large-chunk advisory remains.

The following targeted suites passed, **52 tests total**:

```sh
npx tsx --test src/appearance/workflow.test.ts tests/brief.test.ts src/project/storage.test.ts src/scene-edit/session.test.ts src/components/pivot.test.ts src/performance/refinement.test.ts
npx tsx --test tests/look.test.ts server/handoffs/workflow.test.ts server/assets/workflow.test.ts server/assets/editor.test.ts server/projects/collaboration.test.ts
```

The new workflow checks cover concurrent scene edits, object duplication without duplicating image bytes, server restart, full project transfer, missing-image rejection, hidden-object exclusion, exact image bindings in scene-edit requests, real image content in brief requests, multipart image ordering for styled frames, and the ZIP/shared-page reference mapping.

## Browser and real Muse checks

- Added Appearance Reference through the searchable component picker and uploaded `public/examples/knight-vs-dragon.webp` to Performer. The preview, primary label and appearance notes were visible in Inspector.
- Reused the same image on a second object, then removed that test component. The temporary **Project images** picker was subsequently replaced by **Assets / References**, as verified below.
- One real Muse conversation call received the reference pixels and object binding. Its reply correctly described the silver armor, blue chest panel, red plume and the knight on the right, and identified Performer as the bound object.
- One real **Generate prompt** call received three storyboard/previs images and the bound appearance image with its notes. The generated prompt used the knight's appearance and retained the recorded blocking and camera timing. No styled-image generation calls were made.
- Downloaded the five-second shot package: 11 source frames, two storyboard pages, the appearance image and its mapping guide. The image bytes exactly matched the image in the complete project archive.
- Imported that complete project archive as a new project. The component, primary image and notes were restored and the image loaded successfully. No application warnings or errors were captured in that browser tab.

Screenshots, downloaded archives and the verification summary are under `output/verification/appearance-reference-20261103/` (ignored by Git).

## Assets folder follow-up

- Existing reference images appeared automatically in **Assets / References** after opening the imported project. Imported `public/examples/golden-gate-flight.webp` through **Import images**; both images appeared with thumbnails.
- Dragged an image card onto Sculpture in the 3D viewport. It added and bound the component; Undo removed the binding while retaining the image in Assets.
- Dragged the second image into Performer's existing component. Fixed drop acceptance on `dragenter` so fast drags across component children also work. A repeated drop reported **This reference is already attached** and retained only one binding to that image.
- Reloaded the local project and confirmed its library images and component bindings were restored. A final export reused two image outputs across three bindings on two objects, without duplicating image bytes (`assets-reference-project.zip`).
- `npm run build` and the appearance workflow, asset workflow and project collaboration suites passed again (12 tests). No additional model calls were made for this follow-up.
- The local save shortcut invokes cloud upload when a cloud connection is configured. The QA upload attempt returned **The project archive is incomplete or corrupt. Your saved projects are unchanged.** from the deployed server. This feature is not deployed; cloud transfer of its new reference-image output type still needs verification after deployment.

The OS-file drag/drop handler is wired to the viewport's object picker and uses the same upload/attachment path. The browser automation cannot synthesize external file drags, so this gesture still needs a manual desktop check. Production cloud/browser validation and live styled-image generation were not performed in this run.

## Image upload feedback follow-up

Verified the production build against an isolated local server in cloud mode at `http://127.0.0.1:9623/`, project **QA Reference upload progress**, on 2026-11-03. No production data or model API was used.

- Reference cards now show only the thumbnail and filename, with the full filename in a tooltip. Upload and failure overlays disappear after a successful server acknowledgement.
- Throttled real browser uploads showed actual byte percentages, including 54% and 74%. Stopped this isolated server during an upload: the image showed **Upload failed** and its own **Retry** button. Restarted the server and retried successfully; no duplicate image appeared.
- Added latency to a component upload and observed **Waiting for server…** in both Inspector and Assets after all bytes were sent. The image was attached only after the server confirmed it was saved.
- Restored normal network conditions and reloaded. All three images and the component binding loaded from the isolated server, with no remaining transfer indicators.
- `npm run build` passed; the appearance workflow, project storage and project collaboration suites passed (6 tests). The persistence test also verifies an identical upload retry returns the same output instead of duplicating it.

Screenshots are in `output/verification/reference-upload-20261103/` (ignored by Git). These changes remain local and are not committed, pushed or deployed.
