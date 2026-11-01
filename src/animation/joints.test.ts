import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MathUtils, Vector3 } from 'three';
import { assetGroupBounds, createAsset, createAssetGroup, disposeAssetGroup, poseAssetJoints, recipeBounds, validateAsset } from '../assets/model.ts';
import { instantiateAsset, saveObjectAsset } from '../assets/library.ts';
import { updateAssetInstances } from '../assets/edit.ts';
import { emptyConstruction, type Part } from '../assets/toolkit/schema.ts';
import { createEmptyScene, ensureAnimation, evaluateJointAngles, evaluateTransform } from '../model.ts';
import { createProject, parseProject, ProjectStorage, serializeProject } from '../project/storage.ts';
import { projectContent, validateProjectContent } from '../project/model.ts';
import { applyProjectOperations, type SceneOperation } from '../scene-edit/operations.ts';
import { duplicatePropertyKeys, emptyAnimation, evaluateProperty, jointProperty, movePropertyKeys, putKey, removePropertyKeys, replacePropertyKeys, setKeyInterpolation } from './model.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
function doubleDoor() {
  const part = (id: string, kind: Part['kind'], position: Part['position'], size: Part['size'], parentId: string | null = null): Part => ({
    id, name: id, kind, position, size, parentId, rotation: [0, 0, 0], color: '#86a494', joint: null,
  });
  const pivot = part('left', 'group', [-1, 0, 0], [1, 1, 1]);
  pivot.joint = { type: 'hinge', axis: 'y', pivot: [0, 0, 0], min: 0, max: 120 };
  const construction = emptyConstruction();
  construction.modifiers = [{ id: 'mirror', type: 'mirror', targetId: 'left', enabled: true, axes: ['x'], referenceId: null }];
  return createAsset({ name: 'Double door', description: 'Two independently articulated leaves', tags: ['door'], construction,
    parts: [pivot, part('leaf', 'cube', [.48, 1, 0], [.96, 2, .1], 'left'), part('handle', 'sphere', [.3, 0, .1], [.08, .08, .08], 'leaf')],
  }, 'double-door');
}

