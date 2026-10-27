import { editPlanSchema } from './operations';
import type { SceneEditInput, SceneEditResponse } from './types';
import { saveDiagnostic, type DiagnosticIdentity, type RequestDiagnostic } from './diagnostic-store';

export async function requestSceneEdit(input: SceneEditInput, signal: AbortSignal, identity?: DiagnosticIdentity): Promise<SceneEditResponse> {
  const id = crypto.randomUUID();
  const record: RequestDiagnostic = { id, turnId: id, conversationId: '', messageId: '', ...identity,
    startedAt: new Date().toISOString(), input: structuredClone(input), status: 'pending' };
  // Persist the exact input before starting a paid request. A reload leaves an identifiable interrupted request.
  await saveDiagnostic(record);
  try {
    const response = await fetch('/api/scene-edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { record.unreadableResponse = text; throw new Error('The edit server did not return a response. Try again.'); }
    if (data.diagnostic) record.server = data.diagnostic;
    if (!response.ok) throw new Error(typeof data.error?.message === 'string' ? data.error.message.slice(0, 300) : 'Muse could not finish this edit.');
    if (typeof data.provider !== 'string' || typeof data.model !== 'string') throw new Error('The edit response was incomplete.');
    let result: SceneEditResponse;
    if (data.status === 'needs_views' && Array.isArray(data.requestedViews) && data.requestedViews.length > 0 && data.requestedViews.length <= 2 && new Set(data.requestedViews).size === data.requestedViews.length && data.requestedViews.every((v: unknown) => v === 'top_down' || v === 'shot') && typeof data.summary === 'string') result = data;
    else if (data.status === 'ready') result = { ...data, plan: editPlanSchema.parse(data.plan) };
    else throw new Error('Muse returned an unsupported edit response.');
    record.status = result.status; record.finishedAt = new Date().toISOString(); await saveDiagnostic(record);
    return result;
  } catch (error) {
    record.status = signal.aborted ? 'cancelled' : 'failed'; record.finishedAt = new Date().toISOString();
    record.error = error instanceof Error ? error.message : 'Request failed.';
    await saveDiagnostic(record); throw error;
  }
}
