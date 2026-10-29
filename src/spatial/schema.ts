import { z } from 'zod';
import { identifier, vector } from '../assets/toolkit/schema.ts';

/** Distances are metres. A frame changes measurement axes, never object scale. */
export const spatialFrameSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('world') }),
  z.strictObject({ kind: z.literal('object'), id: identifier }),
  z.strictObject({ kind: z.literal('camera'), id: identifier }),
]);
export const spatialQuerySchema = z.strictObject({
  sceneId: identifier, time: z.number().min(0).max(60),
  objectIds: z.array(identifier).min(1).max(12), frame: spatialFrameSchema,
});
const context = { sceneId: identifier, time: z.number().min(0).max(60) };
const movement = { ...context, scope: z.enum(['static', 'whole_motion']) };
const axis = z.enum(['x', 'y', 'z']);
const forward = z.enum(['+z', '-z', '+x', '-x']);
export const spatialOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...movement, type: z.literal('place_on'), id: identifier, supportId: identifier.nullable(),
    horizontal: z.enum(['keep', 'center']), clearance: z.number().min(0).max(100) }),
  z.strictObject({ ...movement, type: z.literal('place_relative'), id: identifier, referenceId: identifier,
    frame: spatialFrameSchema, side: z.enum(['left', 'right', 'above', 'below', 'front', 'back']), gap: z.number().min(0).max(1000) }),
  z.strictObject({ ...movement, type: z.literal('face_target'), id: identifier, targetId: identifier, forward }),
  z.strictObject({ ...movement, type: z.literal('align_objects'), objectIds: z.array(identifier).min(1).max(100),
    referenceId: identifier, frame: spatialFrameSchema, axis, edge: z.enum(['min', 'center', 'max']) }),
  z.strictObject({ ...movement, type: z.literal('distribute_objects'), objectIds: z.array(identifier).min(3).max(100),
    frame: spatialFrameSchema, axis, spacing: z.enum(['centers', 'gaps']) }),
  z.strictObject({ ...movement, type: z.literal('attach_anchor'), id: identifier, anchor: z.string().min(1).max(64),
    targetId: identifier, targetAnchor: z.string().min(1).max(64), offset: vector(-1000, 1000), frame: spatialFrameSchema }),
  z.strictObject({ ...context, type: z.literal('follow_path'), id: identifier, points: z.array(vector(-1000, 1000)).min(2).max(120),
    start: z.number().min(0).max(60), duration: z.number().min(.1).max(60), orientation: z.enum(['keep', 'tangent']),
    forward, replaceMotion: z.boolean() }),
]);
export type SpatialFrame = z.infer<typeof spatialFrameSchema>;
export type SpatialQuery = z.infer<typeof spatialQuerySchema>;
export type SpatialOperation = z.infer<typeof spatialOperationSchema>;
export function isSpatialOperation(value: { type: string }): value is SpatialOperation {
  return spatialOperationSchema.options.some(option => option.shape.type.value === value.type);
}
