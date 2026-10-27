import type { SceneDocument } from '../types';
import type { EditPlan, SceneSnapshot, SceneView } from './operations';

export interface SceneEditInput {
  scene: SceneDocument; prompt: string; selectedId: string | null; time: number;
  snapshots: SceneSnapshot[];
}
export type SceneEditResponse =
  | { status: 'needs_views'; requestedViews: SceneView[]; summary: string; provider: string; model: string }
  | { status: 'ready'; plan: EditPlan; provider: string; model: string };
