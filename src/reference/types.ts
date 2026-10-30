import type { SceneDocument } from '../types.ts';

export const REFERENCE_LIMITS = { maxVideoBytes: 3_000_000, maxImageBytes: 3_000_000, minSeconds: 1, maxSeconds: 60, imageSeconds: 5 } as const;
export const MAX_REFERENCE_BODY_BYTES = 4_100_000;
export const REFERENCE_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
export const REFERENCE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** `cuts` are hard-cut times in seconds found in the browser; the draft rebuilds the shot before the first one. */
export interface ReferenceVideo { dataUrl: string; duration: number; width: number; height: number; cuts?: number[] }
/** A storyboard panel, sketch, concept frame or photo; `duration` is the length of the shot it becomes. */
export interface ReferenceImage { dataUrl: string; duration: number; width: number; height: number }
export type ReferenceInput = { video: ReferenceVideo; direction: string } | { image: ReferenceImage; direction: string };
export type VideoReferenceInput = Extract<ReferenceInput, { video: ReferenceVideo }>;
/** A SAM 3.1 track for review overlays: boxes as [seconds, x, y, width, height], normalised to the frame. */
export interface ReferenceTrack { label: string; objectId?: string; boxes: [number, number, number, number, number][] }
export interface ReferenceDraft {
  scene: SceneDocument;
  summary: string;
  assumptions: string[];
  provider: string;
  model: string;
  tracks?: ReferenceTrack[];
}
export interface ReferenceConnection { available: boolean; provider: string; model: string }
