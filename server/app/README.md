# Persistent LittleTake application

Node 24 serves the built editor and the same APIs used in development. One shared workspace: anyone who opens a project can edit it immediately; account separation remains deferred.

The hosted website is the main workspace: `LITTLETAKE_MODE=cloud` (also the default when `LITTLETAKE_PUBLIC_URL` is set) lists cloud projects and automatically saves their scenes, assets, conversations, results and covers. For local development, set `LITTLETAKE_MODE=local` and `LITTLETAKE_CLOUD_URL=https://littletake.crazycat.ai`. The Gallery lists cloud projects first; opening one downloads its snapshot under `.littletake/` or `LITTLETAKE_DATA_DIR`. Local edits have no autosave, including conversations, results and covers. **Upload to cloud** or Ctrl/Cmd S explicitly stages the current project and replaces the same cloud project; Export project writes a portable file. A failed upload keeps the staged local copy for retry. If the cloud changed, replacing it requires choosing **Replace cloud version**. Other open pages receive the replacement; their unacknowledged property edits are merged over it. `LITTLETAKE_CLOUD_PASSWORD` is only needed for a private deployment. Browser storage does not hold projects.

The browser is the UI in either case. It does not persist project documents, project lists, media, AI diagnostics or prefab drafts. Hosted editing saves these to the running service automatically; local editing retains changes in page memory until manual upload or export. Normal editing has no save-status text. Leaving with unsaved changes warns before discarding them. During a connection failure, keep the page open and retry or export a copy. UI preferences and the editing session ID may remain in browser storage.

Upgrade cleanup moves old browser content into a private ZIP under `browser-recovery/` on the running service before clearing the browser records. It preserves binary media and does not insert those old snapshots into the project list. The Projects page offers downloading that backup in the migration session. If backing up fails or old browser records change during migration, their newer copies remain untouched. Empty legacy database containers may remain; new project data is never written to them.

Every project has a stable UUID, retained across cloud transfers and `.littletake.zip` exports. The short join code is specific to a workspace. Transfers include scenes, embedded asset definitions, conversations and all saved result/media blobs. Global reusable libraries stay with their workspace; used asset definitions travel with the project. Manual uploads compare a content revision that includes output-only changes, and reject a newer cloud revision. A lost upload response can be retried without creating another project. When both copies have changed, the UI can retain a separate local copy before opening the cloud version, or upload local work as a new project. Existing public reference links remain on the workspace that published them.

Older archives without an identity get a new UUID. Importing an ID already in the workspace offers opening it or explicitly importing a copy. Cloud transfer verification: `npx tsx --test server/projects/cloud.test.ts`. This uses isolated local HTTP servers and makes no paid model calls.

```sh
npm ci
npm run build
npm start
```

Deployment environment:

```dotenv
LITTLETAKE_HOST=0.0.0.0
PORT=8080
LITTLETAKE_DATA_DIR=/data
LITTLETAKE_PUBLIC_URL=https://your-app.example
LITTLETAKE_PUBLIC_WORKSPACE=1
MODEL_API_KEY=<set on the server>
MUSE_MODEL=muse-spark-1.3-contributor
```

Use HTTPS at the ingress/reverse proxy. The hosted demo is a public shared workspace: open the project list without signing in. `LITTLETAKE_PUBLIC_WORKSPACE=1` explicitly enables this mode and overrides any old shared password. Opening a project automatically creates an independent page session for saves and model requests. Sessions do not exclude other editors, and closing one page does not affect another page. A private deployment can omit public mode and set `LITTLETAKE_WORKSPACE_PASSWORD` for HTTP Basic authentication with username `littletake`. Non-loopback startup requires one of these two explicit configurations.

Hosted projects collaborate live. Property changes are batched for 100 ms and ordered by the server; different properties merge and the last received write wins on the same property. Entity arrays use stable IDs, vectors merge by axis, and animation keys merge by time. A held HTTP read returns as soon as a committed change arrives, then reconnects with the latest content version. Unacknowledged changes stay in page memory and reapply over incoming snapshots. Durable edit receipts prevent a lost response from replaying an older write. Local mode does not connect to this live channel.

Undo/redo stores only this page's operations. Conditional inverses and server-side property ownership preserve later edits by other pages, including a property changed back to the same value. Navigation, selection, playback and unsent chat drafts remain personal to each page. Incoming changes wait for the current input, transform or recording to finish. A committed scene change invalidates a pending Muse scene proposal; starting a second page does not interrupt the first page's running conversation. Structural edits are validated atomically; an incompatible edit is retained in the page with export/copy recovery. Result blobs retain timestamp version checks. Expired editing sessions reconnect automatically.

