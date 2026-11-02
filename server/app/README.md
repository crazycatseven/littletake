# Persistent LittleTake application

Node 24 serves the built editor and the same APIs used in development. One shared workspace, with one editor per project; account separation remains deferred.

Local/cloud workflow: running `run.bat` or `npm run dev` starts LittleTake on the local computer. Its projects and assets live under `.littletake/` (or `LITTLETAKE_DATA_DIR`), independently of browser storage. Set `LITTLETAKE_MODE=local` and `LITTLETAKE_CLOUD_URL=https://littletake.crazycat.ai` to enable **Open from cloud** and the header's **Upload to cloud** icon. `LITTLETAKE_CLOUD_PASSWORD` is only needed for a private, password-protected deployment. Uploading is optional; local projects can stay entirely on that computer. The hosted website (`LITTLETAKE_MODE=cloud`, also the default when `LITTLETAKE_PUBLIC_URL` is set) lists and saves cloud projects only.

The browser is the UI in either case. It does not persist project documents, project lists, media, AI diagnostics or prefab drafts. These save to the running service after a short debounce; normal editing has no save-status text. Unsent changes remain in page memory, and leaving the page warns until they are saved. During a connection failure, keep the page open and retry or download a copy. UI preferences and the editing session ID may remain in browser storage.

Upgrade cleanup moves old browser content into a private ZIP under `browser-recovery/` on the running service before clearing the browser records. It preserves binary media and does not insert those old snapshots into the project list. The Projects page offers downloading that backup in the migration session. If backing up fails or old browser records change during migration, their newer copies remain untouched. Empty legacy database containers may remain; new project data is never written to them.

Every project has a stable UUID, retained across cloud transfers and `.littletake.zip` exports. The short join code is specific to a workspace. Transfers include scenes, embedded asset definitions, conversations and all saved result/media blobs. Global reusable libraries stay with their workspace; used asset definitions travel with the project. Manual uploads compare a content revision that includes output-only changes, and reject a newer cloud revision or another active cloud editor. A lost upload response can be retried without creating another project. When both copies have changed, the UI can retain a separate local copy before opening the cloud version, or upload local work as a new project. Existing public reference links remain on the workspace that published them.

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

Use HTTPS at the ingress/reverse proxy. The hosted demo is a public shared workspace: open the project list or join with a project code, without signing in. `LITTLETAKE_PUBLIC_WORKSPACE=1` explicitly enables this mode and overrides any old shared password. Project edits and model requests still require the active editing session. A private deployment can omit public mode and set `LITTLETAKE_WORKSPACE_PASSWORD` for HTTP Basic authentication with username `littletake`. Non-loopback startup requires one of these two explicit configurations.

Mount `/data` on a persistent disk. Keep one writable application instance per directory. `projects.sqlite` stores projects, conversations, reference media, diagnostics, prefab drafts, generated/imported outputs and immutable video-reference packages; `assets/` stores the reusable asset library. A fresh browser loads the project list and content from this service.

The deployment image is built with `docker build -f server/app/Dockerfile -t littletake .`. Provide secrets and the persistent volume at runtime. No cloud resources are provisioned by these files. Static Vercel deployments alone do not provide this storage service.

For the VM deployment, mount the data disk at `/srv/littletake`, put the runtime environment above in `/etc/littletake/app.env` (owner-only access), and run `docker compose -p littletake -f server/app/compose.yaml up -d --build`. The companion Caddy service serves `littletake.crazycat.ai` with automatically renewed HTTPS; point that subdomain to the VM's reserved IP. Only ports 80 and 443 are public. Application port 8080 is bound to loopback. Keep the data disk when replacing the VM, and back it up with a daily disk snapshot retained for seven days.

The hosted workspace is [littletake.crazycat.ai](https://littletake.crazycat.ai). Its VM is `littletake-server` in `ai-mock-interview-488402`, zone `us-central1-a`, with a dedicated `littletake` VPC and reserved address `34.44.159.175`. The `littletake-data` disk is retained when the VM is deleted. Snapshot policy `littletake-daily` runs at 07:00 UTC and retains seven days. A separate initial migration snapshot is retained as `littletake-initial-20261101`. The cloud workspace was cleared on 2026-11-01. Its previous projects, personal assets and original Muse/dragon deliverables are preserved privately under `/srv/littletake/backups/cleared-workspace-20261101T225420Z/data`, outside the active workspace and website. The hosted workspace uses no login; all visitors see the same project list.

The old `littletake.vercel.app` production address redirects to the hosted workspace through the [Vercel project routing rule](https://vercel.com/qingxuan-yans-projects/littletake/cdn/routing). That rule is scoped to this hostname; branch preview domains keep their own deployments. Vercel's static deployment does not host the persistent project API.

Migration: export each old project as a `.littletake.zip` archive, then import it on the deployed application. Export/import includes saved outputs. For an existing local service, its entire data directory can instead be transferred while it is stopped; retain the original. Back up both SQLite and the asset directory. Do not copy only the SQLite main file while a live WAL may contain committed data; `ProjectRoomStore.backupTo` uses SQLite's online backup API.

In a shot's **Look** panel, write a direction or generate a video brief, then **Create Muse link**. The existing video package is published as a fixed snapshot with numbered stills, additional style/continuity references, a brief, a JSON manifest and the previs animation when WebM encoding is available. Copy the instruction into an official Muse conversation. No Muse account credentials or private Muse endpoints are used. Downloaded output can be added using **Import finished video**, then viewed in **Project results**. Original projects and conversations are excluded from public packets.

Local links cannot be opened by Muse's cloud browser. Validate external access and reference-image ingestion after deploying to public HTTPS. A withdrawal makes the page, raw media, manifest and ZIP unavailable; it cannot erase copies already downloaded by recipients.

Verification: `npx tsx --test server/handoffs/workflow.test.ts server/projects/rooms.test.ts src/project/storage.test.ts` checks actual HTTP publication, private-workspace access, project/output restart recovery, fresh-client listing, fixed public snapshots, raw image/ZIP retrieval, retries, corrupt packages and withdrawal. It makes no paid model calls.
