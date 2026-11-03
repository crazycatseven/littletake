import { z } from 'zod';
import { performanceContext, performanceSelection, performanceFrames, performanceOperations, performanceCandidateSchema } from '../../src/performance/refinement.ts';
import { applyProjectOperations, type SceneOperation } from '../../src/scene-edit/operations.ts';
import type { SceneEditInput, SceneEditResponse } from '../../src/scene-edit/types.ts';
import type { SceneEditDiagnostic } from '../../src/scene-edit/diagnostics.ts';
import { AIError, type AIContent, type AIProvider } from '../ai/provider.ts';

const proposalSchema = z.strictObject({
  intent: z.string().min(1).max(800),
  observations: z.array(z.strictObject({ time: z.number().min(0).max(60), observation: z.string().min(1).max(180) })).max(6),
  summary: z.string().min(1).max(700), question: z.string().max(400).nullable(), refinements: performanceCandidateSchema.shape.refinements.nullable(),
});
const reviewSchema = z.strictObject({ approved: z.boolean(), summary: z.string().min(1).max(700), issues: z.array(z.string().min(1).max(200)).max(4) });

/** Exactly one model call per phase: interpretation/proposal, then matching before/after visual review. */
export async function proposePerformance(input: SceneEditInput, provider: AIProvider, signal?: AbortSignal, diagnostic?: SceneEditDiagnostic): Promise<SceneEditResponse> {
  const { targets, candidate } = input.performance!, selected = performanceSelection(input.project, targets);
  if (input.sceneId !== targets[0].sceneId) throw new AIError('invalid_input', 'The recording scope changed. Select the takes again.', 400);
  const expected = performanceFrames(input.project, targets);
  const variants = candidate ? ['before', 'after'] as const : ['before'] as const;
  if (input.snapshots.length !== expected.length * variants.length || variants.some(variant => expected.some(frame => !input.snapshots.some(snapshot => snapshot.variant === variant && snapshot.shotId === frame.shotId && snapshot.view === frame.view && Math.abs(snapshot.time - frame.time) < 1e-6))))
    throw new AIError('invalid_input', 'All selected recordings need their timed rendered views before Muse can review them.', 400);
  const operations: SceneOperation[] = candidate ? performanceOperations(targets, candidate) : [];
  const proposed = candidate ? applyProjectOperations(input.project, operations, input.time) : undefined;
  const instructions = `You are Muse, a performance director in LittleTake. Infer the user's creative intention from their recorded movement AND the supplied timed rendered images. This is universal: a creature, vehicle, prop, performer, XR manipulation or camera take. Do not assume it is a camera. Separate observed facts from inferred intent; use tentative wording for inferences. Reply in the user's language.
Use the latest user request and current scene as authoritative. Preserve deliberate passes, direction changes, pauses, the order of landmarks, subject identity and take duration. Optimize readability and expression, not just minimal curvature. Never invent a goal or claim collision-free geometry from a handful of images. For ambiguous material choices, ask ONE short question and return refinements=null. Unrelated scene-building requests cannot be performed in this scoped workflow; explain that they can detach the recording to edit the scene. Prior conversation proposals are not applied unless their applicationStatus says applied.
The selected recordings form ONE coordinated performance. Understand interactions between their subjects (for example an actor and following camera), and review the combined result. The only editable data are each selected subject's existing local position and rotation channels inside its selected take. Unselected recordings, other entities, joints, scale, FOV, scripts and each take's endpoints remain untouched. Coordinates are Three.js: Y up, XYZ Euler degrees, metres. Camera forward is local -Z; actors usually +Z. Samples include local and world poses; anchors MUST be in the subject's LOCAL parent coordinates. Do not confuse local and world values for moving parents.
${candidate ? `VISUAL REVIEW PHASE. Before and after images have identical timestamps and viewing camera. Compare them with the proposed intent, original trajectory and candidate trajectory. Approve only if this candidate supports the intended action without a visible regression. Sparse frames cannot establish continuous collision clearance. If the intent is uncertain, the subject is not visible enough or the proposal makes composition worse, approved=false, explain what is missing. Do not output a revised path or claim it was applied.` : `PROPOSAL PHASE. Return intent, timestamped observations from the images, concise summary, question=null unless clarification is essential, and refinements. Each entry has targetIndex matching the supplied performances array, plus refinement={smoothness,anchors}. Return exactly one entry for EVERY selected recording; use smoothness=0 and anchors=[] when that recording should stay as-is. Never change unselected recordings. The recordings may overlap in time on different entities or be successive takes on the same entity. smoothness=0..1 removes short jitter over a maximum 0.12-second neighborhood; use modest values and preserve intentional shaking. anchors=[] gives smoothing only. To change a path or framing, provide a few strictly increasing absolute scene-time anchors with desired local position AND rotation, strictly INSIDE the take's interval. Do not resubmit endpoints. The engine applies smooth corrections to the existing recording and preserves movement between these anchors; you are not rebuilding a path from scratch. Prefer the fewest anchors that express the user's intent. If no improvement is supported, return refinements=null. Your proposal will be rendered and visually checked before it can be presented for application.`}`;
  const context = (project: SceneEditInput['project']) => {
    const entries = targets.map(target => performanceContext(project, target));
    return { scene: entries[0].scene, performances: entries.map(({ scene: _scene, ...entry }, targetIndex) => ({ targetIndex, ...entry })) };
  };
  const content: AIContent[] = [{ type: 'text', text: JSON.stringify({ request: input.prompt, original: context(input.project),
    ...(candidate && proposed ? { candidate, proposed: context(proposed) } : {}) }) }];
  for (const snapshot of input.snapshots) content.push({ type: 'text', text: JSON.stringify({ variant: snapshot.variant, time: snapshot.time, view: snapshot.view, shotId: snapshot.shotId, bounds: snapshot.bounds }) }, { type: 'image', dataUrl: snapshot.dataUrl });
  const request = { instructions, content, history: input.history ?? [], schema: z.toJSONSchema(candidate ? reviewSchema : proposalSchema), schemaName: candidate ? 'performance_visual_review' : 'performance_intent', format: 'json_object' as const, reasoningEffort: 'high' as const };
  const evidence: SceneEditDiagnostic['attempts'][number] = { request: structuredClone(request) };
  if (diagnostic) { diagnostic.input ??= structuredClone(input); diagnostic.provider = provider.name; diagnostic.model = provider.model; diagnostic.attempts.push(evidence); }
  const ready = (summary: string, operations: SceneOperation[] = []): SceneEditResponse => {
    if (diagnostic) diagnostic.outcome = 'ready';
    return { status: 'ready', provider: provider.name, model: provider.model, plan: { summary, requestedViews: [], operations } };
  };
  try {
    signal?.throwIfAborted();
    const value = await provider.generateObject({ ...request, signal, onOutput: text => { evidence.rawOutput = text; } });
    evidence.rawProposal = structuredClone(value);
    if (candidate) {
      const review = reviewSchema.parse(value);
      return review.approved && !review.issues.length ? ready(`${candidate.summary}\n\n${review.summary}`, operations)
        : ready(`${review.summary}\n${review.issues.join('\n')}\n\nThe original recording is unchanged. No candidate was applied.`);
    }
    const proposal = proposalSchema.parse(value);
    if (proposal.observations.some(item => !selected.some(({ take }) => item.time >= take.start && item.time <= take.end))) throw new Error('An observation refers to a time outside this recording.');
    const summary = [proposal.intent, ...proposal.observations.map(item => `${item.time.toFixed(2)}s — ${item.observation}`), proposal.summary, proposal.question].filter(Boolean).join('\n');
    if (proposal.question || !proposal.refinements) return ready(summary);
    const nextCandidate = { summary, refinements: proposal.refinements };
    applyProjectOperations(input.project, performanceOperations(targets, nextCandidate), input.time);
    if (diagnostic) diagnostic.outcome = 'needs_motion_review';
    return { status: 'needs_motion_review', provider: provider.name, model: provider.model, candidate: nextCandidate };
  } catch (error) {
    evidence.error = { code: error instanceof AIError ? error.code : 'invalid_performance', message: error instanceof Error ? error.message : 'Performance review failed.' };
    if (error instanceof AIError || signal?.aborted) throw error;
    throw new AIError('invalid_performance', 'Muse could not validate this recording refinement. The original recording is unchanged.');
  }
}
