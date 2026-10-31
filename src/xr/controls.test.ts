import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { XRControls, translatedGrab, rotatedGrab } from './controls';
import { XRMenu, XR_MENU_TOGGLE, XR_MENU_DRAG, XR_TIMELINE_DRAG, XR_ADD_KEY, XR_DELETE_KEY, xrMenuSvg, xrMenuHandleSvg } from './menu';
import type { Transform } from '../types';

const pose: Transform = { position: [0, 0, -2], rotation: [20, 30, 40], scale: [2, 1, 3] };

test('sphere grab rotates around the grip with no initial snap and preserves scale', () => {
  const start: Transform = { position: [1, 0, 0], rotation: [0, 0, 0], scale: [2, 1, 3] };
  const origin = new THREE.Vector3(), current = new THREE.Vector3(0, 2, 0);
  const initial = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .7);
  assert.deepEqual(rotatedGrab(start, origin, origin, initial, initial), start);
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2).multiply(initial);
  const result = rotatedGrab(start, origin, current, initial, rotation);
  assert.ok(new THREE.Vector3(...result.position).distanceTo(new THREE.Vector3(0, 3, 0)) < 1e-8);
  assert.ok(Math.abs(result.rotation[2] - 90) < 1e-8);
  assert.deepEqual(result.scale, start.scale);
});

