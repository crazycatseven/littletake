import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { XRControls, translatedGrab } from '../src/xr-controls';
import { XRMenu, XR_MENU_TOGGLE, xrMenuSvg, xrMenuHandleSvg } from '../src/xr-menu';
import type { Transform } from '../src/types';

const pose: Transform = { position: [0, 0, -2], rotation: [20, 30, 40], scale: [2, 1, 3] };

function aimMenu(controls: XRControls, controller: THREE.Group, action: number): void {
  let button: THREE.Object3D | undefined;
  controls.camera.traverse(node => { if (node.userData.xrAction === action) button = node; });
  assert.ok(button);
  controls.rig.updateMatrixWorld(true);
  const target = controller.parent!.worldToLocal(button.getWorldPosition(new THREE.Vector3())).sub(controller.position).normalize();
  controller.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1), target);
}

test('XR menu collapses without invisible targets and exposes current action availability', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, fillText() {} }) }),
  } });
  const menu = new XRMenu();
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const reference = new EventTarget();
  const session = Object.assign(new EventTarget(), { visibilityState: 'visible' }) as unknown as XRSession;
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => reference } } as unknown as THREE.WebGLRenderer;
  const actions: string[] = [];
  let canUndo = false;
  const controls = new XRControls(renderer, {
    targets: () => [], editable: () => true, select: () => {}, pose: () => pose, transform: () => true,
    action: action => actions.push(action), menuState: () => ({ playing: false, canUndo }),
  });
  const click = (action: number) => { aimMenu(controls, controllers[0], action); controllers[0].dispatchEvent({ type: 'selectstart' } as never); };
  try {
    menu.setState({ playing: false, canUndo: true, following: false, hasCamera: false, scale: 1 });
    assert.equal(menu.enabled(3), false); assert.equal(menu.enabled(1), true);
    menu.toggle(); assert.deepEqual(menu.targets().map(target => target.userData.xrAction), [XR_MENU_TOGGLE]);
    assert.equal(menu.enabled(1), false); assert.equal(menu.enabled(XR_MENU_TOGGLE), true);
    menu.toggle(); assert.equal(menu.enabled(1), true);
    controls.start(session, new THREE.Vector3(0,0,-3));
    click(1); assert.deepEqual(actions, []);
    canUndo = true; click(1); assert.deepEqual(actions, ['undo']);
    click(XR_MENU_TOGGLE); click(0); click(1); assert.deepEqual(actions, ['undo']);
    click(XR_MENU_TOGGLE); click(0); assert.deepEqual(actions, ['undo', 'play']);
    click(XR_MENU_TOGGLE); controls.stop(); controls.start(session, new THREE.Vector3(0,0,-3));
    click(0); assert.deepEqual(actions, ['undo', 'play', 'play']); // session starts expanded
    assert.match(xrMenuSvg({ playing: true, canUndo: false, following: true, hasCamera: true, scale: 1 }), /Pause/);
    assert.match(xrMenuHandleSvg(false), />Menu</);
  } finally {
    menu.dispose(); controls.dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('free-view grip locomotion supports stable one/two-hand movement, rotation, scale and interruption', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, fillText() {} }) }),
  } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const reference = new EventTarget();
  const session = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => reference } } as unknown as THREE.WebGLRenderer;
  const target = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  target.position.set(0, 0, -2); target.userData.entityId = 'object-1'; target.updateMatrixWorld();
  const camera = new THREE.PerspectiveCamera();
  let showTarget = false, edits = 0;
  const controls = new XRControls(renderer, {
    targets: () => showTarget ? [target] : [], editable: () => false, select: () => edits++, pose: () => pose,
    transform: () => { edits++; return true; }, action: () => {}, followCamera: () => camera,
  });
  const fire = (index: number, type: string, data?: unknown) => controllers[index].dispatchEvent({ type, data } as never);
  const frame = { getPose: () => ({}), getViewerPose: () => ({ transform: { matrix: new THREE.Matrix4().elements } }) } as unknown as XRFrame;
  const expectPosition = (x: number, y: number, z: number) => controls.rig.position.toArray().forEach((value, i) => assert.ok(Math.abs(value - [x,y,z][i]) < 1e-6));
  try {
    controls.start(session as unknown as XRSession, new THREE.Vector3(0, 0, -3));
    for (let i = 0; i < 2; i++) fire(i, 'connected', { gripSpace: {} });
    fire(0, 'squeezestart'); grips[0].position.set(1, .5, -.25); controls.updateView(frame);
    expectPosition(-1, -.5, .25);
    controls.updateView(frame); expectPosition(-1, -.5, .25); // no world-space feedback
    fire(1, 'squeezestart'); grips[1].position.x = 5; fire(1, 'squeezeend');
    grips[0].position.x = 2; controls.updateView(frame); expectPosition(-2, -.5, .25);
    fire(0, 'squeezeend'); grips[0].position.x = 3; controls.updateView(frame); expectPosition(-2, -.5, .25);
    fire(0, 'squeezestart'); grips[0].position.x = 4; controls.updateView(frame); expectPosition(-3, -.5, .25);
    controls.updateView({ getPose: () => null } as unknown as XRFrame);
    grips[0].position.x = 9; controls.updateView(frame); expectPosition(-3, -.5, .25);
    fire(0, 'squeezestart'); fire(0, 'disconnected'); grips[0].position.x = 10;
    controls.updateView(frame); expectPosition(-3, -.5, .25);
    fire(0, 'connected', { gripSpace: {} }); fire(0, 'squeezestart');
    session.visibilityState = 'hidden'; session.dispatchEvent(new Event('visibilitychange'));
    session.visibilityState = 'visible'; grips[0].position.x = 11; controls.updateView(frame); expectPosition(-3, -.5, .25);
    fire(0, 'squeezestart'); reference.dispatchEvent(new Event('reset')); grips[0].position.x = 12;
    controls.updateView(frame); expectPosition(-3, -.5, .25);
    controls.rig.position.set(0,0,0); grips[0].position.set(0,0,0);
    showTarget = true; fire(0, 'squeezestart'); grips[0].position.x = 1; controls.updateView(frame);
    expectPosition(0,0,0); // a locked object must not become a navigation gesture
    showTarget = false;
    aimMenu(controls, controllers[0], 3);
    fire(0, 'squeezestart'); grips[0].position.x = 2; controls.updateView(frame); expectPosition(0,0,0); // UI
    fire(0, 'selectstart'); controls.updateView(frame); controllers[0].quaternion.identity();
    fire(0, 'squeezestart'); grips[0].position.x = 3; controls.updateView(frame); expectPosition(0,0,0); // following
    assert.equal(edits, 0);
    controls.stop(); controls.start(session as unknown as XRSession, new THREE.Vector3(0,0,-3));
    fire(1, 'connected', { gripSpace: {} });
    controls.rig.rotation.y = Math.PI / 2;
    fire(1, 'squeezestart'); grips[1].position.x += 1; controls.updateView(frame);
    expectPosition(0,0,1); // reference-space delta respects rig orientation
    fire(1, 'squeezeend');

    // Both hand anchors stay fixed in project space while the world is turned,
    // enlarged and translated together. Test from an already transformed rig.
    fire(0, 'connected', { gripSpace: {} });
    controls.rig.position.set(3,2,-4); controls.rig.rotation.set(0,.4,0); controls.rig.scale.setScalar(2);
    grips[0].position.set(-.5,1,-1); grips[1].position.set(.5,1,-1);
    controls.rig.updateMatrixWorld(true);
    const anchors = grips.map(grip => grip.position.clone().applyMatrix4(controls.rig.matrixWorld));
    fire(0, 'squeezestart'); fire(1, 'squeezestart');
    grips[0].position.set(1,1.5,0); grips[1].position.set(1,1.5,-2);
    controls.updateView(frame); controls.rig.updateMatrixWorld(true);
    assert.equal(controls.rig.scale.x, 1); // spreading enlarges the apparent world
    grips.forEach((grip,i) => assert.ok(grip.position.clone().applyMatrix4(controls.rig.matrixWorld).distanceTo(anchors[i]) < 1e-6));
    const stable = controls.rig.matrix.clone();
    controls.updateView(frame); controls.rig.updateMatrix();
    stable.elements.forEach((value,i) => assert.ok(Math.abs(value-controls.rig.matrix.elements[i]) < 1e-6));
    fire(0, 'squeezeend'); controls.updateView(frame); controls.rig.updateMatrix();
    stable.elements.forEach((value,i) => assert.ok(Math.abs(value-controls.rig.matrix.elements[i]) < 1e-6));
    const beforeSingle = controls.rig.position.clone();
    grips[1].position.z += .3; controls.updateView(frame);
    const expected = beforeSingle.sub(new THREE.Vector3(0,0,.3).multiplyScalar(controls.rig.scale.x).applyQuaternion(controls.rig.quaternion));
    assert.ok(controls.rig.position.distanceTo(expected) < 1e-6);
    fire(1, 'squeezeend');

    // Unequal hand heights can scale/translate but must never tilt the floor.
    grips[0].position.set(-.5,1,-1); grips[1].position.set(.5,1,-1);
    fire(0, 'squeezestart'); fire(1, 'squeezestart');
    const beforeTilt = controls.rig.quaternion.clone();
    grips[1].position.y += 1; controls.updateView(frame);
    assert.ok(controls.rig.quaternion.angleTo(beforeTilt) < 1e-6);
    const expectLevel = () => assert.ok(new THREE.Vector3(0,1,0).applyQuaternion(controls.rig.quaternion).distanceTo(new THREE.Vector3(0,1,0)) < 1e-6);
    expectLevel();
    grips[1].position.set(-.5,2,-2); controls.updateView(frame); expectLevel();
    assert.ok(controls.rig.quaternion.angleTo(beforeTilt) > .1);
    const beforeVertical = controls.rig.quaternion.clone();
    grips[1].position.set(-.5,2,-1); controls.updateView(frame); expectLevel();
    assert.ok(controls.rig.quaternion.angleTo(beforeVertical) < 1e-6);
    grips[1].position.set(-1.5,2,-1); controls.updateView(frame); expectLevel();
    assert.ok(controls.rig.quaternion.angleTo(beforeVertical) < 1e-6); // re-acquire without a jump
    fire(0, 'squeezeend'); fire(1, 'squeezeend');

    // Very close hands freeze and re-anchor rather than dividing by zero.
    grips[0].position.set(-.5,1,-1); grips[1].position.set(.5,1,-1);
    fire(0, 'squeezestart'); fire(1, 'squeezestart');
    controls.rig.updateMatrix(); const beforeClose = controls.rig.matrix.clone();
    grips[1].position.copy(grips[0].position); controls.updateView(frame); controls.rig.updateMatrix();
    assert.deepEqual(controls.rig.matrix.elements, beforeClose.elements);
    grips[1].position.x += 1; controls.updateView(frame); controls.rig.updateMatrix();
    assert.deepEqual(controls.rig.matrix.elements, beforeClose.elements);
    grips[1].position.x += 100; controls.updateView(frame); assert.equal(controls.rig.scale.x, .05);
    fire(0, 'squeezeend'); fire(1, 'squeezeend');

    controls.rig.scale.setScalar(20); grips[0].position.set(-.5,1,-1); grips[1].position.set(.5,1,-1);
    fire(0, 'squeezestart'); fire(1, 'squeezestart');
    grips[1].position.x = -.4; controls.updateView(frame); assert.equal(controls.rig.scale.x, 20);
    const interrupted = controls.rig.position.clone();
    fire(1, 'disconnected'); grips[0].position.x += 4; controls.updateView(frame);
    assert.deepEqual(controls.rig.position.toArray(), interrupted.toArray());

    // Camera-follow temporarily uses real scale and restores the full free rig.
    controls.rig.updateMatrix(); const beforeFollow = controls.rig.matrix.clone();
    const toggle = () => {
      aimMenu(controls, controllers[0], 3);
      fire(0, 'selectstart'); controllers[0].quaternion.identity();
    };
    toggle(); controls.updateView(frame); assert.equal(controls.rig.scale.x, 1);
    toggle(); controls.rig.updateMatrix();
    beforeFollow.elements.forEach((value,i) => assert.ok(Math.abs(value-controls.rig.matrix.elements[i]) < 1e-6));
    assert.equal(edits, 0);
    controls.stop(); controls.start(session as unknown as XRSession, new THREE.Vector3(0,0,-3));
    assert.deepEqual(controls.rig.scale.toArray(), [1,1,1]);
  } finally {
    controls.dispose(); target.geometry.dispose(); (target.material as THREE.Material).dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('XR translation preserves grab offset, rotation and scale without mutating the original', () => {
  const result = translatedGrab(pose, new THREE.Vector3(4, 2, 1), new THREE.Vector3(5, 1, 4));
  assert.deepEqual(result, { position: [1, -1, 1], rotation: [20, 30, 40], scale: [2, 1, 3] });
  assert.deepEqual(pose.position, [0, 0, -2]);
  assert.equal(translatedGrab(pose, new THREE.Vector3(), new THREE.Vector3(5000, 0, 0)).position[0], 1000);
});

test('XR controller gestures select, commit once, cancel on tracking loss, and respect edit locks', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, fillText() {} }) }),
  } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const reference = new EventTarget();
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => reference } } as unknown as THREE.WebGLRenderer;
  const target = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  target.position.set(0, 0, -2); target.userData.entityId = 'object-1'; target.updateMatrixWorld();
  const session = Object.assign(new EventTarget(), { visibilityState: 'visible' }) as unknown as XRSession;
  let editable = true;
  let followCamera: THREE.Camera | null = new THREE.PerspectiveCamera();
  const phases: string[] = [], selections: string[] = [];
  const controls = new XRControls(renderer, {
    targets: () => [target], editable: () => editable, select: id => selections.push(id), pose: () => structuredClone(pose),
    transform: (_id, _pose, phase) => { phases.push(phase); return true; }, action: () => {},
    followCamera: () => followCamera,
  });
  const fire = (type: string, data?: unknown) => controllers[0].dispatchEvent({ type, data } as never);
  const frame = { getPose: () => ({}) } as unknown as XRFrame;
  try {
    controls.start(session, new THREE.Vector3(0, 0, -3));
    fire('connected', { gripSpace: {} });
    fire('selectstart'); assert.deepEqual(selections, ['object-1']);
    fire('squeezestart'); grips[0].position.x = .5; controls.update(frame); fire('squeezeend'); fire('squeezeend');
    assert.deepEqual(phases, ['start', 'change', 'end']);
    // Enter through the spatial button, not a private method. At entry the tracked
    // head (including physical eye height) must coincide with the authored camera.
    const freePosition = controls.rig.position.clone();
    const clickFollow = () => {
      aimMenu(controls, controllers[0], 3);
      fire('selectstart'); controllers[0].quaternion.identity();
    };
    const head = new THREE.Matrix4().compose(new THREE.Vector3(.2, 1.6, .1), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .3), new THREE.Vector3(1, 1, 1));
    const viewerFrame = { getViewerPose: () => ({ transform: { matrix: head.elements } }) } as unknown as XRFrame;
    followCamera.position.set(4, 3, -5); followCamera.rotation.set(.2, .7, 0);
    clickFollow(); controls.updateView(viewerFrame); controls.rig.updateMatrixWorld(true);
    const assertMatrix = (actual: THREE.Matrix4, expected: THREE.Matrix4) => actual.elements.forEach((value, index) => assert.ok(Math.abs(value - expected.elements[index]) < 1e-6));
    assertMatrix(controls.rig.matrixWorld.clone().multiply(head), followCamera.matrixWorld);
    followCamera.position.x += 2; followCamera.rotation.y += .4;
    controls.updateView(viewerFrame); controls.rig.updateMatrixWorld(true);
    assertMatrix(controls.rig.matrixWorld.clone().multiply(head), followCamera.matrixWorld);
    const anchoredRig = controls.rig.matrix.clone();
    const turnedHead = head.clone().multiply(new THREE.Matrix4().makeRotationY(.5));
    controls.updateView({ getViewerPose: () => ({ transform: { matrix: turnedHead.elements } }) } as unknown as XRFrame);
    controls.rig.updateMatrix(); assertMatrix(controls.rig.matrix, anchoredRig);
    assert.equal(controls.camera.layers.isEnabled(3), false);
    clickFollow(); assert.deepEqual(controls.rig.position.toArray(), freePosition.toArray());
    assert.equal(controls.camera.layers.isEnabled(3), true);
    clickFollow(); controls.updateView(viewerFrame);
    followCamera = null; controls.updateView(viewerFrame);
    assert.deepEqual(controls.rig.position.toArray(), freePosition.toArray());
    assert.equal(controls.camera.layers.isEnabled(3), true);
    phases.length = 0;
    fire('squeezestart'); controls.update({ getPose: () => null } as unknown as XRFrame); fire('squeezeend');
    assert.deepEqual(phases, ['start', 'cancel']);
    phases.length = 0;
    editable = false; fire('squeezestart'); assert.deepEqual(phases, []);
    editable = true; fire('squeezestart');
    reference.dispatchEvent(new Event('reset')); assert.deepEqual(phases, ['start', 'cancel']);
    phases.length = 0;
    fire('squeezestart'); fire('disconnected'); assert.deepEqual(phases, ['start', 'cancel']);
    fire('connected', { gripSpace: {} }); phases.length = 0;
    fire('squeezestart'); controls.stop(); assert.deepEqual(phases, ['start', 'cancel']);
    phases.length = 0;
    controls.start(session, new THREE.Vector3(0, 0, -3)); fire('connected', { gripSpace: {} });
    fire('squeezestart'); controls.update(frame); fire('squeezeend');
    assert.deepEqual(phases, ['start', 'change', 'end']);
  } finally {
    controls.dispose(); target.geometry.dispose(); (target.material as THREE.Material).dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});
