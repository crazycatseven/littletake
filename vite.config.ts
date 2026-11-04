import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { createApplication } from './server/app/application.ts';

export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') };
  return { server: { allowedHosts: env.LITTLETAKE_ALLOWED_HOSTS?.split(',').map(host => host.trim()).filter(Boolean) }, build: { rolldownOptions: { input: { studio: path.resolve('index.html'), referenceRunner: path.resolve('src/reference/runner/index.html') } } }, plugins: [{
    name: 'littletake-api',
    async configureServer(server) {
      const app = await createApplication(env, true);
      console.log(`Local VGGT API: ${app.depth.available ? 'ready (on-demand; no model loaded)' : app.depth.status().detail}`);
      server.httpServer?.once('close', () => { void app.close(); });
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname;
        if (!pathname.startsWith('/api/') && !pathname.startsWith('/s/')) { next(); return; }
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
          const request = new Request(`${protocol}://${req.headers.host || 'localhost:4176'}${req.url}`, {
            method: req.method, headers, signal: controller.signal,
            ...(!['GET', 'HEAD'].includes(req.method || 'GET') ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
          });
          const response = await app.fetch(request);
          if (!response) { res.statusCode = 404; res.end(); return; }
          res.statusCode = response.status; response.headers.forEach((value, key) => res.setHeader(key, value));
          if (response.body) { res.flushHeaders(); await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res); } else res.end();
        } catch { if (!res.headersSent) res.statusCode = 500; if (!res.destroyed) res.end(JSON.stringify({ error: { message: 'The project service could not finish this request.' } })); }
      });
    },
  }] };
});
