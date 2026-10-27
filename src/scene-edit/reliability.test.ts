import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from '../model.ts';
import { createSceneEditHandler } from '../../server/scene-edit-api.ts';
import { MetaProvider } from '../../server/ai/meta.ts';
import { applyProjectOperations } from './operations.ts';
import { objectCountRequirements } from '../../server/scene-edit-constraints.ts';

const request = (body: unknown) => new Request('http://localhost/api/scene-edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const input = () => ({ project: { name: 'Regression', scenes: [{ ...createDocument(), id: 'lobby24' }] },
  sceneId: 'lobby24', shotId: 'shot-1', selectedId: 'object-2', time: 0, snapshots: [], prompt: '删除一个物体，让大厅剩 2 个物体。' });
const output = (operations: unknown[], objectCounts: unknown[] = []) => ({ summary: '修改预览', requestedViews: [], operations, objectCounts });

test('a captured wrong scene-removal plan is retained, corrected once and applied atomically across scenes', async () => {
  const source = input(), before = structuredClone(source.project); let calls = 0;
  const wrong = { operations: [{ sceneId: 'lobby24', type: 'remove_scene' }, { sceneId: 'lobby24', type: 'remove_scene' }], requestedViews: [], summary: 'x' };
  const handler = createSceneEditHandler({}, () => new MetaProvider({ apiKey: 'secret-test-key', model: 'test' }, async (_url, options) => {
    const body = JSON.parse(String(options!.body)); calls++;
    assert.equal(body.text.format.type, 'json_object');
    assert.ok(body.instructions.includes('remove_object'));
    if (calls === 2) {
      const feedback = JSON.parse(body.input.at(-1).content.at(-1).text);
      assert.match(feedback.validationFeedback, /Operation 2.*Earlier operations removed this scene/);
      assert.deepEqual(feedback.rejectedProposal, wrong);
    }
    return Response.json({ status: 'completed', output_text: JSON.stringify(calls === 1 ? wrong : output([
      { type: 'remove_object', sceneId: 'lobby24', id: 'object-2' },
      { type: 'add_scene', sceneId: 'corridor', name: '走廊', duration: 4 },
    ], [{ sceneId: 'lobby24', source: '剩 2 个物体', comparison: 'exactly', count: 2 }])) });
  }));
  const response = await handler(request(source)), result = await response.json();
  assert.equal(response.status, 200); assert.equal(calls, 2);
  assert.equal(result.diagnostic.attempts.length, 2);
  assert.deepEqual(result.diagnostic.input, source);
  assert.deepEqual(result.diagnostic.attempts[0].rawProposal, wrong);
  assert.equal(JSON.parse(result.diagnostic.attempts[0].rawOutput).summary, 'x');
  assert.ok(!JSON.stringify(result).includes('secret-test-key'));
  assert.deepEqual(source.project, before);
  const after = applyProjectOperations(source.project, result.plan.operations, 0);
  assert.equal(after.scenes[0].objects.length, 2); assert.equal(after.scenes[1].id, 'corridor');
  assert.deepEqual(after.scenes[0].cameras, before.scenes[0].cameras);
  assert.deepEqual(after.scenes[0].shots, before.scenes[0].shots);
  assert.deepEqual(after.scenes[0].objects[0].track, before.scenes[0].objects[0].track);
});

test('explicit counts reject extra primitives and omitted checks; corrections cannot evade the budget', async () => {
  assert.deepEqual(objectCountRequirements('当前有 11 个物体，删除盆与植物，让大厅剩 9 个物体。走廊最多三个物体。Exactly 4 objects.'), [
    { source: '最多三个物体', comparison: 'at_most', count: 3 },
    { source: '剩 9 个物体', comparison: 'exactly', count: 9 },
    { source: 'Exactly 4 objects', comparison: 'exactly', count: 4 },
  ]);
  const source = input(); source.prompt = '保持最多 3 个物体。';
  const extra = { type: 'add_object', sceneId: 'lobby24', object: { ...source.project.scenes[0].objects[1], id: 'decoration' } };
  const checks = [{ sceneId: 'lobby24', source: '最多 3 个物体', comparison: 'at_most', count: 3 }];
  let calls = 0;
  const handler = createSceneEditHandler({}, () => ({ name: 'Test', model: 'test', async generateObject() {
    calls++; return calls === 1 ? output([extra], checks) : output([extra]);
  } }));
  const result = await (await handler(request(source))).json();
  assert.equal(calls, 2); assert.equal(result.error.code, 'invalid_edit');
  assert.match(result.diagnostic.attempts[0].error.message, /has 4 objects/);
  assert.match(result.diagnostic.attempts[1].error.message, /Missing object count check/);
  assert.equal(result.diagnostic.outcome, 'failed');
  assert.equal(source.project.scenes[0].objects.length, 3);
});

test('an unreadable model reply and its error survive without exposing credentials or issuing a retry', async () => {
  let calls = 0;
  const handler = createSceneEditHandler({}, () => new MetaProvider({ apiKey: 'never-export-this', model: 'test' }, async () => {
    calls++; return Response.json({ status: 'completed', output_text: '{"summary":"unfinished' });
  }));
  const result = await (await handler(request(input()))).json();
  assert.equal(calls, 1); assert.equal(result.error.code, 'invalid_response');
  assert.equal(result.diagnostic.attempts[0].rawOutput, '{"summary":"unfinished');
  assert.equal(result.diagnostic.attempts[0].error.code, 'invalid_response');
  assert.ok(!JSON.stringify(result).includes('never-export-this'));
});
