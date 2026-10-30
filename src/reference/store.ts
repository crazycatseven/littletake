import { referenceSourceSchema, referenceObservationSchema, type ReferenceContext, type ReferenceProgress, type ReferenceSource, type ReferenceObservation } from './observations';
import { prepareReferenceFrames } from './frames';

interface SavedReference { source: ReferenceSource; observations: ReferenceObservation[]; media?: File; extraFrames?: ReferenceSource['frames'] }
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('littletake.reference-media', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('sources', { keyPath: 'source.id' }); request.result.createObjectStore('bindings'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Reference storage could not be opened.'));
    request.onblocked = () => reject(new Error('Close other LittleTake tabs to update reference storage.'));
  });
}
const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
function done(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(new Error('Reference storage could not be saved. Existing references were preserved.')); });
}
export async function saveReference(threadId: string, value: ReferenceSource, media?: File): Promise<void> {
  const source = referenceSourceSchema.parse(value), db = await database();
  try {
    const transaction = db.transaction(['sources', 'bindings'], 'readwrite'), completed = done(transaction);
    transaction.objectStore('sources').add({ source, observations: [], media });
    transaction.objectStore('bindings').put(source.id, threadId);
    await completed;
  } finally { db.close(); }
}
export async function loadReference(threadId: string): Promise<ReferenceContext | undefined> {
  const db = await database();
  try {
    const transaction = db.transaction(['sources', 'bindings'], 'readonly');
    const id = await result(transaction.objectStore('bindings').get(threadId));
    if (!id) return undefined;
    const saved = await result<SavedReference | undefined>(transaction.objectStore('sources').get(id));
    if (!saved) throw new Error('The selected reference could not be found. Attach it again.');
    const source = referenceSourceSchema.parse({ ...saved.source, frames: [...saved.source.frames, ...(saved.extraFrames?.slice(-2) ?? [])] });
    const observations: ReferenceObservation[] = []; let characters = 0;
    for (const value of saved.observations.slice().reverse()) if (source.frames.some(frame => frame.id === value.frameId)) {
      const observation = referenceObservationSchema.parse(value), size = JSON.stringify(observation).length;
      if (observations.length < 8 && characters + size <= 700_000) { observations.unshift(observation); characters += size; }
    }
    return { source, observations, callsUsed: 0, framesRequested: false };
  } finally { db.close(); }
}
export async function saveObservations(progress: ReferenceProgress): Promise<void> {
  if (!progress.observations.length) return;
  const observations = progress.observations.map(observation => referenceObservationSchema.parse(observation)), db = await database();
  try {
    const transaction = db.transaction('sources', 'readwrite'), completed = done(transaction), store = transaction.objectStore('sources');
    const request = store.get(progress.sourceId);
    request.onsuccess = () => {
      const saved: SavedReference | undefined = request.result;
      if (!saved || observations.some(observation => observation.sourceId !== saved.source.id || ![...saved.source.frames, ...(saved.extraFrames ?? [])].some(frame => frame.id === observation.frameId))) { transaction.abort(); return; }
      saved.observations = [...saved.observations.filter(old => !observations.some(next => next.id === old.id)), ...observations];
      store.put(saved);
    };
    await completed;
  } finally { db.close(); }
}
export async function requestReferenceFrames(threadId: string, sourceId: string, times: number[], signal: AbortSignal): Promise<ReferenceContext> {
  const current = await loadReference(threadId);
  if (!current || current.source.id !== sourceId || current.source.kind !== 'video' || !times.length || times.length > 2 || times.some(time => !Number.isFinite(time) || time < 0 || time >= current.source.duration)) throw new Error('Requested frame does not belong to the current reference clip.');
  const db = await database();
  let saved: SavedReference;
  try { saved = await result(db.transaction('sources', 'readonly').objectStore('sources').get(sourceId)); } finally { db.close(); }
  if (!saved.media) throw new Error('The original reference clip is unavailable. Attach it again to request another timestamp.');
  const measured = await prepareReferenceFrames(saved.media, signal, undefined, Promise.resolve(current.source.cuts), [...times].sort((a, b) => a - b));
  signal.throwIfAborted();
  const writing = await database();
  try {
    const transaction = writing.transaction('sources', 'readwrite'), completed = done(transaction), store = transaction.objectStore('sources'), request = store.get(sourceId);
    request.onsuccess = () => {
      const latest: SavedReference = request.result;
      latest.extraFrames ??= [];
      for (const frame of measured.frames) {
        const existing: ReferenceSource['frames'][number] | undefined = [...latest.source.frames, ...latest.extraFrames].find(old => Math.abs(old.time - frame.time) < .00001);
        if (existing && latest.source.frames.some(base => base.id === existing.id)) continue;
        const selected: ReferenceSource['frames'][number] = existing ?? frame;
        latest.extraFrames = [...latest.extraFrames.filter(old => old.id !== selected.id), selected];
      }
      store.put(latest);
    };
    await completed;
  } finally { writing.close(); }
  const updated = await loadReference(threadId);
  if (!updated || updated.source.id !== sourceId) throw new Error('Reference changed while extracting the requested frame.');
  return updated;
}
export async function detachReference(threadId: string): Promise<void> {
  const db = await database();
  try { const transaction = db.transaction('bindings', 'readwrite'), completed = done(transaction); transaction.objectStore('bindings').delete(threadId); await completed; }
  finally { db.close(); }
}
