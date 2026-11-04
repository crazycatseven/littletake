import { icon } from '../icons';
import { newId } from "../id.ts";
import './workspace.css';
import { createProject, parseProject, serializeProject, type ProjectDocument } from './storage';
import { EDIT_HEARTBEAT_MS, type ProjectRoom, type ProjectOutput, type WorkspaceInfo, type ProjectSummary, type ProjectCoverFrame, type ProjectCover } from './room';
import { retireBrowserProjects } from './cache';
import { projectRequestContext } from './client';
import { projectArchive, readProjectArchive, validateAppearanceAttachments } from './archive';
import { copyText } from '../clipboard';
import { handoffPath, type HandoffReceipt } from '../look/handoff';
import { loadProjectCovers, retryProjectCover } from './gallery';
import { coverDue, projectCoverFrame, coverVisual, validateCover, type CoverAttachment } from './cover';
import { ProjectCollaboration } from './collaboration';
import { uploadOutput, type OutputTransfer } from './output-upload';
import { legacyStoryboardDraftSchema, storyboardDraftSchema } from '../look/ai-storyboard';
import { downloadStoryboardImage, renderStoryboards } from '../look/storyboard';

/** Finished projects a newcomer can open as their own copy. Files live in public/examples. */
const EXAMPLES = [
  { slug: 'knight-vs-dragon', name: 'Knight vs dragon', detail: 'One sentence to Muse: a set, two animated characters and three camera shots that cut in sequence.' },
  { slug: 'golden-gate-flight', name: 'Dragon over the Golden Gate', detail: 'A 12 s flight under the bridge with a high wide, a chase and a low shot.' },
  { slug: 'hotel-lobby-from-clip', name: 'Hotel lobby from a film clip', detail: 'Rebuilt from a 12 s reference video: three people, three shots, one shared set.' },
] as const;

