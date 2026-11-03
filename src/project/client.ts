import type { Workspace } from './workspace';
let active: { code: string; lease: string; page: string } | null = null;
let workspace: Workspace | undefined;
export function activeWorkspace() { return workspace; }
export function projectRequestContext(value: typeof active, owner?: Workspace) { active = value; workspace = owner; }
export function projectDiagnosticId(id: string): string { return active ? active.code + ':' + id : id; }
export async function projectFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const context = active;
  if (context && workspace) await workspace.ensureSession();
  if (context !== active) throw new Error('The active project changed.');
  const headers = new Headers(init.headers);
  if (active) { headers.set('x-littletake-project', active.code); headers.set('x-littletake-edit-lease', active.lease); headers.set('x-littletake-edit-page', active.page); }
  return fetch(input, { ...init, headers });
}
