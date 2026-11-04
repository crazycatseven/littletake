import * as THREE from 'three';
import { XR_ACTIVE_RAY_RADIUS } from './feedback';
import type { XRKeyframeSelection, XRTimelineState } from './timeline';

/** Lightweight world-space keyframe markers; never copies the selected model. */
export class XRKeyframeGhosts {
  readonly root = new THREE.Group();
  private selection?: XRKeyframeSelection;
  private nodes?: THREE.InstancedMesh;
  private path?: THREE.InstancedMesh;
  private key = '';
  private colorKey = '';
  private pathWidth = 1;
  private readonly radius = .035;

  sync(state: XRTimelineState | null, source?: THREE.Object3D, rigScale = 1): void {
    const selection = state?.selection;
    if (!selection?.frames.length || !source?.visible) { this.clear(); return; }
    const key = JSON.stringify([selection.id, selection.frames.map(frame => [frame.time, frame.transform.position])]);
    if (key !== this.key) {
      this.clear(); this.key = key;
      const positions = selection.frames.map(frame => new THREE.Vector3(...frame.transform.position));
      this.nodes = new THREE.InstancedMesh(new THREE.SphereGeometry(this.radius, 8, 6),
        new THREE.MeshBasicMaterial({color: '#ffffff', toneMapped: false}), positions.length);
      this.nodes.name = 'XR keyframe nodes'; this.nodes.userData.xrKeyframeGhost = true;
      this.nodes.frustumCulled = false;
      positions.forEach((position, index) => this.nodes!.setMatrixAt(index, new THREE.Matrix4().makeTranslation(position)));
      this.nodes.instanceMatrix.needsUpdate = true;
      this.nodes.computeBoundingSphere(); this.nodes.computeBoundingBox();
      this.root.add(this.nodes);
      if (positions.length > 1) {
        // Thin cylinders give both XR eyes a reliable width without native line-width limits.
        this.path = new THREE.InstancedMesh(new THREE.CylinderGeometry(.008, .008, 1, 8),
          new THREE.MeshBasicMaterial({color: '#65dce6', toneMapped: false}), positions.length - 1);
        const up = new THREE.Vector3(0, 1, 0);
        for (let i = 1; i < positions.length; i++) {
          const delta = positions[i].clone().sub(positions[i - 1]), length = delta.length();
          const rotation = length > 1e-8 ? new THREE.Quaternion().setFromUnitVectors(up, delta.divideScalar(length)) : new THREE.Quaternion();
          this.path.setMatrixAt(i - 1, new THREE.Matrix4().compose(
            positions[i].clone().add(positions[i - 1]).multiplyScalar(.5), rotation,
            length > 1e-8 ? new THREE.Vector3(1, length, 1) : new THREE.Vector3(0, 0, 0)));
        }
        this.path.instanceMatrix.needsUpdate = true;
        this.path.computeBoundingSphere(); this.path.computeBoundingBox();
        this.path.name = 'XR motion path'; this.path.frustumCulled = false;
        this.path.raycast = () => {}; // Only nodes own keyframe selection.
        this.root.add(this.path);
      }
    }
    // Match controller-ray thickness after navigation scaling without moving the path.
    const width = Math.max(1, XR_ACTIVE_RAY_RADIUS * rigScale / .008);
    if (this.path && width !== this.pathWidth) {
      const matrix = new THREE.Matrix4();
      const scale = new THREE.Vector3(width / this.pathWidth, 1, width / this.pathWidth);
      for (let i = 0; i < this.path.count; i++) {
        this.path.getMatrixAt(i, matrix);
        this.path.setMatrixAt(i, matrix.scale(scale));
      }
      this.path.instanceMatrix.needsUpdate = true;
      this.path.computeBoundingSphere(); this.path.computeBoundingBox();
      this.pathWidth = width;
    }
    this.selection = selection;
    const active = selection.frames.findIndex(frame => Math.abs(frame.time - state!.time) < 1e-6);
    const colorKey = JSON.stringify([active, state?.selectedKeyTimes ?? []]);
    if (colorKey !== this.colorKey) {
      selection.frames.forEach((frame, index) => this.nodes!.setColorAt(index, new THREE.Color(
        state?.selectedKeyTimes?.some(time => Math.abs(time-frame.time)<1e-6) ? '#c9f86b' : index === active ? '#65dce6' : '#ffffff')));
      this.nodes!.instanceColor!.needsUpdate = true; this.colorKey = colorKey;
    }
    this.root.updateMatrixWorld(true);
  }

  timeAt(hit: THREE.Intersection): number | undefined {
    if (hit.object !== this.nodes || hit.instanceId === undefined) return;
    return this.selection?.frames[hit.instanceId]?.time;
  }
  boundsAt(time: number): THREE.Box3 | undefined {
    const frame = this.selection?.frames.find(frame => Math.abs(frame.time-time)<1e-6);
    if (!frame) return;
    return new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...frame.transform.position), new THREE.Vector3().setScalar(this.radius*2));
  }
  clear(): void {
    if (this.nodes) { this.nodes.dispose(); this.nodes.geometry.dispose(); (this.nodes.material as THREE.Material).dispose(); }
    if (this.path) { this.path.dispose(); this.path.geometry.dispose(); (this.path.material as THREE.Material).dispose(); }
    this.root.clear(); this.nodes = undefined; this.path = undefined; this.selection = undefined; this.key = ''; this.colorKey = '';
    this.pathWidth = 1;
  }
  dispose(): void { this.clear(); this.root.removeFromParent(); }
}
