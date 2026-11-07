import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { parseProject } from '../../src/project/storage.ts';
import { createCamera, createEmptyScene, createObject } from '../../src/model.ts';
import type { ProjectContent } from '../../src/types.ts';
import { checkVisibility, inspectParts } from './geometry.ts';

const knightProject = (): ProjectContent => {
  const project = parseProject(readFileSync(new URL('../../public/examples/knight-vs-dragon.json', import.meta.url), 'utf8'));
  return { name: project.name, scenes: project.scenes, assets: project.assets };
};

test('a part posed by its own joint reports the posed forward direction', () => {
  const project = knightProject(), scene = project.scenes[0], knight = scene.objects.find(object => object.id === 'knight')!;
  const curve = knight.animation!.curves['jointAngles.left-forearm']!, key = curve.find(item => Math.abs(item.value) > 30)!;
  const posed = inspectParts(project, scene.id, 'knight', key.time, [{ partId: 'left-forearm' }]).parts[0] as { forward: number[] };
  delete knight.animation!.curves['jointAngles.left-forearm'];
  const rest = inspectParts(project, scene.id, 'knight', key.time, [{ partId: 'left-forearm' }]).parts[0] as { forward: number[] };
  const angle = new Vector3(...posed.forward).angleTo(new Vector3(...rest.forward)) * 180 / Math.PI;
  assert.ok(Math.abs(angle - Math.abs(key.value)) < 2, `the forearm turned ${key.value} degrees but the report moved ${angle.toFixed(1)}`);
});

test('a face that fills the frame counts as in frame even when all its corners are outside it', () => {
  const scene = createEmptyScene('wall'), wall = createObject('cube', 1), camera = createCamera('camera', 'Camera');
  wall.id = 'wall'; wall.name = 'Wall'; wall.transform = { position: [0, 0, -15], rotation: [0, 0, 0], scale: [40, 40, 20] };
  camera.transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }; camera.fov = 40;
  scene.objects = [wall]; scene.cameras = [camera]; scene.shots = [{ id: 'shot', name: 'Shot', cameraId: camera.id, start: 0, duration: 2 }];
  const result = checkVisibility({ name: 'Wall', scenes: [scene] }, scene.id, 0, 'wall', { cameraId: camera.id });
  assert.ok(result.inFrame > 0 && result.visible > 0, JSON.stringify(result));
  assert.ok(result.screenCoverage > .99, JSON.stringify(result));
  assert.ok(result.visibleBox && result.visibleBox[0] < .05 && result.visibleBox[1] < .05 && result.visibleBox[2] > .95 && result.visibleBox[3] > .95, JSON.stringify(result.visibleBox));
});
