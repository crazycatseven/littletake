import { z } from 'zod';
import { PNG } from 'pngjs';
import { Resvg } from '@resvg/resvg-js';
import type { AIContent, ToolDefinition } from '../../ai/provider.ts';
import { AIError } from '../../ai/provider.ts';
import type { AIEnvironment } from '../../ai/index.ts';
import { MAX_SAM_CALLS, observationKey, referenceContextSchema, type ReferenceContext, type ReferenceObservation, type ReferenceProgress } from '../../../src/reference/observations.ts';
import { segmentImage, SAM_MODEL, type SamInput, type SamReceipt, type SamResult } from './service.ts';

const frameId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const readSchema = z.strictObject({ frameId });
const segmentSchema = z.strictObject({ frameId, concept: z.string().trim().min(1).max(100), threshold: z.number().min(0).max(1).optional().default(.5) });
const requestSchema = z.strictObject({ time: z.number().min(0).max(60), reason: z.string().trim().min(5).max(300) });
const schemas = { read_reference_frame: readSchema, request_reference_frame: requestSchema, segment_reference: segmentSchema };
const descriptions = {
  read_reference_frame: 'Inspect one ORIGINAL reference frame at its saved resolution before deciding what to segment. Use only an exact frameId from referenceFrames. Free of SAM inference; returns pixels and source timestamp, shot and quality metadata. This is not a rendered scene view.',
  request_reference_frame: 'Ask the browser for an additional timestamp from the original reference VIDEO when saved candidates miss an action, object or unobscured view. Give a concrete visual reason. Up to two timestamps in one batch per user turn. Planning resumes with the same project and cached observations after local extraction. Request missing frames before generating assets or planning edits. Does not run SAM.',
  segment_reference: 'Segment ONE short noun concept in an ORIGINAL reference frame. Choose the frame by visibility and task; prefer the unobscured complete object for layout, and separated moments for action. Returns measured 2D boxes, mask areas, model scores and a false-color mask overlay. Cached identical requests are reused; at most four new SAM calls per user turn, including failed attempts. Never retry an error automatically. IDs are image-local, not identities across frames; no 3D depth or metres are inferred.',
};
export const referenceToolDefinitions: ToolDefinition[] = Object.entries(schemas).map(([name, schema]) => ({ name, description: descriptions[name as keyof typeof schemas], parameters: z.toJSONSchema(schema, { target: 'draft-7' }) }));
export const REFERENCE_TOOL_INSTRUCTIONS = `Original reference pixels are provided separately from rendered scene snapshots. referenceFrames lists exact frame IDs, actual decoded timestamps, original/resized dimensions, shot indices and candidate roles. A contact sheet is a selection aid. Sharpness is a heuristic, not a judgment that this frame contains the whole set. Select frames deliberately: an unobscured wide view for layout, early/late views of the SAME source shot for motion, and another visible view for an occluded object. Read a selected original frame when the contact sheet is insufficient. If important evidence is missing, request_reference_frame with a timestamp and visual reason BEFORE asset generation; request two moments together for motion. The browser resumes planning once with those exact decoded frames. Do not segment every frame or every object by default. Use one short noun per segment_reference call. Reuse cached observations. Keep source-shot projections separate; cuts do not establish a new physical location and image-local IDs do not establish object identity. Boxes and mask fractions constrain image composition, not absolute depth, metric size or hidden geometry. Use existing spatial tools for 3D scene edits and rendered views for visual checks. Be explicit when an object was not found or SAM failed. Do not claim to have segmented or measured anything without a successful tool result.`;
const colors = ['#23b4ef', '#ffab37', '#df5ca9', '#43cc81', '#a580f5', '#f26952'];
export type SamInference = (input: SamInput, options: { signal?: AbortSignal; onReceipt?(receipt: SamReceipt): void }) => Promise<SamResult>;
export interface ReferenceCallEvidence { frameId: string; concept: string; threshold: number; startedAt: string; finishedAt?: string; status: string; receipt?: SamReceipt; result?: SamResult; error?: string }

