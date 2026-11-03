import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Euler, MathUtils } from 'three';
import { createDocument, History } from '../model.ts';
import { emptyAnimation, evaluateTransform, keepRecordedTake, propertyPaths, putKey } from '../animation/model.ts';
import { projectContent, serializeContent } from '../project/model.ts';
import { createProject, parseProject, serializeProject } from '../project/storage.ts';
import { conversationsSchema, createConversations, type ConversationBook } from '../scene-edit/conversations.ts';
import { ConversationSession, type EditorContext } from '../scene-edit/session.ts';
import { applyProjectOperations, type SceneOperation, type SceneSnapshot, type SceneView } from '../scene-edit/operations.ts';
import { parseSceneEditInput, proposeSceneEdit } from '../../server/scene-edit.ts';
import { createSceneEditHandler } from '../../server/scene-edit-api.ts';
import type { AIProvider, StructuredRequest } from '../../server/ai/provider.ts';
import type { SceneEditInput, SceneEditResponse } from '../scene-edit/types.ts';
import type { ProjectContent, SceneEntity, Vec3 } from '../types.ts';
import { performanceContext, performanceTake, refineRecordedTake, performanceFrames, performanceOperations, type PerformanceTarget } from './refinement.ts';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+c5N8AAAAASUVORK5CYII=';
const refinement = { smoothness: .6, anchors: [{ time: 2.25, position: [2, 2, 1] as Vec3, rotation: [0, 45, 0] as Vec3 }] };
function fixture(camera = false, takeId = 'take-1') {
  const scene = createDocument(), item: SceneEntity = camera ? scene.cameras[0] : scene.objects[0];
  item.track = null; item.animation = emptyAnimation();
  for (const [axis, path] of propertyPaths('position').entries()) { putKey(item.animation, path, 0, item.transform.position[axis]); putKey(item.animation, path, 5, item.transform.position[axis] + 1); }
  const frames = Array.from({ length: 121 }, (_, index) => ({ time: .5 + index / 30,
    transform: { position: [index / 30, 1 + (index === 0 || index === 120 ? 0 : index % 2 ? .03 : -.03), 0] as Vec3,
      rotation: [0, index / 4, 0] as Vec3, scale: [1, 1, 1] as Vec3 } }));
  item.animation = keepRecordedTake(item.animation, takeId, frames, scene.duration, { recordScale: false });
  putKey(item.animation, 'scale.x', 0, 1); putKey(item.animation, 'scale.x', 5, 2);
  if (camera) { putKey(item.animation, 'fov', 0, 40); putKey(item.animation, 'fov', 5, 65); }
  const project: ProjectContent = { name: 'Performance', scenes: [scene] };
  const target: PerformanceTarget = { sceneId: scene.id, entityId: item.id, takeId, shotId: scene.shots[0].id };
  return { project, target, item, scene };
}
function snapshot(time: number, view: SceneView): SceneSnapshot { return { view, time, width: 1, height: 1, dataUrl: png, bounds: view === 'top_down' ? { minX: -5, maxX: 5, minZ: -5, maxZ: 5 } : null }; }
function inputFor(project: ProjectContent, target: PerformanceTarget): SceneEditInput {
  const { take } = performanceTake(project, target);
  return { project, sceneId: target.sceneId, shotId: target.shotId, selectedId: target.entityId, selectedIds: [target.entityId], time: take.start, prompt: 'Make this pass more readable.', performance: { targets: [target] },
    snapshots: performanceFrames(project, [target]).map(frame => ({ ...snapshot(frame.time, frame.view), shotId: frame.shotId, variant: 'before' })) };
}
const proposal = { intent: 'It appears you want a rising pass around the subject.', observations: [{ time: 2.1, observation: 'The recorded pass approaches the subject.' }], summary: 'Lift the middle of the route and reduce jitter.', question: null, refinements: [{ targetIndex: 0, refinement }] };
const approved = { approved: true, summary: 'The sampled frames make the pass clearer. Continuous clearance is not established.', issues: [] };
function provider(outputs: unknown[]) {
  const calls: StructuredRequest[] = [];
  const ai: AIProvider = { name: 'Test', model: 'Test', async generateObject(request) { calls.push(structuredClone({ ...request, signal: undefined, onOutput: undefined })); assert.ok(outputs.length, 'no unbounded model retry'); return outputs.shift(); },
    async generateToolTurn() { throw new Error('Performance refinement must not invoke asset tools'); } };
  return { ai, calls };
}

