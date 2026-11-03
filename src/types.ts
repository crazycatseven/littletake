export type Vec3 = [number, number, number];
export type ImageBounds = [number,number,number,number];
import type { AssetDefinition, AssetReference } from './assets/model';
import type { ObjectComponent } from './components/model';
import type { SceneLook } from './scene-edit/look';
import type { SelectionMode } from './placement/selection';
import type { PoseUpdate, TransformPhase, TransformScope } from './placement/transforms';
import type { PropertyAnimation } from './animation/model';
export type PrimitiveKind = 'cube' | 'sphere' | 'cylinder' | 'cone' | 'plane' | 'human' | 'asset';
export type ToolMode = 'translate' | 'rotate' | 'scale';
export type Axis = 'X' | 'Y' | 'Z';
/** Rotation values are degrees; positions and sizes use world units. */
export interface Transform { position: Vec3; rotation: Vec3; scale: Vec3 }
export interface MotionTrack { start: number; duration: number; from: Transform; to: Transform; samples?: { at: number; transform: Transform }[] }
export interface SceneObject { id: string; name: string; kind: PrimitiveKind; color: string; parentId?: string; transform: Transform; track: MotionTrack | null; animation?: PropertyAnimation; asset?: AssetReference; jointAngles?: Record<string, number>; components?: ObjectComponent[]; hidden?: boolean }
export interface SceneCamera { id: string; name: string; fov: number; parentId?: string; transform: Transform; track: MotionTrack | null; animation?: PropertyAnimation; frameBounds?: ImageBounds }
/** A shot selects a camera and a range of the shared scene clock. Framing belongs only to the camera. */
export interface Shot { id: string; name: string; cameraId: string; start: number; duration: number }
export type SceneEntity = SceneObject | SceneCamera;
export interface SceneDocument { format: 'LittleTake.scene'; version: 3; id: string; name: string; duration: number; fps?: 24 | 30; objects: SceneObject[]; cameras: SceneCamera[]; shots: Shot[]; paths?: import('./motion-paths/model').MotionPath[]; look?:SceneLook }
export interface ProjectContent { name: string; scenes: SceneDocument[]; assets?: AssetDefinition[]; scripts?: import('./scripts/model').ScriptDefinition[] }
export interface StageOptions {
  onPathOpen?(id: string): void;
  onPathSelect?(index: number, part: import('./motion-paths/model').PathPart): void;
  onPathChange?(id: string, index: number, phase: import('./motion-paths/editor').PathGesture): void;
  onFrame?(time: number): void;
  canEnterXR?(): boolean;
  onXRChange?(active: boolean): void;
  xrTimelineState?(): import('./xr/timeline').XRTimelineState;
  onXRSeek?(time: number): void;
  onXRAddKeyframe?(): void;
  onXRDeleteKeyframe?(times?: number[]): void;
  onXRRecordAction?(action: import('./xr/recording').XRRecordAction): void;
  onXRTransform?(id: string, pose: Transform, phase: TransformPhase): boolean;
  onXRTimelineChange?(active: boolean): void;
  onXRAction?(action: 'play' | 'undo'): void;
  xrMenuState?(): { playing: boolean; canUndo: boolean };
  viewport: HTMLElement;
  preview: HTMLElement;
  onSelect(ids: string[], mode: SelectionMode): void;
  onTransform(updates: PoseUpdate[], phase: TransformPhase, wholeMotion: TransformScope): boolean;
  onStatus(message: string): void;
}