test('timeline header drags independently and add-key is gated by selection, lock and active gesture', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let timelineSvg = '';
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}), set src(value: string) {
    const svg = decodeURIComponent(value.slice(value.indexOf(',') + 1));
    if (svg.includes('>Timeline</text>')) timelineSvg = svg;
  } }) } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const reference = new EventTarget(), session = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => reference } } as unknown as THREE.WebGLRenderer;
  let selected = true, editable = true, added = 0, edits = 0, time = 1, deleted = 0, hasKey = true;
  const controls = new XRControls(renderer, {
    targets: () => [], editable: () => editable, select: () => {}, pose: () => pose, transform: () => { edits++; return true; }, action: () => {},
    timelineState: () => ({ time, duration: 4, fps: 24, selection: selected ? { id: 'cube', name: 'Cube', frames: hasKey ? [{ time: 1, transform: pose }] : [] } : undefined }),
    deleteKeyframe: () => { deleted++; hasKey = false; },
    addKeyframe: () => { added++; }, seek: value => { time = value; },
  });
  const frame = { getPose: () => ({}), getViewerPose: () => null } as unknown as XRFrame;
  const fire = (type: string) => controllers[0].dispatchEvent({ type } as never);
  const aim = (action: number) => {
    const target = controls.timelineRoot.children.find(child => child.userData.xrAction === action)!;
    controls.rig.updateMatrixWorld(true); controls.timelineRoot.updateMatrixWorld(true);
    controllers[0].quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), controllers[0].parent!.worldToLocal(target.getWorldPosition(new THREE.Vector3())).sub(controllers[0].position).normalize());
  };
  try {
    controls.start(session as unknown as XRSession, new THREE.Vector3(0, 0, -3));
    controllers[0].dispatchEvent({ type: 'connected', data: { gripSpace: {} } } as never);
    aimMenu(controls, controllers[0], 5); fire('selectstart');
    aimMenu(controls, controllers[0], XR_MENU_TOGGLE); fire('selectstart');
    // Nearby grip highlights the title without a pointing ray; leaving or
    // losing tracking clears it. The threshold follows navigation scale.
    const title = controls.timelineRoot.children.find(child => child.userData.xrAction === XR_TIMELINE_DRAG)!;
    controllers[0].quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    for (const scale of [1, 2]) {
      controls.rig.scale.setScalar(scale); controls.rig.updateMatrixWorld(true);
      const point = title.getWorldPosition(new THREE.Vector3());
      grips[0].position.copy(controls.rig.worldToLocal(point.clone().add(new THREE.Vector3(0, 0, .03 * scale))));
      controls.update(frame); assert.match(timelineSvg, /Hold grip to move/);
      controls.update({ getPose: () => null } as unknown as XRFrame); assert.doesNotMatch(timelineSvg, /Hold grip to move/);
      grips[0].position.copy(controls.rig.worldToLocal(point.clone().add(new THREE.Vector3(0, 0, .06 * scale))));
      controls.update(frame); assert.doesNotMatch(timelineSvg, /Hold grip to move/);
    }
    controls.rig.scale.setScalar(1); grips[0].position.set(0, 0, 0); controls.rig.updateMatrixWorld(true);
    const menuPosition = controls.menuRoot.position.clone(), before = controls.timelineRoot.position.clone();
    aim(XR_TIMELINE_DRAG); fire('squeezestart');
    grips[0].position.x += .4; controls.updateView(frame);
    assert.ok(controls.timelineRoot.position.distanceTo(before) > .1);
    assert.deepEqual(controls.menuRoot.position, menuPosition);
    assert.ok(Math.abs(controls.timelineRoot.rotation.x) < 1e-8); assert.ok(Math.abs(controls.timelineRoot.rotation.z) < 1e-8);
    aim(XR_ADD_KEY); fire('selectstart'); assert.equal(added, 0);
    aim(XR_DELETE_KEY); fire('selectstart'); assert.equal(deleted, 0);
    fire('squeezeend'); const placed = controls.timelineRoot.position.clone();
    grips[0].position.x += .4; controls.updateView(frame); assert.deepEqual(controls.timelineRoot.position, placed);
    aim(XR_ADD_KEY); fire('selectstart'); assert.equal(added, 1);
    selected = false; fire('selectstart'); assert.equal(added, 1);
    selected = true; editable = false; fire('selectstart'); assert.equal(added, 1);
    editable = true; fire('selectstart'); assert.equal(added, 2);
    aim(XR_DELETE_KEY);
    time = .5; fire('selectstart'); assert.equal(deleted, 0);
    time = 1; editable = false; fire('selectstart'); assert.equal(deleted, 0);
    editable = true; selected = false; fire('selectstart'); assert.equal(deleted, 0);
    selected = true; fire('selectstart'); assert.equal(deleted, 1);
    fire('selectstart'); assert.equal(deleted, 1);
    assert.equal(edits, 0); assert.equal(time, 1);
  } finally {
    controls.dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

function aimMenu(controls: XRControls, controller: THREE.Group, action: number): void {
  let button: THREE.Object3D | undefined;
  controls.menuRoot.traverse(node => { if (node.userData.xrAction === action) button = node; });
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
  const canUndo = true;
  const controls = new XRControls(renderer, {
    targets: () => [], editable: () => true, select: () => {}, pose: () => pose, transform: () => true,
    action: action => actions.push(action), menuState: () => ({ playing: false, canUndo }),
  });
  const click = (action: number) => { aimMenu(controls, controllers[0], action); controllers[0].dispatchEvent({ type: 'selectstart' } as never); };
  try {
    menu.setState({ playing: false, canUndo: true, following: false, hasCamera: false, scale: 1 });
    assert.equal(menu.enabled(3), false); assert.equal(menu.enabled(1), false);
    menu.toggle(); assert.deepEqual(menu.targets().map(target => target.userData.xrAction), [XR_MENU_TOGGLE]);
    assert.equal(menu.enabled(1), false); assert.equal(menu.enabled(XR_MENU_TOGGLE), true);
    menu.toggle(); assert.equal(menu.enabled(1), false);
    controls.start(session, new THREE.Vector3(0,0,-3));
    assert.ok(menu.targets().every(target => ![0, 1].includes(target.userData.xrAction)));
    assert.equal(menu.enabled(0), false);
    assert.doesNotMatch(xrMenuSvg({ playing: false, canUndo: true, following: false, hasCamera: true, scale: 1 }), /Undo|Play|Pause/);
    click(XR_MENU_TOGGLE); assert.equal(controls.menuRoot.children.filter(child => child.visible).length, 1);
    click(XR_MENU_TOGGLE); assert.ok(controls.menuRoot.children.filter(child => child.visible).length > 1);
    click(XR_MENU_TOGGLE); controls.stop(); controls.start(session, new THREE.Vector3(0,0,-3));
    assert.ok(controls.menuRoot.children.filter(child => child.visible).length > 1); // session starts expanded
    assert.deepEqual(actions, []);
    assert.doesNotMatch(xrMenuSvg({ playing: true, canUndo: false, following: true, hasCamera: true, scale: 1 }), /Undo|Play|Pause/);
    assert.match(xrMenuHandleSvg(false), /<title>Open menu<\/title>/);
  } finally {
    menu.dispose(); controls.dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('world menu keeps its angular size, stays anchored while open and returns to the viewer on reopening', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}) }) } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const reference = new EventTarget();
  const session = Object.assign(new EventTarget(), { visibilityState: 'visible' }) as unknown as XRSession;
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => reference } } as unknown as THREE.WebGLRenderer;
  const actions: string[] = [];
  const controls = new XRControls(renderer, {
    targets: () => [], editable: () => true, select: () => {}, pose: () => pose, transform: () => true,
    action: action => actions.push(action), timelineState: () => ({ time: 0, duration: 2, fps: 24 }),
  });
  const scene = new THREE.Scene(); scene.add(controls.rig, controls.menuRoot);
  const head = new THREE.Matrix4().compose(new THREE.Vector3(.2, 1.7, .1), new THREE.Quaternion().setFromEuler(new THREE.Euler(.3, .4, .2, 'YXZ')), new THREE.Vector3(1, 1, 1));
  const frame = { getViewerPose: () => ({ transform: { matrix: head.elements } }) } as unknown as XRFrame;
  const click = (action: number) => {
    const front = controls.menuRoot.position.clone().add(new THREE.Vector3(0, 0, controls.menuRoot.scale.x).applyQuaternion(controls.menuRoot.quaternion));
    controllers[0].position.copy(controls.rig.worldToLocal(front));
    aimMenu(controls, controllers[0], action); controllers[0].dispatchEvent({ type: 'selectstart' } as never);
  };
  try {
    controls.start(session, new THREE.Vector3(0, 0, -3)); controls.updateView(frame);
    assert.equal(controls.menuRoot.parent, scene);
    const anchor = controls.menuRoot.position.clone(), rotation = controls.menuRoot.quaternion.clone();
    assert.ok(Math.abs(anchor.y - 1.52) < 1e-6); // Eye height minus the panel offset.
    assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(rotation).distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6);
    head.makeTranslation(4, 2, 5); controls.camera.position.set(4, 2, 5); controls.camera.rotation.set(.5, 1, .2);
    for (const scale of [.05, 1, 20]) {
      controls.rig.position.set(5, 2, -3); controls.rig.rotation.y = 1; controls.rig.scale.setScalar(scale);
      controls.updateView(frame);
      assert.ok(controls.menuRoot.position.distanceTo(anchor) < 1e-6);
      assert.ok(controls.menuRoot.quaternion.angleTo(rotation) < 1e-6);
      const eye = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().multiplyMatrices(controls.rig.matrixWorld, head));
      const distance = eye.distanceTo(anchor);
      // Width / viewing distance stays constant, including after locomotion scaling.
      for (const child of controls.menuRoot.children as THREE.Mesh[]) {
        const width = (child.geometry as THREE.PlaneGeometry).parameters.width;
        const left = child.localToWorld(new THREE.Vector3(-width / 2, 0, 0));
        const right = child.localToWorld(new THREE.Vector3(width / 2, 0, 0));
        assert.ok(Math.abs(left.distanceTo(right) / distance - width / 1.25) < 1e-6);
      }
      const controllerWorld = anchor.clone().add(new THREE.Vector3(0, 0, scale).applyQuaternion(rotation));
      controllers[0].position.copy(controls.rig.worldToLocal(controllerWorld));
      click(5); // Timeline hit targets follow the compensated visual.
      assert.equal(controls.timelineRoot.visible, true);
      const timelinePosition = controls.timelineRoot.position.clone();
      click(XR_MENU_TOGGLE);
      assert.equal(controls.menuRoot.children.filter(child => child.visible).length, 1);
      assert.equal(controls.timelineRoot.visible, true);
      head.makeTranslation(4 + scale, 2, 5); controls.updateView(frame);
      const collapsed = controls.menuRoot.position.clone();
      click(XR_MENU_TOGGLE);
      assert.ok(controls.menuRoot.position.distanceTo(collapsed) < 1e-6);
      assert.ok(controls.timelineRoot.position.distanceTo(timelinePosition) < 1e-6);
      click(5); assert.equal(controls.timelineRoot.visible, false);
      const reopenedEye = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().multiplyMatrices(controls.rig.matrixWorld, head));
      assert.ok(Math.abs(controls.menuRoot.position.distanceTo(reopenedEye) / scale - Math.hypot(.9, .18)) < 1e-6);
      anchor.copy(controls.menuRoot.position); rotation.copy(controls.menuRoot.quaternion);
    }
    assert.deepEqual(actions, []);
    head.makeTranslation(2, 1.7, 0);
    reference.dispatchEvent(new Event('reset')); controls.updateView(frame);
    assert.ok(controls.menuRoot.position.distanceTo(anchor) > 1);
    controls.stop(); assert.equal(controls.menuRoot.visible, false);
    controls.start(session, new THREE.Vector3(0, 0, -3)); controls.updateView(frame);
    assert.equal(controls.menuRoot.visible, true); assert.ok(Math.abs(controls.menuRoot.scale.x - Math.hypot(.9, .18) / 1.25) < 1e-6);
    controls.dispose(); assert.equal(controls.menuRoot.parent, null);
  } finally {
    controls.dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('title grip moves only the menu, preserves its grabbed point and stops on release or tracking interruption', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}) }) } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const session = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => new EventTarget() } } as unknown as THREE.WebGLRenderer;
  const axes = [0, 0, 0, 0], buttons = Array.from({ length: 6 }, () => ({ pressed: false }));
  const source = { handedness: 'left', targetRaySpace: {}, gripSpace: {}, gamepad: { mapping: 'xr-standard', axes, buttons } };
  let tracked = true, time = 1, edits = 0;
  const actions: string[] = [];
  const controls = new XRControls(renderer, {
    targets: () => [], editable: () => false, select: () => edits++, pose: () => pose, transform: () => { edits++; return true; },
    action: action => actions.push(action), menuState: () => ({ playing: false, canUndo: true }),
    timelineState: () => ({ time, duration: 10, fps: 24 }), seek: value => { time = value; },
  });
  const head = new THREE.Matrix4().makeTranslation(0, 1.6, 0);
  const frame = { getPose: () => tracked ? {} : null, getViewerPose: () => ({ transform: { matrix: head.elements } }) } as unknown as XRFrame;
  const fire = (type: string, index = 0, data?: unknown) => controllers[index].dispatchEvent({ type, data } as never);
  const click = (action: number) => { aimMenu(controls, controllers[0], action); fire('selectstart'); };
  try {
    for (const [scale, interruption] of [[.05, 'release'], [1, 'tracking'], [20, 'disconnect'], [1, 'visibility']] as const) {
      tracked = true; session.visibilityState = 'visible'; axes[2] = 0; buttons[4].pressed = false;
      controllers[0].position.set(0, 0, 0); grips[0].position.set(0, 0, 0);
      controls.start(session as unknown as XRSession, new THREE.Vector3(0, 0, -3));
      controls.rig.scale.setScalar(scale); controls.updateView(frame, 0);
      fire('connected', 0, source); fire('connected', 1, { gripSpace: {} });
      click(5); controls.updateView(frame, 10);
      const title = controls.menuRoot.children.find(child => child.userData.xrAction === XR_MENU_DRAG)!;
      const point = title.localToWorld(new THREE.Vector3());
      if (interruption === 'release') {
        // Ray grip works without reaching the distant title.
        aimMenu(controls, controllers[0], XR_MENU_DRAG);
      } else {
        grips[0].position.copy(controls.rig.worldToLocal(point.clone())).z += .02;
        controllers[0].quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // Point away: direct touch wins.
      }
      const origin = grips[0].getWorldPosition(new THREE.Vector3());
      const local = controls.menuRoot.worldToLocal(point.clone());
      const position = controls.menuRoot.position.clone(), orientation = controls.menuRoot.quaternion.clone();
      fire('squeezestart'); fire('squeezestart', 1); // A second hand must not start locomotion.
      const dragTime = time;
      axes[2] = 1; buttons[4].pressed = true; buttons[5].pressed = true;
      grips[0].position.add(new THREE.Vector3(.2, .15, -.3)); grips[0].rotation.set(.8, .4, .6);
      controls.updateView(frame, 60); controls.update(frame);
      const delta = grips[0].getWorldPosition(new THREE.Vector3()).sub(origin);
      assert.ok(controls.menuRoot.localToWorld(local.clone()).distanceTo(point.clone().add(delta)) < 1e-6);
      assert.ok(controls.menuRoot.position.distanceTo(position) > .01 * scale);
      assert.ok(controls.menuRoot.quaternion.angleTo(orientation) < 1e-6);
      assert.deepEqual(controls.rig.position.toArray(), [0, 0, 0]);
      assert.equal(time, dragTime); assert.deepEqual(actions, []); assert.equal(edits, 0);
      if (interruption === 'release') fire('squeezeend');
      if (interruption === 'tracking') { tracked = false; controls.updateView(frame, 70); }
      if (interruption === 'disconnect') fire('disconnected');
      if (interruption === 'visibility') { session.visibilityState = 'hidden'; session.dispatchEvent(new Event('visibilitychange')); }
      const stopped = controls.menuRoot.position.clone();
      grips[0].position.x += 2; controls.updateView(frame, 80);
      assert.ok(controls.menuRoot.position.distanceTo(stopped) < 1e-6);
      controls.stop();
    }
  } finally {
    controls.dispose();
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
      // The menu no longer travels with the rig: approach its front to click it.
      const previousPosition = controllers[0].position.clone();
      const front = controls.menuRoot.position.clone().add(new THREE.Vector3(0, 0, controls.rig.scale.x).applyQuaternion(controls.menuRoot.quaternion));
      controllers[0].position.copy(controls.rig.worldToLocal(front));
      aimMenu(controls, controllers[0], 3);
      fire(0, 'selectstart'); controllers[0].quaternion.identity();
      controllers[0].position.copy(previousPosition);
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
    fire('selectend'); phases.length = 0;
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
    const menuBeforeTravel = controls.menuRoot.position.clone();
    const menuFrame = () => new THREE.Matrix4().compose(controls.rig.position,
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), new THREE.Euler().setFromQuaternion(controls.rig.quaternion, 'YXZ').y), controls.rig.scale);
    const localMenu = menuBeforeTravel.clone().applyMatrix4(menuFrame().invert());
    followCamera.position.x += 2; followCamera.rotation.y += .4;
    controls.updateView(viewerFrame); controls.rig.updateMatrixWorld(true);
    assertMatrix(controls.rig.matrixWorld.clone().multiply(head), followCamera.matrixWorld);
    assert.ok(controls.menuRoot.position.distanceTo(menuBeforeTravel) > 1);
    assert.ok(controls.menuRoot.position.distanceTo(localMenu.applyMatrix4(menuFrame())) < 1e-6);
    assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(controls.menuRoot.quaternion).distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6);
    const menuBeforeHeadTurn = controls.menuRoot.position.clone();
    const anchoredRig = controls.rig.matrix.clone();
    const turnedHead = head.clone().multiply(new THREE.Matrix4().makeRotationY(.5));
    controls.updateView({ getViewerPose: () => ({ transform: { matrix: turnedHead.elements } }) } as unknown as XRFrame);
    controls.rig.updateMatrix(); assertMatrix(controls.rig.matrix, anchoredRig);
    assert.ok(controls.menuRoot.position.distanceTo(menuBeforeHeadTurn) < 1e-6);
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

 test('timeline mode scrubs shared time and preserves editing, navigation and undo', async () => {
  const { timelineStep, xrTimelineSvg } = await import('./timeline');
  assert.equal(timelineStep({ time: 3, duration: 10, fps: 24 }, .15, .05), 3);
  assert.equal(timelineStep({ time: 9.99, duration: 10, fps: 24 }, 1, 5), 10);
  assert.equal(timelineStep({ time: .01, duration: 10, fps: 24 }, -1, .05), 0);
  assert.match(xrTimelineSvg({ time: 1, duration: 10, fps: 24 }), /Frame 24/);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}) }) } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const reference = new EventTarget();
  const session = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => reference } } as unknown as THREE.WebGLRenderer;
  let time = 5, tracked = true, playing = false;
  const modes: boolean[] = [], actions: string[] = [], phases: string[] = [], selections: string[] = [];
  const target = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  target.position.set(0, 0, -2); target.userData.entityId = 'object-1'; target.updateMatrixWorld();
  let showTarget = false;
  const axes = [0, 0, 1, 0];
  const buttons = Array.from({ length: 6 }, () => ({ pressed: false }));
  const controls = new XRControls(renderer, {
    targets: () => showTarget ? [target] : [], editable: () => true, select: id => selections.push(id), pose: () => pose, transform: (_, __, phase) => { phases.push(phase); return true; },
    menuState: () => ({ playing, canUndo: true }),
    action: action => {actions.push(action);if(action==='play')playing=!playing;}, timelineState: () => ({ time, duration: 10, fps: 24 }),
    seek: value => { time = value; }, timelineChanged: active => modes.push(active),
  });
  const click = (action: number) => { aimMenu(controls, controllers[0], action); controllers[0].dispatchEvent({ type: 'selectstart' } as never); };
  const frame = { getPose: () => tracked ? {} : null } as unknown as XRFrame;
  try {
    controls.start(session as unknown as XRSession, new THREE.Vector3(0, 0, -3));
    controllers[0].dispatchEvent({ type: 'connected', data: { handedness: 'left', targetRaySpace: {}, gripSpace: {}, gamepad: { mapping: 'xr-standard', axes, buttons } } } as never);
    click(5); assert.deepEqual(modes, [true]);
    controls.updateView(frame, 0); controls.updateView(frame, 50); assert.equal(time, 5);
    axes[2] = 0; controls.updateView(frame, 100);
    axes[2] = 1; controls.updateView(frame, 150); assert.ok(Math.abs(time - 5.1) < 1e-9);
    buttons[5].pressed = true; controls.update(frame); assert.deepEqual(actions, ['play']);assert.equal(playing,true);
    const playbackTime=time;controls.updateView(frame,175);controls.update(frame);assert.equal(time,playbackTime);assert.equal(actions.length,1);
    buttons[5].pressed = false; controls.update(frame);
    buttons[5].pressed = true; controls.update(frame);assert.equal(playing,false);assert.deepEqual(actions,['play','play']);
    buttons[5].pressed = false; controls.update(frame);
    controls.updateView(frame,180);assert.equal(time,playbackTime); // held stick must return to neutral after pause
    actions.length=0;
    controllers[0].quaternion.identity(); controllers[0].dispatchEvent({ type: 'squeezestart' } as never);
    grips[0].position.x = 1; controls.updateView(frame, 200); assert.equal(controls.rig.position.x, -1);
    controllers[0].dispatchEvent({ type: 'squeezeend' } as never);
    controls.rig.position.x = 0; grips[0].position.x = 0; showTarget = true;
    controls.updateView(frame, 200);
    controllers[0].dispatchEvent({ type: 'selectstart' } as never);
    assert.deepEqual(selections, ['object-1']);
    controllers[0].dispatchEvent({ type: 'selectend' } as never); phases.length = 0;
    controllers[0].dispatchEvent({ type: 'squeezestart' } as never);
    const grabTime = time; grips[0].position.x = .5;
    controls.updateView(frame, 210); controls.update(frame);
    assert.equal(time, grabTime); assert.deepEqual(phases, ['start', 'change']);
    controllers[0].dispatchEvent({ type: 'squeezeend' } as never);
    assert.deepEqual(phases, ['start', 'change', 'end']);
    controls.updateView(frame, 220); assert.equal(time, grabTime);
    buttons[4].pressed = true; controls.update(frame); assert.deepEqual(actions, ['undo']);
    buttons[4].pressed = false; controls.update(frame); showTarget = false;
    tracked = false; controls.updateView(frame, 250); const stopped = time;
    tracked = true; controls.updateView(frame, 5000); assert.equal(time, stopped);
    axes[2] = 0; controls.updateView(frame, 5050); axes[2] = -1; controls.updateView(frame, 5100); assert.ok(time < stopped);
    click(XR_MENU_TOGGLE); assert.deepEqual(modes, [true]); assert.equal(controls.timelineRoot.visible, true);
    const finalTime = time; controls.updateView(frame, 5150); assert.ok(time < finalTime);
    click(XR_MENU_TOGGLE); click(5); assert.equal(controls.timelineRoot.visible, false);
    buttons[5].pressed = true; controls.update(frame); assert.deepEqual(actions, ['undo', 'play']);
    click(5); controls.stop(); assert.deepEqual(modes, [true, false, true, false]);
  } finally {
    controls.dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('VR trigger selects ghost poses and timeline diamonds without starting document edits', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}) }) } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const reference = new EventTarget(), session = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => reference } } as unknown as THREE.WebGLRenderer;
  const target = new THREE.Mesh(new THREE.BoxGeometry(.4, .4, .4), new THREE.MeshBasicMaterial());
  target.position.set(1, 0, -3); target.userData.entityId = 'cube';
  const selection = { id: 'cube', name: 'Cube', frames: [0, 1, 2].map(time => ({ time, transform: { position: [time, 0, -3], rotation: [0, 0, 0], scale: [1, 1, 1] } as Transform })) };
  let time = 1, edits = 0, hasSelection = true;
  const deletions:(number[]|undefined)[]=[];
  const controls = new XRControls(renderer, {
    targets: () => [target], editable: () => true, select: () => {}, pose: () => pose,
    transform: () => { edits++; return true; }, action: () => {}, timelineObject: () => target,
    deleteKeyframe:times=>deletions.push(times),
    timelineState: () => ({ time, duration: 2, fps: 24, selection: hasSelection ? selection : undefined }),
    seek: value => { time = value; target.position.x = value; target.updateMatrixWorld(); },
  });
  const scene = new THREE.Scene(); scene.add(target, controls.rig, controls.keyframeGhosts.root);
  const fire = (type: string) => controllers[0].dispatchEvent({ type } as never);
  try {
    controls.start(session as unknown as XRSession, new THREE.Vector3(0, 0, -3));
    controllers[0].dispatchEvent({ type: 'connected', data: { gripSpace: {} } } as never);
    aimMenu(controls, controllers[0], 5); fire('selectstart');
    assert.equal(controls.keyframeGhosts.root.children.length, 1);
    controllers[0].quaternion.identity(); fire('squeezestart'); assert.equal(edits, 0);
    fire('selectstart'); assert.equal(time, 0); assert.equal(edits, 0);
    // Aim at the final key on the visible panel, using its actual mesh position.
    let panel: THREE.Object3D | undefined;
    panel = controls.timelineRoot.children[0];
    assert.ok(panel); controls.rig.updateMatrixWorld(true);
    const point = panel.localToWorld(new THREE.Vector3(.96 * (1376 / 1440 - .5), .96 * (200 - 174) / 1440, 0));
    const direction = controls.rig.worldToLocal(point).sub(controllers[0].position).normalize();
    controllers[0].quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction);
    fire('selectstart'); fire('selectend'); assert.equal(time, 2); assert.equal(edits, 0);
    fire('selectstart'); fire('selectend'); // Toggle the second key off, then back on.
    fire('selectstart'); fire('selectend');
    const aimTimeline=(point:THREE.Vector3)=>controllers[0].quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1),controls.rig.worldToLocal(point).sub(controllers[0].position).normalize());
    const deleteButton=controls.timelineRoot.children.find(child=>child.userData.xrAction===XR_DELETE_KEY)!;
    aimTimeline(deleteButton.getWorldPosition(new THREE.Vector3()));fire('selectstart');assert.deepEqual(deletions,[[0,2]]);
    aimTimeline(panel.localToWorld(new THREE.Vector3(0,-.045,0)));fire('selectstart');fire('selectend'); // Empty timeline background clears selection.
    aimTimeline(deleteButton.getWorldPosition(new THREE.Vector3()));fire('selectstart');assert.equal(deletions[1],undefined);
    const aimTime=(t:number)=>aimTimeline(panel.localToWorld(new THREE.Vector3(.96*((64+1312*t/2)/1440-.5),-.045,0)));
    const dragFrame={getPose:()=>({})} as unknown as XRFrame;
    aimTime(.1);fire('selectstart');aimTime(1.9);controls.update(dragFrame);fire('selectend');
    aimTimeline(deleteButton.getWorldPosition(new THREE.Vector3()));fire('selectstart');assert.deepEqual(deletions[2],[1]);
    aimTime(2);fire('selectstart');aimTime(0);controls.update(dragFrame);fire('selectend');
    aimTimeline(deleteButton.getWorldPosition(new THREE.Vector3()));fire('selectstart');assert.deepEqual(deletions[3],[0,1,2]);
    assert.equal(edits,0); // Range selection never starts an object transform.
    hasSelection = false; controls.updateView(undefined, 100);
    assert.equal(controls.keyframeGhosts.root.children.length, 0);
    hasSelection = true; controls.updateView(undefined, 200);
    assert.equal(controls.keyframeGhosts.root.children.length, 1);
    aimMenu(controls, controllers[0], 5); fire('selectstart'); assert.equal(controls.keyframeGhosts.root.children.length, 0);
    aimMenu(controls, controllers[0], 5); fire('selectstart'); controls.stop(); assert.equal(controls.keyframeGhosts.root.children.length, 0);
  } finally {
    controls.dispose(); target.geometry.dispose(); (target.material as THREE.Material).dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('timeline grip edits the selected object through ghosts, including camera-follow view', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}) }) } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const reference = new EventTarget(), session = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => reference } } as unknown as THREE.WebGLRenderer;
  const target = new THREE.Mesh(new THREE.BoxGeometry(.4, .4, .4), new THREE.MeshBasicMaterial());
  target.position.set(0, 0, -4); target.userData.entityId = 'cube';
  const selection = { id: 'cube', name: 'Cube', frames: [0, 1].map(time => ({ time, transform: { position: [0, 0, time ? -4 : -2], rotation: [0, 0, 0], scale: [1, 1, 1] } as Transform })) };
  const phases: string[] = [], updates: Transform[] = [];
  let time = 1;
  const controls = new XRControls(renderer, {
    targets: () => [target], editable: () => true, select: () => {}, pose: () => selection.frames[1].transform,
    transform: (_, pose, phase) => { phases.push(phase); updates.push(pose); return true; }, action: () => {},
    followCamera: () => new THREE.PerspectiveCamera(), timelineObject: () => target,
    timelineState: () => ({ time, duration: 2, fps: 24, selection }), seek: value => { time = value; },
  });
  const scene = new THREE.Scene(); scene.add(target, controls.rig, controls.keyframeGhosts.root);
  const fire = (type: string) => controllers[0].dispatchEvent({ type } as never);
  const click = (action: number) => { aimMenu(controls, controllers[0], action); fire('selectstart'); controllers[0].quaternion.identity(); };
  const frame = { getPose: () => ({}) } as unknown as XRFrame;
  try {
    controls.start(session as unknown as XRSession, new THREE.Vector3(0, 0, -3));
    controllers[0].dispatchEvent({ type: 'connected', data: { gripSpace: {} } } as never);
    click(5);
    for (const following of [false, true]) {
      if (following) click(3);
      phases.length = 0; updates.length = 0; grips[0].position.x = 0;
      fire('squeezestart'); grips[0].position.x = .5; controls.update(frame); fire('squeezeend');
      assert.deepEqual(phases, ['start', 'change', 'end']);
      assert.equal(updates[1].position[0], .5); assert.equal(time, 1);
    }
    fire('selectstart'); assert.equal(time, 0); // Trigger still picks the nearer ghost.
    click(5); phases.length = 0; fire('squeezestart');
    assert.deepEqual(phases, []); // Ordinary camera-follow viewing remains read-only.
  } finally {
    controls.dispose(); target.geometry.dispose(); (target.material as THREE.Material).dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('XR close inspection stays visible across world scales and camera follow transitions', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}) }) } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => new EventTarget() } } as unknown as THREE.WebGLRenderer;
  const shot = new THREE.PerspectiveCamera(45, 1, .1, 500);
  const controls = new XRControls(renderer, { targets: () => [], editable: () => true, select: () => {}, pose: () => pose, transform: () => true, action: () => {}, followCamera: () => shot });
  const session = Object.assign(new EventTarget(), { visibilityState: 'visible' }) as unknown as XRSession;
  const frame = { getViewerPose: () => ({ transform: { matrix: new THREE.Matrix4().elements } }) } as unknown as XRFrame;
  try {
    controls.start(session, new THREE.Vector3(0, 0, -3));
    for (const scale of [.05, 1, 20]) {
      controls.rig.scale.setScalar(scale); controls.updateView();
      // Emulate an eye projection using the near plane passed to WebXRManager.
      const eye = new THREE.PerspectiveCamera(90, 1, controls.camera.near, controls.camera.far);
      eye.scale.setScalar(scale); eye.updateMatrixWorld(true);
      const projected = new THREE.Vector3(0, 0, -.01).project(eye);
      assert.ok(projected.z > -1 && projected.z < 1, `A surface 1 cm away must survive scale ${scale}`);
    }
    aimMenu(controls, controllers[0], 3); controllers[0].dispatchEvent({ type: 'selectstart' } as never);
    controls.updateView(frame); assert.equal(controls.camera.near, .005); assert.equal(shot.near, .1);
    aimMenu(controls, controllers[0], 3); controllers[0].dispatchEvent({ type: 'selectstart' } as never);
    controls.updateView(); assert.ok(controls.camera.near < .005);
    controls.stop(); controls.start(session, new THREE.Vector3()); assert.equal(controls.camera.near, .005);
  } finally {
    controls.dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('near sphere replaces the ray, grips the highlighted object and restores distant interaction', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}) }) } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const reference = new EventTarget(), session = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => reference } } as unknown as THREE.WebGLRenderer;
  const geometry = new THREE.BoxGeometry(.1, .1, .1), material = new THREE.MeshBasicMaterial();
  const near = new THREE.Mesh(geometry, material), far = new THREE.Mesh(geometry, material);
  near.position.set(.3, 0, -.5); far.position.set(0, 0, -3); near.userData.entityId = 'near'; far.userData.entityId = 'far';
  const phases: string[] = [], selected: string[] = [];
  let tracked = true;
  const controls = new XRControls(renderer, {
    targets: () => [near, far], editable: () => true, select: id => selected.push(id),
    pose: id => ({ position: (id === 'near' ? near : far).position.toArray(), rotation: [0, 0, 0], scale: [1, 1, 1] }),
    transform: (id, pose, phase) => { phases.push(`${id}:${phase}`); (id === 'near' ? near : far).position.fromArray(pose.position); return true; }, action: () => {},
  });
  const scene = new THREE.Scene(); scene.add(near, far, controls.rig, controls.nearSelection.root);
  const fire = (type: string) => controllers[0].dispatchEvent({ type } as never);
  const frame = { getPose: () => tracked ? {} : null } as unknown as XRFrame;
  const ray = controllers[0].getObjectByName('XR pointer')!;
  const sphere = grips[0].getObjectByName('Grab range')!;
  try {
    controls.start(session as unknown as XRSession, new THREE.Vector3(0, 0, -3));
    controllers[0].dispatchEvent({ type: 'connected', data: { gripSpace: {} } } as never);
    grips[0].position.set(.3, 0, -.25); controls.update(frame);
    assert.equal(ray.visible, false); assert.equal(sphere.visible, true); assert.equal(controls.nearSelection.root.children[0].visible, false);
    fire('squeezestart'); fire('squeezeend'); assert.deepEqual(phases, []); // Neither distant grab nor navigation.
    grips[0].position.z = -.4; controls.update(frame); assert.equal(controls.nearSelection.root.children[0].visible, true);
    fire('selectstart'); assert.deepEqual(selected, ['near']);
    fire('squeezestart'); grips[0].position.x += .2; controls.update(frame); fire('squeezeend');
    assert.deepEqual(phases, ['near:start', 'near:change']); // Grip release cannot end a trigger-owned grab.
    fire('selectend'); fire('selectend');
    assert.deepEqual(phases, ['near:start', 'near:change', 'near:end']); assert.ok(Math.abs(near.position.x - .5) < 1e-6);
    tracked = false; controls.update(frame); assert.equal(sphere.visible, false); assert.equal(controls.nearSelection.root.children[0].visible, false);
    tracked = true; grips[0].position.set(0, 0, 0); controls.update(frame); assert.equal(ray.visible, true); assert.equal(sphere.visible, false);
    fire('squeezestart'); fire('squeezeend'); assert.deepEqual(phases.slice(-2), ['far:start', 'far:end']);
    grips[0].position.copy(near.position); controls.update(frame); assert.equal(sphere.visible, true);
    fire('disconnected'); assert.equal(sphere.visible, false); assert.equal(controls.nearSelection.root.children[0].visible, false);
    controls.stop(); assert.ok(controls.nearSelection.root.children.every(child => !child.visible));
  } finally {
    controls.dispose(); geometry.dispose(); material.dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('XR feedback distinguishes hover, selection and held objects, then clears on tracking loss and exit', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}) }) } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const session = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => new EventTarget() } } as unknown as THREE.WebGLRenderer;
  const target = new THREE.Mesh(new THREE.BoxGeometry(.3, .3, .3), new THREE.MeshBasicMaterial());
  target.position.z = -2; target.userData.entityId = 'object';
  let selected = false, tracked = true;
  const controls = new XRControls(renderer, {
    targets: () => [target], selected: () => selected ? [target] : [], editable: () => true,
    select: () => { selected = true; }, pose: () => ({ position: target.position.toArray(), rotation: [0, 0, 0], scale: [1, 1, 1] }),
    transform: (_, pose) => { target.position.fromArray(pose.position); return true; }, action: () => {},
  });
  const frame = { getPose: () => tracked ? {} : null } as unknown as XRFrame;
  const fire = (type: string, data?: unknown) => controllers[0].dispatchEvent({ type, data } as never);
  const colors = () => {
    const result: string[] = [];
    controls.feedbackRoot.traverseVisible(node => { if (node instanceof THREE.Mesh) result.push((node.material as THREE.MeshBasicMaterial).color.getHexString()); });
    return result;
  };
  try {
    controls.start(session as unknown as XRSession, new THREE.Vector3(0, 0, -3));
    fire('connected', { gripSpace: {}, targetRaySpace: {} }); controls.update(frame);
    const pointer = controllers[0].getObjectByName('XR pointer')!;
    assert.equal(pointer.visible, true); assert.ok(colors().includes('c9f86b'));
    fire('selectstart'); fire('selectend'); controllers[0].rotation.y = Math.PI / 2; controls.update(frame);
    assert.ok(colors().includes('62dded')); assert.ok(!colors().includes('c9f86b'));
    controllers[0].quaternion.identity(); fire('squeezestart'); grips[0].position.x = .1; controls.update(frame);
    assert.ok(colors().includes('ffbd66')); assert.equal(target.position.x, .1);
    tracked = false; controls.update(frame); assert.equal(pointer.visible, false); assert.ok(!colors().includes('ffbd66'));
    controls.stop(); assert.equal(controls.feedbackRoot.visible, false); assert.equal(pointer.visible, false);
  } finally {
    controls.dispose(); target.geometry.dispose(); (target.material as THREE.Material).dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('left Menu toggles modes UI without hiding timeline; thumbstick fallback and held-button rearming work', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}) }) } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const session = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => new EventTarget() } } as unknown as THREE.WebGLRenderer;
  const buttons = Array.from({ length: 8 }, () => ({ pressed: false }));
  const source = { handedness: 'left', profiles: ['oculus-touch-v3'], gripSpace: {}, gamepad: { mapping: 'xr-standard', buttons } };
  const controls = new XRControls(renderer, { targets: () => [], editable: () => true, select: () => {}, pose: () => pose, transform: () => true, action: () => {}, timelineState: () => ({ time: 1, duration: 5, fps: 24 }) });
  const expanded = () => controls.menuRoot.children.filter(child => child.visible).length > 1;
  const fire = (type: string, data?: unknown) => controllers[0].dispatchEvent({ type, data } as never);
  const release = (index: number) => { buttons[index].pressed = false; controls.update(); };
  const press = (index: number) => { buttons[index].pressed = true; controls.update(); };
  try {
    controls.start(session as unknown as XRSession, new THREE.Vector3(0, 0, -3));
    fire('connected', source); aimMenu(controls, controllers[0], 5); fire('selectstart');
    const position = controls.timelineRoot.position.clone();
    press(6); assert.equal(expanded(), true); release(6); // Thumb-rest is never Menu.
    press(7); controls.update(); assert.equal(expanded(), false); assert.equal(controls.timelineRoot.visible, true);
    release(7); controls.rig.position.x = 2; press(7); assert.equal(expanded(), true);
    assert.ok(controls.timelineRoot.position.distanceTo(position) < 1e-6);
    fire('disconnected'); fire('connected', source); controls.update(); assert.equal(expanded(), true);
    release(7); press(7); assert.equal(expanded(), false);
    session.visibilityState = 'hidden'; session.dispatchEvent(new Event('visibilitychange'));
    session.visibilityState = 'visible'; session.dispatchEvent(new Event('visibilitychange')); controls.update();
    assert.equal(expanded(), false); release(7); press(7); assert.equal(expanded(), true);
    fire('disconnected'); source.profiles = ['oculus-touch-v2']; fire('connected', source);
    press(3); assert.equal(expanded(), false); release(3); press(3); assert.equal(expanded(), true);
    assert.equal(controls.timelineRoot.visible, true);
    aimMenu(controls, controllers[0], 5); fire('selectstart'); assert.equal(controls.timelineRoot.visible, false);
  } finally {
    controls.dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('left Y toggles playback once, ignores right B and consumes held presses across grabs and reconnects', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}) }) } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const session = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => new EventTarget() } } as unknown as THREE.WebGLRenderer;
  const buttons = () => Array.from({ length: 6 }, () => ({ pressed: false }));
  const left = { handedness: 'left', gripSpace: {}, gamepad: { mapping: 'xr-standard', buttons: buttons() } };
  const right = { handedness: 'right', gripSpace: {}, gamepad: { mapping: 'xr-standard', buttons: buttons() } };
  let playing = false;
  const actions: string[] = [];
  const controls = new XRControls(renderer, {
    targets: () => [], editable: () => true, select: () => {}, pose: () => pose, transform: () => true,
    action: action => { actions.push(action); if (action === 'play') playing = !playing; }, menuState: () => ({ playing, canUndo: true }),
  });
  const fire = (type: string, data?: unknown) => controllers[1].dispatchEvent({ type, data } as never);
  const release = () => { left.gamepad.buttons[5].pressed = false; controls.update(); };
  const press = () => { left.gamepad.buttons[5].pressed = true; controls.update(); };
  try {
    controls.start(session as unknown as XRSession, new THREE.Vector3(0, 0, -3));
    left.gamepad.buttons[5].pressed = true; fire('connected', left);
    controllers[0].dispatchEvent({ type: 'connected', data: right } as never);
    right.gamepad.buttons[5].pressed = true; controls.update(); assert.deepEqual(actions, []);
    release(); press(); controls.update(); assert.deepEqual(actions, ['play']); assert.equal(playing, true);
    release(); press(); assert.equal(playing, false); assert.equal(actions.length, 2);
    release(); fire('squeezestart'); press(); fire('squeezeend'); controls.update();
    assert.equal(actions.length, 2); // Ending locomotion cannot replay the held Y press.
    release(); press(); assert.equal(actions.length, 3);
    session.visibilityState = 'hidden'; session.dispatchEvent(new Event('visibilitychange')); controls.update();
    session.visibilityState = 'visible'; session.dispatchEvent(new Event('visibilitychange')); controls.update();
    assert.equal(actions.length, 3);
    release(); press(); assert.equal(actions.length, 4);
    fire('disconnected'); fire('connected', left); controls.update(); assert.equal(actions.length, 4);
    release(); press(); assert.equal(actions.length, 5);
    controls.stop(); release(); press(); assert.equal(actions.length, 5);
  } finally {
    controls.dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('left X undoes once per press, ignores right A, and rearms after visibility/reconnect', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}) }) } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const session = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const renderer = { xr: { getController: (i: number) => controllers[i], getControllerGrip: (i: number) => grips[i], getReferenceSpace: () => new EventTarget() } } as unknown as THREE.WebGLRenderer;
  const actions: string[] = []; let canUndo = true;
  const buttons = () => Array.from({ length: 6 }, () => ({ pressed: false, touched: false, value: 0 }));
  const left = { handedness: 'left', gamepad: { mapping: 'xr-standard', buttons: buttons() } };
  const right = { handedness: 'right', gamepad: { mapping: 'xr-standard', buttons: buttons() } };
  const controls = new XRControls(renderer, { targets: () => [], editable: () => true, select: () => {}, pose: () => pose, transform: () => true, action: action => actions.push(action), menuState: () => ({ playing: false, canUndo }) });
  try {
    controls.start(session as unknown as XRSession, new THREE.Vector3());
    // Handedness, not controller index, decides which button is X.
    controllers[0].dispatchEvent({ type: 'connected', data: right } as never);
    controllers[1].dispatchEvent({ type: 'connected', data: left } as never);
    right.gamepad.buttons[4].pressed = true; controls.update(); assert.deepEqual(actions, []);
    left.gamepad.buttons[4].pressed = true; controls.update(); controls.update(); assert.deepEqual(actions, ['undo']);
    left.gamepad.buttons[4].pressed = false; controls.update(); left.gamepad.buttons[4].pressed = true; controls.update(); assert.equal(actions.length, 2);
    canUndo = false; left.gamepad.buttons[4].pressed = false; controls.update(); left.gamepad.buttons[4].pressed = true; controls.update();
    canUndo = true; controls.update(); assert.equal(actions.length, 2);
    session.visibilityState = 'hidden'; session.dispatchEvent(new Event('visibilitychange')); controls.update();
    session.visibilityState = 'visible'; session.dispatchEvent(new Event('visibilitychange')); controls.update(); assert.equal(actions.length, 2);
    left.gamepad.buttons[4].pressed = false; controls.update(); left.gamepad.buttons[4].pressed = true; controls.update(); assert.equal(actions.length, 3);
    controllers[1].dispatchEvent({ type: 'disconnected' } as never);
    controllers[1].dispatchEvent({ type: 'connected', data: left } as never); controls.update(); assert.equal(actions.length, 3);
    left.gamepad.buttons[4].pressed = false; controls.update(); left.gamepad.buttons[4].pressed = true; controls.update(); assert.equal(actions.length, 4);
    controls.stop(); controls.update(); assert.equal(actions.length, 4);
  } finally {
    controls.dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});
