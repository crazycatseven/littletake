import { sceneWorldMatrices, matrixTransform, effectivelyHidden } from '../placement/hierarchy';
import * as THREE from 'three';
import { evaluateFov, evaluateJointAngles } from '../model';
import { poseAssetJoints, type AssetDefinition } from '../assets/model';
import { DEFAULT_SCENE_LOOK } from '../scene-edit/look';

import type { SceneDocument, Transform } from '../types';
import {renderCameraFrame} from '../scene-snapshot';
import {cameraFarForBounds} from '../spatial/geometry';

/** Assets face +Z. Remove rotation, not scale, when describing which side the shot sees. */
export function objectCameraView(root: THREE.Object3D, cameraPosition: THREE.Vector3) {
  root.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(root);
  if (bounds.isEmpty()) return undefined;
  const center = bounds.getCenter(new THREE.Vector3());
  const local = cameraPosition.clone().sub(root.getWorldPosition(new THREE.Vector3())).applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()).invert());
  const azimuth = THREE.MathUtils.radToDeg(Math.atan2(local.x, local.z));
  const elevation = THREE.MathUtils.radToDeg(Math.atan2(cameraPosition.y - center.y, Math.hypot(cameraPosition.x - center.x, cameraPosition.z - center.z)));
  return { azimuth, elevation };
}

export interface DepthRange { near: number; far: number }
/** Wide range used only to measure where a shot's geometry actually sits. */
const DEPTH_LOG_RANGE: DepthRange = { near: .05, far: 2000 };

/** Camera-distance shader. 'log' packs distance for measuring; 'disparity' is normalised inverse depth (near = 1), the form depth video models are trained on. */
function depthMaterial(mode: 'log' | 'disparity', range: DepthRange): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { near: { value: range.near }, far: { value: range.far } },
    defines: mode === 'log' ? { DEPTH_LOG: '' } : {},
    side: THREE.DoubleSide,
    vertexShader: `#include <common>
#include <skinning_pars_vertex>
varying float vDepth;
void main() {
#include <skinbase_vertex>
#include <begin_vertex>
#include <skinning_vertex>
#include <project_vertex>
  vDepth = -mvPosition.z;
}`,
    fragmentShader: `uniform float near; uniform float far; varying float vDepth;
void main() {
#ifdef DEPTH_LOG
  float v = log(max(vDepth, near) / near) / log(far / near);
#else
  float d = clamp(vDepth, near, far);
  float v = (1.0 / d - 1.0 / far) / (1.0 / near - 1.0 / far);
#endif
  gl_FragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
}`,
  });
}

/** An export owns its geometry, materials, camera and poses; the live editor keeps running independently. */
export class ShotRenderer {
  readonly document: SceneDocument;
  readonly canvas: HTMLCanvasElement;
  readonly sourceState: string;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private roots = new Map<string, THREE.Object3D>();
  private assets: AssetDefinition[];
  private geometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  private materials = new Map<THREE.Material, THREE.Material>();
  private textures = new Map<THREE.Texture, THREE.Texture>();
  private disposed = false;

