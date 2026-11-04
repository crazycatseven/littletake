import path from 'node:path';
import { createReferenceHandler } from '../reference-api.ts';
import { createSceneEditHandler } from '../scene-edit-api.ts';
import { createAssetsHandler } from '../assets/api.ts';
import { AssetLibrary } from '../assets/library.ts';
import { createAIProvider } from '../ai/index.ts';
import { createBriefHandler, createLookHandler } from '../look-api.ts';
import { createSpatialHandler } from '../spatial/api.ts';
import { createSegmentationHandler } from '../reference/sam/api.ts';
import { LocalDepthService } from '../reference/geometry/depth.ts';
import { createDepthHandler } from '../reference/geometry/api.ts';
import { ProjectRoomStore, ProjectRoomError } from '../projects/store.ts';
import { AIError } from '../ai/provider.ts';
import { createProjectRoomsHandler } from '../projects/api.ts';
import { createReferenceJobsProxy } from '../reference/jobs/proxy.ts';
import { createHandoffsHandler } from '../handoffs/api.ts';
import { createCloudProjectsHandler } from '../projects/cloud.ts';

/** Development and the persistent production service use the same handlers and stores. */
export async function createApplication(input: Record<string, string | undefined>, startDepth = false) {
  const directory = input.LITTLETAKE_DATA_DIR || path.resolve('.littletake');
  const env: Record<string, string | undefined> = { ...input, LITTLETAKE_DATA_DIR: directory, LITTLETAKE_ASSET_DIR: input.LITTLETAKE_ASSET_DIR || path.join(directory, 'assets') };
  const depth = new LocalDepthService(env), projects = new ProjectRoomStore(directory);
  try { if (startDepth) await depth.start(); } catch (error) { projects.close(); await depth.close(); throw error; }
  const handoffs = createHandoffsHandler(projects);
  const mode = env.LITTLETAKE_MODE ?? (env.LITTLETAKE_PUBLIC_URL ? 'cloud' : 'local');
  if (mode !== 'local' && mode !== 'cloud') { projects.close(); await depth.close(); throw new Error('LITTLETAKE_MODE must be local or cloud.'); }
  const workspace = { mode, cloudAvailable: mode === 'local' && Boolean(env.LITTLETAKE_CLOUD_URL) } as const;
  const handlers: Record<string, (request: Request) => Promise<Response>> = {
    '/api/reference': createReferenceHandler(env, undefined, request => {
      request.signal.throwIfAborted();
      try { projects.consumeCall(request.headers.get('x-littletake-project')!, request.headers.get('x-littletake-edit-lease')!, request.headers.get('x-littletake-run-id') ?? crypto.randomUUID(), 72, request.headers.get('x-littletake-edit-page') ?? undefined); }
      catch (error) { if (error instanceof ProjectRoomError) throw new AIError(error.code, error.message, error.status); throw error; }
    }),
    '/api/scene-edit': createSceneEditHandler(env, undefined, depth,request=>({save:async design=>{
      const code=request.headers.get('x-littletake-project')!,lease=request.headers.get('x-littletake-edit-lease')!,page=request.headers.get('x-littletake-edit-page')??undefined;
      if(design.concept){const [prefix,base64]=design.concept.image.split(',',2),mime=prefix.slice(5,prefix.indexOf(';')) as 'image/png'|'image/jpeg'|'image/webp';
        const previous=projects.get(code).outputs.find(output=>output.id===design.concept!.id);
        projects.saveOutput(code,lease,{id:design.concept.id,kind:'scene-design',sceneId:design.sceneId,shotId:'',name:'Scene concept · '+design.sceneId,mime},Buffer.from(base64,'base64'),page,previous?.updatedAt??0);}
      const previous=projects.get(code).outputs.find(output=>output.id===design.id);
      projects.saveOutput(code,lease,{id:design.id,kind:'scene-design',sceneId:design.sceneId,shotId:'',name:'Scene design · '+design.sceneId,mime:'application/json'},Buffer.from(JSON.stringify(design)),page,previous?.updatedAt??0);
      return {imageOutputId:design.concept?.id};
    },load:async(sceneId,intent)=>{
      const code=request.headers.get('x-littletake-project')!,room=projects.get(code);
      for(const output of room.outputs.filter(item=>item.kind==='scene-design'&&item.mime==='application/json').sort((a,b)=>b.updatedAt-a.updatedAt)){
        const design=JSON.parse(Buffer.from(projects.readOutput(code,output.id).data).toString('utf8'));
        if(design.status==='ready'&&design.originalRequest===intent&&(design.sceneId===sceneId||!room.project.scenes.some(scene=>scene.id===design.sceneId)))return {...design,sceneId};
      }
    }})),
    '/api/spatial': createSpatialHandler(), '/api/segmentation': createSegmentationHandler(env), '/api/depth': createDepthHandler(depth),
    '/api/assets': createAssetsHandler(new AssetLibrary(env.LITTLETAKE_ASSET_DIR), () => createAIProvider(env)),
    '/api/look': createLookHandler(env), '/api/brief': createBriefHandler(env),
    '/api/reference-jobs': createReferenceJobsProxy(env), '/api/projects': createProjectRoomsHandler(projects, workspace), '/api/handoffs': handoffs,
    '/api/cloud-projects': createCloudProjectsHandler(projects, workspace.mode === 'local' ? env : {}),
  };
  return {
    projects, depth,
    async fetch(request: Request): Promise<Response | null> {
      const pathname = new URL(request.url).pathname;
      const handler = pathname.startsWith('/s/') ? handoffs : handlers[pathname];
      if (!handler) return null;
      try {
        if (request.method === 'POST' && pathname.startsWith('/api/') && !['/api/projects', '/api/handoffs', '/api/cloud-projects'].includes(pathname)) {
          const code = request.headers.get('x-littletake-project'), lease = request.headers.get('x-littletake-edit-lease');
          if (!code || !lease || projects.get(code, lease, request.headers.get('x-littletake-edit-page') ?? undefined).editing !== 'you')
            return Response.json({ error: { code: 'read_only', message: 'Open a project before changing it or using AI.' } }, { status: 403 });
        }
        return await handler(request);
      } catch (error) {
        return Response.json({ error: { code: error instanceof ProjectRoomError ? error.code : 'service_unavailable', message: error instanceof ProjectRoomError ? error.message : 'The project service could not finish this request.' } }, { status: error instanceof ProjectRoomError ? error.status : 500 });
      }
    },
    async close() { await depth.close(); projects.close(); },
  };
}
