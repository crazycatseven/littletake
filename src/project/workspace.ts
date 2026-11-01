import { newId } from "../id.ts";
import './workspace.css';
import { createProject, parseProject, serializeProject, PROJECT_STORAGE_KEY, type ProjectDocument } from './storage';
import { EDIT_HEARTBEAT_MS, type ProjectRoom, type ProjectOutput } from './room';
import { projectCache } from './cache';
import { projectRequestContext } from './client';
import { projectArchive } from './archive';
import { referenceWorkspace } from '../reference/store';
import { copyText } from '../clipboard';

interface RecentProject { code: string; name: string; updatedAt: number; scenes: number; objects: number }
interface WorkspaceOptions {
  project(): ProjectDocument;
  open(project: ProjectDocument): void;
  stop(): void;
  state(message: string, readOnly: boolean, problem: boolean): void;
  beforeSwitch(): boolean;
  result?(output: ProjectOutput, data: Blob): void;
  recoverBrowserSave?(): void;
}
const RECENTS = 'littletake.projects.recent.v1', MIGRATED = 'littletake.projects.migrated.v1';
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export class Workspace {
  room: ProjectRoom | null = null;
  lease: string;
  private readonly page = newId();
  private readonly home = document.createElement('dialog');
  private readonly share = document.createElement('dialog');
  private pending: ProjectDocument | null = null;
  private saving: Promise<void> | null = null;
  private failed = false;
  private conflict = false;
  private refreshing = false;
  private lastHeartbeat = 0;
  private timer: ReturnType<typeof setInterval>;
  private readonly sessionReady: Promise<void>;
  private creation: { id: string; project: ProjectDocument; sourceCode?: string } | null = null;
  private savedText: string | null = null;
  constructor(private readonly options: WorkspaceOptions) {
    this.lease = sessionStorage.getItem('littletake.edit-session') ?? newId();
    sessionStorage.setItem('littletake.edit-session', this.lease);
    const channel = new BroadcastChannel('littletake-editor-sessions'), page = this.page; let sharedLease = false;
    channel.onmessage = event => {
      const value = event.data;
      if (value?.lease !== this.lease || value.page === page) return;
      if (value.type === 'check') channel.postMessage({ type: 'occupied', lease: this.lease, page });
      if (value.type === 'occupied') sharedLease = true;
    };
    this.sessionReady = new Promise(resolve => { channel.postMessage({ type: 'check', lease: this.lease, page }); setTimeout(() => { if (sharedLease) { this.lease = newId(); sessionStorage.setItem('littletake.edit-session', this.lease); } resolve(); }, 100); });
    this.home.className = 'projects-dialog'; this.home.setAttribute('aria-label', 'Projects');
    this.share.className = 'project-share-dialog'; this.share.setAttribute('aria-label', 'Share project');
    document.body.append(this.home, this.share);
    this.home.addEventListener('cancel', event => { if (!this.room) event.preventDefault(); });
    this.home.addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLElement>('[data-project-action]'); if (button) void this.action(button.dataset.projectAction!, button.dataset.code); });
    this.home.addEventListener('submit', event => { event.preventDefault(); const form = event.target as HTMLFormElement; void this.submit(form); });
    this.timer = setInterval(() => void this.refresh(), 5000);
    window.addEventListener('online', () => void this.retry());
    window.addEventListener('pagehide', () => { this.options.stop(); channel.close(); if (this.room?.editing === 'you') void this.api({ action: 'release' }, this.room.code, true).catch(() => {}); });
  }
  get canEdit() { return this.room?.editing === 'you' && !this.conflict; }
  get hasUnsaved() { return Boolean(this.pending || this.failed || this.saving); }
  private async api(body?: unknown, code?: string, keepalive = false): Promise<ProjectRoom> {
    const response = await fetch('/api/projects' + (code ? '?code=' + encodeURIComponent(code) : ''), {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', keepalive,
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.error?.message ?? 'The local project service is unavailable. Your changes are kept on this device.'), { code: value.error?.code ?? 'unavailable' });
    return value;
  }
  private recents(): RecentProject[] { try { const value = JSON.parse(localStorage.getItem(RECENTS) ?? '[]'); return Array.isArray(value) ? value.filter(item => typeof item.code === 'string' && typeof item.name === 'string' && Number.isFinite(item.updatedAt)) : []; } catch { return []; } }
  private remember(room: ProjectRoom) {
    const value = { code: room.code, name: room.project.name, updatedAt: room.updatedAt, scenes: room.project.scenes.length, objects: room.project.scenes.reduce((n, scene) => n + scene.objects.length, 0) };
    try { localStorage.setItem(RECENTS, JSON.stringify([value, ...this.recents().filter(item => item.code !== room.code)].slice(0, 100))); } catch { /* A full recent-project index must not stop a durable server save. */ }
  }
  async start(legacy: ProjectDocument | null, legacyError = '') {
    await this.sessionReady;
    const code = new URL(location.href).searchParams.get('project');
    try {
      const pending = await projectCache.draft('create', this.lease);
      if (pending?.dirty && pending.creation) { this.creation = { ...pending.creation, project: pending.project }; await this.create(pending.project, pending.creation.sourceCode); if (legacy && serializeProject(legacy) === serializeProject(pending.project)) localStorage.setItem(MIGRATED, '1'); return; }
      if (code) { await this.join(code); return; }
      if (legacyError) { this.showHome(); this.error(legacyError); this.home.querySelector('.projects-error')!.insertAdjacentHTML('afterend', '<button data-project-action="recover-browser">Download previous browser save</button>'); return; }
      if (legacy && !localStorage.getItem(MIGRATED)) { await this.create(legacy); localStorage.setItem(MIGRATED, '1'); return; }
      this.showHome();
    } catch (error) { this.showHome(); this.error((error as Error).message); }
  }
  private notify() {
    const readOnly = !this.canEdit;
    const text = this.conflict ? 'Save conflict · your draft is kept on this device' : this.failed ? 'Offline · changes kept on this device' : readOnly ? 'Viewing · read only' : this.pending || this.saving ? 'Saving…' : 'Saved on this computer';
    this.options.state(text, readOnly, this.failed || this.conflict);
  }
  private async activate(room: ProjectRoom) {
    this.options.stop(); this.room = room; this.lastHeartbeat = Date.now(); this.failed = false; this.conflict = false;
    this.savedText = serializeProject(room.project);
    projectRequestContext({ code: room.code, lease: this.lease, page: this.page });
    const draft = await projectCache.draft(room.code, this.lease) ?? (room.editing === 'you' ? (await projectCache.drafts(room.code))[0] : undefined);
    if (draft?.dirty) {
      if (serializeProject(draft.project) === serializeProject(room.project)) { await projectCache.saveDraft({ ...draft, savedVersion: room.savedVersion, dirty: false }); }
      else if (room.editing === 'you' && draft.savedVersion === room.savedVersion) { room.project = draft.project; this.pending = draft.project; }
      else { this.conflict = true; room.project = draft.project; this.pending = draft.project; }
    }
    room.project = parseProject(serializeProject(room.project), room.editing === 'you');
    const url = new URL(location.href); url.searchParams.set('project', room.code); history.replaceState(null, '', url);
    referenceWorkspace(this);
    this.options.open(room.project); this.remember(room); this.home.close(); this.notify();
    if (this.pending && !this.conflict) void this.flush().catch(() => {});
  }
  async join(code: string) {
    if (this.room && !await this.leave()) throw new Error('Finish saving the current project before switching.');
    const clean = code.replace(/[-\s]/g, '').toUpperCase(); let room: ProjectRoom;
    try { room = await this.api({ action: 'claim' }, clean); }
    catch (error) { if ((error as { code?: string }).code !== 'editor_present') throw error; room = await this.api(undefined, clean); }
    await this.activate(room);
  }
  async create(project: ProjectDocument = createProject(null), sourceCode?: string) {
    if (!sourceCode && project.lookSettings) for (const settings of Object.values(project.lookSettings)) { settings.anchorId = null; settings.styleId = null; }
    if (this.room && !await this.leave()) throw new Error('Finish saving the current project before switching.');
    if (this.creation && serializeProject(this.creation.project) !== serializeProject(project)) throw new Error('Recover the pending project before creating another one.');
    this.creation ??= { id: newId(), project, ...(sourceCode ? { sourceCode } : {}) };
    await projectCache.saveDraft({ id: `create:${this.lease}`, code: 'create', lease: this.lease, savedVersion: 0, project, dirty: true, creation: { id: this.creation.id, ...(sourceCode ? { sourceCode } : {}) } });
    let room = await this.api({ action: 'create', id: this.creation.id, project, ...(sourceCode ? { sourceCode } : {}) });
    if (room.editing !== 'you') try { room = await this.api({ action: 'claim' }, room.code); } catch (error) { if ((error as { code?: string }).code !== 'editor_present') throw error; }
    await projectCache.saveDraft({ id: `create:${this.lease}`, code: 'create', lease: this.lease, savedVersion: 0, project, dirty: false }); this.creation = null;
    await this.activate(room);
  }
  save(project: ProjectDocument) {
    if (!this.room || !this.canEdit) return;
    if (!this.pending && serializeProject(project) === this.savedText) return;
    this.pending = structuredClone(project);
    void projectCache.saveDraft({ id: `${this.room.code}:${this.lease}`, code: this.room.code, lease: this.lease, savedVersion: this.room.savedVersion, project: this.pending, dirty: true }).catch(() => {});
    this.notify();
    void this.flush().catch(() => {});
  }
  async flush(): Promise<void> {
    if (this.saving) return this.saving;
    if (!this.pending || !this.room || !this.canEdit) return;
    const room = this.room;
    this.saving = (async () => {
      while (this.pending && this.room === room && this.canEdit) {
        const project = this.pending;
        try { await projectCache.saveDraft({ id: `${room.code}:${this.lease}`, code: room.code, lease: this.lease, savedVersion: room.savedVersion, project, dirty: true }); } catch { /* The server can still save when the browser cache is full. */ }
        try {
          const saved = await this.api({ action: 'save', savedVersion: room.savedVersion, project }, room.code);
          this.savedText = serializeProject(project);
          room.savedVersion = saved.savedVersion; room.updatedAt = saved.updatedAt; room.leaseExpiresAt = saved.leaseExpiresAt;
          if (this.pending === project) this.pending = null;
          this.failed = false; this.remember({ ...room, project });
          if (!this.pending) await projectCache.saveDraft({ id: `${room.code}:${this.lease}`, code: room.code, lease: this.lease, savedVersion: room.savedVersion, project, dirty: false }).catch(() => {});
        } catch (error) {
          this.failed = true;
          if (['save_conflict', 'edit_lease_lost', 'editor_present'].includes((error as { code?: string }).code ?? '')) { this.conflict = true; this.options.stop(); }
          throw error;
        }
      }
    })().finally(() => { this.saving = null; this.notify(); });
    this.notify(); return this.saving;
  }
  async retry() {
    if (!this.room) return;
    try { if (this.conflict) { const next = await this.api(undefined, this.room.code); if (next.savedVersion !== this.room.savedVersion) throw new Error('A newer version is saved. Download your changes or save a new project.'); Object.assign(this.room, await this.api({ action: 'claim' }, this.room.code)); this.conflict = false; } await this.flush(); for (const cached of await projectCache.outputs(this.room.code)) if (cached.pending) { const { updatedAt: _at, ...metadata } = cached.output; await this.putOutput(metadata, cached.data); } this.failed = false; this.notify(); }
    catch (error) { this.failed = true; this.notify(); this.error((error as Error).message); }
  }
  private async refresh() {
    if (!this.room || this.refreshing || this.home.open) return; this.refreshing = true; const room = this.room;
    try {
      if (this.canEdit) {
        if (this.failed) { await this.retry(); return; }
        if (Date.now() - this.lastHeartbeat >= EDIT_HEARTBEAT_MS) { const next = await this.api({ action: 'heartbeat' }, room.code); room.leaseExpiresAt = next.leaseExpiresAt; this.lastHeartbeat = Date.now(); }
        if (this.pending && this.failed) await this.flush();
      } else if (!this.conflict) {
        const next = await this.api(undefined, room.code);
        if (this.room !== room) return;
        if (next.savedVersion !== room.savedVersion) { this.room = next; this.options.open(next.project); }
        else Object.assign(room, { editing: next.editing, outputs: next.outputs });
      }
      this.failed = false;
    } catch (error) { if (this.room === room) { this.failed = true; if ((error as { code?: string }).code === 'edit_lease_lost') { this.conflict = true; this.options.stop(); } } }
    finally { this.refreshing = false; this.notify(); }
  }
  private async leave(): Promise<boolean> {
    if (!this.options.beforeSwitch()) return false;
    this.options.stop();
    if (this.conflict && this.pending) { this.options.state('Keep your changes by downloading them or saving a new project before switching.', true, true); return false; }
    try { await this.flush(); }
    catch { this.options.state('Save failed. Retry or download your changes before switching projects.', false, true); return false; }
    if (this.room?.editing === 'you') try { await this.api({ action: 'release' }, this.room.code); } catch { /* The saved document is already durable; a disconnected lease expires. */ }
    this.room = null; this.pending = null; projectRequestContext(null); return true;
  }
  async showProjects() {
    if (this.room && !await this.leave()) return;
    const url = new URL(location.href); url.searchParams.delete('project'); history.replaceState(null, '', url); this.showHome();
  }
  async newProject() { await this.showProjects(); if (this.home.open) await this.action('new'); }
  private showHome() {
    this.home.innerHTML = `<header class="projects-heading"><a class="brand" href="/">LittleTake</a><span>LOCAL WORKSPACE</span></header>
      <div class="projects-welcome"><div><small>YOUR FILM STARTS HERE</small><h1>A place for every little take.</h1><p>Build a set, shape the action, and keep your projects on this computer.</p></div><button class="primary-button" data-project-action="new">＋ New project</button></div>
      <div class="projects-toolbar"><h2>Recent projects <span>${this.recents().length}</span></h2><div><button data-project-action="import">Import project</button><button data-project-action="join">Join with a code</button></div></div>
      <section class="project-cards">${this.recents().map(item => `<article><button class="project-card-open" data-project-action="open" data-code="${escape(item.code)}"><div class="project-card-art"><span>▱</span><small>${item.scenes} SCENES · ${item.objects} OBJECTS</small></div><h3>${escape(item.name)}</h3><p>Saved ${new Date(item.updatedAt).toLocaleDateString()} · ${escape(this.formatCode(item.code))}</p></button><button class="project-copy-button" data-project-action="copy" data-code="${escape(item.code)}">Duplicate</button></article>`).join('') || '<div class="projects-empty"><span>◇</span><h3>Your next scene starts here</h3><p>Create a project or import an existing LittleTake save.</p><button data-project-action="new">Create your first project</button></div>'}</section>
      ${this.creation ? '<button data-project-action="recover">Recover pending project</button>' : ''}<p class="projects-error" role="alert" hidden></p><footer>Projects, assets and conversations are saved by this local LittleTake server.</footer>`;
    if (!this.home.open) this.home.showModal();
  }
  private error(message: string) { const element = this.home.querySelector<HTMLElement>('.projects-error'); if (element) { element.textContent = message; element.hidden = false; } }
  private async action(action: string, code?: string) {
    try {
      if (action === 'open' && code) await this.join(code);
      if (action === 'recover' && this.creation) await this.create(this.creation.project, this.creation.sourceCode);
      if (action === 'recover-browser') this.options.recoverBrowserSave?.();
      if (action === 'copy' && code) { const source = await this.api(undefined, code); const project = parseProject(serializeProject(source.project)); project.name = `${project.name.slice(0, 110)} copy`; await this.create(project, code); }
      if (action === 'new' || action === 'join') {
        this.home.querySelector('.projects-welcome')!.innerHTML = action === 'new' ? `<form data-create><small>NEW PROJECT</small><h1>Make room for an idea.</h1><label>Project name<input name="name" maxlength="120" value="Untitled project" required autofocus></label><label class="project-starter"><input name="starter" type="checkbox"> Include a starter scene</label><div><button type="button" data-project-action="back">Back</button><button class="primary-button">Create project</button></div></form>` : `<form data-join><small>JOIN A PROJECT</small><h1>Enter the project code.</h1><p>One person edits at a time. Everyone else can view the scene.</p><label>Project code<input name="code" placeholder="ABCD-EFGH-JKLM" maxlength="32" required autofocus></label><div><button type="button" data-project-action="back">Back</button><button class="primary-button">Join project</button></div></form>`;
        this.home.querySelector<HTMLInputElement>('form input')?.focus();
      }
      if (action === 'back') this.showHome();
      if (action === 'import') document.querySelector<HTMLInputElement>('#openFile')?.click();
    } catch (error) { this.error((error as Error).message); }
  }
  private async submit(form: HTMLFormElement) {
    const button = form.querySelector<HTMLButtonElement>('.primary-button')!; button.disabled = true;
    try { const data = new FormData(form); if (form.hasAttribute('data-join')) await this.join(String(data.get('code'))); else { const project = createProject(data.has('starter') ? undefined : null); project.name = String(data.get('name')).trim(); await this.create(project); } }
    catch (error) { this.error((error as Error).message); } finally { button.disabled = false; }
  }
  reportError(message: string) { if (!this.room && !this.home.open) this.showHome(); if (this.home.open) this.error(message); else this.options.state(message, !this.canEdit, true); }
  private formatCode(code: string) { return code.match(/.{1,4}/g)?.join('-') ?? code; }
  showShare() {
    if (!this.room) return; const room = this.room;
    this.share.innerHTML = `<header><h2>${this.canEdit ? 'Share your project' : 'Viewing this project'}</h2><button data-close aria-label="Close share">✕</button></header><p>One editor, a shared view of the whole set.</p><small>PROJECT CODE</small><strong>${this.formatCode(room.code)}</strong><label>Project link<input readonly value="${escape(location.href)}"></label><p data-share-status>${this.canEdit ? 'You are editing. Others join as viewers.' : room.editing === 'available' ? 'The editing seat is available.' : 'Someone else is editing. Your view follows saved changes.'}</p><div><button data-copy>Copy link</button><button class="primary-button" data-seat>${this.canEdit ? 'Release editing' : 'Start editing'}</button></div>`;
    this.share.querySelector<HTMLButtonElement>('[data-seat]')!.disabled = !this.canEdit && room.editing !== 'available';
    this.share.querySelector('[data-close]')!.addEventListener('click', () => this.share.close());
    this.share.querySelector('[data-copy]')!.addEventListener('click', async () => { try { await copyText(location.href, this.share); this.share.querySelector('[data-share-status]')!.textContent = 'Link copied'; } catch { this.share.querySelector('input')!.select(); } });
    this.share.querySelector('[data-seat]')!.addEventListener('click', async () => {
      try { this.options.stop(); await this.flush(); const next = await this.api({ action: this.canEdit ? 'release' : 'claim' }, room.code); this.share.close(); await this.activate(next); }
      catch (error) { this.share.querySelector('[data-share-status]')!.textContent = (error as Error).message; }
    });
    this.share.showModal();
  }
  async putOutput(output: Omit<ProjectOutput, 'updatedAt'>, data: Blob, target = this.room): Promise<ProjectOutput> {
    if (!target || (target === this.room && !this.canEdit)) throw new Error('Start editing before saving a result.');
    const room = target, stored = { ...output, updatedAt: Date.now() };
    await projectCache.saveOutput({ id: `${room.code}:${output.id}`, code: room.code, output: stored, data, pending: true });
    room.outputs = [stored, ...room.outputs.filter(item => item.id !== output.id)];
    let value: ProjectOutput;
    try { const response = await fetch(`/api/projects?code=${encodeURIComponent(room.code)}&output=1`, { method: 'POST', headers: { 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page, 'x-littletake-output': encodeURIComponent(JSON.stringify(output)) }, body: data });
      const result = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? 'The result is kept on this device but has not reached the local server.'); value = result;
    } catch (error) { if (this.room === room) { this.failed = true; this.notify(); } throw error; }
    await projectCache.saveOutput({ id: `${room.code}:${output.id}`, code: room.code, output: value, data, pending: false });
    room.outputs = [value, ...room.outputs.filter(item => item.id !== value.id)]; return value;
  }
  async output(id: string, room = this.room): Promise<Blob> {
    if (!room) throw new Error('Open a project first.'); const cached = await projectCache.output(room.code, id);
    if (cached && (cached.pending || cached.output.updatedAt >= (room.outputs.find(output => output.id === id)?.updatedAt ?? 0))) return cached.data;
    const response = await fetch(`/api/projects?code=${encodeURIComponent(room.code)}&output=${encodeURIComponent(id)}`); if (!response.ok) throw new Error('The saved result could not be opened.'); return response.blob();
  }
  lookSettings(sceneId: string) { return this.options.project().lookSettings?.[sceneId] ?? { direction: '', anchorId: null, styleId: null }; }
  setLookSettings(sceneId: string, value: Partial<NonNullable<ProjectDocument['lookSettings']>[string]>) {
    if (!this.canEdit) return;
    const project = this.options.project(); project.lookSettings ??= {}; project.lookSettings[sceneId] = { ...this.lookSettings(sceneId), ...value }; this.save(project);
  }
  async importArchive(file: Blob) {
    if (this.room && !await this.leave()) return;
    const response = await fetch('/api/projects?import=1&id=' + newId(), { method: 'POST', headers: { 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page }, body: file });
    const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? 'The archive could not be imported. Your saved projects are unchanged.'); await this.activate(value);
  }
  async download() {
    if (!this.room) return;
    const room = this.room, project = structuredClone(this.options.project());
    try { await this.flush(); } catch { /* The archive also preserves a local draft when saving is unavailable. */ }
    const metadata = new Map(room.outputs.map(output => [output.id, output]));
    for (const cached of await projectCache.outputs(room.code)) if (cached.pending) metadata.set(cached.output.id, cached.output);
    const outputs: { output: ProjectOutput; data: Uint8Array }[] = [];
    for (const output of metadata.values()) outputs.push({ output, data: new Uint8Array(await (await this.output(output.id, room)).arrayBuffer()) });
    const url = URL.createObjectURL(projectArchive({ project, outputs })), link = document.createElement('a');
    link.href = url; link.download = `${project.name.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'LittleTake'}.littletake.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async saveCopy() {
    if (!this.room) return;
    this.options.stop(); await this.saving?.catch(() => {});
    const project = parseProject(serializeProject(this.options.project())); project.name = project.name.slice(0, 110) + ' copy';
    const sourceCode = this.room.code;
    const pendingOutputs = (await projectCache.outputs(sourceCode)).filter(output => output.pending);
    const room = await this.api({ action: 'create', id: newId(), project, sourceCode });
    this.pending = null; await this.activate(room);
    for (const cached of pendingOutputs) { const { updatedAt: _at, ...metadata } = cached.output; await this.putOutput(metadata, cached.data); }
    for (const draft of await projectCache.drafts(sourceCode)) await projectCache.saveDraft({ ...draft, dirty: false });
  }
  async showResults() {
    if (!this.room) return;
    const dialog = document.createElement('dialog'); dialog.className = 'project-results-dialog'; dialog.setAttribute('aria-label', 'Project results');
    const outputs = [...this.room.outputs].filter(output => output.kind !== 'style-reference' && output.kind !== 'reference-media');
    dialog.innerHTML = `<header><div><small>PROJECT RESULTS</small><h2>${escape(this.options.project().name)}</h2></div><button data-close aria-label="Close results">✕</button></header><p>Look frames, video briefs and reference analyses are kept with this project.</p><div class="project-results-list">${outputs.map(output => `<button data-output="${output.id}"><span>${output.kind === 'look-frame' ? '▧' : output.kind === 'video-brief' ? '▤' : '◇'}</span><div><strong>${escape(output.name)}</strong><small>${escape(output.kind.replaceAll('-', ' '))} · ${new Date(output.updatedAt).toLocaleString()}</small></div><span>↗</span></button>`).join('') || '<div class="projects-empty">No results yet. Open a shot’s Look panel or analyze a reference clip to begin.</div>'}</div><div class="project-result-preview" hidden></div><p class="projects-error" hidden role="alert"></p>`;
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('click', async event => {
      const id = (event.target as HTMLElement).closest<HTMLElement>('[data-output]')?.dataset.output; if (!id) return;
      try {
        const output = outputs.find(value => value.id === id)!, data = await this.output(id);
        if (output.kind === 'reference-analysis') { dialog.close(); this.options.result?.(output, data); return; }
        const value = JSON.parse(await data.text()), preview = dialog.querySelector<HTMLElement>('.project-result-preview')!; preview.hidden = false; preview.replaceChildren();
        if (output.kind === 'look-frame') { const image = new Image(); image.src = value.image; image.alt = output.name; preview.append(image); const link = document.createElement('a'); link.href = value.image; link.download = output.name + '.png'; link.textContent = 'Download image'; preview.append(link); }
        else { const text = document.createElement('p'); text.textContent = value.brief.prompt; preview.append(text); }
      } catch (error) { const message = dialog.querySelector<HTMLElement>('.projects-error')!; message.hidden = false; message.textContent = (error as Error).message; }
    });
    document.body.append(dialog); dialog.showModal();
  }
}