/** Original-frame tools, request budget and replay cache. No scene mutation. */
export class ReferenceTools {
  readonly context: ReferenceContext | undefined;
  readonly evidence: ReferenceCallEvidence[] = [];
  readonly requestedFrames: { time: number; reason: string }[] = [];
  private observations = new Map<string, ReferenceObservation>();
  private pending = new Map<string, Promise<ReferenceObservation>>();
  private callsUsed: number;
  constructor(raw?: ReferenceContext, private env: AIEnvironment = process.env, private inference: SamInference = (input, options) => segmentImage(input, env, options)) {
    this.context = raw ? referenceContextSchema.parse(raw) : undefined;
    this.callsUsed = this.context?.callsUsed ?? 0;
    if (!this.context) return;
    for (const frame of this.context.source.frames) {
      const bytes = Buffer.from(frame.dataUrl.slice(22), 'base64');
      if (bytes.length < 24 || bytes.readUInt32BE(16) !== frame.width || bytes.readUInt32BE(20) !== frame.height) throw new AIError('invalid_reference', 'Reference PNG dimensions differ from the saved source frame.', 400);
      try { PNG.sync.read(bytes, { checkCRC: true }); } catch { throw new AIError('invalid_reference', 'A reference PNG could not be decoded.', 400); }
    }
    const provider = env.SAM_PROVIDER === 'local' ? 'local' : 'Meta Model API';
    for (const observation of this.context.observations) if (observation.provider === provider && observation.model === SAM_MODEL) this.observations.set(observationKey(observation.frameId, observation.concept, observation.threshold), observation);
  }
  get available() { return Boolean(this.context); }
  handles(name: string) { return Object.hasOwn(schemas, name); }
  private frame(id: string) {
    const frame = this.context?.source.frames.find(frame => frame.id === id);
    if (!frame) throw new Error('Unknown reference frame. Use an exact frameId from the current referenceFrames catalog.');
    return frame;
  }
  content(): AIContent[] {
    if (!this.context) return [];
    const source = this.context.source;
    const catalog = source.frames.map(({ dataUrl: _, ...frame }) => ({ ...frame, sourceShotNumber: frame.shot + 1 }));
    const width = 900, tileWidth = 300, imageHeight = 170, tileHeight = 207;
    const tiles = source.frames.map((frame, index) => {
      const x = index % 3 * tileWidth, y = Math.floor(index / 3) * tileHeight;
      return `<image x="${x}" y="${y}" width="${tileWidth}" height="${imageHeight}" preserveAspectRatio="xMidYMid meet" href="${frame.dataUrl}"/><text x="${x + 8}" y="${y + 188}" fill="#e6edf6" font-size="13">${index + 1} · shot ${frame.shot + 1} · ${frame.time.toFixed(3)}s · ${frame.role}</text>`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.ceil(source.frames.length / 3) * tileHeight}"><rect width="100%" height="100%" fill="#171c25"/>${tiles}</svg>`;
    const png = new Resvg(svg).render().asPng();
    return [{ type: 'text', text: JSON.stringify({ originalReference: { id: source.id, name: source.name, kind: source.kind, duration: source.duration, originalWidth: source.originalWidth, originalHeight: source.originalHeight, cuts: source.cuts, omittedShots: source.omittedShots }, referenceFrames: catalog, shotConvention: 'shot is a zero-based index. Report the one-based sourceShotNumber to users, matching the contact sheet.', contactSheetOrder: source.frames.map(frame => frame.id), cachedSegmentations: [...this.observations.values()].map(item => ({ frameId: item.frameId, concept: item.concept, threshold: item.threshold, count: item.instances.length })), remainingSamCalls: MAX_SAM_CALLS - this.callsUsed }) },
      { type: 'image', dataUrl: 'data:image/png;base64,' + png.toString('base64') }];
  }
  progress(): ReferenceProgress | undefined {
    return this.context ? { sourceId: this.context.source.id, observations: [...this.observations.values()].slice(-8), callsUsed: this.callsUsed, framesRequested: Boolean(this.context.framesRequested || this.requestedFrames.length) } : undefined;
  }
  async execute(name: string, value: unknown, signal?: AbortSignal): Promise<{ result: unknown; image?: string }> {
    if (name === 'request_reference_frame') {
      const args = requestSchema.parse(value), source = this.context?.source;
      if (!source || source.kind !== 'video' || args.time >= source.duration) throw new Error('Request a timestamp inside the current reference video.');
      const existing = source.frames.find(frame => Math.abs(frame.time - args.time) < .00001 || Math.abs(frame.requestedTime - args.time) < .00001);
      if (existing) return this.execute('read_reference_frame', { frameId: existing.id }, signal);
      if (this.context!.framesRequested) throw new Error('This turn already requested extra reference frames. Use the available catalog or continue in another user turn.');
      if (!this.requestedFrames.some(frame => frame.time === args.time)) {
        if (this.requestedFrames.length >= 2) throw new Error('Request at most two extra reference timestamps per turn.');
        this.requestedFrames.push(args);
      }
      return { result: { ok: true, status: 'frame_required', time: args.time, reason: args.reason, instruction: 'Planning will resume with the decoded frame. No edits have been applied.' } };
    }
    if (name === 'read_reference_frame') {
      const frame = this.frame(readSchema.parse(value).frameId), { dataUrl, ...metadata } = frame;
      return { result: { ok: true, originalReference: true, sourceId: this.context!.source.id, ...metadata, sourceShotNumber: frame.shot + 1 }, image: dataUrl };
    }
    if (name !== 'segment_reference') throw new Error('Unknown reference tool.');
    const args = segmentSchema.parse(value), frame = this.frame(args.frameId), key = observationKey(frame.id, args.concept, args.threshold);
    const cached = this.observations.get(key), reused = Boolean(cached || this.pending.has(key));
    if (!cached && !this.pending.has(key)) {
      if (this.callsUsed >= MAX_SAM_CALLS) throw new Error('This turn reached its four-call SAM limit. Use existing observations or ask the user to continue in another turn.');
      signal?.throwIfAborted(); this.callsUsed++;
      const evidence: ReferenceCallEvidence = { frameId: frame.id, concept: args.concept, threshold: args.threshold, startedAt: new Date().toISOString(), status: 'requesting' };
      this.evidence.push(evidence);
      const promise = (async () => {
        try {
          const result = await this.inference({ imageDataUrl: frame.dataUrl, prompt: args.concept, threshold: args.threshold }, { signal, onReceipt: receipt => { evidence.receipt = receipt; } });
          evidence.result = result; evidence.receipt = result.receipt;
          if (result.width !== frame.width || result.height !== frame.height) throw new Error('SAM returned coordinates from another reference frame.');
          const overlay = PNG.sync.read(Buffer.from(frame.dataUrl.slice(22), 'base64'));
          const instances = result.instances.map((item, index) => {
            const color = colors[index % colors.length], rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
            const [left, top, right, bottom] = item.box, mask = PNG.sync.read(Buffer.from(item.mask.pngBase64, 'base64'));
            if (left < 0 || top < 0 || right > frame.width || bottom > frame.height || right - left !== mask.width || bottom - top !== mask.height) throw new Error('SAM mask coordinates differ from this reference frame.');
            for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) if (mask.data[(y * mask.width + x) * 4]) {
              const at = ((top + y) * overlay.width + left + x) * 4;
              for (let channel = 0; channel < 3; channel++) overlay.data[at + channel] = Math.round(overlay.data[at + channel] * .55 + rgb[channel] * .45);
            }
            return { id: String(item.objectId), box: item.box as [number, number, number, number], normalizedBox: [left / frame.width, top / frame.height, right / frame.width, bottom / frame.height] as [number, number, number, number], pixels: item.pixels, areaFraction: item.pixels / (frame.width * frame.height), score: item.score, overlayColor: color };
          });
          const observation: ReferenceObservation = { id: crypto.randomUUID(), sourceId: this.context!.source.id, frameId: frame.id, concept: args.concept, threshold: args.threshold,
            createdAt: new Date().toISOString(), provider: result.source.provider, model: result.source.model, width: frame.width, height: frame.height,
            instances, overlayDataUrl: 'data:image/png;base64,' + PNG.sync.write(overlay).toString('base64') };
          this.observations.set(key, observation); evidence.status = 'complete'; return observation;
        } catch (error) { evidence.status = 'failed'; evidence.error = error instanceof Error ? error.message : 'SAM failed.'; throw error; }
        finally { evidence.finishedAt = new Date().toISOString(); }
      })();
      this.pending.set(key, promise); // Repeated errors reuse the rejected promise; no automatic repayment.
    }
    const observation = cached ?? await this.pending.get(key)!;
    return { result: { ok: true, applied: false, cached: reused, sourceId: observation.sourceId, frameId: frame.id, time: frame.time, shot: frame.shot, sourceShotNumber: frame.shot + 1,
      concept: observation.concept, threshold: observation.threshold, provider: observation.provider, model: observation.model,
      width: frame.width, height: frame.height, originalWidth: this.context!.source.originalWidth, originalHeight: this.context!.source.originalHeight,
      pixelConvention: 'resized full reference frame, half-open boxes; normalized boxes also map to the original image',
      overlayConvention: 'False colors identify masks only. Read original pixels to judge material color.',
      instances: observation.instances, limitations: ['2D observations only; no depth, metric dimensions or hidden volume.', 'Instance IDs apply only to this frame and concept.'] }, image: observation.overlayDataUrl };
  }
}
