import * as THREE from 'three';
import { XRMenu, XR_MENU_TOGGLE, XR_MENU_DRAG, XR_TIMELINE_DRAG, XR_ADD_KEY, XR_DELETE_KEY, XR_RECORD, XR_RECORD_PREVIEW, XR_RECORD_APPLY, XR_RECORD_DISCARD } from './menu';
import type { XRRecordAction } from './recording';
import { XRMenuSpace } from './menu-space';
import { menuButtonBinding } from './buttons';
import { timelineStep, XRKeyframeMultiSelection, type XRTimelineState } from './timeline';
import { XRKeyframeGhosts } from './keyframe-ghosts';
import { XRControllerVisual } from './controller-visual';
import { XRNearSelection, type NearSelection } from './near-selection';
import { XRPointerFeedback, XRObjectOutline, XRSelectionFeedback, XR_FEEDBACK } from './feedback';
import type { Transform } from '../types';
import type { TransformPhase } from '../placement/transforms';

/** A translation gesture preserves rotation, scale and the initial grab offset. */
export function translatedGrab(start: Transform, origin: THREE.Vector3, current: THREE.Vector3): Transform {
  const pose = structuredClone(start);
  pose.position = pose.position.map((v, i) => THREE.MathUtils.clamp(v + current.getComponent(i) - origin.getComponent(i), -1000, 1000)) as Transform['position'];
  return pose;
}

/** Rigid near grab: rotate around the original grip point, preserving its offset. */
export function rotatedGrab(start: Transform, origin: THREE.Vector3, current: THREE.Vector3, initial: THREE.Quaternion, rotation: THREE.Quaternion): Transform {
  const delta = rotation.clone().multiply(initial.clone().invert());
  if (delta.angleTo(new THREE.Quaternion()) < 1e-8) return translatedGrab(start, origin, current);
  const position = new THREE.Vector3(...start.position).sub(origin).applyQuaternion(delta).add(current);
  const orientation = delta.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...start.rotation.map(THREE.MathUtils.degToRad) as [number, number, number])));
  const angles = new THREE.Euler().setFromQuaternion(orientation);
  return { position: position.toArray().map(value => THREE.MathUtils.clamp(value, -1000, 1000)) as Transform['position'],
    rotation: [angles.x, angles.y, angles.z].map(THREE.MathUtils.radToDeg) as Transform['rotation'], scale: [...start.scale] };
}

interface Options {
  timelineState?(): XRTimelineState;
  timelineObject?(id: string): THREE.Object3D | undefined;
  seek?(time: number): void;
  addKeyframe?(): void;
  deleteKeyframe?(times?: number[]): void;
  recordAction?(action: XRRecordAction): void;
  timelineChanged?(active: boolean): void;
  targets(): THREE.Object3D[];
  selected?(): THREE.Object3D[];
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
const XR_NEAR = .005;

/** Small XR adapter. All document edits go through the existing editor transaction. */
export class XRControls {
  readonly camera = new THREE.PerspectiveCamera(60, 1, XR_NEAR, 500);
  readonly rig = new THREE.Group();
  readonly keyframeGhosts = new XRKeyframeGhosts();
  readonly nearSelection = new XRNearSelection();
  readonly feedbackRoot = new THREE.Group();
  private selectionFeedback = new XRSelectionFeedback();
  private hoverOutlines: XRObjectOutline[] = [];
  private nearTracked = new Map<number, boolean>();
  private raycaster = new THREE.Raycaster();
  private sources = new Map<number, XRInputSource>();
  private buttonPressed = new Map<number, boolean[]>();
  private menuPressed = new Map<number, { index: number; pressed: boolean }>();
  private controllers: THREE.Group[] = [];
  private grips: THREE.Group[] = [];
  private controllerVisuals: XRControllerVisual[] = [];
  private pointers: XRPointerFeedback[] = [];
  private menu = new XRMenu();
  readonly menuRoot = this.menu.root;
  readonly timelineRoot = this.menu.timelineRoot;
  private timelineSpace = new XRMenuSpace(this.timelineRoot);
  private menuSpace = new XRMenuSpace(this.menuRoot);
  private menuDrag: number | null = null;
  private draggingTimeline = false;
  private viewerLocal = new THREE.Matrix4();
  private menuNeedsPlacement = true;
  private cleanups: (() => void)[] = [];
  private grab: { index: number; input: 'grip' | 'trigger'; id: string; start: Transform; origin: THREE.Vector3; orientation: THREE.Quaternion; latest: Transform; near: boolean } | null = null;
  private locomotion: NavigationGrab | null = null;
  private session: XRSession | null = null;
  private reference: XRReferenceSpace | null = null;
  private timeline = false;
  private keySelection = new XRKeyframeMultiSelection();
  private keyDrag: { index: number; id: string; startU: number; from: number; to: number; previous: number[]; moved: boolean } | null = null;
  private timelineArmed = false;
  private timelineTime: number | null = null;
  private timelinePaint = -Infinity;
  private following = false;
  private headAnchor: THREE.Matrix4 | null = null;
  private freeRig = new THREE.Matrix4();
  private menuFollowAnchor: THREE.Matrix4 | null = null;

