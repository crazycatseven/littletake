import { z } from 'zod';

export const INITIAL_REFERENCE_FRAMES = 6;
export const MAX_REFERENCE_FRAMES = 8;
export const MAX_SAM_CALLS = 4;
export const MAX_REFERENCE_IMAGE_CHARACTERS = 2_400_000;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const box = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
export const referenceFrameSchema = z.strictObject({
  id, time: z.number().min(0).max(60), requestedTime: z.number().min(0).max(60), shot: z.number().int().min(0).max(120),
  role: z.enum(['anchor', 'early', 'late', 'coverage', 'image', 'requested']), quality: z.number().finite().min(0),
  width: z.number().int().min(1).max(1280), height: z.number().int().min(1).max(1280),
  dataUrl: z.string().startsWith('data:image/png;base64,').max(1_200_000),
});
export const referenceSourceSchema = z.strictObject({
  id, name: z.string().min(1).max(200), kind: z.enum(['video', 'image']),
  duration: z.number().min(0).max(60), originalWidth: z.number().int().min(1).max(8192), originalHeight: z.number().int().min(1).max(8192),
  cuts: z.array(z.number().min(0).max(60)).max(120), omittedShots: z.number().int().nonnegative(),
  frames: z.array(referenceFrameSchema).min(1).max(MAX_REFERENCE_FRAMES),
}).superRefine((source, ctx) => {
  if (new Set(source.frames.map(frame => frame.id)).size !== source.frames.length || source.frames.some(frame => frame.time > source.duration + .1 && source.kind === 'video')) ctx.addIssue({ code: 'custom', message: 'Reference frame identity or time is inconsistent.' });
  if (source.cuts.some((cut, index) => cut <= 0 || cut >= source.duration || (index > 0 && cut <= source.cuts[index - 1]))) ctx.addIssue({ code: 'custom', message: 'Reference cuts must be ordered inside the clip.' });
  if (source.frames.reduce((sum, frame) => sum + frame.dataUrl.length, 0) > MAX_REFERENCE_IMAGE_CHARACTERS) ctx.addIssue({ code: 'custom', message: 'Reference frame images exceed their request allowance.' });
});
export const referenceObservationSchema = z.strictObject({
  id, sourceId: id, frameId: id, concept: z.string().trim().min(1).max(100), threshold: z.number().min(0).max(1),
  createdAt: z.string(), provider: z.string().max(100), model: z.string().max(100),
  width: z.number().int().positive(), height: z.number().int().positive(),
  instances: z.array(z.strictObject({ id: z.string().max(100), box, normalizedBox: box, pixels: z.number().int().nonnegative(),
    areaFraction: z.number().min(0).max(1), score: z.number().min(0).max(1).nullable(), overlayColor: z.string().regex(/^#[0-9a-fA-F]{6}$/) })),
  overlayDataUrl: z.string().startsWith('data:image/png;base64,').max(1_600_000),
});
export const referenceContextSchema = z.strictObject({
  source: referenceSourceSchema, observations: z.array(referenceObservationSchema).max(8),
  callsUsed: z.number().int().min(0).max(MAX_SAM_CALLS).optional().default(0),
  framesRequested: z.boolean().optional().default(false),
}).superRefine((context, ctx) => {
  if (context.observations.some(observation => {
    const frame = context.source.frames.find(frame => frame.id === observation.frameId);
    return observation.sourceId !== context.source.id || !frame || frame.width !== observation.width || frame.height !== observation.height ||
      observation.instances.some(instance => instance.box[0] < 0 || instance.box[1] < 0 || instance.box[2] > frame.width || instance.box[3] > frame.height || instance.box[0] >= instance.box[2] || instance.box[1] >= instance.box[3] ||
        instance.pixels > frame.width * frame.height || Math.abs(instance.areaFraction - instance.pixels / (frame.width * frame.height)) > 1e-6 ||
        instance.normalizedBox.some((value, index) => Math.abs(value - instance.box[index] / (index % 2 ? frame.height : frame.width)) > 1e-6));
  })) ctx.addIssue({ code: 'custom', message: 'Cached segmentation belongs to a different reference frame.' });
});
export type ReferenceFrame = z.infer<typeof referenceFrameSchema>;
export type ReferenceSource = z.infer<typeof referenceSourceSchema>;
export type ReferenceObservation = z.infer<typeof referenceObservationSchema>;
export type ReferenceContext = z.infer<typeof referenceContextSchema>;
export interface ReferenceProgress { sourceId: string; observations: ReferenceObservation[]; callsUsed: number; framesRequested: boolean }
export const observationKey = (frameId: string, concept: string, threshold: number) => JSON.stringify([frameId, concept.trim().toLocaleLowerCase('en'), threshold]);
