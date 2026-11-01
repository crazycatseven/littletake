import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { parseProject, serializeProject } from '../../src/project/storage.ts';
import { EDIT_LEASE_MS, MAX_OUTPUT_BYTES, type ProjectRoom, type ProjectOutput } from '../../src/project/room.ts';

export class ProjectRoomError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
interface Row {
  id: string; code: string; document: string; saved_version: number; updated_at: number;
  creator_token: string; lease_token: string | null; lease_until: number | null;
  lease_page: string | null;
}
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function roomCode() { return [...randomBytes(12)].map(byte => alphabet[byte % alphabet.length]).join(''); }
function normalizeCode(code: string) { return code.replace(/[-\s]/g, '').toUpperCase(); }

/** A project and its edit lease are written together on the application server. */
export class ProjectRoomStore {
  readonly db: DatabaseSync;
  constructor(directory: string, private readonly now = Date.now) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'projects.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, document TEXT NOT NULL,
        saved_version INTEGER NOT NULL, updated_at INTEGER NOT NULL, creator_token TEXT NOT NULL,
        lease_token TEXT, lease_until INTEGER
      );
      CREATE TABLE IF NOT EXISTS outputs (
        project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, kind TEXT NOT NULL,
        scene_id TEXT NOT NULL, shot_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
        updated_at INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(project_id,id)
      );
      CREATE TABLE IF NOT EXISTS ai_calls (project_id TEXT NOT NULL,run_id TEXT NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(project_id,run_id));`);
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some(column => column.name === 'lease_page')) this.db.exec('ALTER TABLE projects ADD COLUMN lease_page TEXT');
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = run(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private row(code: string): Row {
    const row = this.db.prepare('SELECT * FROM projects WHERE code=?').get(normalizeCode(code)) as unknown as Row | undefined;
    if (!row) throw new ProjectRoomError('project_missing', 'No project has that code. Check the code and try again.', 404);
    return row;
  }
  private snapshot(row: Row, lease?: string, page?: string): ProjectRoom {
    const occupied = row.lease_token !== null && (row.lease_until ?? 0) > this.now();
    return { id: row.id, code: row.code, project: JSON.parse(row.document), savedVersion: row.saved_version,
      updatedAt: row.updated_at, editing: occupied ? row.lease_token === lease && (!row.lease_page || row.lease_page === page) ? 'you' : 'occupied' : 'available',
      leaseExpiresAt: occupied ? row.lease_until : null, outputs: this.outputs(row.id) };
  }
  private requireEditor(row: Row, lease: string, page?: string) {
    if (row.lease_token !== lease || (row.lease_until ?? 0) <= this.now() || (row.lease_page && row.lease_page !== page))
      throw new ProjectRoomError('edit_lease_lost', 'Your editing session has ended. Keep your changes and rejoin before saving.');
  }
  private document(value: unknown) {
    try { return serializeProject(parseProject(JSON.stringify(value), false)); }
    catch { throw new ProjectRoomError('invalid_project', 'This project could not be validated. The saved project was not changed.', 400); }
  }
  create(id: string, lease: string, value: unknown, sourceCode?: string, outputs: { output: ProjectOutput; data: Uint8Array }[] = [], page?: string): ProjectRoom {
    const document = this.document(value);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Row | undefined;
      if (existing) {
        if (existing.creator_token !== lease) throw new ProjectRoomError('create_conflict', 'This project request already exists.');
        return this.snapshot(existing, lease, page);
      }
      let code = roomCode();
      while (this.db.prepare('SELECT 1 FROM projects WHERE code=?').get(code)) code = roomCode();
      const time = this.now();
      this.db.prepare('INSERT INTO projects(id,code,document,saved_version,updated_at,creator_token,lease_token,lease_until,lease_page) VALUES(?,?,?,?,?,?,?,?,?)').run(id, code, document, 1, time, lease, lease, time + EDIT_LEASE_MS, page ?? null);
      if (sourceCode) {
        const source = this.row(sourceCode);
        this.db.prepare('INSERT INTO outputs SELECT ?,id,kind,scene_id,shot_id,name,mime,updated_at,data FROM outputs WHERE project_id=?').run(id, source.id);
      }
      for (const { output, data } of outputs) {
        if (data.byteLength > MAX_OUTPUT_BYTES) throw new ProjectRoomError('output_too_large', 'This result is larger than 64 MB.', 413);
        this.db.prepare('INSERT INTO outputs VALUES(?,?,?,?,?,?,?,?,?)').run(id, output.id, output.kind, output.sceneId, output.shotId, output.name, output.mime, output.updatedAt, data);
      }
      return this.get(code, lease, page);
    });
  }
  get(code: string, lease?: string, page?: string): ProjectRoom { return this.snapshot(this.row(code), lease, page); }
  claim(code: string, lease: string, page?: string): ProjectRoom {
    return this.transaction(() => {
      const row = this.row(code);
      if (row.lease_token && row.lease_token !== lease && (row.lease_until ?? 0) > this.now())
        throw new ProjectRoomError('editor_present', 'Someone is editing this project. You can keep watching.');
      this.db.prepare('UPDATE projects SET lease_token=?,lease_until=?,lease_page=? WHERE id=?').run(lease, this.now() + EDIT_LEASE_MS, page ?? null, row.id);
      return this.get(code, lease, page);
    });
  }
  heartbeat(code: string, lease: string, page?: string): ProjectRoom {
    return this.transaction(() => {
      const row = this.row(code); this.requireEditor(row, lease, page);
      this.db.prepare('UPDATE projects SET lease_until=? WHERE id=?').run(this.now() + EDIT_LEASE_MS, row.id);
      return this.get(code, lease, page);
    });
  }
  release(code: string, lease: string, page?: string): ProjectRoom {
    return this.transaction(() => {
      const row = this.row(code);
      if (row.lease_token === null) return this.snapshot(row);
      this.requireEditor(row, lease, page);
      this.db.prepare('UPDATE projects SET lease_token=NULL,lease_until=NULL,lease_page=NULL WHERE id=?').run(row.id);
      return this.get(code);
    });
  }
  save(code: string, lease: string, version: number, value: unknown, page?: string): ProjectRoom {
    const document = this.document(value);
    return this.transaction(() => {
      const row = this.row(code); this.requireEditor(row, lease, page);
      // A lost response may be retried after the write already committed.
      if (row.document === document) return this.snapshot(row, lease, page);
      if (row.saved_version !== version) throw new ProjectRoomError('save_conflict', 'A newer project is already saved. Your changes have not replaced it.');
      this.db.prepare('UPDATE projects SET document=?,saved_version=saved_version+1,updated_at=?,lease_until=? WHERE id=?')
        .run(document, this.now(), this.now() + EDIT_LEASE_MS, row.id);
      return this.get(code, lease, page);
    });
  }
  private outputs(projectId: string): ProjectOutput[] {
    return this.db.prepare('SELECT id,kind,scene_id AS sceneId,shot_id AS shotId,name,mime,updated_at AS updatedAt FROM outputs WHERE project_id=? ORDER BY updated_at DESC').all(projectId) as unknown as ProjectOutput[];
  }
  readOutput(code: string, id: string): { output: ProjectOutput; data: Uint8Array } {
    const row = this.row(code), output = this.outputs(row.id).find(item => item.id === id);
    if (!output) throw new ProjectRoomError('output_missing', 'This saved result could not be found.', 404);
    const data = this.db.prepare('SELECT data FROM outputs WHERE project_id=? AND id=?').get(row.id, id)!.data as Uint8Array;
    return { output, data };
  }
  saveOutput(code: string, lease: string, output: Omit<ProjectOutput, 'updatedAt'>, data: Uint8Array, page?: string): ProjectOutput {
    if (data.byteLength > MAX_OUTPUT_BYTES) throw new ProjectRoomError('output_too_large', 'This result is larger than 64 MB.', 413);
    return this.transaction(() => {
      const row = this.row(code); this.requireEditor(row, lease, page);
      const updatedAt = this.now();
      this.db.prepare(`INSERT INTO outputs VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET
        kind=excluded.kind,scene_id=excluded.scene_id,shot_id=excluded.shot_id,name=excluded.name,mime=excluded.mime,updated_at=excluded.updated_at,data=excluded.data`)
        .run(row.id, output.id, output.kind, output.sceneId, output.shotId, output.name, output.mime, updatedAt, data);
      return { ...output, updatedAt };
    });
  }
  consumeCall(code: string, lease: string, runId: string, limit = 72, page?: string): number {
    return this.transaction(() => {
      const row = this.row(code); this.requireEditor(row, lease, page);
      const current = this.db.prepare('SELECT calls FROM ai_calls WHERE project_id=? AND run_id=?').get(row.id, runId)?.calls as number | undefined;
      if ((current ?? 0) >= limit) throw new ProjectRoomError('call_limit', 'This analysis reached its model-call limit. Completed work is kept.', 429);
      const calls = (current ?? 0) + 1;
      this.db.prepare('INSERT INTO ai_calls VALUES(?,?,?) ON CONFLICT(project_id,run_id) DO UPDATE SET calls=excluded.calls').run(row.id, runId, calls);
      return calls;
    });
  }
  /** Uses SQLite's online snapshot API, including committed WAL contents. */
  async backupTo(filename: string) { await backup(this.db, filename); }
  close() { this.db.close(); }
}
