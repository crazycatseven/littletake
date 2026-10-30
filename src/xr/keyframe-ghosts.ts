import * as THREE from 'three';
import type { XRKeyframeSelection, XRTimelineState } from './timeline';

/** World-space, read-only poses. Instance geometry is shared; only owned materials are disposed. */
export class XRKeyframeGhosts {
  readonly root = new THREE.Group();
  private source?: THREE.Object3D;
  private selection?: XRKeyframeSelection;
  private parts: { mesh: THREE.InstancedMesh; matrices: THREE.Matrix4[] }[] = [];
  private active = -1;
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);

  sync(state: XRTimelineState | null, source?: THREE.Object3D): void {
    const selection = state?.selection;
    if (!selection?.frames.length || !source?.visible) { this.clear(); return; }
    if (source !== this.source || selection !== this.selection) {
      this.clear(); this.source = source; this.selection = selection;
      source.updateWorldMatrix(true, true);
      const inverse = source.matrixWorld.clone().invert();
      const poses = selection.frames.map(({ transform }) => new THREE.Matrix4().compose(
        new THREE.Vector3(...transform.position),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...transform.rotation.map(THREE.MathUtils.degToRad) as [number, number, number], 'XYZ')),
        new THREE.Vector3(...transform.scale),
      ));
      source.traverseVisible(node => {
        if (!(node instanceof THREE.Mesh)) return;
        const copyMaterial = (original: THREE.Material) => {
          const material = original.clone(); material.transparent = true; material.opacity = .34;
          material.depthWrite = false; return material;
        };
        const material = Array.isArray(node.material) ? node.material.map(copyMaterial) : copyMaterial(node.material);
        const mesh = new THREE.InstancedMesh(node.geometry, material, poses.length);
        mesh.frustumCulled = false; // XR-only previews share the scaled-rig frustum issue.
        const local = inverse.clone().multiply(node.matrixWorld);
        const matrices = poses.map(pose => pose.clone().multiply(local));
        matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
        mesh.userData.xrKeyframeGhost = true; mesh.castShadow = false; mesh.receiveShadow = false;
        mesh.computeBoundingSphere(); mesh.computeBoundingBox();
        this.root.add(mesh); this.parts.push({ mesh, matrices });
      });
    }
    // The actual editable object already represents the current key; hide its duplicate.
    const active = selection.frames.findIndex(frame => Math.abs(frame.time - state!.time) < 1e-6);
    if (active !== this.active) {
      for (const { mesh, matrices } of this.parts) {
        if (this.active >= 0) mesh.setMatrixAt(this.active, matrices[this.active]);
        if (active >= 0) mesh.setMatrixAt(active, this.zero);
        mesh.instanceMatrix.needsUpdate = true;
      }
      this.active = active;
    }
    this.root.updateMatrixWorld(true);
  }

  timeAt(hit: THREE.Intersection): number | undefined {
    if (!hit.object.userData.xrKeyframeGhost || hit.instanceId === undefined || hit.instanceId === this.active) return;
    return this.selection?.frames[hit.instanceId]?.time;
  }

  boundsAt(time: number): THREE.Box3 | undefined {
    const index = this.selection?.frames.findIndex(frame => frame.time === time) ?? -1;
    if (index < 0 || index === this.active) return;
    const bounds = new THREE.Box3();
    for (const { mesh, matrices } of this.parts) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(matrices[index]));
    }
    return bounds;
  }

  clear(): void {
    for (const { mesh } of this.parts) {
      mesh.dispose(); // Instance buffers, never the source geometry or textures.
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    }
    this.root.clear(); this.parts = []; this.selection = undefined; this.source = undefined; this.active = -1;
  }
  dispose(): void { this.clear(); this.root.removeFromParent(); }
}
