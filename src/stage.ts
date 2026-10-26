import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { evaluateTransform } from './model';
import type { Axis, PrimitiveKind, SceneDocument, SceneObject, StageOptions, ToolMode, Transform } from './types';

interface EntityView {
  root: THREE.Group;
  kind: PrimitiveKind;
  material: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  color: string;
}
interface PointerStart {
  id: number;
  x: number;
  y: number;
  selected: string | null;
  orbit: boolean;
  gizmo: boolean;
}

const DEG = Math.PI / 180;
const NAV_HINT = 'Drag empty space to orbit · Middle drag to pan · Scroll to zoom · RMB + WASD / Q E to fly · F to focus';

/** Two persistent views of one scene: an editor with tools, and a clean shot camera. */
export class Stage {
  private readonly options: StageOptions;
  private readonly scene = new THREE.Scene();
  private readonly editorCamera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
  private readonly shotCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 500);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly previewRenderer: THREE.WebGLRenderer;
  private readonly orbit: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly gizmoHelper: THREE.Object3D;
  private readonly selection = new THREE.BoxHelper(this.scene, 0xf3ae65);
  private readonly cameraIcon = new THREE.Group();
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
  private playing = false;
  private dragging = false;
  private dragEntityId: string | null = null;
  private tool: ToolMode = 'translate';
  private axis: Axis | null = null;
  private pointerStart: PointerStart | null = null;
  private flyPointer: number | null = null;
  private lastPointer = new THREE.Vector2();
  private frame = 0;
  private lastFrame = 0;
  private disposed = false;

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
    // The control raycaster must use the same layer as the visible helper.
    this.gizmoHelper.traverse((node) => node.layers.set(1));
    this.gizmo.getRaycaster().layers.set(1);
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('mouseDown', this.onGizmoStart);
    this.gizmo.addEventListener('objectChange', this.onGizmoChange);
    this.gizmo.addEventListener('mouseUp', this.onGizmoEnd);
    this.gizmo.addEventListener('dragging-changed', this.onDraggingChanged);

    this.selection.layers.set(1);
    this.selection.visible = false;
    this.selection.material.depthTest = false;
    this.selection.material.transparent = true;
    this.selection.material.opacity = 0.85;
    this.selection.material.toneMapped = false;
    this.scene.add(this.selection);
    this.sun = this.createEnvironment();
    this.createCameraIcon();
    this.resetView();

    this.listen(canvas, 'pointerdown', this.onPointerDown as EventListener, true);
    this.listen(canvas, 'pointermove', this.onPointerMove as EventListener, true);
    this.listen(window, 'pointerup', this.onPointerUp as EventListener);
    this.listen(window, 'pointercancel', this.onPointerCancel as EventListener);
    this.listen(canvas, 'contextmenu', (event) => event.preventDefault());
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
    this.frame = requestAnimationFrame(this.render);
  }

  update(doc: SceneDocument, time: number, selectedId: string | null, playing: boolean): void {
    if (this.disposed) return;
    const liveIds = new Set(doc.objects.map((object) => object.id));
    for (const [id, view] of this.views) {
      if (liveIds.has(id)) continue;
      if (this.dragEntityId === id) this.finishGizmo();
      this.scene.remove(view.root);
      view.material.dispose();
      view.accent.dispose();
      this.views.delete(id);
    }
    for (const object of doc.objects) {
      let view = this.views.get(object.id);
      if (!view || view.kind !== object.kind) {
        if (view) {
          this.scene.remove(view.root);
          view.material.dispose();
          view.accent.dispose();
        }
        view = this.createEntity(object);
        this.views.set(object.id, view);
        this.scene.add(view.root);
      }
      if (view.color !== object.color) {
        view.material.color.set(object.color);
        view.accent.color.copy(view.material.color).multiplyScalar(0.72);
        view.color = object.color;
      }
      view.root.name = object.name;
      if (this.dragEntityId !== object.id) this.applyPose(view.root, evaluateTransform(object, time));
    }
    if (this.dragEntityId !== 'camera') {
      const cameraPose = evaluateTransform(doc.camera, time);
      this.applyPose(this.cameraIcon, cameraPose);
      this.applyPose(this.shotCamera, cameraPose, false);
    } else {
      this.copyIconToShot();
    }
    if (this.shotCamera.fov !== doc.camera.fov) {
      this.shotCamera.fov = THREE.MathUtils.clamp(doc.camera.fov, 10, 120);
      this.shotCamera.updateProjectionMatrix();
    }
    const validSelectedId = selectedId === 'camera' || (selectedId && this.views.has(selectedId)) ? selectedId : null;
    if ((playing && !this.playing) || validSelectedId !== this.selectedId) this.finishGizmo();
    this.playing = playing;
    this.selectedId = validSelectedId;
    this.syncSelection();
  }

  setTool(mode: ToolMode): void {
    this.tool = mode;
    this.gizmo.setMode(mode);
    this.gizmo.setSpace(mode === 'scale' ? 'local' : 'world');
    this.options.onStatus(`${mode[0].toUpperCase()}${mode.slice(1)}${this.axis ? ` on ${this.axis}` : ''} · Drag a colored handle · F to focus`);
  }

  setAxis(axis: Axis | null): void {
    this.axis = axis;
    this.gizmo.showX = axis === null || axis === 'X';
    this.gizmo.showY = axis === null || axis === 'Y';
    this.gizmo.showZ = axis === null || axis === 'Z';
    this.options.onStatus(`${this.tool[0].toUpperCase()}${this.tool.slice(1)} · ${axis ? `${axis} axis` : 'All axes'} · Drag the handle`);
  }

  focusSelection(): void {
    const object = this.getSelectedObject();
    if (!object) {
      this.resetView();
      return;
    }
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 0.4);
    const distance = radius / Math.sin(this.editorCamera.fov * DEG * 0.5) * 1.3;
    const outward = this.editorCamera.position.clone().sub(this.orbit.target).normalize();
    if (outward.lengthSq() < 0.1) outward.set(1, 0.6, 1).normalize();
    this.editorCamera.position.copy(center).addScaledVector(outward, distance);
    this.orbit.target.copy(center);
    this.orbit.update();
  }

  resetView(): void {
    this.clearNavigation();
    this.editorCamera.position.set(8, 6, 10);
    this.orbit.target.set(0, 1, 0);
    this.orbit.update();
  }

  captureView(): { transform: Transform; fov: number } {
    return { transform: this.readPose(this.editorCamera), fov: this.editorCamera.fov };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.clearNavigation();
    this.resizeObserver.disconnect();
    this.removeListeners.forEach((remove) => remove());
    this.gizmo.removeEventListener('mouseDown', this.onGizmoStart);
    this.gizmo.removeEventListener('objectChange', this.onGizmoChange);
    this.gizmo.removeEventListener('mouseUp', this.onGizmoEnd);
    this.gizmo.removeEventListener('dragging-changed', this.onDraggingChanged);
    this.gizmo.dispose();
    this.orbit.dispose();
    for (const view of this.views.values()) {
      view.material.dispose();
      view.accent.dispose();
    }
    this.views.clear();
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.fixedGeometries.forEach((geometry) => geometry.dispose());
    this.fixedMaterials.forEach((material) => material.dispose());
    this.selection.geometry.dispose();
    this.selection.material.dispose();
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
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    return { root, kind: object.kind, material, accent, color: object.color };
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
    if (this.selectedId === 'camera') return this.cameraIcon;
    return this.selectedId ? this.views.get(this.selectedId)?.root ?? null : null;
  }

  private syncSelection(): void {
    const selected = this.getSelectedObject();
    this.selection.visible = !!selected;
    if (selected) this.selection.setFromObject(selected);
    if (!selected || this.playing) {
      this.gizmo.detach();
    } else if (this.gizmo.object !== selected) {
      this.gizmo.attach(selected);
    }
    this.gizmo.enabled = !!selected && !this.playing && this.flyPointer === null && !this.pointerStart?.orbit;
  }

  private copyIconToShot(): void {
    this.shotCamera.position.copy(this.cameraIcon.position);
    this.shotCamera.quaternion.copy(this.cameraIcon.quaternion);
  }

  private onGizmoStart = (): void => {
    if (this.playing || !this.selectedId || !this.gizmo.object) return;
    this.clearNavigation();
    this.dragging = true;
    this.dragEntityId = this.selectedId;
    this.orbit.enabled = false;
    if (this.pointerStart) this.pointerStart.gizmo = true;
    this.options.onTransform(this.dragEntityId, this.readPose(this.gizmo.object), 'start');
  };

  private onGizmoChange = (): void => {
    if (!this.dragEntityId || !this.gizmo.object || this.playing) return;
    const object = this.gizmo.object;
    object.scale.clampScalar(0.01, 100);
    object.position.clampScalar(-1000, 1000);
    if (this.dragEntityId === 'camera') this.copyIconToShot();
    this.options.onTransform(this.dragEntityId, this.readPose(object), 'change');
  };

  private onGizmoEnd = (): void => this.finishGizmo();

  private onDraggingChanged = (event: { value?: unknown }): void => {
    this.dragging = event.value === true;
    this.orbit.enabled = !this.dragging && this.flyPointer === null;
  };

  private finishGizmo(): void {
    const id = this.dragEntityId;
    const object = id === 'camera' ? this.cameraIcon : id ? this.views.get(id)?.root : null;
    this.dragEntityId = null;
    this.dragging = false;
    if (this.gizmo.dragging) this.gizmo.dragging = false;
    this.orbit.enabled = this.flyPointer === null;
    if (id && object) this.options.onTransform(id, this.readPose(object), 'end');
  }

  private pick(event: PointerEvent): string | null {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.scene.updateMatrixWorld(true);
    this.editorCamera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.editorCamera);
    const roots = [...this.views.values()].map((view) => view.root);
    roots.push(this.cameraIcon);
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
    if (event.pointerType === 'touch' && !event.isPrimary) return;
    this.renderer.domElement.focus({ preventScroll: true });
    if (event.button === 2) {
      if (this.dragging) return;
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
    const overGizmo = !event.altKey && !this.playing && this.gizmo.enabled && this.gizmo.axis !== null;
    const selected = this.pick(event);
    const orbit = event.altKey || (!selected && !overGizmo);
    this.pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY, selected, orbit, gizmo: overGizmo };
    this.orbit.enabled = orbit && !overGizmo;
    if (orbit) this.gizmo.enabled = false;
  };

  private onPointerMove = (event: PointerEvent): void => {
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
    this.orbit.enabled = !this.dragging;
    this.gizmo.enabled = !!this.selectedId && !this.playing;
    if (start.orbit) this.gizmo.axis = null;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (moved <= 5 && !start.gizmo && !event.altKey && (!start.orbit || start.selected === null)) {
      this.options.onSelect(start.selected);
    }
  };

  private onPointerCancel = (): void => {
    this.pointerStart = null;
    this.clearNavigation();
    this.finishGizmo();
    this.gizmo.axis = null;
  };

  private onBlur = (): void => {
    this.pointerStart = null;
    this.clearNavigation();
  };

  private isTextInput(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');
  }

  private onKeyDown = (event: KeyboardEvent): void => {
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
    if (this.disposed) return;
    const { viewport, preview } = this.options;
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.editorCamera.aspect = width / height;
    this.editorCamera.updateProjectionMatrix();
    const hostWidth = Math.max(1, preview.clientWidth);
    const hostHeight = preview.clientHeight || hostWidth * 9 / 16;
    const previewWidth = Math.max(1, Math.min(hostWidth, hostHeight * 16 / 9));
    const previewHeight = previewWidth * 9 / 16;
    this.previewRenderer.setPixelRatio(dpr);
    this.previewRenderer.setSize(Math.round(previewWidth), Math.round(previewHeight), false);
    this.previewRenderer.domElement.style.width = `${previewWidth}px`;
    this.previewRenderer.domElement.style.height = `${previewHeight}px`;
  };

  private render = (time: number): void => {
    if (this.disposed) return;
    const delta = Math.min(this.lastFrame ? (time - this.lastFrame) / 1000 : 0, 0.05);
    this.lastFrame = time;
    this.updateFly(delta);
    if (this.flyPointer === null && this.orbit.enabled) this.orbit.update();
    if (this.selection.visible) this.selection.update();
    if (this.dragEntityId === 'camera') this.copyIconToShot();
    this.renderer.render(this.scene, this.editorCamera);
    this.previewRenderer.render(this.scene, this.shotCamera);
    this.frame = requestAnimationFrame(this.render);
  };

  private listen(target: EventTarget, type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void {
    target.addEventListener(type, listener, options);
    this.removeListeners.push(() => target.removeEventListener(type, listener, options));
  }
}