Collaboration verification: `npx tsx --test server/projects/collaboration.test.ts` covers two HTTP clients, concurrent properties and keyframes, private navigation, local undo, duplicate requests, disconnection, deletion and database restart.

Mount `/data` on a persistent disk. Keep one writable application instance per directory. `projects.sqlite` stores projects, conversations, reference media, diagnostics, prefab drafts, generated/imported outputs and immutable video-reference packages; `assets/` stores the reusable asset library. A fresh browser loads the project list and content from this service.

The deployment image is built with `docker build -f server/app/Dockerfile -t littletake .`. Provide secrets and the persistent volume at runtime. No cloud resources are provisioned by these files. Static Vercel deployments alone do not provide this storage service.

For the VM deployment, mount the data disk at `/srv/littletake`, put the runtime environment above in `/etc/littletake/app.env` (owner-only access), and run `docker compose -p littletake -f server/app/compose.yaml up -d --build`. The companion Caddy service serves `littletake.crazycat.ai` with automatically renewed HTTPS; point that subdomain to the VM's reserved IP. Only ports 80 and 443 are public. Application port 8080 is bound to loopback. Keep the data disk when replacing the VM, and back it up with a daily disk snapshot retained for seven days.

The hosted workspace is [littletake.crazycat.ai](https://littletake.crazycat.ai). It runs on one VM. Its data disk is retained if the VM is deleted, and daily snapshots are kept for seven days. It uses no login; all visitors see the same project list. Caddy serves `/demo.mp4` from `/srv/littletake/caddy/data/public` on that disk, so the demo video is not in this repository and can be replaced without a deployment.

The old `littletake.vercel.app` production address redirects to the hosted workspace through the [Vercel project routing rule](https://vercel.com/qingxuan-yans-projects/littletake/cdn/routing). That rule is scoped to this hostname; branch preview domains keep their own deployments. Vercel's static deployment does not host the persistent project API.

Migration: export each old project as a `.littletake.zip` archive, then import it on the deployed application. Export/import includes saved outputs. For an existing local service, its entire data directory can instead be transferred while it is stopped; retain the original. Back up both SQLite and the asset directory. Do not copy only the SQLite main file while a live WAL may contain committed data; `ProjectRoomStore.backupTo` uses SQLite's online backup API.

**Projects** in the upper left opens the project gallery. **Render** creates a PNG still or WebM video from the active shot in the browser and adds it to **Renders**. Hosted projects save these files to the server; local projects retain them until manual upload or project export. **Export project** is in the three-dot project menu. Reference inputs remain in Muse's **+ Reference**, with **Scene from video or sketch** in the project menu.

In **Render → Storyboards**, **Proxy storyboard** renders a separate first-frame image and 3×3 pages at 0.5-second intervals, including the shot's last frame. **AI storyboard** generates one 2×2 sheet from four editable key moments, with bound object appearance and optional style references. One explicit action makes exactly one image request, without per-panel generation, enhancement or automatic retries. The original sheet and its source/timing snapshot save together and resume on reopen. Failed requests retain previous results, and **Retry save** does not call the model again. Review generated images against their proxies because composition can drift.

**Render with Muse** prepares the prompt and selected storyboard, publishes a fixed reference page and copies a request containing its URL. The creator pastes the request into Muse. A linked local project can publish the shot’s reference package to its configured cloud workspace. A standalone local workspace can preview the page locally. **Download package** contains the same prompt and images, including the original AI sheet when selected. **Previous links** lets the creator withdraw a publication. **Renders → Import finished video** saves the returned MP4 or WebM with the current shot.

Local links cannot be opened by Muse's cloud browser. Validate external access and reference-image ingestion after deploying to public HTTPS. A withdrawal makes the page, raw media, manifest and ZIP unavailable; it cannot erase copies already downloaded by recipients.

Verification: `npx tsx --test server/handoffs/workflow.test.ts server/projects/rooms.test.ts src/project/storage.test.ts` checks actual HTTP publication, private-workspace access, project/output restart recovery, fresh-client listing, fixed public snapshots, raw image/ZIP retrieval, retries, corrupt packages and withdrawal. It makes no paid model calls.
