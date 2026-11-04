import { z } from 'zod';
import { newId } from '../id.ts';

/** Public execution records only; provider reasoning and raw tool arguments never enter this stream. */
export const agentProgressSchema = z.strictObject({
  id: z.string().min(1).max(80), at: z.iso.datetime(),
  status: z.enum(['running', 'done', 'error']), message: z.string().trim().min(1).max(300),
  sources: z.array(z.strictObject({title:z.string().max(200),url:z.url().regex(/^https?:\/\//i)})).max(6).optional(),
  imageOutputId: z.uuid().optional(),
});
export type AgentProgress = z.infer<typeof agentProgressSchema>;
export type ProgressListener = (event: AgentProgress) => void;
export const progressHistorySchema = z.array(agentProgressSchema);
export function newProgress(message: string, status: AgentProgress['status'] = 'running'): AgentProgress {
  return { id: newId(), at: new Date().toISOString(), status, message: message.slice(0, 300) };
}

/** The same endpoint also serves ordinary JSON to older clients. */
export async function readSceneEditResponse(response: Response, onProgress?: ProgressListener): Promise<unknown> {
  if (!response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
    const text = await response.text();
    try { return JSON.parse(text); }
    catch { throw new Error('The edit server did not return readable JSON. Try again.', { cause: { unreadableResponse: text } }); }
  }
  if (!response.body) throw new Error('Muse did not return a response.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', result: unknown, complete = false;
  const line = (text: string) => {
    if (!text.trim()) return;
    if (complete) throw new Error('Muse sent data after finishing the response.');
    const value = JSON.parse(text);
    if (value.type === 'progress') onProgress?.(agentProgressSchema.parse(value.event));
    else if (value.type === 'result' && value.data && typeof value.data === 'object') { result = value.data; complete = true; }
    else throw new Error('Muse returned an unsupported progress response.');
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (chunk.done) break;
    }
    if (buffer.trim()) line(buffer);
    if (!complete) throw new Error('Muse disconnected before finishing. Your work history is retained; no changes were applied.');
    return result;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
