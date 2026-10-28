import * as THREE from 'three';
import { XRMenu, XR_MENU_TOGGLE } from './xr-menu';
import type { Transform } from './types';
import type { TransformPhase } from './placement/transforms';

/** A translation gesture preserves rotation, scale and the initial grab offset. */
export function translatedGrab(start: Transform, origin: THREE.Vector3, current: THREE.Vector3): Transform {
  const pose = structuredClone(start);
  pose.position = pose.position.map((v, i) => THREE.MathUtils.clamp(v + current.getComponent(i) - origin.getComponent(i), -1000, 1000)) as Transform['position'];
  return pose;
}

interface Options {
  targets(): THREE.Object3D[];
  editable(): boolean;
  select(id: string): void;
  pose(id: string): Transform | undefined;
  transform(id: string, pose: Transform, phase: TransformPhase): boolean;
  action(action: 'play' | 'undo'): void;
  followCamera?(): THREE.Camera | null;
  menuState?(): { playing: boolean; canUndo: boolean };
}

interface NavigationGrab {
  indices: number[];
  hand: THREE.Vector3;
  span: THREE.Vector3 | null;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  scale: number;
  heading: number | null;
  yaw: number;
}

const MIN_HAND_DISTANCE = .08;
const MIN_VIEW_SCALE = .05;
const MAX_VIEW_SCALE = 20;

/** Small XR adapter. All document edits go through the existing editor transaction. */
export class XRControls {
  readonly camera = new THREE.PerspectiveCamera(60, 1, .05, 500);
  readonly rig = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private sources = new Map<number, XRInputSource>();
  private controllers: THREE.Group[] = [];
  private grips: THREE.Group[] = [];
  private lines: THREE.Line[] = [];
  private menu = new XRMenu();
  private cleanups: (() => void)[] = [];
  private grab: { index: number; id: string; start: Transform; origin: THREE.Vector3; latest: Transform } | null = null;
  private locomotion: NavigationGrab | null = null;
  private session: XRSession | null = null;
  private reference: XRReferenceSpace | null = null;
  private following = false;
  private headAnchor: THREE.Matrix4 | null = null;
  private freeRig = new THREE.Matrix4();