interface WorkspaceOptions {
  project(): ProjectDocument;
  open(project: ProjectDocument): void;
  receive(project: ProjectDocument): boolean;
  stop(): void;
  state(message: string, readOnly: boolean, problem: boolean): void;
  beforeSwitch(): boolean;
  result?(output: ProjectOutput, data: Blob): void;
  recoverBrowserSave?(): void;
  mode?(workspace: WorkspaceInfo): void;
  notice?(message: string): void;
  preview(preview: ProjectCoverFrame): string | null;
  previewReady(): boolean;
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
  private listed: ProjectSummary[] | null = null;
  private coverSaving: Promise<void> | null = null;
  private coverAbort?: AbortController;
  private coverAttemptAt = 0;
  private coverOnOpen = false;
  private lastInput = 0;
  private readonly heldPointers = new Set<number>();
  private projectSearch = '';
  private projectSort = 'recent';
  private gallerySource: 'cloud' | 'downloads' = 'cloud';
  private homeGeneration = 0;
  private workspace: WorkspaceInfo = { mode: 'cloud', cloudAvailable: false };
  private migrationError = '';
  private readonly pendingOutputs = new Map<string, { room: ProjectRoom; output: ProjectOutput; data: Blob; base: number; transfer?: OutputTransfer; progress?: (state: OutputTransfer) => void }>();
  private readonly outputWrites = new Map<string, Promise<void>>();
  private browserRecoveryId?: string;
  private uploading = false;
  private collaboration: ProjectCollaboration | null = null;
  private collaborationError = '';
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
    // Focus the gallery itself on open, so the browser does not ring the first link (the logo) on every visit.
    this.home.tabIndex = -1;
    this.share.className = 'project-share-dialog'; this.share.setAttribute('aria-label', 'Share project');
    this.cloudDialog.className = 'project-cloud-dialog'; this.cloudDialog.setAttribute('aria-label', 'Cloud projects');
    document.body.append(this.home, this.share, this.cloudDialog);
    this.home.addEventListener('cancel', event => { if (!this.room) event.preventDefault(); });
    this.home.addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLElement>('[data-project-action]'); if (button?.dataset.projectAction === 'retry-preview') retryProjectCover(button.closest<HTMLElement>('[data-project-cover]')!); else if (button) void this.action(button.dataset.projectAction!, button.dataset.code, button.dataset.projectId); });
    this.home.addEventListener('submit', event => { event.preventDefault(); const form = event.target as HTMLFormElement; void this.submit(form); });
    this.timer = setInterval(() => void this.refresh(), 5000);
    window.addEventListener('online', () => { if (this.autosave) void this.retry(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) void this.flush().catch(() => {}); });
    window.addEventListener('pointerdown', event => { this.heldPointers.add(event.pointerId); this.lastInput = Date.now(); }, true);
    for (const name of ['pointerup', 'pointercancel'] as const) window.addEventListener(name, event => { this.heldPointers.delete(event.pointerId); this.lastInput = Date.now(); }, true);
    for (const name of ['keydown', 'input', 'wheel']) window.addEventListener(name, () => { this.lastInput = Date.now(); }, { capture: true, passive: true });
    window.addEventListener('blur', () => this.heldPointers.clear());
    window.addEventListener('pagehide', () => { this.coverAbort?.abort(); this.options.stop(); this.collaboration?.stop(); channel.close(); if ((!this.autosave || !this.hasUnsaved) && this.room?.editing === 'you') void this.api({ action: 'release' }, this.room.code, true).catch(() => {}); });
  }
  get canEdit() { return this.room !== null; }
  get hasUnsaved() { return Boolean(this.collaboration?.dirty || this.pending || this.failed || this.saving || this.pendingOutputs.size); }
  get hasUnsafeChanges() { return Boolean(this.collaboration?.dirty || this.pending || this.saving || this.pendingOutputs.size || this.creation || this.uploading); }
  private get autosave() { return this.workspace.mode === 'cloud'; }
  private get remoteGallery() { return this.canUpload && this.gallerySource === 'cloud'; }
  get canUpload() { return this.workspace.mode === 'local' && this.workspace.cloudAvailable; }
  get isUploading() { return this.uploading; }
  private async api(body?: unknown, code?: string, keepalive = false, reconnect = true): Promise<ProjectRoom> {
    const response = await fetch('/api/projects' + (code ? '?code=' + encodeURIComponent(code) : ''), {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', keepalive,
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok && reconnect && code && value.error?.code === 'edit_lease_lost' && ['save', 'edit', 'heartbeat'].includes((body as { action?: string })?.action ?? '')) {
      await this.api({ action: 'claim' }, code);
      return this.api(body, code, keepalive, false);
    }
    if (!response.ok) throw Object.assign(new Error(value.error?.message ?? 'The project service is unavailable. Keep this page open and retry saving.'), { code: value.error?.code ?? 'unavailable' });
    return value;
  }
  async ensureSession(room = this.room) {
    if (!room) throw new Error('Open a project first.');
    if (room === this.room && Date.now() - this.lastHeartbeat < EDIT_HEARTBEAT_MS) return;
    const next = await this.api({ action: 'heartbeat' }, room.code);
    room.leaseExpiresAt = next.leaseExpiresAt;
    if (room === this.room) this.lastHeartbeat = Date.now();
  }
  async start() {
    await this.sessionReady;
    try {
      const response = await fetch('/api/projects?workspace=1'); if (!response.ok) throw new Error('The workspace is unavailable. Reconnect to open your saved projects.');
      this.workspace = await response.json(); this.options.mode?.(this.workspace);
      try { this.browserRecoveryId = await retireBrowserProjects(this.lease, this.page); }
      catch (error) { this.migrationError = (error as Error).message; }
      const code = new URL(location.href).searchParams.get('project');
      if (code) { await this.join(code); if (this.migrationError) this.reportError(this.migrationError); return; }
      this.showHome();
    } catch (error) { this.showHome(); this.error((error as Error).message); }
  }
  private notify() {
    const readOnly = !this.canEdit;
    const text = this.collaborationError || (this.conflict ? 'A newer version is saved. Keep this page open; download your changes or save a copy to continue.' : this.failed ? (this.autosave ? 'Saving failed. Keep this page open; changes have not reached the workspace. Saving will retry automatically.' : 'Upload failed. Keep this page open and retry uploading, or export your project.') : this.migrationError);
    this.options.state(text, readOnly, Boolean(text));
  }
  private async activate(room: ProjectRoom) {
    this.collaboration?.stop(); this.collaboration = null; this.collaborationError = '';
    this.coverAttemptAt = 0; this.coverOnOpen = room.cover?.savedVersion !== room.savedVersion;
    this.options.stop(); this.pending = null; this.draftVersion = undefined; this.room = room; this.lastHeartbeat = Date.now(); this.failed = false; this.conflict = false;
    this.savedText = serializeProject(room.project);
    projectRequestContext({ code: room.code, lease: this.lease, page: this.page }, this);
    // Another page may still be running the saved conversation.
    room.project = parseProject(serializeProject(room.project), false);
    if (this.autosave) {
      this.collaboration = new ProjectCollaboration(room, {
        send: edit => this.api(edit, room.code),
        watch: async (version, signal) => {
          const response = await fetch(`/api/projects?code=${encodeURIComponent(room.code)}&since=${version}`, { signal, cache: 'no-store' });
          if (response.status === 204) return null;
          if (!response.ok) throw new Error('Connection interrupted. Keep this page open; collaboration will reconnect automatically.');
          return response.json();
        },
        receive: project => !this.heldPointers.size && this.options.receive(project),
        room: next => {
          if (this.room !== room) return;
          room.project = next.project; room.savedVersion = next.savedVersion; room.contentVersion = next.contentVersion; room.updatedAt = next.updatedAt;
          const pending = [...this.pendingOutputs.values()].filter(entry => entry.room === room);
          room.outputs = [...next.outputs.filter(output => !pending.some(entry => entry.output.id === output.id)), ...pending.map(entry => entry.output)];
          room.handoffs = next.handoffs; this.mergeCover(room, next.cover); this.savedText = serializeProject(next.project); this.listed = null;
        },
        state: error => { if(this.room!==room)return;this.collaborationError = error instanceof TypeError ? 'Connection interrupted. Keep this page open; your edits will sync automatically when reconnected.' : error?.message ?? ''; this.failed = !!error; this.notify(); },
      });
    }
    const url = new URL(location.href); url.searchParams.set('project', room.code); history.replaceState(null, '', url);
    this.options.open(room.project);
    const editor = document.getElementById('app'); if (editor) { editor.removeAttribute('data-opening'); editor.inert = false; }
    document.getElementById('workspaceOpening')?.remove();
    this.home.close(); this.notify();
    this.collaboration?.start();
    if (this.pending && !this.conflict) void this.flush().catch(() => {});
  }
  async join(code: string) {
    if (this.room && !await this.leave()) throw new Error('Finish saving the current project before switching.');
    const clean = code.replace(/[-\s]/g, '').toUpperCase();
    const room = await this.api({ action: 'claim' }, clean);
    await this.activate(room);
  }
  async create(project: ProjectDocument = createProject(null), sourceCode?: string) {
    if (!sourceCode) validateAppearanceAttachments(project, []);
    if (!sourceCode && project.lookSettings) for (const settings of Object.values(project.lookSettings)) { settings.anchorId = null; settings.styleId = null; }
    if (this.room && !await this.leave()) throw new Error('Finish saving the current project before switching.');
    if (this.creation && serializeProject(this.creation.project) !== serializeProject(project)) throw new Error('Recover the pending project before creating another one.');
    this.creation ??= { id: newId(), project, ...(sourceCode ? { sourceCode } : {}) };
    this.notify();
    let room = await this.api({ action: 'create', id: this.creation.id, project, ...(sourceCode ? { sourceCode } : {}) });
    if (room.editing !== 'you') room = await this.api({ action: 'claim' }, room.code);
    this.creation = null; this.listed = null;
    await this.activate(room);
  }
  save(project: ProjectDocument, guard = false) {
    if (!this.room || !this.canEdit) return;
    if (this.collaboration) { this.collaboration.observe(project, guard); this.notify(); return; }
    if (!this.saving && serializeProject(project) === this.savedText) { this.pending = null; this.draftVersion = undefined; this.notify(); return; }
    if (!this.pending && serializeProject(project) === this.savedText) return;
    if (this.pending && serializeProject(project) === serializeProject(this.pending)) return;
    if (!this.pending) this.draftVersion = this.room.savedVersion;
    this.pending = structuredClone(project);
    this.notify();
  }
  async flush(manual = false): Promise<void> {
    if (this.collaboration) { await this.collaboration.flush(); this.notify(); return; }
    if (!this.autosave && !manual) return;
    if (this.conflict) throw new Error('A newer version is saved. Download your changes or save a new project.');
    if (this.saving) return this.saving;
    if (!this.pending || !this.room || !this.canEdit) return;
    const room = this.room;
    this.saving = (async () => {
      while (this.pending && this.room === room && !this.conflict) {
        const project = this.pending;
        try {
          const saved = await this.api({ action: 'save', savedVersion: this.draftVersion ?? room.savedVersion, project }, room.code);
          this.savedText = serializeProject(project);
          room.savedVersion = saved.savedVersion; room.contentVersion = Math.max(room.contentVersion ?? 0, saved.contentVersion ?? 0); room.updatedAt = saved.updatedAt; room.leaseExpiresAt = saved.leaseExpiresAt;
          this.mergeCover(room, saved.cover);
          if (this.pending === project) this.pending = null;
          this.draftVersion = this.pending ? saved.savedVersion : undefined;
          this.failed = false; this.listed = null;
        } catch (error) {
          this.failed = true;
          if ((error as { code?: string }).code === 'save_conflict') { this.conflict = true; this.options.stop(); }
          throw error;
        }
      }
    })().finally(() => { this.saving = null; this.notify(); });
    this.notify(); return this.saving;
  }
  async retry(retryFailedOutputs = true) {
    if (!this.room) return;
    try {
      if (!this.collaboration && (this.failed || this.conflict)) {
        const room = this.room, next = await this.api({ action: 'claim' }, room.code);
        if (this.room !== room) return;
        if (this.pending && next.savedVersion !== (this.draftVersion ?? room.savedVersion) && serializeProject(next.project) !== serializeProject(this.pending)) {
          this.conflict = true; this.options.stop(); throw new Error('A newer version is saved. Download your changes or save a new project.');
        }
        // Reconnecting must not replace this page's draft or advance its save baseline.
        room.leaseExpiresAt = next.leaseExpiresAt; this.conflict = false; this.lastHeartbeat = Date.now();
      }
      await this.flush();
      if (this.autosave) await this.flushOutputs(this.room, retryFailedOutputs);
      this.failed = false; this.notify();
    }
    catch (error) { this.failed = true; this.notify(); this.error((error as Error).message); }
  }
  private async refresh() {
    if (!this.room || this.refreshing || this.home.open) return; this.refreshing = true; const room = this.room;
    try {
      await this.ensureSession(room);
      if (this.conflict) return;
      if (this.autosave && (this.failed || [...this.pendingOutputs.values()].some(entry => entry.room.id === room.id))) { await this.retry(false); return; }
    } catch { if (this.room === room) this.failed = true; }
    finally { this.refreshing = false; this.notify(); }
    void this.updateCover();
  }
  private mergeCover(room: ProjectRoom, incoming: ProjectCover | null | undefined) {
    if (incoming && (!room.cover || incoming.updatedAt > room.cover.updatedAt || (incoming.updatedAt === room.cover.updatedAt && incoming.savedVersion > room.cover.savedVersion))) room.cover = incoming;
  }
  private async updateCover(force = false, manual = false): Promise<void> {
    if (!this.autosave && !manual) return;
    if (this.coverSaving) { if (!force) return; await this.coverSaving; }
    const room = this.room, now = Date.now();
    if (!room || !this.canEdit || this.hasUnsaved || !this.savedText || document.hidden || !this.options.previewReady()) return;
    if (!force && (this.heldPointers.size > 0 || now - this.lastInput < 1500)) return;
    if (!coverDue(room.cover, room.savedVersion, now, this.coverAttemptAt, force || this.coverOnOpen)) return;
    const project: ProjectDocument = JSON.parse(this.savedText), version = room.savedVersion;
    const controller = new AbortController(); this.coverAbort = controller;
    this.coverAttemptAt = now; this.coverOnOpen = false;
    this.coverSaving = (async () => {
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const source = this.options.preview(projectCoverFrame(project));
        const data = source ? await (await fetch(source)).blob() : new Blob([], { type: 'image/webp' });
        validateCover(new Uint8Array(await data.arrayBuffer()));
        if (controller.signal.aborted || document.hidden || this.room !== room || !this.canEdit) return;
        await this.ensureSession(room);
        const response = await fetch(`/api/projects?code=${encodeURIComponent(room.code)}&cover=1&version=${version}`, {
          method: 'POST', headers: { 'Content-Type': 'image/webp', 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page }, body: data, signal: controller.signal,
        });
        if (!response.ok) return; // A stale or failed optional cover never blocks saving the project.
        const saved = await response.json();
        this.mergeCover(room, saved.cover); room.contentVersion = Math.max(room.contentVersion ?? 0, saved.contentVersion);
        this.listed = null; if (!source) this.coverAttemptAt = 0;
      } catch { /* Keep the previous server image and retry at the next checkpoint. */ }
      finally { clearTimeout(timeout); }
    })();
    try { await this.coverSaving; } finally { this.coverSaving = null; }
  }
  private async leave(): Promise<boolean> {
    if (this.uploading) { this.options.notice?.('Wait for the upload to finish before switching projects.'); return false; }
    if (!this.options.beforeSwitch()) return false;
    this.options.stop();
    if (!this.autosave && this.hasUnsaved && !await this.confirmLocalLeave()) return false;
    if (this.autosave && this.conflict && this.hasUnsaved) { this.options.state('Keep your changes by downloading them or saving a new project before switching.', false, true); return false; }
    try {
      await this.flush();
      if (this.autosave && this.room) await this.flushOutputs(this.room);
    }
    catch { this.options.state('Save failed. Retry or download your changes before switching projects.', false, true); return false; }
    await this.updateCover(true);
    if (this.room?.editing === 'you') try { await this.api({ action: 'release' }, this.room.code); } catch { /* The saved document is already durable; a disconnected lease expires. */ }
    if (!this.autosave && this.room) for (const [key, entry] of this.pendingOutputs) if (entry.room === this.room) this.pendingOutputs.delete(key);
    this.collaboration?.stop(); this.collaboration = null; this.collaborationError = '';
    this.room = null; this.pending = null; this.draftVersion = undefined; projectRequestContext(null); return true;
  }
  async showProjects() {
    if (this.room && !await this.leave()) return;
    const url = new URL(location.href); url.searchParams.delete('project'); history.replaceState(null, '', url); this.showHome();
  }
  async newProject() { await this.showProjects(); if (this.home.open) await this.action('new'); }
  private showHome(load = true) {
    const generation = ++this.homeGeneration;
    this.home.innerHTML = `<header class="projects-heading"><a class="brand" href="/" aria-label="LittleTake"><span class="brand-mark">L</span><span>LittleTake</span></a><span>GALLERY</span><nav>${this.canUpload ? `<button data-project-action="${this.remoteGallery ? 'downloads' : 'cloud'}">${this.remoteGallery ? 'Downloaded projects' : 'Cloud projects'}</button>` : ''}<button data-project-action="join">Join with a code</button><button data-project-action="import">Import project</button><button class="primary-button" data-project-action="new">${icon('plus')} New project</button></nav></header>
      <div class="projects-welcome"><div><h1>${this.remoteGallery ? 'Cloud projects' : this.autosave ? 'Projects' : 'Downloaded projects'}</h1><p>${this.autosave ? 'Turn a sentence, a sketch or a film clip into an editable 3D previs: set, characters, cameras and shots. Open an example below, or start a new project.' : 'Open a local copy to edit. Upload manually to replace the cloud project.'}</p></div><span class="projects-count"></span></div>
      <section class="project-examples" aria-label="Examples"><div class="project-examples-heading"><h2>New here? Open an example</h2><p>Each one opens as your own copy. Press play to watch its shots, then change anything by hand or by asking Muse.</p></div><div class="project-example-cards">${EXAMPLES.map(example => `<button class="project-example" data-project-action="example" data-code="${example.slug}"><img src="/examples/${example.slug}.webp" alt="" width="640" height="360" loading="lazy" /><span><strong>${escape(example.name)}</strong><small>${escape(example.detail)}</small></span></button>`).join('')}</div></section>
      <div class="projects-toolbar"><label class="project-search"><span aria-hidden="true">${icon('search')}</span><input type="search" aria-label="Search projects" placeholder="Search projects…" value="${escape(this.projectSearch)}" /></label><label class="project-sort">Sort by<select aria-label="Sort projects"><option value="recent" ${this.projectSort === 'recent' ? 'selected' : ''}>Last edited</option><option value="name" ${this.projectSort === 'name' ? 'selected' : ''}>Name A–Z</option></select></label></div>
      <section class="project-cards" aria-label="Projects"></section>
      ${this.creation ? '<button data-project-action="recover">Retry creating project</button>' : ''}${this.browserRecoveryId ? '<a class="project-recovery-link" href="/api/projects?browserRecovery=' + this.browserRecoveryId + '">Download previous browser data backup</a>' : ''}<p class="projects-error" role="alert" hidden></p><footer>${this.autosave ? 'Projects, assets and conversations are stored on the cloud server.' : 'Local editing has no autosave. Upload to cloud or export a project file before leaving.'}</footer>`;
    if (!this.home.open) { this.home.showModal(); this.home.focus({ preventScroll: true }); }
    document.getElementById('workspaceOpening')?.remove();
    this.renderProjectCards();
    this.home.querySelector<HTMLInputElement>('.project-search input')!.oninput = event => { this.projectSearch = (event.target as HTMLInputElement).value; this.renderProjectCards(); };
    this.home.querySelector<HTMLSelectElement>('.project-sort select')!.onchange = event => { this.projectSort = (event.target as HTMLSelectElement).value; this.renderProjectCards(); };
    if (this.migrationError) this.error(this.migrationError);
    if (load) void fetch(this.remoteGallery ? '/api/cloud-projects' : '/api/projects?list=1', { cache: 'no-store' }).then(async response => {
      const value = await response.json(); if (!response.ok || !Array.isArray(value.projects)) throw new Error('The project list could not be loaded.');
      if (!this.home.open || generation !== this.homeGeneration) return;
      this.listed = value.projects;
      this.renderProjectCards();
    }).catch(() => { if (this.home.open && generation === this.homeGeneration) this.error('The workspace could not be reached. Reconnect to load your saved projects.'); });
  }
  private renderProjectCards() {
    const grid = this.home.querySelector<HTMLElement>('.project-cards'); if (!grid) return;
    const projects = (this.listed ?? []).filter(item => item.name.toLowerCase().includes(this.projectSearch.trim().toLowerCase()))
      .sort((a, b) => this.projectSort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt - a.updatedAt);
    const count = this.home.querySelector<HTMLElement>('.projects-count');
    if (count) count.textContent = this.listed ? `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}` : '';
    const placeholder = icon('film');
    grid.innerHTML = this.listed === null ? '<div class="projects-empty" role="status">Loading projects…</div>' : projects.map(item => `<article data-project-cover data-code="${escape(item.code)}" data-preview-state="${item.cover?.hasImage ? 'loading' : 'empty'}"><button class="project-card-open" data-project-action="${this.remoteGallery ? 'open-cloud' : 'open'}" data-project-id="${escape(item.id)}" data-code="${escape(item.code)}" aria-label="Open project ${escape(item.name)}"><div class="project-card-art"><img alt="Preview of ${escape(item.name)}" decoding="async" loading="lazy" width="640" height="360" ${item.cover?.hasImage ? `data-cover-url="/api/${this.remoteGallery ? 'cloud-projects' : 'projects'}?cover=1&amp;code=${escape(item.code)}&amp;v=${item.cover.updatedAt}"` : ''} /><div class="project-cover-placeholder">${placeholder}<span data-preview-label>${item.cover?.hasImage ? 'Loading preview…' : item.objects && !item.cover ? 'Preview not available yet' : 'Your next idea goes here'}</span></div><small>${item.scenes} ${item.scenes === 1 ? 'scene' : 'scenes'}</small><span class="project-open-arrow" aria-hidden="true">${icon('external')}</span></div><h3>${escape(item.name)}</h3><p>Edited ${new Date(item.updatedAt).toLocaleDateString()} · ${escape(this.formatCode(item.code))}</p></button><button class="project-preview-retry" data-project-action="retry-preview" aria-label="Retry preview for ${escape(item.name)}">${icon('retry')}</button>${this.remoteGallery ? '' : `<button class="project-copy-button" data-project-action="copy" data-code="${escape(item.code)}">Duplicate</button>`}</article>`).join('') || (this.projectSearch ? '<div class="projects-empty"><h3>No projects found</h3><p>Try another project name.</p><button data-project-action="clear-search">Clear search</button></div>' : `<div class="projects-empty">${icon('film')}<h3>Your next scene starts here</h3><p>Create a project or import an existing LittleTake save.</p><button data-project-action="new">Create your first project</button></div>`);
    loadProjectCovers(grid);
  }
  private error(message: string) { const element = this.home.querySelector<HTMLElement>('.projects-error'); if (element) { element.textContent = message; element.hidden = false; } }
  private async action(action: string, code?: string, id?: string) {
    try {
      if (action === 'open' && code) await this.join(code);
      if (action === 'open-cloud' && id) await this.openCloud(id);
      if (action === 'cloud' || action === 'downloads') { this.gallerySource = action; this.listed = null; this.showHome(); }
      if (action === 'recover' && this.creation) await this.create(this.creation.project, this.creation.sourceCode);
      if (action === 'recover-browser') this.options.recoverBrowserSave?.();
      if (action === 'example' && code) {
        const example = EXAMPLES.find(item => item.slug === code); if (!example) return;
        const response = await fetch(`/examples/${example.slug}.json`); if (!response.ok) throw new Error('This example could not be loaded. Please try again.');
        const project = parseProject(await response.text()); project.name = `${example.name} · your copy`; await this.create(project);
      }
      if (action === 'copy' && code) { const source = await this.api(undefined, code); const project = parseProject(serializeProject(source.project)); project.name = `${project.name.slice(0, 110)} copy`; await this.create(project, code); }
      if (action === 'new' || action === 'join') {
        this.homeGeneration++;
        this.home.querySelector('.projects-welcome')!.innerHTML = action === 'new' ? `<form data-create><small>NEW PROJECT</small><h1>Make room for an idea.</h1><label>Project name<input name="name" maxlength="120" value="Untitled project" required autofocus></label><label class="project-starter"><input name="starter" type="checkbox"> Include a starter scene</label><div><button type="button" data-project-action="back">Back</button><button class="primary-button">Create project</button></div></form>` : `<form data-join><small>JOIN A PROJECT</small><h1>Enter the project code.</h1><p>${this.canUpload ? 'Download a cloud project for local editing. Changes upload only when you choose.' : 'Edit together. Changes appear automatically for everyone in the project.'}</p><label>Project code<input name="code" placeholder="ABCD-EFGH-JKLM" maxlength="32" required autofocus></label><div><button type="button" data-project-action="back">Back</button><button class="primary-button">${this.canUpload ? 'Download project' : 'Join project'}</button></div></form>`;
        this.home.querySelector<HTMLInputElement>('form input')?.focus();
      }
      if (action === 'back') this.showHome();
      if (action === 'clear-search') { this.projectSearch = ''; this.home.querySelector<HTMLInputElement>('.project-search input')!.value = ''; this.renderProjectCards(); }
      if (action === 'import') document.querySelector<HTMLInputElement>('#openFile')?.click();
    } catch (error) { this.renderProjectCards(); this.error((error as Error).message); }
  }
  private async submit(form: HTMLFormElement) {
    const button = form.querySelector<HTMLButtonElement>('.primary-button')!; button.disabled = true;
    try { const data = new FormData(form); if (form.hasAttribute('data-join')) { const code = String(data.get('code')); if (this.canUpload) await this.openCloud(code, false, true); else await this.join(code); } else { const project = createProject(data.has('starter') ? undefined : null); project.name = String(data.get('name')).trim(); await this.create(project); } }
    catch (error) { this.renderProjectCards(); this.error((error as Error).message); } finally { button.disabled = false; }
  }
  reportError(message: string) { if (!this.room && !this.home.open) this.showHome(); if (this.home.open) this.error(message); else this.options.state(message, !this.canEdit, true); }
  private formatCode(code: string) { return code.match(/.{1,4}/g)?.join('-') ?? code; }
  showShare() {
    if (!this.room) return; const room = this.room;
    if (!this.autosave) { this.transferDialog('Local editing', 'Upload this project to cloud before sharing it. Local edits are not saved automatically.'); return; }
    this.share.innerHTML = `<header><h2>Share your project</h2><button data-close aria-label="Close share">${icon('close')}</button></header><p>Anyone with this link can open and edit the project.</p><small>PROJECT CODE</small><strong>${this.formatCode(room.code)}</strong><label>Project link<input readonly value="${escape(location.href)}"></label><label class="project-identity">Project ID<input readonly value="${room.id}"></label><p data-share-status></p><div><button class="primary-button" data-copy>Copy link</button></div>`;
    this.share.querySelector('[data-close]')!.addEventListener('click', () => this.share.close());
    this.share.querySelector('[data-copy]')!.addEventListener('click', async () => { try { await copyText(location.href, this.share); this.share.querySelector('[data-share-status]')!.textContent = 'Link copied'; } catch { this.share.querySelector('input')!.select(); } });
    this.share.showModal();
  }
  private async cloudRequest(body?: { action: 'open' | 'upload'; id?: string; code?: string; keepLocal?: boolean; overwrite?: boolean }) {
    const response = await fetch('/api/cloud-projects', { method: body ? 'POST' : 'GET', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.error?.message ?? 'The cloud could not be reached. Your local project is retained.'), { code: value.error?.code });
    return value;
  }
  private transferDialog(title: string, message: string, actions: { label: string; run(): Promise<void> }[] = []) {
    const dialog = this.cloudDialog;
    dialog.innerHTML = `<header><h2>${escape(title)}</h2><button data-close aria-label="Close cloud projects">${icon('close')}</button></header><p>${escape(message)}</p><div class="cloud-project-list"></div><div class="cloud-project-actions">${actions.map((action, index) => `<button data-transfer="${index}"${index === actions.length - 1 ? ' class="primary-button"' : ''}>${escape(action.label)}</button>`).join('')}</div><p class="projects-error" role="alert" hidden></p>`;
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    dialog.querySelectorAll<HTMLButtonElement>('[data-transfer]').forEach(button => button.addEventListener('click', async () => {
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]; buttons.forEach(item => item.disabled = true);
      try { await actions[Number(button.dataset.transfer)].run(); }
      catch (error) { const element = dialog.querySelector<HTMLElement>('.projects-error')!; element.textContent = (error as Error).message; element.hidden = false; }
      finally { buttons.forEach(item => item.disabled = false); }
    }));
    if (!dialog.open) dialog.showModal();
  }
  private confirmLocalLeave(): Promise<boolean> {
    return new Promise(resolve => {
      this.transferDialog('Unsaved local changes', 'Local editing has no autosave. Upload to cloud or export a project file before leaving to keep your changes.', [
        { label: 'Discard and leave', run: async () => { resolve(true); this.cloudDialog.close(); } },
        { label: 'Keep editing', run: async () => { this.cloudDialog.close(); } },
      ]);
      this.cloudDialog.addEventListener('close', () => resolve(false), { once: true });
    });
  }
  private async openCloud(identifier: string, keepLocal = false, byCode = false) {
    if (this.room && !await this.leave()) throw new Error('Finish saving the current project before switching.');
    try {
      const room = await this.cloudRequest({ action: 'open', ...(byCode ? { code: identifier } : { id: identifier }), ...(keepLocal ? { keepLocal: true } : {}) });
      await this.activate(room); this.cloudDialog.close(); this.listed = null;
      this.options.notice?.('Downloaded for local editing · Upload to cloud when ready');
    } catch (error) {
      if ((error as { code?: string }).code !== 'local_conflict') throw error;
      this.transferDialog('Keep your local changes', (error as Error).message, [{ label: 'Keep local copy and open cloud', run: () => this.openCloud(identifier, true, byCode) }]);
    }
  }
  async saveNow() { if (this.autosave) await this.flush(); else if (this.canUpload) await this.uploadToCloud(); else await this.download(); }
  async uploadToCloud(overwrite = false) {
    if (!this.canUpload || this.uploading) return;
    if (!this.room || !this.canEdit) throw new Error('Open a project before uploading it.');
    if (!this.options.beforeSwitch()) return;
    this.options.stop();
    this.uploading = true; this.notify();
    try {
      await this.flush(true);
      await this.flushOutputs(this.room);
      await this.updateCover(true, true);
      await this.ensureSession();
      const room = this.room, value = await this.cloudRequest({ action: 'upload', id: room.id, ...(overwrite ? { overwrite: true } : {}) });
      if (this.room === room) room.cloud = value.cloud;
      this.failed = false; this.listed = null;
      this.options.notice?.('Uploaded to cloud');
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (['cloud_conflict', 'cloud_mismatch', 'cloud_missing'].includes(code ?? '')) {
        this.transferDialog('Cloud project has changed', code === 'cloud_conflict' ? 'Someone changed this project since you downloaded it. Replace the cloud project with your local version, or upload a separate copy.' : (error as Error).message, [
          { label: 'Upload as a new project', run: async () => { this.cloudDialog.close(); await this.saveCopy(); await this.uploadToCloud(); } },
          ...(code === 'cloud_conflict' ? [{ label: 'Replace cloud version', run: async () => { this.cloudDialog.close(); await this.uploadToCloud(true); } }] : []),
        ]);
      } else this.transferDialog('Upload could not finish', (error as Error).message, [{ label: 'Try again', run: async () => { this.cloudDialog.close(); await this.uploadToCloud(); } }]);
    } finally { this.uploading = false; this.notify(); }
  }
  async putOutput(output: Omit<ProjectOutput, 'updatedAt'>, data: Blob, target = this.room, progress?: (state: OutputTransfer) => void): Promise<ProjectOutput> {
    if (!target || (!this.autosave && target !== this.room) || (target === this.room && !this.canEdit)) throw new Error('Open a project before saving a result.');
    const stored = { ...output, updatedAt: Date.now() }, key = `${target.code}:${output.id}`;
    const base = this.pendingOutputs.get(key)?.base ?? target.outputs.find(item => item.id === output.id)?.updatedAt ?? 0;
    this.pendingOutputs.set(key, { room: target, output: stored, data, base, progress });
    target.outputs = [stored, ...target.outputs.filter(item => item.id !== output.id)]; this.notify();
    try { if (this.autosave) await this.writeOutput(key); }
    finally { const pending = this.pendingOutputs.get(key); if (pending?.progress === progress && pending) pending.progress = undefined; }
    return target.outputs.find(item => item.id === output.id)!;
  }
  outputTransfer(id: string, room = this.room): OutputTransfer | undefined { return room ? this.pendingOutputs.get(`${room.code}:${id}`)?.transfer : undefined; }
  async retryOutput(id: string): Promise<void> {
    if (!this.room || !this.canEdit) return;
    await this.writeOutput(`${this.room.code}:${id}`);
    await this.retry(false);
  }
  private async writeOutput(key: string): Promise<void> {
    if (this.conflict) throw new Error('A newer version is saved. Download your changes or save a new project.');
    const writing = this.outputWrites.get(key); if (writing) return writing;
    const promise = (async () => {
      let current;
      try {
        while ((current = this.pendingOutputs.get(key))) {
          const { room, data, base, output: { updatedAt: _at, ...metadata } } = current;
          const entry = current, update = (transfer: OutputTransfer) => { entry.transfer = transfer; entry.progress?.(transfer); this.notify(); };
          update({ phase: 'uploading', loaded: 0, total: data.size });
          await this.ensureSession(room);
          const value = await uploadOutput(`/api/projects?code=${encodeURIComponent(room.code)}&output=1`, { 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page, 'x-littletake-output': encodeURIComponent(JSON.stringify(metadata)), 'x-littletake-output-version': String(base) }, data, update);
          if (value.id !== metadata.id) throw new Error('The server did not confirm this file was saved. Retry the upload.');
          if (this.pendingOutputs.get(key) === current) { this.pendingOutputs.delete(key); room.outputs = [value, ...room.outputs.filter(item => item.id !== value.id)]; }
          else { const queued = this.pendingOutputs.get(key); if (queued) queued.base = value.updatedAt; }
        }
      } catch (error) { if (current) { current.transfer = { phase: 'failed', loaded: current.transfer?.loaded ?? 0, total: current.data.size, error: (error as Error).message }; current.progress?.(current.transfer); } this.failed = true; if ((error as { code?: string }).code === 'output_conflict') { this.conflict = true; this.options.stop(); } throw error; }
    })().finally(() => { this.outputWrites.delete(key); this.notify(); });
    this.outputWrites.set(key, promise); return promise;
  }
  private async flushOutputs(room: ProjectRoom, retryFailed = true) {
    for (const [key, entry] of this.pendingOutputs) if (entry.room.id === room.id && (retryFailed || entry.transfer?.phase !== 'failed')) await this.writeOutput(key);
  }
  async output(id: string, room = this.room): Promise<Blob> {
    if (!room) throw new Error('Open a project first.');
    const pending = this.pendingOutputs.get(`${room.code}:${id}`); if (pending) return pending.data;
    const response = await fetch(`/api/projects?code=${encodeURIComponent(room.code)}&output=${encodeURIComponent(id)}`); if (!response.ok) throw new Error('The saved result could not be opened.');
    return response.blob();
  }
  async publishHandoff(archive: Blob, id: string, target = this.room): Promise<HandoffReceipt> {
    if (!target || target !== this.room || !this.canEdit) throw new Error('Open this project before publishing references.');
    await this.flush();
    await this.ensureSession(target);
    const response = await fetch(`/api/handoffs?code=${encodeURIComponent(target.code)}&id=${id}`, { method: 'POST', headers: { 'Content-Type': 'application/zip', 'x-littletake-edit-lease': this.lease, 'x-littletake-edit-page': this.page }, body: archive });
    const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? 'References could not be published. Retry to keep the same publication.');
    target.handoffs = [value, ...(target.handoffs ?? []).filter(item => item.id !== value.id)]; return value;
  }
  async withdrawHandoff(id: string) {
    if (!this.room || !this.canEdit) throw new Error('Open the project before withdrawing a reference link.');
    await this.ensureSession();
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
    await this.updateCover(true);
    let cover: CoverAttachment | undefined;
    if (room.cover) try {
      const response = await fetch('/api/projects?cover=1&code=' + encodeURIComponent(room.code));
      if (response.ok) cover = { data: new Uint8Array(await response.arrayBuffer()), current: room.cover.savedVersion === room.savedVersion && !!this.savedText && coverVisual(project) === coverVisual(JSON.parse(this.savedText)) };
    } catch { /* An unavailable optional image must not prevent downloading the project draft. */ }
    const metadata = new Map(room.outputs.map(output => [output.id, output]));
    for (const entry of this.pendingOutputs.values()) if (entry.room.id === room.id) metadata.set(entry.output.id, entry.output);
    const outputs: { output: ProjectOutput; data: Uint8Array }[] = [];
    for (const output of metadata.values()) outputs.push({ output, data: new Uint8Array(await (await this.output(output.id, room)).arrayBuffer()) });
    const url = URL.createObjectURL(projectArchive({ id: room.id, version: room.contentVersion, project, outputs, cover })), link = document.createElement('a');
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
    const dialog = document.createElement('dialog'); dialog.className = 'project-results-dialog'; dialog.setAttribute('aria-label', 'Renders');
    const outputs = [...this.room.outputs].filter(output => !['style-reference', 'appearance-reference', 'reference-media', 'diagnostic', 'asset-draft'].includes(output.kind)).sort((a,b) => b.updatedAt-a.updatedAt);
    const renders = outputs.filter(output => ['shot-render', 'look-frame', 'storyboard', 'final-video'].includes(output.kind));
    const notes = outputs.filter(output => !renders.includes(output));
    const cards = (items: ProjectOutput[]) => items.map(output => {
      const label = output.kind === 'shot-render' ? (output.mime.startsWith('video/') ? 'Video' : 'Still image') : output.kind === 'storyboard' ? 'AI storyboard' : output.kind === 'look-frame' ? 'Film still' : output.kind === 'final-video' ? 'Finished video' : output.kind === 'video-brief' ? 'Video brief' : 'Reference analysis';
      return `<button data-output="${output.id}"><span>${output.mime.startsWith('video/') ? `${icon('play')}` : renders.includes(output) ? `${icon('image')}` : `${icon('file')}`}</span><div><strong>${escape(output.name)}</strong><small>${label} · ${new Date(output.updatedAt).toLocaleString()}</small></div><span>${icon('external')}</span></button>`;
    }).join('');
    dialog.innerHTML = `<header><div><small>RENDERS</small><h2>${escape(this.options.project().name)}</h2></div><button data-close aria-label="Close renders">${icon('close')}</button></header><p>Your rendered videos and stills, saved with this project.</p><div class="project-results-list">${cards(renders) || '<div class="projects-empty">No renders yet. Use Render to create a video or still image from your shot.</div>'}</div>${notes.length ? `<details class="project-render-notes"><summary>Briefs & reference analyses <span>${notes.length}</span></summary><div class="project-results-list">${cards(notes)}</div></details>` : ''}<div class="project-result-preview" hidden></div><p class="projects-error" hidden role="alert"></p>`;
    const urls: string[] = [];
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { urls.forEach(url => URL.revokeObjectURL(url)); dialog.remove(); });
    dialog.addEventListener('click', async event => {
      const id = (event.target as HTMLElement).closest<HTMLElement>('[data-output]')?.dataset.output; if (!id) return;
      try {
        const output = outputs.find(value => value.id === id)!, data = await this.output(id);
        if (output.kind === 'reference-analysis') { dialog.close(); this.options.result?.(output, data); return; }
        const preview = dialog.querySelector<HTMLElement>('.project-result-preview')!; preview.hidden = false; preview.replaceChildren();
        if (output.kind === 'shot-render' || output.kind === 'final-video') {
          const url = URL.createObjectURL(data); urls.push(url);
          const media = document.createElement(output.mime.startsWith('video/') ? 'video' : 'img'); media.src = url;
          if (media instanceof HTMLVideoElement) { media.controls = true; media.preload = 'metadata'; } else media.alt = output.name;
          const link = document.createElement('a'); link.href = url; link.download = output.name + '.' + output.mime.split('/')[1]; link.textContent = media instanceof HTMLVideoElement ? 'Download video' : 'Download image';
          preview.append(media, link); return;
        }
        const value = JSON.parse(await data.text());
        if (output.kind === 'storyboard') {
          if (value.version === 2) {
            const draft = storyboardDraftSchema.parse(value), caption = document.createElement('p');
            caption.textContent = draft.result ? `2 × 2 storyboard · ${draft.result.panels.map(panel => panel.at.toFixed(2) + ' s').join(' · ')}` : 'No image generated yet. Open Render → Storyboards → AI storyboard to continue.';
            preview.append(caption);
            if (draft.result) {
              const image = new Image(); image.src = draft.result.image; image.alt = 'Generated 2 by 2 storyboard';
              const link = document.createElement('a'); link.href = image.src; link.download = `${output.name}.${image.src.slice(11, image.src.indexOf(';')).replace('jpeg', 'jpg')}`; link.textContent = 'Download original image';
              link.onclick = event => { event.preventDefault(); downloadStoryboardImage(image.src, link.download); }; preview.append(image, link);
            }
            return;
          }
          const draft = legacyStoryboardDraftSchema.parse(value), frames = [];
          for (const panel of draft.panels) {
            if (!panel.frameId) continue;
            const frame = JSON.parse(await (await this.output(panel.frameId)).text());
            // A changed timestamp or instruction must not relabel an older generation.
            if (Math.abs(frame.time - draft.shot.start - panel.at) > .00001 || (frame.note ?? '') !== panel.note.trim()) continue;
            frames.push({ at: panel.at, previs: frame.previs as string, look: frame.image as string });
          }
          const caption = document.createElement('p'); caption.textContent = `${frames.length} / ${draft.panels.length} saved panels. Open Render → Storyboards → AI storyboard to continue editing.`; preview.append(caption);
          if (frames.length) for (const [index, page] of (await renderStoryboards(draft.shot, frames, new AbortController().signal, 'ai')).entries()) {
            if (!dialog.open) return;
            const image = new Image(); image.src = page.image; image.alt = `AI storyboard page ${index + 1}`;
            const link = document.createElement('a'); link.href = page.image; link.download = `${output.name}-${index + 1}.jpg`; link.textContent = 'Download storyboard page'; link.onclick = event => { event.preventDefault(); downloadStoryboardImage(page.image, link.download); }; preview.append(image, link);
          }
          return;
        }
        if (output.kind === 'look-frame') { const image = new Image(); image.src = value.image; image.alt = output.name; preview.append(image); const link = document.createElement('a'); link.href = value.image; link.download = output.name + '.' + value.image.slice(11, value.image.indexOf(';')).replace('jpeg', 'jpg'); link.textContent = 'Download image'; link.onclick = event => { event.preventDefault(); downloadStoryboardImage(value.image, link.download); }; preview.append(link); }
        else { const text = document.createElement('p'); text.textContent = value.brief.promptText ?? value.brief.prompt; text.style.whiteSpace = 'pre-wrap'; preview.append(text); }
      } catch (error) { const message = dialog.querySelector<HTMLElement>('.projects-error')!; message.hidden = false; message.textContent = (error as Error).message; }
    });
    document.body.append(dialog); dialog.showModal();
  }
}
