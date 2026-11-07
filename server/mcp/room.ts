import type { Change } from '../../src/project/changes.ts';
import type { ProjectRoom, ProjectSummary } from '../../src/project/room.ts';

export class RoomError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
type Transport = (input: URL, init: RequestInit) => Promise<Response>;

/** One agent's editing seat in a LittleTake project room. It edits beside open browser pages, which receive its changes live. */
export class LittleTakeRoom {
  readonly lease = crypto.randomUUID();
  readonly page = crypto.randomUUID();
  code: string | null = null;
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(readonly baseUrl: string, private readonly transport: Transport = (input, init) => fetch(input, init)) {}

  private async call<T>(query: string, body?: unknown): Promise<T> {
    const response = await this.transport(new URL('/api/projects' + query, this.baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    if (!response.ok) throw new RoomError(data?.error?.code ?? 'request_failed', data?.error?.message ?? `LittleTake answered ${response.status}.`, response.status);
    return data as T;
  }
  private required(): string {
    if (!this.code) throw new RoomError('no_project', 'Open a project first with open_project.', 400);
    return this.code;
  }
  async list(): Promise<ProjectSummary[]> { return (await this.call<{ projects: ProjectSummary[] }>('?list')).projects; }
  async open(code: string): Promise<ProjectRoom> {
    if (this.code && this.code !== code) await this.close();
    const room = await this.call<ProjectRoom>(`?code=${encodeURIComponent(code)}`, { action: 'claim' });
    this.code = code; clearInterval(this.heartbeat);
    // Leases expire after 90 s; renew well inside that while the agent is thinking.
    this.heartbeat = setInterval(() => { void this.call(`?code=${encodeURIComponent(code)}`, { action: 'heartbeat' }).catch(() => {}); }, 30_000);
    this.heartbeat.unref?.();
    return room;
  }
  get(): Promise<ProjectRoom> { return this.call<ProjectRoom>(`?code=${encodeURIComponent(this.required())}`); }
  edit(changes: Change[], revision: number): Promise<ProjectRoom> {
    return this.call<ProjectRoom>(`?code=${encodeURIComponent(this.required())}`, { action: 'edit', id: crypto.randomUUID(), revision, changes });
  }
  async close(): Promise<void> {
    clearInterval(this.heartbeat); this.heartbeat = undefined;
    const code = this.code; this.code = null;
    if (code) await this.call(`?code=${encodeURIComponent(code)}`, { action: 'release' }).catch(() => {});
  }
}
