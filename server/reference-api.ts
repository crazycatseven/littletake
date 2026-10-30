import { MAX_REFERENCE_BODY_BYTES, type ReferenceDraft, type VideoReferenceInput } from '../src/reference/types.ts';
import { aiConnection, createAIProvider, type AIEnvironment } from './ai/index.ts';
import { AIError, type AIProvider } from './ai/provider.ts';
import { analyzeReference, parseReferenceInput } from './reference/analyze.ts';
import { groundReferenceDraft } from './reference/ground.ts';
import { trackConcept, type SamTracks } from './reference/sam.ts';

export type PeopleTracker = (input: VideoReferenceInput, signal: AbortSignal) => Promise<SamTracks>;
/** SAM 3.1 person tracking runs alongside Muse analysis of a video on the same key; SAM_TRACKING=off disables it. */
export function samTracker(env: AIEnvironment, transport: typeof fetch = fetch): PeopleTracker | null {
  const key = env.MODEL_API_KEY?.trim();
  return key && (env.AI_PROVIDER || 'meta') === 'meta' && env.SAM_TRACKING !== 'off' ? (input, signal) => trackConcept('person', input.video.dataUrl, key, transport, signal) : null;
}

function grounded(draft: ReferenceDraft, input: VideoReferenceInput, result: SamTracks | Error): ReferenceDraft {
  try { return groundReferenceDraft(draft, input, result); }
  catch { return { ...draft, assumptions: [...draft.assumptions, 'SAM 3.1 tracking could not be applied, so placement and timing are Muse estimates.'] }; }
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

async function readJSON(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AIError('invalid_input', 'Send a JSON reference request.', 415);
  if (Number(request.headers.get('content-length')) > MAX_REFERENCE_BODY_BYTES) throw new AIError('video_too_large', 'This first version accepts clips up to 3 MB.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AIError('invalid_input', 'Choose a reference clip or image first.', 400);
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

export function createReferenceHandler(env: AIEnvironment = process.env, providerFactory = (): AIProvider => createAIProvider(env), trackerFactory = (): PeopleTracker | null => samTracker(env)) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'GET') return json(aiConnection(env));
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    try {
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) throw new AIError('wrong_origin', 'Open LittleTake directly to analyze a clip.', 403);
      const input = parseReferenceInput(await readJSON(request));
      const provider = providerFactory(), tracker = trackerFactory(), controller = new AbortController();
      const stop = () => controller.abort();
      request.signal.addEventListener('abort', stop);
      // Tracks need motion over time; a still image is staged by Muse alone.
      const tracking = 'video' in input ? tracker?.(input, controller.signal).catch((error: unknown) => error instanceof Error ? error : new Error('SAM 3.1 tracking failed.')) : undefined;
      try {
        const draft = await analyzeReference(input, provider, request.signal);
        return json(tracking && 'video' in input ? grounded(draft, input, await tracking) : draft);
      } finally { stop(); request.signal.removeEventListener('abort', stop); }
    } catch (error) {
      if (error instanceof AIError) return json({ error: { code: error.code, message: error.message } }, error.status);
      return json({ error: { code: 'analysis_failed', message: 'The clip could not be analyzed. Your current scene is unchanged.' } }, 500);
    }
  };
}
