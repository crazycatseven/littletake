import { z } from 'zod';
import { newId } from '../id';
import { projectFetch } from '../project/client';
import type { Workspace } from '../project/workspace';
import type { Shot } from '../types';
import type { AppearanceImage } from '../appearance/model';
import type { LookSubject, StoryboardInput } from '../../server/look/generate';
import type { StoryboardStyle } from './styles';
import { matchingLegacyStoryboardSource, splitStoryboardImage, type StoryboardFrame, type StoryboardPage } from './storyboard';

const shotSchema = z.object({ name: z.string(), start: z.number(), duration: z.number() });
const panelSchema = z.strictObject({ id: z.string(), at: z.number().min(0).max(60), note: z.string().max(600) });
const imageSchema = z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);
const resultSchema = z.strictObject({
  image: imageSchema, model: z.string(), prompt: z.string(), context: z.string(), shot: shotSchema, source: z.string().optional(),
  panels: z.array(z.strictObject({ at: z.number(), note: z.string(), previs: imageSchema })).length(4),
});
export const storyboardDraftSchema = z.strictObject({
  format: z.literal('LittleTake.storyboard'), version: z.literal(2), shot: shotSchema,
  panels: z.array(panelSchema).length(4), result: resultSchema.nullable(),
});
/** Existing per-panel outputs stay readable in Renders; new generations use a single sheet. */
export const legacyStoryboardDraftSchema = z.strictObject({
  format: z.literal('LittleTake.storyboard'), version: z.literal(1), shot: shotSchema,
  approvedFrameId: z.string().nullable(),
  panels: z.array(panelSchema.extend({ frameId: z.string().nullable() })).min(1).max(8),
});
export type StoryboardDraft = z.infer<typeof storyboardDraftSchema>;
export interface CapturedPanel { previs: string; input: string; subjects: LookSubject[]; visible: Set<string>; camera?: StoryboardInput['panels'][number]['camera'] }
export interface StoryboardPanel { data: StoryboardDraft['panels'][number]; source: CapturedPanel }
interface BoardReferences { direction: string; style?: string; stylePreset?: StoryboardStyle; appearance: AppearanceImage[] }

/** Four moments spanning the shot. Very short shots repeat frames rather than sampling outside it. */
export function keyPanelTimes(shot: Pick<Shot, 'duration'>, fps: number): number[] {
  const last = Math.max(0, Math.ceil(shot.duration * fps - 1e-7) - 1);
  return Array.from({ length: 4 }, (_, i) => Math.round(last * i / 3) / fps);
}

/** One explicit generation action creates one sheet and saves its original source/timing snapshot. */
export class AIStoryboard {
  readonly room;
  id = newId();
  draft: StoryboardDraft;
  panels: StoryboardPanel[] = [];
  busy = false;
  saveError = '';
  private saves: Promise<unknown> = Promise.resolve();
  private crops?: { image: string; frames: string[] };
  private legacySources = new Map<number, string>();

  constructor(readonly shot: Shot, readonly fps: number, private sceneId: string, private workspace: Workspace,
    private capture: (at: number) => CapturedPanel, private references: () => BoardReferences,
    private changed: () => void, private message: (value: string) => void, private source?: string,
    private preparePerformance?: (signal: AbortSignal) => Promise<NonNullable<StoryboardInput['performance']>>) {
    this.room = workspace.room;
    this.draft = { format: 'LittleTake.storyboard', version: 2, shot: this.shotSnapshot(), panels: [], result: null };
  }

  private shotSnapshot() { return { name: this.shot.name, start: this.shot.start, duration: this.shot.duration }; }

