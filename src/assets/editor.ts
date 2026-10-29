import './editor.css';
import './toolkit/inspector.css';
import { AssetEditorStage } from './editor-stage';
import { AssetDraftStore, assetDraft, draftFromAsset, editAsset, type AssetDraft, type AssetEdit, type AssetEditorState, type AssetInstance, type AssetProposal, type AssetUpdateScope } from './edit';
import { constructionFields, constructionAction, constructionChange } from './toolkit/inspector';
import { drivenProperties } from './toolkit/edits';
import { evaluateAsset, recipeBounds, validateAsset, type AssetDefinition } from './model';
import { componentScripts, movement } from '../components/model';
import type { ToolMode, Vec3 } from '../types';

const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
const number = (v: number) => String(Math.round(v * 10000) / 10000);
interface Options {
  host: HTMLElement;
  onClose(): void;
  asset: AssetDefinition;
  instance?: AssetInstance;
  instanceCount(base: AssetDefinition): number;
  onSaved(base: AssetDefinition, asset: AssetDefinition, scope: AssetUpdateScope): string;
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
    if (JSON.stringify(this.state.base) !== JSON.stringify(options.asset)) throw new Error('The saved draft belongs to a different asset definition.');
    this.history = [structuredClone(this.state.draft)];
    this.root = options.host;
    if (this.root.classList.contains('asset-mode')) throw new Error('An asset is already open.');
    this.root.classList.add('asset-mode');
    const toolIcon = (path: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
    try {
      this.mount('.history-actions', 'ae-header-controls', `<button class="icon-button" data-ae="undo" aria-label="撤销资产修改" title="Undo asset edit · Ctrl Z">↶</button><button class="icon-button" data-ae="redo" aria-label="重做资产修改" title="Redo asset edit · Ctrl Shift Z">↷</button>`);
      this.mount('.header-actions', 'ae-header-controls', `<button data-ae="export-draft">导出草稿</button><button class="primary-button" data-ae="save-options">保存资产版本</button><div class="ae-save" hidden><strong>保存后更新</strong><select aria-label="更新范围"><option value="library">仅资产库</option>${options.instance ? '<option value="selected">当前实例</option>' : ''}<option value="all">全部引用实例</option></select><small>实例的位置、颜色、动作和组件保持各自设置。</small><button data-ae="publish" class="primary-button">确认保存</button><button data-ae="save-options">取消</button></div>`);
      this.mount('.library-panel', 'ae-tree', `<div class="library-tabs"><button role="tab" aria-selected="true">Hierarchy <span data-ae-count></span></button></div><div class="outliner"><button class="object-row ae-root" data-ae="root"><i aria-hidden="true">◇</i><span data-ae-title></span></button><div data-ae-tree role="tree" aria-label="资产部件"></div></div><div class="ae-add"><select aria-label="新增部件形状"><option value="cube">方块</option><option value="sphere">球体</option><option value="cylinder">圆柱</option><option value="cone">圆锥</option><option value="group">组</option></select><button data-ae="add">＋ 部件</button></div>`);
      this.mount('.stage-panel', 'ae-center', `<div class="ae-stage viewport"></div><div class="viewport-heading"><div class="transform-tools" role="toolbar" aria-label="Transform tools"><button data-ae-tool="translate" class="active" aria-label="Move tool" title="Move · G">${toolIcon('<path d="M12 3v18M3 12h18m-3-3 3 3-3 3M9 6l3-3 3 3M6 9l-3 3 3 3m3 3 3 3 3-3"/>')}<span>Move</span></button><button data-ae-tool="rotate" aria-label="Rotate tool" title="Rotate · R">${toolIcon('<path d="M19 7a8 8 0 1 0 1 8M19 3v5h-5"/>')}<span>Rotate</span></button><button data-ae-tool="scale" aria-label="Scale tool" title="Size · S">${toolIcon('<path d="M4 15v5h5M20 9V4h-5M4 20l6-6m10-10-6 6"/>')}<span>Scale</span></button></div><div><button data-view="front">正视</button><button data-view="side">侧视</button><button data-view="top">俯视</button><button data-view="perspective">Focus</button></div></div><nav class="ae-context" aria-label="编辑路径"><button data-ae="close" aria-label="返回片场">← 片场</button><span aria-hidden="true">/</span><strong data-ae-title></strong><span class="ae-version" data-ae-version></span></nav><section class="shot-panel ae-views" aria-label="资产几何预览"><div class="shot-heading"><h2>资产预览</h2><button class="icon-button" data-ae="expand-views" aria-label="展开资产预览" aria-expanded="false">⛶</button></div><img alt="资产几何三视图"/><div class="shot-footer"><span data-ae-render-status>生成中…</span><button data-ae="reset-tests">重置试动</button></div></section><div class="ae-measure viewport-caption" aria-live="polite"></div>`);
      this.mount('.properties-drawer', 'ae-sidebar', `<div class="panel-tabs ae-tabs" role="tablist" aria-label="Asset tools"><button id="assetMuseTab" role="tab" data-tab="expert" aria-selected="false" aria-controls="assetExpertPanel">✧ Muse</button><button id="assetInspectorTab" role="tab" data-tab="properties" aria-selected="true" aria-controls="assetInspectorPanel">Inspector</button><span class="model-pill">资产专家</span></div><section id="assetInspectorPanel" class="ae-properties inspector-panel" role="tabpanel" aria-labelledby="assetInspectorTab"></section><section id="assetExpertPanel" class="ae-expert" role="tabpanel" aria-labelledby="assetMuseTab" hidden><div class="ae-chat"></div><div class="ae-proposal" hidden></div><form class="ae-compose"><label for="assetExpertPrompt">修改当前资产</label><textarea id="assetExpertPrompt" aria-label="资产专家指令" maxlength="3000" placeholder="例如：加宽底座，保留四个轮子，并检查支架是否连在一起。"></textarea><div><small>资产对话 · 历史保留</small><button class="primary-button" type="submit">发送</button><button type="button" data-ae="cancel-expert" hidden>停止</button></div></form></section>`);
      this.mount('.status-bar', 'ae-status', '<span data-ae-feedback role="status"></span><span>Prefab Mode · 资产草稿</span>');
      const timeline = this.$('#timelinePanel'), wasInert = timeline.inert;
      timeline.inert = true;
      const note = document.createElement('span'); note.className = 'ae-timeline-note'; note.textContent = '资产模式 · 返回片场后继续编辑时间线'; timeline.append(note);
      this.restores.push(() => { timeline.inert = wasInert; note.remove(); });
      const projectName = this.$<HTMLInputElement>('#projectName'), wasReadOnly = projectName.readOnly;
      projectName.readOnly = true; this.restores.push(() => { projectName.readOnly = wasReadOnly; });
      this.stage = new AssetEditorStage(this.$('.ae-stage'), id => { this.selected = id; this.tab = 'properties'; this.$('.ae-properties').scrollTop = 0; this.render(); }, edits => this.edit(edits));
      this.stage.setDraft(this.current, null, true);
      this.$<HTMLFormElement>('.ae-compose').onsubmit = e => { e.preventDefault(); void this.askExpert(); };
      window.addEventListener('keydown', this.keydown); this.restores.push(() => window.removeEventListener('keydown', this.keydown));
      this.render(); this.queuePreview(); this.$('#assetInspectorTab').focus();
      this.feedback(this.store.read() ? '已恢复本机草稿和资产对话。' : '正在编辑资产草稿，保存后可选择更新片场实例。');
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
      if (key === 's') { if (!this.locked) this.$('.ae-save').hidden = false; }
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
    catch (error) { this.storageFailed = true; this.feedback('草稿未保存：' + (error as Error).message + ' 可先导出草稿，再返回片场。', true); return false; }
  }
  private commit(draft: AssetDraft) {
    this.state.draft = assetDraft(draft); this.componentTesting = false;
    this.history = this.history.slice(0, this.cursor + 1); this.history.push(structuredClone(this.state.draft)); if (this.history.length > 60) this.history.shift(); this.cursor = this.history.length - 1;
    this.stage.setDraft(this.current, this.selected); this.render(); this.queuePreview(); if (this.persist()) this.feedback('草稿已保存 · 片场尚未更新');
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
    this.cursor = next; this.state.draft = structuredClone(this.history[next]); this.stage.setDraft(this.current, this.selected); this.render(); this.queuePreview(); if (this.persist()) this.feedback(delta < 0 ? '已撤销资产修改' : '已重做资产修改');
  }
  private render() {
    this.componentTesting = false;
    const draft = this.current, evaluated = evaluateAsset(draft); if (!evaluated.parts.some(p => p.id === this.selected)) this.selected = null;
    this.root.querySelectorAll<HTMLElement>('[data-ae-title]').forEach(el => el.textContent = draft.name); this.$('[data-ae-version]').textContent = `v${this.state.base.version} · ${this.state.proposal ? '专家方案预览' : '草稿'}`;
    this.$('[data-ae-count]').textContent = String(evaluated.parts.filter(p=>p.kind!=='group').length);
    this.$('[aria-label="更新范围"] option[value="all"]').textContent = `项目中引用此版本的全部 ${this.options.instanceCount(this.state.base)} 个实例`;
    const rows = (parent: string | null, depth: number): string => evaluated.parts.filter(p => p.parentId === parent).map(p => `<button role="treeitem" aria-selected="${p.id === this.selected}" data-part="${esc(p.id)}" style="padding-left:${28 + depth * 14}px" class="object-row ${p.id === this.selected ? 'selected' : ''}"><i aria-hidden="true">${p.generatedBy.length ? '↪' : p.kind === 'group' ? '▱' : p.joint ? '⟳' : '◇'}</i><span>${esc(p.name)}</span><small>${p.generatedBy.length ? esc(p.id.split('~').slice(1).map(s=>s.split('.').at(-1)).join(' · ').toUpperCase()) : p.kind}</small></button>${rows(p.id, depth + 1)}`).join('');
    this.$('[data-ae-tree]').innerHTML = rows(null, 0); this.stage.setEditable(!this.locked); this.stage.select(this.selected);
    this.$('.ae-properties').hidden = this.tab !== 'properties'; this.$('.ae-expert').hidden = this.tab !== 'expert';
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => { const active = b.dataset.tab === this.tab; b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1; });
    this.$('[data-ae="root"]').classList.toggle('selected', !this.selected);
    this.$<HTMLButtonElement>('[data-ae="undo"]').disabled = this.locked || this.cursor === 0; this.$<HTMLButtonElement>('[data-ae="redo"]').disabled = this.locked || this.cursor >= this.history.length - 1;
    this.$<HTMLButtonElement>('[data-ae="add"]').disabled = this.locked || draft.parts.length >= 2048;
    this.root.querySelectorAll<HTMLButtonElement>('[data-ae-tool], [data-ae="save-options"], [data-ae="publish"]').forEach(b => b.disabled = this.locked);
    this.$<HTMLTextAreaElement>('#assetExpertPrompt').disabled = this.locked; this.$<HTMLButtonElement>('.ae-compose [type="submit"]').disabled = this.locked;
    this.$('[data-ae="cancel-expert"]').hidden = !this.controller;
    const bounds = recipeBounds(draft);
    this.$('.ae-measure').innerHTML = `<strong>${bounds.size.map(n => n.toFixed(3)).join(' × ')} <small>m</small></strong><span>X 宽 · Y 高 · Z 深</span><span>包围盒 min ${bounds.min.map(n => n.toFixed(2)).join(', ')} · max ${bounds.max.map(n => n.toFixed(2)).join(', ')}</span>`;
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
    this.$('.ae-properties').innerHTML = p ? `<div class="inspector-title"><span class="entity-type">◇ ASSET PART</span><small class="ae-part-id">${esc(p.id)}</small></div><input class="entity-name" data-field="name" aria-label="部件名称" value="${esc(p.name)}" maxlength="120"/>${select('形状','kind',{ cube:'方块',sphere:'球体',cylinder:'圆柱',cone:'圆锥',group:'组' },p.kind)}${select('父部件','parentId',{ '':'资产原点', ...Object.fromEntries(draft.parts.filter(q => q.id !== p.id).map(q => [q.id,q.name])) },p.parentId ?? '')}<small class="ae-hint">父级改变后，数值仍为局部坐标。</small>${this.vectors('位置','position',p.position,-1000,1000)}${this.vectors('旋转','rotation',p.rotation,-360,360,1)}${p.kind==='group'?'':this.vectors('尺寸','size',p.size,.005,100)}<label class="ae-color">颜色<input type="color" data-field="color" aria-label="部件颜色" value="${p.color}"/></label><div class="ae-divider"></div>${select('可动关节','jointType',{ '':'固定',hinge:'铰链',wheel:'轮轴' },p.joint?.type ?? '')}${p.joint ? `${select('旋转轴','jointAxis',{ x:'X',y:'Y',z:'Z' },p.joint.axis)}${this.vectors('转轴位置','pivot',p.joint.pivot,-100,100)}<div class="ae-limits"><label>最小角度<input type="number" data-field="jointMin" aria-label="最小角度" min="-360" max="360" value="${p.joint.min}"/></label><label>最大角度<input type="number" data-field="jointMax" aria-label="最大角度" min="-360" max="360" value="${p.joint.max}"/></label></div><label>试动 · <span data-joint-angle>0°</span><input type="range" aria-label="关节试动角度" min="${p.joint.min}" max="${p.joint.max}" step="1" value="${Math.max(p.joint.min, Math.min(p.joint.max, 0))}" data-joint-test/></label><small class="ae-hint">只预览动作，不改变草稿姿态。</small>` : ''}<div class="ae-part-actions"><button data-ae="duplicate-part">复制部件</button><button data-ae="delete-part">删除及子部件</button></div>`
      : `<div class="inspector-title"><span class="entity-type">◇ PREFAB ASSET</span></div><input class="entity-name" data-meta="name" aria-label="资产名称" maxlength="120" value="${esc(draft.name)}"/><label>描述<textarea data-meta="description" aria-label="资产描述" maxlength="1200">${esc(draft.description)}</textarea></label><label>标签<input data-meta="tags" aria-label="资产标签" value="${esc(draft.tags.join(', '))}"/></label><div class="ae-divider"></div><div class="ae-section-title">实例默认组件</div>${this.componentFields()}<small class="ae-hint">保存组件默认值供新实例使用；已有实例保留自己的设置。${draft.template?.track ? '已保留模板动作与录制采样。' : ''}</small><div class="ae-divider"></div><p class="ae-hint">包围盒来自实际几何。尺寸与三视图提供证据，造型是否合适由你和资产专家判断。</p>`;
    (p && !p.generatedBy.length ? this.$('.ae-properties') : this.$('.ae-properties .entity-name')).insertAdjacentHTML(p && !p.generatedBy.length?'beforeend':'afterend',constructionFields(draft,this.selected));
    this.$('.ae-properties').querySelectorAll<HTMLDetailsElement>('details[data-tk-key]').forEach(e=>{ if(open.includes(e.dataset.tkKey))e.open=true; });
    this.$('.ae-properties').scrollTop = scroll;
    this.$('.ae-properties').querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea,button').forEach(el => el.disabled = this.locked || (!!p?.generatedBy.length && !el.closest('.tk-section')));
    if(p) this.$('.ae-properties').querySelectorAll<HTMLInputElement>('[data-vector]').forEach(input=>{ if(drivenProperties(draft,p.id).includes((input.dataset.vector+'.'+['x','y','z'][Number(input.dataset.index)]) as any)){ input.disabled=true; input.title='由参数或锚点关联驱动'; } });
    const slider = this.$<HTMLInputElement>('[data-joint-test]');
    if(slider)slider.disabled=false;
    if (slider && p) slider.oninput = () => { this.stage.testJoint(p.id, Number(slider.value)); this.$('[data-joint-angle]').textContent = slider.value + '°'; };
  }
  private componentFields(): string {
    const c = this.current.template?.components[0];
    if (!c) return '<button data-ae="add-movement">＋ 移动操控</button><button data-ae="add-hinge">＋ 转轴开合</button>';
    const script = componentScripts[c.type], values = c as unknown as Record<string,string|number>;
    return `<div class="ae-component"><label><input type="checkbox" data-component="enabled" aria-label="启用默认组件" ${c.enabled ? 'checked' : ''}/> ${script.title}</label>${script.fields.map(f => f.options ? `<label>${f.label}<select data-component="${f.key}" aria-label="${f.label}">${Object.entries(f.options).map(([v,l])=>`<option value="${v}" ${v === values[f.key] ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : `<label>${f.label} (${f.unit})<input type="number" data-component="${f.key}" aria-label="${f.label}" min="${f.min}" max="${f.max}" step="${f.step}" value="${values[f.key]}"/></label>`).join('')}<button data-ae="test-component">${this.componentTesting ? '退出试动并还原' : '在沙箱试动'}</button><p>${script.help(c)}</p><button data-ae="remove-component">移除默认组件</button></div>`;
  }
  private renderChat() {
    this.$('.ae-chat').innerHTML = this.state.messages.length ? this.state.messages.map(m => `<article class="${m.role} ${m.error ? 'error' : ''}"><small>${m.role === 'user' ? '你' : '资产专家'}</small><p>${esc(m.text)}</p>${m.jobId ? `<a href="/api/assets?jobId=${encodeURIComponent(m.jobId)}" target="_blank" rel="noopener">查看本轮输入、工具记录与结果 ↗</a>${m.error ? `<button data-recover="${esc(m.jobId)}" ${this.locked ? 'disabled' : ''}>查看未完成草稿</button>` : ''}` : ''}</article>`).join('') : '<div class="ae-chat-empty"><span>✧</span><h3>一起打磨这个资产</h3><p>专家能读取部件、修改草稿、计算尺寸，并查看实际渲染图。每次修改先预览，再由你采用。</p></div>';
    if (this.busy && this.controller) this.$('.ae-chat').insertAdjacentHTML('beforeend','<article><small>资产专家</small><p>正在修改、量测和检查渲染图…</p></article>');
    const proposal = this.state.proposal; this.$('.ae-proposal').hidden = !proposal;
    if (proposal) this.$('.ae-proposal').innerHTML = `<strong>${proposal.incomplete ? '未完成专家评估 · 中间草稿' : proposal.approved ? '专家已检查此方案' : '专家提示仍有问题'}</strong><p>${proposal.incomplete ? '此任务已中止，草稿尚未得到最终评估。可人工检查后采用。' : '视图显示方案预览。采用后仍可继续手动修改。'}</p><button data-ae="accept" class="primary-button">${proposal.incomplete ? '采用未评估草稿' : '采用此草稿'}</button><button data-ae="reject">放弃方案</button>`;
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
        anchor.href = url; anchor.download = `${this.state.base.id}-v${this.state.base.version}.asset-draft.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.exportedState = text; this.feedback('已导出草稿、方案和资产对话。'); break;
      }
      case 'root': this.selected = null; this.tab = 'properties'; this.componentTesting = false; this.$('.ae-properties').scrollTop = 0; this.stage.resetTests(); this.render(); break;
      case 'expand-views': { const expanded = this.$('.ae-views').classList.toggle('expanded'); button.setAttribute('aria-expanded', String(expanded)); button.setAttribute('aria-label', expanded ? '收起资产预览' : '展开资产预览'); break; }
      case 'undo': this.undo(-1); break; case 'redo': this.undo(1); break;
      case 'save-options': this.$('.ae-save').hidden = !this.$('.ae-save').hidden; break;
      case 'publish': void this.publish(); break;
      case 'reset-tests': this.componentTesting = false; this.stage.resetTests(); this.renderProperties(); break;
      case 'add': { const id = 'part-' + crypto.randomUUID(); this.selected = id; this.edit([{ type:'add_part', part: { id, name:'新部件', parentId:null, kind:this.$<HTMLSelectElement>('[aria-label="新增部件形状"]').value as 'cube', position:[0,.25,0], rotation:[0,0,0], size:[.5,.5,.5], color:'#b7c5ae', joint:null } }]); break; }
      case 'duplicate-part': if(this.selected)this.edit([{type:'duplicate_subtree',partId:this.selected}]); break;
      case 'delete-part': if (this.selected) this.edit([{ type:'remove_part',id:this.selected }]); break;
      case 'add-movement': this.edit([{ type:'set_components', components:[movement('free')] }]); break;
      case 'add-hinge': this.edit([{ type:'set_components', components:[{ type:'hinge', enabled:true, speed:50 }] }]); break;
      case 'remove-component': this.edit([{ type:'set_components',components:[] }]); break;
      case 'test-component': this.componentTesting = !this.componentTesting; this.stage.testComponent(this.componentTesting); this.renderProperties(); break;
      case 'cancel-expert': this.controller?.abort(); break;
      case 'accept': { const proposal = this.state.proposal; if (!proposal) break; delete this.state.proposal; this.state.messages.push({ role:'user',text:proposal.incomplete ? '人工采用未完成专家评估的中间草稿。' : '已采用该方案作为草稿。' }); this.commit(proposal.draft); break; }
      case 'reject': delete this.state.proposal; this.state.messages.push({ role:'user',text:'已放弃该方案，保留原草稿。' }); this.stage.setDraft(this.current, this.selected); this.render(); this.queuePreview(); this.persist(); break;
    }
  };
  private change = (event: Event) => {
    event.stopPropagation(); if (this.locked) return;
    const input = event.target as HTMLInputElement, p = this.state.draft.parts.find(p => p.id === this.selected);
    if(input.dataset.tkField||input.dataset.tkAxis){ try{const edits=constructionChange(input,this.current,this.selected);if(edits?.length)this.edit(edits);}catch(error){this.feedback((error as Error).message,true);this.renderProperties();}return; }
    if (input.dataset.meta) { const key = input.dataset.meta; this.edit([{ type:'set_metadata', changes:{ [key]: key === 'tags' ? input.value.split(/[,，]/).map(s=>s.trim()).filter(Boolean) : input.value } }]); }
    else if (input.dataset.component) { const c = this.state.draft.template?.components[0]; if (c) this.edit([{ type:'set_components', components:[{ ...c, [input.dataset.component]: input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value }] }]); }
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
    clearTimeout(this.previewTimer); this.previewController?.abort(); this.$('[data-ae-render-status]').textContent = '更新中…';
    this.previewTimer = setTimeout(() => void this.preview(), 250);
  }
  private async preview() {
    const controller = new AbortController(); this.previewController = controller;
    try {
      const response = await fetch('/api/assets', { method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify({ action:'preview',base:this.state.base,draft:this.current }),signal:controller.signal });
      if (!response.ok) throw new Error('三视图暂时不可用'); const blob = await response.blob(); if (controller.signal.aborted || this.closed) return;
      if (this.previewUrl) URL.revokeObjectURL(this.previewUrl); this.previewUrl = URL.createObjectURL(blob); this.$<HTMLImageElement>('.ae-views img').src = this.previewUrl; this.$('[data-ae-render-status]').textContent = '与当前几何同步';
    } catch (error) { if (!controller.signal.aborted && !this.closed) this.$('[data-ae-render-status]').textContent = (error as Error).message; }
  }
  private async askExpert() {
    if (this.locked) return; const prompt = this.$<HTMLTextAreaElement>('#assetExpertPrompt').value.trim(); if (!prompt) return;
    const history = this.state.messages.slice(-16).map(({role,text})=>({role,text})); this.state.messages.push({ role:'user',text:prompt }); if (!this.persist()) return;
    this.$<HTMLTextAreaElement>('#assetExpertPrompt').value = ''; this.busy = true; this.controller = new AbortController(); this.stage.resetTests(); this.render(); this.feedback('资产专家正在处理本轮；片场保持原样。');
    try {
      const response = await fetch('/api/assets', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ action:'expert',base:this.state.base,draft:this.state.draft,prompt,history }),signal:this.controller.signal });
      const data = await response.json(); if (!response.ok) { this.state.messages.push({ role:'assistant',text:data.error?.message ?? '专家请求失败。',error:true,jobId:data.error?.jobId }); throw new Error(data.error?.message ?? '专家请求失败。'); }
      if (this.closed || this.controller.signal.aborted) return;
      const proposal: AssetProposal = { draft:assetDraft(data.draft),approved:!!data.approved,summary:data.summary,jobId:data.jobId };
      this.state.proposal = proposal; this.state.messages.push({ role:'assistant',text:proposal.summary,jobId:proposal.jobId }); this.stage.setDraft(this.current,this.selected); this.queuePreview(); this.feedback('方案已生成，正在预览；采用后可以继续修改。');
    } catch (error) {
      const message = this.controller.signal.aborted ? '本轮已停止，原草稿保留。' : (error as Error).message;
      if (this.state.messages.at(-1)?.role === 'user') this.state.messages.push({ role:'assistant',text:message,error:true });
      if (!this.closed) this.feedback(message,true);
    } finally { this.busy = false; this.controller = undefined; this.persist(); if (!this.closed) this.render(); }
  }
  private async publish() {
    if (this.locked || !this.persist()) return; this.busy = true; this.render(); this.feedback('正在保存新版本…');
    const base = this.state.base, scope = this.$<HTMLSelectElement>('[aria-label="更新范围"]').value as AssetUpdateScope;
    try {
      const response = await fetch('/api/assets',{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save',base,draft:this.state.draft}) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? '保存失败。');
      const asset = validateAsset(data.asset); let message: string;
      try { message = this.options.onSaved(base,asset,scope); } catch (error) { message = (error as Error).message + ' 新版本已保存在资产库。'; }
      // Keep the old version's draft/history, and never overwrite a draft already
      // being edited for the newly saved version in another tab.
      const nextStore = new AssetDraftStore(localStorage,asset), existing = nextStore.read();
      if (existing && JSON.stringify(existing.base) !== JSON.stringify(asset)) throw new Error('新版本已有不同的本机草稿，请从资产库重新打开。');
      this.state = existing ?? { base:asset, draft:draftFromAsset(asset), messages:this.state.messages };
      this.store = nextStore; this.persist();
      this.stage.setDraft(this.current,this.selected); this.queuePreview();
      this.history = [structuredClone(this.state.draft)]; this.cursor = 0; this.$('.ae-save').hidden = true; this.feedback(`已保存 v${asset.version}。${message}`);
    } catch (error) { this.feedback((error as Error).message,true); }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }
  private async recover(jobId: string) {
    if (this.locked) return; this.busy = true; this.render();
    try {
      const response = await fetch('/api/assets?jobId=' + encodeURIComponent(jobId)); if (!response.ok) throw new Error('无法读取本轮记录。'); const job = await response.json();
      if (job.kind !== 'asset_revision' || JSON.stringify(job.base) !== JSON.stringify(this.state.base) || JSON.stringify(job.input?.draft) !== JSON.stringify(this.state.draft)) throw new Error('草稿已变化，保留当前内容；可通过任务记录查看原方案。');
      if (!job.result?.draft) throw new Error('这一轮没有可恢复的草稿。');
      this.state.proposal = { draft:assetDraft(job.result.draft),approved:false,summary:'未完成专家最终评估。',jobId,incomplete:true };
      this.stage.setDraft(this.current,this.selected); this.queuePreview(); this.persist(); this.feedback('显示中间草稿；最终专家评估未完成。');
    } catch (error) { this.feedback((error as Error).message,true); }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }
  private close() {
    if (this.busy && !this.controller) { this.feedback('正在保存版本，请稍候。'); return; }
    this.controller?.abort(); if (!this.persist() && this.storageFailed && this.exportedState !== JSON.stringify(this.state)) return;
    this.closed = true; clearTimeout(this.previewTimer); this.previewController?.abort(); if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.stage.dispose(); this.restoreShell(); this.options.onClose(); if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
  }
}
