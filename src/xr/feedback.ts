import * as THREE from 'three';

export const XR_FEEDBACK = { idle: '#def3ef', ready: '#c9f86b', held: '#ffbd66', selected: '#62dded', disabled: '#789084', dark: '#10231e' };

/** Thick corner brackets use real geometry: WebGL line widths are usually one pixel. */
export class XRObjectOutline {
  readonly root = new THREE.Group();
  private geometry = new THREE.BoxGeometry();
  private material = new THREE.MeshBasicMaterial({ color: XR_FEEDBACK.ready, depthTest: false, depthWrite: false, toneMapped: false });
  private edges = new THREE.InstancedMesh(this.geometry, this.material, 24);
  private box = new THREE.Box3();
  constructor() {
    this.edges.frustumCulled = false; this.edges.renderOrder = 80;
    this.root.add(this.edges); this.root.visible = false;
  }
  update(target: THREE.Object3D | undefined, scale: number, color: string): void {
    this.root.visible = false;
    if (!target) return;
    for (let node: THREE.Object3D | null = target; node; node = node.parent) if (!node.visible) return;
    target.updateWorldMatrix(true, true);
    this.box.setFromObject(target, true);
    this.updateBounds(this.box, scale, color);
  }
  updateBounds(bounds: THREE.Box3, scale: number, color: string): void {
    this.root.visible = false; this.box.copy(bounds);
    if (this.box.isEmpty()) return;
    this.box.expandByScalar(.006 * scale);
    const size = this.box.getSize(new THREE.Vector3()), matrix = new THREE.Matrix4();
    const position = new THREE.Vector3(), dimensions = new THREE.Vector3();
    let index = 0;
    for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) {
      const corner = [x, y, z];
      for (let axis = 0; axis < 3; axis++) {
        const length = Math.min(size.getComponent(axis) * .24, .16 * scale);
        position.set(x ? this.box.max.x : this.box.min.x, y ? this.box.max.y : this.box.min.y, z ? this.box.max.z : this.box.min.z);
        position.setComponent(axis, position.getComponent(axis) + (corner[axis] ? -1 : 1) * length / 2);
        dimensions.setScalar(.004 * scale); dimensions.setComponent(axis, length);
        matrix.makeScale(dimensions.x, dimensions.y, dimensions.z).setPosition(position);
        this.edges.setMatrixAt(index++, matrix);
      }
    }
    this.material.color.set(color); this.edges.instanceMatrix.needsUpdate = true;
    this.root.visible = true; this.root.updateMatrixWorld(true);
  }
  dispose(): void { this.root.removeFromParent(); this.edges.dispose(); this.geometry.dispose(); this.material.dispose(); }
}

/** Visible beam and hit marker, attached to tracking space so thickness survives grab scaling. */
export class XRPointerFeedback {
  readonly root = new THREE.Group();
  private beamMaterial = new THREE.MeshBasicMaterial({ color: XR_FEEDBACK.idle, depthTest: false, depthWrite: false, toneMapped: false });
  private darkMaterial = new THREE.MeshBasicMaterial({ color: XR_FEEDBACK.dark, depthTest: false, depthWrite: false, toneMapped: false });
  private beamGeometry = new THREE.CylinderGeometry(1, 1, 1, 8).rotateX(Math.PI / 2).translate(0, 0, -.5);
  private beam = new THREE.Mesh(this.beamGeometry, this.beamMaterial);
  private cursor = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), this.beamMaterial);
  private rim = new THREE.Mesh(new THREE.TorusGeometry(1, .16, 6, 32), this.darkMaterial);
  constructor(controller: THREE.Group) {
    this.root.name = 'XR pointer'; this.root.visible = false;
    this.beam.renderOrder = 110; this.cursor.renderOrder = 112; this.rim.renderOrder = 111;
    for (const mesh of [this.beam, this.cursor, this.rim]) mesh.frustumCulled = false;
    this.root.add(this.beam, this.cursor, this.rim); controller.add(this.root);
  }
  update(visible: boolean, distance: number, hit: boolean, color: string, active = false): void {
    this.root.visible = visible;
    this.beamMaterial.color.set(color);
    this.beam.scale.set(active ? .0024 : .0015, active ? .0024 : .0015, Math.max(.001, distance));
    // A minimum physical diameter plus a small angular component keeps distant hits legible.
    const radius = Math.max(.008, distance * .006);
    this.cursor.position.set(0, 0, -distance); this.cursor.scale.setScalar(radius);
    this.rim.position.copy(this.cursor.position); this.rim.scale.setScalar(radius * 1.25);
    this.cursor.visible = hit; this.rim.visible = hit;
  }
  dispose(): void {
    this.root.removeFromParent(); this.beamGeometry.dispose(); this.cursor.geometry.dispose(); this.rim.geometry.dispose();
    this.beamMaterial.dispose(); this.darkMaterial.dispose();
  }
}

export class XRSelectionFeedback {
  readonly root = new THREE.Group();
  private outlines = new Map<THREE.Object3D, XRObjectOutline>();
  sync(targets: THREE.Object3D[], scale: number): void {
    for (const [target, outline] of this.outlines) if (!targets.includes(target)) { outline.dispose(); this.outlines.delete(target); }
    for (const target of targets) {
      let outline = this.outlines.get(target);
      if (!outline) { outline = new XRObjectOutline(); this.outlines.set(target, outline); this.root.add(outline.root); }
      outline.update(target, scale, XR_FEEDBACK.selected);
    }
  }
  dispose(): void { this.sync([], 1); this.root.removeFromParent(); }
}
