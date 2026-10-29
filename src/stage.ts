import * as THREE from 'three';
import { XRControls } from './xr/controls';
import { setXRObjectCulling } from './xr/culling';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { evaluateComponents, evaluateFov, evaluateTransform } from './model';
import { activePivot, fromPivotPose, toPivotPose } from './components/transform';
import { createAssetGroup, disposeAssetGroup, type AssetDefinition } from './assets/model';
import { renderSceneSnapshot } from './scene-snapshot';
import { configureHandles } from './placement/gizmo';
import { ViewNavigation } from './placement/navigation';
import type { AlignmentEdge, PrecisionSettings } from './placement/panel';
import { ShotRenderer } from './shot-export/renderer';
import type { PoseUpdate } from './placement/transforms';
import type { SceneSnapshot, SceneView } from './scene-edit/operations';
import type { Axis, PrimitiveKind, SceneDocument, SceneObject, StageOptions, ToolMode, Transform } from './types';

interface EntityView {
  root: THREE.Group;
  bounds: THREE.Box3;
  kind: PrimitiveKind;
  material: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  color: string;
  assetKey?: string;
  disposeAsset?: () => void;
}
interface PointerStart {
  id: number;
  x: number;
  y: number;
  selected: string | null;
  orbit: boolean;
  gizmo: boolean;
  box: boolean;
  additive: boolean;
  toggle: boolean;
}

const DEG = Math.PI / 180;
const NAV_HINT = 'Drag empty space to orbit · Shift drag to box select · Ctrl click to toggle · F to focus';

