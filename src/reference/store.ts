import { activeWorkspace } from '../project/client';
import type { ProjectRoom } from '../project/room';
import { referenceSourceSchema, referenceFrameSchema, referenceObservationSchema, type ReferenceContext, type ReferenceProgress, type ReferenceSource, type ReferenceObservation } from './observations';
import { prepareReferenceFrames } from './frames';

interface SavedReference { source: ReferenceSource; observations: ReferenceObservation[]; media?: File; extraFrames?: ReferenceSource['frames'] }
const scope = () => { const workspace = activeWorkspace(); return { workspace, room: workspace?.room ?? null }; };
const bindings = new Map<string, string>(), writes = new Map<string, Promise<void>>();
const key = (room: ProjectRoom | null, threadId: string) => (room?.id ?? '') + ':' + threadId;
async function persistReference(threadId: string, saved: SavedReference | null, target: ReturnType<typeof scope>) {
  if (!target.workspace || !target.room) throw new Error('Open a project before attaching a reference.');
  const media = saved?.media ? { name: saved.media.name, type: saved.media.type, dataUrl: await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(saved.media!); }) } : undefined;
  await target.workspace.putOutput({ id: threadId, kind: 'reference-media', sceneId: threadId, shotId: '', name: saved?.source.name ?? 'Detached reference', mime: 'application/json' }, new Blob([JSON.stringify(saved ? { ...saved, media } : null)], { type: 'application/json' }), target.room);
  if (saved) bindings.set(key(target.room, saved.source.id), threadId);
}
async function savedReference(threadId: string, target: ReturnType<typeof scope>): Promise<SavedReference | undefined> {
  const output = target.room?.outputs.find(output => output.kind === 'reference-media' && output.sceneId === threadId);
  if (!output || !target.workspace) return;
  const raw = JSON.parse(await (await target.workspace.output(output.id, target.room)).text()); if (!raw) return;
  const saved: SavedReference = { source: referenceSourceSchema.parse(raw.source), observations: referenceObservationSchema.array().parse(raw.observations), extraFrames: referenceFrameSchema.array().parse(raw.extraFrames ?? []) };
  if (raw.media) {
    const { name, type, dataUrl } = raw.media;
    if (typeof name !== 'string' || typeof type !== 'string' || typeof dataUrl !== 'string' || dataUrl.length > 14_000_000 || !/^data:(?:image|video)\/[A-Za-z0-9.+-]+;base64,/.test(dataUrl)) throw new Error('The saved reference contains invalid media.');
    saved.media = new File([await (await fetch(dataUrl)).blob()], name, { type });
  }
  bindings.set(key(target.room, saved.source.id), threadId); return saved;
}
async function update(threadId: string, target: ReturnType<typeof scope>, run: () => Promise<void>) {
  const id = key(target.room, threadId), previous = writes.get(id);
  const promise = (async () => { await previous?.catch(() => {}); await run(); })(); writes.set(id, promise);
  try { await promise; } finally { if (writes.get(id) === promise) writes.delete(id); }
}
export async function saveReference(threadId: string, value: ReferenceSource, media?: File) {
  const target = scope(), source = referenceSourceSchema.parse(value);
  await update(threadId, target, () => persistReference(threadId, { source, observations: [], media }, target));
}
export async function loadReference(threadId: string, target = scope()): Promise<ReferenceContext | undefined> {
  await writes.get(key(target.room, threadId));
  const saved = await savedReference(threadId, target); if (!saved) return;
  const source = referenceSourceSchema.parse({ ...saved.source, frames: [...saved.source.frames, ...(saved.extraFrames?.slice(-2) ?? [])] });
  const observations: ReferenceObservation[] = []; let characters = 0;
  for (const value of saved.observations.slice().reverse()) if (source.frames.some(frame => frame.id === value.frameId)) {
    const observation = referenceObservationSchema.parse(value), size = JSON.stringify(observation).length;
    if (observations.length < 8 && characters + size <= 700_000) { observations.unshift(observation); characters += size; }
  }
  return { source, observations, callsUsed: 0, framesRequested: false };
}
export async function saveObservations(progress: ReferenceProgress) {
  if (!progress.observations.length) return;
  const target = scope(), threadId = bindings.get(key(target.room, progress.sourceId));
  if (!threadId) throw new Error('Load this conversation reference before saving observations.');
  await update(threadId, target, async () => {
    const saved = await savedReference(threadId, target), observations = progress.observations.map(observation => referenceObservationSchema.parse(observation));
    if (!saved || saved.source.id !== progress.sourceId || observations.some(observation => observation.sourceId !== saved.source.id || ![...saved.source.frames, ...(saved.extraFrames ?? [])].some(frame => frame.id === observation.frameId))) throw new Error('The observations do not belong to the current reference.');
    saved.observations = [...saved.observations.filter(old => !observations.some(next => next.id === old.id)), ...observations];
    await persistReference(threadId, saved, target);
  });
}
export async function requestReferenceFrames(threadId: string, sourceId: string, times: number[], signal: AbortSignal): Promise<ReferenceContext> {
  const target = scope();
  await update(threadId, target, async () => {
    const saved = await savedReference(threadId, target);
    if (!saved || saved.source.id !== sourceId || saved.source.kind !== 'video' || !times.length || times.length > 2 || times.some(time => !Number.isFinite(time) || time < 0 || time >= saved.source.duration)) throw new Error('Requested frame does not belong to the current reference clip.');
    if (!saved.media) throw new Error('The original reference clip is unavailable. Attach it again to request another timestamp.');
    const measured = await prepareReferenceFrames(saved.media, signal, undefined, Promise.resolve(saved.source.cuts), [...times].sort((a, b) => a - b)); signal.throwIfAborted();
    saved.extraFrames ??= [];
    for (const frame of measured.frames) {
      const existing: ReferenceSource['frames'][number] | undefined = [...saved.source.frames, ...saved.extraFrames].find(old => Math.abs(old.time - frame.time) < .00001);
      if (existing && saved.source.frames.some(base => base.id === existing.id)) continue;
      const selected: ReferenceSource['frames'][number] = existing ?? frame;
      saved.extraFrames = [...saved.extraFrames.filter(old => old.id !== selected.id), selected];
    }
    await persistReference(threadId, saved, target);
  });
  const updated = await loadReference(threadId, target); if (!updated || updated.source.id !== sourceId) throw new Error('Reference changed while extracting the requested frame.'); return updated;
}
export async function detachReference(threadId: string) {
  const target = scope(); await update(threadId, target, () => persistReference(threadId, null, target));
}
