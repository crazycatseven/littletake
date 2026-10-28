import { validateDocument } from '../model';
import type { ReferenceConnection, ReferenceDraft, ReferenceInput } from './types';
import { readTracks } from './tracks';

export async function referenceConnection(signal?: AbortSignal): Promise<ReferenceConnection> {
  const response = await fetch('/api/reference', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('The analysis server is unavailable. You can keep editing your scene.');
  const data = await response.json();
  if (typeof data.available !== 'boolean' || typeof data.provider !== 'string' || typeof data.model !== 'string') throw new Error('The analysis server is unavailable on this deployment.');
  return data;
}

export async function requestReferenceDraft(input: ReferenceInput, signal: AbortSignal): Promise<ReferenceDraft> {
  const response = await fetch('/api/reference', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
  let data;
  try { data = await response.json(); } catch { throw new Error('Analysis did not finish. Please try a shorter clip.'); }
  if (!response.ok) throw new Error(typeof data.error?.message === 'string' ? data.error.message.slice(0, 300) : 'The clip could not be analyzed. Please try again.');
  if (typeof data.summary !== 'string' || !Array.isArray(data.assumptions) || data.assumptions.some((item: unknown) => typeof item !== 'string') || typeof data.provider !== 'string' || typeof data.model !== 'string') throw new Error('The analysis response was incomplete. Please try again.');
  const tracks = readTracks(data.tracks);
  return { scene: validateDocument(data.scene), summary: data.summary, assumptions: data.assumptions, provider: data.provider, model: data.model, ...(tracks ? { tracks } : {}) };
}
