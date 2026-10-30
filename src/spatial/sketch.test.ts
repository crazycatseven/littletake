import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, MathUtils, Vector3 } from 'three';
import { movement } from '../components/model.ts';
import { createEmptyScene, createObject, evaluateTransform } from '../model.ts';
import { validateProjectContent } from '../project/model.ts';
import { applyProjectOperations } from '../scene-edit/operations.ts';
import type { SceneObject, Vec3 } from '../types.ts';
import { pathLength, simplifyPath, sketchedPath } from './sketch.ts';

const near = (a: number, b: number, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const facing = (rotation: Vec3) => new Vector3(0, 0, 1).applyEuler(new Euler(...rotation.map(MathUtils.degToRad) as Vec3, 'XYZ'));

function stroke(): Vec3[] {
  // A hand-drawn L: 4 m along +X with jitter, then 3 m along -Z, sampled every few centimetres.
  const points: Vec3[] = [];
  for (let x = 0; x <= 4; x += .05) points.push([x, 0, Math.sin(x * 40) * .01]);
  for (let z = -.05; z >= -3; z -= .05) points.push([4 + Math.sin(z * 40) * .01, 0, z]);
  return points;
}

test('a jittery floor stroke keeps its corner and stays within the operation point limit', () => {
  const simple = simplifyPath(stroke());
  assert.ok(simple.length >= 3 && simple.length <= 8, `${simple.length} points`);
  assert.deepEqual(simple[0], [0, 0, 0]);
  assert.ok(simple.some(([x, , z]) => Math.abs(x - 4) < .06 && Math.abs(z) < .06), 'corner kept');
  near(pathLength(simple), 7, .1);
  const wiggle: Vec3[] = Array.from({ length: 1000 }, (_, i) => [i * .01, 0, (i % 2) * .5]);
  const capped = simplifyPath(wiggle);
  assert.equal(capped.length, 120);
  assert.deepEqual(capped[0], wiggle[0]); assert.deepEqual(capped.at(-1), wiggle.at(-1));
  assert.deepEqual(simplifyPath([[0, 0, 0], [0, 0, 0], [1, 0, 0]]), [[0, 0, 0], [1, 0, 0]]);
});

test('a drawn path becomes walking motion that faces along the path, from the playhead, within the scene', () => {
  const scene = createEmptyScene('street', 'Street'); scene.duration = 10;
  const actor: SceneObject = { ...createObject('human', 1), id: 'actor', name: 'Actor', components: [movement('walk', 1.4)], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } };
  const crate: SceneObject = { ...createObject('cube', 2), id: 'crate', name: 'Crate', transform: { position: [5, .5, 5], rotation: [0, 0, 0], scale: [1, 1, 1] } };
  scene.objects = [actor, crate];
  const project = validateProjectContent({ name: 'Paths', scenes: [scene] });

  const walk = sketchedPath(project.scenes[0], project.scenes[0].objects[0], stroke(), 1);
  assert.equal(walk.operation.type, 'follow_path');
  if (walk.operation.type !== 'follow_path') return;
  assert.equal(walk.operation.start, 1); near(walk.operation.duration, walk.length / 1.4); assert.equal(walk.fitted, false);
  assert.equal(walk.operation.replaceMotion, false);
  const walked = applyProjectOperations(project, [walk.operation], 1).scenes[0].objects[0];
  // Before the corner the actor walks along +X and faces it; after it, along -Z.
  const before = evaluateTransform(walked, 1 + 2 / 1.4), after = evaluateTransform(walked, 1 + 5.5 / 1.4);
  near(before.position[0], 2, .05); near(before.position[1], 0); near(facing(before.rotation).x, 1, .01);
  near(after.position[2], -1.5, .1); near(facing(after.rotation).z, -1, .01);
  near(evaluateTransform(walked, 10).position[0], 4, .06); near(evaluateTransform(walked, 10).position[2], -3, .06);

  // A raised object keeps its own origin height; a long path is sped up to end with the scene.
  const long = stroke().map(([x, y, z]) => [x * 4, y, z * 4] as Vec3);
  const drive = sketchedPath(project.scenes[0], project.scenes[0].objects[1], long, 9.8);
  if (drive.operation.type !== 'follow_path') return;
  assert.equal(drive.operation.start, 0, 'too close to the end: starts from the beginning');
  near(drive.operation.duration, 10); assert.equal(drive.fitted, true);
  assert.ok(drive.operation.points.every(point => point[1] === .5));

  // Redrawing replaces the existing motion explicitly; tiny strokes are rejected.
  const again = sketchedPath(applyProjectOperations(project, [walk.operation], 1).scenes[0], walked, stroke(), 0);
  if (again.operation.type !== 'follow_path') return;
  assert.equal(again.operation.replaceMotion, true);
  assert.throws(() => sketchedPath(project.scenes[0], actor, [[0, 0, 0], [.05, 0, 0]], 0), /longer path/);
});
