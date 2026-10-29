export type Vec3 = [number, number, number];
export type PrimitiveKind = 'cube' | 'sphere' | 'cylinder' | 'cone' | 'plane' | 'human';
export type ToolMode = 'translate' | 'rotate' | 'scale';
export type Axis = 'X' | 'Y' | 'Z';
/** Rotation values are degrees; positions and sizes use world units. */
export interface Transform { position: Vec3; rotation: Vec3; scale: Vec3 }
export interface MotionTrack { start: number; duration: number; from: Transform; to: Transform; samples?: { at: number; transform: Transform }[] }
export interface SceneObject { id: string; name: string; kind: PrimitiveKind | 'asset'; color: string; transform: Transform; track: MotionTrack | null; asset?: import('./assets/model.ts').AssetReference }
export interface SceneCamera { id: string; name: string; fov: number; transform: Transform; track: null }
/** A shot keeps its own framing. All track times use the scene's clock. */
export interface Shot { id: string; name: string; cameraId: string; start: number; duration: number; fov: number; transform: Transform; track: MotionTrack | null }
export type SceneEntity = SceneObject | SceneCamera | Shot;
export interface SceneDocument { format: 'LittleTake.scene'; version: 2; id: string; name: string; duration: number; objects: SceneObject[]; cameras: SceneCamera[]; shots: Shot[] }
export interface ProjectContent { name: string; scenes: SceneDocument[]; assets?: import('./assets/model.ts').AssetDefinition[] }
export interface StageOptions {
  viewport: HTMLElement;
  preview: HTMLElement;
  onSelect(id: string | null): void;
  onTransform(id: string, transform: Transform, phase: 'start' | 'change' | 'end'): void;
  onStatus(message: string): void;
}
