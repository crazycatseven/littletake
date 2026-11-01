import { z } from 'zod';
import { AIError } from '../../ai/provider.ts';
import { LocalDepthService } from './depth.ts';

/** Same-origin local API. The service owns Python lifecycle and cancellation. */
export function createDepthHandler(service: Pick<LocalDepthService, 'start' | 'status' | 'estimate'>) {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method === 'GET') { await service.start(); return json(service.status()); }
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
      if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) throw new AIError('wrong_origin', 'Open LittleTake directly to estimate depth.', 403);
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AIError('invalid_input', 'Send a JSON reference frame.', 415);
      const reader = request.body?.getReader(); if (!reader) throw new AIError('invalid_input', 'A reference frame is required.', 400);
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > 1_600_000) { await reader.cancel(); throw new AIError('too_large', 'The depth request exceeds 1.6 MB.', 413); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AIError('invalid_input', 'The depth request is not valid JSON.', 400); }
      return json(await service.estimate(body as Parameters<LocalDepthService['estimate']>[0], request.signal));
    } catch (error) {
      if (error instanceof z.ZodError) return json({ error: { code: 'invalid_input', message: 'Send a sourceId, saved reference frame and optional normalized regions.' } }, 400);
      if (error instanceof AIError) return json({ error: { code: error.code, message: error.message } }, error.status);
      return json({ error: { code: 'depth_failed', message: 'Local depth could not finish. Saved measurements remain available.' } }, 500);
    }
  };
}
