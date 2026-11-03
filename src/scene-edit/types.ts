import type { ProjectContent } from '../types';
import type { EditPlan, SceneSnapshot, SceneView } from './operations';
import type { ConversationHistory } from './conversations';
import type { ReferenceContext, ReferenceProgress } from '../reference/observations';
import type { PerformanceRequest, PerformanceCandidate } from '../performance/refinement';

export interface SceneEditInput {
  project: ProjectContent; sceneId: string | null; shotId: string | null; prompt: string; selectedId: string | null; time: number;
  selectedIds?: string[];
  snapshots: SceneSnapshot[];
  history?: ConversationHistory;
  reference?: ReferenceContext;
  performance?: PerformanceRequest;
}
export type SceneEditResponse = (
  | { status: 'needs_reference_frames'; requestedTimes: number[]; summary: string; provider: string; model: string }
  | { status: 'needs_views'; requestedViews: SceneView[]; summary: string; provider: string; model: string }
  | { status: 'needs_motion_review'; candidate: PerformanceCandidate; provider: string; model: string }
  | { status: 'ready'; plan: EditPlan; provider: string; model: string }) & { reference?: ReferenceProgress };
