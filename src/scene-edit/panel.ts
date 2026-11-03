import { icon } from '../icons';
import type {ReferenceVideo} from '../reference/types';
import './panel.css';
import { downloadDiagnostics } from './diagnostic-store';
import { animationFor, sceneEntity } from '../model';
import type { ConversationBook, ChatMessage, AssistantMessage } from './conversations';
import type { SceneSnapshot } from './operations';
import { ConversationSession, type SessionOptions } from './session';
import { prepareReferenceFrames } from '../reference/frames';
import { loadReference, saveReference, saveObservations, detachReference, requestReferenceFrames } from '../reference/store';
import type { ReferenceContext } from '../reference/observations';
import type { ReferenceInput } from '../reference/types';
import { performanceTake, performanceKey, MAX_PERFORMANCE_TAKES, type PerformanceTarget } from '../performance/refinement';

/** Prompts that build a complete demo scene in one turn. */
const STARTER_PROMPTS: [label: string, prompt: string][] = [
  ['Knight vs dragon', 'Build a fantasy battle: a knight in silver armor fights a huge red dragon on a rocky cliff at sunset. Over 10 seconds the dragon swoops in and breathes fire, the knight dodges, then charges and strikes. Give me three shots: a wide establishing shot, a low-angle hero push-in on the knight, and an over-the-shoulder shot from behind the dragon.'],
  ['Dragon over the Golden Gate', 'Build a sweeping flight: a knight rides a red dragon that dives from above the north tower of the Golden Gate Bridge, swoops under the deck and climbs out past the south tower at golden hour, over 12 seconds. Three shots: a high wide shot, a chase shot under the deck, and a low shot from the water.'],
  ['Two friends at a café', 'Build a small café: two friends talk at a table by the window, one leans in and laughs. 8 seconds, three shots: a wide two-shot, then an over-the-shoulder shot on each of them.'],
];

