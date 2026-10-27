import { AIError, type AIProvider, type StructuredRequest } from './provider.ts';

interface MetaConfig { apiKey: string; model: string }

/** Muse's Responses API is the only place that knows Meta's wire format. */
export class MetaProvider implements AIProvider {
  readonly name = 'Meta';
  readonly model: string;
  constructor(private readonly config: MetaConfig, private readonly transport: typeof fetch = fetch) {
    this.model = config.model;
  }

  async generateObject(request: StructuredRequest): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport('https://api.meta.ai/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.any([AbortSignal.timeout(150_000), ...(request.signal ? [request.signal] : [])]),
        body: JSON.stringify({
          model: this.model, store: false, reasoning: { effort: 'low' }, max_output_tokens: 10_000,
          instructions: request.instructions,
          text: { format: { type: 'json_schema', name: request.schemaName, strict: true, schema: request.schema } },
          input: [{ type: 'message', role: 'user', content: request.content.map(part => part.type === 'text'
            ? { type: 'input_text', text: part.text }
            : { type: 'input_video', video_url: part.dataUrl }) }],
        }),
      });
    } catch {
      if (request.signal?.aborted) throw new AIError('cancelled', 'Analysis cancelled.', 499);
      throw new AIError('provider_unavailable', 'Muse could not finish the request. Please try again.', 504);
    }
    if (!response.ok) {
      // Never echo an upstream error body: it can contain request data or credentials.
      if (response.status === 402) throw new AIError('credits_required', 'Muse needs API credits before it can analyze this clip.', 503);
      if (response.status === 401 || response.status === 403) throw new AIError('provider_auth', 'Muse is not authorized on this server.', 503);
      if (response.status === 429) throw new AIError('rate_limited', 'Muse is busy. Please wait a moment and try again.', 429);
      throw new AIError('provider_error', 'Muse could not analyze this clip. Please try a shorter MP4 or WebM clip.');
    }
    let data: { status?: string; output_text?: string; output?: { content?: { type?: string; text?: string }[] }[] };
    try { data = await response.json(); } catch { throw new AIError('invalid_response', 'Muse returned an unreadable response. Please try again.'); }
    if (data.status && data.status !== 'completed') throw new AIError('incomplete_response', 'Muse did not finish the scene. Please try a shorter clip.');
    const text = data.output_text ?? data.output?.flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text ?? '').join('');
    try { if (!text) throw new Error(); return JSON.parse(text); }
    catch { throw new AIError('invalid_response', 'Muse did not return a complete scene. Please try again.'); }
  }
}