/** Two persistent views of one scene: an editor with tools, and a clean shot camera. */
export class Stage {
  private precision: PrecisionSettings = { space: 'world', snap: false, move: .25, rotate: 15 };
  private currentAssets: AssetDefinition[] = [];
  private assetKeys = new WeakMap<AssetDefinition, string>();
  private assetKey(asset: AssetDefinition | undefined): string | undefined {
    if (!asset) return undefined;
    let key = this.assetKeys.get(asset);
    if (!key) { key = JSON.stringify(asset); this.assetKeys.set(asset, key); }
    return key;
  }
  private controlled: { id: string; pose: Transform } | null = null;
  private ghost: THREE.Group | null = null;
  private readonly forwardArrow = new THREE.ArrowHelper(new THREE.Vector3(0,0,1),new THREE.Vector3(),1.2,0x669bb1,.22,.13);
  private readonly options: StageOptions;
  private readonly scene = new THREE.Scene();
  private readonly perspectiveCamera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
  private readonly orthographicCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, .05, 500);
  private editorCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspectiveCamera;
  private readonly shotCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 500);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly previewRenderer: THREE.WebGLRenderer;
  private readonly orbit: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly gizmoHelper: THREE.Object3D;
  private readonly uniformHandles: (uniform: boolean) => void;
  private readonly navigation: ViewNavigation;
  private readonly selectionBox = document.createElement('div');
  private readonly groupPivot = new THREE.Group();
  private readonly objectPivot = new THREE.Group();
  private readonly dragPoses = new Map<string, Transform>();
  private dragPivot = new THREE.Matrix4();
  private lastAxisPress: { axis: string | null; x: number; y: number; at: number } | null = null;
  private viewTween: { start: number; from: THREE.Vector3; to: THREE.Vector3 } | null = null;
  private readonly cameraIcon = new THREE.Group();
  private readonly selectionMarker = new THREE.Group();
  private readonly selectionBounds = new THREE.Box3();
  private readonly selectionMarkers = new Map<string, THREE.Group>();
  private readonly views = new Map<string, EntityView>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly fixedGeometries: THREE.BufferGeometry[] = [];
  private readonly fixedMaterials: THREE.Material[] = [];
  private readonly removeListeners: Array<() => void> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly sun: THREE.DirectionalLight;
  private readonly keys = new Set<string>();
  private readonly direction = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly originalPreviewPosition: string;
  private readonly previewPositionChanged: boolean;
  private selectedId: string | null = null;
  private selectedIds: string[] = [];
  private currentShotId: string | null = null;
  private iconCameraId: string | null = null;
  private previewCameraId: string | null = null;
  private playing = false;
  private dragging = false;
  private dragEntityId: string | null = null;
  private tool: ToolMode = 'translate';
  private axis: Axis | null = null;
  private pointerStart: PointerStart | null = null;
  private flyPointer: number | null = null;
  private lastPointer = new THREE.Vector2();
  private xrControls?: XRControls;
  private xrPending = false;
  private lastFrame = 0;
  private disposed = false;
  private currentDoc: SceneDocument | null = null;
  private currentTime = 0;

  constructor(options: StageOptions) {
    this.options = options;
    this.scene.background = new THREE.Color('#e9e7e2');
    this.scene.fog = new THREE.Fog('#e9e7e2', 45, 150);
    this.renderer = this.createRenderer();
    this.previewRenderer = this.createRenderer();
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', '3D scene editor. Drag empty space to orbit. Hold right mouse and use WASD to fly.');
    canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;touch-action:none;';
    options.viewport.appendChild(canvas);
    const previewCanvas = this.previewRenderer.domElement;
    previewCanvas.setAttribute('aria-label', 'Live shot camera preview');
    previewCanvas.setAttribute('role', 'img');
    previewCanvas.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:block;pointer-events:none;';
    this.originalPreviewPosition = options.preview.style.position;
    this.previewPositionChanged = getComputedStyle(options.preview).position === 'static';
    if (this.previewPositionChanged) options.preview.style.position = 'relative';
    options.preview.appendChild(previewCanvas);
    this.editorCamera.layers.enable(1);
    this.orthographicCamera.layers.enable(1);
    this.shotCamera.layers.set(0);
    this.raycaster.layers.enable(1);
    this.raycaster.params.Line.threshold = 0.055;

    this.orbit = new OrbitControls(this.editorCamera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.1;
    this.orbit.minDistance = 0.25;
    this.orbit.maxDistance = 150;
    this.orbit.maxPolarAngle = Math.PI - 0.015;
    this.orbit.minPolarAngle = 0.015;
    this.orbit.screenSpacePanning = true;
    this.orbit.zoomToCursor = true;
    this.orbit.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    this.orbit.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    this.orbit.mouseButtons.RIGHT = null;
    this.gizmo = new TransformControls(this.editorCamera, canvas);
    this.gizmo.setSize(0.9);
    this.gizmo.setSpace('world');
    this.gizmoHelper = this.gizmo.getHelper();
    this.uniformHandles = configureHandles(this.gizmoHelper);
    // The control raycaster must use the same layer as the visible helper.
    this.gizmoHelper.traverse((node) => node.layers.set(1));
    this.gizmo.getRaycaster().layers.set(1);
    this.scene.add(this.gizmoHelper);
    this.scene.add(this.groupPivot, this.objectPivot);
    this.gizmo.addEventListener('mouseDown', this.onGizmoStart);
    this.gizmo.addEventListener('objectChange', this.onGizmoChange);
    this.gizmo.addEventListener('mouseUp', this.onGizmoEnd);
    this.gizmo.addEventListener('dragging-changed', this.onDraggingChanged);

    this.forwardArrow.traverse(node => node.layers.set(1)); this.forwardArrow.visible=false; this.scene.add(this.forwardArrow);
    this.sun = this.createEnvironment();
    this.createCameraIcon();
    this.createSelectionMarker();
    this.selectionBox.className = 'viewport-selection-box'; this.selectionBox.hidden = true; options.viewport.append(this.selectionBox);
    this.navigation = new ViewNavigation(options.viewport, {
      snap: direction => this.snapView(direction),
      orbit: (dx, dy) => { this.orbit.rotateLeft(dx * .012); this.orbit.rotateUp(dy * .012); },
      projection: () => this.setProjection(this.editorCamera === this.perspectiveCamera),
      begin: () => { this.viewTween = null; this.clearNavigation(); this.orbit.enabled = false; },
      end: () => { this.orbit.enabled = !this.controlled && !this.dragging; },
    });
    this.resetView();

    this.listen(canvas, 'pointerdown', this.onPointerDown as EventListener, true);
    this.listen(canvas, 'pointermove', this.onPointerMove as EventListener, true);
    this.listen(window, 'pointerup', this.onPointerUp as EventListener);
    this.listen(window, 'pointercancel', this.onPointerCancel as EventListener);
    this.listen(canvas, 'contextmenu', (event) => event.preventDefault());
    this.listen(canvas, 'dblclick', this.onDoubleClick as EventListener);
    this.listen(canvas, 'keydown', this.onKeyDown as EventListener);
    this.listen(window, 'keyup', this.onKeyUp as EventListener);
    this.listen(canvas, 'blur', this.onBlur);
    this.listen(window, 'blur', this.onBlur);
    this.listen(window, 'resize', this.resize);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(options.viewport);
    this.resizeObserver.observe(options.preview);
    this.resize();
    options.onStatus(NAV_HINT);
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    this.renderer.xr.addEventListener('sessionstart', this.onXRStart);
    this.renderer.xr.addEventListener('sessionend', this.onXREnd);
    this.renderer.setAnimationLoop(this.render);
  }

  get presentingXR(): boolean { return this.renderer.xr.isPresenting; }

  async enterXR(): Promise<void> {
    if (this.xrPending || this.presentingXR) return;
    if (!navigator.xr || !window.isSecureContext) throw new Error('VR requires a compatible headset browser and HTTPS.');
    if (this.options.canEnterXR?.() === false) throw new Error('Finish the current edit, preview or recording before entering VR.');
    this.xrPending = true;
    let session: XRSession | undefined;
    try {
      session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] });
      if (this.disposed || this.options.canEnterXR?.() === false) throw new Error('The editor changed while entering VR. Try again.');
      this.xrControls ??= new XRControls(this.renderer, {
        targets: () => [...this.views.values()].filter(view => view.root.visible).map(view => view.root).concat(this.cameraIcon.visible ? [this.cameraIcon] : []),
        selected: () => this.selectedIds.map(id => this.rootFor(id)).filter((root): root is THREE.Object3D => !!root && root.visible),
        editable: () => !this.playing && !this.controlled && this.options.canEnterXR?.() !== false,
        select: id => this.options.onSelect([id], 'replace'),
        pose: id => { const root = this.rootFor(id); return root ? this.readPose(root) : undefined; },
        transform: (id, transform, phase) => this.options.onTransform([{ id, transform }], phase, 'keyframe-pose'),
        action: action => this.options.onXRAction?.(action),
        followCamera: () => this.previewCameraId ? this.shotCamera : null,
        timelineState: this.options.xrTimelineState,
        addKeyframe: this.options.onXRAddKeyframe,
        deleteKeyframe: this.options.onXRDeleteKeyframe,
        timelineObject: id => this.views.get(id)?.root,
        seek: time => this.options.onXRSeek?.(time),
        timelineChanged: active => this.options.onXRTimelineChange?.(active),
        menuState: () => this.options.xrMenuState?.() ?? { playing: this.playing, canUndo: false },
      });
      this.scene.add(this.xrControls.rig, this.xrControls.menuRoot, this.xrControls.timelineRoot, this.xrControls.keyframeGhosts.root, this.xrControls.nearSelection.root, this.xrControls.feedbackRoot);
      await this.renderer.xr.setSession(session);
      this.xrControls.start(session, this.orbit.target);
    } catch (error) {
      if (session) await session.end().catch(() => {});
      throw error;
    } finally { this.xrPending = false; }
  }

  private onXRStart = (): void => {
    this.finishGizmo(true); this.clearNavigation(); this.viewTween = null;
    for (const view of this.views.values()) setXRObjectCulling(view.root, true);
    // Three.js reserves layers 1 and 2 for the two XR eyes. Keep editor helpers binocular.
    this.scene.traverse(node => { if (node.layers.isEnabled(1)) { node.layers.disable(1); node.layers.enable(3); } });
    this.orbit.enabled = false; this.gizmo.detach(); this.gizmo.enabled = false;
    this.options.onXRChange?.(true);
    this.options.onStatus('VR · Grip objects to move them · Grip empty space to navigate · Two grips: horizontal turn, spread/pinch to scale');
  };

  private onXREnd = (): void => {
    this.xrControls?.stop(); this.lastFrame = 0;
    for (const view of this.views.values()) setXRObjectCulling(view.root, false);
    this.scene.traverse(node => { if (node !== this.xrControls?.camera && node.layers.isEnabled(3)) { node.layers.disable(3); node.layers.enable(1); } });
    this.orbit.enabled = !this.controlled; this.syncSelection(); this.resize();
    this.options.onXRChange?.(false); this.options.onStatus(NAV_HINT);
  };

  update(doc: SceneDocument, time: number, selectedIds: string[], playing: boolean, shotId: string | null = doc.shots[0]?.id ?? null, assets: AssetDefinition[] = []): void {
    if (this.disposed) return;
    selectedIds = selectedIds.filter(id => !doc.objects.find(item => item.id === id)?.hidden);
    const selectedId = selectedIds.at(-1) ?? null;
    this.currentDoc = doc; this.currentTime = time; this.currentShotId = shotId;
    this.currentAssets = assets;
    const liveIds = new Set(doc.objects.map((object) => object.id));
    for (const [id, view] of this.views) {
      if (liveIds.has(id)) continue;
      if (this.dragEntityId === id) this.finishGizmo();
      this.scene.remove(view.root);
      view.disposeAsset?.();
      view.material.dispose();
      view.accent.dispose();
      this.views.delete(id);
    }
    for (const object of doc.objects) {
      let view = this.views.get(object.id);
      const assetKey=this.assetKey(this.currentAssets.find(asset=>asset.id===object.asset?.id));
      if (!view || view.kind !== object.kind || view.assetKey !== assetKey) {
        if (view) {
          this.scene.remove(view.root);
          view.disposeAsset?.();
          view.material.dispose();
          view.accent.dispose();
        }
        view = this.createEntity(object);
        if (this.presentingXR) setXRObjectCulling(view.root, true);
        this.views.set(object.id, view);
        this.scene.add(view.root);
      }
      if (view.color !== object.color) {
        view.material.color.set(object.color);
        view.accent.color.copy(view.material.color).multiplyScalar(0.72);
        view.color = object.color;
        if(object.asset)view.root.traverse(node=>{if(node instanceof THREE.Mesh && node.userData.baseColor)(node.material as THREE.MeshStandardMaterial).color.set(node.userData.baseColor).multiply(new THREE.Color(object.color));});
      }
      view.root.name = object.name;
      view.root.visible = !object.hidden;
      if (!this.dragPoses.has(object.id)) this.applyPose(view.root, this.controlled?.id===object.id?this.controlled.pose:evaluateTransform(object, time));
    }
    const shot = doc.shots.find(item => item.id === shotId);
    const selectedCamera = doc.cameras.find(item => item.id === selectedId);
    const preview = doc.cameras.find(item => item.id === shot?.cameraId) ?? selectedCamera ?? doc.cameras[0];
    const camera = selectedCamera ?? preview;
    this.iconCameraId = camera?.id ?? null; this.previewCameraId = preview?.id ?? null;
    this.cameraIcon.visible = !!camera; this.cameraIcon.userData.entityId = camera?.id ?? '';
    if (camera && this.dragEntityId !== camera.id) this.applyPose(this.cameraIcon, evaluateTransform(camera, time));
    if (preview) {
      if (this.dragEntityId === preview.id) this.copyIconToShot();
      else this.applyPose(this.shotCamera, evaluateTransform(preview, time), false);
      const fov = evaluateFov(preview, time);
      if (this.shotCamera.fov !== fov) { this.shotCamera.fov = fov; this.shotCamera.updateProjectionMatrix(); }
    }
    this.previewRenderer.domElement.hidden = !preview;
    const validSelectedId = selectedId && (selectedId === this.iconCameraId || this.views.has(selectedId)) ? selectedId : null;
    if ((playing && !this.playing) || selectedIds.join('|') !== this.selectedIds.join('|')) this.finishGizmo();
    this.playing = playing;
    this.selectedId = validSelectedId;
    this.selectedIds = selectedIds.filter(id => this.views.has(id) || id === this.iconCameraId);
    this.syncSelection();
  }

  setTool(mode: ToolMode): void {
    this.tool = mode;
    this.gizmo.setMode(mode);
    this.syncSelection();
    this.options.onStatus(`${mode[0].toUpperCase()}${mode.slice(1)}${this.axis ? ` on ${this.axis}` : ''} · Drag a colored handle · F to focus`);
  }

  setPrecision(settings: PrecisionSettings): void {
    this.precision = {...settings};
    this.gizmo.setTranslationSnap(settings.snap ? settings.move : null);
    this.gizmo.setRotationSnap(settings.snap ? settings.rotate * DEG : null);
    this.syncSelection();
  }

  setControlled(value: {id:string;pose:Transform;world?:boolean}|null): void {
    if(!!value!==!!this.controlled)this.clearNavigation();
    this.controlled=value;this.orbit.enabled=!value&&!this.presentingXR;this.forwardArrow.visible=!!value;
    if(value){this.forwardArrow.position.fromArray(value.pose.position).add(new THREE.Vector3(0,.07,0));const direction=new THREE.Vector3(0,0,1);if(!value.world)direction.applyEuler(new THREE.Euler(...value.pose.rotation.map(THREE.MathUtils.degToRad) as [number,number,number],'XYZ'));direction.y=0;this.forwardArrow.setDirection(direction.normalize());}
  }
  focusCanvas():void {this.renderer.domElement.focus({preventScroll:true});}
  placement(asset:AssetDefinition,clientX?:number,clientY?:number): Transform|null {
    const rect=this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(clientX===undefined?0:(clientX-rect.left)/rect.width*2-1,clientY===undefined?0:-(clientY-rect.top)/rect.height*2+1);
    this.scene.updateMatrixWorld(true);this.editorCamera.updateMatrixWorld(true);this.raycaster.setFromCamera(this.pointer,this.editorCamera);
    let point=this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),new THREE.Vector3());
    const surface=this.raycaster.intersectObjects([...this.views.values()].filter(v=>v.root.visible).map(v=>v.root),true).find(hit=>hit.face && hit.face.normal.clone().transformDirection(hit.object.matrixWorld).y>.65);
    if(surface && (!point || surface.distance < point.distanceTo(this.raycaster.ray.origin)))point=surface.point;
    if(!point || point.toArray().some(v=>Math.abs(v)>990))return null;
    const pose:Transform=structuredClone(asset.template?.transform??{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]});
    pose.position=[0,0,0];const root=createAssetGroup(asset);this.applyPose(root,pose);root.updateMatrixWorld(true);
    const minY=new THREE.Box3().setFromObject(root).min.y;disposeAssetGroup(root);
    pose.position=[point.x,point.y-minY,point.z];return pose;
  }
  previewAsset(asset:AssetDefinition|null,pose?:Transform):void {
    if(!asset){if(this.ghost){this.scene.remove(this.ghost);disposeAssetGroup(this.ghost);this.ghost=null;}return;}
    if(!this.ghost||this.ghost.userData.assetId!==asset.id){this.previewAsset(null);this.ghost=createAssetGroup(asset);this.ghost.userData.assetId=asset.id;this.ghost.traverse(node=>{if(node instanceof THREE.Mesh){const m=node.material as THREE.MeshStandardMaterial;m.transparent=true;m.opacity=.55;m.depthWrite=false;node.castShadow=false;}});this.scene.add(this.ghost);}
    if(pose)this.applyPose(this.ghost,pose);
  }

  setAxis(axis: Axis | null): void {
    this.axis = axis;
    this.syncAxis();
    this.options.onStatus(`${this.tool[0].toUpperCase()}${this.tool.slice(1)} · ${axis ? `${axis} axis` : 'All axes'} · Drag the handle`);
  }

  focusSelection(): void {
    if (!this.selectedIds.length) {
      this.resetView();
      return;
    }
    const box = this.selectedBounds();
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 0.4);
    const distance = radius / Math.sin(this.perspectiveCamera.fov * DEG * 0.5) * 1.3;
    this.viewTween = null;
    if (this.editorCamera === this.orthographicCamera) {
      this.orthographicCamera.zoom = (this.orthographicCamera.top - this.orthographicCamera.bottom) / (radius * 2.6 / Math.min(1, this.perspectiveCamera.aspect));
      this.orthographicCamera.updateProjectionMatrix();
    }
    const outward = this.editorCamera.position.clone().sub(this.orbit.target).normalize();
    if (outward.lengthSq() < 0.1) outward.set(1, 0.6, 1).normalize();
    this.editorCamera.position.copy(center).addScaledVector(outward, distance);
    this.orbit.target.copy(center);
    this.orbit.update();
  }

  resetView(): void {
    this.viewTween = null;
    this.clearNavigation();
    this.setProjection(false);
    this.editorCamera.position.set(8, 6, 10);
    this.orbit.target.set(0, 1, 0);
    this.orbit.update();
  }

  captureView(): { transform: Transform; fov: number } {
    if (this.editorCamera === this.orthographicCamera) this.setProjection(false);
    return { transform: this.readPose(this.editorCamera), fov: this.perspectiveCamera.fov };
  }

  captureSnapshot(doc: SceneDocument, time: number, view: SceneView, shotId: string | null = doc.shots[0]?.id ?? null, assets:AssetDefinition[] = this.currentAssets): SceneSnapshot {
    if (view === 'shot' && !doc.shots.some(shot => shot.id === shotId)) throw new Error('Choose a shot before capturing its view.');
    if (this.disposed || !this.currentDoc) throw new Error('The stage is not ready to capture an image.');
    if (this.dragging || this.flyPointer !== null) throw new Error('Finish moving the object or camera before capturing a view.');
    const previous = { doc: this.currentDoc, time: this.currentTime, selected: [...this.selectedIds], playing: this.playing, shotId: this.currentShotId, assets:this.currentAssets };
    try {
      this.update(doc, time, [], true, shotId, assets);
      return renderSceneSnapshot(this.previewRenderer, this.scene, this.shotCamera, doc.objects.filter(item=>!item.hidden).map(item => ({ id: item.id, name: item.name, root: this.views.get(item.id)!.root })), view, time, this.previewCameraId);
    } finally { this.update(previous.doc, previous.time, previous.selected, previous.playing, previous.shotId,previous.assets); }
  }

  createShotRenderer(cameraId: string): ShotRenderer {
    if (!this.currentDoc || this.disposed || this.dragging) throw new Error('Finish editing before exporting a shot.');
    const roots = [...this.views.values()].map(view => view.root);
    const environment = this.scene.children.filter(node => node instanceof THREE.Light || (node instanceof THREE.Mesh && node.layers.isEnabled(0)));
    return new ShotRenderer(this.currentDoc, cameraId, [...environment, ...roots], this.scene.background, this.scene.fog);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.renderer.xr.removeEventListener('sessionstart', this.onXRStart);
    this.renderer.xr.removeEventListener('sessionend', this.onXREnd);
    this.xrControls?.dispose();
    void this.renderer.xr.getSession()?.end().catch(() => {});
    this.clearNavigation();
    this.resizeObserver.disconnect();
    this.removeListeners.forEach((remove) => remove());
    this.gizmo.removeEventListener('mouseDown', this.onGizmoStart);
    this.gizmo.removeEventListener('objectChange', this.onGizmoChange);
    this.gizmo.removeEventListener('mouseUp', this.onGizmoEnd);
    this.gizmo.removeEventListener('dragging-changed', this.onDraggingChanged);
    this.uniformHandles(false);
    this.gizmo.dispose();
    this.orbit.dispose();
    this.navigation.dispose(); this.selectionBox.remove();
    this.previewAsset(null);this.forwardArrow.dispose();
    for (const view of this.views.values()) {
      view.disposeAsset?.();
      view.material.dispose();
      view.accent.dispose();
    }
    this.views.clear();
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.fixedGeometries.forEach((geometry) => geometry.dispose());
    this.fixedMaterials.forEach((material) => material.dispose());
    this.sun.shadow.dispose();
    this.scene.clear();
    this.renderer.dispose();
    this.previewRenderer.dispose();
    this.renderer.domElement.remove();
    this.previewRenderer.domElement.remove();
    if (this.previewPositionChanged) this.options.preview.style.position = this.originalPreviewPosition;
  }

  private createRenderer(): THREE.WebGLRenderer {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    return renderer;
  }

  private createEnvironment(): THREE.DirectionalLight {
    const floorGeometry = new THREE.PlaneGeometry(200, 200);
    const floorMaterial = new THREE.MeshStandardMaterial({ color: '#eceae4', roughness: 0.98, metalness: 0 });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.012;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.fixedGeometries.push(floorGeometry);
    this.fixedMaterials.push(floorMaterial);
    const grid = new THREE.GridHelper(100, 100, '#aaa79e', '#b9b6ad');
    grid.position.y = -0.008;
    grid.layers.set(1);
    for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) {
      material.transparent = true;
      material.opacity = 0.29;
      material.depthWrite = false;
      this.fixedMaterials.push(material);
    }
    this.fixedGeometries.push(grid.geometry);
    this.scene.add(grid);
    this.scene.add(new THREE.HemisphereLight('#f6f5ee', '#c6c2b9', 2.1));
    const sun = new THREE.DirectionalLight('#fff4dc', 3.4);
    sun.position.set(-4, 9, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -16;
    sun.shadow.camera.right = 16;
    sun.shadow.camera.top = 16;
    sun.shadow.camera.bottom = -16;
    sun.shadow.camera.near = 0.1;
    sun.shadow.camera.far = 40;
    sun.shadow.normalBias = 0.035;
    sun.shadow.bias = -0.00015;
    sun.shadow.radius = 4;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight('#dbe9ff', 0.7);
    fill.position.set(5, 4, -5);
    this.scene.add(fill);
    return sun;
  }

  private geometry(kind: string): THREE.BufferGeometry {
    const existing = this.geometries.get(kind);
    if (existing) return existing;
    let geometry: THREE.BufferGeometry;
    switch (kind) {
      case 'sphere': geometry = new THREE.SphereGeometry(0.5, 24, 16); break;
      case 'cylinder': geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); break;
      case 'cone': geometry = new THREE.ConeGeometry(0.5, 1, 32); break;
      case 'capsule': geometry = new THREE.CapsuleGeometry(0.5, 1, 6, 12); break;
      case 'plane': geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); break;
      default: geometry = new THREE.BoxGeometry(1, 1, 1);
    }
    this.geometries.set(kind, geometry);
    return geometry;
  }

  private createEntity(object: SceneObject): EntityView {
    const root = new THREE.Group();
    root.userData.entityId = object.id;
    const material = new THREE.MeshStandardMaterial({ color: object.color, roughness: 0.79, metalness: 0.01 });
    const accent = material.clone();
    accent.color.multiplyScalar(0.72);
    if(object.kind==='asset'){
      const asset=this.currentAssets.find(a=>a.id===object.asset?.id);
      if(!asset)throw new Error('Missing asset: '+object.name);
      const group=createAssetGroup(asset);root.add(group);group.traverse(node=>{if(node instanceof THREE.Mesh)(node.material as THREE.MeshStandardMaterial).color.multiply(new THREE.Color(object.color));});
      return {root,bounds:new THREE.Box3().setFromObject(root),kind:object.kind,material,accent,color:object.color,assetKey:this.assetKey(asset),disposeAsset:()=>disposeAssetGroup(group)};
    }
    if (object.kind === 'plane') material.side = THREE.DoubleSide;
    const add = (kind: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, dark = false): THREE.Mesh => {
      const mesh = new THREE.Mesh(this.geometry(kind), dark ? accent : material);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      root.add(mesh);
      return mesh;
    };
    if (object.kind === 'human') {
      add('capsule', 0, 1.12, 0, 0.41, 0.29, 0.27);
      add('sphere', 0, 0.82, 0, 0.39, 0.28, 0.29, true);
      add('cylinder', 0, 1.45, 0, 0.11, 0.12, 0.11);
      add('sphere', 0, 1.63, 0, 0.32, 0.37, 0.32);
      for (const side of [-1, 1]) {
        add('capsule', side * 0.12, 0.43, 0, 0.14, 0.34, 0.15, true);
        add('cube', side * 0.12, 0.055, -0.045, 0.155, 0.11, 0.28, true);
        const arm = add('capsule', side * 0.315, 1.09, 0, 0.12, 0.28, 0.12);
        arm.rotation.z = side * 0.1;
        add('sphere', side * 0.344, 0.79, 0, 0.13, 0.15, 0.13);
      }
    } else {
      add(object.kind, 0, 0, 0, 1, 1, 1);
    }
    return { root, bounds: new THREE.Box3().setFromObject(root), kind: object.kind, material, accent, color: object.color };
  }

  private createSelectionMarker(): void {
    const fillGeometry = new THREE.CircleGeometry(1, 96).rotateX(-Math.PI / 2);
    const ringGeometry = new THREE.RingGeometry(0.985, 1, 96).rotateX(-Math.PI / 2);
    const fillMaterial = new THREE.MeshBasicMaterial({ color: '#bd804b', transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const ringMaterial = fillMaterial.clone(); ringMaterial.opacity = 0.85;
    const fill = new THREE.Mesh(fillGeometry, fillMaterial), ring = new THREE.Mesh(ringGeometry, ringMaterial);
    fill.renderOrder = 1; ring.renderOrder = 2;
    this.selectionMarker.add(fill, ring);
    this.selectionMarker.traverse(node => node.layers.set(1));
    this.selectionMarker.visible = false;
    this.scene.add(this.selectionMarker);
    this.fixedGeometries.push(fillGeometry, ringGeometry);
    this.fixedMaterials.push(fillMaterial, ringMaterial);
  }

  private syncSelectionMarker(): void {
    for (const [id, marker] of this.selectionMarkers) {
      if (this.selectedIds.includes(id) && this.views.has(id)) continue;
      this.scene.remove(marker); this.selectionMarkers.delete(id);
    }
    for (const id of this.selectedIds) {
      const view = this.views.get(id); if (!view) continue;
      let marker = this.selectionMarkers.get(id);
      if (!marker) { marker = this.selectionMarker.clone(); marker.visible = true; this.scene.add(marker); this.selectionMarkers.set(id, marker); }
      view.root.updateWorldMatrix(true, false);
      this.selectionBounds.copy(view.bounds).applyMatrix4(view.root.matrixWorld);
      this.selectionBounds.getCenter(marker.position);
      let radius = .2;
      for (const point of this.boundCorners(view.bounds)) {
        point.applyMatrix4(view.root.matrixWorld);
        radius = Math.max(radius, Math.hypot(point.x - marker.position.x, point.z - marker.position.z));
      }
      marker.position.y = Math.max(0, this.selectionBounds.min.y) + .015;
      // Equal world radii, independent of the object's width/depth and animated limbs.
      marker.scale.set(radius + .08, 1, radius + .08);
    }
  }

  private boundCorners(box: THREE.Box3): THREE.Vector3[] {
    return [box.min.x, box.max.x].flatMap(x => [box.min.y, box.max.y].flatMap(y => [box.min.z, box.max.z].map(z => new THREE.Vector3(x, y, z))));
  }

  private rootFor(id: string): THREE.Object3D | undefined { return id === this.iconCameraId ? this.cameraIcon : this.views.get(id)?.root; }

  private selectedBounds(): THREE.Box3 {
    const bounds = new THREE.Box3();
    for (const id of this.selectedIds) {
      const root = this.rootFor(id); if (!root) continue;
      root.updateWorldMatrix(true, true);
      const view = this.views.get(id);
      bounds.union(view ? view.bounds.clone().applyMatrix4(root.matrixWorld) : new THREE.Box3().setFromObject(root));
    }
    return bounds;
  }

  selectionCenter(): number[] { const box = this.selectedBounds(); return box.isEmpty() ? [0, 0, 0] : box.getCenter(new THREE.Vector3()).toArray(); }

  private setProjection(orthographic: boolean): void {
    const previous = this.editorCamera, next = orthographic ? this.orthographicCamera : this.perspectiveCamera;
    if (previous === next) return;
    next.position.copy(previous.position); next.quaternion.copy(previous.quaternion);
    if (orthographic) {
      const height = 2 * previous.position.distanceTo(this.orbit.target) * Math.tan(this.perspectiveCamera.fov * DEG / 2);
      this.orthographicCamera.zoom = (this.orthographicCamera.top - this.orthographicCamera.bottom) / Math.max(height, .1);
    } else {
      const height = (this.orthographicCamera.top - this.orthographicCamera.bottom) / this.orthographicCamera.zoom;
      next.position.sub(this.orbit.target).normalize().multiplyScalar(height / (2 * Math.tan(this.perspectiveCamera.fov * DEG / 2))).add(this.orbit.target);
    }
    this.editorCamera = next; this.orbit.object = next; this.gizmo.camera = next;
    next.updateProjectionMatrix(); this.orbit.update();
  }

  private snapView(direction: THREE.Vector3): void {
    this.setProjection(true);
    if (Math.abs(direction.y) > .99) direction.z = .00001;
    const distance = Math.max(.25, this.editorCamera.position.distanceTo(this.orbit.target));
    this.viewTween = { start: performance.now(), from: this.editorCamera.position.clone(), to: this.orbit.target.clone().addScaledVector(direction.normalize(), distance) };
  }

  private createCameraIcon(): void {
    this.cameraIcon.name = 'Shot camera';
    this.cameraIcon.userData.entityId = 'camera';
    const geometry = new THREE.BoxGeometry(0.42, 0.28, 0.28);
    const material = new THREE.MeshBasicMaterial({ color: '#7a8995', transparent: true, opacity: 0.16, depthWrite: false });
    const body = new THREE.Mesh(geometry, material);
    const edgesGeometry = new THREE.EdgesGeometry(geometry);
    const lineMaterial = new THREE.LineBasicMaterial({ color: '#657581', toneMapped: false });
    const edges = new THREE.LineSegments(edgesGeometry, lineMaterial);
    this.cameraIcon.add(body, edges);
    const lines: number[] = [];
    const near = [[-0.13, -0.09, -0.14], [0.13, -0.09, -0.14], [0.13, 0.09, -0.14], [-0.13, 0.09, -0.14]];
    const far = [[-0.23, -0.13, -0.46], [0.23, -0.13, -0.46], [0.23, 0.13, -0.46], [-0.23, 0.13, -0.46]];
    for (let index = 0; index < 4; index++) {
      lines.push(...near[index], ...far[index], ...far[index], ...far[(index + 1) % 4]);
    }
    const lensGeometry = new THREE.BufferGeometry();
    lensGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    this.cameraIcon.add(new THREE.LineSegments(lensGeometry, lineMaterial));
    this.cameraIcon.traverse((node) => node.layers.set(1));
    this.fixedGeometries.push(geometry, edgesGeometry, lensGeometry);
    this.fixedMaterials.push(material, lineMaterial);
    this.scene.add(this.cameraIcon);
  }

  private applyPose(object: THREE.Object3D, pose: Transform, withScale = true): void {
    object.position.fromArray(pose.position);
    object.rotation.set(pose.rotation[0] * DEG, pose.rotation[1] * DEG, pose.rotation[2] * DEG, 'XYZ');
    if (withScale) object.scale.fromArray(pose.scale);
  }

  private readPose(object: THREE.Object3D): Transform {
    // Persist the same Euler convention used by the scene model, in degrees.
    const rotation = new THREE.Euler().setFromQuaternion(object.quaternion, 'XYZ');
    const clean = (value: number): number => Math.abs(value) < 0.000001 ? 0 : value;
    return {
      position: [object.position.x, object.position.y, object.position.z].map(clean) as [number, number, number],
      rotation: [rotation.x / DEG, rotation.y / DEG, rotation.z / DEG].map(clean) as [number, number, number],
      scale: [object.scale.x, object.scale.y, object.scale.z].map(clean) as [number, number, number],
    };
  }

  private getSelectedObject(): THREE.Object3D | null {
    if (this.selectedIds.length > 1) return this.groupPivot;
    if (this.selectedId !== null && this.selectedId === this.iconCameraId) return this.cameraIcon;
    if (activePivot(this.currentDoc?.objects.find(item => item.id === this.selectedId)?.components)) return this.objectPivot;
    return this.selectedId ? this.views.get(this.selectedId)?.root ?? null : null;
  }

  private syncSelection(): void {
    if (this.presentingXR) { this.gizmo.detach(); this.gizmo.enabled = false; return; }
    if (this.selectedIds.length > 1 && !this.dragging) {
      this.groupPivot.position.fromArray(this.selectionCenter());
      this.groupPivot.quaternion.copy(this.precision.space === 'local' ? this.rootFor(this.selectedId!)!.quaternion : new THREE.Quaternion());
      this.groupPivot.scale.setScalar(1); this.groupPivot.updateMatrixWorld();
    } else if (this.selectedId && !this.dragging) {
      const item = this.currentDoc?.objects.find(item => item.id === this.selectedId), root = this.rootFor(this.selectedId);
      if (item && root) { this.applyPose(this.objectPivot, toPivotPose(this.readPose(root), evaluateComponents(item, this.currentTime))); this.objectPivot.updateMatrixWorld(); }
    }
    this.uniformHandles(this.selectedIds.length > 1);
    this.gizmo.setSpace(this.tool === 'scale' && this.selectedIds.length < 2 ? 'local' : this.precision.space);
    this.syncAxis();
    const selected = this.getSelectedObject();
    if (!selected || this.playing) {
      this.gizmo.detach();
    } else if (this.gizmo.object !== selected) {
      this.gizmo.attach(selected);
    }
    this.gizmo.enabled = !!selected && !this.playing && this.flyPointer === null && !this.pointerStart?.orbit && !this.pointerStart?.box;
  }

  private syncAxis(): void {
    const all = this.axis === null || (this.selectedIds.length > 1 && this.tool === 'scale');
    this.gizmo.showX = all || this.axis === 'X'; this.gizmo.showY = all || this.axis === 'Y'; this.gizmo.showZ = all || this.axis === 'Z';
  }

  private copyIconToShot(): void {
    if (this.iconCameraId !== this.previewCameraId) return;
    this.shotCamera.position.copy(this.cameraIcon.position);
    this.shotCamera.quaternion.copy(this.cameraIcon.quaternion);
  }

  private onGizmoStart = (): void => {
    if (this.playing || !this.selectedId || !this.gizmo.object) return;
    this.clearNavigation();
    this.dragging = true;
    this.dragEntityId = this.selectedId;
    this.dragPoses.clear();
    for (const id of this.selectedIds) { const root = this.rootFor(id); if (root) this.dragPoses.set(id, this.readPose(root)); }
    this.gizmo.object.updateMatrix(); this.dragPivot.copy(this.gizmo.object.matrix).invert();
    this.lastAxisPress = { axis: this.gizmo.axis, x: this.pointerStart?.x ?? 0, y: this.pointerStart?.y ?? 0, at: performance.now() };
    this.orbit.enabled = false;
    if (this.pointerStart) this.pointerStart.gizmo = true;
    if (!this.options.onTransform(this.currentUpdates(), 'start', this.selectedIds.length > 1)) this.finishGizmo(true);
  };

  private currentUpdates(): PoseUpdate[] {
    return [...this.dragPoses.keys()].map(id => ({ id, transform: this.readPose(this.rootFor(id)!) }));
  }

  private onGizmoChange = (): void => {
    if (!this.dragEntityId || !this.gizmo.object || this.playing) return;
    const object = this.gizmo.object;
    object.scale.clampScalar(0.01, 100);
    object.position.clampScalar(-1000, 1000);
    if (this.dragPoses.size > 1) {
      object.updateMatrix();
      const delta = object.matrix.clone().multiply(this.dragPivot);
      for (const [id, pose] of this.dragPoses) {
        const root = this.rootFor(id)!; this.applyPose(root, pose); root.updateMatrix();
        delta.clone().multiply(root.matrix).decompose(root.position, root.quaternion, root.scale);
      }
    } else if (object === this.objectPivot) {
      const item = this.currentDoc?.objects.find(item => item.id === this.dragEntityId), root = this.rootFor(this.dragEntityId);
      if (item && root) this.applyPose(root, fromPivotPose(this.readPose(object), evaluateComponents(item, this.currentTime)));
    }
    if (this.dragEntityId !== null && this.dragEntityId === this.iconCameraId) this.copyIconToShot();
    if (!this.options.onTransform(this.currentUpdates(), 'change', this.dragPoses.size > 1)) this.finishGizmo(true);
  };

  private onGizmoEnd = (): void => this.finishGizmo();

  private onDraggingChanged = (event: { value?: unknown }): void => {
    this.dragging = event.value === true;
    this.orbit.enabled = !this.dragging && this.flyPointer === null;
  };

  private finishGizmo(cancel = false): void {
    const updates = this.currentUpdates(), wholeMotion = this.dragPoses.size > 1;
    if (cancel) for (const [id, pose] of this.dragPoses) { const root = this.rootFor(id); if (root) this.applyPose(root, pose); }
    this.dragPoses.clear();
    this.dragEntityId = null;
    this.dragging = false;
    if (this.gizmo.dragging) this.gizmo.dragging = false;
    this.orbit.enabled = this.flyPointer === null;
    if (updates.length) this.options.onTransform(updates, cancel ? 'cancel' : 'end', wholeMotion);
  }

  /** Inspector and snap commands use the same atomic gesture as the viewport handles. */
  private applyPlacement(updates: PoseUpdate[]): void {
    if (!updates.length) return;
    if (!this.options.onTransform(updates, 'start', true)) return;
    const ok = this.options.onTransform(updates, 'change', true);
    this.options.onTransform(updates, ok ? 'end' : 'cancel', true);
  }

  transformGroup(group: 'position' | 'rotation' | 'scale', index: number, value: number): void {
    if (!this.selectedIds.length || !Number.isFinite(value)) return;
    const center = new THREE.Vector3().fromArray(this.selectionCenter());
    const delta = new THREE.Matrix4();
    if (group === 'position') {
      const offset = new THREE.Vector3(); offset.setComponent(index, value - center.getComponent(index)); delta.makeTranslation(offset);
    } else {
      const change = group === 'scale' ? new THREE.Matrix4().makeScale(value, value, value) : new THREE.Matrix4().makeRotationAxis(new THREE.Vector3().setComponent(index, 1), value * DEG);
      delta.makeTranslation(center).multiply(change).multiply(new THREE.Matrix4().makeTranslation(center.clone().negate()));
    }
    const scratch = new THREE.Object3D();
    this.applyPlacement(this.selectedIds.map(id => {
      const root = this.rootFor(id)!; root.updateMatrix(); delta.clone().multiply(root.matrix).decompose(scratch.position, scratch.quaternion, scratch.scale);
      return { id, transform: this.readPose(scratch) };
    }));
  }

  alignSelection(axis: number, edge: AlignmentEdge): void {
    if (this.controlled || this.dragging || this.playing) return;
    const ids = this.selectedIds.filter(id => this.views.has(id));
    if (ids.length < 2) return;
    const coordinate = (id: string) => {
      const view = this.views.get(id)!; view.root.updateWorldMatrix(true, true);
      const bounds = view.bounds.clone().applyMatrix4(view.root.matrixWorld);
      return (edge === 'center' ? bounds.getCenter(new THREE.Vector3()) : bounds[edge]).getComponent(axis);
    };
    const target = coordinate(ids.at(-1)!);
    this.applyPlacement(ids.map(id => {
      const transform = this.readPose(this.views.get(id)!.root);
      transform.position[axis] += target - coordinate(id);
      return {id, transform};
    }));
  }

  dropSelection(): void {
    if (this.controlled || this.dragging) return;
    const ids = this.selectedIds.filter(id => this.views.has(id)), pending = new Set(ids);
    const originals = new Map(ids.map(id => [id, this.readPose(this.views.get(id)!.root)]));
    const boxFor = (id: string) => { const view = this.views.get(id)!; view.root.updateWorldMatrix(true, true); return view.bounds.clone().applyMatrix4(view.root.matrixWorld); };
    const ordered = ids.sort((a, b) => boxFor(a).min.y - boxFor(b).min.y), updates: PoseUpdate[] = [];
    const ray = new THREE.Raycaster();
    try {
      for (const id of ordered) {
        const view = this.views.get(id)!, box = boxFor(id);
        const supports = [...this.views].filter(([other, value]) => !pending.has(other) && value.root.visible).map(([, value]) => value.root);
        supports.forEach(root => root.updateWorldMatrix(true, true));
        let height = 0;
        // Sample inside the actual rotated footprint rather than the corners of its world AABB.
        for (const x of [.2, .5, .8]) for (const z of [.2, .5, .8]) {
          const point = new THREE.Vector3(THREE.MathUtils.lerp(view.bounds.min.x, view.bounds.max.x, x), view.bounds.min.y, THREE.MathUtils.lerp(view.bounds.min.z, view.bounds.max.z, z)).applyMatrix4(view.root.matrixWorld);
          ray.set(new THREE.Vector3(point.x, Math.max(0, box.min.y) + .03, point.z), new THREE.Vector3(0, -1, 0));
          for (const hit of ray.intersectObjects(supports, true)) if (hit.face && hit.face.normal.clone().transformDirection(hit.object.matrixWorld).y > .5) { height = Math.max(height, hit.point.y); break; }
        }
        view.root.position.y += height - box.min.y; view.root.updateMatrixWorld(true);
        updates.push({ id, transform: this.readPose(view.root) }); pending.delete(id);
      }
    } finally { for (const [id, pose] of originals) this.applyPose(this.views.get(id)!.root, pose); }
    this.applyPlacement(updates);
  }

  private onDoubleClick = (event: MouseEvent): void => {
    const press = this.lastAxisPress;
    if (this.tool !== 'translate' || !press || press.axis !== 'Y' || performance.now() - press.at > 600 || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) return;
    event.preventDefault(); this.dropSelection();
  };

  private pick(event: PointerEvent): string | null {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.scene.updateMatrixWorld(true);
    this.editorCamera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.editorCamera);
    const roots = [...this.views.values()].filter(view => view.root.visible).map((view) => view.root);
    if (this.cameraIcon.visible) roots.push(this.cameraIcon);
    const hits = this.raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        if (typeof node.userData.entityId === 'string') return node.userData.entityId;
        node = node.parent;
      }
    }
    return null;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.presentingXR) return;
    if(this.controlled){event.preventDefault();event.stopImmediatePropagation();this.focusCanvas();return;}
    if (event.pointerType === 'touch' && !event.isPrimary) return;
    this.renderer.domElement.focus({ preventScroll: true });
    this.viewTween = null;
    if (event.button === 2) {
      if (this.dragging) return;
      this.setProjection(false);
      event.preventDefault();
      event.stopImmediatePropagation();
      this.pointerStart = null;
      this.flyPointer = event.pointerId;
      this.lastPointer.set(event.clientX, event.clientY);
      this.lookEuler.setFromQuaternion(this.editorCamera.quaternion, 'YXZ');
      this.orbit.enabled = false;
      this.gizmo.enabled = false;
      this.renderer.domElement.setPointerCapture(event.pointerId);
      this.options.onStatus('Fly camera · WASD to move · Q / E down / up · Shift for speed · Release right mouse to finish');
      return;
    }
    if (event.button !== 0 || this.flyPointer !== null) return;
    const overGizmo = !event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && !this.playing && this.gizmo.enabled && this.gizmo.axis !== null;
    const selected = this.pick(event);
    const box = event.shiftKey && !event.altKey && !selected;
    const orbit = !box && (event.altKey || (!selected && !overGizmo));
    this.pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY, selected, orbit, gizmo: overGizmo, box, additive: event.ctrlKey || event.metaKey, toggle: event.ctrlKey || event.metaKey || event.shiftKey };
    this.orbit.enabled = orbit && !overGizmo;
    if (!overGizmo) this.gizmo.enabled = false;
    if (box) { event.preventDefault(); event.stopImmediatePropagation(); this.renderer.domElement.setPointerCapture(event.pointerId); }
  };

  private onPointerMove = (event: PointerEvent): void => {
    const start = this.pointerStart;
    if (start?.box && start.id === event.pointerId) {
      event.preventDefault(); event.stopImmediatePropagation();
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.selectionBox.hidden = false;
      this.selectionBox.style.left = `${Math.min(start.x, event.clientX) - rect.left}px`;
      this.selectionBox.style.top = `${Math.min(start.y, event.clientY) - rect.top}px`;
      this.selectionBox.style.width = `${Math.abs(event.clientX - start.x)}px`; this.selectionBox.style.height = `${Math.abs(event.clientY - start.y)}px`;
      return;
    }
    if (this.flyPointer !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    this.lastPointer.set(event.clientX, event.clientY);
    this.lookEuler.y -= dx * 0.003;
    this.lookEuler.x = THREE.MathUtils.clamp(this.lookEuler.x - dy * 0.003, -Math.PI / 2 + 0.015, Math.PI / 2 - 0.015);
    this.editorCamera.quaternion.setFromEuler(this.lookEuler);
    this.keepFlyTarget();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.flyPointer === event.pointerId) {
      this.clearNavigation();
      return;
    }
    const start = this.pointerStart;
    if (!start || start.id !== event.pointerId || event.button !== 0) return;
    this.pointerStart = null;
    this.selectionBox.hidden = true;
    if (start.box && this.renderer.domElement.hasPointerCapture(event.pointerId)) this.renderer.domElement.releasePointerCapture(event.pointerId);
    this.orbit.enabled = !this.dragging;
    this.gizmo.enabled = !!this.selectedId && !this.playing;
    if (start.orbit) this.gizmo.axis = null;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (start.box && moved > 5) {
      this.options.onSelect(this.boxSelection(start.x, start.y, event.clientX, event.clientY), start.additive ? 'append' : 'replace'); return;
    }
    if (moved <= 5 && !start.gizmo && !event.altKey && (!start.orbit || start.selected === null)) {
      this.options.onSelect(start.selected ? [start.selected] : [], start.toggle ? 'toggle' : 'replace');
    }
  };

  private boxSelection(x1: number, y1: number, x2: number, y2: number): string[] {
    const rect = this.renderer.domElement.getBoundingClientRect(), ids: string[] = [];
    this.editorCamera.updateMatrixWorld(true);
    for (const [id, view] of this.views) {
      if (!view.root.visible) continue;
      view.root.updateWorldMatrix(true, false);
      const points = this.boundCorners(view.bounds).map(point => point.applyMatrix4(view.root.matrixWorld).project(this.editorCamera)).filter(point => point.z >= -1 && point.z <= 1);
      if (!points.length) continue;
      const xs = points.map(point => rect.left + (point.x + 1) * rect.width / 2), ys = points.map(point => rect.top + (1 - point.y) * rect.height / 2);
      if (Math.max(...xs) >= Math.min(x1, x2) && Math.min(...xs) <= Math.max(x1, x2) && Math.max(...ys) >= Math.min(y1, y2) && Math.min(...ys) <= Math.max(y1, y2)) ids.push(id);
    }
    return ids;
  }

  private onPointerCancel = (): void => {
    this.pointerStart = null;
    this.selectionBox.hidden = true;
    this.clearNavigation();
    this.finishGizmo(true);
    this.gizmo.axis = null;
  };

  private onBlur = (): void => {
    if (this.pointerStart?.box && this.renderer.domElement.hasPointerCapture(this.pointerStart.id)) this.renderer.domElement.releasePointerCapture(this.pointerStart.id);
    this.pointerStart = null;
    this.selectionBox.hidden = true;
    this.clearNavigation();
    if (this.dragging) this.finishGizmo();
  };

  private isTextInput(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.presentingXR) return;
    if(this.controlled)return;
    if (document.activeElement !== this.renderer.domElement || this.isTextInput(event.target)) return;
    const key = event.key.toLowerCase();
    if (this.flyPointer !== null && ['w', 'a', 's', 'd', 'q', 'e', 'shift'].includes(key)) {
      this.keys.add(key);
      event.preventDefault();
      event.stopPropagation();
    } else if (key === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      this.focusSelection();
    } else if (key === 'escape') {
      if (this.dragging || this.pointerStart?.box) { event.preventDefault(); event.stopPropagation(); this.onPointerCancel(); }
      this.clearNavigation();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    if (this.keys.has(key) && this.flyPointer !== null) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.keys.delete(key);
  };

  private clearNavigation(): void {
    const pointer = this.flyPointer;
    this.flyPointer = null;
    this.keys.clear();
    if (pointer !== null && this.renderer.domElement.hasPointerCapture(pointer)) {
      this.renderer.domElement.releasePointerCapture(pointer);
    }
    this.orbit.enabled = !this.dragging;
    this.gizmo.enabled = !!this.selectedId && !this.playing && !this.pointerStart?.orbit;
    if (pointer !== null) {
      this.gizmo.axis = null;
      this.orbit.update();
      this.options.onStatus(NAV_HINT);
    }
  }

  private keepFlyTarget(): void {
    const distance = Math.max(this.editorCamera.position.distanceTo(this.orbit.target), 2);
    this.editorCamera.getWorldDirection(this.direction);
    this.orbit.target.copy(this.editorCamera.position).addScaledVector(this.direction, distance);
  }

  private updateFly(delta: number): void {
    if (this.flyPointer === null) return;
    this.editorCamera.getWorldDirection(this.direction);
    this.right.setFromMatrixColumn(this.editorCamera.matrix, 0).normalize();
    this.velocity.set(0, 0, 0);
    if (this.keys.has('w')) this.velocity.add(this.direction);
    if (this.keys.has('s')) this.velocity.sub(this.direction);
    if (this.keys.has('d')) this.velocity.add(this.right);
    if (this.keys.has('a')) this.velocity.sub(this.right);
    if (this.keys.has('e')) this.velocity.y += 1;
    if (this.keys.has('q')) this.velocity.y -= 1;
    if (this.velocity.lengthSq() > 0) {
      this.velocity.normalize().multiplyScalar(delta * (this.keys.has('shift') ? 12 : 3.5));
      this.editorCamera.position.add(this.velocity);
      this.orbit.target.add(this.velocity);
    }
  }

  private resize = (): void => {
    if (this.disposed || this.presentingXR) return;
    const { viewport, preview } = this.options;
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.perspectiveCamera.aspect = width / height;
    this.perspectiveCamera.updateProjectionMatrix();
    this.orthographicCamera.left = -10 * width / height; this.orthographicCamera.right = 10 * width / height;
    this.orthographicCamera.updateProjectionMatrix();
    const hostWidth = Math.max(1, preview.clientWidth);
    const hostHeight = preview.clientHeight || hostWidth * 9 / 16;
    const previewWidth = Math.max(1, Math.min(hostWidth, hostHeight * 16 / 9));
    const previewHeight = previewWidth * 9 / 16;
    this.previewRenderer.setPixelRatio(dpr);
    this.previewRenderer.setSize(Math.round(previewWidth), Math.round(previewHeight), false);
    this.previewRenderer.domElement.style.width = `${previewWidth}px`;
    this.previewRenderer.domElement.style.height = `${previewHeight}px`;
  };

  private render = (time: number, frame?: XRFrame): void => {
    if (this.disposed) return;
    this.options.onFrame?.(time);
    if (this.presentingXR && this.xrControls) {
      this.xrControls.updateView(frame, time);
      this.xrControls.rig.updateMatrixWorld(true);
      this.renderer.xr.updateCamera(this.xrControls.camera);
      this.xrControls.update(frame);
      this.syncSelectionMarker();
      this.renderer.render(this.scene, this.xrControls.camera);
      return;
    }
    const delta = Math.min(this.lastFrame ? (time - this.lastFrame) / 1000 : 0, 0.05);
    this.lastFrame = time;
    this.updateFly(delta);
    if (this.viewTween) {
      const t = Math.min(1, (time - this.viewTween.start) / 240), eased = 1 - Math.pow(1 - t, 3);
      this.editorCamera.position.lerpVectors(this.viewTween.from, this.viewTween.to, eased); this.orbit.update();
      if (t >= 1) this.viewTween = null;
    } else if (this.flyPointer === null && this.orbit.enabled) this.orbit.update();
    if (this.dragEntityId !== null && this.dragEntityId === this.iconCameraId) this.copyIconToShot();
    this.syncSelectionMarker();
    this.navigation.update(this.editorCamera, this.editorCamera === this.orthographicCamera, !this.controlled && !this.dragging);
    this.renderer.render(this.scene, this.editorCamera);
    this.previewRenderer.render(this.scene, this.shotCamera);
  };

  private listen(target: EventTarget, type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void {
    target.addEventListener(type, listener, options);
    this.removeListeners.push(() => target.removeEventListener(type, listener, options));
  }
}
