import { z } from 'zod';
import type { AIEnvironment } from '../../ai/index.ts';
import { AIError } from '../../ai/provider.ts';
import { MAX_SAM_BODY_BYTES, samConnection, segmentImage, type SamInput, type SamReceipt } from './service.ts';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

/** Cloud is the default. Local inference is an explicit server/request choice. */
export function createSegmentationHandler(env: AIEnvironment = process.env, transport: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let receipt: SamReceipt | undefined;
    try {
      if (request.method === 'GET') return json(await samConnection(env));
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) throw new AIError('wrong_origin', 'Open LittleTake directly to segment a reference.', 403);
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AIError('invalid_input', 'Send a JSON reference-frame request.', 415);
      reader = request.body?.getReader();
      if (!reader) throw new AIError('invalid_input', 'A reference frame is required.', 400);
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > MAX_SAM_BODY_BYTES) { await reader.cancel(); throw new AIError('image_too_large', 'The PNG reference request exceeds 4.1 MB.', 413); }
        chunks.push(value);
      }
      let input: SamInput;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new AIError('invalid_input', 'The reference request is not valid JSON.', 400); }
      const result = await segmentImage(input, env, { transport, signal: request.signal, onReceipt: value => { receipt = value; } });
      return json(result);
    } catch (error) {
      if (error instanceof z.ZodError) return json({ error: { code: 'invalid_input', message: 'Send a PNG imageDataUrl, a short prompt and an optional threshold from 0 to 1.' } }, 400);
      if (error instanceof AIError) return json({ error: { code: error.code, message: error.message }, receipt }, error.status);
      return json({ error: { code: 'segmentation_failed', message: 'The reference frame could not be segmented.' } }, 500);
    } finally { reader?.releaseLock(); }
  };
}