  constructor(private renderer: THREE.WebGLRenderer, private options: Options) {
    this.camera.layers.enable(3);
    this.rig.add(this.camera);
    this.rig.visible = false;
    this.feedbackRoot.add(this.selectionFeedback.root);
    for (let index = 0; index < 2; index++) {
      const controller = renderer.xr.getController(index), grip = renderer.xr.getControllerGrip(index);
      this.controllers.push(controller); this.grips.push(grip); this.rig.add(controller, grip);
      const visual = new XRControllerVisual(grip); this.controllerVisuals.push(visual);
      this.nearSelection.addHand(grip);
      this.pointers.push(new XRPointerFeedback(controller));
      const outline = new XRObjectOutline(); this.hoverOutlines.push(outline); this.feedbackRoot.add(outline.root);
      const connected = (event: { data: XRInputSource }) => { this.sources.set(index, event.data); this.buttonPressed.set(index, [4, 5].map(button => !!event.data.gamepad?.buttons?.[button]?.pressed)); const binding = menuButtonBinding(event.data); if (binding) this.menuPressed.set(index, { index: binding.index, pressed: !!event.data.gamepad?.buttons[binding.index]?.pressed }); this.nearTracked.set(index, true); visual.connect(event.data); };
      const disconnected = () => { visual.disconnect(); this.pointers[index].root.visible = false; this.hoverOutlines[index].root.visible = false; this.buttonPressed.delete(index); this.nearSelection.clear(index); this.nearTracked.delete(index); if (this.keyDrag?.index === index || this.menuDrag === index || this.grab?.index === index || this.locomotion?.indices.includes(index)) this.finish(true); this.sources.delete(index); this.resetTimelineInput(); };
      const select = () => this.select(index);
      const selectRelease = () => {
        if(this.keyDrag?.index===index){this.updateKeyDrag();this.keyDrag=null;this.resetTimelineInput();this.syncTimeline(this.options.timelineState?.()??null);}
        if (this.grab?.index === index && this.grab.input === 'trigger') this.finish(false);
      };
      const squeeze = () => this.begin(index);
      const release = () => {
        if (this.menuDrag === index || this.grab?.index === index && this.grab.input === 'grip') this.finish(false);
        else if (this.locomotion?.indices.includes(index)) {
          const remaining = this.locomotion.indices.filter(hand => hand !== index);
          this.locomotion = remaining.length ? this.navigationGrab(remaining) : null;
        }
      };
      controller.addEventListener('connected', connected);
      controller.addEventListener('disconnected', disconnected);
      controller.addEventListener('selectstart', select);
      controller.addEventListener('selectend', selectRelease);
      controller.addEventListener('squeezestart', squeeze);
      controller.addEventListener('squeezeend', release);
      this.cleanups.push(() => {
        controller.removeEventListener('connected', connected); controller.removeEventListener('disconnected', disconnected);
        controller.removeEventListener('selectstart', select); controller.removeEventListener('squeezestart', squeeze); controller.removeEventListener('squeezeend', release);
        controller.removeEventListener('selectend', selectRelease);
      });
    }
    this.menuRoot.visible = false;
  }

