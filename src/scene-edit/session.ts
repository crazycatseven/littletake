import { serializeContent } from '../project/model.ts';
import type { ProjectContent } from '../types.ts';
import { requestSceneEdit } from './client.ts';
import { applyProjectOperations, type SceneSnapshot, type SceneView } from './operations.ts';
import { conversationHistory, newConversation, type AssistantMessage, type ConversationBook, type UserMessage } from './conversations.ts';
import type { SceneEditInput, SceneEditResponse } from './types.ts';

export interface EditorContext { project: ProjectContent; sceneId: string | null; shotId: string | null; revision: number; time: number; selectedId: string | null }
export interface SessionOptions {
  context(): EditorContext;
  prepare(): void;
  focus?(context: NonNullable<UserMessage['context']>): boolean;
  capture(project: ProjectContent, sceneId: string | null, shotId: string | null, time: number, view: SceneView): SceneSnapshot;
  preview(project: ProjectContent | null, focus?: { sceneId: string | null; shotId: string | null }): void;
  apply(project: ProjectContent, base: string, focus: { sceneId: string | null; shotId: string | null }): boolean;
  changed(): void;
  request?(input: SceneEditInput, signal: AbortSignal): Promise<SceneEditResponse>;
}
interface Run { id: string; threadId: string; message: UserMessage; controller: AbortController; base: string; revision: number }