  async load() {
    const saved = this.room?.outputs.filter(item => item.kind === 'storyboard' && item.sceneId === this.sceneId && item.shotId === this.shot.id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (saved) {
      const value = JSON.parse(await (await this.workspace.output(saved.id, this.room)).text());
      if (value.version === 2) { this.draft = storyboardDraftSchema.parse(value); this.id = saved.id; }
      else legacyStoryboardDraftSchema.parse(value);
    }
    const last = keyPanelTimes(this.shot, this.fps)[3];
    if (!this.draft.panels.length) this.draft.panels = keyPanelTimes(this.shot, this.fps).map(at => ({ id: newId(), at, note: '' }));
    // An edited shot can shorten the range. Keep the older generated snapshot with its original times.
    this.panels = this.draft.panels.map(data => {
      const at = Math.min(last, Math.round(data.at * this.fps) / this.fps);
      return { data: { ...data, at }, source: this.capture(at) };
    }).sort((a, b) => a.data.at - b.data.at);
    if (this.result && this.result.source === undefined) {
      for (const [i, panel] of this.panels.entries()) if (await matchingLegacyStoryboardSource(this.result.panels[i].previs, panel.source.previs)) this.legacySources.set(i, panel.source.previs);
    }
    this.changed();
  }

  private context() {
    const { direction, appearance, stylePreset } = this.references(), visible = new Set(this.panels.flatMap(panel => [...panel.source.visible]));
    return JSON.stringify({ direction: direction.trim(), styleId: this.workspace.lookSettings(this.sceneId).styleId,
      ...(stylePreset && stylePreset !== 'scene' ? { stylePreset } : {}),
      appearance: appearance.filter(image => image.bindings.some(binding => visible.has(binding.objectId))).map(image => ({ id: image.id, updatedAt: this.room?.outputs.find(output => output.id === image.id)?.updatedAt ?? 0, bindings: image.bindings.filter(binding => visible.has(binding.objectId)) })) });
  }

  get result() { return this.draft.result; }
  get current() {
    const result = this.result;
    return !!result && result.shot.start === this.shot.start && result.shot.duration === this.shot.duration && result.context === this.context()
      && (result.source === undefined || result.source === this.source)
      && this.panels.every((panel, i) => result.panels[i].at === panel.data.at && result.panels[i].note === panel.data.note.trim()
        && (result.source !== undefined || result.panels[i].previs === panel.source.previs || this.legacySources.get(i) === panel.source.previs));
  }
  get complete() { return this.current && !this.saveError; }

  pages(): StoryboardPage[] {
    if (!this.complete) throw new Error('Generate and save the storyboard for these settings before exporting.');
    return [{ image: this.result!.image, frames: this.result!.panels.map((panel, i) => ({ index: i + 1, at: panel.at })) }];
  }

  async frames(signal: AbortSignal): Promise<StoryboardFrame[]> {
    this.pages();
    const result = this.result!;
    if (this.crops?.image !== result.image) this.crops = { image: result.image, frames: await splitStoryboardImage(result.image, signal) };
    signal.throwIfAborted();
    return result.panels.map((panel, i) => ({ ...panel, look: this.crops!.frames[i] }));
  }

  async setTime(panel: StoryboardPanel, at: number) {
    if (this.busy || panel === this.panels[0]) return;
    at = Math.round(at * this.fps) / this.fps;
    if (!Number.isFinite(at) || at < 0 || at > keyPanelTimes(this.shot, this.fps)[3]) throw new Error('Choose a frame inside this shot. The opening panel stays at 0 seconds.');
    panel.data.at = at; panel.source = this.capture(at);
    this.panels.sort((a, b) => a.data.at - b.data.at); await this.persist(); this.changed();
  }

  async setNote(panel: StoryboardPanel, note: string) {
    if (this.busy) return;
    panel.data.note = note.slice(0, 600); await this.persist(); this.changed();
  }

  async persist() {
    this.draft.panels = this.panels.map(panel => panel.data); this.draft.shot = this.shotSnapshot();
    const blob = new Blob([JSON.stringify(this.draft)], { type: 'application/json' });
    const operation = this.saves.catch(() => {}).then(() => this.workspace.putOutput({ id: this.id, kind: 'storyboard', sceneId: this.sceneId, shotId: this.shot.id, name: this.shot.name + ' · AI storyboard', mime: 'application/json' }, blob, this.room));
    this.saves = operation;
    try { await operation; this.saveError = ''; }
    catch (error) { this.saveError = (error as Error).message; this.changed(); throw error; }
  }

  async retrySave() {
    if (this.busy) return;
    this.busy = true; this.changed();
    try { await this.persist(); this.message('Storyboard saved.'); }
    finally { this.busy = false; this.changed(); }
  }

  /** Exactly one paid image request, no per-panel enhancement or automatic retry. */
  async generate(signal: AbortSignal) {
    if (this.busy) return;
    signal.throwIfAborted();
    const { direction, style, stylePreset, appearance } = this.references();
    this.busy = true; this.changed();
    try {
      // Capture the submitted settings before yielding; persistence failure never starts a paid call.
      const visible = new Set(this.panels.flatMap(panel => [...panel.source.visible])), context = this.context();
      const panels = this.panels.map(panel => ({ at: panel.data.at, note: panel.data.note.trim(), previs: panel.source.previs }));
      const input: StoryboardInput = { layout: '2x2', direction: direction.trim(), stylePreset,
        panels: this.panels.map(panel => ({ at: panel.data.at, note: panel.data.note.trim(), frame: panel.source.input, subjects: panel.source.subjects, camera: panel.source.camera })),
        ...(style ? { style } : {}), appearance: appearance.map(image => ({ ...image, bindings: image.bindings.filter(binding => visible.has(binding.objectId)) })).filter(image => image.bindings.length) };
      await this.persist(); signal.throwIfAborted();
      if (this.preparePerformance) input.performance = await this.preparePerformance(signal);
      signal.throwIfAborted();
      this.message('Generating all four panels together…');
      const response = await projectFetch('/api/look', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify(input) });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error?.message ?? 'Muse could not generate the storyboard.');
      signal.throwIfAborted();
      const result = resultSchema.safeParse({ ...value, context, panels, shot: this.shotSnapshot(), source: this.source });
      if (!result.success) throw new Error('Muse returned no readable storyboard. Your previous image is kept.');
      this.draft.result = result.data;
      await this.persist();
      this.message('Storyboard ready.');
    } finally { this.busy = false; this.changed(); }
  }
}
