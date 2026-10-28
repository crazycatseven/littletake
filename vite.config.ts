import { Readable } from 'node:stream';
import { defineConfig, loadEnv } from 'vite';
import { createReferenceHandler } from './server/reference-api.ts';
import { createSceneEditHandler } from './server/scene-edit-api.ts';
import { createAssetsHandler } from './server/assets/api.ts';
import { AssetLibrary } from './server/assets/library.ts';
import { createAIProvider } from './server/ai/index.ts';
import { createBriefHandler, createLookHandler } from './server/look-api.ts';

export default defineConfig(({ mode }) => {
  // No VITE_ prefix: model credentials stay on the server, including in development.
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') };
  const handlers = { '/api/reference': createReferenceHandler(env), '/api/scene-edit': createSceneEditHandler(env), '/api/assets': createAssetsHandler(new AssetLibrary(env.LITTLETAKE_ASSET_DIR), () => createAIProvider(env)), '/api/look': createLookHandler(env), '/api/brief': createBriefHandler(env) };
  return { plugins: [{
    name: 'littletake-reference-api',
    configureServer(server) {
      for (const [path, handler] of Object.entries(handlers)) server.middlewares.use(path, async (req, res) => {
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          const request = new Request(`http://${req.headers.host || 'localhost:4176'}${path}${req.url && req.url !== '/' ? req.url : ''}`, {
            method: req.method, headers, signal: controller.signal,
            ...(req.method === 'POST' ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
          });
          const response = await handler(request);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch { if (!res.headersSent) res.statusCode = 500; res.end('{"error":{"message":"The local analysis server could not finish this request."}}'); }
      });
    },
  }] };
});
