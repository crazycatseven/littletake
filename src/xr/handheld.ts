import * as THREE from 'three';
import { MenuTexture } from './texture';

export type HandheldAction = 'enter' | 'start' | 'stop' | 'cancel' | 'exit';
export interface HandheldState {
  available: boolean;
  id?: string;
  mode?: 'armed' | 'recording' | 'review';
  time?: number;
  start?: number;
  end?: number;
}

export function viewfinderSvg(state: HandheldState): string {
  const recording = state.mode === 'recording';
  const label = recording ? 'REC' : state.mode === 'review' ? 'REVIEW' : 'READY';
  const hint = recording ? 'Trigger or release Grip to stop' : state.mode === 'review' ? 'Timeline: Preview / Apply / Discard' : 'Hold Grip to frame · Trigger to record';
  const elapsed = Math.max(0, (state.time ?? 0) - (state.start ?? 0)).toFixed(1);
  const duration = Math.max(0, (state.end ?? 0) - (state.start ?? 0)).toFixed(1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="160"><rect width="960" height="160" rx="16" fill="#182b26"/><circle cx="32" cy="42" r="10" fill="${recording ? '#ff837a' : '#c9f86b'}"/><g font-family="Segoe UI, Arial, sans-serif" fill="#f6f3e9"><text x="56" y="54" font-size="34">${label}</text><text x="930" y="54" text-anchor="end" font-size="32">${elapsed} / ${duration} s</text><text x="480" y="120" text-anchor="middle" font-size="32">${hint}</text></g></svg>`;
}

/** A camera-mounted monitor. Only layer 0 is rendered into it, excluding XR helpers. */
export class XRViewfinder {
  readonly root = new THREE.Group();
  private target = new THREE.WebGLRenderTarget(640, 360);
  private camera = new THREE.PerspectiveCamera(45, 16 / 9, .05, 500);
  private label = new MenuTexture(960, 160);
  private lastRender = -Infinity;
  constructor() {
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(.32, .18), new THREE.MeshBasicMaterial({ map: this.target.texture, toneMapped: false }));
    const label = new THREE.Mesh(new THREE.PlaneGeometry(.32, .32 / 6), new THREE.MeshBasicMaterial({ map: this.label.texture, transparent: true, toneMapped: false }));
    screen.position.set(0, .23, .12); label.position.set(0, .11, .12);
    this.root.add(screen, label);
    this.root.traverse(node => { node.layers.set(3); node.frustumCulled = false; });
    this.root.visible = false;
  }
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, source: THREE.PerspectiveCamera, state: HandheldState, now: number, scale: number, helpers: THREE.Object3D[] = []): void {
    this.root.visible = !!state.id;
    if (!state.id) return;
    source.updateWorldMatrix(true, false);
    source.getWorldPosition(this.root.position); source.getWorldQuaternion(this.root.quaternion);
    this.root.scale.setScalar(scale);
    this.label.draw(viewfinderSvg(state));
    if (now - this.lastRender < 1000 / 20) return;
    this.lastRender = now;
    source.getWorldPosition(this.camera.position); source.getWorldQuaternion(this.camera.quaternion);
    this.camera.fov = source.fov; this.camera.near = source.near; this.camera.far = source.far; this.camera.updateProjectionMatrix();
    const target = renderer.getRenderTarget(), xr = renderer.xr.enabled;
    const viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
    const visibility = helpers.map(node => node.visible);
    try {
      helpers.forEach(node => node.visible = false);
      renderer.xr.enabled = false; renderer.setRenderTarget(this.target); renderer.setScissorTest(false);
      renderer.clear(); renderer.render(scene, this.camera);
    } finally {
      helpers.forEach((node, index) => node.visible = visibility[index]);
      renderer.setRenderTarget(target); renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest); renderer.xr.enabled = xr;
    }
  }
  dispose(): void {
    this.root.traverse(node => { if (node instanceof THREE.Mesh) { node.geometry.dispose(); (node.material as THREE.Material).dispose(); } });
    this.target.dispose(); this.label.dispose();
  }
}
