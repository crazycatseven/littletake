import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from './application.ts';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json' };
export async function startApplication(options: { env?: Record<string, string | undefined>; host?: string; port?: number; dist?: string } = {}) {
  const env = { ...process.env, ...options.env }, host = options.host ?? env.LITTLETAKE_HOST ?? '127.0.0.1';
  const password = env.LITTLETAKE_WORKSPACE_PASSWORD, publicOrigin = env.LITTLETAKE_PUBLIC_URL;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !password) throw new Error('Set LITTLETAKE_WORKSPACE_PASSWORD before exposing the shared workspace. Public reference links remain read-only.');
  if (publicOrigin && !/^https?:\/\//.test(publicOrigin)) throw new Error('LITTLETAKE_PUBLIC_URL must be an HTTP or HTTPS origin.');
  const app = await createApplication(env, env.LITTLETAKE_LOCAL_DEPTH === '1'), dist = path.resolve(options.dist ?? 'dist');
  const server = createServer(async (req, res) => {
    const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const parsed = new URL(req.url ?? '/', 'http://localhost'), pathname = parsed.pathname;
      if (pathname === '/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return; }
      if (!pathname.startsWith('/s/') && password) {
        const expected = Buffer.from('Basic ' + Buffer.from('littletake:' + password).toString('base64')), supplied = Buffer.from(req.headers.authorization ?? '');
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) { res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Basic realm="LittleTake workspace", charset="UTF-8"'); res.end('Workspace access required.'); return; }
      }
      const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const origin = publicOrigin || `http://${req.headers.host}`;
      const request = new Request(new URL(parsed.pathname + parsed.search, origin), { method: req.method, headers, signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(req.method ?? 'GET') ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
      });
      let response = await app.fetch(request);
      if (!response) {
        if (!['GET', 'HEAD'].includes(req.method ?? 'GET') || pathname.startsWith('/api/')) response = new Response('Not found.', { status: 404 });
        else {
          const target = path.resolve(dist, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
          if (!target.startsWith(dist + path.sep)) response = new Response('Not found.', { status: 404 });
          else { const bytes = await readFile(target); response = new Response(req.method === 'HEAD' ? null : bytes, { headers: { 'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' } }); }
        }
      }
      res.statusCode = response.status; response.headers.forEach((value, key) => res.setHeader(key, value)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { if (!res.headersSent) { res.statusCode = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500; res.setHeader('Content-Type', 'application/json'); } res.end(JSON.stringify({ error: { message: 'The server could not finish this request.' } })); }
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? Number(env.PORT ?? 4176), host, resolve); }); }
  catch (error) { await app.close(); throw error; }
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server address.');
  return { origin: `http://127.0.0.1:${address.port}`, projects: app.projects, async close() { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }); await app.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.loadEnvFile('.env.local'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const service = await startApplication(); console.log('LittleTake application: ' + (process.env.LITTLETAKE_PUBLIC_URL || service.origin));
  let closing = false; for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (!closing) { closing = true; void service.close().then(() => process.exit(0)); } });
}
