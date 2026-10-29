import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Euler, MathUtils, Vector3 } from 'three';
import { createAsset } from '../assets/model.ts';
import { emptyConstruction, type Part } from '../assets/toolkit/schema.ts';
import { createCamera, createEmptyScene, createObject, evaluateTransform, History } from '../model.ts';
import { validateProjectContent } from '../project/model.ts';
import { createProject, parseProject, serializeProject } from '../project/storage.ts';
import { applyProjectOperations } from '../scene-edit/operations.ts';
import { newDiagnostic } from '../scene-edit/diagnostics.ts';
import type { ProjectContent, SceneObject, Transform, Vec3 } from '../types.ts';
import { createSpatialHandler } from '../../server/spatial/api.ts';
import { AssetLibrary } from '../../server/assets/library.ts';
import { MetaProvider } from '../../server/ai/meta.ts';
import { proposeSceneEdit } from '../../server/scene-edit.ts';
import { inspectSpatial, solveSpatial } from './methods.ts';
import type { SpatialOperation } from './schema.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
const vectorNear = (a: number[], b: number[]) => a.forEach((value, i) => near(value, b[i]));
const world = { kind: 'world' } as const;
const common = { sceneId: 'lobby', time: 0, scope: 'static' } as const;
const pose = (position: Vec3, rotation: Vec3 = [0, 0, 0], scale: Vec3 = [1, 1, 1]): Transform => ({ position, rotation, scale });
function fixture(): ProjectContent {
  const part = (id: string, position: Vec3, size: Vec3): Part => ({ id, name: id, kind: 'cube', position, size, rotation: [0, 0, 0], color: '#865b3d', parentId: null, joint: null });
  const construction = emptyConstruction(); construction.anchors.push({ id: 'surface', name: 'Table surface', partId: 'top', position: [0, .1, 0] });
  const asset = createAsset({ name: 'Table', description: 'Table with a top and four feet', tags: ['table'], construction,
    parts: [part('top', [0, 1, 0], [4, .2, 2]), part('tall_edge_post', [1.7, 1.75, .7], [.15, 1.5, .15]),
      ...[-1, 1].flatMap(x => [-1, 1].map(z => part(`leg_${x < 0 ? 'l' : 'r'}_${z < 0 ? 'b' : 'f'}`, [x * 1.7, .45, z * .7], [.15, .9, .15])))] }, 'table_asset');
  const scene = createEmptyScene('lobby', 'Lobby'); scene.duration = 8;
  const table: SceneObject = { id: 'table', name: 'Table', kind: 'asset', color: '#ffffff', asset: { id: asset.id, version: asset.version }, track: null, transform: pose([3, 0, 2], [0, 45, 0], [1.2, 1, .8]) };
  const object = (id: string, position: Vec3, scale: Vec3 = [1, 1, 1]) => ({ ...createObject('cube', 1), id, name: id, transform: pose(position, [0, 0, 0], scale) });
  scene.objects = [table, object('vase', [0, 4, 0], [.25, .5, .25]), object('chair', [0, .5, -2]),
    object('a', [-4, .5, -5]), object('b', [0, 1, -5], [2, 2, 1]), object('c', [5, .25, -5], [.5, .5, 1]),
    { ...createObject('human', 1), id: 'actor', name: 'Actor', transform: pose([0, 0, 0]) }];
  const camera = createCamera('camera'); camera.transform = pose([0, 2, 8], [0, 90, 0]); scene.cameras = [camera];
  const other = createEmptyScene('other', 'Other location'); other.objects = [object('table', [0, .5, 0])];
  return validateProjectContent({ name: 'Spatial integration', scenes: [scene, other], assets: [asset] });
}
const objectIn = (project: ProjectContent, id: string) => project.scenes[0].objects.find(object => object.id === id)!;
const measure = (project: ProjectContent, ids: string[], frame = world) => inspectSpatial(project, { sceneId: 'lobby', time: 0, objectIds: ids, frame });

