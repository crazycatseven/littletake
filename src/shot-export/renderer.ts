import * as THREE from 'three';
import { evaluateFov, evaluateTransform } from '../model';
import type { SceneDocument, Transform } from '../types';

/** An export owns its geometry, materials, camera and poses; the live editor keeps running independently. */
export class ShotRenderer {
  readonly document: SceneDocument;
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private roots = new Map<string, THREE.Object3D>();
  private geometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  private materials = new Map<THREE.Material, THREE.Material>();
  private textures = new Map<THREE.Texture, THREE.Texture>();
  private disposed = false;

  constructor(doc: SceneDocument, private cameraId: string, nodes: THREE.Object3D[], background: THREE.Scene['background'], fog: THREE.Scene['fog']) {
    this.document = structuredClone(doc);
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
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setPixelRatio(1);
    this.canvas = this.renderer.domElement;
    this.resize(720, 405);
  }

  resize(width: number, height: number): void { this.renderer.setSize(width, height, false); this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); }
  render(time: number): HTMLCanvasElement {
    if (this.disposed || this.renderer.getContext().isContextLost()) throw new Error('The graphics context was lost. Close the export window and try again.');
    const pose = (root: THREE.Object3D, transform: Transform, scale = true) => {
      root.position.fromArray(transform.position);
      root.rotation.set(...transform.rotation.map(THREE.MathUtils.degToRad) as [number, number, number], 'XYZ');
      if (scale) root.scale.fromArray(transform.scale);
    };
    for (const item of this.document.objects) {
      const root = this.roots.get(item.id); if (!root) continue;
      root.visible = !item.hidden;
      if (root.visible) pose(root, evaluateTransform(item, time));
    }
    const camera = this.document.cameras.find(item => item.id === this.cameraId)!;
    pose(this.camera, evaluateTransform(camera, time), false);
    const fov = evaluateFov(camera, time);
    if (this.camera.fov !== fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    this.renderer.render(this.scene, this.camera);
    return this.canvas;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometries.forEach(value => value.dispose()); this.materials.forEach(value => value.dispose()); this.textures.forEach(value => value.dispose());
    this.scene.traverse(node => { if (node instanceof THREE.DirectionalLight) node.shadow.dispose(); });
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.canvas.remove(); this.scene.clear();
  }
}
