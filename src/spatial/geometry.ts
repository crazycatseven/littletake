import {humanProxyParts} from '../assets/human.ts';
import { sceneWorldMatrices, worldTransform } from '../placement/hierarchy.ts';
import { Box3, BoxGeometry, BufferGeometry, CapsuleGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide,
  Euler, Group, MathUtils, Matrix3, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Raycaster, SphereGeometry, PlaneGeometry, Vector3,PerspectiveCamera } from 'three';
import { createAssetGroup, disposeAssetGroup, poseAssetJoints, type AssetDefinition } from '../assets/model.ts';
import { evaluateTransform, evaluateJointAngles, sceneEntity } from '../model.ts';
import type { ProjectContent, SceneObject, Transform, Vec3 } from '../types.ts';
import type { SpatialFrame } from './schema.ts';
import { eulerDegrees } from '../rotation.ts';

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
  accent: MeshStandardMaterial, geometry = primitiveGeometry, time = 0): Group {
  const root = new Group(); root.userData.entityId = object.id;
  if (object.kind === 'asset') {
    const asset = assets.find(a => a.id === object.asset?.id);
    if (!asset) throw new Error(`Missing asset for ${object.id}.`);
    const group = createAssetGroup(asset);poseAssetJoints(group,asset,evaluateJointAngles(object,time)); root.add(group);
    root.userData.anchors = group.userData.evaluated.anchors;
    group.traverse(node => { if (node instanceof Mesh) (node.material as MeshStandardMaterial).color.multiply(new Color(object.color)); });
  } else {
    if (object.kind === 'plane') material.side = DoubleSide;
    const add = (kind: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, dark = false) => {
      const mesh = new Mesh(geometry(kind), dark ? accent : material);
      mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.castShadow = mesh.receiveShadow = true; root.add(mesh); return mesh;
    };
    if (object.kind === 'human') {
      const owned:MeshStandardMaterial[]=[];root.userData.ownedMaterials=owned;
      for(const part of humanProxyParts){const mesh=add(part.kind,...part.position,...part.size,part.accent);mesh.userData.partId=part.id;
        if(part.color){const skin=material.clone();skin.color.set(part.color);mesh.material=skin;owned.push(skin);}
        if(part.rotation)mesh.rotation.set(...part.rotation.map(MathUtils.degToRad) as Vec3);
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
  return { position: position.toArray(), rotation: eulerDegrees(quaternion), scale: scale.toArray() };
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
/** Shared by CPU inspection, the live shot and export: clip beyond the actual visible set. */
export function cameraFarForBounds(position:Vector3,bounds:Box3):number {
  return bounds.isEmpty()?500:Math.max(500,position.distanceTo(bounds.getCenter(new Vector3()))+bounds.getSize(new Vector3()).length());
}
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
/** Solve distance/target from world geometry; visibility still needs a depth-tested render. */
export function fitCameraToBounds(bounds:Box3,direction:Vector3,fov:number,aspect=16/9,margin=1.15){
  if(bounds.isEmpty()||direction.lengthSq()<1e-8)throw new Error('Camera fitting needs nonempty bounds and a nonzero world view direction.');
  const center=bounds.getCenter(new Vector3()),back=direction.clone().normalize(),camera=new PerspectiveCamera(fov,aspect);
  camera.position.copy(center).add(back);camera.lookAt(center);camera.updateMatrixWorld(true);
  const right=new Vector3(1,0,0).applyQuaternion(camera.quaternion),up=new Vector3(0,1,0).applyQuaternion(camera.quaternion),tanV=Math.tan(MathUtils.degToRad(fov/2)),tanH=tanV*aspect;let distance=.1;
  for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z]){
    const point=new Vector3(x,y,z).sub(center);distance=Math.max(distance,point.dot(back)+margin*Math.max(Math.abs(point.dot(right))/tanH,Math.abs(point.dot(up))/tanV)+.1);
  }
  return {position:center.clone().addScaledVector(back,distance).toArray() as Vec3,target:center.toArray() as Vec3,fov};
}

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
      const root = createObjectGroup(object, this.project.assets ?? [], material, accent, primitiveGeometry, this.time);
      // Asset meshes own their own materials.
      if (object.kind === 'asset') { material.dispose(); accent.dispose(); }
      this.roots.set(id, root);const matrix=sceneWorldMatrices(this.scene,this.time).get(id)!;matrix.decompose(root.position,root.quaternion,root.scale);root.matrix.copy(matrix);root.matrixAutoUpdate=false;root.updateMatrixWorld(true);
    }
    return this.roots.get(id)!;
  }
  pose(id: string, pose: Transform) { const root = this.root(id);root.matrixAutoUpdate=true; root.position.fromArray(pose.position); root.rotation.set(...pose.rotation.map(MathUtils.degToRad) as Vec3, 'XYZ'); root.scale.fromArray(pose.scale); root.updateMatrixWorld(true); this.vertices.delete(id); }
  frame(frame: SpatialFrame): Matrix4 {
    if (frame.kind === 'world') return new Matrix4();
    const entity = sceneEntity(this.scene, frame.id);
    if (!entity || (frame.kind === 'object') !== ('kind' in entity)) throw new Error('Frame entity has the wrong kind or is missing: ' + frame.id);
    return matrixOf({ ...worldTransform(this.scene,entity.id,this.time), scale: [1, 1, 1] });
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
