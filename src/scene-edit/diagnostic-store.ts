import type { SceneEditInput } from './types.ts';
import type { SceneEditDiagnostic } from './diagnostics.ts';
import type { Conversation } from './conversations.ts';
import { activeWorkspace, projectDiagnosticId } from '../project/client.ts';
import type { ProjectRoom } from '../project/room.ts';
import type { Workspace } from '../project/workspace.ts';

export interface DiagnosticIdentity { turnId: string; conversationId: string; messageId: string }
export interface RequestDiagnostic<T = SceneEditInput> extends DiagnosticIdentity {
  id: string; startedAt: string; finishedAt?: string; input: T;
  status: 'pending' | 'ready' | 'needs_views' | 'needs_reference_frames' | 'needs_motion_review' | 'failed' | 'cancelled';
  server?: SceneEditDiagnostic; result?: unknown; error?: string; unreadableResponse?: string;
}
const targets = new Map<string, { workspace: Workspace; room: ProjectRoom }>();
const conversation = (value: string) => value.slice(value.indexOf(':') + 1);
/** Large snapshots are project outputs on the running service, alongside media and results. */
export async function saveDiagnostic<T>(record: RequestDiagnostic<T>): Promise<void> {
  let target = targets.get(record.id);
  if (!target) {
    const workspace = activeWorkspace(), room = workspace?.room;
    if (!workspace || !room) throw new Error('Open a project before starting an AI request.');
    target = { workspace, room }; targets.set(record.id, target);
  }
  if (record.status === 'cancelled' && target.workspace.room?.id !== target.room.id) { targets.delete(record.id); return; }
  await target.workspace.putOutput({ id: record.id, kind: 'diagnostic', sceneId: conversation(record.conversationId), shotId: '', name: 'AI request ' + record.startedAt, mime: 'application/json' }, new Blob([JSON.stringify(record)], { type: 'application/json' }), target.room);
  if (record.finishedAt) targets.delete(record.id);
}
export async function readDiagnostics<T = SceneEditInput>(conversationId: string): Promise<RequestDiagnostic<T>[]> {
  const workspace = activeWorkspace(), room = workspace?.room; if (!workspace || !room) return [];
  const outputs = room.outputs.filter(output => output.kind === 'diagnostic' && output.sceneId === conversation(conversationId));
  const requests: RequestDiagnostic<T>[] = [];
  for (const output of outputs) requests.push(JSON.parse(await (await workspace.output(output.id, room)).text()));
  return requests.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
export async function downloadDiagnostics(conversation: Conversation): Promise<number> {
  const savedConversation = structuredClone(conversation);
  const requests = await readDiagnostics(projectDiagnosticId(savedConversation.id));
  if (!requests.length) throw new Error('No recorded requests in this conversation yet.');
  const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'LittleTake.conversation-diagnostics', version: 1, conversationId: savedConversation.id, conversation: savedConversation, requests }, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'LittleTake-conversation-diagnostics.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); return requests.length;
}
