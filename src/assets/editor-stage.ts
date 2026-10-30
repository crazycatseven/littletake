import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { drivenProperties } from './toolkit/edits';
import { evaluateAsset, createAssetGroup, disposeAssetGroup, recipeBounds, poseAssetJoints } from './model';
import type { AssetDraft, AssetEdit } from './edit';
import { inputController, updateComponents } from '../components/model';
import type { Transform, Vec3, ToolMode } from '../types';

/** Independent asset coordinates: never constructs a Project Scene or edits the stage camera. */
export class AssetEditorStage {
  private renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, .01, 3000);
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private group = new THREE.Group();
  private box = new THREE.Box3Helper(new THREE.Box3(), 0x8f9c78);
  private selection = new THREE.Box3Helper(new THREE.Box3(), 0xb88656);
  private grid = new THREE.GridHelper(20, 40, 0xb2b9ab, 0xd7dbd0);
  private axes = new THREE.AxesHelper(.3);
  private draft?: AssetDraft;
  private selected: string | null = null;
  private tool: ToolMode = 'translate';
  private frame = 0;
  private resize: ResizeObserver;
  private nodes = new Map<string, THREE.Object3D>();
  private meshes = new Map<string, THREE.Mesh>();
  private joints = new Map<string, THREE.Object3D>();
  private testing = false;
  private editable = true;
  private keys = new Set<string>();
  private pose: Transform = { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] };
  private runtime = { velocity: 0, yaw: 0 };
  private lastTime = 0;
  private startPointer = [0, 0];
  private dragChanged = false;
  constructor(private host: HTMLElement, private onSelect: (id: string | null) => void, private onEdit: (edits: AssetEdit[]) => void) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); this.renderer.setClearColor(0xf2f3ed);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute('aria-label', 'Prefab viewport'); host.append(this.renderer.domElement);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement); this.orbit.enableDamping = true;
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement); this.gizmo.setSize(.8); this.gizmo.setSpace('local');
    // Three shares the TransformControls raycaster with the main stage, which
    // uses layer 1 for handles. Keep this independent viewport on that layer too.
    this.gizmo.getHelper().traverse(node => node.layers.set(1));
    this.gizmo.getRaycaster().layers.set(1); this.camera.layers.enable(1);
    const light = new THREE.DirectionalLight(0xffffff, 2.8); light.position.set(4, 7, 5);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb7bea9, 2.1), light, this.grid, this.axes, this.group, this.box, this.selection, this.gizmo.getHelper());
    // Detaching here clears TransformControls.axis and silently cancels the drag.
    // Trial poses are reset before selecting/attaching a handle instead.
    this.gizmo.addEventListener('dragging-changed', event => { this.orbit.enabled = !event.value; if (event.value) this.dragChanged = false; });
    this.gizmo.addEventListener('objectChange', () => { this.dragChanged = true; this.updateBoxes(); });
    this.gizmo.addEventListener('mouseUp', () => {
      if (!this.dragChanged || !this.selected) return;
      const node = this.nodes.get(this.selected)!, mesh = this.meshes.get(this.selected)!;
      const changes = this.tool === 'scale' ? { size: mesh.scale.toArray() as Vec3 } : this.tool === 'rotate'
        ? { rotation: [node.rotation.x, node.rotation.y, node.rotation.z].map(v => THREE.MathUtils.radToDeg(v) % 360) as Vec3 }
        : { position: node.position.toArray() as Vec3 };
      const source=this.draft?.parts.find(p=>p.id===this.selected);
      if(!source)return;
      const property=this.tool==='scale'?'size':this.tool==='rotate'?'rotation':'position';
      for(const driven of drivenProperties(this.draft!,source.id))if(driven.startsWith(property+'.')){const i=['x','y','z'].indexOf(driven.split('.')[1]); const values=changes[property];if(values)values[i]=source[property][i];}
      if(property==='position'&&!source.parentId&&this.draft?.construction){const values=changes.position!;for(let i=0;i<3;i++)if(!drivenProperties(this.draft,source.id).includes(('position.'+['x','y','z'][i]) as any))values[i]-=this.draft.construction.offset[i];}
      this.onEdit([{ type: 'set_part', id: this.selected, changes }]);
    });
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', e => { this.startPointer = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', e => {
      if (Math.hypot(e.clientX - this.startPointer[0], e.clientY - this.startPointer[1]) > 4 || this.gizmo.axis || this.testing) return;
      const rect = canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), this.camera);
      let hit: THREE.Object3D | null = ray.intersectObject(this.group, true)[0]?.object ?? null;
      while (hit && !hit.userData.partId) hit = hit.parent;
      this.onSelect(hit?.userData.partId ?? null);
    });
    canvas.addEventListener('keydown', e => { if (this.testing && ['w','a','s','d','f','v','shift',' '].includes(e.key.toLowerCase())) { e.preventDefault(); e.stopPropagation(); this.keys.add(e.key.toLowerCase()); } });
    canvas.addEventListener('keyup', e => { this.keys.delete(e.key.toLowerCase()); }); canvas.addEventListener('blur', () => this.keys.clear());
    this.resize = new ResizeObserver(() => { const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; this.renderer.setSize(w, h); this.camera.aspect = w/h; this.camera.updateProjectionMatrix(); }); this.resize.observe(host);
    this.frame = requestAnimationFrame(this.tick);
  }
  setDraft(draft: AssetDraft, selected: string | null, fit = false) {
    this.resetTests(); this.draft = draft; this.gizmo.detach(); this.scene.remove(this.group); disposeAssetGroup(this.group);
    this.group = createAssetGroup(draft); this.scene.add(this.group); this.nodes.clear(); this.meshes.clear(); this.joints.clear();
    this.group.traverse(node => {
      if (!node.userData.partId) return;
      this.nodes.set(node.userData.partId, node);
      const pivot = node.children[0], mesh = pivot.children[0].children.find(child => child instanceof THREE.Mesh) as THREE.Mesh;
      if(mesh)this.meshes.set(node.userData.partId, mesh); if (pivot.userData.joint) this.joints.set(node.userData.partId, pivot);
    });
    this.select(selected); if (fit) this.view('perspective');
  }
  select(id: string | null) { this.resetTests(); this.selected = id; this.attach(); this.updateBoxes(); }
  setTool(tool: ToolMode) { this.resetTests(); this.tool = tool; this.gizmo.setMode(tool); this.attach(); }
  setEditable(value: boolean) { this.editable = value; this.attach(); }
  private attach() {
    this.gizmo.detach(); if(!this.selected||this.testing||!this.editable||!this.draft)return;
    const source=this.draft.parts.find(p=>p.id===this.selected); if(!source)return;
    const target=(this.tool==='scale'?this.meshes:this.nodes).get(this.selected); if(!target)return;
    const property=this.tool==='scale'?'size':this.tool==='rotate'?'rotation':'position',driven=drivenProperties(this.draft,source.id);
    this.gizmo.showX=!driven.includes((property+'.x') as any);this.gizmo.showY=!driven.includes((property+'.y') as any);this.gizmo.showZ=!driven.includes((property+'.z') as any);
    this.gizmo.attach(target);
  }
  private updateBoxes() {
    this.group.updateMatrixWorld(true); this.box.box.setFromObject(this.group, true);
    const node = this.selected ? this.nodes.get(this.selected) : null; this.selection.visible = !!node;
    if (node) this.selection.box.setFromObject(node, true);
  }
  view(view: 'perspective' | 'front' | 'side' | 'top') {
    if (!this.draft) return;
    const bounds = recipeBounds(this.draft), center = new THREE.Vector3(...bounds.min).add(new THREE.Vector3(...bounds.max)).multiplyScalar(.5);
    const radius = Math.max(...bounds.size, .3), direction = view === 'front' ? [0,0,1] : view === 'side' ? [1,0,0] : view === 'top' ? [0,1,.001] : [1.2,.8,1.6];
    this.camera.position.copy(center).add(new THREE.Vector3(...direction as Vec3).normalize().multiplyScalar(radius * 2.4)); this.orbit.target.copy(center); this.camera.lookAt(center); this.orbit.update();
  }
  testJoint(id: string, degrees: number) {
    this.resetTests(); const pivot = this.joints.get(id), joint = this.draft ? evaluateAsset(this.draft).parts.find(p => p.id === id)?.joint : undefined;
    if (pivot && joint) { this.gizmo.detach(); poseAssetJoints(this.group, this.draft!, { [id]: degrees }); this.updateBoxes(); }
  }
  testComponent(enabled: boolean) { this.resetTests(); this.testing = enabled; if (enabled) { this.gizmo.detach(); this.renderer.domElement.focus(); } }
  resetTests() {
    this.testing = false; this.keys.clear(); this.runtime = { velocity: 0, yaw: 0 };
    this.pose = { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }; this.group.position.set(0,0,0); this.group.rotation.set(0,0,0);
    for (const pivot of this.joints.values()) pivot.rotation.set(0,0,0); this.attach(); this.updateBoxes();
  }
  private tick = (now: number) => {
    const dt = Math.min((now - this.lastTime) / 1000, .05); this.lastTime = now;
    const components = this.draft?.template?.components;
    if (this.testing && inputController(components)) { updateComponents(components, this.pose, this.keys, dt, this.runtime); this.group.position.fromArray(this.pose.position); this.group.rotation.set(...this.pose.rotation.map(THREE.MathUtils.degToRad) as Vec3); this.updateBoxes(); }
    this.orbit.update(); this.renderer.render(this.scene, this.camera); this.frame = requestAnimationFrame(this.tick);
  };
  dispose() {
    cancelAnimationFrame(this.frame); this.resize.disconnect(); this.gizmo.dispose(); this.orbit.dispose(); disposeAssetGroup(this.group);
    for (const line of [this.box, this.selection, this.grid, this.axes]) { line.geometry.dispose(); for (const material of Array.isArray(line.material) ? line.material : [line.material]) material.dispose(); }
    this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
