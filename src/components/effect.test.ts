import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyScene, createObject } from '../model.ts';
import { applyProjectOperations } from '../scene-edit/operations.ts';
import { effectObjectIds } from './model.ts';

function fixture() {
  const scene = createEmptyScene('set');
  const dragon = createObject('cube', 1); dragon.id = 'dragon';
  const fire = createObject('cone', 2); fire.id = 'fire'; fire.name = 'Fire Breath';
  const ember = createObject('sphere', 3); ember.id = 'ember'; ember.parentId = 'fire';
  scene.objects = [dragon, fire, ember];
  return { project: { name: 'Effects', scenes: [scene] }, sceneId: scene.id };
}

test('set_effect marks an object and its children as effects, and null clears it', () => {
  const { project, sceneId } = fixture();
  const marked = applyProjectOperations(project, [{ type: 'set_effect', sceneId, id: 'fire', effect: 'fire' }], 0);
  const fire = marked.scenes[0].objects.find(object => object.id === 'fire')!;
  assert.deepEqual(fire.components, [{ type: 'effect', enabled: true, kind: 'fire' }]);
  assert.deepEqual([...effectObjectIds(marked.scenes[0])].sort(), ['ember', 'fire']);
  const retyped = applyProjectOperations(marked, [{ type: 'set_effect', sceneId, id: 'fire', effect: 'smoke' }], 0);
  assert.deepEqual(retyped.scenes[0].objects.find(object => object.id === 'fire')!.components, [{ type: 'effect', enabled: true, kind: 'smoke' }]);
  const cleared = applyProjectOperations(retyped, [{ type: 'set_effect', sceneId, id: 'fire', effect: null }], 0);
  assert.equal(cleared.scenes[0].objects.find(object => object.id === 'fire')!.components, undefined);
  assert.equal(effectObjectIds(cleared.scenes[0]).size, 0);
});

test('a disabled effect component does not count as an effect', () => {
  const { project } = fixture();
  project.scenes[0].objects[1].components = [{ type: 'effect', enabled: false, kind: 'fire' }];
  assert.equal(effectObjectIds(project.scenes[0]).size, 0);
});

test('set_effect keeps other components and refuses cameras', () => {
  const { project, sceneId } = fixture();
  project.scenes[0].objects[1].components = [{ type: 'pivot', enabled: true, offset: [0, 1, 0] }];
  const marked = applyProjectOperations(project, [{ type: 'set_effect', sceneId, id: 'fire', effect: 'spark' }], 0);
  assert.deepEqual(marked.scenes[0].objects[1].components?.map(component => component.type), ['pivot', 'effect']);
  const camera = { ...project.scenes[0] };
  assert.throws(() => applyProjectOperations({ ...project, scenes: [{ ...camera, cameras: [{ id: 'cam', name: 'Cam', fov: 40, transform: { position: [0, 1, 5], rotation: [0, 0, 0], scale: [1, 1, 1] }, track: null }] }] },
    [{ type: 'set_effect', sceneId, id: 'cam', effect: 'fire' }], 0), /Only a scene object/);
});
