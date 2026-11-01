import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { XRKeyframeReader, XRKeyframeMultiSelection, keyframeAtTimeline, xrTimelineSvg, deleteXRKeyframe, deleteXRKeyframes } from './timeline';
import { History } from '../model';
import { XRKeyframeGhosts } from './keyframe-ghosts';
import type { SceneObject } from '../types';

function object(): SceneObject {
  return { id: 'cube', name: 'Cube <one>', kind: 'cube', color: '#669988', track: null,
    transform: { position: [0, 0, -3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    animation: { takes: [], curves: {
      'position.x': [{ time: 0, value: 0, interpolation: 'linear' }, { time: 2, value: 2, interpolation: 'linear' }],
      'rotation.y': [{ time: 0, value: 0, interpolation: 'linear' }, { time: 1, value: 90, interpolation: 'linear' }],
    } },
  };
}

test('key multi-selection toggles, prunes stale times and clears when the object changes', () => {
  const reader=new XRKeyframeReader(), selection=reader.read(object(),3)!, selected=new XRKeyframeMultiSelection();
  selected.toggle(selection,0);selected.toggle(selection,2);assert.deepEqual(selected.times,[0,2]);
  selected.toggle(selection,2+1e-9);assert.deepEqual(selected.times,[0]);
  selected.toggle(selection,9);assert.deepEqual(selected.times,[0]);
  selected.sync({...selection,frames:selection.frames.filter(frame=>frame.time!==0)});assert.deepEqual(selected.times,[]);
  selected.toggle(selection,1);selected.sync({...selection,id:'another'});assert.deepEqual(selected.times,[]);
});

test('batch key deletion preserves unselected keys and is one undoable change', () => {
  const item=object(), original=structuredClone(item), history=new History(item);
  const result=deleteXRKeyframes(item,[0,2,2])!;
  assert.deepEqual(new XRKeyframeReader().read(result,3)!.frames.map(frame=>frame.time),[1]);
  assert.deepEqual(result.animation!.curves['rotation.y'],original.animation!.curves['rotation.y']!.slice(1));
  assert.deepEqual(item,original);
  history.commit(result as SceneObject);assert.deepEqual(history.undo(),original);assert.deepEqual(history.redo(),result);
  assert.equal(deleteXRKeyframes(item,[]),undefined);
});

test('deleting a merged XR marker removes only its property keys and refreshes previews', () => {
  const item = object(), original = structuredClone(item), reader = new XRKeyframeReader();
  reader.read(item, 3);
  const edited = deleteXRKeyframe(item, 1e-9)!;
  assert.deepEqual(edited.animation!.curves['position.x'], original.animation!.curves['position.x']!.slice(1));
  assert.deepEqual(edited.animation!.curves['rotation.y'], original.animation!.curves['rotation.y']!.slice(1));
  assert.deepEqual(reader.read(edited, 3)!.frames.map(frame => frame.time), [1, 2]);
  assert.deepEqual(reader.read(original, 3)!.frames.map(frame => frame.time), [0, 1, 2]);
  assert.deepEqual(item, original);
  assert.equal(deleteXRKeyframe(edited, 0), undefined);
  assert.equal(deleteXRKeyframe(item, .5), undefined);
});

test('deleting a legacy XR key migrates the track without retaining the removed marker', () => {
  const item = object(); delete item.animation;
  item.track = { start: 0, duration: 2, from: structuredClone(item.transform), to: structuredClone(item.transform) };
  const edited = deleteXRKeyframe(item, 0)!;
  assert.equal(edited.track, null);
  assert.deepEqual(new XRKeyframeReader().read(edited, 3)!.frames.map(frame => frame.time), [2]);
  assert.ok(item.track);
});

test('XR keys merge property times, evaluate poses, cache scrubbing and invalidate after edits/undo', () => {
  const item = object(), original = structuredClone(item), reader = new XRKeyframeReader();
  const selection = reader.read(item, 3)!;
  assert.deepEqual(selection.frames.map(frame => frame.time), [0, 1, 2]);
  assert.deepEqual(selection.frames[1].transform.position, [1, 0, -3]);
  assert.ok(Math.abs(selection.frames[1].transform.rotation[1] - 90) < 1e-6);
  assert.equal(reader.read(item, 3), selection);
  assert.deepEqual(item, original);
  item.animation!.curves['position.x']![1].value = 4;
  assert.equal(reader.read(item, 3)!.frames[1].transform.position[0], 2);
  assert.equal(reader.read(original, 3)!.frames[1].transform.position[0], 1);
  assert.deepEqual(reader.read(original, 1)!.frames.map(frame => frame.time), [0, 1]);
  assert.equal(reader.read({ ...item, hidden: true }, 3), undefined);
  assert.equal(reader.read(undefined, 3), undefined);
  assert.deepEqual(reader.read({ ...item, animation: undefined }, 3)!.frames, []);
  const legacy = { ...item, animation: undefined, track: { start: 1, duration: 2, from: item.transform, to: { ...item.transform, position: [2, 0, -3] as [number, number, number] } } };
  assert.deepEqual(reader.read(legacy, 3)!.frames.map(frame => frame.time), [1, 3]);
});

test('timeline diamonds hit exact key times, escape names, and expose empty selection', () => {
  const state = { time: 1, duration: 3, fps: 24, selection: new XRKeyframeReader().read(object(), 3) };
  assert.equal(keyframeAtTimeline(state, (64 + 1312 / 3) / 1440, 1 - 174 / 400), 1);
  assert.equal(keyframeAtTimeline(state, (64 + 1312 / 3) / 1440, .9), undefined);
  assert.equal(keyframeAtTimeline(state, .99, .565), undefined);
  assert.match(xrTimelineSvg(state), /Cube &lt;one&gt; · 3 keyframes/);
  assert.match(xrTimelineSvg({ time: 0, duration: 3, fps: 24 }), /Select an object/);
});

test('keyframe ghosts preserve source resources, use world poses and hide the current duplicate', () => {
  const source = new THREE.Group(), material = new THREE.MeshStandardMaterial({ color: '#669988' });
  const geometry = new THREE.BoxGeometry(.4, .4, .4), part = new THREE.Mesh(geometry, material);
  part.position.y = .5; source.position.set(10, 0, 0); source.add(part); source.userData.entityId = 'cube';
  const ghosts = new XRKeyframeGhosts(), selection = new XRKeyframeReader().read(object(), 3)!;
  let geometryDisposed = false, sourceMaterialDisposed = false, ghostMaterialDisposed = false;
  geometry.addEventListener('dispose', () => { geometryDisposed = true; });
  material.addEventListener('dispose', () => { sourceMaterialDisposed = true; });
  ghosts.sync({ time: .5, duration: 3, fps: 24, selection }, source);
  assert.equal(ghosts.root.children.length, 1);
  const mesh = ghosts.root.children[0] as THREE.InstancedMesh;
  assert.equal(mesh.count, 3); assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.frustumCulled, false); assert.equal(part.frustumCulled, true);
  assert.notEqual(mesh.material, material); assert.equal((mesh.material as THREE.Material).opacity, .34);
  assert.equal(material.opacity, 1); assert.equal(mesh.userData.entityId, undefined);
  const matrix = new THREE.Matrix4(); mesh.getMatrixAt(1, matrix);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(matrix).toArray(), [1, .5, -3]);
  const ray = new THREE.Raycaster(new THREE.Vector3(1, .5, 0), new THREE.Vector3(0, 0, -1));
  const hit = ray.intersectObject(ghosts.root, true)[0]; assert.equal(ghosts.timeAt(hit), 1);
  assert.ok(ghosts.boundsAt(1)!.containsPoint(new THREE.Vector3(1, .5, -3)));
  ghosts.sync({ time: 1, duration: 3, fps: 24, selection }, source);
  mesh.getMatrixAt(1, matrix); assert.equal(matrix.determinant(), 0); assert.equal(ghosts.timeAt(hit), undefined);
  assert.equal(ghosts.boundsAt(1), undefined);
  ghosts.sync({time:1,duration:3,fps:24,selection,selectedKeyTimes:[0,2]},source);
  const color=new THREE.Color();mesh.getColorAt(0,color);assert.equal(color.getHexString(),'c9f86b');
  mesh.getColorAt(1,color);assert.equal(color.getHexString(),'ffffff');
  ghosts.sync({ time: 2, duration: 3, fps: 24, selection }, source);
  mesh.getMatrixAt(1, matrix); assert.ok(Math.abs(matrix.determinant() - 1) < 1e-6);
  (mesh.material as THREE.Material).addEventListener('dispose', () => { ghostMaterialDisposed = true; });
  ghosts.sync(null); assert.equal(ghosts.root.children.length, 0);
  assert.equal(ghostMaterialDisposed, true); assert.equal(geometryDisposed, false); assert.equal(sourceMaterialDisposed, false);
  ghosts.dispose(); geometry.dispose(); material.dispose();
});
