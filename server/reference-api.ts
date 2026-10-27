import { MAX_REFERENCE_BODY_BYTES } from '../src/reference/types.ts';
import { aiConnection, createAIProvider, type AIEnvironment } from './ai/index.ts';
import { AIError, type AIProvider } from './ai/provider.ts';
import { analyzeReference, parseReferenceInput } from './reference/analyze.ts';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

async function readJSON(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AIError('invalid_input', 'Send a JSON video request.', 415);
  if (Number(request.headers.get('content-length')) > MAX_REFERENCE_BODY_BYTES) throw new AIError('video_too_large', 'This first version accepts clips up to 3 MB.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AIError('invalid_input', 'Choose a reference clip first.', 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_REFERENCE_BODY_BYTES) { await reader.cancel(); throw new AIError('video_too_large', 'This first version accepts clips up to 3 MB.', 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError('invalid_input', 'The reference request could not be read.', 400);
  } finally { reader.releaseLock(); }
}

export function createReferenceHandler(env: AIEnvironment = process.env, providerFactory = (): AIProvider => createAIProvider(env)) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'GET') return json(aiConnection(env));
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    try {
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) throw new AIError('wrong_origin', 'Open LittleTake directly to analyze a clip.', 403);
      const input = parseReferenceInput(await readJSON(request));
      const draft = await analyzeReference(input, providerFactory(), request.signal);
      return json(draft);
    } catch (error) {
      if (error instanceof AIError) return json({ error: { code: error.code, message: error.message } }, error.status);
      return json({ error: { code: 'analysis_failed', message: 'The clip could not be analyzed. Your current scene is unchanged.' } }, 500);
    }
  };
}
