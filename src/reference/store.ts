import type {Workspace} from '../project/workspace';
import type {ProjectRoom} from '../project/room';
import { referenceSourceSchema, referenceFrameSchema, referenceObservationSchema, type ReferenceContext, type ReferenceProgress, type ReferenceSource, type ReferenceObservation } from './observations';
import { prepareReferenceFrames } from './frames';

interface SavedReference { source: ReferenceSource; observations: ReferenceObservation[]; media?: File; extraFrames?: ReferenceSource['frames'] }
let workspace:Workspace|undefined;
export function referenceWorkspace(value:Workspace){workspace=value;}
const scope=()=>({workspace,room:workspace?.room??null});
async function persistReference(threadId:string,saved:SavedReference|null,target:ReturnType<typeof scope>){
  if(!target.workspace||!target.room)return;
  const media=saved?.media?{name:saved.media.name,type:saved.media.type,dataUrl:await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(saved.media!);})}:undefined;
  await target.workspace.putOutput({id:threadId,kind:'reference-media',sceneId:threadId,shotId:'',name:saved?.source.name??'Detached reference',mime:'application/json'},new Blob([JSON.stringify(saved?{...saved,media}:null)],{type:'application/json'}),target.room);
}
function database(room:ProjectRoom|null=workspace?.room??null): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('littletake.reference-media'+(room?':'+room.code:''), 1);
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
async function readSaved(db: IDBDatabase, threadId: string): Promise<SavedReference | undefined> {
  const transaction = db.transaction(['sources', 'bindings'], 'readonly');
  const id = await result(transaction.objectStore('bindings').get(threadId));
  return id ? result(transaction.objectStore('sources').get(id)) : undefined;
}
async function writeSaved(db: IDBDatabase, threadId: string, saved: SavedReference | null) {
  const transaction = db.transaction(['sources', 'bindings'], 'readwrite'), completed = done(transaction);
  if (saved) { transaction.objectStore('sources').put(saved); transaction.objectStore('bindings').put(saved.source.id, threadId); }
  else transaction.objectStore('bindings').delete(threadId);
  await completed;
}
async function restoreSaved(value: unknown): Promise<SavedReference | null> {
  if (value === null) return null;
  const raw = value as SavedReference & {media?: {name: string; type: string; dataUrl: string}};
  const saved: SavedReference = {source: referenceSourceSchema.parse(raw.source), observations: referenceObservationSchema.array().parse(raw.observations), extraFrames: referenceFrameSchema.array().parse(raw.extraFrames ?? [])};
  if (raw.media) {
    const {name, type, dataUrl} = raw.media;
    if (typeof name !== 'string' || typeof type !== 'string' || typeof dataUrl !== 'string' || dataUrl.length > 14_000_000 || !/^data:(?:image|video)\/[A-Za-z0-9.+-]+;base64,/.test(dataUrl)) throw new Error('The saved reference contains invalid media.');
    saved.media = new File([await (await fetch(dataUrl)).blob()], name, {type});
  }
  return saved;
}
export async function saveReference(threadId: string, value: ReferenceSource, media?: File): Promise<void> {
  const target=scope(),source = referenceSourceSchema.parse(value), db = await database(target.room);
  try {
    const transaction = db.transaction(['sources', 'bindings'], 'readwrite'), completed = done(transaction);
    transaction.objectStore('sources').add({ source, observations: [], media });
    transaction.objectStore('bindings').put(source.id, threadId);
    await completed;
    await persistReference(threadId,{source,observations:[],media},target);
  } finally { db.close(); }
}
export async function loadReference(threadId: string, target=scope()): Promise<ReferenceContext | undefined> {
  const db = await database(target.room);
  try {
    const output=target.room?.outputs.find(output=>output.kind==='reference-media'&&output.sceneId===threadId);
    if(output&&target.workspace){
      const saved=await restoreSaved(JSON.parse(await (await target.workspace.output(output.id,target.room)).text()));
      await writeSaved(db,threadId,saved);
      if(!saved)return undefined;
    }
    let saved=await readSaved(db,threadId);
    // Copy a previous browser-only binding once. Never remove the original database.
    if(!saved&&!output&&target.room){
      const legacy=await database(null);
      try{saved=await readSaved(legacy,threadId);}finally{legacy.close();}
      if(saved)await writeSaved(db,threadId,saved);
    }
    if(!saved)return undefined;
    if(!output&&target.room&&target.workspace?.room===target.room&&target.workspace.canEdit)await persistReference(threadId,saved,target);
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
  const target=scope(),observations = progress.observations.map(observation => referenceObservationSchema.parse(observation)), db = await database(target.room);
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
    const saved=await result<SavedReference>(db.transaction('sources','readonly').objectStore('sources').get(progress.sourceId));
    const threadId=await result<IDBValidKey[]>(db.transaction('bindings','readonly').objectStore('bindings').getAllKeys()).then(async keys=>{for(const key of keys as IDBValidKey[])if(await result(db.transaction('bindings','readonly').objectStore('bindings').get(key))===progress.sourceId)return String(key);});
    if(threadId)await persistReference(threadId,saved,target);
  } finally { db.close(); }
}
export async function requestReferenceFrames(threadId: string, sourceId: string, times: number[], signal: AbortSignal): Promise<ReferenceContext> {
  const target=scope(),current = await loadReference(threadId,target);
  if (!current || current.source.id !== sourceId || current.source.kind !== 'video' || !times.length || times.length > 2 || times.some(time => !Number.isFinite(time) || time < 0 || time >= current.source.duration)) throw new Error('Requested frame does not belong to the current reference clip.');
  const db = await database(target.room);
  let saved: SavedReference;
  try { saved = await result(db.transaction('sources', 'readonly').objectStore('sources').get(sourceId)); } finally { db.close(); }
  if (!saved.media) throw new Error('The original reference clip is unavailable. Attach it again to request another timestamp.');
  const measured = await prepareReferenceFrames(saved.media, signal, undefined, Promise.resolve(current.source.cuts), [...times].sort((a, b) => a - b));
  signal.throwIfAborted();
  const writing = await database(target.room);
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
  const read=await database(target.room);try{await persistReference(threadId,await result<SavedReference>(read.transaction('sources','readonly').objectStore('sources').get(sourceId)),target);}finally{read.close();}
  const updated = await loadReference(threadId,target);
  if (!updated || updated.source.id !== sourceId) throw new Error('Reference changed while extracting the requested frame.');
  return updated;
}
export async function detachReference(threadId: string): Promise<void> {
  const target=scope(),db = await database(target.room);
  try { const transaction = db.transaction('bindings', 'readwrite'), completed = done(transaction); transaction.objectStore('bindings').delete(threadId); await completed;await persistReference(threadId,null,target); }
  finally { db.close(); }
}
