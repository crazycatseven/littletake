import { newId } from "../id.ts";
import { serializeContent } from '../project/model.ts';
import type { ProjectContent } from '../types.ts';
import { requestSceneEdit } from './client.ts';
import { applyProjectOperations, type SceneSnapshot, type SceneView } from './operations.ts';
import { conversationHistory, newConversation, type AssistantMessage, type ConversationBook, type UserMessage } from './conversations.ts';
import type { SceneEditInput, SceneEditResponse } from './types.ts';
import type { ReferenceContext, ReferenceProgress } from '../reference/observations.ts';
import { performanceSelection, performanceFrames, performanceOperations, type PerformanceTarget } from '../performance/refinement.ts';
import type { AppearanceImage } from '../appearance/model.ts';
import type { AgentProgress, ProgressListener } from './progress.ts';

export interface EditorContext { project: ProjectContent; sceneId: string | null; shotId: string | null; revision: number; time: number; selectedId: string | null; selectedIds?: string[] }
export interface SessionOptions {
  context(): EditorContext;
  prepare(): void;
  play?(): void;
  focus?(context: NonNullable<UserMessage['context']>): boolean;
  capture(project: ProjectContent, sceneId: string | null, shotId: string | null, time: number, view: SceneView, compact?: boolean): SceneSnapshot;
  preview(project: ProjectContent | null, focus?: { sceneId: string | null; shotId: string | null }): void;
  apply(project: ProjectContent, base: string, focus: { sceneId: string | null; shotId: string | null }): boolean;
  changed(): void;
  reference?(threadId: string): Promise<ReferenceContext | undefined>;
  appearance?(context: EditorContext): Promise<AppearanceImage[]>;
  saveReferenceObservations?(progress: ReferenceProgress): Promise<void>;
  requestReferenceFrames?(threadId: string, sourceId: string, times: number[], signal: AbortSignal): Promise<ReferenceContext>;
  request?(input: SceneEditInput, signal: AbortSignal, onProgress?: ProgressListener): Promise<SceneEditResponse>;
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
  get previewRange() {
    const operations = this.preview && this.assistant(this.preview.messageId)?.edit?.operations.filter(operation => operation.type === 'refine_take');
    const takes = operations?.flatMap(operation => {
      const scene = this.preview!.project.scenes.find(scene => scene.id === operation.sceneId);
      const take = scene && [...scene.objects, ...scene.cameras].find(item => item.id === operation.id)?.animation?.takes.find(take => take.id === operation.takeId);
      return take ? [take] : [];
    });
    return takes?.length ? { start: Math.min(...takes.map(take => take.start)), end: Math.max(...takes.map(take => take.end)) } : null;
  }
  playReview(id: string) { this.review(id, this.after); if (this.preview?.messageId === id) this.options.play?.(); }
  private emit() { this.options.changed(); }
  attachPerformance(targets: PerformanceTarget[]) {
    const context = this.options.context(), selected = performanceSelection(context.project, targets), selectedIds = [...new Set(selected.map(entry => entry.item.id))];
    this.cancel(); this.clearPreview();
    if (this.options.focus && !this.options.focus({ sceneId: targets[0].sceneId, shotId: targets[0].shotId, selectedId: selectedIds.at(-1)!, selectedIds, time: Math.min(...selected.map(entry => entry.take.start)) })) return;
    this.active.performance = structuredClone(targets);
    if (!this.active.draft.trim()) this.active.draft = 'Refine these recordings while preserving their intent, timing and route.';
    this.emit();
  }
  detachPerformance(index?: number) {
    this.cancel();
    if (index !== undefined) this.active.performance?.splice(index, 1); else delete this.active.performance;
    if (!this.active.performance?.length) delete this.active.performance;
    this.emit();
  }
  replaceBook(book: ConversationBook) {
    this.cancel(); this.clearPreview(); this.evidence = []; this.evidenceMessageId = null;
    this.book.activeId = book.activeId; this.book.threads = book.threads; this.emit();
  }
  receiveBook(book: ConversationBook) {
    // Preserve references held by this page's in-flight Muse request.
    this.book.threads = book.threads.map(incoming => {
      const thread = this.book.threads.find(item => item.id === incoming.id);
      if (!thread) return structuredClone(incoming);
      if (!incoming.performance) delete thread.performance;
      const messages = incoming.messages.map(message => {
        const existing = thread.messages.find(item => item.id === message.id);
        if(existing)for(const key of Object.keys(existing))if(!Object.hasOwn(message,key))delete (existing as unknown as Record<string,unknown>)[key];
        return existing ? Object.assign(existing, message) : structuredClone(message);
      });
      Object.assign(thread, incoming, { messages }); return thread;
    });
    this.book.activeId = book.activeId;
  }
  receiveRevision(before: number, after: number) {
    if (this.run?.revision === before) this.run.revision = after;
    for (const thread of this.book.threads) for (const message of thread.messages)
      if (message.role === 'assistant' && message.edit?.status === 'pending' && message.edit.revision === before) message.edit.revision = after;
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
    (run.message.progress ??= []).push(this.progressEvent('error', 'Stopped. No changes applied.'));
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
      const project = applyProjectOperations(context.project, edit.operations, edit.time), sceneId = edit.operations.find(op => op.type === 'add_scene')?.sceneId ?? edit.sceneId;
      // A request sent before any shot existed (e.g. "build a scene") opens on the first shot it created, not on a bare camera preview.
      const shotId = edit.shotId ?? project.scenes.find(scene => scene.id === sceneId)?.shots[0]?.id ?? null;
      this.preview = { messageId: id, base: serializeContent(context.project), project, focus: { sceneId, shotId } };
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
      if (request.context?.performance) this.active.performance = structuredClone(request.context.performance); else delete this.active.performance;
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
      message = { id: newId(), role: 'user', text, status: 'pending' };
      if (!thread.messages.length) thread.title = text.replace(/\s+/g, ' ').slice(0, 80);
      for (const older of thread.messages) if (older.role === 'assistant' && older.edit?.status === 'pending') older.edit.status = 'discarded';
      thread.messages.push(message); thread.draft = '';
    }
    this.clearPreview(); this.options.prepare();
    const context = this.options.context(), project = structuredClone(context.project);
    const selectedIds = [...(context.selectedIds ?? (context.selectedId ? [context.selectedId] : []))];
    const performance = retryId ? message.context?.performance : thread.performance;
    message.context = { sceneId: context.sceneId, shotId: context.shotId, selectedId: context.selectedId, selectedIds, time: context.time, ...(performance ? { performance: structuredClone(performance) } : {}) };
    const run: Run = { id: newId(), threadId: thread.id, message, controller: new AbortController(), base: serializeContent(project), revision: context.revision };
    this.run = run; this.evidence = []; this.evidenceMessageId = message.id; this.activity = 'Reading your scene request…';
    (message.progress ??= []).push(this.progressEvent('running', this.activity)); this.emit();
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
      const input: SceneEditInput = { project, sceneId: context.sceneId, shotId: context.shotId, time: context.time, selectedId: context.selectedId, selectedIds, prompt: message.text,
        history: conversationHistory(thread.messages.slice(0, -1)), snapshots: [] };
      if (this.options.appearance) input.appearance = await this.options.appearance({ ...context, project });
      if (!current()) return;
      const reference = !performance && this.options.reference ? await this.options.reference(thread.id) : undefined;
      if (!current()) return;
      if (reference) input.reference = reference;
      const progress: ProgressListener = event => {
        if (!current()) return;
        const last = message.progress?.at(-1); if (last?.message === event.message && last.status === event.status) return;
        (message.progress ??= []).push(event); this.activity = event.message; this.emit();
      };
      const request = this.options.request ?? ((input: SceneEditInput, signal: AbortSignal, onProgress?: ProgressListener) => requestSceneEdit(input, signal,
        { turnId: run.id, conversationId: thread.id, messageId: message.id }, onProgress));
      let response: SceneEditResponse;
      if (performance) {
        performanceSelection(project, performance);
        if (context.sceneId !== performance[0].sceneId) throw new Error('Return to the recordings\' scene, or detach the animations.');
        input.performance = { targets: performance }; input.selectedIds = [...new Set(performance.map(target => target.entityId))]; input.selectedId = input.selectedIds.at(-1)!;
        const capture = async (content: ProjectContent, variant: 'before' | 'after') => {
          const frames = performanceFrames(project, performance);
          const snapshots: SceneSnapshot[] = [];
          for (const [index, frame] of frames.entries()) {
            if (!current()) throw new Error('Recording review stopped.');
            progress(this.progressEvent('running', `Rendering ${variant === 'before' ? 'recorded' : 'refined'} performance · ${index + 1}/${frames.length}…`));
            // Yield between small offscreen renders so Stop and the rest of the editor stay responsive.
            await new Promise(resolve => setTimeout(resolve, 0));
            if (!current()) throw new Error('Recording review stopped.');
            snapshots.push({ ...this.options.capture(content, performance[0].sceneId, frame.shotId, frame.time, frame.view, true), shotId: frame.shotId, variant });
          }
          return snapshots;
        };
        input.snapshots = await capture(project, 'before'); this.evidence = input.snapshots;
        progress(this.progressEvent('running', 'Muse is reading the performance and its images…'));
        response = await request(input, run.controller.signal, progress);
        if (!current()) return;
        let reviewedOperations: unknown;
        if (response.status === 'needs_motion_review') {
          const candidate = response.candidate;
          const operations = performanceOperations(performance, candidate);
          const proposed = applyProjectOperations(project, operations, context.time);
          reviewedOperations = operations;
          const after = await capture(proposed, 'after');
          input.performance = { targets: performance, candidate }; input.snapshots = [...input.snapshots, ...after]; this.evidence = input.snapshots;
          progress(this.progressEvent('running', 'Muse is comparing the original and refined images…'));
          response = await request(input, run.controller.signal, progress);
          if (!current()) return;
        }
        if (response.status !== 'ready') throw new Error('The recording review did not finish. The original recording is unchanged.');
        if (response.plan.operations.length && JSON.stringify(response.plan.operations) !== JSON.stringify(reviewedOperations))
          throw new Error('The final proposal differs from the rendered candidate. No changes were applied.');
      } else response = await request(input, run.controller.signal, progress);
      let frameFollowup = false, viewFollowup = false;
      for (let step = 0; step < 3; step++) {
        if (!current()) return;
        if (response.reference) await this.options.saveReferenceObservations?.(response.reference);
        if (!current()) return;
        if (input.reference && response.reference) input.reference = { source: input.reference.source, observations: response.reference.observations, callsUsed: response.reference.callsUsed, framesRequested: response.reference.framesRequested };
        if (response.status === 'ready') break;
        if (response.status === 'needs_motion_review') throw new Error('Choose a recording before asking for a performance review.');
        if (response.status === 'needs_reference_frames') {
          if (frameFollowup || !input.reference || !this.options.requestReferenceFrames) throw new Error('Additional reference frames are unavailable for this turn. Use the current candidates or attach the reference again.');
          frameFollowup = true; progress(this.progressEvent('running', `Reading original reference frames at ${response.requestedTimes.map(time => time.toFixed(2) + 's').join(', ')}…`));
          const previous = input.reference;
          const updated = await this.options.requestReferenceFrames(thread.id, previous.source.id, response.requestedTimes, run.controller.signal);
          if (!current()) return;
          if (updated.source.id !== previous.source.id) throw new Error('Reference changed while extracting the requested frame.');
          input.reference = { ...updated, callsUsed: previous.callsUsed, framesRequested: true };
        } else if (response.status === 'needs_views') {
          if (viewFollowup) throw new Error('Muse requested more rendered views than this turn supports.');
          viewFollowup = true; progress(this.progressEvent('running', `Capturing ${response.requestedViews.map(view => view === 'top_down' ? 'top view' : 'shot view').join(' and ')}…`));
          input.snapshots = response.requestedViews.map(view => this.options.capture(project, context.sceneId, context.shotId, context.time, view));
          this.evidence = input.snapshots; this.emit();
        }
        response = await request(input, run.controller.signal, progress);
      }
      if (response.status !== 'ready' || response.plan.requestedViews.length)
        throw new Error('Muse requested more views than this turn supports. Try a more specific message.');
      const reply: AssistantMessage = { id: newId(), role: 'assistant', text: response.plan.summary, model: response.model };
      if (response.plan.operations.length) {
        applyProjectOperations(project, response.plan.operations, context.time);
        reply.edit = { operations: response.plan.operations, time: context.time, revision: run.revision, sceneId: context.sceneId, shotId: context.shotId, status: 'pending' };
      }
      message.status = 'answered'; thread.messages.push(reply); this.evidenceMessageId = reply.id;
      progress(this.progressEvent('done', reply.edit ? 'Proposal ready for review.' : 'Completed.'));
      this.run = null; this.activity = '';
      if (reply.edit) this.review(reply.id); else this.emit();
    } catch (error) {
      if (!current()) return;
      const progress = error instanceof Error && error.cause && typeof error.cause === 'object' && 'referenceProgress' in error.cause ? error.cause.referenceProgress as ReferenceProgress : undefined;
      if (progress) {
        try { await this.options.saveReferenceObservations?.(progress); }
        catch { /* The original request diagnostic still retains the partial observations. */ }
        if (!current()) return;
      }
      message.status = 'failed'; message.detail = error instanceof Error ? error.message.slice(0, 500) : 'Muse could not respond. Try again.';
      (message.progress ??= []).push(this.progressEvent('error', 'This request did not finish. Expand the work history for details. No changes applied.'));
      this.run = null; this.activity = ''; this.emit();
    }
  }
  private progressEvent(status: AgentProgress['status'], message: string): AgentProgress {
    return { id: newId(), at: new Date().toISOString(), status, message };
  }
}
