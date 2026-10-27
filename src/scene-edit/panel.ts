import { cloneDocument, serializeDocument } from '../model';
import type { SceneDocument } from '../types';
import { applySceneOperations, type SceneSnapshot, type SceneView } from './operations';
import { requestSceneEdit } from './client';

interface EditorContext { scene: SceneDocument; time: number; selectedId: string | null }
interface Options {
  root: HTMLElement;
  context(): EditorContext;
  prepare(): void;
  capture(scene: SceneDocument, time: number, view: SceneView): SceneSnapshot;
  preview(scene: SceneDocument | null): void;
  apply(scene: SceneDocument, base: string): boolean;
}

export class SceneEditPanel {
  private controller: AbortController | null = null;
  private candidate: SceneDocument | null = null;
  private base = '';
  private operation = 0;
  private busy = false;
  private readonly prompt: HTMLTextAreaElement;
  private readonly message: HTMLElement;
  constructor(private readonly options: Options) {
    options.root.innerHTML = `<div class="ai-edit-heading"><label for="sceneInstruction">Edit with Muse</label><span>Scene + views</span></div><textarea id="sceneInstruction" aria-label="Scene instruction" maxlength="2000" rows="2" placeholder="Move the selected object left…"></textarea><p class="ai-edit-message" role="status">Describe a change to the scene, action or camera.</p><div class="ai-view-evidence" hidden></div><div class="ai-edit-actions"><button class="primary-button" data-scene-edit="generate">Preview changes</button><button data-scene-edit="cancel" hidden>Cancel</button><button data-scene-edit="before" hidden>Before</button><button data-scene-edit="after" hidden>After</button><button data-scene-edit="discard" hidden>Discard</button><button class="primary-button" data-scene-edit="apply" hidden>Apply</button></div>`;
    this.prompt = options.root.querySelector('textarea')!; this.message = options.root.querySelector('.ai-edit-message')!;
    options.root.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-scene-edit]')?.dataset.sceneEdit;
      if (action === 'generate') void this.generate();
      if (action === 'cancel') this.reset('Cancelled. Your scene is unchanged.');
      if (action === 'discard') this.reset('Changes discarded.');
      if (action === 'before') { options.preview(null); this.setComparison(false); }
      if (action === 'after' && this.candidate) { options.preview(this.candidate); this.setComparison(true); }
      if (action === 'apply' && this.candidate) {
        const candidate = this.candidate, base = this.base;
        this.reset('Changes applied. Undo restores the previous scene.');
        if (!options.apply(candidate, base)) this.message.textContent = 'The scene changed. Ask Muse again before applying.';
      }
    });
    this.prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void this.generate(); } });
    this.prompt.addEventListener('input', () => { if (this.busy || this.candidate) this.reset('Instruction updated. Preview the new changes.'); this.update(); });
    this.update();
  }
  private button(action: string) { return this.options.root.querySelector<HTMLButtonElement>(`[data-scene-edit="${action}"]`)!; }
  private update() {
    this.button('generate').hidden = !!this.candidate; this.button('generate').disabled = this.busy || !this.prompt.value.trim();
    this.button('generate').textContent = this.busy ? 'Thinking…' : 'Preview changes';
    this.button('cancel').hidden = !this.busy;
    for (const action of ['before', 'after', 'discard', 'apply']) this.button(action).hidden = !this.candidate;
  }
  private setComparison(after: boolean) {
    this.button('before').setAttribute('aria-pressed', String(!after)); this.button('after').setAttribute('aria-pressed', String(after));
  }
  private reset(message?: string) {
    this.operation++; this.controller?.abort(); this.controller = null; this.busy = false; this.candidate = null;
    this.options.preview(null); this.options.root.querySelector('.ai-view-evidence')!.replaceChildren();
    this.options.root.querySelector<HTMLElement>('.ai-view-evidence')!.hidden = true;
    if (message) this.message.textContent = message;
    this.update();
  }
  sceneChanged() { if (this.busy || this.candidate) this.reset('The scene changed. Preview your instruction again.'); }
  private async generate() {
    if (this.busy || !this.prompt.value.trim()) return;
    this.reset(); this.options.prepare();
    const context = this.options.context(), scene = cloneDocument(context.scene);
    this.base = serializeDocument(scene); this.busy = true; this.controller = new AbortController();
    const operation = this.operation, signal = this.controller.signal;
    this.message.textContent = 'Muse is reading the scene…'; this.update();
    const stillCurrent = () => {
      if (operation !== this.operation) return false;
      if (serializeDocument(this.options.context().scene) !== this.base) {
        this.reset('The scene changed. Preview your instruction again.');
        return false;
      }
      return true;
    };
    try {
      const input = { ...context, scene, prompt: this.prompt.value.trim(), snapshots: [] as SceneSnapshot[] };
      let response = await requestSceneEdit(input, signal);
      if (!stillCurrent()) return;
      if (response.status === 'needs_views') {
        this.message.textContent = `Rendering ${response.requestedViews.map(v => v === 'top_down' ? 'top view' : 'shot view').join(' + ')} for Muse…`;
        input.snapshots = response.requestedViews.map(view => this.options.capture(scene, context.time, view));
        const evidence = this.options.root.querySelector<HTMLElement>('.ai-view-evidence')!; evidence.replaceChildren(); evidence.hidden = false;
        for (const snapshot of input.snapshots) {
          const img = document.createElement('img'); img.src = snapshot.dataUrl; img.alt = `${snapshot.view === 'top_down' ? 'Top view' : 'Shot view'} shared with Muse at ${snapshot.time.toFixed(2)}s`; img.title = img.alt; evidence.appendChild(img);
        }
        response = await requestSceneEdit(input, signal);
        if (!stillCurrent()) return;
      }
      if (response.status !== 'ready' || response.plan.requestedViews.length) throw new Error('Muse requested more views than this edit supports. Try a more specific instruction.');
      this.message.textContent = response.plan.summary;
      if (response.plan.operations.length) {
        this.candidate = applySceneOperations(scene, response.plan.operations, context.time);
        this.options.preview(this.candidate); this.setComparison(true);
      }
    } catch (error) { if (operation === this.operation) this.message.textContent = signal.aborted ? 'Cancelled. Your scene is unchanged.' : (error as Error).message; }
    finally { if (operation === this.operation) { this.busy = false; this.controller = null; this.update(); } }
  }
}
