import { newId } from '../id.ts';
import { applyChanges, projectChanges, projectView, sameValue, type Change } from './changes.ts';
import type { ProjectDocument } from './storage.ts';
import type { ProjectRoom } from './room.ts';

export interface ProjectEdit { action: 'edit'; id: string; revision: number; changes: Change[] }
interface Options {
  send(edit: ProjectEdit): Promise<ProjectRoom>;
  watch(version: number, signal: AbortSignal): Promise<ProjectRoom | null>;
  receive(project: ProjectDocument): boolean;
  room(room: ProjectRoom): void;
  state(error: Error | null): void;
}

/** Server-ordered property writes, with unacknowledged local edits layered over incoming state. */
export class ProjectCollaboration {
  private confirmed: ProjectRoom;
  private observed: ProjectDocument;
  private pending: Change[] = [];
  private sending: ProjectEdit | null = null;
  private writing: Promise<void> | null = null;
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private receiveTimer?: ReturnType<typeof setTimeout>;
  private blocked = false;
  private receiving = false;
  private receiveDirty = false;
  constructor(room: ProjectRoom, private readonly options: Options) {
    this.confirmed = structuredClone(room); this.observed = structuredClone(room.project);
  }
  get dirty() { return !!(this.pending.length || this.sending); }
  get stopped() { return this.controller.signal.aborted; }
  start() { void this.listen(); }
  stop() { this.controller.abort(); clearTimeout(this.timer); clearTimeout(this.receiveTimer); }
  observe(project: ProjectDocument, guard = false) {
    if (this.stopped || this.receiving) return;
    const changes = projectChanges(this.observed, project).map(change => guard ? { ...change, guard: true, own: true } : change);
    this.observed = structuredClone(project);
    this.pending.push(...changes);
    if (changes.length && !this.blocked) {
      this.options.state(null);
      // Coalesce input/drag events without delaying other participants until pointer-up.
      this.timer ??= setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, 100);
    }
  }
  private accept(room: ProjectRoom) {
    if (this.stopped) return;
    if ((room.contentVersion ?? room.savedVersion) >= (this.confirmed.contentVersion ?? this.confirmed.savedVersion)) {
      this.confirmed = structuredClone(room); this.options.room(room);
    }
    this.receiveDirty = true; this.deliver();
  }
  private deliver() {
    clearTimeout(this.receiveTimer); this.receiveTimer = undefined;
    if (this.stopped || !this.receiveDirty || this.blocked) return;
    const next = projectView(applyChanges(this.confirmed.project, [...this.sending?.changes ?? [], ...this.pending]), this.observed);
    next.revision = Math.max(next.revision, this.observed.revision);
    if (sameValue(next, this.observed)) { this.receiveDirty = false; return; }
    this.receiving = true;
    try {
      if (this.options.receive(next)) { this.observed = structuredClone(next); this.receiveDirty = false; }
    } finally { this.receiving = false; }
    if (this.receiveDirty) this.receiveTimer = setTimeout(() => this.deliver(), 100);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.blocked) throw new Error('Keep this page open; save a copy to retain the conflicting edit.');
    if (this.writing) return this.writing;
    if (this.stopped || !this.dirty) return;
    this.writing = (async () => {
      while (!this.stopped && this.dirty) {
        if (!this.sending) {
          // A rapid undo must run after the server has recorded ownership of its original write.
          const boundary = this.pending.findIndex(change => !!change.own !== !!this.pending[0].own);
          this.sending = { action: 'edit', id: newId(), revision: this.observed.revision, changes: this.pending.splice(0, boundary < 0 ? this.pending.length : boundary) };
        }
        try {
          const room = await this.options.send(this.sending);
          this.sending = null; this.accept(room); this.options.state(null);
        } catch (error) {
          this.blocked = ['edit_conflict', 'invalid_edit', 'invalid_request'].includes((error as { code?: string }).code ?? '');
          this.options.state(error as Error); throw error;
        }
      }
    })().finally(() => { this.writing = null; });
    return this.writing;
  }
  private async listen() {
    let reconnecting = false;
    while (!this.stopped) {
      try {
        const room = await this.options.watch(reconnecting ? 0 : this.confirmed.contentVersion ?? this.confirmed.savedVersion, this.controller.signal);
        reconnecting = false;
        if (room) this.accept(room);
        if (!this.dirty && !this.blocked && !this.stopped) this.options.state(null);
      } catch (error) {
        if (this.stopped) return;
        reconnecting = true;
        this.options.state(error as Error);
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.controller.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 3000); this.controller.signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  }
}
