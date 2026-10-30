import { createAIProvider, aiConnection, type AIEnvironment } from './ai/index.ts';
import { AIError, type AIProvider } from './ai/provider.ts';
import { parseSceneEditInput, proposeSceneEdit } from './scene-edit.ts';
import { newDiagnostic } from '../src/scene-edit/diagnostics.ts';
import { AssetLibrary } from './assets/library.ts';
import { ReferenceTools } from './reference/sam/tools.ts';

const MAX_BODY = 4_100_000;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
export function createSceneEditHandler(env: AIEnvironment = process.env, providerFactory = (): AIProvider => createAIProvider(env)) {
  const library = new AssetLibrary(env.LITTLETAKE_ASSET_DIR);
  return async (request: Request): Promise<Response> => {
    if (request.method === 'GET') return json(aiConnection(env));
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    const diagnostic = newDiagnostic();
    let references: ReferenceTools | undefined;
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
      diagnostic.input = body;
      const input = parseSceneEditInput(body); references = new ReferenceTools(input.reference, env);
      const result = await proposeSceneEdit(input, providerFactory(), request.signal, diagnostic, library, references);
      return json({ ...result, diagnostic });
    } catch (error) {
      const detail = error instanceof AIError ? { code: error.code, message: error.message }
        : { code: 'edit_failed', message: 'The edit could not finish. Your scene is unchanged.' };
      diagnostic.outcome = 'failed'; diagnostic.error = detail;
      return json({ error: detail, diagnostic, ...(references?.available ? { reference: references.progress() } : {}) }, error instanceof AIError ? error.status : 500);
    }
  };
}
