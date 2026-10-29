import * as THREE from 'three';

// Preserve the original menu's width-to-distance ratio (about 42 degrees).
const SIZE_DISTANCE = 1.25;
const OPEN_DISTANCE = .9;

/** World placement and angular sizing, independent of the tracked camera parent. */
export class XRMenuSpace {
  private drag: { localPoint: THREE.Vector3; offset: THREE.Vector3 } | null = null;
  constructor(private root: THREE.Group) {}

  place(head: THREE.Matrix4, rigScale: number): void {
    const forward = new THREE.Vector3(0, 0, -1).transformDirection(head);
    if (Math.hypot(forward.x, forward.z) > 1e-6) {
      this.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-forward.x, -forward.z));
    }
    this.root.position.set(0, -.18, -OPEN_DISTANCE).multiplyScalar(rigScale)
      .applyQuaternion(this.root.quaternion).add(new THREE.Vector3().setFromMatrixPosition(head));
    this.resize(head, rigScale);
  }

  resize(head: THREE.Matrix4, rigScale: number): void {
    const distance = this.root.position.distanceTo(new THREE.Vector3().setFromMatrixPosition(head));
    // Only guard the singularity at the eye; position and heading stay anchored.
    this.root.scale.setScalar(Math.max(distance, .01 * rigScale) / SIZE_DISTANCE);
    this.root.updateMatrixWorld(true);
  }

  begin(point: THREE.Vector3, grip: THREE.Vector3): void {
    this.drag = { localPoint: this.root.worldToLocal(point.clone()), offset: point.clone().sub(grip) };
  }

  move(grip: THREE.Vector3, head: THREE.Matrix4, rigScale: number): void {
    if (!this.drag) return;
    const target = grip.clone().add(this.drag.offset);
    const a = target.clone().sub(new THREE.Vector3().setFromMatrixPosition(head));
    const b = this.drag.localPoint.clone().applyQuaternion(this.root.quaternion);
    // Solve scale = distance(head, target - b * scale) / SIZE_DISTANCE.
    // This keeps the grabbed title point under the hand while resizing the panel.
    const denominator = SIZE_DISTANCE ** 2 - b.lengthSq(), dot = a.dot(b);
    const scale = Math.max((-dot + Math.sqrt(dot * dot + denominator * a.lengthSq())) / denominator, .01 * rigScale / SIZE_DISTANCE);
    this.root.position.copy(target).addScaledVector(b, -scale);
    this.root.scale.setScalar(scale);
    this.root.updateMatrixWorld(true);
  }

  end(): void { this.drag = null; }
}
