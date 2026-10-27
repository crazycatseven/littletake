import { Readable } from 'node:stream';
import { defineConfig, loadEnv } from 'vite';
import { createReferenceHandler } from './server/reference-api.ts';

export default defineConfig(({ mode }) => {
  // No VITE_ prefix: model credentials stay on the server, including in development.
  const handler = createReferenceHandler({ ...process.env, ...loadEnv(mode, process.cwd(), '') });
  return { plugins: [{
    name: 'littletake-reference-api',
    configureServer(server) {
      server.middlewares.use('/api/reference', async (req, res) => {
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          const request = new Request(`http://${req.headers.host || 'localhost:4176'}/api/reference`, {
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
