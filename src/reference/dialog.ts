import { icon } from '../icons';
import { newId } from "../id.ts";
import { referenceConnection, parseReferenceDraft, requestReferenceDraft } from './client';
import { z } from 'zod';
import type { Workspace } from '../project/workspace';
import { videoExportIssue } from '../shot-export/export';
import { reconstructReference, type ReferenceRun } from './workflow';
import { isReferenceImage, readReferenceImage } from './image';
import { attachTrackOverlay } from './tracks';
import { collectReferenceSource, readReferenceVideo } from './video';
import type { SourceEvidence } from './analysis';
import type { ReferenceConnection, ReferenceDraft, ReferenceImage, ReferenceVideo, ReferenceInput, ReferenceCapture } from './types';

/** Muse quotes measured times like 1.8761666666666668; show them as 1.88. */
const readableTimes = (text: string) => text.replace(/\d+\.\d{4,}/g, value => Number(value).toFixed(2));


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
  private video: ReferenceVideo | null = null;
  private image: ReferenceImage | null = null;
  private readonly still: HTMLImageElement;
  private draft: ReferenceDraft | null = null;
  private objectURL: string | null = null;
  private controller: AbortController | null = null;
  private operation = 0;
  private busy = false;
  private loadingDemo = false;
  private preparingSource = false;
  private source: SourceEvidence | null = null;
  private run: ReferenceRun | null = null;
  private disposeTracks: (() => void) | null = null;


  constructor(private readonly applyScene: (draft: ReferenceDraft) => void, private readonly capture: ReferenceCapture, private readonly storage: () => Workspace | undefined, private readonly shareReference?: (file:File,video:ReferenceVideo,cuts:Promise<number[]>)=>Promise<void>) {
    this.root.id = 'referenceDialog'; this.root.setAttribute('aria-labelledby', 'referenceTitle');
    this.root.innerHTML = `
      <div class="reference-heading"><div><span class="reference-eyebrow">REFERENCE</span><h2 id="referenceTitle">Video or sketch to scene</h2></div><button class="icon-button" data-reference="close" aria-label="Close reference video">${icon('close')}</button></div>
      <p class="reference-intro">Turn a short shot, a storyboard panel or a sketch into an editable whitebox draft.</p>
      <div class="reference-layout">
        <section class="reference-source">
          <div class="reference-video-frame"><video id="referencePlayer" controls playsinline muted hidden></video><img id="referenceStill" alt="Reference image" hidden/><div class="reference-placeholder">${icon('film')}<span>A continuous shot or one storyboard panel</span></div></div>
          <div class="reference-file-row"><button data-reference="choose">Choose video or image</button><button data-reference="demo">Load demo clip</button><span id="referenceFileName">MP4, WebM, PNG, JPEG or WebP</span></div>
          <input id="referenceFile" type="file" accept=".mp4,.webm,video/mp4,video/webm,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" hidden/>
          <p id="referenceMetadata" class="reference-metadata">A 1–60 s clip, or a sketch with arrows for movement</p>
          <details id="referenceSamples" class="reference-samples" hidden><summary></summary><div class="reference-sample-list"></div></details>
          <label class="reference-direction-label" for="referenceDirection">Creative direction <span>optional</span></label>
          <textarea id="referenceDirection" aria-label="Creative direction" maxlength="1200" rows="3" placeholder="Focus on the two people and the camera push…"></textarea>
        </section>
        <section class="reference-result" aria-label="Reference analysis">
          <div class="reference-result-heading"><span id="referenceState">YOUR SCENE DRAFT</span><span id="referenceConnection" class="reference-model">Connecting…</span></div>
          <div id="referenceReport"><div class="reference-empty"><h3>Choose a clip or a sketch</h3><p>Review the AI draft here before bringing it into your scene.</p></div></div>
        </section>
      </div>
      <p id="referenceError" class="reference-error" role="alert" hidden></p>
      <div class="reference-footer"><span id="referenceFooterNote">Estimated geometry and camera remain editable.</span><div><button data-reference="diagnostics" hidden>Download analysis</button><button data-reference="resume" hidden>Resume interrupted step</button><button data-reference="cancel" hidden>Cancel analysis</button><button class="primary-button" data-reference="analyze" disabled>Analyze clip</button><button class="primary-button" data-reference="apply" hidden>Use scene</button></div></div>`;
    document.body.appendChild(this.root);
    this.fileInput = this.find('#referenceFile'); this.player = this.find('#referencePlayer'); this.still = this.find('#referenceStill');
    this.analyzeButton = this.find('[data-reference="analyze"]'); this.applyButton = this.find('[data-reference="apply"]');
    this.direction = this.find('#referenceDirection');
    this.root.addEventListener('click', event => {
      const sample=(event.target as HTMLElement).closest<HTMLElement>('[data-source-time]');
      if(sample&&Number.isFinite(Number(sample.dataset.sourceTime))){this.player.pause();this.player.currentTime=Number(sample.dataset.sourceTime);}
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-reference]')?.dataset.reference;
      if (action === 'close') this.root.close();
      if (action === 'choose') this.fileInput.click();
      if (action === 'demo') void this.loadDemo();
      if (action === 'analyze') void this.analyze();
      if (action === 'cancel') void this.cancelAnalysis();
      if(action==='resume')void this.analyze();
      if(action==='diagnostics')this.downloadAnalysis();
      if (action === 'apply' && this.draft) { this.applyScene(this.draft); this.root.close(); }
    });
    this.root.addEventListener('close', () => { this.cancelOperation(); this.player.pause(); });
    window.addEventListener('pagehide', () => this.cancelOperation());
    this.fileInput.addEventListener('change', () => { const file = this.fileInput.files?.[0]; if (file) void this.choose(file); this.fileInput.value = ''; });
    this.direction.addEventListener('input', () => {
      if (this.draft) { this.draft = null; this.emptyReport('Direction updated', `Analyze the ${this.image ? 'image' : 'clip'} again to include your changes.`); this.updateButtons(); }
    });
  }
  private find<T extends HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  open() {
    if (this.root.open) return;
    this.root.showModal();
    void this.connect();
  }
  private async connect() {
    const operation=this.operation;
    try {
      const connection=await referenceConnection();this.connection=connection;
      if(!this.root.open)return;
      this.find('#referenceConnection').textContent = this.connection.available ? (this.connection.provider === 'Meta' ? this.connection.model.includes('contributor')?'Muse · Contributor':'Muse Spark' : this.connection.provider) : 'Not connected';
      if (!this.connection.available) this.showError('Muse is not configured. You can keep editing your scene.');
      else if (videoExportIssue()) this.showError('Reference analysis needs localhost or HTTPS to render its review video. Open the local editor to continue.');
    } catch (error) { this.connection = null; this.find('#referenceConnection').textContent = 'Unavailable'; this.showError((error as Error).message); }
    this.updateButtons();
  }
  private updateButtons() {
    this.analyzeButton.disabled = this.busy || this.loadingDemo || this.preparingSource || (!this.video&&!this.image) || (!this.image&&!this.source&&!this.run?.error) || !this.connection?.available || !this.storage()?.canEdit || (!this.image&&Boolean(videoExportIssue()));
    this.analyzeButton.textContent = this.loadingDemo ? 'Loading demo…' : this.preparingSource ? 'Finding shots…' : this.busy ? 'Analyzing…' : this.draft ? 'Analyze again' : this.image ? 'Analyze image' : 'Analyze clip';
    this.analyzeButton.classList.toggle('reference-working', this.busy);
    this.applyButton.hidden = !this.draft || this.busy || this.loadingDemo || !this.storage()?.canEdit;
    this.find<HTMLButtonElement>('[data-reference="choose"]').disabled = this.busy || this.loadingDemo || this.preparingSource;
    this.find<HTMLButtonElement>('[data-reference="demo"]').disabled = this.busy || this.loadingDemo || this.preparingSource;
    this.find('[data-reference="cancel"]').hidden = !this.busy && !this.loadingDemo && !this.preparingSource;
    this.find('[data-reference="cancel"]').textContent = this.loadingDemo ? 'Cancel loading' : this.preparingSource ? 'Cancel scan' : 'Cancel analysis';
    this.find<HTMLButtonElement>('[data-reference="cancel"]').disabled=false;
    this.direction.disabled = this.busy || this.loadingDemo;
    this.find('[data-reference="diagnostics"]').hidden=!this.run;
    this.find('[data-reference="resume"]').hidden=!this.run?.error || this.busy;
    this.find<HTMLButtonElement>('[data-reference="resume"]').disabled=!this.storage()?.canEdit || !this.connection?.available || this.busy || Boolean(videoExportIssue());
    this.find('#referenceFooterNote').textContent = this.draft ? 'Adds an editable scene to the current project.' : this.busy ? 'Keep this page open. Closing it stops analysis.' : 'Estimated geometry, lighting, motion and cameras remain editable.';
  }
  private cancelOperation() {
    if (this.busy && this.run) this.run.error = 'Analysis interrupted. Resume explicitly to continue.';
    this.operation++; this.controller?.abort(); this.controller = null; this.busy = false; this.loadingDemo = false; this.preparingSource = false; this.updateButtons();
  }
  private showError(message: string) { const error = this.find('#referenceError'); error.textContent = message; error.hidden = false; }
  private clearError() { this.find('#referenceError').hidden = true; }
  private emptyReport(title: string, detail: string) {
    this.find('#referenceState').textContent = 'YOUR SCENE DRAFT';
    this.find('#referenceReport').innerHTML = `<div class="reference-empty"><h3>${escapeHTML(title)}</h3><p>${escapeHTML(detail)}</p></div>`;
  }
  private async loadDemo() {
    if (this.busy || this.loadingDemo) return;
    this.cancelOperation(); this.clearError(); this.video = null; this.image=null; this.draft = null; this.source=null;this.showSamples();this.loadingDemo = true;
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
    if (isReferenceImage(file)) return this.chooseImage(file);
    this.cancelOperation(); this.clearError(); this.video = null; this.image=null;this.still.hidden=true; this.draft = null; this.run = null; this.source = null; this.showTracks(); this.showSamples();

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
      this.preparingSource=true;this.updateButtons();this.emptyReport('Finding shots', 'Scanning this clip on your device before AI analysis.');
      const source=await collectReferenceSource(video,this.controller.signal,message=>{if(operation===this.operation)this.find('#referenceMetadata').textContent=message;});
      if(operation!==this.operation)return;
      this.source=source;this.preparingSource=false;void this.shareReference?.(file,video,Promise.resolve(source.cuts)).catch(error=>this.showError('Reference frames were not saved: '+error.message));this.showSamples();
      this.find('#referenceMetadata').textContent = `${video.duration.toFixed(1)}s · ${video.width} × ${video.height} · ${(file.size / 1_000_000).toFixed(2)} MB`;
      this.emptyReport('Ready to analyze', `${source.cuts.length+1} shots and ${source.frames.length} selected frames. Muse will read the full clip and reuse these source measurements.`);
    } catch (error) {
      if (operation !== this.operation) return;
      this.preparingSource=false;
      this.find('#referenceMetadata').textContent = 'Choose another clip'; this.showError((error as Error).message);
      this.emptyReport('Clip could not be opened', 'Choose a short MP4 or WebM video.');
    }
    this.updateButtons();
  }
  private async chooseImage(file: File) {
    this.cancelOperation(); this.clearError(); this.video = null; this.image = null; this.draft = null; this.showTracks();
    this.source=null;this.run=null;this.showSamples();
    const operation = this.operation;
    this.controller = new AbortController();
    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
    this.player.pause(); this.player.removeAttribute('src'); this.player.hidden = true; this.still.hidden = true;
    this.find('.reference-placeholder').hidden = false;
    this.find('#referenceFileName').textContent = file.name;
    this.find('#referenceMetadata').textContent = 'Reading image…';
    this.emptyReport('Reading your image', 'Large photos are reduced in your browser before sending.');
    this.updateButtons();
    try {
      const image = await readReferenceImage(file, this.controller.signal);
      if (operation !== this.operation) return;
      this.image = image;
      this.objectURL = URL.createObjectURL(file); this.still.src = this.objectURL; this.still.hidden = false;
      this.find('.reference-placeholder').hidden = true;
      this.find('#referenceMetadata').textContent = `${image.width} × ${image.height} · image · becomes a ${image.duration} s shot`;
      this.emptyReport('Ready to analyze', 'Muse reads it as one shot: people, props, drawn movement arrows and the camera.');
    } catch (error) {
      if (operation !== this.operation) return;
      this.find('#referenceMetadata').textContent = 'Choose another image'; this.showError((error as Error).message);
      this.emptyReport('Image could not be opened', 'Choose a PNG, JPEG or WebP image.');
    }
    this.updateButtons();
  }
  /** SAM 3.1 boxes stay on the reference player while its draft is under review. */
  private showTracks(draft?: ReferenceDraft) {
    this.disposeTracks?.(); this.disposeTracks = draft?.tracks?.length ? attachTrackOverlay(this.player, draft.tracks) : null;
  }
  private showSamples(){
    const panel=this.find<HTMLDetailsElement>('#referenceSamples'),source=this.source;
    panel.hidden=!source;if(!source){panel.open=false;this.find('.reference-sample-list').replaceChildren();return;}
    panel.querySelector('summary')!.textContent=`${source.cuts.length+1} shots · ${source.frames.length} selected frames`;
    const bounds=[0,...source.cuts,this.video!.duration];
    this.find('.reference-sample-list').innerHTML=bounds.slice(1).map((end,shotIndex)=>`<section><h4>Shot ${shotIndex+1} <span>${bounds[shotIndex].toFixed(2)}–${end.toFixed(2)}s</span></h4><div>${source.frames.filter(frame=>frame.shotIndex===shotIndex).map(frame=>`<button type="button" data-source-time="${frame.time}" title="${escapeHTML((frame.reason??'selected frame').replaceAll('-',' '))} · ${frame.time.toFixed(3)}s"><img src="${escapeHTML(frame.dataUrl)}" alt="Shot ${shotIndex+1} at ${frame.time.toFixed(2)} seconds"/><span>${frame.time.toFixed(2)}s · ${escapeHTML((frame.reason??'selected').replaceAll('-',' '))}</span></button>`).join('')}</div></section>`).join('')+`<p>${source.sampling?`${source.sampling.decodedFrames} frames scanned locally. `:''}Click a frame to inspect its source time.${source.sampling?.limited?' Frame budget reached; every shot is represented.':''}</p>`;
  }
  private async analyze() {
    if (!this.image&&videoExportIssue()) { this.showError('Reference analysis needs localhost or HTTPS to render its review video.'); return; }
    if ((!this.video&&!this.image) || !this.connection?.available || this.busy || !this.storage()?.canEdit) return;
    const resume = this.run?.error;
    this.cancelOperation(); this.clearError(); this.draft = null; this.busy = true; this.player.pause(); this.showTracks();
    if (!resume) this.run = { id: newId(), attempts: [], ...(this.source?{source:structuredClone(this.source)}:{}) };

    const operation = this.operation; this.controller = new AbortController();
    this.find('#referenceState').textContent = 'ANALYZING REFERENCE';
    this.find('#referenceReport').innerHTML = '<div class="reference-empty reference-analyzing"><span class="reference-orbit" aria-hidden="true"></span><h3>Reading your clip</h3><p data-progress>Preparing source frames…</p></div>';
    this.updateButtons();
    try {
      const input = { video: this.video!, direction: this.direction.value.trim() }, storage = this.storage()!, room = storage.room, sourceName = this.find('#referenceFileName').textContent ?? 'Reference clip';
      const draft = this.image?await requestReferenceDraft({image:this.image,direction:input.direction},this.controller.signal):await reconstructReference(input, this.capture, this.controller.signal,
        message => { if (operation === this.operation) this.find('[data-progress]').textContent = message; }, this.run!, async run => {
          await storage.putOutput({ id: run.id, kind: 'reference-analysis', sceneId: '', shotId: '', name: sourceName, mime: 'application/json' }, new Blob([JSON.stringify({ run, input, sourceName })], { type: 'application/json' }), room);
        });
      if (operation !== this.operation) return;
      this.showDraft(draft); this.showTracks(draft);

    } catch (error) {
      if (operation !== this.operation) return;
      this.showError((error as Error).message);
      // Every review round was rejected: offer the best-scoring reviewed draft, clearly marked, so it can still be edited by hand.
      const best = this.bestReviewedDraft();
      if (best) { this.showDraft(best, false); this.showTracks(best); }
      else this.emptyReport('Analysis stopped', 'Completed steps are retained. Resume when you are ready.');
    }
    if (operation === this.operation) { this.busy = false; this.updateButtons(); }
  }
  private bestReviewedDraft():ReferenceDraft|null{
    const reviewed=(this.run?.attempts??[]).filter(attempt=>attempt.quality&&!attempt.quality.approved);
    if(this.run?.phase!=='failed'||!reviewed.length)return null;
    const total=(attempt:typeof reviewed[number])=>Object.values(attempt.quality!.scores??{}).reduce((sum,score)=>sum+Number(score),0);
    const best=reviewed.reduce((a,b)=>total(b)>total(a)?b:a),round=reviewed.indexOf(best)+1;
    const scores=Object.entries(best.quality!.scores??{}).map(([name,score])=>`${name} ${score}`).join(', ');
    return {...best.result,scene:structuredClone(best.scene),assets:structuredClone(best.assets??[]),analysis:best.analysis??best.result?.analysis,bindings:best.bindings??best.result?.bindings,quality:best.quality,
      summary:`Best of ${reviewed.length} reviewed drafts (round ${round}: ${scores} of 10). It did not pass Muse's visual review, so check framing and blocking before you rely on it.`,
      assumptions:best.result?.assumptions??[],provider:best.result?.provider??'Meta',model:best.result?.model??''};
  }
  private showDraft(draft:ReferenceDraft,approved=true){
      this.draft=draft;const animated=draft.scene.objects.filter(item=>item.track||Object.keys(item.animation?.curves??{}).length).length;
      this.find('#referenceState').textContent = approved ? 'DRAFT READY · VISUAL REVIEW PASSED' : 'BEST DRAFT · DID NOT PASS VISUAL REVIEW';
      this.applyButton.textContent = approved ? 'Use scene' : 'Use draft anyway';
      const palette=[...new Set(draft.scene.objects.map(item=>item.color))];
      this.find('#referenceReport').innerHTML = `<div class="reference-draft-summary"><h3>${escapeHTML(draft.scene.name)}</h3><p>${escapeHTML(readableTimes(draft.summary))}</p><div class="reference-output-tags"><span>${draft.scene.objects.length} objects</span><span>${animated} moving</span><span>${draft.scene.shots.length} shots</span><span>${draft.scene.cameras.filter(camera=>camera.track).length} camera moves</span></div><div class="reference-palette" aria-label="Scene palette">${palette.map(color=>`<span title="${color}" style="display:inline-block;width:22px;height:22px;border-radius:4px;margin:8px 4px 0 0;background:${color}"></span>`).join('')}</div></div><ol class="reference-object-list">${draft.scene.shots.map(shot=>`<li><span class="reference-kind">${shot.start.toFixed(2)}–${(shot.start+shot.duration).toFixed(2)}s</span><span>${escapeHTML(shot.name)}</span></li>`).join('')}</ol><ul class="reference-object-list">${draft.scene.objects.map(item => `<li><span class="reference-kind">${escapeHTML(item.kind)}${item.track?' · motion':''}</span><span>${escapeHTML(item.name)}</span></li>`).join('')}</ul>${draft.assumptions.length ? `<div class="reference-assumptions"><h4>Estimated / simplified</h4><ul>${draft.assumptions.map(item => `<li>${escapeHTML(readableTimes(item))}</li>`).join('')}</ul></div>` : ''}`;
  }
  private cancelAnalysis(){
    const scanning=this.preparingSource;
    if (this.run && this.busy) this.run.error = 'Analysis interrupted. Resume explicitly to continue.';
    this.cancelOperation(); this.emptyReport(scanning?'Scan stopped':'Analysis stopped', scanning?'Choose the clip again to restart the local scan.':'Completed steps are retained. Resume when you are ready.'); this.updateButtons();
  }
  private downloadAnalysis() {
    if (!this.run) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.run)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'LittleTake-reference-analysis.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  restore(value: unknown) {
    const saved = z.object({ run: z.object({ id: z.uuid(), attempts: z.array(z.unknown()).max(4) }).passthrough(), input: z.object({ video: z.object({ dataUrl: z.string().startsWith('data:video/').max(4_000_100), duration: z.number().min(1).max(60), width: z.number().positive(), height: z.number().positive() }), direction: z.string().max(1200) }), sourceName: z.string().max(240) }).parse(value);
    this.contextChanged(); this.run = saved.run as ReferenceRun; this.video = saved.input.video; this.direction.value = saved.input.direction;
    this.source=this.run.source??null;this.showSamples();
    this.player.src = this.video.dataUrl; this.player.hidden = false; this.find('.reference-placeholder').hidden = true;
    this.find('#referenceFileName').textContent = saved.sourceName;
    this.find('#referenceMetadata').textContent = `${this.video.duration.toFixed(1)}s · ${this.video.width} × ${this.video.height}`;
    if (this.run.result) { const draft = parseReferenceDraft(this.run.result); if (draft.quality?.approved) { this.showDraft(draft); this.showTracks(draft); } else { this.run.phase = 'failed'; delete this.run.result; } }
    const best = this.draft ? null : this.bestReviewedDraft();
    if (best) { this.showError(this.run.error ?? 'The rendered reconstruction did not pass visual review.'); this.showDraft(best, false); this.showTracks(best); }
    else if (!this.draft) { this.run.error ??= 'This analysis was interrupted. Resume explicitly to continue.'; this.emptyReport('Saved analysis restored', 'Completed steps are kept. Resume when you are ready.'); }
    this.open(); this.updateButtons();
  }
  contextChanged() { this.root.close(); this.cancelOperation(); this.video = null; this.draft = null; this.run = null; this.source=null;this.showSamples();this.showTracks(); this.emptyReport('Choose a reference clip', 'Analysis belongs to the current project.'); this.updateButtons(); }
}
