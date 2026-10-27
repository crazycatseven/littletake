import type { ProjectContent } from '../types';
import type { EditPlan, SceneSnapshot, SceneView } from './operations';
import type { ConversationHistory } from './conversations';

export interface SceneEditInput {
  project: ProjectContent; sceneId: string | null; shotId: string | null; prompt: string; selectedId: string | null; time: number;
  snapshots: SceneSnapshot[];
  history?: ConversationHistory;
}
export type SceneEditResponse =
  | { status: 'needs_views'; requestedViews: SceneView[]; summary: string; provider: string; model: string }
  | { status: 'ready'; plan: EditPlan; provider: string; model: string };
