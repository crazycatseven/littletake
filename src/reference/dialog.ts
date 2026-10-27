import type { SceneDocument } from '../types';
import { shotCamera } from '../model';
import { referenceConnection, requestReferenceDraft } from './client';
import { readReferenceVideo } from './video';
import type { ReferenceConnection, ReferenceDraft, ReferenceInput } from './types';

const escapeHTML = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

/** A self-contained reference workflow. Applying a draft is the editor's decision. */
export class ReferenceDialog {
  private readonly root = document.createElement('dialog');
  private readonly fileInput: HTMLInputElement;
  private readonly player: HTMLVideoElement;
  private readonly analyzeButton: HTMLButtonElement;
  private readonly applyButton: HTMLButtonElement;
  private readonly direction: HTMLTextAreaElement;
  private connection: ReferenceConnection | null = null;
  private video: ReferenceInput['video'] | null = null;
  private draft: ReferenceDraft | null = null;
  private objectURL: string | null = null;
  private controller: AbortController | null = null;
  private operation = 0;
  private busy = false;
  private loadingDemo = false;

  constructor(private readonly applyScene: (scene: SceneDocument) => void) {
    this.root.id = 'referenceDialog'; this.root.setAttribute('aria-labelledby', 'referenceTitle');
    this.root.innerHTML = `
      <div class="reference-heading"><div><span class="reference-eyebrow">REFERENCE CLIP</span><h2 id="referenceTitle">Video to scene</h2></div><button class="icon-button" data-reference="close" aria-label="Close reference video">✕</button></div>
      <p class="reference-intro">Turn a short shot into an editable whitebox draft.</p>
      <div class="reference-layout">
        <section class="reference-source">
          <div class="reference-video-frame"><video id="referencePlayer" controls playsinline muted hidden></video><div class="reference-placeholder"><svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="5" y="7" width="30" height="26" rx="3"/><path d="m17 14 10 6-10 6Z"/></svg><span>A continuous shot works best</span></div></div>
          <div class="reference-file-row"><button data-reference="choose">Choose video</button><button data-reference="demo">Load demo clip</button><span id="referenceFileName">MP4 or WebM · up to 3 MB</span></div>
          <input id="referenceFile" type="file" accept=".mp4,.webm,video/mp4,video/webm" hidden/>
          <p id="referenceMetadata" class="reference-metadata">1–60 seconds · objects, movement and camera</p>
          <label class="reference-direction-label" for="referenceDirection">Creative direction <span>optional</span></label>
          <textarea id="referenceDirection" aria-label="Creative direction" maxlength="1200" rows="3" placeholder="Focus on the two people and the camera push…"></textarea>
        </section>
        <section class="reference-result" aria-label="Reference analysis">
          <div class="reference-result-heading"><span id="referenceState">YOUR SCENE DRAFT</span><span id="referenceConnection" class="reference-model">Connecting…</span></div>
          <div id="referenceReport"><div class="reference-empty"><span class="reference-draft-icon">◇</span><h3>Choose a reference clip</h3><p>Review the AI draft here before bringing it into your scene.</p><div class="reference-output-tags"><span>Objects</span><span>Motion</span><span>Camera</span></div></div></div>
        </section>
      </div>
      <p id="referenceError" class="reference-error" role="alert" hidden></p>
      <div class="reference-footer"><span id="referenceFooterNote">Estimated geometry and camera remain editable.</span><div><button data-reference="cancel" hidden>Cancel analysis</button><button class="primary-button" data-reference="analyze" disabled>Analyze clip</button><button class="primary-button" data-reference="apply" hidden>Use scene</button></div></div>`;
    document.body.appendChild(this.root);
    this.fileInput = this.find('#referenceFile'); this.player = this.find('#referencePlayer');
    this.analyzeButton = this.find('[data-reference="analyze"]'); this.applyButton = this.find('[data-reference="apply"]');
    this.direction = this.find('#referenceDirection');
    this.root.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-reference]')?.dataset.reference;
      if (action === 'close') this.root.close();
      if (action === 'choose') this.fileInput.click();
      if (action === 'demo') void this.loadDemo();
      if (action === 'analyze') void this.analyze();
      if (action === 'cancel') { this.cancelOperation(); this.emptyReport('Analysis cancelled', 'Your current scene is unchanged.'); }
      if (action === 'apply' && this.draft) { this.applyScene(this.draft.scene); this.root.close(); }
    });
    this.root.addEventListener('close', () => { this.cancelOperation(); this.player.pause(); });
    this.fileInput.addEventListener('change', () => { const file = this.fileInput.files?.[0]; if (file) void this.choose(file); this.fileInput.value = ''; });
    this.direction.addEventListener('input', () => {
      if (this.draft) { this.draft = null; this.emptyReport('Direction updated', 'Analyze the clip again to include your changes.'); this.updateButtons(); }
    });
  }

  private find<T extends HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  open() {
    if (this.root.open) return;
    this.root.showModal();
    void this.connect();
  }
  private async connect() {
    try {
      this.connection = await referenceConnection();
      this.find('#referenceConnection').textContent = this.connection.available ? (this.connection.provider === 'Meta' ? 'Muse Spark' : this.connection.provider) : 'Not connected';
      if (!this.connection.available) this.showError('AI analysis is not configured on this deployment yet. You can keep editing your scene.');
    } catch (error) { this.connection = null; this.find('#referenceConnection').textContent = 'Unavailable'; this.showError((error as Error).message); }
    this.updateButtons();
  }
  private updateButtons() {
    this.analyzeButton.disabled = this.busy || this.loadingDemo || !this.video || !this.connection?.available;
    this.analyzeButton.textContent = this.loadingDemo ? 'Loading demo…' : this.busy ? 'Analyzing…' : this.draft ? 'Analyze again' : 'Analyze clip';
    this.analyzeButton.classList.toggle('reference-working', this.busy);
    this.applyButton.hidden = !this.draft || this.busy || this.loadingDemo;
    this.find<HTMLButtonElement>('[data-reference="choose"]').disabled = this.busy || this.loadingDemo;
    this.find<HTMLButtonElement>('[data-reference="demo"]').disabled = this.busy || this.loadingDemo;
    this.find('[data-reference="cancel"]').hidden = !this.busy && !this.loadingDemo;
    this.find('[data-reference="cancel"]').textContent = this.loadingDemo ? 'Cancel loading' : 'Cancel analysis';
    this.direction.disabled = this.busy || this.loadingDemo;
    this.find('#referenceFooterNote').textContent = this.draft ? 'Use scene replaces your current scene. Undo brings it back.' : 'Estimated geometry and camera remain editable.';
  }
  private cancelOperation() {
    this.operation++; this.controller?.abort(); this.controller = null; this.busy = false; this.loadingDemo = false; this.updateButtons();
  }
  private showError(message: string) { const error = this.find('#referenceError'); error.textContent = message; error.hidden = false; }
  private clearError() { this.find('#referenceError').hidden = true; }
  private emptyReport(title: string, detail: string) {
    this.find('#referenceState').textContent = 'YOUR SCENE DRAFT';
    this.find('#referenceReport').innerHTML = `<div class="reference-empty"><span class="reference-draft-icon">◇</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(detail)}</p><div class="reference-output-tags"><span>Objects</span><span>Motion</span><span>Camera</span></div></div>`;
  }
  private async loadDemo() {
    if (this.busy || this.loadingDemo) return;
    this.cancelOperation(); this.clearError(); this.video = null; this.draft = null; this.loadingDemo = true;
    const operation = this.operation; this.controller = new AbortController();
    this.emptyReport('Loading the demo clip', 'The Grand Budapest Hotel · Interview with Zero · 0:33–0:45');
    this.updateButtons();
    try {
      const response = await fetch('/demo/grand-budapest-zero/input-web.mp4', { signal: this.controller.signal });
      if (!response.ok) throw new Error('The demo clip could not be loaded. Please try again.');
      const clip = await response.blob();
      if (operation !== this.operation) return;
      await this.choose(new File([clip], 'grand-budapest-zero.mp4', { type: 'video/mp4' }));
    } catch (error) {
      if (operation === this.operation) {
        this.loadingDemo = false; this.showError((error as Error).message);
        this.emptyReport('Demo could not be loaded', 'You can choose a video from your device instead.'); this.updateButtons();
      }
    }
  }
  private async choose(file: File) {
    this.cancelOperation(); this.clearError(); this.video = null; this.draft = null;
    const operation = this.operation;
    this.controller = new AbortController();
    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
    this.player.pause(); this.player.removeAttribute('src'); this.player.hidden = true;
    this.find('.reference-placeholder').hidden = false;
    this.find('#referenceFileName').textContent = file.name;
    this.find('#referenceMetadata').textContent = 'Reading clip…';
    this.emptyReport('Reading your clip', 'The original video will be used for analysis.');
    this.updateButtons();
    try {
      const video = await readReferenceVideo(file, this.controller.signal);
      if (operation !== this.operation) return;
      this.video = video;
      this.objectURL = URL.createObjectURL(file); this.player.src = this.objectURL; this.player.hidden = false;
      this.find('.reference-placeholder').hidden = true;
      this.find('#referenceMetadata').textContent = `${video.duration.toFixed(1)}s · ${video.width} × ${video.height} · ${(file.size / 1_000_000).toFixed(2)} MB`;
      this.emptyReport('Ready to analyze', 'Muse will estimate the visible objects, their motion and the camera.');
    } catch (error) {
      if (operation !== this.operation) return;
      this.find('#referenceMetadata').textContent = 'Choose another clip'; this.showError((error as Error).message);
      this.emptyReport('Clip could not be opened', 'Choose a short MP4 or WebM video.');
    }
    this.updateButtons();
  }
  private async analyze() {
    if (!this.video || !this.connection?.available || this.busy) return;
    this.cancelOperation(); this.clearError(); this.draft = null; this.busy = true; this.player.pause();
    const operation = this.operation; this.controller = new AbortController();
    this.find('#referenceState').textContent = 'ANALYZING REFERENCE';
    this.find('#referenceReport').innerHTML = '<div class="reference-empty reference-analyzing"><span class="reference-orbit" aria-hidden="true"></span><h3>Reading the shot</h3><p>Finding the staging, action and camera.<br>This can take a minute.</p></div>';
    this.updateButtons();
    try {
      const draft = await requestReferenceDraft({ video: this.video, direction: this.direction.value.trim() }, this.controller.signal);
      if (operation !== this.operation) return;
      this.draft = draft;
      const animated = draft.scene.objects.filter(item => item.track).length;
      this.find('#referenceState').textContent = 'DRAFT READY';
      this.find('#referenceReport').innerHTML = `<div class="reference-draft-summary"><h3>${escapeHTML(draft.scene.name)}</h3><p>${escapeHTML(draft.summary)}</p><div class="reference-output-tags"><span>${draft.scene.objects.length} objects</span><span>${animated} moving</span><span>${shotCamera(draft.scene,draft.scene.shots[0]?.id??null)?.track ? 'Moving camera' : 'Fixed camera'}</span></div></div><ul class="reference-object-list">${draft.scene.objects.map(item => `<li><span class="reference-kind">${escapeHTML(item.kind)}</span><span>${escapeHTML(item.name)}</span></li>`).join('')}</ul>${draft.assumptions.length ? `<div class="reference-assumptions"><h4>Estimated / simplified</h4><ul>${draft.assumptions.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul></div>` : ''}`;
    } catch (error) {
      if (operation !== this.operation) return;
      this.showError((error as Error).message); this.emptyReport('Analysis did not finish', 'Your current scene is unchanged. You can try again.');
    }
    if (operation === this.operation) { this.busy = false; this.updateButtons(); }
  }
}
