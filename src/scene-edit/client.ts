import { editPlanSchema } from './operations';
import type { SceneEditInput, SceneEditResponse } from './types';

export async function requestSceneEdit(input: SceneEditInput, signal: AbortSignal): Promise<SceneEditResponse> {
  const response = await fetch('/api/scene-edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
  let data; try { data = await response.json(); } catch { throw new Error('The edit server did not return a response. Try again.'); }
  if (!response.ok) throw new Error(typeof data.error?.message === 'string' ? data.error.message.slice(0, 300) : 'Muse could not finish this edit.');
  if (typeof data.provider !== 'string' || typeof data.model !== 'string') throw new Error('The edit response was incomplete.');
  if (data.status === 'needs_views' && Array.isArray(data.requestedViews) && data.requestedViews.length > 0 && data.requestedViews.length <= 2 && new Set(data.requestedViews).size === data.requestedViews.length && data.requestedViews.every((v: unknown) => v === 'top_down' || v === 'shot') && typeof data.summary === 'string') return data;
  if (data.status === 'ready') return { ...data, plan: editPlanSchema.parse(data.plan) };
  throw new Error('Muse returned an unsupported edit response.');
}