test('recorded objects, camera pilots, script and XR takes share one atomic operation and retain other data', () => {
  for (const [camera, id] of [[false, 'take-1'], [true, 'camera-take'], [false, 'script-take'], [false, 'xr-take-1']] as const) {
    const { project, target, item } = fixture(camera, id), frozen = serializeContent(project);
    const operation: SceneOperation = { type: 'refine_take', sceneId: target.sceneId, id: item.id, takeId: id, refinement };
    const next = applyProjectOperations(project, [operation], .5), changed = [...next.scenes[0].objects, ...next.scenes[0].cameras].find(entity => entity.id === item.id)!;
    assert.equal(serializeContent(project), frozen);
    for (const time of [0, .2, .5, 4.5, 4.8, 5]) assert.deepEqual(evaluateTransform(changed, time), evaluateTransform(item, time), 'outside poses and boundaries stay exact');
    const middle = evaluateTransform(changed, 2.25);
    middle.position.forEach((value, axis) => assert.ok(Math.abs(value - refinement.anchors[0].position[axis]) < 1e-8));
    assert.ok(Math.abs(middle.rotation[1] - 45) < 1e-7);
    assert.deepEqual(changed.animation!.takes, item.animation!.takes);
    for (const path of ['scale.x', 'fov'] as const) assert.deepEqual(changed.animation!.curves[path], item.animation!.curves[path]);
    for (const entity of [...project.scenes[0].objects, ...project.scenes[0].cameras]) if (entity.id !== item.id) assert.deepEqual([...next.scenes[0].objects, ...next.scenes[0].cameras].find(node => node.id === entity.id), entity);
    const stored = createProject(next.scenes[0]); stored.name = next.name;
    assert.deepEqual(projectContent(parseProject(serializeProject(stored))), next);
    const history = new History(project); history.commit(next); assert.deepEqual(history.undo(), project); assert.deepEqual(history.redo(), next);
  }
});

test('smoothing reduces jitter, keeps stationary pauses, rotations and joint channels, and rejects out-of-scope anchors', () => {
  const { item, scene, target } = fixture();
  item.animation!.curves['jointAngles.wing'] = [{ time: 0, value: 0, interpolation: 'linear' }, { time: 5, value: 60, interpolation: 'linear' }];
  const after = refineRecordedTake(item, target.takeId, { smoothness: 1, anchors: [] }, scene.duration);
  assert.deepEqual(after.curves['jointAngles.wing'], item.animation!.curves['jointAngles.wing']);
  const residual = (entity: SceneEntity) => Array.from({ length: 80 }, (_, i) => Math.abs(evaluateTransform(entity, 1 + i / 30).position[1] - 1)).reduce((a, b) => a + b, 0);
  assert.ok(residual({ ...item, animation: after }) < residual(item) * .5);
  const paused = structuredClone(item);
  for (const path of [...propertyPaths('position'), ...propertyPaths('rotation')]) for (const key of paused.animation!.curves[path]!) if (key.time >= 1.5 && key.time <= 3) { key.value = path === 'position.y' ? 1 : 0; if (key.orientation) key.orientation = [0, 0, 0]; }
  const pausedAfter = refineRecordedTake(paused, target.takeId, { smoothness: 1, anchors: [] }, scene.duration);
  for (const time of [1.75, 2, 2.75]) assert.deepEqual(evaluateTransform({ ...paused, animation: pausedAfter }, time).position, [0, 1, 0]);
  assert.deepEqual(refineRecordedTake(item, target.takeId, { smoothness: 0, anchors: [] }, scene.duration), item.animation);
  for (const time of [0, .5, 4.5, 6]) assert.throws(() => refineRecordedTake(item, target.takeId, { ...refinement, anchors: [{ ...refinement.anchors[0], time }] }, scene.duration));
  assert.throws(() => refineRecordedTake(item, target.takeId, { ...refinement, anchors: [refinement.anchors[0], refinement.anchors[0]] }, scene.duration));
  const rotation = after.curves['rotation.y']!.find(key => key.time > 2)!;
  const q = new Quaternion().setFromEuler(new Euler(...rotation.orientation!.map(MathUtils.degToRad) as Vec3)); assert.ok(Number.isFinite(q.length()));
});