  constructor(doc: SceneDocument, private cameraId: string, nodes: THREE.Object3D[], background: THREE.Scene['background'], fog: THREE.Scene['fog'], assets: AssetDefinition[] = []) {
    this.document = structuredClone(doc);
    this.assets = structuredClone(assets);
    // Persist render inputs, not GPU output bytes, when checking whether an illustrated sheet is current.
    this.sourceState = JSON.stringify({ cameraId, objects: doc.objects, cameras: doc.cameras, paths: doc.paths ?? [], look: doc.look ?? DEFAULT_SCENE_LOOK,
      assets: this.assets.filter(asset => doc.objects.some(object => object.asset?.id === asset.id)) });
    const camera = doc.cameras.find(item => item.id === cameraId);
    if (!camera) throw new Error('Choose a camera before exporting.');
    this.camera = new THREE.PerspectiveCamera(camera.fov, 16 / 9, .05, 500);
    this.scene.background = background instanceof THREE.Color ? background.clone() : new THREE.Color('#eae8e1');
    this.scene.fog = fog?.clone() ?? null;
    for (const source of nodes) {
      const node = source.clone(true);
      node.traverse(child => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
          if (!this.geometries.has(child.geometry)) this.geometries.set(child.geometry, child.geometry.clone());
          child.geometry = this.geometries.get(child.geometry)!;
          const cloneMaterial = (original: THREE.Material) => {
            if (!this.materials.has(original)) {
              const copy = original.clone();
              for (const [key, value] of Object.entries(copy)) if (value instanceof THREE.Texture) {
                if (!this.textures.has(value)) this.textures.set(value, value.clone());
                (copy as unknown as Record<string, unknown>)[key] = this.textures.get(value)!;
              }
              this.materials.set(original, copy);
            }
            return this.materials.get(original)!;
          };
          child.material = Array.isArray(child.material) ? child.material.map(cloneMaterial) : cloneMaterial(child.material);
        }
        if (child instanceof THREE.DirectionalLight) child.target.updateMatrixWorld(true);
      });
      this.scene.add(node);
      if (node.userData.entityId) this.roots.set(node.userData.entityId, node);
    }
    this.renderer = new THREE.WebGLRenderer({antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance'});
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = (doc.look ?? DEFAULT_SCENE_LOOK).exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setPixelRatio(1);
    this.canvas = this.renderer.domElement;
    this.resize(720, 405);
  }

  resize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.renderer.setSize(width, height, false); this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
  }
  render(time: number, cameraId = this.cameraId): HTMLCanvasElement {
    if (this.disposed || this.renderer.getContext().isContextLost()) throw new Error('The graphics context was lost. Close the export window and try again.');
    const pose = (root: THREE.Object3D, transform: Transform, scale = true) => {
      root.position.fromArray(transform.position);
      root.rotation.set(...transform.rotation.map(THREE.MathUtils.degToRad) as [number, number, number], 'XYZ');
      if (scale) root.scale.fromArray(transform.scale);
    };
    const world=sceneWorldMatrices(this.document,time);
    for (const item of this.document.objects) {
      const root = this.roots.get(item.id); if (!root) continue;
      root.visible = !effectivelyHidden(this.document,item.id);
      if (root.visible) { const matrix=world.get(item.id)!;matrix.decompose(root.position,root.quaternion,root.scale);root.matrix.copy(matrix);root.matrixAutoUpdate=false;root.updateMatrixWorld(true);
        if (item.asset) {
          const asset = this.assets.find(asset => asset.id === item.asset!.id);
          if (!asset) throw new Error("Missing export asset: " + item.asset.id);
          poseAssetJoints(root.children[0] as THREE.Group, asset, evaluateJointAngles(item, time));
        }
      }
    }
    const camera = this.document.cameras.find(item => item.id === cameraId)!;
    pose(this.camera, matrixTransform(world.get(camera.id)!), false);
    const fov = evaluateFov(camera, time);
    const bounds=new THREE.Box3();for(const root of this.roots.values())if(root.visible)bounds.expandByObject(root);
    const far=cameraFarForBounds(this.camera.position,bounds);
    if (this.camera.fov !== fov||this.camera.far!==far) { this.camera.fov = fov;this.camera.far=far; this.camera.updateProjectionMatrix(); }
    renderCameraFrame(this.renderer,this.scene,this.camera,camera.frameBounds);
    return this.canvas;
  }
  /** Depth range of the visible geometry over the given times, as camera distances in metres (1st to 99th percentile of pixels).
   * One range per export keeps the depth video from flickering as objects enter or leave the frame. */
  depthRange(samples: { time: number; cameraId: string }[]): DepthRange {
    const target = new THREE.WebGLRenderTarget(160, 90), pixels = new Uint8Array(160 * 90 * 4), values: number[] = [];
    const material = depthMaterial('log', DEPTH_LOG_RANGE);
    try {
      for (const { time, cameraId } of samples) {
        this.render(time, cameraId);
        this.withOverride(material, () => { this.renderer.setRenderTarget(target); this.renderer.setClearColor(0x000000, 0); this.renderer.clear(); this.renderer.render(this.scene, this.camera); });
        this.renderer.setRenderTarget(null);
        this.renderer.readRenderTargetPixels(target, 0, 0, 160, 90, pixels);
        for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 3] > 0) values.push(DEPTH_LOG_RANGE.near * Math.exp(pixels[index] / 255 * Math.log(DEPTH_LOG_RANGE.far / DEPTH_LOG_RANGE.near)));
      }
    } finally { target.dispose(); material.dispose(); this.renderer.setClearColor(0x000000, 1); }
    if (!values.length) return { near: 1, far: 100 };
    values.sort((a, b) => a - b);
    const near = Math.max(.05, values[Math.floor(values.length * .01)]), far = Math.max(near * 1.5, values[Math.min(values.length - 1, Math.floor(values.length * .99))]);
    return { near, far };
  }
  /** Inverse-depth frame for depth-controlled video models: near is white, far and sky are black. Pose comes from the normal render. */
  renderDepth(time: number, range: DepthRange, cameraId = this.cameraId): HTMLCanvasElement {
    this.render(time, cameraId);
    const material = depthMaterial('disparity', range), camera = this.document.cameras.find(item => item.id === cameraId)!;
    try { this.withOverride(material, () => { this.renderer.setClearColor(0x000000, 1); renderCameraFrame(this.renderer, this.scene, this.camera, camera.frameBounds); }); }
    finally { material.dispose(); }
    return this.canvas;
  }
  /** Draw every mesh with one material, without background, fog or lines; restores the scene afterwards. */
  private withOverride(material: THREE.Material, draw: () => void): void {
    const saved = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>(), hidden: THREE.Object3D[] = [], background = this.scene.background, fog = this.scene.fog;
    try {
      this.scene.background = null; this.scene.fog = null;
      this.scene.traverse(node => {
        if (node instanceof THREE.Mesh) { saved.set(node, node.material); node.material = material; }
        else if ((node instanceof THREE.Line || node instanceof THREE.Points || node instanceof THREE.Sprite) && node.visible) { node.visible = false; hidden.push(node); }
      });
      draw();
    } finally { for (const [node, original] of saved) node.material = original; for (const node of hidden) node.visible = true; this.scene.background = background; this.scene.fog = fog; }
  }
  /** Render visible target pixels with normal depth occlusion, for composition checks. */
  renderObjectMask(id: string, time: number): HTMLCanvasElement {
    const target=this.roots.get(id);if(!target)throw new Error('Choose an existing scene object for the mask.');
    this.render(time);
    const white=new THREE.MeshBasicMaterial({color:0xffffff}),black=new THREE.MeshBasicMaterial({color:0x000000});
    const members=new Set<THREE.Object3D>();target.traverse(node=>members.add(node));
    const saved=new Map<THREE.Mesh,THREE.Material|THREE.Material[]>(),background=this.scene.background,fog=this.scene.fog;
    try{
      this.scene.background=new THREE.Color(0x000000);this.scene.fog=null;
      this.scene.traverse(node=>{if(node instanceof THREE.Mesh){saved.set(node,node.material);node.material=members.has(node)?white:black;}});
      this.renderer.render(this.scene,this.camera);return this.canvas;
    }finally{for(const [node,material]of saved)node.material=material;this.scene.background=background;this.scene.fog=fog;white.dispose();black.dispose();}
  }
  /** Normalised [left, top, right, bottom] screen boxes of visible objects fully in front of the camera, for the pose of the last render. */
  screenBoxes(): Map<string, [number, number, number, number]> {
    const boxes = new Map<string, [number, number, number, number]>(), bounds = new THREE.Box3(), corner = new THREE.Vector3();
    this.camera.updateMatrixWorld();
    for (const [id, root] of this.roots) {
      if (!root.visible) continue;
      root.updateMatrixWorld(true); bounds.setFromObject(root);
      if (bounds.isEmpty()) continue;
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, behind = false;
      for (let index = 0; index < 8; index++) {
        corner.set(index & 1 ? bounds.max.x : bounds.min.x, index & 2 ? bounds.max.y : bounds.min.y, index & 4 ? bounds.max.z : bounds.min.z).project(this.camera);
        if (corner.z <= -1 || corner.z >= 1) { behind = true; break; }
        const x = (corner.x + 1) / 2, y = (1 - corner.y) / 2;
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      if (behind || right <= 0 || left >= 1 || bottom <= 0 || top >= 1) continue;
      const clamp = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
      boxes.set(id, [clamp(left), clamp(top), clamp(right), clamp(bottom)]);
    }
    return boxes;
  }
  /** Subject-relative viewing side and camera elevation at the last rendered pose. */
  subjectView(id: string) {
    const root = this.roots.get(id);
    return root?.visible ? objectCameraView(root, this.camera.getWorldPosition(new THREE.Vector3())) : undefined;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometries.forEach(value => value.dispose()); this.materials.forEach(value => value.dispose()); this.textures.forEach(value => value.dispose());
    this.scene.traverse(node => { if (node instanceof THREE.DirectionalLight) node.shadow.dispose(); });
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.canvas.remove(); this.scene.clear();
  }
}