  start(session: XRSession, target: THREE.Vector3): void {
    this.session = session; this.rig.position.set(target.x, 0, target.z + 3); this.rig.quaternion.identity(); this.rig.scale.setScalar(1); this.rig.visible = true;
    this.camera.near = XR_NEAR;
    this.menuNeedsPlacement = true;
    this.camera.updateMatrix(); this.viewerLocal.copy(this.camera.matrix);
    this.menuSpace.place(this.menuHead(), this.rig.scale.x);
    this.menuRoot.visible = true;
    this.feedbackRoot.visible = true;
    if (!this.menu.expanded) this.menu.toggle();
    this.syncMenu();
    session.addEventListener('visibilitychange', this.visibility);
    this.reference = this.renderer.xr.getReferenceSpace();
    this.reference?.addEventListener('reset', this.reset);
  }
  stop(): void {
    this.setTimeline(false);
    this.finish(true);
    this.leaveCamera();
    this.session?.removeEventListener('visibilitychange', this.visibility);
    this.reference?.removeEventListener('reset', this.reset); this.reference = null;
    this.session = null; this.sources.clear(); this.rig.visible = false;
    this.menuRoot.visible = false;
    this.feedbackRoot.visible = false; this.selectionFeedback.sync([], 1);
    this.pointers.forEach(pointer => pointer.root.visible = false);
    this.hoverOutlines.forEach(outline => outline.root.visible = false);
    this.buttonPressed.clear(); this.menuPressed.clear();
    this.nearTracked.clear(); this.nearSelection.clear();
    this.controllerVisuals.forEach(visual => visual.disconnect());
  }
  private visibility = () => { this.buttonPressed.clear(); this.menuPressed.clear(); this.resetTimelineInput(); if (this.session?.visibilityState !== 'visible') { this.finish(true); this.nearSelection.clear(); } };
  private reset = () => { this.resetTimelineInput(); this.finish(true); this.leaveCamera(); this.nearSelection.clear(); this.menuNeedsPlacement = true; };

  private menuHead(): THREE.Matrix4 {
    this.rig.updateWorldMatrix(true, false);
    return new THREE.Matrix4().multiplyMatrices(this.rig.matrixWorld, this.viewerLocal);
  }

