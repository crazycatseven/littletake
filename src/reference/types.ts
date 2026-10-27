import type { SceneDocument } from '../types.ts';

export const REFERENCE_LIMITS = { maxVideoBytes: 3_000_000, minSeconds: 1, maxSeconds: 60 } as const;
export const MAX_REFERENCE_BODY_BYTES = 4_100_000;
export const REFERENCE_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;

export interface ReferenceInput {
  video: { dataUrl: string; duration: number; width: number; height: number };
  direction: string;
}
export interface ReferenceDraft {
  scene: SceneDocument;
  summary: string;
  assumptions: string[];
  provider: string;
  model: string;
}
export interface ReferenceConnection { available: boolean; provider: string; model: string }
