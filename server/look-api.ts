import { aiConnection, createAIProvider, type AIEnvironment } from './ai/index.ts';
import { AIError, type AIProvider } from './ai/provider.ts';
import { parseBriefInput, writeVideoBrief } from './look/brief.ts';
import { generateLookFrame, LOOK_LIMITS, parseLookInput } from './look/generate.ts';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export const lookConnection = (env: AIEnvironment) => ({
  available: (env.AI_PROVIDER || 'meta') === 'meta' && Boolean(env.MODEL_API_KEY?.trim()),
  provider: 'Meta', model: env.MUSE_IMAGE_MODEL || 'muse-image-1.0',
});

async function readJSON(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AIError('invalid_input', 'Send a JSON look-frame request.', 415);
  const tooLarge = () => new AIError('request_too_large', 'This request is too large. Use smaller reference images.', 413);
  if (Number(request.headers.get('content-length')) > LOOK_LIMITS.maxBodyBytes) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new AIError('invalid_input', 'Send a previs frame first.', 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > LOOK_LIMITS.maxBodyBytes) { await reader.cancel(); throw tooLarge(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError('invalid_input', 'The look-frame request could not be read.', 400);
  } finally { reader.releaseLock(); }
}

export function createLookHandler(env: AIEnvironment = process.env, transport: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    const connection = lookConnection(env);
    if (request.method === 'GET') return json(connection);
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    try {
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) throw new AIError('wrong_origin', 'Open LittleTake directly to render look frames.', 403);
      const input = parseLookInput(await readJSON(request));
      if (!connection.available) throw new AIError('not_configured', 'Muse Image is not configured on this server. Previs export still works.', 503);
      return json(await generateLookFrame(input, { apiKey: env.MODEL_API_KEY!.trim(), model: connection.model }, transport, request.signal));
    } catch (error) {
      if (error instanceof AIError) return json({ error: { code: error.code, message: error.message } }, error.status);
      return json({ error: { code: 'look_failed', message: 'The look frame could not be rendered. Your scene is unchanged.' } }, 500);
    }
  };
}

/** Muse Spark turns a shot's frames, blocking and camera into a brief any video model can use. */
export function createBriefHandler(env: AIEnvironment = process.env, providerFactory = (): AIProvider => createAIProvider(env)) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'GET') return json(aiConnection(env));
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    try {
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) throw new AIError('wrong_origin', 'Open LittleTake directly to write a video brief.', 403);
      const input = parseBriefInput(await readJSON(request));
      return json(await writeVideoBrief(input, providerFactory(), request.signal));
    } catch (error) {
      if (error instanceof AIError) return json({ error: { code: error.code, message: error.message } }, error.status);
      return json({ error: { code: 'brief_failed', message: 'The video brief could not be written. Your scene is unchanged.' } }, 500);
    }
  };
}
