import { newId } from "../id.ts";
import { projectFetch, projectDiagnosticId } from '../project/client';
import { editPlanSchema } from './operations';
import type { SceneEditInput, SceneEditResponse } from './types';
import { saveDiagnostic, type DiagnosticIdentity, type RequestDiagnostic } from './diagnostic-store';
import { referenceContextSchema } from '../reference/observations';
import { performanceRequestSchema } from '../performance/refinement';
import { readSceneEditResponse, type ProgressListener } from './progress';

export async function requestSceneEdit(input: SceneEditInput, signal: AbortSignal, identity?: DiagnosticIdentity, onProgress?: ProgressListener): Promise<SceneEditResponse> {
  const id = newId();
  const record: RequestDiagnostic = { id, turnId: id, conversationId: '', messageId: '', ...identity,
    startedAt: new Date().toISOString(), input: structuredClone(input), status: 'pending' };
  record.conversationId = projectDiagnosticId(record.conversationId);
  // Persist the exact input before starting a paid request. A reload leaves an identifiable interrupted request.
  await saveDiagnostic(record);
  try {
    const response = await projectFetch('/api/scene-edit', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(input), signal });
    const data = await readSceneEditResponse(response, event => {
      record.server ??= { format: 'LittleTake.scene-edit-diagnostic', version: 1, id, startedAt: record.startedAt, attempts: [] };
      (record.server.progress ??= []).push(event); onProgress?.(event);
    }) as any;
    if (data.diagnostic) record.server = data.diagnostic;
    if (data.reference) {
      if (!input.reference || data.reference.sourceId !== input.reference.source.id || data.reference.callsUsed < input.reference.callsUsed || (input.reference.framesRequested && !data.reference.framesRequested)) throw new Error('Reference progress differs from this conversation turn.');
      referenceContextSchema.parse({ source: input.reference.source, observations: data.reference.observations, callsUsed: data.reference.callsUsed, framesRequested: data.reference.framesRequested });
    }
    if (!response.ok || data.error) throw new Error(typeof data.error?.message === 'string' ? data.error.message.slice(0, 300) : 'Muse could not finish this edit.', { cause: data.reference ? { referenceProgress: data.reference } : undefined });
    if (typeof data.provider !== 'string' || typeof data.model !== 'string') throw new Error('The edit response was incomplete.');
    let result: SceneEditResponse;
    if (data.status === 'needs_reference_frames' && input.reference?.source.kind === 'video' && data.reference && Array.isArray(data.requestedTimes) && data.requestedTimes.length > 0 && data.requestedTimes.length <= 2 && new Set(data.requestedTimes).size === data.requestedTimes.length && data.requestedTimes.every((time: unknown) => typeof time === 'number' && Number.isFinite(time) && time >= 0 && time < input.reference!.source.duration) && typeof data.summary === 'string') result = data;
    else if (data.status === 'needs_views' && Array.isArray(data.requestedViews) && data.requestedViews.length > 0 && data.requestedViews.length <= 2 && new Set(data.requestedViews).size === data.requestedViews.length && data.requestedViews.every((v: unknown) => v === 'top_down' || v === 'shot') && typeof data.summary === 'string') result = data;
    else if (data.status === 'ready') result = { ...data, plan: editPlanSchema.parse(data.plan) };
    else if (data.status === 'needs_motion_review' && input.performance && !input.performance.candidate) {
      const parsed = performanceRequestSchema.parse({ targets: input.performance.targets, candidate: data.candidate });
      if (!parsed.candidate) throw new Error('Muse returned an incomplete recording proposal.');
      result = { status: 'needs_motion_review', candidate: parsed.candidate, provider: data.provider, model: data.model };
    }
    else throw new Error('Muse returned an unsupported edit response.');
    record.status = result.status; record.finishedAt = new Date().toISOString(); await saveDiagnostic(record);
    return result;
  } catch (error) {
    if (error instanceof Error && error.cause && typeof error.cause === 'object' && 'unreadableResponse' in error.cause) record.unreadableResponse = String(error.cause.unreadableResponse);
    record.status = signal.aborted ? 'cancelled' : 'failed'; record.finishedAt = new Date().toISOString();
    record.error = error instanceof Error ? error.message : 'Request failed.';
    await saveDiagnostic(record); throw error;
  }
}