/** Owns a conversation turn from saved user message through preview and explicit application. */
export class ConversationSession {
  private run: Run | null = null;
  private preview: { messageId: string; project: ProjectContent; base: string; focus: { sceneId: string | null; shotId: string | null } } | null = null;
  activity = '';
  after = true;
  evidence: SceneSnapshot[] = [];
  evidenceMessageId: string | null = null;
  constructor(readonly book: ConversationBook, private readonly options: SessionOptions) {}
  get active() { return this.book.threads.find(thread => thread.id === this.book.activeId)!; }
  get busy() { return this.run !== null; }
  get previewMessageId() { return this.preview?.messageId ?? null; }
  private emit() { this.options.changed(); }
  replaceBook(book: ConversationBook) {
    this.cancel(); this.clearPreview(); this.evidence = []; this.evidenceMessageId = null;
    this.book.activeId = book.activeId; this.book.threads = book.threads; this.emit();
  }
  private clearPreview() { this.preview = null; this.options.preview(null); }
  setDraft(text: string) { this.active.draft = text.slice(0, 2000); this.emit(); }
  create() {
    this.cancel(); const thread = newConversation(); this.book.threads.unshift(thread); this.switch(thread.id);
  }
  switch(id: string) {
    if (!this.book.threads.some(thread => thread.id === id)) return;
    this.cancel(); this.clearPreview(); this.evidence = []; this.evidenceMessageId = null;
    this.book.activeId = id; this.emit();
  }
  cancel(detail = 'Response stopped. Your message is saved.') {
    const run = this.run;
    if (!run) return;
    this.run = null; run.controller.abort(); run.message.status = 'stopped'; run.message.detail = detail;
    this.activity = ''; this.evidence = []; this.emit();
  }
  contextChanged() { this.cancel('The active scene or shot changed. Retry in the intended scene.'); this.clearPreview(); this.evidence = []; this.emit(); }
  sceneChanged() {
    this.cancel('The scene changed while Muse was responding. Retry using the current scene.');
    for (const thread of this.book.threads) for (const message of thread.messages)
      if (message.role === 'assistant' && message.edit?.status === 'pending') message.edit.status = 'stale';
    this.clearPreview(); this.evidence = []; this.emit();
  }
  private assistant(id: string): AssistantMessage | undefined {
    return this.active.messages.find((m): m is AssistantMessage => m.id === id && m.role === 'assistant');
  }
  review(id: string, after = true) {
    const message = this.assistant(id), edit = message?.edit, context = this.options.context();
    if (!edit || edit.status !== 'pending') return;
    if (edit.revision !== context.revision) { edit.status = 'stale'; this.clearPreview(); this.emit(); return; }
    try {
      this.options.prepare();
      this.preview = { messageId: id, base: serializeContent(context.project), project: applyProjectOperations(context.project, edit.operations, edit.time), focus: {
        sceneId: edit.operations.find(op => op.type === 'add_scene')?.sceneId ?? edit.sceneId,
        shotId: edit.shotId,
      } };
      this.after = after; this.options.preview(after ? this.preview.project : null, this.preview.focus);
    } catch { edit.status = 'stale'; this.clearPreview(); }
    this.emit();
  }
  discard(id: string) {
    const edit = this.assistant(id)?.edit;
    if (!edit || edit.status !== 'pending') return;
    edit.status = 'discarded'; if (this.preview?.messageId === id) this.clearPreview(); this.emit();
  }
  apply(id: string) {
    const message = this.assistant(id), edit = message?.edit, preview = this.preview;
    if (!edit || edit.status !== 'pending' || preview?.messageId !== id || this.busy) return;
    if (edit.revision !== this.options.context().revision || serializeContent(this.options.context().project) !== preview.base) {
      edit.status = 'stale'; this.clearPreview(); this.emit(); return;
    }
    // Mark the receipt first: the editor's scene commit saves both in the same project write.
    edit.status = 'applied'; this.clearPreview();
    if (!this.options.apply(preview.project, preview.base, preview.focus)) edit.status = 'stale';
    this.emit();
  }
  async refresh(id: string) {
    const index = this.active.messages.findIndex(m => m.id === id);
    const request = this.active.messages.slice(0, index).reverse().find(m => m.role === 'user');
    if (request?.role === 'user') {
      this.active.draft = request.text;
      if (request.context && this.options.focus && !this.options.focus(request.context)) { this.emit(); return; }
      await this.send();
    }
  }
  async send(retryId?: string) {
    if (this.busy) return;
    const thread = this.active;
    const latest = thread.messages.at(-1);
    let message: UserMessage;
    if (retryId) {
      if (latest?.id !== retryId || latest.role !== 'user' || !['failed', 'stopped'].includes(latest.status)) return;
      if (latest.context && this.options.focus && !this.options.focus(latest.context)) return;
      message = latest; message.status = 'pending'; delete message.detail;
    } else {
      const text = thread.draft.trim(); if (!text) return;
      message = { id: crypto.randomUUID(), role: 'user', text, status: 'pending' };
      if (!thread.messages.length) thread.title = text.replace(/\s+/g, ' ').slice(0, 80);
      for (const older of thread.messages) if (older.role === 'assistant' && older.edit?.status === 'pending') older.edit.status = 'discarded';
      thread.messages.push(message); thread.draft = '';
    }
    this.clearPreview(); this.options.prepare();
    const context = this.options.context(), project = structuredClone(context.project);
    message.context = { sceneId: context.sceneId, shotId: context.shotId, selectedId: context.selectedId, time: context.time };
    const run: Run = { id: crypto.randomUUID(), threadId: thread.id, message, controller: new AbortController(), base: serializeContent(project), revision: context.revision };
    this.run = run; this.evidence = []; this.evidenceMessageId = message.id; this.activity = 'Muse is thinking…'; this.emit();
    if (this.run !== run) return;
    const current = () => {
      if (this.run !== run || this.book.activeId !== run.threadId) return false;
      if (this.options.context().sceneId !== context.sceneId || this.options.context().shotId !== context.shotId) {
        this.cancel('The active scene or shot changed. Retry in the intended scene.'); return false;
      }
      if (this.options.context().revision !== run.revision || serializeContent(this.options.context().project) !== run.base) {
        this.sceneChanged(); return false;
      }
      return true;
    };
    try {
      const input: SceneEditInput = { project, sceneId: context.sceneId, shotId: context.shotId, time: context.time, selectedId: context.selectedId, prompt: message.text,
        history: conversationHistory(thread.messages.slice(0, -1)), snapshots: [] };
      const request = this.options.request ?? ((input: SceneEditInput, signal: AbortSignal) => requestSceneEdit(input, signal,
        { turnId: run.id, conversationId: thread.id, messageId: message.id }));
      let response = await request(input, run.controller.signal);
      if (!current()) return;
      if (response.status === 'needs_views') {
        this.activity = `Checking ${response.requestedViews.map(view => view === 'top_down' ? 'the top view' : 'the shot view').join(' and ')}…`;
        input.snapshots = response.requestedViews.map(view => this.options.capture(project, context.sceneId, context.shotId, context.time, view));
        this.evidence = input.snapshots; this.emit();
        response = await request(input, run.controller.signal);
        if (!current()) return;
      }
      if (response.status !== 'ready' || response.plan.requestedViews.length)
        throw new Error('Muse requested more views than this turn supports. Try a more specific message.');
      const reply: AssistantMessage = { id: crypto.randomUUID(), role: 'assistant', text: response.plan.summary, model: response.model };
      if (response.plan.operations.length) {
        applyProjectOperations(project, response.plan.operations, context.time);
        reply.edit = { operations: response.plan.operations, time: context.time, revision: context.revision, sceneId: context.sceneId, shotId: context.shotId, status: 'pending' };
      }
      message.status = 'answered'; thread.messages.push(reply); this.evidenceMessageId = reply.id;
      this.run = null; this.activity = '';
      if (reply.edit) this.review(reply.id); else this.emit();
    } catch (error) {
      if (!current()) return;
      message.status = 'failed'; message.detail = error instanceof Error ? error.message.slice(0, 500) : 'Muse could not respond. Try again.';
      this.run = null; this.activity = ''; this.emit();
    }
  }
}