  constructor(private renderer: THREE.WebGLRenderer, private options: Options) {
    this.camera.layers.enable(3);
    this.rig.add(this.camera);
    this.rig.visible = false;
    for (let index = 0; index < 2; index++) {
      const controller = renderer.xr.getController(index), grip = renderer.xr.getControllerGrip(index);
      this.controllers.push(controller); this.grips.push(grip); this.rig.add(controller, grip);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: '#326e89' }));
      line.scale.z = 8; controller.add(line); this.lines.push(line);
      const connected = (event: { data: XRInputSource }) => this.sources.set(index, event.data);
      const disconnected = () => { if (this.grab?.index === index || this.locomotion?.indices.includes(index)) this.finish(true); this.sources.delete(index); };
      const select = () => this.select(index);
      const squeeze = () => this.begin(index);
      const release = () => {
        if (this.grab?.index === index) this.finish(false);
        else if (this.locomotion?.indices.includes(index)) {
          const remaining = this.locomotion.indices.filter(hand => hand !== index);
          this.locomotion = remaining.length ? this.navigationGrab(remaining) : null;
        }
      };
      controller.addEventListener('connected', connected);
      controller.addEventListener('disconnected', disconnected);
      controller.addEventListener('selectstart', select);
      controller.addEventListener('squeezestart', squeeze);
      controller.addEventListener('squeezeend', release);
      this.cleanups.push(() => {
        controller.removeEventListener('connected', connected); controller.removeEventListener('disconnected', disconnected);
        controller.removeEventListener('selectstart', select); controller.removeEventListener('squeezestart', squeeze); controller.removeEventListener('squeezeend', release);
      });
    }
    this.camera.add(this.menu.root);
  }

  start(session: XRSession, target: THREE.Vector3): void {
    this.session = session; this.rig.position.set(target.x, 0, target.z + 3); this.rig.quaternion.identity(); this.rig.scale.setScalar(1); this.rig.visible = true;
    if (!this.menu.expanded) this.menu.toggle();
    this.syncMenu();
    session.addEventListener('visibilitychange', this.visibility);
    this.reference = this.renderer.xr.getReferenceSpace();
    this.reference?.addEventListener('reset', this.reset);
  }
  stop(): void {
    this.finish(true);
    this.leaveCamera();
    this.session?.removeEventListener('visibilitychange', this.visibility);
    this.reference?.removeEventListener('reset', this.reset); this.reference = null;
    this.session = null; this.sources.clear(); this.rig.visible = false;
  }
  private visibility = () => { if (this.session?.visibilityState !== 'visible') this.finish(true); };
  private reset = () => { this.finish(true); this.leaveCamera(); };

  /** Anchor the tracked head once, then carry the entire XR rig with the shot camera.
   * Current head motion remains relative to that anchor; headset FOV is never overwritten. */
  updateView(frame?: XRFrame): void {
    this.updateLocomotion(frame);
    const target = this.options.followCamera?.();
    if (this.following && !target) this.leaveCamera();
    this.syncMenu();
    if (!this.following || !target || !this.reference) return;
    const viewer = frame?.getViewerPose(this.reference);
    if (!viewer) return;
    if (!this.headAnchor) this.headAnchor = new THREE.Matrix4().fromArray(viewer.transform.matrix).invert();
    target.updateWorldMatrix(true, false);
    const matrix = target.matrixWorld.clone().multiply(this.headAnchor);
    matrix.decompose(this.rig.position, this.rig.quaternion, this.rig.scale);
  }

  private toggleCamera(): void {
    if (this.following) { this.leaveCamera(); return; }
    if (!this.options.followCamera?.()) return;
    this.finish(true); this.rig.updateMatrix(); this.freeRig.copy(this.rig.matrix);
    this.following = true; this.headAnchor = null;
    this.camera.layers.disable(3);
  }

  private leaveCamera(): void {
    if (this.following) this.freeRig.decompose(this.rig.position, this.rig.quaternion, this.rig.scale);
    this.following = false; this.headAnchor = null; this.camera.layers.enable(3);
  }
  private syncMenu(): void {
    const playback = this.options.menuState?.() ?? { playing: false, canUndo: false };
    this.menu.setState({ ...playback, following: this.following, hasCamera: !!this.options.followCamera?.(), scale: this.following ? 1 : 1 / this.rig.scale.x });
  }
  private hit(index: number): THREE.Intersection | undefined {
    if (!this.session || this.session.visibilityState !== 'visible' || !this.controllers[index].visible) return;
    this.rig.updateMatrixWorld(true);
    const controller = this.controllers[index];
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
    this.raycaster.layers.enable(3);
    this.raycaster.far = 30 * this.rig.scale.x;
    const ui = this.raycaster.intersectObjects(this.menu.targets(), false)[0];
    return ui ?? this.raycaster.intersectObjects(this.options.targets(), true).find(hit => {
      for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) if (!node.visible) return false;
      return true;
    });
  }
  private entity(hit?: THREE.Intersection): string | undefined {
    for (let node: THREE.Object3D | null = hit?.object ?? null; node; node = node.parent) if (node.userData.entityId) return node.userData.entityId;
  }
  private select(index: number): void {
    if (this.grab || this.locomotion) return;
    const hit = this.hit(index); if (!hit) return;
    const action = hit.object.userData.xrAction;
    if (action !== undefined) {
      this.syncMenu();
      if (!this.menu.enabled(action)) return;
      if (action === XR_MENU_TOGGLE) this.menu.toggle();
      else if (action === 3) this.toggleCamera();
      else if (action === 2) void this.session?.end().catch(() => {});
      else this.options.action(action === 0 ? 'play' : 'undo');
      return;
    }
    const id = this.entity(hit); if (id && !this.following && this.options.editable()) this.options.select(id);
  }
  private begin(index: number): void {
    if (this.following || this.grab || this.session?.visibilityState !== 'visible' || !this.controllers[index].visible || !this.grips[index].visible || !this.sources.get(index)?.gripSpace) return;
    const hit = this.hit(index);
    if (this.locomotion) {
      if (!hit && !this.locomotion.indices.includes(index)) this.locomotion = this.navigationGrab([...this.locomotion.indices, index]);
      return;
    }
    // UI and objects own their grip gestures, even when editing is locked.
    if (!hit) {
      this.locomotion = this.navigationGrab([index]);
      return;
    }
    const id = this.entity(hit); if (!id || !this.options.editable()) return;
    this.options.select(id);
    const start = this.options.pose(id); if (!start) return;
    if (!this.options.transform(id, start, 'start')) return;
    this.grab = { index, id, start, latest: start, origin: this.grips[index].getWorldPosition(new THREE.Vector3()) };
  }
  private navigationGrab(indices: number[]): NavigationGrab {
    const hand = this.grips[indices[0]].position.clone();
    let span: THREE.Vector3 | null = null;
    if (indices.length === 2) {
      const second = this.grips[indices[1]].position;
      span = second.clone().sub(hand); hand.add(second).multiplyScalar(.5);
      if (span.length() < MIN_HAND_DISTANCE) span = null;
    }
    const heading = span && Math.hypot(span.x, span.z) >= MIN_HAND_DISTANCE ? Math.atan2(span.x, span.z) : null;
    return { indices, hand, span, position: this.rig.position.clone(), rotation: this.rig.quaternion.clone(), scale: this.rig.scale.x,
      heading, yaw: new THREE.Euler().setFromQuaternion(this.rig.quaternion, 'YXZ').y };
  }

  private updateLocomotion(frame?: XRFrame): void {
    const move = this.locomotion; if (!move) return;
    const tracked = move.indices.every(index => {
      const source = this.sources.get(index);
      return source?.gripSpace && this.reference && frame?.getPose(source.gripSpace, this.reference);
    });
    if (this.following || this.session?.visibilityState !== 'visible' || !tracked) {
      // Keep the last stable viewing position on interruption; never snap back.
      this.locomotion = null; return;
    }
    const current = this.grips[move.indices[0]].position.clone();
    if (move.indices.length === 1) {
      // Reference-space deltas avoid feeding rig motion back into the next frame.
      const delta = current.sub(move.hand).multiplyScalar(move.scale).applyQuaternion(move.rotation);
      this.rig.position.copy(move.position).sub(delta);
      return;
    }
    const second = this.grips[move.indices[1]].position;
    const span = second.clone().sub(current);
    current.add(second).multiplyScalar(.5);
    // Coincident hands have no usable rotation/scale. Freeze, then re-anchor
    // when separated again so crossing controllers cannot produce a jump.
    if (span.length() < MIN_HAND_DISTANCE) { move.span = null; return; }
    if (!move.span) { this.locomotion = this.navigationGrab(move.indices); return; }
    // Navigation turns only around world up. Ignore hand height for heading,
    // and re-anchor heading after a vertical span rather than snapping 180°.
    const heading = Math.hypot(span.x, span.z) >= MIN_HAND_DISTANCE ? Math.atan2(span.x, span.z) : null;
    if (heading !== null && move.heading !== null) {
      const delta = move.heading - heading;
      move.yaw += Math.atan2(Math.sin(delta), Math.cos(delta));
    }
    move.heading = heading;
    this.rig.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), move.yaw);
    const scale = THREE.MathUtils.clamp(move.scale * move.span.length() / span.length(), MIN_VIEW_SCALE, MAX_VIEW_SCALE);
    this.rig.scale.setScalar(scale);
    const anchor = move.hand.clone().multiplyScalar(move.scale).applyQuaternion(move.rotation).add(move.position);
    this.rig.position.copy(anchor).sub(current.multiplyScalar(scale).applyQuaternion(this.rig.quaternion));
  }

  update(frame?: XRFrame): void {
    if (!this.session) return;
    const hovered: number[] = [];
    this.controllers.forEach((_, index) => {
      const hit = this.hit(index); this.lines[index].scale.z = hit ? hit.distance / this.rig.scale.x : 8;
      const action = hit?.object.userData.xrAction;
      if (typeof action === 'number' && this.menu.enabled(action)) hovered.push(action);
      (this.lines[index].material as THREE.LineBasicMaterial).color.set(action !== undefined ? this.menu.enabled(action) ? '#d7e9b2' : '#789084' : hit ? '#c97935' : '#326e89');
    });
    this.menu.hover(hovered);
    const grab = this.grab; if (!grab) return;
    const source = this.sources.get(grab.index), reference = this.renderer.xr.getReferenceSpace();
    if (!this.options.editable() || !source?.gripSpace || !reference || !frame?.getPose(source.gripSpace, reference)) { this.finish(true); return; }
    grab.latest = translatedGrab(grab.start, grab.origin, this.grips[grab.index].getWorldPosition(new THREE.Vector3()));
    if (!this.options.transform(grab.id, grab.latest, 'change')) this.finish(true);
  }
  private finish(cancel: boolean): void {
    this.locomotion = null;
    const grab = this.grab; this.grab = null;
    if (grab) this.options.transform(grab.id, cancel ? grab.start : grab.latest, cancel ? 'cancel' : 'end');
  }
  dispose(): void {
    this.stop(); this.cleanups.forEach(cleanup => cleanup()); this.rig.removeFromParent();
    this.lines.forEach(line => { line.removeFromParent(); line.geometry.dispose(); (line.material as THREE.Material).dispose(); });
    this.menu.dispose();
  }
}
