import { Mesh, type Object3D } from 'three';

const originalCulling = new WeakMap<Object3D, boolean>();

/** Scaled XR rigs can produce an incorrect combined-eye CPU frustum.
 * Let each eye's GPU clipping decide visibility, preserving desktop settings.
 * Weak keys do not retain models removed or rebuilt during the session. */
export function setXRObjectCulling(root: Object3D, active: boolean): void {
  root.traverse(node => {
    if (!(node instanceof Mesh)) return;
    if (active) {
      if (!originalCulling.has(node)) originalCulling.set(node, node.frustumCulled);
      node.frustumCulled = false;
    } else if (originalCulling.has(node)) {
      node.frustumCulled = originalCulling.get(node)!;
      originalCulling.delete(node);
    }
  });
}
