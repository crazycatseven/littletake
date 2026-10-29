import { Box3, BoxGeometry, BufferGeometry, CapsuleGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide,
  Euler, Group, MathUtils, Matrix3, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Raycaster, SphereGeometry, PlaneGeometry, Vector3 } from 'three';
import { createAssetGroup, disposeAssetGroup, type AssetDefinition } from '../assets/model.ts';
import { evaluateTransform, sceneEntity } from '../model.ts';
import type { ProjectContent, SceneObject, Transform, Vec3 } from '../types.ts';
import type { SpatialFrame } from './schema.ts';

/** The viewport and spatial tools build precisely the same meshes. */
export function primitiveGeometry(kind: string): BufferGeometry {
  switch (kind) {
    case 'sphere': return new SphereGeometry(.5, 24, 16);
    case 'cylinder': return new CylinderGeometry(.5, .5, 1, 32);
    case 'cone': return new ConeGeometry(.5, 1, 32);
    case 'capsule': return new CapsuleGeometry(.5, 1, 6, 12);
    case 'plane': return new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    default: return new BoxGeometry(1, 1, 1);
  }
}
export function createObjectGroup(object: SceneObject, assets: AssetDefinition[], material: MeshStandardMaterial,
  accent: MeshStandardMaterial, geometry = primitiveGeometry): Group {
  const root = new Group(); root.userData.entityId = object.id;
  if (object.kind === 'asset') {
    const asset = assets.find(a => a.id === object.asset?.id && a.version === object.asset.version);
    if (!asset) throw new Error(`Missing asset for ${object.id}.`);
    const group = createAssetGroup(asset); root.add(group);
    root.userData.anchors = group.userData.evaluated.anchors;
    group.traverse(node => { if (node instanceof Mesh) (node.material as MeshStandardMaterial).color.multiply(new Color(object.color)); });
  } else {
    if (object.kind === 'plane') material.side = DoubleSide;
    const add = (kind: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, dark = false) => {
      const mesh = new Mesh(geometry(kind), dark ? accent : material);
      mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.castShadow = mesh.receiveShadow = true; root.add(mesh); return mesh;
    };
    if (object.kind === 'human') {
      add('capsule', 0, 1.12, 0, .41, .29, .27); add('sphere', 0, .82, 0, .39, .28, .29, true);
      add('cylinder', 0, 1.45, 0, .11, .12, .11); add('sphere', 0, 1.63, 0, .32, .37, .32);
      for (const side of [-1, 1]) {
        add('capsule', side * .12, .43, 0, .14, .34, .15, true); add('cube', side * .12, .055, -.045, .155, .11, .28, true);
        add('capsule', side * .315, 1.09, 0, .12, .28, .12).rotation.z = side * .1;
        add('sphere', side * .344, .79, 0, .13, .15, .13);
      }
    } else add(object.kind, 0, 0, 0, 1, 1, 1);
  }
  root.updateMatrixWorld(true); return root;
}
export function matrixOf(pose: Transform): Matrix4 {
  return new Matrix4().compose(new Vector3(...pose.position),
    new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3, 'XYZ')), new Vector3(...pose.scale));
}
export function poseOf(matrix: Matrix4): Transform {
  const position = new Vector3(), scale = new Vector3(), quaternion = new Quaternion(); matrix.decompose(position, quaternion, scale);
  const euler = new Euler().setFromQuaternion(quaternion, 'XYZ');
  return { position: position.toArray(), rotation: [euler.x, euler.y, euler.z].map(v => v === 0 ? 0 : MathUtils.radToDeg(v)) as Vec3, scale: scale.toArray() };
}
export function geometryVertices(root: Group): Vector3[] {
  root.updateWorldMatrix(true, true); const vertices: Vector3[] = [];
  root.traverse(node => {
    if (node instanceof Mesh) {
      const positions = node.geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) vertices.push(new Vector3().fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld));
    }
  });
  return vertices;
}
export const boxData = (box: Box3) => ({ min: box.min.toArray(), max: box.max.toArray(), size: box.getSize(new Vector3()).toArray() });
/** Actual bottom vertices and bottom-face centroids, bounded for interactive queries. */
export function bottomPoints(root: Group, bounds: Box3): Vector3[] {
  const points = new Map<string, Vector3>();
  const add = (point: Vector3) => { if (point.y <= bounds.min.y + 1e-5) points.set(`${point.x.toFixed(5)},${point.z.toFixed(5)}`, point); };
  root.traverse(node => {
    if (!(node instanceof Mesh)) return;
    const vertices = node.geometry.getAttribute('position'), index = node.geometry.getIndex();
    for (let i = 0; i < (index?.count ?? vertices.count); i += 3) {
      const triangle = [0, 1, 2].map(k => new Vector3().fromBufferAttribute(vertices, index ? index.getX(i + k) : i + k).applyMatrix4(node.matrixWorld));
      triangle.forEach(add);
      if (triangle.every(p => p.y <= bounds.min.y + 1e-5)) add(triangle[0].clone().add(triangle[1]).add(triangle[2]).multiplyScalar(1 / 3));
    }
  });
  const all = [...points.values()]; return all.filter((_, i) => i % Math.max(1, Math.ceil(all.length / 128)) === 0);
}
export function upwardSurface(root: Group, x: number, z: number, fromY: number): number | null {
  const ray = new Raycaster(new Vector3(x, fromY, z), new Vector3(0, -1, 0));
  const hit = ray.intersectObject(root, true).find(hit => hit.face && hit.face.normal.clone().applyMatrix3(new Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize().y > .5);
  return hit?.point.y ?? null;
}

/** Disposable CPU geometry; no renderer, GPU context, network or model invocation. */
export class SpatialScene {
  readonly scene;
  private roots = new Map<string, Group>();
  private vertices = new Map<string, Vector3[]>();
  constructor(readonly project: ProjectContent, readonly sceneId: string, readonly time: number) {
    const scene = project.scenes.find(item => item.id === sceneId);
    if (!scene) throw new Error('Unknown scene: ' + sceneId);
    if (!Number.isFinite(time) || time < 0 || time > scene.duration) throw new Error('Spatial time must be within the scene.');
    this.scene = scene;
  }
  object(id: string): SceneObject {
    const object = this.scene.objects.find(item => item.id === id);
    if (!object) throw new Error(`Unknown object ${id} in scene ${this.sceneId}.`);
    return object;
  }
  root(id: string): Group {
    if (!this.roots.has(id)) {
      const object = this.object(id), material = new MeshStandardMaterial({ color: object.color }), accent = material.clone();
      accent.color.multiplyScalar(.72);
      const root = createObjectGroup(object, this.project.assets ?? [], material, accent);
      // Asset meshes own their own materials.
      if (object.kind === 'asset') { material.dispose(); accent.dispose(); }
      this.roots.set(id, root); this.pose(id, evaluateTransform(object, this.time));
    }
    return this.roots.get(id)!;
  }
  pose(id: string, pose: Transform) { const root = this.root(id); root.position.fromArray(pose.position); root.rotation.set(...pose.rotation.map(MathUtils.degToRad) as Vec3, 'XYZ'); root.scale.fromArray(pose.scale); root.updateMatrixWorld(true); this.vertices.delete(id); }
  frame(frame: SpatialFrame): Matrix4 {
    if (frame.kind === 'world') return new Matrix4();
    const entity = sceneEntity(this.scene, frame.id);
    if (!entity || (frame.kind === 'object') !== ('kind' in entity)) throw new Error('Frame entity has the wrong kind or is missing: ' + frame.id);
    return matrixOf({ ...evaluateTransform(entity, this.time), scale: [1, 1, 1] });
  }
  bounds(id: string, frame = new Matrix4()): Box3 {
    if (!this.vertices.has(id)) this.vertices.set(id, geometryVertices(this.root(id)));
    const inverse = frame.clone().invert(); return new Box3().setFromPoints(this.vertices.get(id)!.map(v => v.clone().applyMatrix4(inverse)));
  }
  support(id: string) {
    const bounds = this.bounds(id), points = bottomPoints(this.root(id), bounds), findings = new Map<string | null, number[]>();
    const candidates = this.scene.objects.filter(object => object.id !== id).map(object => ({ id: object.id, bounds: this.bounds(object.id) }));
    for (const point of points) {
      let height: number | null = point.y >= -1e-5 ? 0 : null, supportId: string | null = null;
      for (const other of candidates) {
        if (point.x < other.bounds.min.x || point.x > other.bounds.max.x || point.z < other.bounds.min.z || point.z > other.bounds.max.z) continue;
        const y = upwardSurface(this.root(other.id), point.x, point.z, point.y + 1e-5);
        if (y !== null && (height === null || y >= height)) { height = y; supportId = other.id; }
      }
      if (height !== null) findings.set(supportId, [...(findings.get(supportId) ?? []), point.y - height]);
    }
    return { method: 'downward mesh rays from sampled bottom', sampled: points.length,
      surfacesBelow: [...findings].map(([id, gaps]) => ({ id, name: id === null ? 'World ground y=0' : this.object(id).name, minGap: Math.min(...gaps), maxGap: Math.max(...gaps), samples: gaps.length })) };
  }
  anchor(id: string, name: string): Vector3 {
    const root = this.root(id), bounds = this.bounds(id), center = bounds.getCenter(new Vector3());
    if (name === '@origin') return root.getWorldPosition(new Vector3());
    if (name === '@center') return center;
    if (name === '@bottom' || name === '@top') return center.setY(name === '@bottom' ? bounds.min.y : bounds.max.y);
    const position = root.userData.anchors?.[name] as Vec3 | undefined;
    if (!position) throw new Error(`Unknown anchor ${name} on ${id}. Inspect its available anchors first.`);
    return new Vector3(...position).applyMatrix4(root.matrixWorld);
  }
  anchors(id: string) { return Object.fromEntries(['@origin', '@center', '@bottom', '@top', ...Object.keys(this.root(id).userData.anchors ?? {})].map(name => [name, this.anchor(id, name).toArray()])); }
  dispose() { for (const root of this.roots.values()) disposeAssetGroup(root); this.roots.clear(); this.vertices.clear(); }
}
