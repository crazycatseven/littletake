export type Vec3 = [number, number, number];
export type PrimitiveKind = 'cube' | 'sphere' | 'cylinder' | 'cone' | 'plane' | 'human';
export type ToolMode = 'translate' | 'rotate' | 'scale';
export type Axis = 'X' | 'Y' | 'Z';
/** Rotation values are degrees; positions and sizes use world units. */
export interface Transform { position: Vec3; rotation: Vec3; scale: Vec3 }
export interface MotionTrack { start: number; duration: number; from: Transform; to: Transform }
export interface SceneObject { id: string; name: string; kind: PrimitiveKind; color: string; transform: Transform; track: MotionTrack | null }
export interface ShotCamera { id: 'camera'; name: string; fov: number; transform: Transform; track: MotionTrack | null }
export type SceneEntity = SceneObject | ShotCamera;
export interface SceneDocument { format: 'LittleTake.scene'; version: 1; name: string; duration: number; objects: SceneObject[]; camera: ShotCamera }
export interface StageOptions {
  viewport: HTMLElement;
  preview: HTMLElement;
  onSelect(id: string | null): void;
  onTransform(id: string, transform: Transform, phase: 'start' | 'change' | 'end'): void;
  onStatus(message: string): void;
}
