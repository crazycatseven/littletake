import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Euler, MathUtils, Vector3 } from 'three';
import { createDocument, cloneDocument, evaluateTransform, History, serializeDocument } from '../src/model.ts';
import { applySceneOperations, editPlanSchema, type SceneOperation, type SceneSnapshot } from '../src/scene-edit/operations.ts';
import { topDownCamera } from '../src/scene-snapshot.ts';
import { parseSceneEditInput, proposeSceneEdit } from '../server/scene-edit.ts';
import { createSceneEditHandler } from '../server/scene-edit-api.ts';
import { MetaProvider } from '../server/ai/meta.ts';
import { AIError, type AIProvider, type StructuredRequest } from '../server/ai/provider.ts';

const input = () => ({ scene: createDocument(), prompt: 'Move the selected object left by one metre.', selectedId: 'object-2', time: 0, snapshots: [] as SceneSnapshot[] });
const plan = () => ({ summary: 'Moved the plinth left by one metre.', requestedViews: [], operations: [{ type: 'translate', id: 'object-2', offset: [-1, 0, 0] }] });
const snapshot = (): SceneSnapshot => ({ view: 'top_down', time: 0, width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+c5N8AAAAASUVORK5CYII=', bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 } });
const provider = (output: unknown): AIProvider => ({ name: 'Replacement', model: 'test', async generateObject() { return output; } });
const request = (body: unknown, origin?: string) => new Request('http://127.0.0.1:4176/api/scene-edit', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });

test('AI translation changes only its target, and moves an animated path consistently', () => {
  const before = createDocument(), frozen = serializeDocument(before);
  const next = applySceneOperations(before, [{ type: 'translate', id: 'object-1', offset: [1, 2, -3] }], 0);
  assert.equal(serializeDocument(before), frozen);
  assert.deepEqual(next.objects[1], before.objects[1]); assert.deepEqual(next.camera, before.camera);
  for (const key of ['from', 'to'] as const) assert.deepEqual(next.objects[0].track![key].position, before.objects[0].track![key].position.map((n, i) => n + [1, 2, -3][i]));
  assert.equal(next.objects[0].track!.duration, before.objects[0].track!.duration);
  const history = new History(before); history.commit(next); assert.deepEqual(history.undo(), before); assert.deepEqual(history.redo(), next);
});

test('an invalid later operation rejects the whole edit without changing the source', () => {
  const before = createDocument(), frozen = serializeDocument(before);
  assert.throws(() => applySceneOperations(before, [{ type: 'translate', id: 'object-2', offset: [1, 0, 0] }, { type: 'remove_object', id: 'camera' }], 0));
  assert.equal(serializeDocument(before), frozen);
  for (const operations of [
    [{ type: 'translate', id: 'missing', offset: [1, 0, 0] }],
    [{ type: 'set_duration', duration: 1 }],
    [{ type: 'set_transform', id: 'object-1', pose: 'static', transform: before.objects[0].transform }],
    [{ type: 'set_transform', id: 'object-2', pose: 'static', transform: { ...before.objects[1].transform, scale: [-1, 1, 1] } }],
    [{ type: 'add_object', object: before.objects[0] }],
  ]) assert.throws(() => applySceneOperations(before, operations as SceneOperation[], 0));
});

test('retiming and removing motion preserve explicit motion semantics', () => {
  const before = createDocument(), expected = evaluateTransform(before.objects[0], 2);
  const frozen = applySceneOperations(before, [{ type: 'set_motion', id: 'object-1', track: null }], 2);
  assert.equal(frozen.objects[0].track, null); assert.deepEqual(frozen.objects[0].transform, expected);
  const track = structuredClone(before.objects[0].track!); track.start = 1; track.duration = 2;
  const next = applySceneOperations(before, [{ type: 'set_motion', id: 'object-1', track }], 0);
  assert.equal(next.objects[0].track!.start + next.objects[0].track!.duration, 3);
});

test('camera aim uses world look-at orientation and preserves its other endpoint', () => {
  const before = createDocument(), position: [number, number, number] = [4, 3, 7], target: [number, number, number] = [0, 1, 0];
  const next = applySceneOperations(before, [{ type: 'aim_camera', pose: 'end', position, target, fov: 50 }], 0);
  const forward = new Vector3(0, 0, -1).applyEuler(new Euler(...next.camera.track!.to.rotation.map(MathUtils.degToRad) as [number, number, number]));
  assert.ok(forward.distanceTo(new Vector3(...target).sub(new Vector3(...position)).normalize()) < 1e-8);
  assert.deepEqual(next.camera.track!.from, before.camera.track!.from); assert.equal(next.camera.fov, 50);
});

test('top-down framing fits all transformed bounds with X right and negative Z up', () => {
  for (const bounds of [new Box3(new Vector3(-8, -2, -1), new Vector3(20, 30, 3)), new Box3(new Vector3(-0.2, 0, -22), new Vector3(0.3, 0.1, 20))]) {
    const camera = topDownCamera(bounds), center = bounds.getCenter(new Vector3());
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const p = new Vector3(x, y, z).project(camera); assert.ok(Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && Math.abs(p.z) < 1);
    }
    assert.ok(center.clone().add(new Vector3(1, 0, 0)).project(camera).x > center.clone().project(camera).x);
    assert.ok(center.clone().add(new Vector3(0, 0, -1)).project(camera).y > center.clone().project(camera).y);
  }
});

