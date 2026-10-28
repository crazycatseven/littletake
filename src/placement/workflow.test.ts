import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { createObject, createEmptyScene, createCamera, createShot, evaluateTransform, History } from '../model';
import { createProject, parseProject, serializeProject } from '../project/storage';
import { projectContent, validateProjectContent } from '../project/model';
import { trackPoses } from '../performance/motion';
import { transformSelection } from './transforms';
import type { Transform } from '../types';

test('batch placement preserves complete motion, camera/shot independence, one-step undo and project reopen', () => {
  const scene = createEmptyScene(), first = createObject('human', 1), second = createObject('cube', 2), untouched = createObject('sphere', 3);
  const pose = (x: number, y = 0): Transform => ({ position: [x, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  first.transform = pose(-2); first.track = { start: 0, duration: 4, from: pose(-2), to: pose(2), samples: [{ at: .5, transform: pose(0, 1) }] };
  second.transform = pose(3); second.track = { start: 0, duration: 4, from: pose(3), to: pose(5) };
  scene.objects = [first, second, untouched]; const camera = createCamera('camera'); scene.cameras = [camera]; scene.shots = [createShot(camera, 'shot', 5)];
  const project = createProject(scene), original = structuredClone(projectContent(project)), history = new History(original);
  const delta = new Matrix4().makeTranslation(3, 2, -1).multiply(new Matrix4().makeRotationY(Math.PI / 2)).multiply(new Matrix4().makeScale(1.5, 1.5, 1.5));
  const apply = (value: Transform): Transform => {
    const matrix = new Matrix4().compose(new Vector3(...value.position), new Quaternion().setFromEuler(new Euler(...value.rotation.map(v => v * Math.PI / 180) as [number, number, number])), new Vector3(...value.scale));
    const p = new Vector3(), q = new Quaternion(), s = new Vector3(); delta.clone().multiply(matrix).decompose(p, q, s);
    const r = new Euler().setFromQuaternion(q);
    return { position: p.toArray(), rotation: [r.x, r.y, r.z].map(v => v * 180 / Math.PI) as [number, number, number], scale: s.toArray() };
  };
  const before = [first, second], edited = transformSelection(before, before.map(item => ({ id: item.id, transform: apply(evaluateTransform(item, 2)) })), 2, true);
  for (let i = 0; i < edited.length; i++) {
    const old = trackPoses(before[i].track!), next = trackPoses(edited[i].track!);
    for (let j = 0; j < next.length; j++) {
      const expected = apply(old[j]);
      next[j].position.forEach((value, axis) => assert.ok(Math.abs(value - expected.position[axis]) < 1e-8));
      next[j].scale.forEach((value, axis) => assert.ok(Math.abs(value - expected.scale[axis]) < 1e-8));
    }
    assert.equal(edited[i].track!.duration, before[i].track!.duration);
    Object.assign(scene.objects[i], edited[i]);
  }
  validateProjectContent(projectContent(project)); history.commit(projectContent(project));
  assert.deepEqual(history.undo(), original); assert.deepEqual(history.redo(), projectContent(project));
  assert.deepEqual(projectContent(parseProject(serializeProject(project))), JSON.parse(JSON.stringify(projectContent(project))));
  assert.deepEqual(scene.objects[2], original.scenes[0].objects[2]); assert.deepEqual(scene.cameras, original.scenes[0].cameras); assert.deepEqual(scene.shots, original.scenes[0].shots);
  // A pose at the playhead can fit while an off-screen sample exceeds the world limits.
  const safe = structuredClone(scene.objects.slice(0, 2));
  const bad = safe.map(item => ({ id: item.id, transform: { ...evaluateTransform(item, 2), position: [999, 0, 0] as [number, number, number] } }));
  safe[1].track!.to.position[0] = 1000;
  const unchanged = structuredClone(safe);
  assert.throws(() => transformSelection(safe, bad, 0, true)); assert.deepEqual(safe, unchanged);
});