test('parented performance evidence includes local and animated world poses without changing parent motion', () => {
  const { project, target, item, scene } = fixture(true), parent = scene.objects[1];
  parent.animation = emptyAnimation(); putKey(parent.animation, 'position.x', 0, 0); putKey(parent.animation, 'position.x', 5, 10);
  parent.transform.scale = [2, 2, 2]; item.parentId = parent.id;
  const context = performanceContext(project, target);
  assert.notDeepEqual(context.samples[20].local.position, context.samples[20].world.position);
  const result = applyProjectOperations(project, [{ type: 'refine_take', sceneId: scene.id, id: item.id, takeId: target.takeId, refinement }], 0);
  assert.deepEqual(result.scenes[0].objects[1], parent);
  assert.equal(result.scenes[0].cameras[0].parentId, parent.id);
});

function sessionHarness(outputs: unknown[], initialBook = createConversations()) {
  const { project: initial, target } = fixture(); let project = initial, revision = 0, preview: ProjectContent | null = null;
  const { ai, calls } = provider(outputs), captures: { variant: 'before' | 'after'; time: number; view: SceneView; subjectY: number }[] = [];
  let context: Omit<EditorContext, 'project' | 'revision'> = { sceneId: target.sceneId, shotId: target.shotId, time: 0, selectedId: target.entityId };
  const session = new ConversationSession(initialBook, {
    context: () => ({ ...context, project, revision }), prepare() {}, changed() {},
    focus(next) { context = { ...context, ...next }; return true; },
    capture(content, _scene, _shot, time, view, compact) { assert.equal(compact, true); captures.push({ variant: content === initial ? 'before' : 'after', time, view, subjectY: evaluateTransform(content.scenes[0].objects[0], time).position[1] }); return snapshot(time, view); },
    preview(next) { preview = next; },
    apply(next, base) { assert.equal(serializeContent(project), base); project = next; revision++; session.sceneChanged(); return true; },
    request(input, signal) { return proposeSceneEdit(parseSceneEditInput(input), ai, signal); },
  });
  return { session, target, calls, captures, get project() { return project; }, get preview() { return preview; },
    change() { project.scenes[0].objects[1].name = 'Edited by peer'; revision++; session.sceneChanged(); } };
}

test('a saved take scope survives clarification and drives two-phase visual review, preview, apply and project reopen', async () => {
  const h = sessionHarness([{ ...proposal, refinements: null, question: 'Should the middle pass rise or stay level?' }]);
  h.session.attachPerformance([h.target]); await h.session.send();
  assert.equal(h.calls.length, 1); assert.equal(h.preview, null);
  const book: ConversationBook = conversationsSchema.parse(JSON.parse(JSON.stringify(h.session.book)));
  assert.deepEqual(book.threads[0].performance, [h.target]);
  const migrated = conversationsSchema.parse({ ...book, threads: book.threads.map(thread => ({ ...thread, performance: h.target })) });
  assert.deepEqual(migrated.threads[0].performance, [h.target]);
  const next = sessionHarness([proposal, approved], book), before = serializeContent(next.project);
  next.session.setDraft('Rise around the sculpture, while keeping the beginning and ending.'); await next.session.send();
  assert.equal(next.calls.length, 2); assert.equal(next.calls[0].content.filter(part => part.type === 'image').length, 7);
  assert.equal(next.calls[1].content.filter(part => part.type === 'image').length, 14);
  assert.ok(next.calls[0].history!.some(message => message.text.includes('rise or stay level')));
  assert.ok(next.calls[1].instructions.includes('VISUAL REVIEW PHASE'));
  assert.deepEqual(next.captures.slice(0, 7).map(frame => [frame.time, frame.view]), next.captures.slice(7).map(frame => [frame.time, frame.view]));
  assert.notEqual(next.captures[2].subjectY, next.captures[9].subjectY);
  assert.equal(serializeContent(next.project), before, 'rendering a candidate does not apply it'); assert.ok(next.preview);
  const reply = next.session.active.messages.at(-1)!; assert.equal(reply.role, 'assistant');
  assert.deepEqual(next.session.previewRange, { start: .5, end: 4.5 });
  next.session.review(reply.id, false); assert.equal(next.preview, null); next.session.review(reply.id, true); assert.ok(next.preview);
  next.session.apply(reply.id); assert.notEqual(serializeContent(next.project), before); assert.equal(next.preview, null);
  const saved = createProject(next.project.scenes[0]); saved.conversations = next.session.book;
  assert.deepEqual(parseProject(serializeProject(saved)).conversations, next.session.book);
  next.session.detachPerformance(); assert.equal(next.session.active.performance, undefined);
});