test('scene edit input validates IDs, frame times and real inline PNG headers', () => {
  assert.equal(parseSceneEditInput(input()).scene.objects.length, 3);
  assert.equal(parseSceneEditInput({ ...input(), snapshots: [snapshot()] }).snapshots.length, 1);
  for (const value of [
    { ...input(), selectedId: 'missing' }, { ...input(), time: 7 },
    { ...input(), snapshots: [{ ...snapshot(), dataUrl: 'https://example.com/image.png' }] },
    { ...input(), snapshots: [{ ...snapshot(), width: 1024 }] },
    { ...input(), snapshots: [{ ...snapshot(), time: 1 }] },
    { ...input(), snapshots: [snapshot(), snapshot()] },
  ]) assert.throws(() => parseSceneEditInput(value));
});

test('scene workflow requests views only when needed, then uses them through the provider interface', async () => {
  let seen: StructuredRequest | undefined;
  const first = await proposeSceneEdit(input(), provider({ summary: 'Check the layout from above.', requestedViews: ['top_down'], operations: [] }));
  assert.equal(first.status, 'needs_views');
  const replacement: AIProvider = { name: 'Other provider', model: 'other-model', async generateObject(request) { seen = request; return plan(); } };
  const response = await proposeSceneEdit({ ...input(), snapshots: [snapshot()] }, replacement);
  assert.equal(response.status, 'ready'); assert.equal(response.provider, 'Other provider');
  assert.equal(seen!.content.filter(part => part.type === 'image').length, 1);
  assert.ok(!JSON.stringify(seen!.schema).includes('"oneOf"'), 'Muse strict output does not support oneOf');
  assert.ok(seen!.instructions.includes('DEGREES')); assert.ok(JSON.stringify(seen!.content).includes('object-2'));
  if (response.status === 'ready') assert.ok(Math.abs(applySceneOperations(input().scene, response.plan.operations, 0).objects[1].transform.position[0] - 0.9) < 1e-9);
});

test('invalid model operations, mixed tool/edit results and repeated view requests are rejected', async () => {
  for (const output of [
    { ...plan(), requestedViews: ['top_down'] },
    { ...plan(), operations: [{ type: 'translate', id: 'missing', offset: [1, 0, 0] }] },
    { ...plan(), operations: [{ type: 'execute_code', code: 'bad' }] },
  ]) await assert.rejects(proposeSceneEdit(input(), provider(output)), (error: unknown) => error instanceof AIError && error.code === 'invalid_edit');
  await assert.rejects(proposeSceneEdit({ ...input(), snapshots: [snapshot()] }, provider({ summary: 'Again', requestedViews: ['shot'], operations: [] })));
});

test('Meta image adapter sends input_image rather than video or client-side credentials', async () => {
  const meta = new MetaProvider({ apiKey: 'test-server-key', model: 'test-model' }, async (_url, options) => {
    const body = JSON.parse(String(options!.body));
    assert.equal(body.input[0].content[0].type, 'input_image'); assert.equal(body.input[0].content[0].image_url, snapshot().dataUrl);
    return Response.json({ status: 'completed', output_text: JSON.stringify(plan()) });
  });
  const result = await meta.generateObject({ instructions: 'Test', schema: {}, schemaName: 'test', content: [{ type: 'image', dataUrl: snapshot().dataUrl }] });
  assert.ok(!JSON.stringify(result).includes('test-server-key'));
});

test('scene API checks origin, malformed JSON and body limits before calling the model', async () => {
  let calls = 0; const handler = createSceneEditHandler({ MODEL_API_KEY: 'not-public' }, () => ({ ...provider(plan()), async generateObject() { calls++; return plan(); } }));
  assert.equal((await handler(request(input(), 'https://another.example'))).status, 403);
  assert.equal((await handler(request({}))).status, 400);
  assert.equal((await handler(request({ padding: 'x'.repeat(4_100_001) }))).status, 413);
  assert.equal(calls, 0);
  const response = await handler(request(input())); assert.equal(response.status, 200); assert.equal((await response.json()).status, 'ready'); assert.equal(calls, 1);
});

test('serialized scenes remain independent of the proposed changes', () => {
  const before = input().scene, editable = cloneDocument(before), parsed = editPlanSchema.parse(plan());
  const next = applySceneOperations(editable, parsed.operations, 0);
  next.objects[1].transform.position[0] = 999; assert.equal(before.objects[1].transform.position[0], 1.9);
});
