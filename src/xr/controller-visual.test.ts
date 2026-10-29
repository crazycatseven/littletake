import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRControllerVisual, xrControllerIconSvg } from './controller-visual';

test('controller visuals follow grips, keep a fallback until loading, and clean up on disconnect/dispose', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}) }) } });
  const grip = new THREE.Group(), device = new THREE.Group(), loaded = new THREE.Group();
  const rig = new THREE.Group(); rig.add(grip);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); loaded.add(mesh);
  let connects = 0, disposed = 0;
  mesh.geometry.addEventListener('dispose', () => disposed++);
  const factory = {
    onLoad: null as ((scene: THREE.Group) => void) | null,
    createControllerModel(input: THREE.Group) {
      input.addEventListener('connected' as never, () => { connects++; });
      input.addEventListener('disconnected' as never, () => device.clear());
      return device;
    },
  };
  const visual = new XRControllerVisual(grip, factory as unknown as XRControllerModelFactory);
  const fallback = visual.root.getObjectByName('Offline controller')!;
  const source = { handedness: 'left', profiles: ['oculus-touch-v3'], targetRayMode: 'tracked-pointer', gripSpace: {}, gamepad: { mapping: 'xr-standard', buttons: Array.from({ length: 8 }, () => ({ pressed: false })) } } as unknown as XRInputSource;
  assert.equal(visual.root.visible, false);
  visual.connect(source); assert.equal(visual.root.visible, true); assert.equal(fallback.visible, true);
  const hint = visual.root.getObjectByName('X Undo hint')!;
  const playHint = visual.root.getObjectByName('Y Play hint') as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  const menuHint = visual.root.getObjectByName('Menu hint')!;
  const legend = visual.root.getObjectByName('Left controls guide')!;
  assert.ok(menuHint.visible); assert.ok(legend.visible);
  assert.ok(hint); assert.equal(hint.visible, true);
  assert.ok(playHint); assert.equal(playHint.visible, true);
  visual.setState({ playing: false, canUndo: true, canPlay: true });
  assert.equal(playHint.material.opacity, 1);
  visual.setState({ playing: true, canUndo: false, canPlay: false });
  assert.equal(playHint.material.opacity, .6);
  visual.acknowledge('play'); assert.equal(playHint.material.opacity, 1);
  assert.doesNotMatch(xrControllerIconSvg('undo'), /<text/);
  assert.notEqual(xrControllerIconSvg('play', false), xrControllerIconSvg('play', true));
  fallback.traverse(node => { if (node instanceof THREE.Mesh) assert.equal(node.frustumCulled, false); });
  grip.position.set(1, 2, 3); grip.rotation.y = Math.PI / 2; grip.updateMatrixWorld(true);
  assert.deepEqual(visual.root.getWorldPosition(new THREE.Vector3()).toArray(), [1, 2, 3]);
  assert.ok(visual.root.getWorldQuaternion(new THREE.Quaternion()).angleTo(grip.quaternion) < 1e-6);
  const button = new THREE.Mesh(new THREE.CylinderGeometry(.006, .006, .006, 16), new THREE.MeshStandardMaterial());
  button.name = 'actual-x'; button.position.set(.02, .04, .01); loaded.add(button);
  const yButton = new THREE.Mesh(new THREE.CylinderGeometry(.006, .006, .006, 16), new THREE.MeshStandardMaterial());
  yButton.name = 'actual-y'; yButton.position.set(.02, .04, -.01); loaded.add(yButton);
  const menuButton = new THREE.Mesh(new THREE.CylinderGeometry(.005, .005, .004, 16), new THREE.MeshStandardMaterial());
  menuButton.name = 'actual-menu'; menuButton.position.set(-.015, .04, .01); loaded.add(menuButton);
  Object.assign(device, { motionController: { components: { 'x-button': { rootNodeName: 'actual-x' }, 'y-button': { rootNodeName: 'actual-y' }, menu: { rootNodeName: 'actual-menu', gamepadIndices: { button: 7 } } } } });
  device.add(loaded); factory.onLoad!(loaded); assert.equal(fallback.visible, false);
  loaded.traverse(node => {
    if (node instanceof THREE.Mesh) {
      assert.equal(node.frustumCulled, false);
      assert.equal((node.material as THREE.Material).depthTest, true);
    }
  });
  assert.equal(hint.parent, button); assert.ok(hint instanceof THREE.Mesh);
  assert.equal(menuHint.parent, menuButton);
  assert.equal(playHint.parent, yButton); assert.ok(Math.abs(playHint.position.y - .0032) < 1e-6);
  assert.ok(Math.abs(hint.position.y - .0032) < 1e-6); // On the button's upper surface.
  assert.ok(visual.root.children.every(child => !(child instanceof THREE.Line)));
  const eye = new THREE.PerspectiveCamera(60, 1, .001, 100); rig.add(eye);
  eye.position.set(1, 2.2, 3.4); eye.lookAt(hint.getWorldPosition(new THREE.Vector3()));
  const projectedWidth = (scale: number, icon: THREE.Object3D) => {
    rig.scale.setScalar(scale); rig.updateMatrixWorld(true);
    const a = new THREE.Vector3(-.5, 0, 0).applyMatrix4(icon.matrixWorld).project(eye);
    const b = new THREE.Vector3(.5, 0, 0).applyMatrix4(icon.matrixWorld).project(eye);
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  for (const icon of [hint, playHint, menuHint, legend]) {
    const width = projectedWidth(1, icon); assert.ok(width > 0);
    for (const scale of [.05, 20]) assert.ok(Math.abs(projectedWidth(scale, icon) - width) < 1e-6);
  }
  rig.scale.setScalar(1);
  visual.disconnect(); assert.equal(visual.root.visible, false); assert.equal(device.children.length, 0);
  assert.equal(hint.visible, false); assert.equal(playHint.visible, false);
  visual.connect(source); assert.equal(fallback.visible, true); assert.equal(connects, 2);
  visual.connect({ ...source, hand: {} } as XRInputSource); assert.equal(visual.root.visible, false); assert.equal(connects, 2);
  visual.connect({ ...source, handedness: 'right' }); assert.equal(hint.visible, false); assert.equal(playHint.visible, false);
  assert.equal(menuHint.visible, false); assert.equal(legend.visible, false);
  visual.dispose(); assert.equal(grip.children.length, 0); assert.equal(disposed, 1);
  visual.connect(source); assert.equal(connects, 3);
  if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
});
