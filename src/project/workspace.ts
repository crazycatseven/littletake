import { newId } from "../id.ts";
import './workspace.css';
import { createProject, parseProject, serializeProject, type ProjectDocument } from './storage';
import { EDIT_HEARTBEAT_MS, type ProjectRoom, type ProjectOutput, type WorkspaceInfo } from './room';
import { retireBrowserProjects } from './cache';
import { projectRequestContext } from './client';
import { projectArchive, readProjectArchive } from './archive';
import { copyText } from '../clipboard';
import { handoffPath, type HandoffReceipt } from '../look/handoff';

interface RecentProject { id?: string; code: string; name: string; updatedAt: number; scenes: number; objects: number }
interface WorkspaceOptions {
  project(): ProjectDocument;
  open(project: ProjectDocument): void;
  stop(): void;
  state(message: string, readOnly: boolean, problem: boolean): void;
  beforeSwitch(): boolean;
  result?(output: ProjectOutput, data: Blob): void;
  recoverBrowserSave?(): void;
  mode?(workspace: WorkspaceInfo): void;
  notice?(message: string): void;
}
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export class Workspace {
  room: ProjectRoom | null = null;
  lease: string;
  private readonly page = newId();
  private readonly home = document.createElement('dialog');
  private readonly share = document.createElement('dialog');
  private readonly cloudDialog = document.createElement('dialog');
  private pending: ProjectDocument | null = null;
  private draftVersion: number | undefined;
  private saving: Promise<void> | null = null;
  private failed = false;
  private conflict = false;
  private refreshing = false;
  private lastHeartbeat = 0;
  private timer: ReturnType<typeof setInterval>;
  private readonly sessionReady: Promise<void>;
  private creation: { id: string; project: ProjectDocument; sourceCode?: string } | null = null;
  private savedText: string | null = null;
  private listed: RecentProject[] | null = null;
  private homeGeneration = 0;
  private workspace: WorkspaceInfo = { mode: 'local', cloudAvailable: false };
  private modeReady = false;
  private migrationError = '';
  private readonly pendingOutputs = new Map<string, { room: ProjectRoom; output: ProjectOutput; data: Blob }>();
  private readonly outputWrites = new Map<string, Promise<void>>();
  private browserRecoveryId?: string;
  private autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private firstPendingAt = 0;
  private uploading = false;
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
    this.cloudDialog.className = 'project-cloud-dialog'; this.cloudDialog.setAttribute('aria-label', 'Cloud projects');
    document.body.append(this.home, this.share, this.cloudDialog);
    this.home.addEventListener('cancel', event => { if (!this.room) event.preventDefault(); });
    this.home.addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLElement>('[data-project-action]'); if (button) void this.action(button.dataset.projectAction!, button.dataset.code); });
    this.home.addEventListener('submit', event => { event.preventDefault(); const form = event.target as HTMLFormElement; void this.submit(form); });
    this.timer = setInterval(() => void this.refresh(), 5000);
    window.addEventListener('online', () => void this.retry());
    document.addEventListener('visibilitychange', () => { if (document.hidden) void this.flush().catch(() => {}); });
    window.addEventListener('pagehide', () => { this.options.stop(); channel.close(); clearTimeout(this.autoSaveTimer); if (!this.hasUnsaved && this.room?.editing === 'you') void this.api({ action: 'release' }, this.room.code, true).catch(() => {}); });
  }
  get canEdit() { return this.room?.editing === 'you' && !this.conflict; }
  get hasUnsaved() { return Boolean(this.pending || this.failed || this.saving || this.pendingOutputs.size); }
  get hasUnsafeChanges() { return Boolean(this.pending || this.saving || this.pendingOutputs.size || this.creation); }
  get canUpload() { return this.workspace.mode === 'local' && this.workspace.cloudAvailable; }
  get isUploading() { return this.uploading; }
  private async api(body?: unknown, code?: string, keepalive = false): Promise<ProjectRoom> {
    const response = await fetch('/api/projects' + (code ? '?code=' + encodeURIComponent(code) : ''), {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', keepalive,
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.error?.message ?? 'The project service is unavailable. Keep this page open and retry saving.'), { code: value.error?.code ?? 'unavailable' });
    return value;
  }
  async start() {
    await this.sessionReady;
    try {
      const response = await fetch('/api/projects?workspace=1'); if (!response.ok) throw new Error('The workspace is unavailable. Reconnect to open your saved projects.');
      this.workspace = await response.json(); this.modeReady = true; this.options.mode?.(this.workspace);
      try { this.browserRecoveryId = await retireBrowserProjects(this.lease, this.page); }
      catch (error) { this.migrationError = (error as Error).message; }
      const code = new URL(location.href).searchParams.get('project');
      if (code) { await this.join(code); if (this.migrationError) this.reportError(this.migrationError); return; }
      this.showHome();
    } catch (error) { this.showHome(); this.error((error as Error).message); }
  }
  private notify() {
    const readOnly = !this.canEdit;
    const text = this.conflict ? 'A newer version is saved. Keep this page open; download your changes or save a copy to continue.' : this.failed ? 'Saving failed. Keep this page open; changes have not reached the workspace. Saving will retry automatically.' : this.migrationError;
    this.options.state(text, readOnly, Boolean(text));
  }
  private async activate(room: ProjectRoom) {
    this.options.stop(); clearTimeout(this.autoSaveTimer); this.pending = null; this.draftVersion = undefined; this.firstPendingAt = 0; this.room = room; this.lastHeartbeat = Date.now(); this.failed = false; this.conflict = false;
    this.savedText = serializeProject(room.project);
    projectRequestContext({ code: room.code, lease: this.lease, page: this.page }, this);
    room.project = parseProject(serializeProject(room.project), room.editing === 'you');
    const url = new URL(location.href); url.searchParams.set('project', room.code); history.replaceState(null, '', url);
    this.options.open(room.project); this.home.close(); this.notify();
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
    this.notify();
    let room = await this.api({ action: 'create', id: this.creation.id, project, ...(sourceCode ? { sourceCode } : {}) });
    if (room.editing !== 'you') try { room = await this.api({ action: 'claim' }, room.code); } catch (error) { if ((error as { code?: string }).code !== 'editor_present') throw error; }
    this.creation = null; this.listed = null;
    await this.activate(room);
  }
  save(project: ProjectDocument) {
    if (!this.room || !this.canEdit) return;
    if (!this.pending && serializeProject(project) === this.savedText) return;
    if (this.pending && serializeProject(project) === serializeProject(this.pending)) return;
    if (!this.pending) this.draftVersion = this.room.savedVersion;
    this.pending = structuredClone(project);
    this.notify();
    this.firstPendingAt ||= Date.now(); clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => void this.flush().catch(() => {}), Math.min(650, Math.max(0, 2000 - (Date.now() - this.firstPendingAt))));
  }
  async flush(): Promise<void> {
    clearTimeout(this.autoSaveTimer); this.firstPendingAt = 0;
    if (this.saving) return this.saving;
    if (!this.pending || !this.room || !this.canEdit) return;
    const room = this.room;
    this.saving = (async () => {
      while (this.pending && this.room === room && this.canEdit) {
        const project = this.pending;
        try {
          const saved = await this.api({ action: 'save', savedVersion: this.draftVersion ?? room.savedVersion, project }, room.code);
          this.savedText = serializeProject(project);
          room.savedVersion = saved.savedVersion; room.contentVersion = saved.contentVersion; room.updatedAt = saved.updatedAt; room.leaseExpiresAt = saved.leaseExpiresAt;
          if (this.pending === project) this.pending = null;
          this.draftVersion = this.pending ? saved.savedVersion : undefined;
          this.failed = false; this.listed = null;
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
    try {
      if (this.failed || this.conflict) {
        const room = this.room, next = await this.api(undefined, room.code);
        if (this.room !== room) return;
        if (this.pending && next.savedVersion !== (this.draftVersion ?? room.savedVersion) && serializeProject(next.project) !== serializeProject(this.pending)) {
          this.conflict = true; this.options.stop(); throw new Error('A newer version is saved. Download your changes or save a new project.');
        }
        const claimed = await this.api({ action: 'claim' }, room.code);
        if (!this.pending && claimed.savedVersion !== room.savedVersion) { this.savedText = serializeProject(claimed.project); this.options.open(claimed.project); }
        Object.assign(room, claimed); this.conflict = false; this.lastHeartbeat = Date.now();
      }
      await this.flush();
      await this.flushOutputs(this.room);
      this.failed = false; this.notify();
    }
    catch (error) { this.failed = true; this.notify(); this.error((error as Error).message); }
  }
  private async refresh() {
    if (!this.room || this.refreshing || this.home.open) return; this.refreshing = true; const room = this.room;
    try {
      if (this.canEdit) {
        if (this.failed || [...this.pendingOutputs.values()].some(entry => entry.room.id === room.id)) { await this.retry(); return; }
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
    try {
      await this.flush();
      if (this.room) await this.flushOutputs(this.room);
    }
    catch { this.options.state('Save failed. Retry or download your changes before switching projects.', false, true); return false; }
    if (this.room?.editing === 'you') try { await this.api({ action: 'release' }, this.room.code); } catch { /* The saved document is already durable; a disconnected lease expires. */ }
    this.room = null; this.pending = null; this.draftVersion = undefined; projectRequestContext(null); return true;
  }
  async showProjects() {
    if (this.room && !await this.leave()) return;
    const url = new URL(location.href); url.searchParams.delete('project'); history.replaceState(null, '', url); this.showHome();
  }
  async newProject() { await this.showProjects(); if (this.home.open) await this.action('new'); }
  private showHome(load = true) {
    const generation = ++this.homeGeneration, projects = this.listed ?? [];
    this.home.innerHTML = `<header class="projects-heading"><a class="brand" href="/">LittleTake</a><span>PROJECT WORKSPACE</span></header>
      <div class="projects-welcome"><div><small>YOUR FILM STARTS HERE</small><h1>A place for every little take.</h1><p>Build a set, shape the action, and keep your projects together.</p></div><button class="primary-button" data-project-action="new">＋ New project</button></div>
      <div class="projects-toolbar"><h2>${!this.modeReady ? 'Projects' : this.workspace.mode === 'cloud' ? 'Cloud projects' : 'Local projects'} <span>${projects.length}</span></h2><div>${this.canUpload ? '<button data-project-action="cloud">Open from cloud</button>' : ''}<button data-project-action="import">Import project</button><button data-project-action="join">Join with a code</button></div></div>
      <section class="project-cards">${projects.map(item => `<article><button class="project-card-open" data-project-action="open" data-code="${escape(item.code)}"><div class="project-card-art"><span>▱</span><small>${item.scenes} SCENES · ${item.objects} OBJECTS</small></div><h3>${escape(item.name)}</h3><p>Saved ${new Date(item.updatedAt).toLocaleDateString()} · ${escape(this.formatCode(item.code))}</p></button><button class="project-copy-button" data-project-action="copy" data-code="${escape(item.code)}">Duplicate</button></article>`).join('') || '<div class="projects-empty"><span>◇</span><h3>Your next scene starts here</h3><p>Create a project or import an existing LittleTake save.</p><button data-project-action="new">Create your first project</button></div>'}</section>
      ${this.creation ? '<button data-project-action="recover">Retry creating project</button>' : ''}${this.browserRecoveryId ? '<a class="project-recovery-link" href="/api/projects?browserRecovery=' + this.browserRecoveryId + '">Download previous browser data backup</a>' : ''}<p class="projects-error" role="alert" hidden></p><footer>${this.workspace.mode === 'cloud' ? 'Projects, assets and conversations are stored on the cloud server.' : 'Projects, assets and conversations are stored on this computer by the running LittleTake service. Upload to cloud is optional.'}</footer>`;
    if (!this.home.open) this.home.showModal();
    if (this.migrationError) this.error(this.migrationError);
    if (load) void fetch('/api/projects?list=1', { cache: 'no-store' }).then(async response => {
      const value = await response.json(); if (!response.ok || !Array.isArray(value.projects)) throw new Error('The project list could not be loaded.');
      this.listed = value.projects;
      if (this.home.open && generation === this.homeGeneration && !this.home.querySelector('form')) this.showHome(false);
    }).catch(() => { if (this.home.open && generation === this.homeGeneration) this.error('The workspace could not be reached. Reconnect to load your saved projects.'); });
  }
  private error(message: string) { const element = this.home.querySelector<HTMLElement>('.projects-error'); if (element) { element.textContent = message; element.hidden = false; } }
  private async action(action: string, code?: string) {
    try {
      if (action === 'open' && code) await this.join(code);
      if (action === 'cloud') await this.openCloudProjects();
      if (action === 'recover' && this.creation) await this.create(this.creation.project, this.creation.sourceCode);
      if (action === 'recover-browser') this.options.recoverBrowserSave?.();
      if (action === 'copy' && code) { const source = await this.api(undefined, code); const project = parseProject(serializeProject(source.project)); project.name = `${project.name.slice(0, 110)} copy`; await this.create(project, code); }
      if (action === 'new' || action === 'join') {
        this.homeGeneration++;
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
    this.share.innerHTML = `<header><h2>${this.canEdit ? 'Share your project' : 'Viewing this project'}</h2><button data-close aria-label="Close share">✕</button></header><p>One editor, a shared view of the whole set.</p><small>PROJECT CODE</small><strong>${this.formatCode(room.code)}</strong><label>Project link<input readonly value="${escape(location.href)}"></label><label class="project-identity">Project ID<input readonly value="${room.id}"></label><p data-share-status>${this.canEdit ? 'You are editing. Others join as viewers.' : room.editing === 'available' ? 'The editing seat is available.' : 'Someone else is editing. Your view follows saved changes.'}</p><div><button data-copy>Copy link</button><button class="primary-button" data-seat>${this.canEdit ? 'Release editing' : 'Start editing'}</button></div>`;
    this.share.querySelector<HTMLButtonElement>('[data-seat]')!.disabled = !this.canEdit && room.editing !== 'available';
    this.share.querySelector('[data-close]')!.addEventListener('click', () => this.share.close());
    this.share.querySelector('[data-copy]')!.addEventListener('click', async () => { try { await copyText(location.href, this.share); this.share.querySelector('[data-share-status]')!.textContent = 'Link copied'; } catch { this.share.querySelector('input')!.select(); } });
    this.share.querySelector('[data-seat]')!.addEventListener('click', async () => {
      try { this.options.stop(); await this.flush(); const next = await this.api({ action: this.canEdit ? 'release' : 'claim' }, room.code); this.share.close(); await this.activate(next); }
      catch (error) { this.share.querySelector('[data-share-status]')!.textContent = (error as Error).message; }
    });
    this.share.showModal();
  }
  private async cloudRequest(body?: { action: 'open' | 'upload'; id: string; keepLocal?: boolean }) {
    const response = await fetch('/api/cloud-projects', { method: body ? 'POST' : 'GET', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.error?.message ?? 'The cloud could not be reached. Your local project is retained.'), { code: value.error?.code });
    return value;
  }
  private transferDialog(title: string, message: string, actions: { label: string; run(): Promise<void> }[] = []) {
    const dialog = this.cloudDialog;
    dialog.innerHTML = `<header><h2>${escape(title)}</h2><button data-close aria-label="Close cloud projects">✕</button></header><p>${escape(message)}</p><div class="cloud-project-list"></div><div class="cloud-project-actions">${actions.map((action, index) => `<button data-transfer="${index}"${index === actions.length - 1 ? ' class="primary-button"' : ''}>${escape(action.label)}</button>`).join('')}</div><p class="projects-error" role="alert" hidden></p>`;
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    dialog.querySelectorAll<HTMLButtonElement>('[data-transfer]').forEach(button => button.addEventListener('click', async () => {
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]; buttons.forEach(item => item.disabled = true);
      try { await actions[Number(button.dataset.transfer)].run(); }
      catch (error) { const element = dialog.querySelector<HTMLElement>('.projects-error')!; element.textContent = (error as Error).message; element.hidden = false; }
      finally { buttons.forEach(item => item.disabled = false); }
    }));
    if (!dialog.open) dialog.showModal();
  }
  async openCloudProjects() {
    if (!this.canUpload) return;
    this.transferDialog('Open from cloud', 'Loading projects…');
    try {
      const { projects } = await this.cloudRequest();
      if (!this.cloudDialog.open) return;
      this.transferDialog('Open from cloud', 'Open a local copy. Your edits stay on this computer until you upload them.');
      const list = this.cloudDialog.querySelector<HTMLElement>('.cloud-project-list')!;
      list.innerHTML = (projects as RecentProject[]).map(item => `<button data-cloud-id="${escape(item.id!)}"><span><strong>${escape(item.name)}</strong><small>${item.scenes} ${item.scenes === 1 ? 'scene' : 'scenes'} · ${new Date(item.updatedAt).toLocaleDateString()}</small></span><span>Open ↗</span></button>`).join('') || '<p>No cloud projects yet. Create a local project and upload it to begin.</p>';
      list.querySelectorAll<HTMLButtonElement>('[data-cloud-id]').forEach(button => button.addEventListener('click', async () => {
        const buttons = [...list.querySelectorAll('button')]; buttons.forEach(item => item.disabled = true);
        try { await this.openCloud(button.dataset.cloudId!); }
        catch (error) { const element = this.cloudDialog.querySelector<HTMLElement>('.projects-error')!; element.textContent = (error as Error).message; element.hidden = false; }
        finally { buttons.forEach(item => item.disabled = false); }
      }));
    } catch (error) { this.transferDialog('Cloud unavailable', (error as Error).message, [{ label: 'Try again', run: () => this.openCloudProjects() }]); }
  }
  private async openCloud(id: string, keepLocal = false) {
    if (this.room && !await this.leave()) throw new Error('Finish saving the current project before switching.');
    try {
      const room = await this.cloudRequest({ action: 'open', id, ...(keepLocal ? { keepLocal: true } : {}) });
      await this.activate(room); this.cloudDialog.close(); this.listed = null;
      this.options.notice?.('Opened on this computer');
    } catch (error) {
      if ((error as { code?: string }).code !== 'local_conflict') throw error;
      this.transferDialog('Keep your local changes', (error as Error).message, [{ label: 'Keep local copy and open cloud', run: () => this.openCloud(id, true) }]);
    }
  }
  async uploadToCloud() {
    if (!this.canUpload || this.uploading) return;
    if (!this.room || !this.canEdit) throw new Error('Start editing before uploading this project.');
    this.uploading = true; this.notify();
    try {
      await this.flush();
      await this.flushOutputs(this.room);
      const room = this.room, value = await this.cloudRequest({ action: 'upload', id: room.id });
      if (this.room === room) room.cloud = value.cloud;
      this.options.notice?.('Uploaded to cloud');
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (['cloud_conflict', 'cloud_mismatch', 'cloud_missing'].includes(code ?? '')) {
        this.transferDialog('Cloud project has changed', (error as Error).message, [{ label: 'Upload as a new project', run: async () => { await this.saveCopy(); this.cloudDialog.close(); await this.uploadToCloud(); } }]);
      } else this.transferDialog('Upload could not finish', (error as Error).message, [{ label: 'Try again', run: async () => { this.cloudDialog.close(); await this.uploadToCloud(); } }]);
    } finally { this.uploading = false; this.notify(); }
  }
  async putOutput(output: Omit<ProjectOutput, 'updatedAt'>, data: Blob, target = this.room): Promise<ProjectOutput> {
    if (!target || (target === this.room && !this.canEdit)) throw new Error('Start editing before saving a result.');
    const stored = { ...output, updatedAt: Date.now() }, key = `${target.code}:${output.id}`;
    this.pendingOutputs.set(key, { room: target, output: stored, data });
    target.outputs = [stored, ...target.outputs.filter(item => item.id !== output.id)]; this.notify();
    await this.writeOutput(key); return target.outputs.find(item => item.id === output.id)!;
  }
  private async writeOutput(key: string): Promise<void> {
    const writing = this.outputWrites.get(key); if (writing) return writing;
    const promise = (async () => {
      let current;
      try {
        while ((current = this.pendingOutputs.get(key))) {
          const { room, data, output: { updatedAt: _at, ...metadata } } = current;
          const response = await fetch(`/api/projects?code=${encodeURIComponent(room.code)}&output=1`, { method: 'POST', headers: { 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page, 'x-littletake-output': encodeURIComponent(JSON.stringify(metadata)) }, body: data });
          const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? 'The result has not reached the workspace. Keep this page open and retry.');
          if (this.pendingOutputs.get(key) === current) { this.pendingOutputs.delete(key); room.outputs = [value, ...room.outputs.filter(item => item.id !== value.id)]; }
        }
      } catch (error) { this.failed = true; throw error; }
    })().finally(() => { this.outputWrites.delete(key); this.notify(); });
    this.outputWrites.set(key, promise); return promise;
  }
  private async flushOutputs(room: ProjectRoom) {
    for (const [key, entry] of this.pendingOutputs) if (entry.room.id === room.id) await this.writeOutput(key);
  }
  async output(id: string, room = this.room): Promise<Blob> {
    if (!room) throw new Error('Open a project first.');
    const pending = this.pendingOutputs.get(`${room.code}:${id}`); if (pending) return pending.data;
    const response = await fetch(`/api/projects?code=${encodeURIComponent(room.code)}&output=${encodeURIComponent(id)}`); if (!response.ok) throw new Error('The saved result could not be opened.');
    return response.blob();
  }
  async publishHandoff(archive: Blob, id: string, target = this.room): Promise<HandoffReceipt> {
    if (!target || target !== this.room || !this.canEdit) throw new Error('Open this project and start editing before publishing references.');
    await this.flush();
    const response = await fetch(`/api/handoffs?code=${encodeURIComponent(target.code)}&id=${id}`, { method: 'POST', headers: { 'Content-Type': 'application/zip', 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page }, body: archive });
    const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? 'References could not be published. Retry to keep the same publication.');
    target.handoffs = [value, ...(target.handoffs ?? []).filter(item => item.id !== value.id)]; return value;
  }
  async withdrawHandoff(id: string) {
    if (!this.room || !this.canEdit) throw new Error('Start editing before withdrawing a reference link.');
    const response = await fetch(`/api/handoffs?code=${encodeURIComponent(this.room.code)}&id=${id}&revoke=1`, { method: 'POST', headers: { 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page } });
    if (!response.ok) throw new Error((await response.json()).error?.message ?? 'The reference link could not be withdrawn.');
    const receipt = this.room.handoffs?.find(value => value.id === id); if (receipt) receipt.revokedAt = Date.now();
  }
  handoffUrl(receipt: HandoffReceipt) { return new URL(handoffPath(receipt.token), location.origin).href; }
  lookSettings(sceneId: string) { return this.options.project().lookSettings?.[sceneId] ?? { direction: '', anchorId: null, styleId: null }; }
  setLookSettings(sceneId: string, value: Partial<NonNullable<ProjectDocument['lookSettings']>[string]>) {
    if (!this.canEdit) return;
    const project = this.options.project(); project.lookSettings ??= {}; project.lookSettings[sceneId] = { ...this.lookSettings(sceneId), ...value }; this.save(project);
  }
  async importArchive(file: Blob, asCopy = false) {
    const bundle = await readProjectArchive(file), id = asCopy ? newId() : bundle.id ?? newId();
    if (!asCopy && bundle.id) {
      const existing = await fetch('/api/projects?id=' + id, { cache: 'no-store' });
      if (existing.ok) {
        const room: ProjectRoom = await existing.json();
        this.transferDialog('Project already exists', 'This archive has the same project ID as a saved project. Open that project or import a separate copy.', [
          { label: 'Open existing', run: async () => { await this.join(room.code); this.cloudDialog.close(); } },
          { label: 'Import as a copy', run: () => this.importArchive(file, true) },
        ]); return;
      }
      if (existing.status !== 404) throw new Error('The project could not be checked. Retry before importing.');
    }
    if (this.room && !await this.leave()) return;
    const response = await fetch('/api/projects?import=1&id=' + id, { method: 'POST', headers: { 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page }, body: projectArchive({ ...bundle, id }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? 'The archive could not be imported. Your saved projects are unchanged.'); await this.activate(value);
    this.cloudDialog.close(); this.listed = null;
  }
  async download() {
    if (!this.room) return;
    const room = this.room, project = structuredClone(this.options.project());
    try { await this.flush(); } catch { /* The archive also preserves a local draft when saving is unavailable. */ }
    const metadata = new Map(room.outputs.map(output => [output.id, output]));
    for (const entry of this.pendingOutputs.values()) if (entry.room.id === room.id) metadata.set(entry.output.id, entry.output);
    const outputs: { output: ProjectOutput; data: Uint8Array }[] = [];
    for (const output of metadata.values()) outputs.push({ output, data: new Uint8Array(await (await this.output(output.id, room)).arrayBuffer()) });
    const url = URL.createObjectURL(projectArchive({ id: room.id, version: room.contentVersion, project, outputs })), link = document.createElement('a');
    link.href = url; link.download = `${project.name.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'LittleTake'}.littletake.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async saveCopy() {
    if (!this.room) return;
    this.options.stop(); await this.saving?.catch(() => {});
    const original = serializeProject(this.options.project()), project = parseProject(original); project.name = project.name.slice(0, 110) + ' copy';
    const sourceCode = this.room.code;
    const pendingOutputs = [...this.pendingOutputs.values()].filter(entry => entry.room.code === sourceCode);
    const room = await this.api({ action: 'create', id: newId(), project, sourceCode });
    this.pending = null; await this.activate(room);
    for (const entry of pendingOutputs) { const { updatedAt: _at, ...metadata } = entry.output; await this.putOutput(metadata, entry.data); this.pendingOutputs.delete(`${sourceCode}:${metadata.id}`); }
    await this.api({ action: 'release' }, sourceCode).catch(() => {}); this.listed = null;
  }
  async showResults() {
    if (!this.room) return;
    const dialog = document.createElement('dialog'); dialog.className = 'project-results-dialog'; dialog.setAttribute('aria-label', 'Project results');
    const outputs = [...this.room.outputs].filter(output => !['style-reference', 'reference-media', 'diagnostic', 'asset-draft'].includes(output.kind));
    dialog.innerHTML = `<header><div><small>PROJECT RESULTS</small><h2>${escape(this.options.project().name)}</h2></div><button data-close aria-label="Close results">✕</button></header><p>Look frames, video briefs and reference analyses are kept with this project.</p><div class="project-results-list">${outputs.map(output => `<button data-output="${output.id}"><span>${output.kind === 'look-frame' ? '▧' : output.kind === 'video-brief' ? '▤' : '◇'}</span><div><strong>${escape(output.name)}</strong><small>${escape(output.kind.replaceAll('-', ' '))} · ${new Date(output.updatedAt).toLocaleString()}</small></div><span>↗</span></button>`).join('') || '<div class="projects-empty">No results yet. Open a shot’s Look panel or analyze a reference clip to begin.</div>'}</div><div class="project-result-preview" hidden></div><p class="projects-error" hidden role="alert"></p>`;
    const urls: string[] = [];
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { urls.forEach(url => URL.revokeObjectURL(url)); dialog.remove(); });
    dialog.addEventListener('click', async event => {
      const id = (event.target as HTMLElement).closest<HTMLElement>('[data-output]')?.dataset.output; if (!id) return;
      try {
        const output = outputs.find(value => value.id === id)!, data = await this.output(id);
        if (output.kind === 'reference-analysis') { dialog.close(); this.options.result?.(output, data); return; }
        const preview = dialog.querySelector<HTMLElement>('.project-result-preview')!; preview.hidden = false; preview.replaceChildren();
        if (output.kind === 'final-video') { const url = URL.createObjectURL(data); urls.push(url); const video = document.createElement('video'); video.src = url; video.controls = true; video.style.width = '100%'; const link = document.createElement('a'); link.href = url; link.download = output.name + (output.mime === 'video/webm' ? '.webm' : '.mp4'); link.textContent = 'Download video'; preview.append(video, link); return; }
        const value = JSON.parse(await data.text());
        if (output.kind === 'look-frame') { const image = new Image(); image.src = value.image; image.alt = output.name; preview.append(image); const link = document.createElement('a'); link.href = value.image; link.download = output.name + '.png'; link.textContent = 'Download image'; preview.append(link); }
        else { const text = document.createElement('p'); text.textContent = value.brief.prompt; preview.append(text); }
      } catch (error) { const message = dialog.querySelector<HTMLElement>('.projects-error')!; message.hidden = false; message.textContent = (error as Error).message; }
    });
    document.body.append(dialog); dialog.showModal();
  }
}