test('failed visual review or provider error leaves the original intact and cannot loop', async () => {
  for (const result of [{ approved: false, summary: 'The subject is lost behind the wall.', issues: ['The pass is not readable.'] }, { invalid: true }]) {
    const h = sessionHarness([proposal, result]), before = serializeContent(h.project);
    h.session.attachPerformance([h.target]); await h.session.send();
    assert.equal(h.calls.length, 2); assert.equal(serializeContent(h.project), before); assert.equal(h.preview, null);
    assert.ok(!h.session.active.messages.some(message => message.role === 'assistant' && message.edit));
  }
});

test('cancellation, concurrent edits and stale apply cannot overwrite a peer or cross takes', async () => {
  const h = sessionHarness([proposal, approved]); h.session.attachPerformance([h.target]);
  const pending = h.session.send(); h.session.cancel(); await pending;
  assert.equal(h.calls.length, 0, 'cancelling while capturing must not start a model request');
  h.session.setDraft('Smooth this take'); await h.session.send(); const reply = h.session.active.messages.at(-1)!;
  assert.ok(h.preview); const original = structuredClone(h.project.scenes[0].objects[0]);
  h.change(); h.session.apply(reply.id); assert.equal(h.preview, null); assert.deepEqual(h.project.scenes[0].objects[0], original);
  assert.equal(h.project.scenes[0].objects[1].name, 'Edited by peer');
  if (reply.role === 'assistant') assert.equal(reply.edit!.status, 'stale');
  const incoming = structuredClone(h.session.book); delete incoming.threads[0].performance; h.session.receiveBook(incoming);
  assert.equal(h.session.active.performance, undefined, 'detaching a shared scope is received from peers');
});

