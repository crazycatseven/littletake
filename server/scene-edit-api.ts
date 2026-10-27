import { createAIProvider, aiConnection, type AIEnvironment } from './ai/index.ts';
import { AIError, type AIProvider } from './ai/provider.ts';
import { parseSceneEditInput, proposeSceneEdit } from './scene-edit.ts';

const MAX_BODY = 4_100_000;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
export function createSceneEditHandler(env: AIEnvironment = process.env, providerFactory = (): AIProvider => createAIProvider(env)) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'GET') return json(aiConnection(env));
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    try {
      if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) throw new AIError('wrong_origin', 'Open LittleTake directly to edit this scene.', 403);
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AIError('invalid_input', 'Send a JSON scene request.', 415);
      if (Number(request.headers.get('content-length')) > MAX_BODY) throw new AIError('too_large', 'The scene request is too large.', 413);
      const reader = request.body?.getReader(); if (!reader) throw new AIError('invalid_input', 'Enter a scene instruction.', 400);
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          length += value.byteLength; if (length > MAX_BODY) { await reader.cancel(); throw new AIError('too_large', 'The scene request is too large.', 413); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AIError('invalid_input', 'The scene request could not be read.', 400); }
      return json(await proposeSceneEdit(parseSceneEditInput(body), providerFactory(), request.signal));
    } catch (error) {
      if (error instanceof AIError) return json({ error: { code: error.code, message: error.message } }, error.status);
      return json({ error: { code: 'edit_failed', message: 'The edit could not finish. Your scene is unchanged.' } }, 500);
    }
  };
}
