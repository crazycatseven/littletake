import type { SceneEditInput } from './types.ts';
import type { SceneEditDiagnostic } from './diagnostics.ts';
import type { Conversation } from './conversations.ts';

export interface DiagnosticIdentity { turnId: string; conversationId: string; messageId: string }
export interface RequestDiagnostic extends DiagnosticIdentity {
  id: string; startedAt: string; finishedAt?: string; input: SceneEditInput;
  status: 'pending' | 'ready' | 'needs_views' | 'failed' | 'cancelled';
  server?: SceneEditDiagnostic; error?: string; unreadableResponse?: string;
}

// Large request snapshots live separately from the small, frequently saved project document.
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('littletake.diagnostics', 1);
    request.onupgradeneeded = () => {
      const records = request.result.createObjectStore('requests', { keyPath: 'id' });
      records.createIndex('conversation', 'conversationId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not open diagnostic storage.'));
    request.onblocked = () => reject(new Error('Close other LittleTake tabs to open diagnostic storage.'));
  });
}

export async function saveDiagnostic(record: RequestDiagnostic): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('requests', 'readwrite');
      transaction.objectStore('requests').put(structuredClone(record));
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new Error('Could not save the run diagnostic. Browser storage may be full.'));
    });
  } finally { database.close(); }
}

export async function readDiagnostics(conversationId: string): Promise<RequestDiagnostic[]> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction('requests').objectStore('requests').index('conversation').getAll(conversationId);
      request.onsuccess = () => resolve((request.result as RequestDiagnostic[]).sort((a, b) => a.startedAt.localeCompare(b.startedAt)));
      request.onerror = () => reject(new Error('Could not read the saved diagnostics.'));
    });
  } finally { database.close(); }
}

export async function downloadDiagnostics(conversation: Conversation): Promise<number> {
  const savedConversation = structuredClone(conversation);
  const requests = await readDiagnostics(savedConversation.id);
  if (!requests.length) throw new Error('No recorded requests in this conversation yet.');
  const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'LittleTake.conversation-diagnostics', version: 1, conversationId: savedConversation.id, conversation: savedConversation, requests }, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'LittleTake-conversation-diagnostics.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); return requests.length;
}