test('joint curves survive save/reopen, independent instances, mirrored parts and prefab reuse alongside root motion', () => {
  const asset = doubleDoor(), first = instantiateAsset(asset, 'first', [2, 0, 0], 5), second = instantiateAsset(asset, 'second', [-3, 0, 0], 5);
  const left = jointProperty('left'), right = jointProperty('left~mirror.x');
  first.jointAngles = { left: 15, 'left~mirror.x': 20 }; second.jointAngles = { left: 5, 'left~mirror.x': 65 };
  first.track = { start: .5, duration: 3, from: structuredClone(first.transform), to: { ...structuredClone(first.transform), position: [6, 0, 2] },
    samples: [{ at: .4, transform: { position: [3, .2, 1], rotation: [0, 35, 0], scale: [1, 1, 1] } }] };
  const before = structuredClone(first), animation = ensureAnimation(first);
  putKey(animation, left, 0, 0); putKey(animation, left, 2, 90);
  setKeyInterpolation(animation, [left], 0, 'smooth');
  putKey(animation, right, 1, 20); putKey(animation, right, 3, 100);
  setKeyInterpolation(animation, [right], 1, 'constant');
  close(evaluateJointAngles(first, .5).left, 90 * .15625);
  close(evaluateJointAngles(first, 1).left, 45); close(evaluateJointAngles(first, 2)['left~mirror.x'], 20);
  close(evaluateJointAngles(first, 3)['left~mirror.x'], 100);
  for (let frame = 0; frame <= 120; frame++) {
    const time = frame / 24, old = evaluateTransform(before, time), current = evaluateTransform(first, time);
    for (const group of ['position', 'rotation', 'scale'] as const) for (let i = 0; i < 3; i++) close(current[group][i], old[group][i]);
  }
  duplicatePropertyKeys(animation, [left], 2, 4); movePropertyKeys(animation, [left], 4, 4.5); removePropertyKeys(animation, [left], 4.5);
  const project = createProject(); project.assets = [asset]; project.scenes[0].objects = [first, second];
  const disk = new Map<string, string>(), storage = { getItem: (key: string) => disk.get(key) ?? null, setItem: (key: string, value: string) => { disk.set(key, value); } };
  const owner = new ProjectStorage(storage); owner.load(); owner.save(project);
  const reopened = new ProjectStorage(storage).load().project, [a, b] = reopened.scenes[0].objects;
  assert.deepEqual(a.animation, animation); assert.equal(a.track, null);
  assert.deepEqual(evaluateJointAngles(b, 2), second.jointAngles);
  putKey(ensureAnimation(a), left, 2, 110);
  assert.deepEqual(evaluateJointAngles(b, 2), second.jointAngles); close(evaluateJointAngles(first, 2).left, 90);
  const prefab = saveObjectAsset(a, [asset], 'saved-doors');
  reopened.assets!.push(prefab); const otherScene = createEmptyScene('scene-2', 'Other scene');
  const copy = instantiateAsset(prefab, 'copy', [12, 0, 0], 5); otherScene.objects.push(copy); reopened.scenes.push(otherScene);
  const imported = parseProject(serializeProject(reopened));
  close(evaluateJointAngles(imported.scenes[1].objects[0], 2).left, 110);
  close(evaluateTransform(copy, 2).position[0] - evaluateTransform(a, 2).position[0], 10);
  putKey(ensureAnimation(copy), right, 3, 50); close(evaluateJointAngles(a, 3)['left~mirror.x'], 100);
  const groupA = createAssetGroup(asset), groupB = createAssetGroup(asset), exported = groupA.clone(true);
  const angle = (root: typeof groupA, id: string) => { let value = NaN; root.traverse(node => { if (node.userData.partId === id) value = MathUtils.radToDeg(node.children[0].rotation.y); }); return value; };
  try {
    poseAssetJoints(groupA, asset, evaluateJointAngles(a, 2)); poseAssetJoints(groupB, asset, evaluateJointAngles(b, 2));
    close(angle(groupA, 'left'), 110); close(angle(groupB, 'left'), 5);
    poseAssetJoints(exported, asset, evaluateJointAngles(a, 0)); close(angle(exported, 'left'), 0); close(angle(groupA, 'left'), 110);
    poseAssetJoints(groupA, asset, { left: 90 }); close(angle(groupA, 'left~mirror.x'), 0);
    const openBounds = assetGroupBounds(groupA), localSize = openBounds.getSize(new Vector3());
    groupA.position.set(10, 3, -4); groupA.rotation.set(.2, .7, .4); groupA.scale.set(2, 3, .5);
    const movedBounds = assetGroupBounds(groupA); for (let i = 0; i < 3; i++) close(movedBounds.getSize(new Vector3()).toArray()[i], localSize.toArray()[i]);
    poseAssetJoints(groupA, asset, {}); close(angle(groupA, 'left'), 0);
    assert.ok(localSize.z > assetGroupBounds(groupA).getSize(new Vector3()).z + .5, 'posed bounds follow the leaf');
  } finally { disposeAssetGroup(groupA); disposeAssetGroup(groupB); }
  const revised = structuredClone(asset); revised.parts.find(part => part.id === 'leaf')!.color = '#cc9966';
  const updated = updateAssetInstances(imported, [revised]);
  assert.deepEqual(updated.project.scenes[0].objects, imported.scenes[0].objects);
  const removed = structuredClone(revised); removed.construction!.modifiers = []; removed.bounds = recipeBounds(removed);
  assert.throws(() => updateAssetInstances(imported, [removed]), /Invalid asset joint/);
  assert.deepEqual(imported.assets![0], asset, 'an incompatible library update must not overwrite the saved prefab');
  const variant={...structuredClone(revised),id:'blue-doors'},target=imported.scenes[0].objects[0];
  const swapped=applyProjectOperations(projectContent(imported),[{type:'set_asset',sceneId:imported.scenes[0].id,id:target.id,asset:variant}],2);
  assert.deepEqual(swapped.scenes[0].objects[0],{...target,asset:{id:variant.id}},'Replacing a prefab must retain every instance property and animated joint.');
  assert.deepEqual(swapped.scenes[0].objects[1],imported.scenes[0].objects[1]);
  const restored=parseProject(serializeProject({...imported,...swapped}));close(evaluateJointAngles(restored.scenes[0].objects[0],2).left,110);
  assert.throws(()=>applyProjectOperations(swapped,[{type:'set_asset',sceneId:imported.scenes[0].id,id:target.id,asset:{...removed,id:'incompatible'}}],2),/Invalid asset joint/);

});

