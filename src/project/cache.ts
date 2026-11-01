import type { ProjectDocument } from './storage';
import type { ProjectOutput } from './room';

export interface ProjectDraft { id: string; code: string; lease: string; savedVersion: number; project: ProjectDocument; dirty: boolean; updatedAt?: number; creation?: { id: string; sourceCode?: string } }
export interface CachedOutput { id: string; code: string; output: ProjectOutput; data: Blob; pending: boolean }
let opened: Promise<IDBDatabase> | undefined;
const database = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('littletake-projects', 1);
  request.onupgradeneeded = () => { for (const name of ['drafts', 'outputs']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' }); };
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
async function request<T>(store: string, write: boolean, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, write ? 'readwrite' : 'readonly'), operation = run(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(operation.result); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
  });
}
export const projectCache = {
  draft: (code: string, lease: string) => request<ProjectDraft | undefined>('drafts', false, store => store.get(`${code}:${lease}`)),
  saveDraft: (draft: ProjectDraft) => request('drafts', true, store => store.put({ ...draft, updatedAt: Date.now() })),
  drafts: async (code: string) => (await request<ProjectDraft[]>('drafts', false, store => store.getAll())).filter(draft => draft.code === code && draft.dirty).sort((a,b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
  output: (code: string, id: string) => request<CachedOutput | undefined>('outputs', false, store => store.get(`${code}:${id}`)),
  saveOutput: (value: CachedOutput) => request('outputs', true, store => store.put(value)),
  outputs: async (code: string) => (await request<CachedOutput[]>('outputs', false, store => store.getAll())).filter(value => value.code === code),
};