test('API rejects missing evidence, wrong time, malformed images and changed scope before any model call', async () => {
  const { project, target } = fixture(), input = inputFor(project, target), { ai, calls } = provider([proposal]);
  const handler = createSceneEditHandler({}, () => ai);
  for (const body of [
    { ...input, snapshots: [] },
    { ...input, snapshots: input.snapshots.slice(1) },
    { ...input, snapshots: [...input.snapshots, input.snapshots[0]] },
    { ...input, snapshots: input.snapshots.map((frame, index) => index ? frame : { ...frame, time: 5 }) },
    { ...input, snapshots: input.snapshots.map(frame => ({ ...frame, dataUrl: 'data:image/jpeg;base64,YmFk' })) },
    { ...input, performance: { targets: [{ ...target, entityId: 'object-2' }] } },
  ]) {
    const response = await handler(new Request('http://localhost/api/scene-edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    assert.equal(response.status, 400);
  }
  assert.equal(calls.length, 0);
  const response = await handler(new Request('http://localhost/api/scene-edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
  assert.equal(response.status, 200); const body = await response.json() as SceneEditResponse; assert.equal(body.status, 'needs_motion_review'); assert.equal(calls.length, 1);
});

test('multiple actor takes and camera motion are reviewed together across viewing cameras, saved and applied as one undoable change', async () => {
  const { project: initial, target, item, scene } = fixture(); scene.duration = 8;
  const laterFrames = Array.from({ length: 61 }, (_, index) => ({ time: 5.5 + index / 30, transform: { ...item.transform, position: [2 + index / 60, 0, 1] as Vec3 } }));
  item.animation = keepRecordedTake(item.animation!, 'later-take', laterFrames, 8, { recordScale: false });
  const camera = structuredClone(scene.cameras[0]); camera.id = 'follow-camera'; camera.name = 'Follow camera'; camera.track = null;
  camera.animation = keepRecordedTake(emptyAnimation(), 'camera-take', [{ time: .5, transform: camera.transform }, { time: 4.5, transform: { ...camera.transform, position: [5, 3, 7] } }], 8, { recordScale: false });
  scene.cameras.push(camera); scene.shots.push({ ...scene.shots[0], id: 'follow-shot', cameraId: camera.id });
  const targets: PerformanceTarget[] = [target, { ...target, entityId: camera.id, takeId: 'camera-take', shotId: 'follow-shot' }, { ...target, takeId: 'later-take' }];
  const refinements = [{ targetIndex: 0, refinement }, { targetIndex: 1, refinement: { smoothness: .4, anchors: [] } }, { targetIndex: 2, refinement: { smoothness: .3, anchors: [{ time: 6.5, position: [3, .5, 1] as Vec3, rotation: [0, 20, 0] as Vec3 }] } }];
  const { ai, calls } = provider([{ ...proposal, refinements }, approved]);
  let project = initial, revision = 0, preview: ProjectContent | null = null;
  const before = serializeContent(project), history = new History(project), captures: { shotId: string | null; time: number }[] = [];
  let context = { sceneId: scene.id, shotId: target.shotId, selectedId: item.id, selectedIds: [item.id], time: .5 };
  const session = new ConversationSession(createConversations(), {
    context: () => ({ ...context, project, revision }), prepare() {}, changed() {},
    focus(next) { context = { ...context, ...next, time: next.time ?? 0, selectedId: next.selectedId ?? null, selectedIds: next.selectedIds ?? [] } as typeof context; return true; },
    capture(_content, _scene, shotId, time, view) { captures.push({ shotId, time }); return snapshot(time, view); },
    preview(next) { preview = next; },
    apply(next, base) { assert.equal(base, serializeContent(project)); history.commit(next); project = next; revision++; session.sceneChanged(); return true; },
    request(input, signal) { return proposeSceneEdit(parseSceneEditInput(input), ai, signal); },
  });
  session.attachPerformance(targets); session.detachPerformance(1); assert.deepEqual(session.active.performance, [target, targets[2]]);
  session.attachPerformance(targets);
  assert.deepEqual(conversationsSchema.parse(JSON.parse(JSON.stringify(session.book))).threads[0].performance, targets);
  await session.send();
  assert.equal(calls.length, 2, 'one shared proposal and one shared review, not two calls per recording');
  assert.equal(serializeContent(project), before); assert.ok(preview);
  const frameCount = performanceFrames(initial, targets).length;
  assert.equal(frameCount, 19); assert.equal(captures.length, frameCount * 2);
  assert.deepEqual(captures.slice(0, frameCount), captures.slice(frameCount), 'all cameras and times match between original and combined candidate');
  assert.ok(captures.some(frame => frame.shotId === 'follow-shot'));
  const original = JSON.parse((calls[0].content[0] as { text: string }).text).original;
  assert.equal(original.performances.length, 3);
  const combined = JSON.parse((calls[1].content[0] as { text: string }).text).proposed;
  assert.equal(combined.performances.length, 3);
  const reply = session.active.messages.at(-1)!; assert.equal(reply.role, 'assistant');
  assert.deepEqual(session.previewRange, { start: .5, end: 7.5 });
  session.apply(reply.id); assert.notEqual(serializeContent(project), before);
  assert.deepEqual(project.scenes[0].objects[1], initial.scenes[0].objects[1]);
  assert.ok(evaluateTransform(project.scenes[0].objects[0], 6.5).position[1] > .49);
  assert.equal(serializeContent(history.undo()!), before, 'one Undo restores all selected recordings together');
  const stored = createProject(project.scenes[0]); stored.conversations = session.book;
  assert.deepEqual(parseProject(serializeProject(stored)).conversations, session.book);
  assert.throws(() => performanceOperations(targets, { summary: 'Bad target', refinements: [{ targetIndex: 0, refinement }, { targetIndex: 0, refinement }, { targetIndex: 2, refinement }] }));
  assert.throws(() => performanceFrames(project, [target, target]));
});
