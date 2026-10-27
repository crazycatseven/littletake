export type Vec3 = [number, number, number];
import type { AssetDefinition, AssetReference } from './assets/model';
import type { ObjectComponent } from './components/model';
export type PrimitiveKind = 'cube' | 'sphere' | 'cylinder' | 'cone' | 'plane' | 'human' | 'asset';
export type ToolMode = 'translate' | 'rotate' | 'scale';
export type Axis = 'X' | 'Y' | 'Z';
/** Rotation values are degrees; positions and sizes use world units. */
export interface Transform { position: Vec3; rotation: Vec3; scale: Vec3 }
export interface MotionTrack { start: number; duration: number; from: Transform; to: Transform; samples?: { at: number; transform: Transform }[] }
export interface SceneObject { id: string; name: string; kind: PrimitiveKind; color: string; transform: Transform; track: MotionTrack | null; asset?: AssetReference; components?: ObjectComponent[] }
export interface SceneCamera { id: string; name: string; fov: number; transform: Transform; track: MotionTrack | null }
/** A shot selects a camera and a range of the shared scene clock. Framing belongs only to the camera. */
export interface Shot { id: string; name: string; cameraId: string; start: number; duration: number }
export type SceneEntity = SceneObject | SceneCamera;
export interface SceneDocument { format: 'LittleTake.scene'; version: 3; id: string; name: string; duration: number; objects: SceneObject[]; cameras: SceneCamera[]; shots: Shot[] }
export interface ProjectContent { name: string; scenes: SceneDocument[]; assets?: AssetDefinition[] }
export interface StageOptions {
  viewport: HTMLElement;
  preview: HTMLElement;
  onSelect(id: string | null): void;
  onTransform(id: string, transform: Transform, phase: 'start' | 'change' | 'end'): void;
  onStatus(message: string): void;
}
