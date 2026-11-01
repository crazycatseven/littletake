import { Readable } from 'node:stream';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { createReferenceHandler } from './server/reference-api.ts';
import { createSceneEditHandler } from './server/scene-edit-api.ts';
import { createAssetsHandler } from './server/assets/api.ts';
import { AssetLibrary } from './server/assets/library.ts';
import { createAIProvider } from './server/ai/index.ts';
import { createBriefHandler, createLookHandler } from './server/look-api.ts';
import { createSpatialHandler } from './server/spatial/api.ts';
import { createSegmentationHandler } from './server/reference/sam/api.ts';
import { LocalDepthService } from './server/reference/geometry/depth.ts';
import { createDepthHandler } from './server/reference/geometry/api.ts';
import { ProjectRoomStore, ProjectRoomError } from './server/projects/store.ts';
import { AIError } from './server/ai/provider.ts';
import { createProjectRoomsHandler } from './server/projects/api.ts';
import { createReferenceJobsProxy } from './server/reference/jobs/proxy.ts';

export default defineConfig(({ mode }) => {
  // No VITE_ prefix: model credentials stay on the server, including in development.
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') };
  env.LITTLETAKE_ASSET_DIR ||= path.join(env.LITTLETAKE_DATA_DIR || path.resolve('.littletake'), 'assets');
  const depth = new LocalDepthService(env);
  return { server: { allowedHosts: env.LITTLETAKE_ALLOWED_HOSTS?.split(',').map(host => host.trim()).filter(Boolean) }, build: { rolldownOptions: { input: { studio: path.resolve('index.html'), referenceRunner: path.resolve('src/reference/runner/index.html') } } }, plugins: [{
    name: 'littletake-api',
    async closeBundle() { await depth.close(); },
    async configureServer(server) {
      await depth.start();
      console.log(`Local VGGT API: ${depth.available ? 'ready (on-demand; no model loaded)' : depth.status().detail}`);
      const projects = new ProjectRoomStore(env.LITTLETAKE_DATA_DIR || path.resolve('.littletake'));
      server.httpServer?.once('close', () => projects.close());
      const handlers = {
        '/api/reference': createReferenceHandler(env, undefined, request => {
          request.signal.throwIfAborted();
          try { projects.consumeCall(request.headers.get('x-littletake-project')!, request.headers.get('x-littletake-edit-lease')!, request.headers.get('x-littletake-run-id') ?? crypto.randomUUID(), 72, request.headers.get('x-littletake-edit-page') ?? undefined); }
          catch (error) { if (error instanceof ProjectRoomError) throw new AIError(error.code, error.message, error.status); throw error; }
        }),
        '/api/scene-edit': createSceneEditHandler(env, undefined, depth),
        '/api/spatial': createSpatialHandler(), '/api/segmentation': createSegmentationHandler(env), '/api/depth': createDepthHandler(depth),
        '/api/assets': createAssetsHandler(new AssetLibrary(env.LITTLETAKE_ASSET_DIR), () => createAIProvider(env)),
        '/api/look': createLookHandler(env), '/api/brief': createBriefHandler(env),
        '/api/reference-jobs': createReferenceJobsProxy(env), '/api/projects': createProjectRoomsHandler(projects),
      };
      for (const [path, handler] of Object.entries(handlers)) server.middlewares.use(path, async (req, res) => {
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
          const request = new Request(`${protocol}://${req.headers.host || 'localhost:4176'}${path}${req.url && req.url !== '/' ? req.url : ''}`, {
            method: req.method, headers, signal: controller.signal,
            ...(req.method === 'POST' ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
          });
          if (request.method === 'POST' && path !== '/api/projects') {
            const code = request.headers.get('x-littletake-project'), lease = request.headers.get('x-littletake-edit-lease');
            if (!code || !lease || projects.get(code, lease, request.headers.get('x-littletake-edit-page') ?? undefined).editing !== 'you') {
              res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: { code: 'read_only', message: 'Open a project and start editing before changing it or using AI.' } })); return;
            }
          }
          const response = await handler(request);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) { if (!res.headersSent) { res.statusCode = error instanceof ProjectRoomError ? error.status : 500; res.setHeader('Content-Type', 'application/json'); } res.end(JSON.stringify({error:{message:error instanceof ProjectRoomError?error.message:'The local server could not finish this request.'}})); }
      });
    },
  }] };
});
