import { AIError } from '../ai/provider.ts';

/** One tracked box in source pixels, half-open right/bottom like Meta's parser. */
export interface SamBox { frame: number; left: number; top: number; right: number; bottom: number }
export type SamTracks = Map<string, SamBox[]>;

/**
 * Reads boxes from SAM 3.1's output lane: one line per frame,
 * `<Nf>id<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|><|mask;…|>,id<|box;…|><|mask;…|>`.
 * Mask payloads never contain `,` or `|`, so records split cleanly. Masks are not needed here.
 */
export function parseSamBoxes(text: string): SamTracks {
  const tracks: SamTracks = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim(), header = /^<(\d+)f>/.exec(line);
    if (!header) continue;
    const frame = Number(header[1]);
    for (const record of line.slice(header[0].length).matchAll(/(?:^|,)(\d+)<\|box;([^|]*)\|>/g)) {
      const fields = new Map(record[2].split(';').map(field => field.split('=').map(part => part.trim())).filter(pair => pair.length === 2) as [string, string][]);
      const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(key => Number(fields.get(key) ?? NaN));
      if (![x1, y1, x2, y2].every(Number.isFinite) || x2 < x1 || y2 < y1) continue;
      const list = tracks.get(record[1]) ?? [];
      list.push({ frame, left: x1, top: y1, right: x2 + 1, bottom: y2 + 1 });
      tracks.set(record[1], list);
    }
  }
  // Video lines may arrive forward then backward; keep one box per frame in frame order.
  for (const [id, boxes] of tracks) tracks.set(id, [...new Map(boxes.map(box => [box.frame, box])).values()].sort((a, b) => a.frame - b.frame));
  return tracks;
}

/** Collects the output text from a streamed (SSE) or plain JSON Responses reply. */
async function outputText(response: Response): Promise<string> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = await response.json() as { output_text?: string; output?: { content?: { type?: string; text?: string }[] }[] };
    return data.output_text ?? data.output?.flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text ?? '').join('') ?? '';
  }
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = '', deltas = '', final: string | null = null;
  const handle = (block: string) => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event: { type?: string; delta?: string; text?: string };
    try { event = JSON.parse(data); } catch { return; }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') deltas += event.delta;
    else if (event.type === 'response.output_text.done' && typeof event.text === 'string') final = event.text;
    else if (event.type === 'response.failed' || event.type === 'error') throw new AIError('provider_error', 'SAM 3.1 could not track this clip.');
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      let split: number;
      while ((split = buffer.indexOf('\n\n')) >= 0) { handle(buffer.slice(0, split)); buffer = buffer.slice(split + 2); }
      if (done) { if (buffer.trim()) handle(buffer); break; }
    }
  } finally { reader.releaseLock(); }
  return final ?? deltas;
}

/** SAM 3.1 tracks every match of a short noun phrase through the clip and keeps object ids stable across frames. */
export async function trackConcept(prompt: string, videoDataUrl: string, apiKey: string, transport: typeof fetch = fetch, signal?: AbortSignal): Promise<SamTracks> {
  let response: Response;
  try {
    response = await transport('https://api.meta.ai/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      signal: AbortSignal.any([AbortSignal.timeout(150_000), ...(signal ? [signal] : [])]),
      body: JSON.stringify({ model: 'sam-3.1', stream: true, input: [{ type: 'message', role: 'user', content: [
        { type: 'input_text', text: prompt }, { type: 'input_video', video_url: videoDataUrl },
      ] }] }),
    });
  } catch {
    if (signal?.aborted) throw new AIError('cancelled', 'Request cancelled.', 499);
    throw new AIError('provider_unavailable', 'SAM 3.1 could not track this clip.', 504);
  }
  // Never echo an upstream error body: it can contain request data or credentials.
  if (response.status === 402) throw new AIError('credits_required', 'SAM 3.1 needs API credits before it can track clips.', 503);
  if (response.status === 401 || response.status === 403) throw new AIError('provider_auth', 'SAM 3.1 is not authorized on this server.', 503);
  if (!response.ok) throw new AIError('provider_error', 'SAM 3.1 could not track this clip.');
  try { return parseSamBoxes(await outputText(response)); }
  catch (error) { if (error instanceof AIError) throw error; throw new AIError('invalid_response', 'SAM 3.1 returned an unreadable response.'); }
}