test('spatial API edits a rotated prefab set, preserves sampled motion, reloads and undoes atomically', async () => {
  const source = fixture(), frozen = JSON.stringify(source), api = createSpatialHandler();
  const onTable: SpatialOperation = { ...common, type: 'place_on', id: 'vase', supportId: 'table', horizontal: 'center', clearance: .015 };
  const response = await api(new Request('http://localhost/api/spatial', { method: 'POST', body: JSON.stringify({ action: 'solve', project: source, operation: onTable }) }));
  assert.equal(response.status, 200); const solved = await response.json(); assert.equal(solved.applied, false); assert.ok(solved.result.observations.contact.hits > 0);
  let current = applyProjectOperations(source, [onTable], 0);
  assert.deepEqual(objectIn(current, 'vase').transform, solved.result.updates[0].transform);
  near(measure(current, ['vase']).objects[0].bounds.min[1], 1.115);
  near(measure(current, ['table']).objects[0].bounds.max[1], 2.5); // The post must not become the vase's support surface.
  current = applyProjectOperations(current, [{ ...common, type: 'align_objects', objectIds: ['chair'], referenceId: 'table', frame: { kind: 'object', id: 'table' }, axis: 'x', edge: 'center' },
    { ...common, type: 'place_relative', id: 'chair', referenceId: 'table', frame: { kind: 'object', id: 'table' }, side: 'front', gap: .4 },
    { ...common, type: 'face_target', id: 'chair', targetId: 'table', forward: '+z' },
    { ...common, type: 'place_relative', id: 'chair', referenceId: 'table', frame: { kind: 'object', id: 'table' }, side: 'front', gap: .4 },
    { ...common, type: 'place_on', id: 'chair', supportId: null, horizontal: 'keep', clearance: 0 },
  ], 0);
  const framed = inspectSpatial(current, { sceneId: 'lobby', time: 0, objectIds: ['table', 'chair'], frame: { kind: 'object', id: 'table' } });
  near(framed.relations[0].positiveEdgeGaps[2], .4);
  near(measure(current, ['chair']).objects[0].bounds.min[1], 0);
  const chair = objectIn(current, 'chair'), direction = new Vector3(0, 0, 1).applyEuler(new Euler(...chair.transform.rotation.map(MathUtils.degToRad) as Vec3));
  const toTable = new Vector3(...objectIn(current, 'table').transform.position).sub(new Vector3(...chair.transform.position)).setY(0).normalize();
  near(direction.dot(toTable), 1);
  current = applyProjectOperations(current, [{ ...common, type: 'place_relative', id: 'a', referenceId: 'table', frame: { kind: 'camera', id: 'camera' }, side: 'left', gap: .3 }], 0);
  const cameraQuery = inspectSpatial(current, { sceneId: 'lobby', time: 0, objectIds: ['a', 'table'], frame: { kind: 'camera', id: 'camera' } });
  near(cameraQuery.relations[0].positiveEdgeGaps[0], .3);
  current = applyProjectOperations(current, [{ ...common, type: 'align_objects', objectIds: ['a', 'b', 'c'], referenceId: 'a', frame: world, axis: 'y', edge: 'min' },
    { ...common, type: 'distribute_objects', objectIds: ['c', 'a', 'b'], frame: world, axis: 'x', spacing: 'gaps' }], 0);
  const row = measure(current, ['a', 'b', 'c']);
  row.objects.forEach(object => near(object.bounds.min[1], row.objects[0].bounds.min[1]));
  near(row.objects[1].bounds.min[0] - row.objects[0].bounds.max[0], row.objects[2].bounds.min[0] - row.objects[1].bounds.max[0]);
  current = applyProjectOperations(current, [{ ...common, type: 'attach_anchor', id: 'vase', anchor: '@bottom', targetId: 'table', targetAnchor: 'surface', offset: [0, .02, 0], frame: world }], 0);
  const anchored = measure(current, ['vase', 'table']);
  vectorNear(anchored.objects[0].anchors['@bottom'], new Vector3(...anchored.objects[1].anchors.surface as Vec3).add(new Vector3(0, .02, 0)).toArray());
  const supportingTable = anchored.objects[0].support.surfacesBelow.find(surface => surface.id === 'table');
  assert.ok(supportingTable); near(supportingTable.minGap, .02);
  const pathOperation: SpatialOperation = { type: 'follow_path', sceneId: 'lobby', time: 0, id: 'actor', start: 1, duration: 4,
    points: [[0, 0, 0], [2, 0, 0], [2, 0, 2]], orientation: 'tangent', forward: '+z', replaceMotion: false };
  current = applyProjectOperations(current, [pathOperation], 0);
  const actor = structuredClone(objectIn(current, 'actor'));
  vectorNear(evaluateTransform(actor, 2).position, [1, 0, 0]); vectorNear(evaluateTransform(actor, 4).position, [2, 0, 1]);
  assert.equal(actor.track!.samples!.length, 2);
  for (const [time, expected] of [[2, [1, 0, 0]], [4, [0, 0, 1]]] as [number, Vec3][]) {
    const facing = new Vector3(0, 0, 1).applyEuler(new Euler(...evaluateTransform(actor, time).rotation.map(MathUtils.degToRad) as Vec3));
    vectorNear(facing.toArray(), expected);
  }
  const motionEdit: SpatialOperation = { ...common, time: 2, type: 'face_target', id: 'actor', targetId: 'table', forward: '+z', scope: 'whole_motion' };
  current = applyProjectOperations(current, [motionEdit, { type: 'translate', sceneId: 'lobby', id: 'actor', offset: [1, 0, 1] }], 2);
  const moved = objectIn(current, 'actor'); assert.equal(moved.track!.start, actor.track!.start); assert.equal(moved.track!.duration, actor.track!.duration);
  assert.equal(moved.track!.samples!.length, actor.track!.samples!.length);
  for (const time of [1, 2, 3, 4]) near(new Vector3(...evaluateTransform(moved, time).position).distanceTo(new Vector3(...evaluateTransform(moved, time + 1).position)), 1);
  assert.deepEqual(current.scenes[1], source.scenes[1]); assert.deepEqual(current.assets, source.assets); assert.equal(JSON.stringify(source), frozen);
  const saved = { ...createProject(current.scenes[0]), ...current }, restored = parseProject(serializeProject(saved));
  assert.deepEqual(restored.scenes, current.scenes); assert.deepEqual(restored.assets, current.assets);
  vectorNear(evaluateTransform(objectIn(restored, 'actor'), 4).position, evaluateTransform(moved, 4).position);
  const history = new History(source); history.commit(current); assert.deepEqual(history.undo(), source); assert.deepEqual(history.redo(), current);
  const before = JSON.stringify(current);
  assert.throws(() => applyProjectOperations(current, [{ ...common, type: 'place_relative', id: 'vase', referenceId: 'table', side: 'left', frame: world, gap: 1 },
    { ...common, type: 'place_on', id: 'actor', supportId: null, horizontal: 'keep', clearance: 0 }], 0), /animated/);
  assert.throws(() => applyProjectOperations(current, [pathOperation], 0), /replaceMotion/);
  assert.throws(() => solveSpatial(source, { ...onTable, horizontal: 'keep' }), /No upward support/);
  assert.throws(() => solveSpatial(source, { ...common, type: 'place_relative', id: 'vase', referenceId: 'table', side: 'front', gap: 1, frame: { kind: 'camera', id: 'table' } }), /wrong kind/);
  assert.equal(JSON.stringify(current), before);
  const bad = await api(new Request('http://localhost/api/spatial', { method: 'POST', body: JSON.stringify({ action: 'solve', project: source, operation: { ...onTable, supportId: 'missing' } }) }));
  assert.equal(bad.status, 400); assert.equal((await bad.json()).applied, false);
});

