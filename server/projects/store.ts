import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { parseProject, serializeProject } from '../../src/project/storage.ts';
import { applyChanges, changesBetween, projectView, sameValue, valueAt, type Change } from '../../src/project/changes.ts';
import { projectContent } from '../../src/project/model.ts';
import { EDIT_LEASE_MS, MAX_OUTPUT_BYTES, type ProjectRoom, type ProjectOutput, type ProjectSummary, type ProjectCover } from '../../src/project/room.ts';
import { coverVisual, validateCover, type CoverAttachment } from '../../src/project/cover.ts';
import type { HandoffReceipt, VideoManifest } from '../../src/look/handoff.ts';
import type { ProjectBundle } from '../../src/project/archive.ts';

export class ProjectRoomError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
interface Row {
  id: string; code: string; document: string; saved_version: number; updated_at: number;
  creator_token: string; lease_token: string | null; lease_until: number | null;
  lease_page: string | null;
  content_version: number; cloud_origin: string | null; cloud_version: number | null; cloud_local_version: number | null;
}
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function roomCode() { return [...randomBytes(12)].map(byte => alphabet[byte % alphabet.length]).join(''); }
function normalizeCode(code: string) { return code.replace(/[-\s]/g, '').toUpperCase(); }

/** Shared projects use independent page sessions and versioned, atomic saves. */
export class ProjectRoomStore {
  readonly db: DatabaseSync;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly directory: string, private readonly now = Date.now) {
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
      CREATE TABLE IF NOT EXISTS project_covers (
        project_id TEXT PRIMARY KEY REFERENCES projects(id), saved_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, data BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_sessions (
        project_id TEXT NOT NULL REFERENCES projects(id), token TEXT NOT NULL, page TEXT NOT NULL,
        expires_at INTEGER NOT NULL, PRIMARY KEY(project_id,token,page)
      );
      CREATE TABLE IF NOT EXISTS project_edits (
        project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL,
        token TEXT NOT NULL, page TEXT NOT NULL, PRIMARY KEY(project_id,id)
      );
      CREATE TABLE IF NOT EXISTS project_property_writers (
        project_id TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL, token TEXT NOT NULL,
        page TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(project_id,path)
      );
      CREATE TABLE IF NOT EXISTS ai_calls (project_id TEXT NOT NULL,run_id TEXT NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(project_id,run_id));
      CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
        scene_id TEXT NOT NULL, shot_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER, archive BLOB NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some(column => column.name === 'lease_page')) this.db.exec('ALTER TABLE projects ADD COLUMN lease_page TEXT');
    const columns = new Set(this.db.prepare('PRAGMA table_info(projects)').all().map(column => column.name));
    if (!columns.has('content_version')) this.db.exec('ALTER TABLE projects ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1; UPDATE projects SET content_version=saved_version');
    for (const [name, type] of [['cloud_origin', 'TEXT'], ['cloud_version', 'INTEGER'], ['cloud_local_version', 'INTEGER']])
      if (!columns.has(name)) this.db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${type}`);
    // Preserve an already-open page across the upgrade, without retaining its exclusive seat.
    this.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO project_sessions SELECT id,lease_token,COALESCE(lease_page,''),lease_until
        FROM projects WHERE lease_token IS NOT NULL AND lease_until>?`).run(this.now());
      this.db.exec('UPDATE projects SET lease_token=NULL,lease_until=NULL,lease_page=NULL WHERE lease_token IS NOT NULL');
    });
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    let value: T;
    try { value = run(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    for (const listener of this.listeners) listener();
    return value;
  }
  private row(code: string): Row {
    const row = this.db.prepare('SELECT * FROM projects WHERE code=?').get(normalizeCode(code)) as unknown as Row | undefined;
    if (!row) throw new ProjectRoomError('project_missing', 'No project has that code. Check the code and try again.', 404);
    return row;
  }
  private snapshot(row: Row, lease?: string, page?: string): ProjectRoom {
    const expires = lease ? this.sessionExpiry(row.id, lease, page) : null;
    return { id: row.id, code: row.code, project: JSON.parse(row.document), savedVersion: row.saved_version, contentVersion: row.content_version,
      ...(row.cloud_origin && row.cloud_version !== null ? { cloud: { origin: row.cloud_origin, version: row.cloud_version, localVersion: row.cloud_local_version ?? 0 } } : {}),
      updatedAt: row.updated_at, editing: expires ? 'you' : 'available',
      leaseExpiresAt: expires, outputs: this.outputs(row.id), handoffs: this.handoffs(row.id), cover: this.coverInfo(row.id) };
  }
  private sessionExpiry(id: string, lease: string, page?: string): number | null {
    const session = this.db.prepare('SELECT expires_at FROM project_sessions WHERE project_id=? AND token=? AND page=? AND expires_at>?').get(id, lease, page ?? '', this.now());
    return session ? Number(session.expires_at) : null;
  }
  private renewSession(id: string, lease: string, page?: string) {
    this.db.prepare('DELETE FROM project_sessions WHERE expires_at<=?').run(this.now());
    this.db.prepare(`INSERT INTO project_sessions VALUES(?,?,?,?) ON CONFLICT(project_id,token,page)
      DO UPDATE SET expires_at=excluded.expires_at`).run(id, lease, page ?? '', this.now() + EDIT_LEASE_MS);
  }
  private requireEditor(row: Row, lease: string, page?: string) {
    if (!this.sessionExpiry(row.id, lease, page))
      throw new ProjectRoomError('edit_lease_lost', 'The project connection expired. Reconnect and retry; your changes are kept in this page.');
  }
  private document(value: unknown) {
    try { return serializeProject(parseProject(JSON.stringify(value), false)); }
    catch { throw new ProjectRoomError('invalid_project', 'This project could not be validated. The saved project was not changed.', 400); }
  }
  create(id: string, lease: string, value: unknown, sourceCode?: string, outputs: { output: ProjectOutput; data: Uint8Array }[] = [], page?: string, cover?: CoverAttachment): ProjectRoom {
    const document = this.document(value);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Row | undefined;
      if (existing) {
        if (existing.creator_token !== lease) throw new ProjectRoomError('create_conflict', 'This project request already exists.');
        this.renewSession(existing.id, lease, page);
        return this.snapshot(existing, lease, page);
      }
      let code = roomCode();
      while (this.db.prepare('SELECT 1 FROM projects WHERE code=?').get(code)) code = roomCode();
      const time = this.now();
      this.db.prepare('INSERT INTO projects(id,code,document,saved_version,updated_at,creator_token) VALUES(?,?,?,?,?,?)').run(id, code, document, 1, time, lease);
      this.renewSession(id, lease, page);
      if (sourceCode) {
        const source = this.row(sourceCode);
        this.db.prepare('INSERT INTO outputs SELECT ?,id,kind,scene_id,shot_id,name,mime,updated_at,data FROM outputs WHERE project_id=?').run(id, source.id);
        const originalCover = this.coverAttachment(source);
        if (!cover && originalCover) cover = { ...originalCover, current: originalCover.current && coverVisual(JSON.parse(source.document)) === coverVisual(JSON.parse(document)) };
      }
      if (cover) this.writeCover(id, cover.current ? 1 : 0, cover.data);
      for (const { output, data } of outputs) {
        if (data.byteLength > MAX_OUTPUT_BYTES) throw new ProjectRoomError('output_too_large', 'This result is larger than 64 MB.', 413);
        this.db.prepare('INSERT INTO outputs VALUES(?,?,?,?,?,?,?,?,?)').run(id, output.id, output.kind, output.sceneId, output.shotId, output.name, output.mime, output.updatedAt, data);
      }
      return this.get(code, lease, page);
    });
  }
  get(code: string, lease?: string, page?: string): ProjectRoom { return this.snapshot(this.row(code), lease, page); }
  /** Hold the read until a committed change arrives. Reconnecting always reads the latest snapshot. */
  async changes(code: string, since: number, signal: AbortSignal, lease?: string, page?: string): Promise<ProjectRoom | null> {
    this.row(code);
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown, room: ProjectRoom | null = null) => {
        clearTimeout(timeout); clearInterval(checkpoint); this.listeners.delete(check); signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(room);
      };
      const check = () => { try { const row = this.row(code); if (row.content_version > since) finish(undefined, this.snapshot(row, lease, page)); } catch (error) { finish(error); } };
      const abort = () => finish(new DOMException('Project connection closed.', 'AbortError'));
      const timeout = setTimeout(() => finish(), 25000);
      // Also observe writes from another SQLite connection (maintenance/imports).
      const checkpoint = setInterval(check, 1000);
      this.listeners.add(check); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else check();
    });
  }
  getById(id: string, lease?: string, page?: string): ProjectRoom {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Row | undefined;
    if (!row) throw new ProjectRoomError('project_missing', 'This project is not in the workspace.', 404);
    return this.snapshot(row, lease, page);
  }
  list(): ProjectSummary[] {
    return (this.db.prepare('SELECT id,code,document,updated_at,saved_version FROM projects ORDER BY updated_at DESC,id').all() as unknown as Pick<Row, 'id' | 'code' | 'document' | 'updated_at' | 'saved_version'>[])
      .map(row => { const project = JSON.parse(row.document); return { id: row.id, code: row.code, name: project.name, updatedAt: row.updated_at, savedVersion: row.saved_version, scenes: project.scenes.length, objects: project.scenes.reduce((sum: number, scene: { objects: unknown[] }) => sum + scene.objects.length, 0), cover: this.coverInfo(row.id) }; });
  }
  private coverInfo(id: string): ProjectCover | null {
    const info = this.db.prepare('SELECT saved_version AS savedVersion,updated_at AS updatedAt,length(data)>0 AS hasImage FROM project_covers WHERE project_id=?').get(id);
    return info ? { savedVersion: Number(info.savedVersion), updatedAt: Number(info.updatedAt), hasImage: Boolean(info.hasImage) } : null;
  }
  private coverAttachment(row: Row): CoverAttachment | undefined {
    const cover = this.db.prepare('SELECT saved_version,data FROM project_covers WHERE project_id=?').get(row.id);
    return cover ? { data: cover.data as Uint8Array, current: cover.saved_version === row.saved_version } : undefined;
  }
  private writeCover(id: string, version: number, data: Uint8Array): ProjectCover {
    try { validateCover(data); } catch (error) { throw new ProjectRoomError('invalid_cover', (error as Error).message, 400); }
    const updatedAt = Math.max(this.now(), (this.coverInfo(id)?.updatedAt ?? 0) + 1);
    this.db.prepare('INSERT INTO project_covers VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET saved_version=excluded.saved_version,updated_at=excluded.updated_at,data=excluded.data').run(id, version, updatedAt, data);
    return { savedVersion: version, updatedAt, hasImage: data.length > 0 };
  }
  readCover(code: string): { cover: ProjectCover; data: Uint8Array } {
    return this.transaction(() => {
      const row = this.row(code), cover = this.coverInfo(row.id);
      if (!cover) throw new ProjectRoomError('cover_missing', 'This project does not have a cover yet.', 404);
      return { cover, data: this.db.prepare('SELECT data FROM project_covers WHERE project_id=?').get(row.id)!.data as Uint8Array };
    });
  }
  saveCover(code: string, lease: string, version: number, data: Uint8Array, page?: string): { cover: ProjectCover; contentVersion: number } {
    return this.transaction(() => {
      const row = this.row(code); this.requireEditor(row, lease, page);
      if (row.saved_version !== version) throw new ProjectRoomError('cover_stale', 'The project changed while its cover was being captured.');
      const previous = this.coverInfo(row.id);
      if (previous?.savedVersion === version) return { cover: previous, contentVersion: row.content_version };
      const cover = this.writeCover(row.id, version, data);
      this.db.prepare('UPDATE projects SET content_version=content_version+1 WHERE id=?').run(row.id);
      return { cover, contentVersion: row.content_version + 1 };
    });
  }
  private handoffs(projectId: string): HandoffReceipt[] {
    return this.db.prepare('SELECT id,token,scene_id AS sceneId,shot_id AS shotId,name,created_at AS createdAt,revoked_at AS revokedAt FROM handoffs WHERE project_id=? ORDER BY created_at DESC,rowid DESC').all(projectId) as unknown as HandoffReceipt[];
  }
  publishHandoff(code: string, lease: string, id: string, manifest: VideoManifest, archive: Uint8Array, page?: string): HandoffReceipt {
    return this.transaction(() => {
      const row = this.row(code); this.requireEditor(row, lease, page);
      const existing = this.db.prepare('SELECT project_id,archive FROM handoffs WHERE id=?').get(id) as { project_id: string; archive: Uint8Array } | undefined;
      if (existing) {
        if (existing.project_id !== row.id || !Buffer.from(existing.archive).equals(archive)) throw new ProjectRoomError('share_conflict', 'This publication already contains a different snapshot. Create a new link.');
        return this.handoffs(row.id).find(value => value.id === id)!;
      }
      const project = JSON.parse(row.document), scene = project.scenes.find((value: { id: string }) => value.id === manifest.sceneId);
      if (!scene?.shots.some((value: { id: string }) => value.id === manifest.shot.id)) throw new ProjectRoomError('shot_missing', 'Save this shot in the project before publishing its references.', 400);
      const receipt: HandoffReceipt = { id, token: randomBytes(32).toString('base64url'), sceneId: manifest.sceneId, shotId: manifest.shot.id, name: manifest.shot.name, createdAt: this.now(), revokedAt: null };
      this.db.prepare('INSERT INTO handoffs VALUES(?,?,?,?,?,?,?,?,?)').run(id, row.id, receipt.token, receipt.sceneId, receipt.shotId, receipt.name, receipt.createdAt, null, archive);
      return receipt;
    });
  }
  revokeHandoff(code: string, lease: string, id: string, page?: string): void {
    this.transaction(() => {
      const row = this.row(code); this.requireEditor(row, lease, page);
      this.db.prepare('UPDATE handoffs SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND project_id=?').run(this.now(), id, row.id);
    });
  }
  readHandoff(token: string): { archive: Uint8Array; createdAt: number } {
    const row = this.db.prepare('SELECT archive,created_at,revoked_at FROM handoffs WHERE token=?').get(token) as { archive: Uint8Array; created_at: number; revoked_at: number | null } | undefined;
    if (!row) throw new ProjectRoomError('share_missing', 'This reference link could not be found.', 404);
    if (row.revoked_at !== null) throw new ProjectRoomError('share_revoked', 'This reference link was withdrawn by its creator.', 410);
    return { archive: row.archive, createdAt: row.created_at };
  }
  claim(code: string, lease: string, page?: string): ProjectRoom {
    return this.transaction(() => {
      const row = this.row(code);
      this.renewSession(row.id, lease, page);
      return this.get(code, lease, page);
    });
  }
  heartbeat(code: string, lease: string, page?: string): ProjectRoom {
    return this.transaction(() => {
      const row = this.row(code); this.requireEditor(row, lease, page);
      this.renewSession(row.id, lease, page);
      return this.get(code, lease, page);
    });
  }
  release(code: string, lease: string, page?: string): ProjectRoom {
    return this.transaction(() => {
      const row = this.row(code);
      this.db.prepare('DELETE FROM project_sessions WHERE project_id=? AND token=? AND page=?').run(row.id, lease, page ?? '');
      return this.get(code, lease, page);
    });
  }
  save(code: string, lease: string, version: number, value: unknown, page?: string): ProjectRoom {
    const document = this.document(value);
    return this.transaction(() => {
      const row = this.row(code); this.requireEditor(row, lease, page);
      // A lost response may be retried after the write already committed.
      if (row.document === document) return this.snapshot(row, lease, page);
      if (row.saved_version !== version) throw new ProjectRoomError('save_conflict', 'A newer project is already saved. Your changes have not replaced it.');
      this.db.prepare('UPDATE projects SET document=?,saved_version=saved_version+1,content_version=content_version+1,updated_at=? WHERE id=?')
        .run(document, this.now(), row.id);
      this.replaceWriters(row.id, lease, page, row.saved_version + 1);
      this.renewSession(row.id, lease, page);
      if (this.coverInfo(row.id)?.savedVersion === row.saved_version && coverVisual(JSON.parse(row.document)) === coverVisual(JSON.parse(document)))
        this.db.prepare('UPDATE project_covers SET saved_version=? WHERE project_id=?').run(row.saved_version + 1, row.id);
      return this.get(code, lease, page);
    });
  }
  edit(code: string, lease: string, id: string, changes: Change[], revision: number, page?: string): ProjectRoom {
    return this.transaction(() => {
      const row = this.row(code); this.requireEditor(row, lease, page);
      const receipt = this.db.prepare('SELECT token,page FROM project_edits WHERE project_id=? AND id=?').get(row.id, id);
      if (receipt) {
        if (receipt.token !== lease || receipt.page !== (page ?? '')) throw new ProjectRoomError('edit_identity', 'This edit belongs to another page.');
        return this.snapshot(row, lease, page); // A retried request must not overwrite a later user's edit.
      }
      const before = JSON.parse(row.document);
      const writers = (changes.some(change => change.own) ? this.db.prepare('SELECT path,token,page,version FROM project_property_writers WHERE project_id=?').all(row.id) : [])
        .map(item => ({ token: String(item.token), page: String(item.page), parts: JSON.parse(String(item.path)) as Change['path'], version: Number(item.version) }));
      const prefix = (a: Change['path'], b: Change['path']) => a.length <= b.length && a.every((part, i) => sameValue(part, b[i]));
      const writerPath = (change: Change): Change['path'] => change.order ? [...change.path, '$order'] : change.path;
      changes = changes.filter(change => {
        if (!change.own) return true;
        const target = writerPath(change);
        const ancestor = writers.filter(writer => prefix(writer.parts, target)).sort((a, b) => b.version - a.version || b.parts.length - a.parts.length)[0];
        return !!ancestor && ancestor.token === lease && ancestor.page === (page ?? '') && !writers.some(writer =>
          prefix(target, writer.parts) && writer.version > ancestor.version && (writer.token !== lease || writer.page !== (page ?? '')));
      });
      for (const change of changes) {
        if (!['name', 'scenes', 'assets', 'scripts', 'conversations', 'lookSettings'].includes(String(change.path[0])))
          throw new ProjectRoomError('invalid_edit', 'This project property cannot be shared.', 400);
        const last = change.path.at(-1), existing = valueAt(before, change.path);
        if (typeof last === 'object' && last.key === 'id' && change.before === undefined && change.after !== undefined && existing !== undefined && !change.guard && !sameValue(existing, change.after))
          throw new ProjectRoomError('edit_conflict', 'An item with this ID was created in another page. Your edit is kept here; save a copy to retain it.');
      }
      const build = () => {
        const next = projectView(applyChanges(before, changes));
        next.revision = Math.max(before.revision, revision, before.revision + Number(!sameValue(projectContent(before), projectContent(next))));
        return { next, document: this.document(next) };
      };
      let result: ReturnType<typeof build>;
      try { result = build(); }
      catch {
        // An undo whose dependencies were removed remotely is a no-op, not a broken scene.
        if (changes.some(change => change.own)) changes = changes.filter(change => !change.own);
        try { result = build(); }
        catch { throw new ProjectRoomError('edit_conflict', 'This edit conflicts with a scene structure changed in another page. Your changes are kept here; save a copy to retain them.'); }
      }
      const { next, document } = result;
      const written = changesBetween(before, JSON.parse(document));
      // Equal values can still be the other user's later write (including an A → B → A sequence).
      written.push(...changes.filter(change => !change.guard && !change.order && change.after !== undefined && sameValue(valueAt(next, change.path), change.after)));
      if (document !== row.document || written.length) {
        this.db.prepare('UPDATE projects SET document=?,saved_version=saved_version+1,content_version=content_version+1,updated_at=? WHERE id=?').run(document, this.now(), row.id);
        if (this.coverInfo(row.id)?.savedVersion === row.saved_version && coverVisual(before) === coverVisual(next))
          this.db.prepare('UPDATE project_covers SET saved_version=? WHERE project_id=?').run(row.saved_version + 1, row.id);
        const write = this.db.prepare('INSERT INTO project_property_writers VALUES(?,?,?,?,?) ON CONFLICT(project_id,path) DO UPDATE SET token=excluded.token,page=excluded.page,version=excluded.version');
        for (const change of written) write.run(row.id, JSON.stringify(writerPath(change)), lease, page ?? '', row.saved_version + 1);
      }
      this.db.prepare('INSERT INTO project_edits VALUES(?,?,?,?)').run(row.id, id, lease, page ?? '');
      this.renewSession(row.id, lease, page);
      return this.get(code, lease, page);
    });
  }
  private replaceWriters(id: string, lease: string, page: string | undefined, version: number) {
    this.db.prepare('DELETE FROM project_property_writers WHERE project_id=?').run(id);
    this.db.prepare('INSERT INTO project_property_writers VALUES(?,?,?,?,?)').run(id, '[]', lease, page ?? '', version);
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
  saveOutput(code: string, lease: string, output: Omit<ProjectOutput, 'updatedAt'>, data: Uint8Array, page?: string, expectedUpdatedAt = 0): ProjectOutput {
    if (data.byteLength > MAX_OUTPUT_BYTES) throw new ProjectRoomError('output_too_large', 'This result is larger than 64 MB.', 413);
    return this.transaction(() => {
      const row = this.row(code); this.requireEditor(row, lease, page);
      const previous = this.outputs(row.id).find(item => item.id === output.id);
      if (previous && Object.entries(output).every(([key, value]) => previous[key as keyof ProjectOutput] === value)
        && Buffer.from(this.db.prepare('SELECT data FROM outputs WHERE project_id=? AND id=?').get(row.id, output.id)!.data as Uint8Array).equals(data)) return previous;
      if ((previous?.updatedAt ?? 0) !== expectedUpdatedAt) throw new ProjectRoomError('output_conflict', 'A newer result is saved. Download your changes or save a new project to keep both versions.');
      const updatedAt = Math.max(this.now(), (previous?.updatedAt ?? 0) + 1);
      this.db.prepare(`INSERT INTO outputs VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET
        kind=excluded.kind,scene_id=excluded.scene_id,shot_id=excluded.shot_id,name=excluded.name,mime=excluded.mime,updated_at=excluded.updated_at,data=excluded.data`)
        .run(row.id, output.id, output.kind, output.sceneId, output.shotId, output.name, output.mime, updatedAt, data);
      this.db.prepare('UPDATE projects SET content_version=content_version+1,updated_at=? WHERE id=?').run(updatedAt, row.id);
      return { ...output, updatedAt };
    });
  }
  bundle(id: string): ProjectBundle {
    return this.transaction(() => {
      const room = this.getById(id);
      return { id: room.id, version: room.contentVersion, project: room.project, cover: this.coverAttachment(this.row(room.code)),
        outputs: room.outputs.map(output => ({ output, data: this.db.prepare('SELECT data FROM outputs WHERE project_id=? AND id=?').get(id, output.id)!.data as Uint8Array })) };
    });
  }
  private replaceBundle(row: Row, bundle: ProjectBundle) {
    const document = this.document(bundle.project);
    for (const item of bundle.outputs) if (item.data.byteLength > MAX_OUTPUT_BYTES) throw new ProjectRoomError('output_too_large', 'This result is larger than 64 MB.', 413);
    this.db.prepare('UPDATE projects SET document=?,saved_version=saved_version+1,content_version=content_version+1,updated_at=? WHERE id=?').run(document, this.now(), row.id);
    this.replaceWriters(row.id, '', undefined, row.saved_version + 1);
    this.db.prepare('DELETE FROM outputs WHERE project_id=?').run(row.id);
    for (const { output, data } of bundle.outputs) this.db.prepare('INSERT INTO outputs VALUES(?,?,?,?,?,?,?,?,?)').run(row.id, output.id, output.kind, output.sceneId, output.shotId, output.name, output.mime, output.updatedAt, data);
    if (bundle.cover) this.writeCover(row.id, bundle.cover.current ? row.saved_version + 1 : 0, bundle.cover.data);
    else this.db.prepare('DELETE FROM project_covers WHERE project_id=?').run(row.id);
  }
  private sameBundle(row: Row, bundle: ProjectBundle) {
    if (row.document !== this.document(bundle.project)) return false;
    const cover = this.coverAttachment(row);
    if (Boolean(cover) !== Boolean(bundle.cover) || (cover && bundle.cover && (cover.current !== bundle.cover.current || !Buffer.from(cover.data).equals(bundle.cover.data)))) return false;
    const outputs = this.outputs(row.id); if (outputs.length !== bundle.outputs.length) return false;
    return bundle.outputs.every(item => {
      const saved = outputs.find(output => output.id === item.output.id);
      return saved && Object.keys(item.output).every(key => saved[key as keyof ProjectOutput] === item.output[key as keyof ProjectOutput])
        && Buffer.from(this.db.prepare('SELECT data FROM outputs WHERE project_id=? AND id=?').get(row.id, item.output.id)!.data as Uint8Array).equals(item.data);
    });
  }
  /** A manual upload is atomic and cannot replace an unknown/newer cloud version. */
  publish(bundle: ProjectBundle, lease: string, page?: string, expectedVersion?: number): ProjectRoom {
    if (!bundle.id) throw new ProjectRoomError('identity_required', 'This project needs a permanent ID.', 400);
    return this.transaction(() => {
      let row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(bundle.id!) as unknown as Row | undefined;
      if (row && this.sameBundle(row, bundle)) return this.snapshot(row, lease, page);
      if (row) {
        if (expectedVersion !== row.content_version) throw new ProjectRoomError('cloud_conflict', 'The cloud project has changed. Your local work is safe; open the cloud version or upload a duplicate.');
      } else {
        if (expectedVersion !== undefined) throw new ProjectRoomError('cloud_missing', 'The original cloud project is unavailable. Your local project is retained.', 404);
        let code = roomCode(); while (this.db.prepare('SELECT 1 FROM projects WHERE code=?').get(code)) code = roomCode();
        this.db.prepare('INSERT INTO projects(id,code,document,saved_version,updated_at,creator_token,content_version) VALUES(?,?,?,?,?,?,?)').run(bundle.id!, code, this.document(bundle.project), 0, this.now(), lease, 0);
        row = this.row(code);
      }
      this.replaceBundle(row, bundle); return this.get(row.code, lease, page);
    });
  }
  openCloud(bundle: ProjectBundle, origin: string, lease: string, page?: string, keepLocal = false): ProjectRoom {
    if (!bundle.id || !bundle.version) throw new ProjectRoomError('identity_required', 'The cloud project has no versioned identity.', 400);
    return this.transaction(() => {
      let row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(bundle.id!) as unknown as Row | undefined;
      if (row) {
        const changed = row.cloud_local_version === null || row.content_version !== row.cloud_local_version;
        const conflict = changed && !this.sameBundle(row, bundle) && (row.cloud_origin !== origin || row.cloud_version !== bundle.version);
        if (conflict && !keepLocal) throw new ProjectRoomError('local_conflict', 'This device and the cloud both have changes. Keep a local copy before opening the cloud version.');
        if (conflict) {
          const copy = JSON.parse(row.document); copy.name = copy.name.slice(0, 100) + ' local copy';
          const id = randomUUID(); let code = roomCode(); while (this.db.prepare('SELECT 1 FROM projects WHERE code=?').get(code)) code = roomCode();
          this.db.prepare('INSERT INTO projects(id,code,document,saved_version,updated_at,creator_token) VALUES(?,?,?,?,?,?)').run(id, code, this.document(copy), 1, this.now(), lease);
          this.db.prepare('INSERT INTO outputs SELECT ?,id,kind,scene_id,shot_id,name,mime,updated_at,data FROM outputs WHERE project_id=?').run(id, row.id);
          const cover = this.coverAttachment(row); if (cover) this.writeCover(id, cover.current ? 1 : 0, cover.data);
        }
        if ((!changed || conflict) && !this.sameBundle(row, bundle)) this.replaceBundle(row, bundle);
      } else {
        let code = roomCode(); while (this.db.prepare('SELECT 1 FROM projects WHERE code=?').get(code)) code = roomCode();
        this.db.prepare('INSERT INTO projects(id,code,document,saved_version,updated_at,creator_token,content_version) VALUES(?,?,?,?,?,?,?)').run(bundle.id!, code, this.document(bundle.project), 0, this.now(), lease, 0);
        row = this.row(code); this.replaceBundle(row, bundle);
      }
      const current = this.row(row.code);
      const localVersion = this.sameBundle(current, bundle) ? current.content_version : current.cloud_local_version;
      this.db.prepare('UPDATE projects SET cloud_origin=?,cloud_version=?,cloud_local_version=? WHERE id=?')
        .run(origin, bundle.version!, localVersion, row.id);
      this.renewSession(row.id, lease, page);
      return this.get(row.code, lease, page);
    });
  }
  linkCloud(id: string, origin: string, version: number, localVersion: number, lease: string, page?: string): ProjectRoom {
    return this.transaction(() => {
      const room = this.getById(id, lease, page), row = this.row(room.code); this.requireEditor(row, lease, page);
      this.db.prepare('UPDATE projects SET cloud_origin=?,cloud_version=?,cloud_local_version=? WHERE id=?').run(origin, version, localVersion, id);
      return this.get(room.code, lease, page);
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
  /** Browser data is moved here once before its old browser copies are retired. */
  saveBrowserRecovery(id: string, data: Uint8Array) {
    const directory = path.join(this.directory, 'browser-recovery'); mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, id + '.zip');
    if (existsSync(filename)) {
      if (!readFileSync(filename).equals(data)) throw new ProjectRoomError('recovery_conflict', 'This recovery backup contains different data. The browser data was retained.');
      return;
    }
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try { writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 }); renameSync(temporary, filename); }
    catch (error) { if (existsSync(temporary)) unlinkSync(temporary); throw error; }
  }
  browserRecovery(id: string) {
    const filename = path.join(this.directory, 'browser-recovery', id + '.zip');
    if (!existsSync(filename)) throw new ProjectRoomError('recovery_missing', 'This browser recovery backup could not be found.', 404);
    return readFileSync(filename);
  }
  /** Uses SQLite's online snapshot API, including committed WAL contents. */
  async backupTo(filename: string) { await backup(this.db, filename); }
  close() { this.db.close(); }
}