  /** Anchor the tracked head once, then carry the entire XR rig with the shot camera.
   * Current head motion remains relative to that anchor; headset FOV is never overwritten. */
  updateView(frame?: XRFrame, now = performance.now()): void {
    this.updateTimeline(frame, now);
    this.updateLocomotion(frame);
    const target = this.options.followCamera?.();
    if (this.following && !target) this.leaveCamera();
    this.syncMenu();
    if (this.following && target && this.reference) {
      const viewer = frame?.getViewerPose(this.reference);
      if (viewer) {
        if (!this.headAnchor) this.headAnchor = new THREE.Matrix4().fromArray(viewer.transform.matrix).invert();
        target.updateWorldMatrix(true, false);
        const matrix = target.matrixWorld.clone().multiply(this.headAnchor);
        matrix.decompose(this.rig.position, this.rig.quaternion, this.rig.scale);
      }
    }
    // WebXR depthNear is in reference-space units; the rig scales that plane in
    // the scene. Keep it at most 5 mm in either space for close inspection.
    // WebXRManager propagates this to the session without overriding headset FOV.
    this.camera.near = XR_NEAR / Math.max(1, this.rig.scale.x);
    if (this.session) {
      const viewer = this.reference ? frame?.getViewerPose?.(this.reference) : null;
      if (viewer) {
        this.viewerLocal.fromArray(viewer.transform.matrix);
      }
      const head = this.menuHead();
      if (this.following) {
        // Carry the panel with camera travel and heading, without binding it
        // to live head turns or tilting its upright surface with camera roll.
        const yaw = new THREE.Euler().setFromQuaternion(this.rig.quaternion, 'YXZ').y;
        const anchor = new THREE.Matrix4().compose(this.rig.position,
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), this.rig.scale);
        if (this.menuFollowAnchor && this.menu.expanded && this.menuDrag === null) {
          const delta = anchor.clone().multiply(this.menuFollowAnchor.clone().invert());
          this.menuRoot.position.applyMatrix4(delta);
          this.menuRoot.quaternion.premultiply(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(delta)));
        }
        this.menuFollowAnchor = anchor;
      }
      if (!this.menu.expanded || this.menuNeedsPlacement && viewer) {
        if (this.menuNeedsPlacement && viewer && this.timeline) this.placeTimeline();
        this.menuSpace.place(head, this.rig.scale.x);
        this.menuNeedsPlacement = false;
      }
      if (this.menuDrag !== null) {
        const source = this.sources.get(this.menuDrag);
        if (this.session.visibilityState !== 'visible' || !source?.gripSpace || !this.reference || !frame?.getPose(source.gripSpace, this.reference)) this.finish(true);
        else (this.draggingTimeline ? this.timelineSpace : this.menuSpace).move(this.grips[this.menuDrag].getWorldPosition(new THREE.Vector3()), head, this.rig.scale.x);
      } else this.menuSpace.resize(head, this.rig.scale.x);
      if (this.timeline) this.timelineSpace.resize(head, this.rig.scale.x);
    }
  }

  private resetTimelineInput(): void { this.timelineArmed = false; this.timelineTime = null; }
  private recordingMode() { return this.options.timelineState?.().recording?.mode ?? 'idle'; }
  private toggleMenu(): void {
    this.menu.toggle(); this.menuSpace.place(this.menuHead(), this.rig.scale.x); this.syncMenu();
  }
  private placeTimeline(): void {
    const head = this.menuHead();
    this.timelineSpace.place(head, this.rig.scale.x);
    this.timelineRoot.position.y -= .25 * this.rig.scale.x;
    this.timelineSpace.resize(head, this.rig.scale.x);
  }
  private setTimeline(active: boolean): void {
    if (active && !this.options.timelineState) return;
    if (this.timeline === active) return;
    this.finish(true); this.timeline = active; this.resetTimelineInput(); this.timelinePaint = -Infinity;
    this.keySelection.clear();
    if (active) this.placeTimeline();
    this.options.timelineChanged?.(active);
    this.syncTimeline(active ? this.options.timelineState!() : null); this.syncMenu();
  }
  private syncTimeline(state: XRTimelineState | null): void {
    if(!state || state.recording && state.recording.mode!=='idle')this.keySelection.clear();
    this.keySelection.sync(state?.selection);
    if(this.keyDrag && (!state || state.selection?.id!==this.keyDrag.id || this.recordingMode()!=='idle'))this.keyDrag=null;
    if(state)state={...state,selectedKeyTimes:[...this.keySelection.times],keyDragRange:this.keyDrag?.moved?[this.keyDrag.from,this.keyDrag.to]:undefined};
    this.menu.setTimeline(state ? { ...state, canAddKey: !!state.selection && this.options.editable() && !!this.options.addKeyframe,
      canDeleteKey: (!!state.selectedKeyTimes?.length || !!state.selection?.frames.some(key => Math.abs(key.time - state.time) < 1e-6)) && this.options.editable() && !!this.options.deleteKeyframe } : null);
    this.keyframeGhosts.sync(state, state?.selection ? this.options.timelineObject?.(state.selection.id) : undefined);
  }
  private updateTimeline(frame: XRFrame | undefined, now: number): void {
    if (!this.timeline) return;
    const state = this.options.timelineState?.(); if (!state) { this.setTimeline(false); return; }
    const axes: number[] = [];
    if (this.session?.visibilityState === 'visible' && this.reference && frame) {
      for (const [index, source] of this.sources) {
        if (source.gamepad?.mapping !== 'xr-standard' || source.gamepad.axes.length < 4 ||
            !this.controllers[index].visible || !frame.getPose(source.targetRaySpace, this.reference)) continue;
        const axis = source.gamepad.axes[2]; if (Number.isFinite(axis)) axes.push(axis);
      }
    }
    if (!axes.length || this.keyDrag || this.grab || this.menuDrag !== null || this.options.menuState?.().playing || ['armed','recording'].includes(this.recordingMode()) || state.recording?.previewing) this.resetTimelineInput();
    else {
      const dt = this.timelineTime === null ? 0 : (now - this.timelineTime) / 1000;
      this.timelineTime = now;
      // Require neutral after entry or tracking interruption; never add two sticks.
      if (!this.timelineArmed) this.timelineArmed = axes.every(axis => Math.abs(axis) <= .2);
      else {
        const axis = axes.reduce((a, b) => Math.abs(a) >= Math.abs(b) ? a : b, 0);
        const next = timelineStep(state, axis, dt);
        if (next !== state.time) this.options.seek?.(next);
      }
    }
    if (now - this.timelinePaint >= 50) {
      this.timelinePaint = now; this.syncTimeline(this.options.timelineState!());
    }
  }

  private toggleCamera(): void {
    if (this.following) { this.leaveCamera(); return; }
    if (!this.options.followCamera?.()) return;
    this.finish(true); this.rig.updateMatrix(); this.freeRig.copy(this.rig.matrix);
    this.following = true; this.headAnchor = null;
    this.menuFollowAnchor = null; this.menuNeedsPlacement = true;
    this.camera.layers.disable(3);
  }

  private leaveCamera(): void {
    if (this.following) {
      this.freeRig.decompose(this.rig.position, this.rig.quaternion, this.rig.scale);
      this.menuSpace.place(this.menuHead(), this.rig.scale.x);
    }
    this.menuFollowAnchor = null;
    this.following = false; this.headAnchor = null; this.camera.layers.enable(3);
  }
  private syncMenu(): void {
    const playback = this.options.menuState?.() ?? { playing: false, canUndo: false };
    this.menu.setState({ ...playback, following: this.following, hasCamera: !!this.options.followCamera?.(), scale: this.following ? 1 : 1 / this.rig.scale.x, timeline: this.timeline, dragging: this.menuDrag !== null && !this.draggingTimeline, timelineDragging: this.menuDrag !== null && this.draggingTimeline });
    const idle = !this.keyDrag && !this.grab && !this.locomotion && this.menuDrag === null && this.recordingMode()==='idle';
    this.controllerVisuals.forEach(visual => visual.setState({ playing: playback.playing, canUndo: idle && playback.canUndo, canPlay: idle, canMenu: idle }));
  }
  private hit(index: number, includeGhosts = true): THREE.Intersection | undefined {
    if (!this.session || this.session.visibilityState !== 'visible' || !this.controllers[index].visible) return;
    this.rig.updateMatrixWorld(true);
    this.menuRoot.updateMatrixWorld(true);
    this.timelineRoot.updateMatrixWorld(true);
    const controller = this.controllers[index];
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
    this.raycaster.layers.enable(3);
    this.raycaster.far = Infinity; // A world panel remains reachable after navigating away.
    const ui = this.raycaster.intersectObjects(this.menu.targets(), false)[0];
    this.raycaster.far = 30 * this.rig.scale.x;
    return ui ?? this.raycaster.intersectObjects([...this.options.targets(), ...(includeGhosts ? this.keyframeGhosts.root.children : [])], true).find(hit => {
      if (hit.object.userData.xrKeyframeGhost && this.keyframeGhosts.timeAt(hit) === undefined) return false;
      for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) if (!node.visible) return false;
      return true;
    });
  }
  private entity(hit?: THREE.Intersection): string | undefined {
    for (let node: THREE.Object3D | null = hit?.object ?? null; node; node = node.parent) if (node.userData.entityId) return node.userData.entityId;
  }
  private updateNear(index: number): NearSelection {
    const source = this.sources.get(index);
    const enabled = this.session?.visibilityState === 'visible' && !!source?.gripSpace && this.nearTracked.get(index) !== false &&
      this.controllers[index].visible && this.grips[index].visible && this.options.editable() && (!this.following || this.timeline) &&
      !this.keyDrag && !this.locomotion && this.menuDrag === null && this.recordingMode()!=='review' && (!this.grab || this.grab.index === index);
    let targets = this.options.targets();
    if (this.following || this.recordingMode()!=='idle') targets = targets.filter(target => target.userData.entityId === this.options.timelineState?.().selection?.id);
    const held = this.grab?.index === index && this.grab.near ? targets.find(target => target.userData.entityId === this.grab!.id) : undefined;
    return this.nearSelection.update(index, targets, enabled, this.rig.scale.x, held);
  }
  private select(index: number): void {
    if (this.keyDrag || this.grab || this.locomotion || this.menuDrag !== null) return;
    const near = this.updateNear(index);
    if (near.active) {
      if (near.target?.userData.entityId) this.beginObject(index, near.target.userData.entityId, true, 'trigger');
      return;
    }
    if (this.timeline) this.syncTimeline(this.options.timelineState?.() ?? null);
    const hit = this.hit(index); if (!hit) return;
    const keyTime = this.timeline ? this.menu.keyframeTime(hit) ?? this.keyframeGhosts.timeAt(hit) : undefined;
    if(hit.object.userData.xrTimeline && hit.uv && this.recordingMode()==='idle'){
      const state=this.options.timelineState?.();
      if(state?.selection)this.keyDrag={index,id:state.selection.id,startU:hit.uv.x,from:keyTime??this.timelineTimeAt(hit.uv.x,state.duration),to:keyTime??this.timelineTimeAt(hit.uv.x,state.duration),previous:[...this.keySelection.times],moved:false};
      this.resetTimelineInput();
    }
    if (keyTime !== undefined) {
      if(['armed','recording'].includes(this.recordingMode()))return;
      // Validate against current selection in case an undo or selection change preceded this event.
      const state = this.options.timelineState?.();
      if (!state?.selection?.frames.some(frame => Math.abs(frame.time - keyTime) < 1e-6)) return;
      if(this.recordingMode()==='idle')this.keySelection.toggle(state.selection,keyTime);
      this.options.seek?.(keyTime); this.resetTimelineInput(); this.syncTimeline(this.options.timelineState!());
      return;
    }
    const action = hit.object.userData.xrAction;
    if (action !== undefined) {
      if(hit.object.userData.xrTimeline){this.keySelection.clear();this.syncTimeline(this.options.timelineState!());return;}
      this.syncMenu();
      if (!this.menu.enabled(action)) return;
      if(action>=XR_RECORD&&action<=XR_RECORD_DISCARD){
        const actions:XRRecordAction[]=['record','preview','apply','discard'];
        this.options.recordAction?.(actions[action-XR_RECORD]);this.resetTimelineInput();this.syncTimeline(this.options.timelineState!());return;
      }
      if (action === XR_MENU_TOGGLE) {
        this.toggleMenu();
      }
      else if (action === 5) this.setTimeline(!this.timeline);
      else if (action === XR_ADD_KEY && this.timeline && this.options.editable()) {
        this.options.addKeyframe?.(); this.resetTimelineInput(); this.syncTimeline(this.options.timelineState!());
      }
      else if (action === XR_DELETE_KEY && this.timeline && this.options.editable()) {
        this.options.deleteKeyframe?.(this.keySelection.times.length ? [...this.keySelection.times] : undefined); this.resetTimelineInput(); this.syncTimeline(this.options.timelineState!());
      }
      else if (action === 3) this.toggleCamera();
      else if (action === 2) void this.session?.end().catch(() => {});
      return;
    }
    const id = this.entity(hit); if (id) this.beginObject(index, id, false, 'trigger');
  }
  private begin(index: number): void {
    if(this.keyDrag)return;
    if (this.grab || this.menuDrag !== null || this.session?.visibilityState !== 'visible' || !this.controllers[index].visible || !this.grips[index].visible || !this.sources.get(index)?.gripSpace) return;
    // Grip edits the real object even when a preview is in front of it. A lone
    // preview still blocks empty-space navigation; only trigger selects a key.
    const near = this.updateNear(index);
    const grip = this.grips[index].getWorldPosition(new THREE.Vector3());
    const title = this.menu.nearTitle(grip, .04 * this.rig.scale.x);
    const timelineTitle = this.menu.nearTitle(grip, .04 * this.rig.scale.x, true);
    const menuHit = !near.active ? this.hit(index) : undefined;
    const timelineDrag = !!timelineTitle || !title && menuHit?.object.userData.xrAction === XR_TIMELINE_DRAG;
    const point = timelineTitle ?? title ?? ([XR_MENU_DRAG, XR_TIMELINE_DRAG].includes(menuHit?.object.userData.xrAction) ? menuHit?.point : undefined);
    if (point && !this.locomotion) {
      this.menuDrag = index; this.menuNeedsPlacement = false;
      this.draggingTimeline = timelineDrag;
      (timelineDrag ? this.timelineSpace : this.menuSpace).begin(point, grip); this.nearSelection.clear(); this.resetTimelineInput();
      return;
    }
    if(this.recordingMode()==='review')return;
    if (this.following && !this.timeline) return;
    if (near.active && !near.target) return;
    const hit = near.active ? undefined : this.hit(index, false) ?? this.hit(index);
    if (this.locomotion) {
      if (!hit && !this.locomotion.indices.includes(index)) this.locomotion = this.navigationGrab([...this.locomotion.indices, index]);
      return;
    }
    // UI and objects own their grip gestures, even when editing is locked.
    if (!hit && !near.target) {
      if(this.recordingMode()!=='idle')return;
      if (this.following) return;
      this.locomotion = this.navigationGrab([index]);
      return;
    }
    const id = near.target?.userData.entityId ?? this.entity(hit); if (!id || !this.options.editable()) return;
    this.beginObject(index, id, near.active, 'grip');
  }
  private beginObject(index: number, id: string, near: boolean, input: 'grip' | 'trigger'): void {
    if(this.grab||this.menuDrag!==null||this.locomotion||!this.options.editable()||this.recordingMode()==='review'||this.following&&!this.timeline)return;
    if(this.recordingMode()!=='idle' && id!==this.options.timelineState?.().selection?.id)return;
    // Do not move the camera that is carrying the user's head during a grab.
    if (this.following && id !== this.options.timelineState?.().selection?.id) return;
    this.options.select(id);
    if(!this.sources.get(index)?.gripSpace||!this.grips[index].visible)return;
    const start = this.options.pose(id); if (!start) return;
    if (!this.options.transform(id, start, 'start')) return;
    this.grab = { index, input, id, start, latest: start, near, origin: this.grips[index].getWorldPosition(new THREE.Vector3()), orientation: this.grips[index].getWorldQuaternion(new THREE.Quaternion()) };
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

  private updateControllerButtons(): void {
    if (this.session?.visibilityState !== 'visible') { this.buttonPressed.clear(); this.menuPressed.clear(); return; }
    for (const [index, source] of this.sources) {
      // xr-standard left X / Y occupy indices 4 / 5; right A / B do not trigger shortcuts.
      if (source.handedness !== 'left' || source.hand || source.gamepad?.mapping !== 'xr-standard') continue;
      const pressed = [4, 5].map(button => !!source.gamepad?.buttons?.[button]?.pressed);
      const previous = this.buttonPressed.get(index);
      this.buttonPressed.set(index, pressed);
      const binding = this.controllerVisuals[index].menuBinding(source);
      const priorMenu = this.menuPressed.get(index);
      const menuDown = binding ? !!source.gamepad.buttons[binding.index]?.pressed : false;
      if (binding) this.menuPressed.set(index, { index: binding.index, pressed: menuDown });
      else this.menuPressed.delete(index);
      // Consume presses even while blocked: releasing a grab must not replay a held button.
      if (this.keyDrag || this.grab || this.locomotion || this.menuDrag !== null || this.recordingMode()!=='idle') continue;
      if (pressed[0] && previous?.[0] === false && this.options.menuState?.().canUndo) { this.options.action('undo'); this.controllerVisuals[index].acknowledge('undo'); }
      if (pressed[1] && previous?.[1] === false) { this.options.action('play'); this.resetTimelineInput(); this.controllerVisuals[index].acknowledge('play'); }
      if (binding && priorMenu?.index === binding.index && !priorMenu.pressed && menuDown) {
        this.toggleMenu(); this.controllerVisuals[index].acknowledge('menu');
      }
    }
  }

  update(frame?: XRFrame): void {
    if (!this.session) return;
    this.updateKeyDrag(frame);
    this.updateControllerButtons(); this.syncMenu();
    const hovered: number[] = [];
    const highlighted = new Set<THREE.Object3D>();
    let hoveredKey: number | undefined;
    this.controllers.forEach((_, index) => {
      const source = this.sources.get(index);
      this.nearTracked.set(index, !!(source?.gripSpace && this.reference && frame?.getPose(source.gripSpace, this.reference)));
      const near = this.updateNear(index);
      this.hoverOutlines[index].root.visible = false;
      // Use the same grip-space radius and title target as begin(), even when
      // an object's near sphere would otherwise suppress ray hover feedback.
      const canInteract = !this.keyDrag && !this.grab && !this.locomotion && this.menuDrag === null;
      if (canInteract && this.session?.visibilityState === 'visible' && this.controllers[index].visible &&
          this.grips[index].visible && this.nearTracked.get(index)) {
        const grip = this.grips[index].getWorldPosition(new THREE.Vector3());
        const titleAction = this.menu.nearTitle(grip, .04 * this.rig.scale.x, true) ? XR_TIMELINE_DRAG :
          this.menu.nearTitle(grip, .04 * this.rig.scale.x) ? XR_MENU_DRAG : undefined;
        if (titleAction !== undefined) {
          hovered.push(titleAction);
          this.pointers[index].root.visible = false;
          return;
        }
      }
      if (near.active) {
        this.pointers[index].root.visible = false;
        if (near.target) highlighted.add(near.target);
        return;
      }
      const tracked = !!source && this.controllers[index].visible && this.session?.visibilityState === 'visible' &&
        (!frame || !!(this.reference && frame.getPose(source.targetRaySpace, this.reference)));
      if (!tracked) { this.pointers[index].root.visible = false; return; }
      const hit = this.hit(index);
      const action = hit?.object.userData.xrAction;
      const keyTime = hit && this.timeline && canInteract ? this.menu.keyframeTime(hit) ?? this.keyframeGhosts.timeAt(hit) : undefined;
      if (keyTime !== undefined) hoveredKey = keyTime;
      if (canInteract && typeof action === 'number' && this.menu.enabled(action)) hovered.push(action);
      const held = this.keyDrag?.index === index || this.grab?.index === index || this.menuDrag === index || !!this.locomotion?.indices.includes(index);
      const actionable = canInteract && (keyTime !== undefined || (action !== undefined ? this.menu.enabled(action) : !!hit && this.options.editable() && (!this.following || this.timeline)));
      const color = held ? XR_FEEDBACK.held : actionable ? XR_FEEDBACK.ready : hit ? XR_FEEDBACK.disabled : XR_FEEDBACK.idle;
      this.pointers[index].update(true, hit ? hit.distance / this.rig.scale.x : held ? .3 : 8, !!hit, color, held || actionable);
      const id = this.grab?.index === index ? this.grab.id : canInteract ? this.entity(hit) : undefined;
      const target = id ? this.options.targets().find(target => target.userData.entityId === id) : undefined;
      if (target) { highlighted.add(target); this.hoverOutlines[index].update(target, this.rig.scale.x, color); }
      else if (keyTime !== undefined) {
        const bounds = this.keyframeGhosts.boundsAt(keyTime);
        if (bounds) this.hoverOutlines[index].updateBounds(bounds, this.rig.scale.x, XR_FEEDBACK.ready);
      }
    });
    this.menu.hover(this.menuDrag !== null ? [this.draggingTimeline ? XR_TIMELINE_DRAG : XR_MENU_DRAG] : hovered);
    this.menu.hoverKeyframe(hoveredKey);
    this.selectionFeedback.sync(this.session.visibilityState === 'visible' ? (this.options.selected?.() ?? []).filter(target => !highlighted.has(target)) : [], this.rig.scale.x);
    const grab = this.grab; if (!grab) return;
    const source = this.sources.get(grab.index), reference = this.renderer.xr.getReferenceSpace();
    if (!this.options.editable() || !source?.gripSpace || !reference || !frame?.getPose(source.gripSpace, reference)) { this.finish(true); return; }
    const current = this.grips[grab.index].getWorldPosition(new THREE.Vector3());
    grab.latest = grab.near ? rotatedGrab(grab.start, grab.origin, current, grab.orientation, this.grips[grab.index].getWorldQuaternion(new THREE.Quaternion())) : translatedGrab(grab.start, grab.origin, current);
    if (!this.options.transform(grab.id, grab.latest, 'change')) this.finish(true);
    else if(this.recordingMode()==='review')this.finish(false);
    else {
      this.updateNear(grab.index);
      if (!grab.near) this.hoverOutlines[grab.index].update(this.options.targets().find(target => target.userData.entityId === grab.id), this.rig.scale.x, XR_FEEDBACK.held);
    }
  }
  private finish(cancel: boolean): void {
    this.keyDrag=null;
    this.menuDrag = null; this.draggingTimeline = false; this.menuSpace.end(); this.timelineSpace.end();
    this.locomotion = null;
    const grab = this.grab; this.grab = null;
    if (grab) this.options.transform(grab.id, cancel ? grab.start : grab.latest, cancel ? 'cancel' : 'end');
  }
  private timelineTimeAt(u: number, duration: number): number { return THREE.MathUtils.clamp((u*1440-64)/1312,0,1)*duration; }
  private updateKeyDrag(frame?: XRFrame): void {
    const drag=this.keyDrag;if(!drag)return;
    const source=this.sources.get(drag.index),state=this.options.timelineState?.();
    if(!source || !state?.selection || state.selection.id!==drag.id || this.recordingMode()!=='idle' ||
        this.session?.visibilityState!=='visible' || !this.controllers[drag.index].visible ||
        frame && (!this.reference || !frame.getPose(source.targetRaySpace,this.reference))){
      this.keyDrag=null;this.syncTimeline(state??null);return;
    }
    const hit=this.hit(drag.index);
    if(!hit?.object.userData.xrTimeline || !hit.uv)return;
    if(!drag.moved && Math.abs(hit.uv.x-drag.startU)<.008)return;
    drag.moved=true;drag.to=this.timelineTimeAt(hit.uv.x,state.duration);
    this.keySelection.range(state.selection,drag.from,drag.to,drag.previous);
    this.syncTimeline(state);
  }
  dispose(): void {
    this.stop(); this.cleanups.forEach(cleanup => cleanup()); this.rig.removeFromParent();
    this.pointers.forEach(pointer => pointer.dispose());
    this.hoverOutlines.forEach(outline => outline.dispose()); this.selectionFeedback.dispose(); this.feedbackRoot.removeFromParent();
    this.menu.dispose(); this.keyframeGhosts.dispose();
    this.nearSelection.dispose();
    this.controllerVisuals.forEach(visual => visual.dispose());
  }
}
