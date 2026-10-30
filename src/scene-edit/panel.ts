import './panel.css';
import { downloadDiagnostics } from './diagnostic-store';
import { sceneEntity } from '../model';
import type { ConversationBook, ChatMessage, AssistantMessage } from './conversations';
import { ConversationSession, type SessionOptions } from './session';
import { prepareReferenceFrames } from '../reference/frames';
import { loadReference, saveReference, saveObservations, detachReference, requestReferenceFrames } from '../reference/store';
import type { ReferenceContext } from '../reference/observations';
import type { ReferenceInput } from '../reference/types';

interface Options extends Omit<SessionOptions, 'changed'> {
  root: HTMLElement; book: ConversationBook; changed(): void; clearSelection(): void;
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
  constructor(private readonly options: Options) {
    options.root.innerHTML = `
      <div class="conversation-heading"><button type="button" data-chat="history" aria-label="Conversation history" aria-expanded="false"><span class="conversation-title"></span><span class="chevron">⌄</span></button><button type="button" class="icon-button" data-chat="new" aria-label="New conversation" title="New conversation">＋</button></div>
      <div class="conversation-picker" hidden><div class="picker-label">THIS PROJECT <span class="conversation-count"></span></div><input type="search" aria-label="Search conversations" placeholder="Find a conversation…"/><div class="conversation-list"></div><button type="button" class="picker-new" data-chat="new">＋ New conversation</button></div>
      <div class="scene-context"><span class="context-dot"></span>Project context <span class="scene-context-detail"></span></div>
      <div class="chat-messages" role="log" aria-label="Conversation messages" aria-live="polite"></div>
      <div class="chat-reference" hidden></div>
      <input class="chat-reference-file" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" hidden/>
      <dialog class="chat-reference-view"><button type="button" data-chat="close-reference">Close</button><p class="reference-view-caption"></p><img alt="Original reference frame"/></dialog>
      <form class="chat-composer"><div class="selection-chip" hidden></div><textarea id="sceneInstruction" aria-label="Message Muse" maxlength="2000" rows="3" placeholder="Ask about the scene or describe a change…"></textarea><div class="composer-footer"><button type="button" data-chat="attach-reference" title="Attach an original image or reference clip for Muse">＋ Reference</button><span>Enter to send · Shift ↵</span><button type="submit" class="send-button" aria-label="Send message">↑</button><button type="button" data-chat="stop" hidden>■ Stop</button></div></form>
      <div class="chat-footnote">Changes appear as a preview before you apply them.<br/><button type="button" data-chat="diagnostics">Download diagnostics</button><span class="diagnostic-status" role="status"></span></div>`;
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
        target.disabled = true;
        void downloadDiagnostics(this.session.active).then(count => { this.query('.diagnostic-status').textContent = ` ${count} requests exported.`; })
          .catch(error => { this.query('.diagnostic-status').textContent = ` ${error.message}`; }).finally(() => { target.disabled = false; });
      }
      if (chat === 'clear-selection') options.clearSelection();
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
    options.root.addEventListener('keydown', event => { if (event.key === 'Escape') { this.closePicker(); this.query('[data-chat="history"]').focus(); } });
    document.addEventListener('pointerdown', event => { if (!this.query('.conversation-picker').contains(event.target as Node) && !(event.target as HTMLElement).closest('[data-chat="history"]')) this.closePicker(); });
    this.render();
    void fetch('/api/scene-edit').then(response => response.json()).then(connection => {
      if (typeof connection.model === 'string') this.model = connection.model.includes('contributor') ? 'Contributor' : connection.model;
      const label = document.querySelector<HTMLElement>('#museModel'); if (label) label.textContent = this.model;
    }).catch(() => { /* Sending a message reports connection errors without hiding saved history. */ });
  }
  private query<T extends HTMLElement = HTMLElement>(selector: string): T { return this.options.root.querySelector<T>(selector)!; }
  async attachReference(file: File, video?: ReferenceInput['video'], cuts?: Promise<number[]>): Promise<void> {
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
  private renderPicker() {
    const query = this.query<HTMLInputElement>('input[type="search"]').value.toLowerCase();
    this.query('.conversation-count').textContent = String(this.session.book.threads.length);
    this.query('.conversation-list').innerHTML = this.session.book.threads.filter(t => t.title.toLowerCase().includes(query)).map(thread => {
      const subtitle = thread.draft ? `Draft · ${thread.draft}` : [...thread.messages].reverse().find(m => m.role === 'user')?.text || 'No messages yet';
      return `<button type="button" class="conversation-row" data-thread="${esc(thread.id)}" aria-current="${thread.id === this.session.book.activeId}"><strong>${esc(thread.title)}${thread.id === this.session.book.activeId ? '<b>✓</b>' : ''}</strong><span>${esc(subtitle)}</span></button>`;
    }).join('') || '<p class="property-note">No conversations found.</p>';
  }
  private editCard(message: AssistantMessage): string {
    const edit = message.edit; if (!edit) return '';
    if (edit.status === 'applied') return '<span class="chat-applied">✓ Applied earlier</span>';
    if (edit.status === 'discarded') return '<span class="change-note">Not applied</span>';
    if (edit.status === 'stale' || edit.revision !== this.options.context().revision)
      return `<div class="change-card"><div class="change-title">Scene changed since this suggestion</div><div class="change-description">Ask Muse for a new preview using the current scene.</div><div class="change-actions"><button type="button" data-refresh="${esc(message.id)}" ${this.session.busy ? 'disabled' : ''}>Update preview ↗</button></div></div>`;
    const reviewing = this.session.previewMessageId === message.id;
    return `<div class="change-card"><div class="change-title">${edit.operations.length} scene ${edit.operations.length === 1 ? 'change' : 'changes'}</div><div class="change-description">${reviewing ? 'Preview only · not applied' : 'Ready to review'}</div>${reviewing ? `<div class="change-compare"><button type="button" data-before="${esc(message.id)}" aria-pressed="${!this.session.after}">Before</button><button type="button" data-after="${esc(message.id)}" aria-pressed="${this.session.after}">After</button></div>` : ''}<div class="change-actions"><button type="button" data-discard="${esc(message.id)}">Discard</button><button type="button" class="primary-button" ${reviewing ? `data-apply="${esc(message.id)}"` : `data-review="${esc(message.id)}"`}>${reviewing ? 'Apply changes' : 'Review changes'}</button></div></div>`;
  }
  private renderMessage(message: ChatMessage): string {
    const evidence = this.session.evidenceMessageId === message.id && this.session.evidence.length
      ? `<div class="ai-view-evidence">${this.session.evidence.map(snapshot => `<img src="${esc(snapshot.dataUrl)}" alt="${snapshot.view === 'top_down' ? 'Top view' : 'Shot view'} shared with Muse at ${snapshot.time.toFixed(2)}s"/>`).join('')}</div>` : '';
    const body = `<article class="chat-message ${message.role}"><div class="message-label" ${message.role === 'assistant' ? `title="${esc(message.model)}"` : ''}>${message.role === 'user' ? 'You' : '✧ Muse'}</div><p>${esc(message.text)}</p>${evidence}${message.role === 'assistant' ? this.editCard(message) : ''}</article>`;
    if (message.role !== 'user' || !['failed', 'stopped'].includes(message.status)) return body;
    return body + `<div class="chat-${message.status === 'failed' ? 'error' : 'stopped'}">${esc(message.detail || 'Response interrupted. Your message is saved.')}${message === this.session.active.messages.at(-1) ? `<button type="button" data-retry="${esc(message.id)}" ${this.session.busy ? 'disabled' : ''}>Retry response</button>` : ''}</div>`;
  }
  private render() {
    const thread = this.session.active, switched = this.renderedThread !== thread.id;
    this.query('.conversation-title').textContent = thread.title;
    if (this.prompt.value !== thread.draft) this.prompt.value = thread.draft;
    const content = thread.messages.length ? thread.messages.map(message => this.renderMessage(message)).join('') : `<div class="empty-chat"><div class="empty-chat-mark">✧</div><h2>A fresh conversation.</h2><p>Build a set from an idea, or continue editing the current project.</p><div class="chat-suggestions"><button type="button" data-suggestion="Create a new small film set with a floor, two performers, a camera and a shot. Propose it for preview.">Build a new film set <span>↗</span></button><button type="button" data-suggestion="What could we improve about the framing?">Discuss the framing <span>↗</span></button></div></div>`;
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
    const { project, sceneId, shotId, selectedId } = this.options.context();
    const scene = project.scenes.find(item => item.id === sceneId), shot = scene?.shots.find(item => item.id === shotId);
    this.query('.scene-context-detail').textContent = scene ? `${scene.name}${shot ? " · " + shot.name : ""}` : "Empty project · ready to build";
    const selected = scene ? sceneEntity(scene, selectedId) : undefined;
    const chip = this.query('.selection-chip'); chip.hidden = !selected;
    chip.innerHTML = selected ? `<span>◇</span>${esc(selected.name)}<button type="button" data-chat="clear-selection" aria-label="Remove selection context">×</button>` : '';
  }
  sceneChanged() { this.session.sceneChanged(); }
}
