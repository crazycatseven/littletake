import * as THREE from 'three';
import { XRObjectOutline, XR_FEEDBACK } from './feedback';

export const XR_GRAB_RADIUS = .12;
const ENTER_NEAR = .25;
const LEAVE_NEAR = .30;

export interface NearSelection { active: boolean; target?: THREE.Object3D }

/** Distance to each visible mesh's oriented bounds, avoiding empty compound-object bounds. */
export function distanceToObject(target: THREE.Object3D, point: THREE.Vector3): number {
  for (let node: THREE.Object3D | null = target; node; node = node.parent) if (!node.visible) return Infinity;
  target.updateWorldMatrix(true, true);
  let distance = Infinity;
  const local = new THREE.Vector3(), inverse = new THREE.Matrix4();
  target.traverseVisible(node => {
    if (!(node instanceof THREE.Mesh)) return;
    const geometry = node.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox || node.matrixWorld.determinant() === 0) return;
    inverse.copy(node.matrixWorld).invert(); local.copy(point).applyMatrix4(inverse);
    geometry.boundingBox.clampPoint(local, local).applyMatrix4(node.matrixWorld);
    distance = Math.min(distance, local.distanceTo(point));
  });
  return distance;
}

/** Per-hand feedback. Materials and helpers are independent of document objects. */
export class XRNearSelection {
  readonly root = new THREE.Group();
  private hands: { grip: THREE.Group; sphere: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>; rings: THREE.Group; outline: XRObjectOutline; state: NearSelection }[] = [];

  addHand(grip: THREE.Group): void {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(XR_GRAB_RADIUS, 24, 16), new THREE.MeshBasicMaterial({
      color: XR_FEEDBACK.idle, transparent: true, opacity: .16, depthWrite: false, toneMapped: false,
    }));
    sphere.name = 'Grab range'; sphere.visible = false; sphere.frustumCulled = false; grip.add(sphere);
    const rings = new THREE.Group(); sphere.add(rings);
    for (let axis = 0; axis < 3; axis++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(XR_GRAB_RADIUS, .002, 6, 48), new THREE.MeshBasicMaterial({ color: XR_FEEDBACK.idle, transparent: true, opacity: .8, depthWrite: false, toneMapped: false }));
      if (axis === 1) ring.rotation.x = Math.PI / 2;
      if (axis === 2) ring.rotation.y = Math.PI / 2;
      ring.frustumCulled = false; rings.add(ring);
    }
    const outline = new XRObjectOutline(); outline.root.name = 'Near grab target';
    this.root.add(outline.root); this.hands.push({ grip, sphere, rings, outline, state: { active: false } });
  }

  update(index: number, targets: THREE.Object3D[], enabled: boolean, scale: number, held?: THREE.Object3D): NearSelection {
    const hand = this.hands[index];
    if (!enabled) { this.clear(index); return hand.state; }
    const center = hand.grip.getWorldPosition(new THREE.Vector3());
    let closest: THREE.Object3D | undefined, distance = Infinity;
    for (const target of targets) {
      const next = distanceToObject(target, center);
      if (next < distance) { closest = target; distance = next; }
    }
    // Keep the current candidate when two overlapping objects are equally close.
    const previous = hand.state.target;
    if (previous && targets.includes(previous)) {
      const previousDistance = distanceToObject(previous, center);
      if (previousDistance <= XR_GRAB_RADIUS * scale && previousDistance <= distance + .005 * scale) closest = previous;
    }
    const active = !!held || distance <= (hand.state.active ? LEAVE_NEAR : ENTER_NEAR) * scale;
    const target = held ?? (distance <= XR_GRAB_RADIUS * scale ? closest : undefined);
    hand.state = { active, target };
    hand.sphere.visible = active;
    const color = held ? XR_FEEDBACK.held : target ? XR_FEEDBACK.ready : XR_FEEDBACK.idle;
    hand.sphere.material.color.set(color); hand.sphere.material.opacity = held ? .30 : target ? .24 : .16;
    hand.rings.children.forEach(node => ((node as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(color));
    hand.outline.update(target, scale, color);
    return hand.state;
  }

  clear(index?: number): void {
    for (const hand of index === undefined ? this.hands : [this.hands[index]]) {
      hand.state = { active: false }; hand.sphere.visible = false; hand.outline.root.visible = false;
    }
  }
  dispose(): void {
    for (const { sphere, rings, outline } of this.hands) {
      rings.children.forEach(node => { const mesh = node as THREE.Mesh; mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); });
      sphere.removeFromParent(); sphere.geometry.dispose(); sphere.material.dispose();
      outline.dispose();
    }
    this.root.clear(); this.root.removeFromParent();
  }
}
