import type { SceneDocument,ImageBounds } from '../types.ts';
import type { AssetDefinition } from '../assets/model.ts';
import type { DetectedRegion, FaceLandmarks, ReferenceAnalysis, ReferenceQuality, SourceEvidence } from './analysis.ts';
import type { SceneSnapshot,SceneView } from '../scene-edit/operations.ts';
export type ReferenceCapture=(scene:SceneDocument,time:number,shotId:string,assets:AssetDefinition[],measureVisible:boolean,view?:SceneView,frameBounds?:ImageBounds)=>Pick<SceneSnapshot,'dataUrl'|'visibleBoxes'>;

export const REFERENCE_LIMITS = { maxVideoBytes: 3_000_000, maxImageBytes: 3_000_000, minSeconds: 1, maxSeconds: 60, imageSeconds: 5 } as const;
export const MAX_REFERENCE_BODY_BYTES = 4_400_000;
export const REFERENCE_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
export type ReferenceBindings=Record<string,string[]>;
export const REFERENCE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** `cuts` are hard-cut times in seconds found in the browser; the draft rebuilds the shot before the first one. */
export interface ReferenceVideo { dataUrl: string; duration: number; width: number; height: number; cuts?: number[] }
/** A storyboard panel, sketch, concept frame or photo; `duration` is the length of the shot it becomes. */
export interface ReferenceImage { dataUrl: string; duration: number; width: number; height: number }
export interface VideoReferenceInput {
  /** `cuts` are hard-cut times in seconds found in the browser; the draft rebuilds the shot before the first one. */
  video: ReferenceVideo;
  direction: string;
  assets?:AssetDefinition[];
  source?: SourceEvidence;
  analysis?: ReferenceAnalysis;
  sourceReview?:boolean;
  review?: { scene: SceneDocument; assets?:AssetDefinition[];contactSheet: string;layoutSheet?:string; video?:string;frames: { shotId: string; time: number }[]; measurements?: unknown[]; continuity?:unknown[];bindings?:ReferenceBindings;sourceRegions?:{time:number;detections:DetectedRegion[];faceLandmarks?:FaceLandmarks[]}[] };
  repair?:{scene:SceneDocument;assets?:AssetDefinition[];quality:ReferenceQuality;bindings?:ReferenceBindings;contactSheet?:string;layoutSheet?:string;frames?:{shotId:string;time:number}[]};
}
export interface ImageReferenceInput {image:ReferenceImage;direction:string}
export type ReferenceInput=VideoReferenceInput|ImageReferenceInput;
/** A SAM 3.1 track for review overlays: boxes as [seconds, x, y, width, height], normalised to the frame. */
export interface ReferenceTrack { label: string; objectId?: string; boxes: [number, number, number, number, number][] }
export interface ReferenceDraft {
  scene: SceneDocument;
  assets?:AssetDefinition[];
  summary: string;
  assumptions: string[];
  provider: string;
  model: string;
  tracks?: ReferenceTrack[];
  analysis?: ReferenceAnalysis;
  quality?: ReferenceQuality;
  bindings?:ReferenceBindings;

}
export interface ReferenceObservation { analysis:ReferenceAnalysis; regions:{frameIndex:number;detections:NonNullable<SourceEvidence['frames'][number]['detections']>}[];provider:string; model:string }
export interface ReferencePreparation {preparation:true;assets:AssetDefinition[];analysis:ReferenceAnalysis;summary:string;provider:string;model:string}
export type ReferenceResult=ReferenceDraft|ReferenceObservation|ReferencePreparation;
export interface ReferenceConnection { available: boolean; provider: string; model: string }
export type ReferenceJobStatus='queued'|'running'|'succeeded'|'failed'|'cancelled'|'interrupted';
export interface ReferenceJobSummary {id:string;projectName:string;sourceName:string;status:ReferenceJobStatus;message:string;createdAt:string;updatedAt:string;callsUsed:number;callLimit:number;error?:string}
export interface ReferenceJobSubmission {id:string;projectName:string;sourceName:string;input:Pick<VideoReferenceInput,'video'|'direction'>}