test('native Muse tools inspect and solve a new scene with a library asset, then apply only the final reviewed plan', async () => {
  const source: ProjectContent = { name: 'Empty project', scenes: [] }, original = JSON.stringify(source);
  const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), 'littletake-spatial-'))), diagnostic = newDiagnostic();
  let round = 0, prefix: unknown[] = [], spatial: SpatialOperation;
  const transport = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string), outputs = body.input.filter((item: any) => item.type === 'function_call_output').map((item: any) => JSON.parse(item.output));
    assert.ok(body.tools.some((tool: any) => tool.name === 'inspect_spatial')); assert.ok(body.tools.some((tool: any) => tool.name === 'preview_spatial'));
    const call = (name: string, arguments_: unknown) => Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'spatial_' + round, name, arguments: JSON.stringify(arguments_), status: 'completed' }] });
    round++;
    if (round === 1) return call('read_asset', { assetId: 'builtin-chair', version: 1 });
    if (round === 2) return call('instantiate_asset', { assetId: 'builtin-chair', version: 1, sceneId: 'new_set', name: 'Chair', transform: pose([2, 8, 0]) });
    if (round === 3) {
      prefix = [{ type: 'add_scene', sceneId: 'new_set', name: 'New set', duration: 5 }, outputs[1].operation];
      return call('inspect_spatial', { sceneId: 'new_set', time: 0, objectIds: [outputs[1].objectId], frame: world, precedingOperations: prefix });
    }
    if (round === 4) {
      assert.equal(outputs[2].ok, true); assert.equal(outputs[2].applied, false); near(outputs[2].objects[0].bounds.min[1], 8);
      spatial = { type: 'place_on', sceneId: 'new_set', time: 0, scope: 'static', id: outputs[1].objectId, supportId: null, horizontal: 'keep', clearance: 0 };
      return call('preview_spatial', { operation: { ...spatial, supportId: 'missing' }, precedingOperations: prefix });
    }
    if (round === 5) {
      assert.equal(outputs[3].ok, false); assert.match(outputs[3].error, /Unknown object/);
      return call('preview_spatial', { operation: spatial!, precedingOperations: prefix });
    }
    assert.equal(outputs[4].ok, true); assert.equal(outputs[4].applied, false); near(outputs[4].updates[0].transform.position[1], 0);
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Prepared the grounded chair.', requestedViews: [], objectCounts: [], operations: [...prefix, outputs[4].operation] }) }] }] });
  }) as typeof fetch;
  const response = await proposeSceneEdit({ project: source, sceneId: null, shotId: null, selectedId: null, prompt: 'Build a new set with a chair on the ground.', time: 0, snapshots: [] },
    new MetaProvider({ apiKey: 'test-only-placeholder', model: 'test' }, transport), undefined, diagnostic, library);
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') return;
  assert.equal(round, 6); assert.equal(JSON.stringify(source), original);
  const result = applyProjectOperations(source, response.plan.operations, 0);
  const measured = inspectSpatial(result, { sceneId: 'new_set', time: 0, objectIds: [result.scenes[0].objects[0].id], frame: world });
  near(measured.objects[0].bounds.min[1], 0); assert.equal(result.assets!.length, 1);
  assert.deepEqual(diagnostic.toolCalls!.map(call => call.name), ['read_asset', 'instantiate_asset', 'inspect_spatial', 'preview_spatial', 'preview_spatial']);
  assert.equal(diagnostic.outcome, 'ready'); assert.ok(diagnostic.toolCalls!.find(call => call.error));
});