interface Options extends Omit<SessionOptions, 'changed'> {
  root: HTMLElement; book: ConversationBook; changed(): void; clearSelection(): void; removeSelection(id: string): void;
}
const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export class SceneEditPanel {
  readonly session: ConversationSession;
  private readonly prompt: HTMLTextAreaElement;
  private readonly messages: HTMLElement;
  private renderedMessages = '';
  private renderedThread = '';
  private renderedLastMessage = '';
  private model = 'Muse';
  private reference: ReferenceContext | undefined;
  private referenceThread = '';
  private referenceLoading: { threadId: string; controller: AbortController; promise: Promise<void> } | null = null;
  private referenceError = '';
  private animationChoices: { target: PerformanceTarget; name: string; detail: string; disabled: string }[] = [];
  private pendingAnimations = new Set<string>();
  private animationPickerContext = '';
  constructor(private readonly options: Options) {
    options.root.innerHTML = `
      <div class="conversation-heading"><button type="button" data-chat="history" aria-label="Conversation history" aria-expanded="false"><span class="conversation-title"></span><span class="chevron">${icon('chevron-down')}</span></button><button type="button" class="icon-button" data-chat="new" aria-label="New conversation" title="New conversation">${icon('plus')}</button><details class="conversation-menu"><summary aria-label="Conversation options" title="Conversation options">${icon('more')}</summary><div class="conversation-menu-content"><div class="conversation-model">Model <span id="museModel">Muse</span></div><button type="button" data-chat="diagnostics">${icon('download')} Download diagnostics</button></div></details></div>
      <div class="conversation-picker" hidden><div class="picker-label">THIS PROJECT <span class="conversation-count"></span></div><input type="search" aria-label="Search conversations" placeholder="Find a conversation…"/><div class="conversation-list"></div><button type="button" class="picker-new" data-chat="new">${icon('plus')} New conversation</button></div>
      <div class="scene-context"><span class="context-dot"></span>Project context <span class="scene-context-detail"></span></div>
      <div class="chat-messages" role="log" aria-label="Conversation messages" aria-live="polite"></div>
      <div class="chat-reference" hidden></div>
      <div class="performance-picker" role="region" aria-label="Choose animations" hidden>
        <div class="performance-picker-heading"><strong>Select animations</strong><button type="button" data-chat="cancel-animations" aria-label="Close animation picker">${icon('close')}</button></div>
        <input type="search" class="animation-search" aria-label="Search animations" placeholder="Search objects or cameras…"/>
        <div class="animation-choices"></div><p class="animation-picker-note" role="status"></p>
        <div class="performance-picker-actions"><button type="button" data-chat="cancel-animations">Cancel</button><button type="button" class="primary-button" data-chat="use-animations">Attach animations</button></div>
      </div>
      <input class="chat-reference-file" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" hidden/>
      <dialog class="chat-reference-view"><button type="button" data-chat="close-reference">Close</button><p class="reference-view-caption"></p><img alt="Original reference frame"/></dialog>
      <form class="chat-composer"><div class="performance-context" hidden></div><div class="selection-context" hidden></div><textarea id="sceneInstruction" aria-label="Message Muse" maxlength="2000" rows="3" placeholder="Describe an edit or ask about the scene…" title="Enter to send · Shift + Enter for a new line"></textarea><div class="composer-footer"><button type="button" data-chat="animations" aria-expanded="false" title="Select recorded animations to refine together">${icon('sparkles')} Animation</button><button type="button" data-chat="attach-reference" title="Attach an original image or reference clip for Muse">${icon('plus')} Reference</button><button type="submit" class="send-button" aria-label="Send message" title="Send message · Enter">${icon('arrow-up')}</button><button type="button" data-chat="stop" hidden>${icon('stop')} Stop</button></div></form>
      <div class="chat-footnote"><span class="diagnostic-status" role="status"></span></div>`;
    this.prompt = this.query('textarea'); this.messages = this.query('.chat-messages');
    this.session = new ConversationSession(options.book, { ...options,
      reference: async threadId => { if (this.referenceLoading?.threadId === threadId) await this.referenceLoading.promise; return loadReference(threadId); },
      saveReferenceObservations: async progress => {
        await saveObservations(progress);
        const threadId = this.session.active.id, reference = await loadReference(threadId);
        if (this.session.active.id === threadId && reference?.source.id === progress.sourceId) { this.reference = reference; this.renderReference(); }
      },
      requestReferenceFrames: async (threadId, sourceId, times, signal) => { const reference = await requestReferenceFrames(threadId, sourceId, times, signal); if (this.session.active.id === threadId) { this.reference = reference; this.renderReference(); } return reference; },
      changed: () => { this.render(); options.changed(); } });
    options.root.addEventListener('click', event => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!target) return;
      const { chat, thread, review, before, after, apply, discard, retry, refresh, suggestion } = target.dataset;
      if (chat === 'history') { const picker = this.query('.conversation-picker'); picker.hidden = !picker.hidden; target.setAttribute('aria-expanded', String(!picker.hidden)); this.renderPicker(); if (!picker.hidden) this.query<HTMLInputElement>('input[type="search"]').focus(); }
      if (chat === 'new') { this.closePicker(); this.session.create(); this.prompt.focus(); }
      if (thread) { this.closePicker(); this.session.switch(thread); }
      if (chat === 'stop') this.session.cancel();
      if (chat === 'detach-performance') this.session.detachPerformance();
      if (target.dataset.removePerformance !== undefined) this.session.detachPerformance(Number(target.dataset.removePerformance));
      if (chat === 'animations') this.openAnimationPicker();
      if (chat === 'cancel-animations') this.closeAnimationPicker();
      if (chat === 'use-animations') {
        try {
          const targets = this.animationChoices.filter(choice => this.pendingAnimations.has(performanceKey(choice.target))).map(choice => choice.target);
          this.session.attachPerformance(targets); this.closeAnimationPicker(); this.prompt.focus();
        } catch (error) { this.query('.animation-picker-note').textContent = (error as Error).message; }
      }
      if (target.dataset.playReview) this.session.playReview(target.dataset.playReview);
      if (target.dataset.evidence !== undefined) {
        const snapshot = this.session.evidence[Number(target.dataset.evidence)];
        if (snapshot) {
          this.query<HTMLImageElement>('.chat-reference-view img').src = snapshot.dataUrl;
          this.query<HTMLImageElement>('.chat-reference-view img').alt = 'Rendered performance frame';
          this.query('.reference-view-caption').textContent = this.evidenceCaption(snapshot);
          this.query<HTMLDialogElement>('.chat-reference-view').showModal();
        }
      }
      if (chat === 'attach-reference') this.query<HTMLInputElement>('.chat-reference-file').click();
      if (chat === 'detach-reference') {
        const threadId = this.session.active.id; this.referenceLoading?.controller.abort(); this.session.cancel('Reference detached. Your message is saved.');
        void detachReference(threadId).then(() => { if (this.session.active.id === threadId) { this.reference = undefined; this.referenceError = ''; this.renderReference(); } }).catch(error => { this.referenceError = error.message; this.renderReference(); });
      }
      if (chat === 'close-reference') this.query<HTMLDialogElement>('.chat-reference-view').close();
      if (target.dataset.referenceFrame && this.reference) {
        const frame = this.reference.source.frames.find(frame => frame.id === target.dataset.referenceFrame);
        if (frame) { this.query<HTMLImageElement>('.chat-reference-view img').src = frame.dataUrl; this.query<HTMLImageElement>('.chat-reference-view img').alt = 'Original reference frame'; this.query('.reference-view-caption').textContent = `${this.reference.source.name} · shot ${frame.shot + 1} · ${frame.time.toFixed(3)}s · ${frame.width} × ${frame.height}`; this.query<HTMLDialogElement>('.chat-reference-view').showModal(); }
      }
      if (target.dataset.referenceObservation && this.reference) {
        const observation = this.reference.observations.find(item => item.id === target.dataset.referenceObservation);
        if (observation) { this.query<HTMLImageElement>('.chat-reference-view img').src = observation.overlayDataUrl; this.query<HTMLImageElement>('.chat-reference-view img').alt = 'SAM mask overlay with false colors'; this.query('.reference-view-caption').textContent = `SAM · ${observation.concept} · ${observation.instances.length} masks · false colors identify masks, not materials`; this.query<HTMLDialogElement>('.chat-reference-view').showModal(); }
      }
      if (chat === 'diagnostics') {
        this.query<HTMLDetailsElement>('.conversation-menu').open = false;
        target.disabled = true;
        void downloadDiagnostics(this.session.active).then(count => { this.query('.diagnostic-status').textContent = ` ${count} requests exported.`; })
          .catch(error => { this.query('.diagnostic-status').textContent = ` ${error.message}`; }).finally(() => { target.disabled = false; });
      }
      if (chat === 'clear-selection') options.clearSelection();
      if (target.dataset.removeSelection) options.removeSelection(target.dataset.removeSelection);
      if (review || before || after) this.session.review((review || before || after)!, !before);
      if (apply) this.session.apply(apply);
      if (discard) this.session.discard(discard);
      if (retry) void this.session.send(retry);
      if (refresh) void this.session.refresh(refresh);
      if (suggestion) { this.session.setDraft(suggestion); this.prompt.focus(); }
    });
    this.query('form').addEventListener('submit', event => { event.preventDefault(); void this.session.send(); });
    this.query<HTMLInputElement>('.chat-reference-file').addEventListener('change', event => { const file = (event.target as HTMLInputElement).files?.[0]; if (file) void this.attachReference(file).catch(() => {}); (event.target as HTMLInputElement).value = ''; });
    this.prompt.addEventListener('input', () => this.session.setDraft(this.prompt.value));
    this.prompt.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.session.send(); }
    });
    this.query('input[type="search"]').addEventListener('input', () => this.renderPicker());
    this.query('.animation-search').addEventListener('input', () => this.renderAnimationChoices());
    this.query('.animation-choices').addEventListener('change', event => {
      const checkbox = event.target as HTMLInputElement, key = checkbox.dataset.animationChoice;
      if (!key) return;
      if (checkbox.checked) this.pendingAnimations.add(key); else this.pendingAnimations.delete(key);
      this.updateAnimationCount();
    });
    options.root.addEventListener('keydown', event => { if (event.key === 'Escape') {
      if (this.query<HTMLDetailsElement>('.conversation-menu').open) { event.preventDefault(); event.stopPropagation(); this.query<HTMLDetailsElement>('.conversation-menu').open = false; this.query('.conversation-menu summary').focus(); }
      else if (!this.query('.performance-picker').hidden) { event.preventDefault(); event.stopPropagation(); this.closeAnimationPicker(); this.query('[data-chat="animations"]').focus(); }
      else { this.closePicker(); this.query('[data-chat="history"]').focus(); }
    } });
    document.addEventListener('pointerdown', event => { if (!this.query('.conversation-picker').contains(event.target as Node) && !(event.target as HTMLElement).closest('[data-chat="history"]')) this.closePicker(); if (!this.query('.conversation-menu').contains(event.target as Node)) this.query<HTMLDetailsElement>('.conversation-menu').open = false; });
    this.render();
    void fetch('/api/scene-edit').then(response => response.json()).then(connection => {
      if (typeof connection.model === 'string') this.model = connection.model.includes('contributor') ? 'Contributor' : connection.model;
      const label = document.querySelector<HTMLElement>('#museModel'); if (label) label.textContent = this.model;
    }).catch(() => { /* Sending a message reports connection errors without hiding saved history. */ });
  }
  private query<T extends HTMLElement = HTMLElement>(selector: string): T { return this.options.root.querySelector<T>(selector)!; }
  async attachReference(file: File, video?: ReferenceVideo, cuts?: Promise<number[]>): Promise<void> {
    const threadId = this.session.active.id;
    this.referenceLoading?.controller.abort(); this.session.cancel('Reference changed. Your message is saved.'); this.referenceError = '';
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const source = await prepareReferenceFrames(file, controller.signal, video, cuts);
        controller.signal.throwIfAborted(); if (this.session.active.id !== threadId) return;
        await saveReference(threadId, source, file);
        if (this.session.active.id === threadId && !controller.signal.aborted) { this.reference = { source, observations: [], callsUsed: 0, framesRequested: false }; this.referenceThread = threadId; this.options.changed(); }
      } catch (error) { if (!controller.signal.aborted && this.session.active.id === threadId) this.referenceError = error instanceof Error ? error.message : 'Reference frames could not be prepared.'; throw error; }
      finally { if (this.referenceLoading?.controller === controller) this.referenceLoading = null; this.renderReference(); }
    })();
    this.referenceLoading = { threadId, controller, promise }; this.renderReference();
    return promise;
  }
  private renderReference() {
    const threadId = this.session.active.id;
    if (this.referenceThread !== threadId) {
      this.referenceThread = threadId; this.reference = undefined; this.referenceError = '';
      if (this.referenceLoading && this.referenceLoading.threadId !== threadId) this.referenceLoading.controller.abort();
      void loadReference(threadId).then(reference => { if (this.session.active.id === threadId && !this.referenceLoading) { this.reference = reference; this.renderReference(); } }).catch(error => { if (this.session.active.id === threadId) { this.referenceError = error.message; this.renderReference(); } });
    }
    const box = this.query('.chat-reference'), busy = this.referenceLoading?.threadId === threadId;
    box.hidden = !busy && !this.reference && !this.referenceError;
    if (busy) box.innerHTML = '<p role="status">Selecting clear reference frames…</p>';
    else if (this.referenceError) box.innerHTML = `<p role="status">${esc(this.referenceError)}</p>`;
    else if (this.reference) {
      const { source, observations } = this.reference, open = box.querySelector('details')?.open;
      box.innerHTML = `<details ${open ? 'open' : ''}><summary>${esc(source.name)} · ${source.frames.length} reference frames${observations.length ? ` · ${observations.length} SAM results` : ''}</summary><p>Original reference for this conversation. Muse selects frames and concepts when needed.</p><div class="reference-candidates">${source.frames.map(frame => `<button type="button" data-reference-frame="${esc(frame.id)}" title="Inspect original frame"><img src="${frame.dataUrl}" alt="Reference shot ${frame.shot + 1} at ${frame.time.toFixed(3)} seconds"/><span>Shot ${frame.shot + 1} · ${frame.time.toFixed(2)}s</span><small>${frame.role}</small></button>`).join('')}</div>${source.omittedShots ? `<p>${source.omittedShots} shorter shots are outside this candidate set.</p>` : ''}${observations.length ? `<p>Saved SAM observations · false colors</p><div class="reference-candidates">${observations.map(observation => `<button type="button" data-reference-observation="${esc(observation.id)}"><img src="${observation.overlayDataUrl}" alt="SAM ${esc(observation.concept)} mask overlay"/><span>${esc(observation.concept)} · ${observation.instances.length} masks</span></button>`).join('')}</div>` : ''}<button type="button" data-chat="detach-reference">Detach reference</button></details>`;
    }
    this.query<HTMLButtonElement>('[data-chat="attach-reference"]').disabled = Boolean(busy);
  }
  private closePicker() { this.query('.conversation-picker').hidden = true; this.query('[data-chat="history"]').setAttribute('aria-expanded', 'false'); }
  private closeAnimationPicker() {
    this.query('.performance-picker').hidden = true;
    this.options.root.querySelectorAll('[data-chat="animations"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }
  private openAnimationPicker() {
    if (this.session.busy) return;
    const context = this.options.context(), scene = context.project.scenes.find(scene => scene.id === context.sceneId);
    if (!scene) return;
    this.animationPickerContext = `${this.session.active.id}:${scene.id}`;
    this.animationChoices = [...scene.objects, ...scene.cameras].flatMap(item => (animationFor(item)?.takes ?? []).map(take => {
      const camera = 'fov' in item, shotId = camera ? scene.shots.find(shot => shot.cameraId === item.id)?.id ?? null : context.shotId;
      const target = { sceneId: scene.id, entityId: item.id, takeId: take.id, shotId };
      let disabled = '';
      try { performanceTake(context.project, target); } catch (error) { disabled = (error as Error).message; }
      return { target, name: item.name, detail: `${camera ? 'Camera' : 'Object'} · ${take.start.toFixed(2)}–${take.end.toFixed(2)}s`, disabled };
    }));
    const attached = this.session.active.performance, selectedIds = context.selectedIds ?? (context.selectedId ? [context.selectedId] : []);
    this.pendingAnimations = new Set(this.animationChoices.filter(choice => !choice.disabled && (attached?.some(target => performanceKey(target) === performanceKey(choice.target))
      || !attached && selectedIds.includes(choice.target.entityId) && (() => { const { take } = performanceTake(context.project, choice.target); return context.time >= take.start && context.time <= take.end; })())).slice(0, MAX_PERFORMANCE_TAKES).map(choice => performanceKey(choice.target)));
    this.query<HTMLInputElement>('.animation-search').value = '';
    this.renderAnimationChoices(); this.query('.performance-picker').hidden = false;
    this.options.root.querySelectorAll('[data-chat="animations"]').forEach(button => button.setAttribute('aria-expanded', 'true'));
    this.query<HTMLInputElement>('.animation-search').focus();
  }
  private renderAnimationChoices() {
    const search = this.query<HTMLInputElement>('.animation-search').value.trim().toLowerCase();
    const choices = this.animationChoices.filter(choice => `${choice.name} ${choice.detail}`.toLowerCase().includes(search));
    this.query('.animation-choices').innerHTML = choices.map(choice => {
      const key = performanceKey(choice.target);
      return `<label class="animation-choice" title="${esc(choice.disabled || 'Select this recording')}"><input type="checkbox" data-animation-choice="${esc(key)}" ${this.pendingAnimations.has(key) ? 'checked' : ''} ${choice.disabled ? 'data-unavailable="true" disabled' : ''}/><span><strong>${esc(choice.name)}</strong><small>${esc(choice.disabled || choice.detail)}</small></span></label>`;
    }).join('') || `<p>${this.animationChoices.length ? 'No matching animations.' : 'No recorded animations in this scene yet. Keep a recording, then attach it here.'}</p>`;
    this.updateAnimationCount();
  }
  private updateAnimationCount() {
    const count = this.pendingAnimations.size;
    this.query<HTMLButtonElement>('[data-chat="use-animations"]').disabled = !count;
    this.query('[data-chat="use-animations"]').textContent = count ? `Attach ${count} animation${count === 1 ? '' : 's'}` : 'Attach animations';
    this.query('.animation-picker-note').textContent = count ? `${count} selected · ${count >= MAX_PERFORMANCE_TAKES ? 'Selection limit reached' : 'Refine together in this conversation'}` : 'Choose one or more recorded animations.';
    this.options.root.querySelectorAll<HTMLInputElement>('[data-animation-choice]').forEach(input => { input.disabled = input.dataset.unavailable === 'true' || count >= MAX_PERFORMANCE_TAKES && !input.checked; });
  }
  private renderPicker() {
    const query = this.query<HTMLInputElement>('input[type="search"]').value.toLowerCase();
    this.query('.conversation-count').textContent = String(this.session.book.threads.length);
    this.query('.conversation-list').innerHTML = this.session.book.threads.filter(t => t.title.toLowerCase().includes(query)).map(thread => {
      const subtitle = thread.draft ? `Draft · ${thread.draft}` : [...thread.messages].reverse().find(m => m.role === 'user')?.text || 'No messages yet';
      return `<button type="button" class="conversation-row" data-thread="${esc(thread.id)}" aria-current="${thread.id === this.session.book.activeId}"><strong>${esc(thread.title)}${thread.id === this.session.book.activeId ? `<b>${icon('check')}</b>` : ''}</strong><span>${esc(subtitle)}</span></button>`;
    }).join('') || '<p class="property-note">No conversations found.</p>';
  }
  private editCard(message: AssistantMessage): string {
    const edit = message.edit; if (!edit) return '';
    if (edit.status === 'applied') return `<span class="chat-applied">${icon('check')} Applied earlier</span>`;
    if (edit.status === 'discarded') return '<span class="change-note">Not applied</span>';
    if (edit.status === 'stale' || edit.revision !== this.options.context().revision)
      return `<div class="change-card"><div class="change-title">Scene changed since this suggestion</div><div class="change-description">Ask Muse for a new preview using the current scene.</div><div class="change-actions"><button type="button" data-refresh="${esc(message.id)}" ${this.session.busy ? 'disabled' : ''}>Update preview ${icon('external')}</button></div></div>`;
    const reviewing = this.session.previewMessageId === message.id, recordings = edit.operations.filter(operation => operation.type === 'refine_take').length;
    const title = recordings ? `${recordings} refined animation${recordings === 1 ? '' : 's'}` : `${edit.operations.length} scene ${edit.operations.length === 1 ? 'change' : 'changes'}`;
    return `<div class="change-card"><div class="change-title">${title}</div><div class="change-description">${reviewing ? 'Preview only · not applied' : 'Ready to review'}</div>${reviewing ? `<div class="change-compare"><button type="button" data-before="${esc(message.id)}" aria-pressed="${!this.session.after}">Before</button><button type="button" data-after="${esc(message.id)}" aria-pressed="${this.session.after}">After</button></div>` : ''}<div class="change-actions">${recordings ? `<button type="button" data-play-review="${esc(message.id)}">${icon('play')} Play selection</button>` : ''}<button type="button" data-discard="${esc(message.id)}">Discard</button><button type="button" class="primary-button" ${reviewing ? `data-apply="${esc(message.id)}"` : `data-review="${esc(message.id)}"`}>${reviewing ? 'Apply changes' : 'Review changes'}</button></div></div>`;
  }
  private evidenceCaption(snapshot: SceneSnapshot) {
    const shot = this.options.context().project.scenes.flatMap(scene => scene.shots).find(shot => shot.id === snapshot.shotId);
    return `${snapshot.variant === 'after' ? 'Refined' : 'Original'} · ${snapshot.view === 'top_down' ? 'Top view' : shot?.name ?? 'Shot view'} · ${snapshot.time.toFixed(2)}s`;
  }
  private renderMessage(message: ChatMessage): string {
    const evidence = this.session.evidenceMessageId === message.id && this.session.evidence.length
      ? `<details class="performance-evidence"><summary>Rendered views shared with Muse · ${this.session.evidence.length}</summary><div class="ai-view-evidence">${this.session.evidence.map((snapshot, index) => `<button type="button" data-evidence="${index}" title="Inspect rendered frame"><img src="${esc(snapshot.dataUrl)}" alt="${esc(this.evidenceCaption(snapshot))}"/><span>${esc(this.evidenceCaption(snapshot))}</span></button>`).join('')}</div></details>` : '';
    const body = `<article class="chat-message ${message.role}"><div class="message-label" ${message.role === 'assistant' ? `title="${esc(message.model)}"` : ''}>${message.role === 'user' ? 'You' : 'Muse'}</div><p>${esc(message.text)}</p>${evidence}${message.role === 'assistant' ? this.editCard(message) : ''}</article>`;
    if (message.role !== 'user' || !['failed', 'stopped'].includes(message.status)) return body;
    return body + `<div class="chat-${message.status === 'failed' ? 'error' : 'stopped'}">${esc(message.detail || 'Response interrupted. Your message is saved.')}${message === this.session.active.messages.at(-1) ? `<button type="button" data-retry="${esc(message.id)}" ${this.session.busy ? 'disabled' : ''}>Retry response</button>` : ''}</div>`;
  }
  refreshConversation() { this.render(); }
  private render() {
    const thread = this.session.active, switched = this.renderedThread !== thread.id;
    this.query('.conversation-title').textContent = thread.title;
    if (this.prompt.value !== thread.draft) this.prompt.value = thread.draft;
    const content = thread.messages.length ? thread.messages.map(message => this.renderMessage(message)).join('') : `<div class="empty-chat"><p><strong>Describe a shot in a sentence.</strong> Muse builds an editable 3D set with characters, cameras and shots, and shows it as a preview before anything changes. Pick a starting point, edit it if you like, then press Enter.</p><div class="chat-suggestions">${STARTER_PROMPTS.map(([label, prompt]) => `<button type="button" data-suggestion="${esc(prompt)}">${esc(label)}</button>`).join('')}<button type="button" data-suggestion="What could we improve about the framing?">Review framing</button></div></div>`;
    const html = content + (this.session.busy ? `<div class="chat-waiting"><i></i>${esc(this.session.activity)}</div>` : '');
    const last = thread.messages.at(-1);
    const newRequest = last?.role === 'user' && last.status === 'pending' && last.id !== this.renderedLastMessage;
    if (html !== this.renderedMessages || switched) {
      const nearBottom = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 60;
      this.messages.innerHTML = html;
      if (switched || nearBottom || newRequest) this.messages.scrollTop = thread.messages.length ? this.messages.scrollHeight : 0;
      this.renderedMessages = html; this.renderedThread = thread.id;
    }
    this.renderedLastMessage = last?.id ?? '';
    this.query<HTMLButtonElement>('[type="submit"]').disabled = this.session.busy || !thread.draft.trim();
    this.query('[type="submit"]').hidden = this.session.busy; this.query('[data-chat="stop"]').hidden = !this.session.busy;
    this.renderPicker(); this.refreshContext(); this.renderReference();
  }
  refreshContext() {
    const { project, sceneId, shotId, selectedId, selectedIds } = this.options.context();
    const scene = project.scenes.find(item => item.id === sceneId), shot = scene?.shots.find(item => item.id === shotId);
    this.query('.scene-context-detail').textContent = scene ? `${scene.name}${shot ? " · " + shot.name : ""}` : "Empty project · ready to build";
    const selected = scene ? (selectedIds ?? (selectedId ? [selectedId] : [])).map(id => sceneEntity(scene, id)).filter(item => item !== undefined) : [];
    const context = this.query('.selection-context'); context.hidden = !selected.length;
    const targets = this.session.active.performance, scope = this.query('.performance-context'); scope.hidden = !targets?.length;
    if (targets?.length) {
      scope.innerHTML = `<div>${icon('sparkles')} ${targets.length} animation${targets.length === 1 ? '' : 's'} <button type="button" data-chat="animations">Change</button><button type="button" data-chat="detach-performance" aria-label="Detach all animations">${icon('close')}</button></div><div class="performance-chips">${targets.map((target, index) => {
        let label = 'Recording unavailable';
        try { const { item, take } = performanceTake(project, target); label = `${item.name} · ${take.start.toFixed(2)}–${take.end.toFixed(2)}s`; } catch { /* A removed recording remains detachable. */ }
        return `<span class="performance-chip">${esc(label)}<button type="button" data-remove-performance="${index}" aria-label="Remove ${esc(label)}">${icon('close')}</button></span>`;
      }).join('')}</div>`;
      context.hidden = true;
    }
    this.query<HTMLButtonElement>('[data-chat="attach-reference"]').hidden = !!targets?.length;
    this.options.root.querySelectorAll<HTMLButtonElement>('[data-chat="animations"]').forEach(button => { button.disabled = this.session.busy || !scene; });
    if (this.animationPickerContext !== `${this.session.active.id}:${sceneId}` || this.session.busy) this.closeAnimationPicker();
    context.innerHTML = selected.length ? `<div class="selection-scope"><span>${selected.length} selected</span><button type="button" data-chat="clear-selection" aria-label="Clear selection">Clear</button></div><div class="selection-chips">${selected.map(item => `<span class="selection-chip" title="${esc(item.name)}"><span>${icon('cube')}</span>${esc(item.name)}<button type="button" data-remove-selection="${esc(item.id)}" aria-label="Remove ${esc(item.name)} from selection">${icon('close')}</button></span>`).join('')}</div>` : '';
  }
  sceneChanged() { this.session.sceneChanged(); }
}
