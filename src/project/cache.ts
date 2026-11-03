import { newId } from '../id';
import { zipFiles } from '../look/zip';
import { MAX_ARCHIVE_BYTES } from './room';

/** One-time retirement of browser-owned project data. Normal editing never writes here. */
export async function retireBrowserProjects(lease: string, page: string): Promise<string | undefined> {
  const names = (await indexedDB.databases()).map(value => value.name!).filter(name => name === 'littletake-projects' || name === 'littletake.diagnostics' || name === 'littletake.reference-media' || name.startsWith('littletake.reference-media:'));
  const keys = Object.keys(localStorage).filter(key => ['littletake.project.v1', 'littletake.scene.v1', 'littletake.projects.recent.v1', 'littletake.projects.migrated.v1'].includes(key) || key.startsWith('littletake.asset-draft.'));
  if (!names.length && !keys.length) return;
  const files: { name: string; data: Uint8Array }[] = []; let size = 0;
  const add = (name: string, data: Uint8Array) => { size += data.byteLength; if (size > MAX_ARCHIVE_BYTES - 4096) throw new Error('Previous browser data is larger than 250 MB. It has been retained; export it before removing it.'); files.push({ name, data }); };
  const encode = async (value: unknown): Promise<unknown> => {
    if (value instanceof Blob) {
      const path = 'media/' + files.length; add(path, new Uint8Array(await value.arrayBuffer()));
      return { file: path, type: value.type, ...(value instanceof File ? { name: value.name, lastModified: value.lastModified } : {}) };
    }
    if (Array.isArray(value)) { const values = []; for (const item of value) values.push(await encode(item)); return values; }
    if (value && typeof value === 'object') { const entries = []; for (const [key, item] of Object.entries(value)) entries.push([key, await encode(item)]); return Object.fromEntries(entries); }
    return value;
  };
  const databases: unknown[] = [], snapshots: { name: string; stores: { name: string; signature: string }[] }[] = [];
  const signature = (keys: unknown[], values: unknown[]) => JSON.stringify({ keys, values }, (_key, value) => value instanceof Blob ? { size: value.size, type: value.type, ...(value instanceof File ? { name: value.name, lastModified: value.lastModified } : {}) } : value);
  let records = 0;
  for (const name of names) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onupgradeneeded = () => request.transaction?.abort(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const stores: unknown[] = [], snapshot: { name: string; signature: string }[] = [];
      for (const storeName of db.objectStoreNames) {
        const entries = await new Promise<{ keys: IDBValidKey[]; values: unknown[] }>((resolve, reject) => {
          const tx = db.transaction(storeName), store = tx.objectStore(storeName), keys = store.getAllKeys(), values = store.getAll();
          tx.oncomplete = () => resolve({ keys: keys.result, values: values.result }); tx.onerror = tx.onabort = () => reject(tx.error);
        });
        records += entries.values.length;
        stores.push({ name: storeName, keys: entries.keys, values: await encode(entries.values) }); snapshot.push({ name: storeName, signature: signature(entries.keys, entries.values) });
      }
      databases.push({ name, stores });
      snapshots.push({ name, stores: snapshot });
    } finally { db.close(); }
  }
  if (!records && !keys.length) return;
  const local = Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)]));
  add('browser-data.json', new TextEncoder().encode(JSON.stringify({ format: 'LittleTake.browser-recovery', version: 1, localStorage: local, databases })));
  const id = newId(), archive = new Blob([zipFiles(files) as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
  const response = await fetch('/api/projects?browserRecovery=' + id, { method: 'POST', headers: { 'x-littletake-edit-lease': lease, 'x-littletake-edit-page': page }, body: archive });
  const result = await response.json();
  if (!response.ok || result.id !== id) throw new Error('Previous browser data could not be moved to the workspace. It is retained in this browser; keep this page open and retry.');
  for (const snapshot of snapshots) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(snapshot.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      for (const saved of snapshot.stores) await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(saved.name, 'readwrite'), store = tx.objectStore(saved.name), keys = store.getAllKeys(), values = store.getAll();
        values.onsuccess = () => { if (signature(keys.result, values.result) === saved.signature) store.clear(); else tx.abort(); };
        tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(new Error('Browser data changed while it was being backed up. Close older LittleTake tabs, then reload. Newer browser data was retained.'));
      });
    } finally { db.close(); }
  }
  for (const key of keys) if (localStorage.getItem(key) === local[key]) localStorage.removeItem(key);
  return id;
}
