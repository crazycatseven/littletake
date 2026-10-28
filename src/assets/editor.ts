import './editor.css';
import './toolkit/inspector.css';
import { AssetEditorStage } from './editor-stage';
import { AssetDraftStore, assetDraft, draftFromAsset, editAsset, reviseAsset, type AssetDraft, type AssetEdit, type AssetEditorState, type AssetProposal } from './edit';
import { constructionFields, constructionAction, constructionChange } from './toolkit/inspector';
import { drivenProperties } from './toolkit/edits';
import { evaluateAsset, recipeBounds, validateAsset, type AssetDefinition } from './model';
import { bindComponents, componentInspector } from '../components/inspector';
import { createPrefabDialog } from './dialog';
import type { ToolMode, Vec3 } from '../types';

const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
const number = (v: number) => String(Math.round(v * 10000) / 10000);
interface Options {
  host: HTMLElement;
  onClose(): void;
  asset: AssetDefinition;
  onSaved(asset: AssetDefinition): string;
}
export class AssetEditor {
  private root: HTMLElement;
  private panes: HTMLElement[] = [];
  private restores: Array<() => void> = [];
  private returnFocus = document.activeElement as HTMLElement | null;
  private stage!: AssetEditorStage;
  private state: AssetEditorState;
  private store: AssetDraftStore;
  private history: AssetDraft[] = [];
  private cursor = 0;
  private selected: string | null = null;
  private tab: 'properties' | 'expert' = 'properties';
  private busy = false;
  private closed = false;
  private controller?: AbortController;
  private previewController?: AbortController;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private previewUrl?: string;
  private storageFailed = false;
  private exportedState?: string;
  private componentTesting = false;
  constructor(private options: Options) {
    this.store = new AssetDraftStore(localStorage, options.asset);
    this.state = this.store.read() ?? { base: structuredClone(options.asset), draft: draftFromAsset(options.asset), messages: [] };
    if (!this.state.proposal && JSON.stringify(this.state.draft) === JSON.stringify(draftFromAsset(this.state.base))) {
      this.state.base = structuredClone(options.asset); this.state.draft = draftFromAsset(options.asset);
    }
    this.history = [structuredClone(this.state.draft)];
    this.root = options.host;
    if (this.root.classList.contains('asset-mode')) throw new Error('An asset is already open.');
    this.root.classList.add('asset-mode');
    const toolIcon = (path: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
    try {
      this.mount('.history-actions', 'ae-header-controls', `<button class="icon-button" data-ae="undo" aria-label="Undo asset edit" title="Undo asset edit · Ctrl Z">↶</button><button class="icon-button" data-ae="redo" aria-label="Redo asset edit" title="Redo asset edit · Ctrl Shift Z">↷</button>`);
      this.mount('.header-actions', 'ae-header-controls', `<button data-ae="export-draft">Export Draft</button><button data-ae="publish-copy">Create Independent Prefab…</button><button class="primary-button" data-ae="publish" title="Update this prefab and linked instances; preserve instance transforms and motion">Save Prefab</button>`);
      this.mount('.library-panel', 'ae-tree', `<div class="library-tabs"><button role="tab" aria-selected="true">Hierarchy <span data-ae-count></span></button></div><div class="outliner"><button class="object-row ae-root" data-ae="root"><i aria-hidden="true">◇</i><span data-ae-title></span></button><div data-ae-tree role="tree" aria-label="Prefab parts"></div></div><div class="ae-add"><select aria-label="New part shape"><option value="cube">Cube</option><option value="sphere">Sphere</option><option value="cylinder">Cylinder</option><option value="cone">Cone</option><option value="group">Group</option></select><button data-ae="add">＋ Part</button></div>`);
      this.mount('.stage-panel', 'ae-center', `<div class="ae-stage viewport"></div><div class="viewport-heading"><div class="transform-tools" role="toolbar" aria-label="Transform tools"><button data-ae-tool="translate" class="active" aria-label="Move tool" title="Move · G">${toolIcon('<path d="M12 3v18M3 12h18m-3-3 3 3-3 3M9 6l3-3 3 3M6 9l-3 3 3 3m3 3 3 3 3-3"/>')}<span>Move</span></button><button data-ae-tool="rotate" aria-label="Rotate tool" title="Rotate · R">${toolIcon('<path d="M19 7a8 8 0 1 0 1 8M19 3v5h-5"/>')}<span>Rotate</span></button><button data-ae-tool="scale" aria-label="Scale tool" title="Size · S">${toolIcon('<path d="M4 15v5h5M20 9V4h-5M4 20l6-6m10-10-6 6"/>')}<span>Scale</span></button></div><div><button data-view="front">Front</button><button data-view="side">Side</button><button data-view="top">Top</button><button data-view="perspective">Focus</button></div></div><nav class="ae-context" aria-label="Editing path"><button data-ae="close" aria-label="Return to scene">← Scene</button><span aria-hidden="true">/</span><strong data-ae-title></strong><span class="ae-state" data-ae-state></span></nav><section class="shot-panel ae-views" aria-label="Asset geometry preview"><div class="shot-heading"><h2>Asset Preview</h2><button class="icon-button" data-ae="expand-views" aria-label="Expand asset preview" aria-expanded="false">⛶</button></div><img alt="Asset orthographic views"/><div class="shot-footer"><span data-ae-render-status>Generating…</span><button data-ae="reset-tests">Reset Preview</button></div></section><div class="ae-measure viewport-caption" aria-live="polite"></div>`);
      this.mount('.properties-drawer', 'ae-sidebar', `<div class="panel-tabs ae-tabs" role="tablist" aria-label="Asset tools"><button id="assetMuseTab" role="tab" data-tab="expert" aria-selected="false" aria-controls="assetExpertPanel">✧ Muse</button><button id="assetInspectorTab" role="tab" data-tab="properties" aria-selected="true" aria-controls="assetInspectorPanel">Inspector</button><span class="model-pill">Asset Expert</span></div><section id="assetInspectorPanel" class="ae-properties inspector-panel" role="tabpanel" aria-labelledby="assetInspectorTab"></section><section id="assetExpertPanel" class="ae-expert" role="tabpanel" aria-labelledby="assetMuseTab" hidden><div class="ae-chat"></div><div class="ae-proposal" hidden></div><form class="ae-compose"><label for="assetExpertPrompt">Edit this prefab</label><textarea id="assetExpertPrompt" aria-label="Asset expert prompt" maxlength="3000" placeholder="Widen the base, keep all four wheels, and check that the supports connect."></textarea><div><small>Asset conversation · History saved</small><button class="primary-button" type="submit">Send</button><button type="button" data-ae="cancel-expert" hidden>Stop</button></div></form></section>`);
      this.mount('.status-bar', 'ae-status', '<span data-ae-feedback role="status"></span><button data-ae="reload-base" hidden>Discard Draft and Reload Prefab</button><span>Prefab Mode · Save updates linked instances</span>');
      const timeline = this.$('#timelinePanel'), wasInert = timeline.inert;
      timeline.inert = true;
      const note = document.createElement('span'); note.className = 'ae-timeline-note'; note.textContent = 'Prefab Mode · Return to the scene to edit the timeline'; timeline.append(note);
      this.restores.push(() => { timeline.inert = wasInert; note.remove(); });
      const projectName = this.$<HTMLInputElement>('#projectName'), wasReadOnly = projectName.readOnly;
      projectName.readOnly = true; this.restores.push(() => { projectName.readOnly = wasReadOnly; });
      this.stage = new AssetEditorStage(this.$('.ae-stage'), id => { this.selected = id; this.tab = 'properties'; this.$('.ae-properties').scrollTop = 0; this.render(); }, edits => this.edit(edits));
      this.stage.setDraft(this.current, null, true);
      this.$<HTMLFormElement>('.ae-compose').onsubmit = e => { e.preventDefault(); void this.askExpert(); };
      window.addEventListener('keydown', this.keydown); this.restores.push(() => window.removeEventListener('keydown', this.keydown));
      this.render(); this.queuePreview(); this.$('#assetInspectorTab').focus();
      const stale = JSON.stringify(this.state.base) !== JSON.stringify(options.asset);
      this.$('[data-ae="reload-base"]').hidden = !stale;
      this.feedback(stale ? 'This prefab was updated elsewhere. Your draft is retained. Save it as a new prefab or discard it and reload.' : this.store.read() ? 'Local draft and asset conversation restored.' : 'Save updates the prefab and all linked instances, preserving their transforms and motion.');
    } catch (error) { this.stage?.dispose(); this.restoreShell(); throw error; }
  }
  /** Reuse the existing shell. Scene DOM stays connected so its state and handlers survive. */
  private mount(selector: string, className: string, html: string) {
    const host = this.$(selector), covered = Array.from(host.children) as HTMLElement[];
    covered.forEach(child => child.classList.add('ae-scene-content'));
    this.restores.push(() => covered.forEach(child => child.classList.remove('ae-scene-content')));
    const pane = document.createElement('div'); pane.className = 'ae-pane ' + className; pane.innerHTML = html; host.append(pane); this.panes.push(pane);
    pane.addEventListener('click', this.click); pane.addEventListener('change', this.change);
    pane.addEventListener('input', e => e.stopPropagation()); pane.addEventListener('keydown', this.keydown);
  }
  private restoreShell() {
    this.panes.forEach(pane => pane.remove()); this.panes = [];
    this.restores.reverse().forEach(restore => restore()); this.restores = [];
    this.root.classList.remove('asset-mode');
  }
  private keydown = (e: KeyboardEvent) => {
    e.stopPropagation(); const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && ['z','y','s'].includes(key)) {
      e.preventDefault(); if (this.busy) return;
      if (key === 's') { if (!this.locked) void this.publish(); }
      else this.undo(key === 'y' || e.shiftKey ? 1 : -1);
    } else if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) && !this.componentTesting) {
      const tool = ({g:'translate',r:'rotate',s:'scale'} as const)[key as 'g'|'r'|'s'];
      if (tool && !this.locked) { e.preventDefault(); this.setTool(tool); }
    }
  };
  private setTool(tool: ToolMode) {
    this.stage.setTool(tool); this.root.querySelectorAll<HTMLButtonElement>('[data-ae-tool]').forEach(b => { const active = b.dataset.aeTool === tool; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); });
  }
  private $<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  private get current(): AssetDraft { return this.state.proposal?.draft ?? this.state.draft; }
  private get locked(): boolean { return this.busy || !!this.state.proposal; }
  private feedback(message: string, error = false) { const el = this.$('[data-ae-feedback]'); el.textContent = message; el.classList.toggle('error', error); }
  private persist(): boolean {
    try { this.store.save(this.state); this.storageFailed = false; return true; }
    catch (error) { this.storageFailed = true; this.feedback('Draft was not saved: ' + (error as Error).message + ' Export the draft before returning to the scene.', true); return false; }
  }
  private commit(draft: AssetDraft) {
    this.state.draft = assetDraft(draft); this.componentTesting = false;
    this.history = this.history.slice(0, this.cursor + 1); this.history.push(structuredClone(this.state.draft)); if (this.history.length > 60) this.history.shift(); this.cursor = this.history.length - 1;
    this.stage.setDraft(this.current, this.selected); this.render(); this.queuePreview(); if (this.persist()) this.feedback('Draft saved · Scene unchanged');
  }
  private edit(edits: AssetEdit[]) {
    if (this.locked) return;
    try {
      const draft=editAsset(this.state.draft,edits);
      if(edits.some(e=>e.type==='make_unique'||e.type==='duplicate_subtree'||e.type==='group_parts')){
        const before=new Set(this.state.draft.parts.map(p=>p.id));
        this.selected=draft.parts.find(p=>!before.has(p.id)&&(!p.parentId||before.has(p.parentId)))?.id??this.selected;
      }
      this.commit(draft);
    }
    catch (error) { this.feedback((error as Error).message, true); this.stage.setDraft(this.current, this.selected); this.renderProperties(); }
  }
  private undo(delta: number) {
    if (this.locked) return; const next = this.cursor + delta; if (next < 0 || next >= this.history.length) return;
    this.cursor = next; this.state.draft = structuredClone(this.history[next]); this.stage.setDraft(this.current, this.selected); this.render(); this.queuePreview(); if (this.persist()) this.feedback(delta < 0 ? 'Asset edit undone' : 'Asset edit redone');
  }
  private render() {
    this.componentTesting = false;
    const draft = this.current, evaluated = evaluateAsset(draft); if (!evaluated.parts.some(p => p.id === this.selected)) this.selected = null;
    this.root.querySelectorAll<HTMLElement>('[data-ae-title]').forEach(el => el.textContent = draft.name); this.$('[data-ae-state]').textContent = this.state.proposal ? 'Expert Proposal' : 'Prefab';
    this.$('[data-ae-count]').textContent = String(evaluated.parts.filter(p=>p.kind!=='group').length);
    const rows = (parent: string | null, depth: number): string => evaluated.parts.filter(p => p.parentId === parent).map(p => `<button role="treeitem" aria-selected="${p.id === this.selected}" data-part="${esc(p.id)}" style="padding-left:${28 + depth * 14}px" class="object-row ${p.id === this.selected ? 'selected' : ''}"><i aria-hidden="true">${p.generatedBy.length ? '↪' : p.kind === 'group' ? '▱' : p.joint ? '⟳' : '◇'}</i><span>${esc(p.name)}</span><small>${p.generatedBy.length ? esc(p.id.split('~').slice(1).map(s=>s.split('.').at(-1)).join(' · ').toUpperCase()) : p.kind}</small></button>${rows(p.id, depth + 1)}`).join('');
    this.$('[data-ae-tree]').innerHTML = rows(null, 0); this.stage.setEditable(!this.locked); this.stage.select(this.selected);
    this.$('.ae-properties').hidden = this.tab !== 'properties'; this.$('.ae-expert').hidden = this.tab !== 'expert';
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => { const active = b.dataset.tab === this.tab; b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1; });
    this.$('[data-ae="root"]').classList.toggle('selected', !this.selected);
    this.$<HTMLButtonElement>('[data-ae="undo"]').disabled = this.locked || this.cursor === 0; this.$<HTMLButtonElement>('[data-ae="redo"]').disabled = this.locked || this.cursor >= this.history.length - 1;
    this.$<HTMLButtonElement>('[data-ae="add"]').disabled = this.locked || draft.parts.length >= 2048;
    this.root.querySelectorAll<HTMLButtonElement>('[data-ae-tool], [data-ae="publish"], [data-ae="publish-copy"], [data-ae="reload-base"]').forEach(b => b.disabled = this.locked);
    this.$<HTMLTextAreaElement>('#assetExpertPrompt').disabled = this.locked; this.$<HTMLButtonElement>('.ae-compose [type="submit"]').disabled = this.locked;
    this.$('[data-ae="cancel-expert"]').hidden = !this.controller;
    const bounds = recipeBounds(draft);
    this.$('.ae-measure').innerHTML = `<strong>${bounds.size.map(n => n.toFixed(3)).join(' × ')} <small>m</small></strong><span>X width · Y height · Z depth</span><span>Bounds min ${bounds.min.map(n => n.toFixed(2)).join(', ')} · max ${bounds.max.map(n => n.toFixed(2)).join(', ')}</span>`;
    this.renderProperties(); this.renderChat();
  }
  private vectors(label: string, key: string, values: Vec3, min: number, max: number, step = .01) {
    return `<div class="property-group"><span class="property-label">${label}</span><div class="vector-inputs">${values.map((v, i) => `<label class="vector-field"><span class="axis-${['x','y','z'][i]}">${['X','Y','Z'][i]}</span><input type="number" data-vector="${key}" data-index="${i}" aria-label="${label} ${['X','Y','Z'][i]}" min="${min}" max="${max}" step="${step}" value="${number(v)}"/></label>`).join('')}</div></div>`;
  }
  private renderProperties() {
    const draft = this.current, p = evaluateAsset(draft).parts.find(p => p.id === this.selected);
    const open = Array.from(this.$('.ae-properties').querySelectorAll<HTMLDetailsElement>('details[open][data-tk-key]')).map(e=>e.dataset.tkKey);
    const scroll = this.$('.ae-properties').scrollTop;
    const select = (label: string, key: string, values: Record<string, string>, selected: string) => `<label>${label}<select data-field="${key}" aria-label="${label}">${Object.entries(values).map(([v,l]) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    this.$('.ae-properties').innerHTML = p ? `<div class="inspector-title"><span class="entity-type">◇ ASSET PART</span><small class="ae-part-id">${esc(p.id)}</small></div><input class="entity-name" data-field="name" aria-label="Part name" value="${esc(p.name)}" maxlength="120"/>${select('Shape','kind',{ cube:'Cube',sphere:'Sphere',cylinder:'Cylinder',cone:'Cone',group:'Group' },p.kind)}${select('Parent part','parentId',{ '':'Asset origin', ...Object.fromEntries(draft.parts.filter(q => q.id !== p.id).map(q => [q.id,q.name])) },p.parentId ?? '')}<small class="ae-hint">Transforms remain local to the parent.</small>${this.vectors('Position','position',p.position,-1000,1000)}${this.vectors('Rotation','rotation',p.rotation,-360,360,1)}${p.kind==='group'?'':this.vectors('Size','size',p.size,.005,100)}<label class="ae-color">Color<input type="color" data-field="color" aria-label="Part color" value="${p.color}"/></label><div class="ae-divider"></div>${select('Joint','jointType',{ '':'Fixed',hinge:'Hinge',wheel:'Wheel' },p.joint?.type ?? '')}${p.joint ? `${select('Rotation axis','jointAxis',{ x:'X',y:'Y',z:'Z' },p.joint.axis)}${this.vectors('Pivot','pivot',p.joint.pivot,-100,100)}<div class="ae-limits"><label>Minimum angle<input type="number" data-field="jointMin" aria-label="Minimum angle" min="-360" max="360" value="${p.joint.min}"/></label><label>Maximum angle<input type="number" data-field="jointMax" aria-label="Maximum angle" min="-360" max="360" value="${p.joint.max}"/></label></div><label>Preview · <span data-joint-angle>0°</span><input type="range" aria-label="Joint preview angle" min="${p.joint.min}" max="${p.joint.max}" step="1" value="${Math.max(p.joint.min, Math.min(p.joint.max, 0))}" data-joint-test/></label><small class="ae-hint">Preview only; the draft pose stays unchanged.</small>` : ''}<div class="ae-part-actions"><button data-ae="duplicate-part">Duplicate Part</button><button data-ae="delete-part">Delete Part and Children</button></div>`
      : `<div class="inspector-title"><span class="entity-type">◇ PREFAB ASSET</span></div><input class="entity-name" data-meta="name" aria-label="Prefab name" maxlength="120" value="${esc(draft.name)}"/><label>Description<textarea data-meta="description" aria-label="Prefab description" maxlength="1200">${esc(draft.description)}</textarea></label><label>Tags<input data-meta="tags" aria-label="Prefab tags" value="${esc(draft.tags.join(', '))}"/></label><div class="ae-divider"></div>${this.componentFields()}<small class="ae-hint">Defaults apply to new instances. Existing instances retain their own settings.${draft.template?.track ? ' Template motion and recorded samples are retained.' : ''}</small><div class="ae-divider"></div><p class="ae-hint">Bounds come from the actual geometry. Use the dimensions and views to review the shape with the asset expert.</p>`;
    (p && !p.generatedBy.length ? this.$('.ae-properties') : this.$('.ae-properties .entity-name')).insertAdjacentHTML(p && !p.generatedBy.length?'beforeend':'afterend',constructionFields(draft,this.selected));
    this.$('.ae-properties').querySelectorAll<HTMLDetailsElement>('details[data-tk-key]').forEach(e=>{ if(open.includes(e.dataset.tkKey))e.open=true; });
    this.$('.ae-properties').scrollTop = scroll;
    this.$('.ae-properties').querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea,button').forEach(el => { if (!el.closest('.component-section')) el.disabled = this.locked || (!!p?.generatedBy.length && !el.closest('.tk-section')); });
    if (!p) {
      const owner = {kind:'asset' as const, components:structuredClone(draft.template?.components ?? [])};
      bindComponents(this.$('.ae-properties'), owner, () => this.edit([{type:'set_components',components:owner.components}]), () => {
        this.componentTesting = !this.componentTesting; this.stage.testComponent(this.componentTesting); this.renderProperties();
      });
    }
    if(p) this.$('.ae-properties').querySelectorAll<HTMLInputElement>('[data-vector]').forEach(input=>{ if(drivenProperties(draft,p.id).includes((input.dataset.vector+'.'+['x','y','z'][Number(input.dataset.index)]) as any)){ input.disabled=true; input.title='Driven by a parameter or anchor'; } });
    const slider = this.$<HTMLInputElement>('[data-joint-test]');
    if(slider)slider.disabled=false;
    if (slider && p) slider.oninput = () => { this.stage.testJoint(p.id, Number(slider.value)); this.$('[data-joint-angle]').textContent = slider.value + '°'; };
  }
  private componentFields(): string {
    return componentInspector({kind:'asset',components:this.current.template?.components}, this.locked || this.componentTesting, this.componentTesting, true);
  }
  private renderChat() {
    this.$('.ae-chat').innerHTML = this.state.messages.length ? this.state.messages.map(m => `<article class="${m.role} ${m.error ? 'error' : ''}"><small>${m.role === 'user' ? 'You' : 'Asset Expert'}</small><p>${esc(m.text)}</p>${m.jobId ? `<a href="/api/assets?jobId=${encodeURIComponent(m.jobId)}" target="_blank" rel="noopener">View input, tools, and result ↗</a>${m.error ? `<button data-recover="${esc(m.jobId)}" ${this.locked ? 'disabled' : ''}>Inspect unfinished draft</button>` : ''}` : ''}</article>`).join('') : '<div class="ae-chat-empty"><span>✧</span><h3>Refine this prefab</h3><p>The expert can inspect parts, edit the draft, measure dimensions, and review rendered views. Preview each proposal before applying it.</p></div>';
    if (this.busy && this.controller) this.$('.ae-chat').insertAdjacentHTML('beforeend','<article><small>Asset Expert</small><p>Editing, measuring, and reviewing rendered views…</p></article>');
    const proposal = this.state.proposal; this.$('.ae-proposal').hidden = !proposal;
    if (proposal) this.$('.ae-proposal').innerHTML = `<strong>${proposal.incomplete ? 'Intermediate draft · Review incomplete' : proposal.approved ? 'Expert review complete' : 'Expert found unresolved issues'}</strong><p>${proposal.incomplete ? 'This task stopped before the final expert review. Inspect the draft before using it.' : 'The viewport shows the proposal. You can keep editing after accepting it.'}</p><button data-ae="accept" class="primary-button">${proposal.incomplete ? 'Use Unreviewed Draft' : 'Use This Draft'}</button><button data-ae="reject">Discard Proposal</button>`;
    this.$('.ae-chat').scrollTop = this.$('.ae-chat').scrollHeight;
  }
  private click = (event: MouseEvent) => {
    event.stopPropagation(); const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button || button.disabled) return;
    if(button.dataset.tk){
      if(this.locked)return;
      try { if(button.dataset.tk==='source'){this.selected=evaluateAsset(this.current).parts.find(p=>p.id===this.selected)!.sourceId;this.render();}
        else {const edits=constructionAction(button,this.current,this.selected);if(edits?.length)this.edit(edits);} } catch(error){this.feedback((error as Error).message,true);} return;
    }
    if (button.dataset.recover) { void this.recover(button.dataset.recover); return; }
    if (button.dataset.part) { this.selected = button.dataset.part; this.tab = 'properties'; this.componentTesting = false; this.$('.ae-properties').scrollTop = 0; this.render(); return; }
    if (button.dataset.tab) { this.tab = button.dataset.tab as typeof this.tab; this.render(); return; }
    if (button.dataset.aeTool) { this.setTool(button.dataset.aeTool as ToolMode); return; }
    if (button.dataset.view) { this.stage.view(button.dataset.view as 'front'); return; }
    switch (button.dataset.ae) {
      case 'close': this.close(); break;
      case 'export-draft': {
        const text = JSON.stringify(this.state), url = URL.createObjectURL(new Blob([text], { type: 'application/json' })), anchor = document.createElement('a');
        anchor.href = url; anchor.download = `${this.state.base.id}.asset-draft.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.exportedState = text; this.feedback('Draft, proposals, and asset conversation exported.'); break;
      }
      case 'root': this.selected = null; this.tab = 'properties'; this.componentTesting = false; this.$('.ae-properties').scrollTop = 0; this.stage.resetTests(); this.render(); break;
      case 'expand-views': { const expanded = this.$('.ae-views').classList.toggle('expanded'); button.setAttribute('aria-expanded', String(expanded)); button.setAttribute('aria-label', expanded ? 'Collapse asset preview' : 'Expand asset preview'); break; }
      case 'undo': this.undo(-1); break; case 'redo': this.undo(1); break;
      case 'publish': void this.publish(); break;
      case 'publish-copy': void this.publish(true); break;
      case 'reload-base': void this.reloadBase(); break;
      case 'reset-tests': this.componentTesting = false; this.stage.resetTests(); this.renderProperties(); break;
      case 'add': { const id = 'part-' + crypto.randomUUID(); this.selected = id; this.edit([{ type:'add_part', part: { id, name:'New part', parentId:null, kind:this.$<HTMLSelectElement>('[aria-label="New part shape"]').value as 'cube', position:[0,.25,0], rotation:[0,0,0], size:[.5,.5,.5], color:'#b7c5ae', joint:null } }]); break; }
      case 'duplicate-part': if(this.selected)this.edit([{type:'duplicate_subtree',partId:this.selected}]); break;
      case 'delete-part': if (this.selected) this.edit([{ type:'remove_part',id:this.selected }]); break;
      case 'cancel-expert': this.controller?.abort(); break;
      case 'accept': { const proposal = this.state.proposal; if (!proposal) break; delete this.state.proposal; this.state.messages.push({ role:'user',text:proposal.incomplete ? 'Manually accepted an intermediate draft before final expert review.' : 'Accepted this proposal as the draft.' }); this.commit(proposal.draft); break; }
      case 'reject': delete this.state.proposal; this.state.messages.push({ role:'user',text:'Discarded the proposal and kept the previous draft.' }); this.stage.setDraft(this.current, this.selected); this.render(); this.queuePreview(); this.persist(); break;
    }
  };
  private change = (event: Event) => {
    event.stopPropagation(); if (this.locked) return;
    const input = event.target as HTMLInputElement, p = this.state.draft.parts.find(p => p.id === this.selected);
    if(input.dataset.tkField||input.dataset.tkAxis){ try{const edits=constructionChange(input,this.current,this.selected);if(edits?.length)this.edit(edits);}catch(error){this.feedback((error as Error).message,true);this.renderProperties();}return; }
    if (input.dataset.meta) { const key = input.dataset.meta; this.edit([{ type:'set_metadata', changes:{ [key]: key === 'tags' ? input.value.split(/[,，]/).map(s=>s.trim()).filter(Boolean) : input.value } }]); }
    else if (p && input.dataset.vector) {
      const key = input.dataset.vector, values = [...(key === 'pivot' ? p.joint!.pivot : p[key as 'position'|'rotation'|'size'])] as Vec3; const index=Number(input.dataset.index); values[index] = Number(input.value) - (key==='position'&&!p.parentId ? this.state.draft.construction?.offset[index]??0 : 0);
      this.edit([{ type:'set_part', id:p.id, changes:key === 'pivot' ? { joint:{ ...p.joint!,pivot:values } } : { [key]:values } }]);
    } else if (p && input.dataset.field) {
      const field = input.dataset.field; let changes: Record<string, unknown>;
      if (field === 'jointType') changes = { joint: input.value ? { type:input.value, pivot:[0,0,0],axis:'y',min:0,max:input.value === 'wheel' ? 360 : 90 } : null };
      else if (field.startsWith('joint')) changes = { joint:{ ...p.joint, [field === 'jointAxis' ? 'axis' : field === 'jointMin' ? 'min' : 'max']:field === 'jointAxis' ? input.value : Number(input.value) } };
      else changes = { [field]:field === 'parentId' ? input.value || null : input.value };
      this.edit([{ type:'set_part', id:p.id, changes }]);
    }
  };
  private queuePreview() {
    clearTimeout(this.previewTimer); this.previewController?.abort(); this.$('[data-ae-render-status]').textContent = 'Updating…';
    this.previewTimer = setTimeout(() => void this.preview(), 250);
  }
  private async preview() {
    const controller = new AbortController(); this.previewController = controller;
    try {
      const response = await fetch('/api/assets', { method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify({ action:'preview',base:this.state.base,draft:this.current }),signal:controller.signal });
      if (!response.ok) throw new Error('Asset views are temporarily unavailable'); const blob = await response.blob(); if (controller.signal.aborted || this.closed) return;
      if (this.previewUrl) URL.revokeObjectURL(this.previewUrl); this.previewUrl = URL.createObjectURL(blob); this.$<HTMLImageElement>('.ae-views img').src = this.previewUrl; this.$('[data-ae-render-status]').textContent = 'Matches current geometry';
    } catch (error) { if (!controller.signal.aborted && !this.closed) this.$('[data-ae-render-status]').textContent = (error as Error).message; }
  }
  private async askExpert() {
    if (this.locked) return; const prompt = this.$<HTMLTextAreaElement>('#assetExpertPrompt').value.trim(); if (!prompt) return;
    const history = this.state.messages.slice(-16).map(({role,text})=>({role,text})); this.state.messages.push({ role:'user',text:prompt }); if (!this.persist()) return;
    this.$<HTMLTextAreaElement>('#assetExpertPrompt').value = ''; this.busy = true; this.controller = new AbortController(); this.stage.resetTests(); this.render(); this.feedback('The asset expert is working. The scene stays unchanged.');
    try {
      const response = await fetch('/api/assets', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ action:'expert',base:this.state.base,draft:this.state.draft,prompt,history }),signal:this.controller.signal });
      const data = await response.json(); if (!response.ok) { this.state.messages.push({ role:'assistant',text:data.error?.message ?? 'Expert request failed.',error:true,jobId:data.error?.jobId }); throw new Error(data.error?.message ?? 'Expert request failed.'); }
      if (this.closed || this.controller.signal.aborted) return;
      const proposal: AssetProposal = { draft:assetDraft(data.draft),approved:!!data.approved,summary:data.summary,jobId:data.jobId };
      this.state.proposal = proposal; this.state.messages.push({ role:'assistant',text:proposal.summary,jobId:proposal.jobId }); this.stage.setDraft(this.current,this.selected); this.queuePreview(); this.feedback('Proposal ready for preview. Accept it to continue editing.');
    } catch (error) {
      const message = this.controller.signal.aborted ? 'Request stopped. The original draft is retained.' : (error as Error).message;
      if (this.state.messages.at(-1)?.role === 'user') this.state.messages.push({ role:'assistant',text:message,error:true });
      if (!this.closed) this.feedback(message,true);
    } finally { this.busy = false; this.controller = undefined; this.persist(); if (!this.closed) this.render(); }
  }
  private async publish(copy = false) {
    if (this.locked || !this.persist()) return; this.busy = true; this.render(); this.feedback('Saving prefab…');
    const base = this.state.base;
    try {
      let asset: AssetDefinition;
      if (copy) {
        const draft = assetDraft({...this.state.draft,name:(this.state.draft.name+' Copy').slice(0,120)});
        const created=await createPrefabDialog(reviseAsset({...base,id:'asset-'+crypto.randomUUID(),createdAt:new Date().toISOString()},draft));
        if(!created){this.feedback('Creation cancelled. Your draft is retained.');return;}asset=created.asset;
      }else{
        const response = await fetch('/api/assets',{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save',base,draft:this.state.draft}) });
        if(response.status===409)this.$('[data-ae="reload-base"]').hidden=false;
        const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? 'Save failed.');asset = validateAsset(data.asset);
      }
      let message: string;
      try { message = this.options.onSaved(asset); } catch (error) { message = (error as Error).message + ' The prefab is saved in the library.'; }
      if (copy) {
        this.store.save({...this.state,draft:draftFromAsset(base)});
        this.store = new AssetDraftStore(localStorage,asset);
      }
      this.state = {base:asset,draft:draftFromAsset(asset),messages:this.state.messages};
      const persisted=this.persist();
      this.stage.setDraft(this.current,this.selected); this.queuePreview();
      this.history = [structuredClone(this.state.draft)]; this.cursor = 0;this.$('[data-ae="reload-base"]').hidden=true;
      if(persisted)this.feedback(`${copy?'New prefab created':'Prefab saved'}. ${message}`);
    } catch (error) { this.feedback((error as Error).message,true); }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }
  private async reloadBase() {
    if (this.locked) return; this.busy=true;this.render();
    try {
      const response=await fetch('/api/assets?id='+encodeURIComponent(this.state.base.id)),data=await response.json();if(!response.ok)throw new Error(data.error?.message??'Could not load prefab');
      const asset=validateAsset(data);this.state={base:asset,draft:draftFromAsset(asset),messages:this.state.messages};
      this.history=[structuredClone(this.state.draft)];this.cursor=0;
      this.stage.setDraft(this.current,this.selected);this.queuePreview();if(this.persist()){this.$('[data-ae="reload-base"]').hidden=true;this.feedback('Saved prefab loaded. Asset conversation retained.');}
    } catch(error){this.feedback((error as Error).message,true);}
    finally{this.busy=false;this.render();}
  }
  private async recover(jobId: string) {
    if (this.locked) return; this.busy = true; this.render();
    try {
      const response = await fetch('/api/assets?jobId=' + encodeURIComponent(jobId)); if (!response.ok) throw new Error('Could not read the task record.'); const job = await response.json();
      if (job.kind !== 'asset_revision' || JSON.stringify(validateAsset(job.base)) !== JSON.stringify(this.state.base) || JSON.stringify(job.input?.draft) !== JSON.stringify(this.state.draft)) throw new Error('The draft has changed. Your current work is retained; the task record contains the original proposal.');
      if (!job.result?.draft) throw new Error('No recoverable draft in this task.');
      this.state.proposal = { draft:assetDraft(job.result.draft),approved:false,summary:'Final expert review incomplete.',jobId,incomplete:true };
      this.stage.setDraft(this.current,this.selected); this.queuePreview(); this.persist(); this.feedback('Showing an intermediate draft before final expert review.');
    } catch (error) { this.feedback((error as Error).message,true); }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }
  private close() {
    if (this.busy && !this.controller) { this.feedback('Saving prefab. Please wait.'); return; }
    this.controller?.abort(); if (!this.persist() && this.storageFailed && this.exportedState !== JSON.stringify(this.state)) return;
    this.closed = true; clearTimeout(this.previewTimer); this.previewController?.abort(); if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.stage.dispose(); this.restoreShell(); this.options.onClose(); if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
  }
}