test('shared key operations validate joint owners and ranges atomically and keep joint motion when replacing root motion', () => {
  const asset = doubleDoor(), project = createProject(), scene = project.scenes[0];
  project.assets = [asset]; scene.objects = [instantiateAsset(asset, 'door', [0, 0, 0], 5)];
  const left = jointProperty('left'), right = jointProperty('left~mirror.x');
  const staticPose: SceneOperation = { type: 'set_asset_joint', sceneId: scene.id, id: 'door', partId: 'left~mirror.x', angle: 35 };
  const key: SceneOperation = { type: 'set_property_key', sceneId: scene.id, id: 'door', path: left, time: 0, value: 0, interpolation: 'linear' };
  const edited = applyProjectOperations(projectContent(project), [staticPose, key, { ...key, time: 2, value: 90 }], 0);
  close(evaluateJointAngles(edited.scenes[0].objects[0], 1).left, 45); assert.equal(project.scenes[0].objects[0].animation, undefined);
  const frozen = JSON.stringify(edited), apply = (...ops: SceneOperation[]) => applyProjectOperations(edited, ops, 1);
  assert.throws(() => apply({ ...key, time: 2, value: 121 }), /Invalid asset joint/);
  assert.throws(() => apply({ ...key, path: 'jointAngles.missing' }), /Invalid asset joint/);
  assert.throws(() => apply({ ...key, path: 'jointAngles.leaf' }), /Invalid asset joint/);
  assert.throws(() => apply({ ...key, id: scene.cameras[0].id }), /cameras cannot animate asset joints/);
  assert.throws(() => apply({ ...staticPose, partId: 'left' }), /animated/);
  assert.throws(() => apply({ ...staticPose, angle: 75 }, { ...key, path: 'movement.speed' }), /Invalid keyframe/);
  assert.equal(JSON.stringify(edited), frozen, 'rejected batches must not partially change a scene');
  const invalid = structuredClone(edited); invalid.scenes[0].objects[0].animation!.curves[right] = [{ time: 2, value: -1, interpolation: 'linear' }];
  assert.throws(() => validateProjectContent(invalid), /Invalid asset joint/);
  const badTemplate = structuredClone(asset); badTemplate.template = { components: [], track: null, animation: emptyAnimation() };
  putKey(badTemplate.template.animation!, 'jointAngles.missing', 0, 1); assert.throws(() => validateAsset(badTemplate), /Invalid asset joint/);
  const from = structuredClone(edited.scenes[0].objects[0].transform), to = { ...structuredClone(from), position: [4, 0, 0] as [number, number, number] };
  const jointAnimation = edited.scenes[0].objects[0].animation!;
  jointAnimation.takes.push({ id: 'legacy-motion', start: 0, end: 2, source: 'legacy' });
  for (const key of jointAnimation.curves[left]!) key.take = 'legacy-motion';
  const sampledTrack = { start: 0, duration: 2, from, to, samples: [{ at: .5, transform: { ...structuredClone(from), position: [2, 0, 0] as [number, number, number] } }] };
  const moved = apply({ type: 'set_motion', sceneId: scene.id, id: 'door', track: sampledTrack });
  assert.equal(new Set(moved.scenes[0].objects[0].animation!.takes.map(take => take.id)).size, 2, 'sampled root motion must not merge with a joint take of the same ID');
  const prefab = saveObjectAsset(edited.scenes[0].objects[0], [asset], 'keyed-prefab');
  const withPrefab = apply({ type: 'instantiate_asset', sceneId: scene.id, id: 'new-door', name: 'New door', asset: prefab, transform: from, track: sampledTrack });
  close(evaluateJointAngles(withPrefab.scenes[0].objects[1], 1).left, 45);
  assert.equal(withPrefab.scenes[0].objects[1].track, null, 'an imported root track and prefab joints share one animation');
  const stopped = applyProjectOperations(moved, [{ type: 'set_motion', sceneId: scene.id, id: 'door', track: null }], 1);
  const object = stopped.scenes[0].objects[0]; close(evaluateTransform(object, 4).position[0], 2);
  close(evaluateJointAngles(object, 1).left, 45); close(evaluateJointAngles(object, 4)['left~mirror.x'], 35);
  close(evaluateProperty(object.animation, left, 0, 2), 90);

  // One operation carries a complete sampled channel, including more than 64 points.
  const beforeBulk = applyProjectOperations(moved, [
    { ...key, path: left, time: 4.5, value: 15 },
    { ...key, path: right, time: 0, value: 35 }, { ...key, path: right, time: 4, value: 75, interpolation: 'smooth' },
  ], 0);
  const batch: Extract<SceneOperation, { type: 'set_property_keys' }> = {
    type: 'set_property_keys', sceneId: scene.id, id: 'door', path: left,
    keys: Array.from({ length: 121 }, (_, i) => ({ time: i / 30, value: 45 + 30 * Math.sin(i * Math.PI / 15), interpolation: ['linear', 'constant', 'smooth'][i % 3] as 'linear' | 'constant' | 'smooth' })),
  };
  const sourceText = JSON.stringify(beforeBulk), sourceAnimation = beforeBulk.scenes[0].objects[0].animation!;
  const batched = applyProjectOperations(beforeBulk, [batch], 0), target = batched.scenes[0].objects[0];
  assert.deepEqual(target.animation!.curves[left], batch.keys, 'replace the whole selected channel without keeping obsolete points');
  assert.equal(target.animation!.curves[left]!.length, 121);
  for (const [path, keys] of Object.entries(sourceAnimation.curves)) if (path !== left) assert.deepEqual(target.animation!.curves[path as keyof typeof sourceAnimation.curves], keys);
  assert.deepEqual(target.transform, beforeBulk.scenes[0].objects[0].transform);
  assert.deepEqual(target.jointAngles, beforeBulk.scenes[0].objects[0].jointAngles);
  assert.deepEqual(target.animation!.takes, sourceAnimation.takes.filter(take => take.id !== 'legacy-motion'), 'retire only the take belonging to the replaced channel');
  for (let frame = 0; frame <= 120; frame++) {
    assert.deepEqual(evaluateTransform(target, frame / 30), evaluateTransform(beforeBulk.scenes[0].objects[0], frame / 30));
  }
  const outOfRange = structuredClone(batch); outOfRange.keys[120].value = 121;
  assert.throws(() => applyProjectOperations(beforeBulk, [{ type: 'set_color', sceneId: scene.id, id: 'door', color: '#ff0000' }, outOfRange], 0), /Invalid asset joint/);
  const duplicate = structuredClone(batch); duplicate.keys[100].time = duplicate.keys[99].time;
  assert.throws(() => applyProjectOperations(beforeBulk, [duplicate], 0), /strictly increasing/);
  const outOfScene = structuredClone(batch); outOfScene.keys[120].time = 6;
  assert.throws(() => applyProjectOperations(beforeBulk, [outOfScene], 0), /Invalid keys/);
  assert.equal(JSON.stringify(beforeBulk), sourceText, 'invalid late keys must leave neither a partial curve nor earlier operations');
  const brokenScalar = structuredClone(batch.keys); brokenScalar[100].value = 361;
  const animationText = JSON.stringify(sourceAnimation);
  assert.throws(() => replacePropertyKeys(sourceAnimation, left, brokenScalar, scene.duration), /outside the supported range/);
  assert.equal(JSON.stringify(sourceAnimation), animationText, 'the curve-level helper is atomic too');
  const locallyEdited = applyProjectOperations(batched, [{ ...key, time: 4.5, value: 80 }], 0);
  assert.equal(locallyEdited.scenes[0].objects[0].animation!.curves[left]!.length, 122, 'a single-key edit keeps the rest of the batch');
  assert.deepEqual(locallyEdited.scenes[0].objects[0].animation!.curves[right], target.animation!.curves[right]);
  const receiptProject = createProject(locallyEdited.scenes[0]); receiptProject.assets = locallyEdited.assets;
  receiptProject.conversations.threads[0].messages.push({ id: 'reply', role: 'assistant', text: 'Open the door.', model: 'test',
    edit: { sceneId: scene.id, shotId: scene.shots[0].id, revision: 0, status: 'applied', time: 0, operations: [staticPose, key, batch] } });
  const saved = serializeProject(receiptProject);
  assert.deepEqual(parseProject(saved), JSON.parse(saved));
});
