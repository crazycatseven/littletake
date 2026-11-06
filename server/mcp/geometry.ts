import { Mesh, Object3D, PerspectiveCamera, Quaternion, Raycaster, Vector3 } from 'three';
import { SpatialScene } from '../../src/spatial/geometry.ts';
import { sceneWorldMatrices, effectivelyHidden } from '../../src/placement/hierarchy.ts';
import { evaluateFov, evaluateJointAngles, shotAtTime } from '../../src/model.ts';
import type { ProjectContent, Vec3 } from '../../src/types.ts';

const round = (value: number, digits = 3) => { const scale = 10 ** digits, result = Math.round(value * scale) / scale; return result === 0 ? 0 : result; };
const vec = (value: Vector3): Vec3 => [round(value.x), round(value.y), round(value.z)];

function partOf(node: Object3D | null): string | undefined {
  for (let item = node; item; item = item.parent) if (item.userData.partId) return String(item.userData.partId);
  return undefined;
}

/** World pose of an asset's parts at one time: what an agent needs to place an effect at a mouth or a prop in a hand. */
export function inspectParts(project: ProjectContent, sceneId: string, id: string, time: number, parts?: { partId: string; offset?: Vec3 }[]) {
  const spatial = new SpatialScene(project, sceneId, time);
  try {
    const object = spatial.object(id), root = spatial.root(id), nodes = new Map<string, Object3D>();
    root.updateMatrixWorld(true);
    root.traverse(node => { if (node.userData.partId && !nodes.has(String(node.userData.partId))) nodes.set(String(node.userData.partId), node); });
    if (object.kind !== 'asset') throw new Error(`${id} is a ${object.kind}, not an asset; use inspect_spatial for its bounds.`);
    const asset = project.assets?.find(item => item.id === object.asset?.id), angles = evaluateJointAngles(object, time);
    const jointed: { partId: string; offset?: Vec3 }[] = (asset?.parts ?? []).filter(part => part.joint).map(part => ({ partId: part.id }));
    const requested = parts?.length ? parts : jointed;
    return {
      sceneId, id, time, units: 'metres, world space; forward is the part\'s local +Z, up its local +Y',
      parts: requested.map(({ partId, offset }) => {
        const node = nodes.get(partId);
        if (!node) return { partId, error: 'No such part. Parts with joints: ' + jointed.map(part => part.partId).slice(0, 40).join(', ') };
        const origin = node.localToWorld(new Vector3(...(offset ?? [0, 0, 0]))), rotation = node.getWorldQuaternion(new Quaternion());
        const definition = asset?.parts.find(part => part.id === partId);
        return { partId, name: definition?.name, position: vec(origin), forward: vec(new Vector3(0, 0, 1).applyQuaternion(rotation)), up: vec(new Vector3(0, 1, 0).applyQuaternion(rotation)),
          ...(definition?.joint ? { joint: { axis: definition.joint.axis, min: definition.joint.min, max: definition.joint.max, angle: angles[partId] ?? 0 } } : {}) };
      }),
    };
  } finally { spatial.dispose(); }
}

/**
 * How much of an object (or of its parts whose ID starts with partPrefix) a camera actually sees at one time:
 * sample its surface, keep points inside the 16:9 frame, then ray-cast against every visible object in the scene.
 */
export function checkVisibility(project: ProjectContent, sceneId: string, time: number, id: string, options: { cameraId?: string; partPrefix?: string } = {}) {
  const spatial = new SpatialScene(project, sceneId, time);
  try {
    const scene = spatial.scene, cameraId = options.cameraId ?? shotAtTime(scene, time)?.cameraId ?? scene.cameras[0]?.id;
    const source = scene.cameras.find(item => item.id === cameraId);
    if (!source) throw new Error(`Unknown camera ${cameraId ?? '(none)'} in scene ${sceneId}.`);
    spatial.object(id);
    const camera = new PerspectiveCamera(evaluateFov(source, time), 16 / 9, .05, 5000);
    sceneWorldMatrices(scene, time).get(source.id)!.decompose(camera.position, camera.quaternion, camera.scale);
    camera.scale.set(1, 1, 1); camera.updateMatrixWorld(true);
    const meshes: Mesh[] = [];
    for (const object of scene.objects) if (!effectivelyHidden(scene, object.id)) spatial.root(object.id).traverse(node => { if (node instanceof Mesh && node.visible) meshes.push(node); });
    const target = spatial.root(id), wanted = (node: Object3D) => !options.partPrefix || (partOf(node) ?? '').startsWith(options.partPrefix);
    const targetMeshes: Mesh[] = []; target.traverse(node => { if (node instanceof Mesh && wanted(node)) targetMeshes.push(node); });
    if (!targetMeshes.length) throw new Error(options.partPrefix ? `${id} has no parts starting with "${options.partPrefix}".` : `${id} has no geometry.`);
    const points: Vector3[] = [];
    for (const mesh of targetMeshes) {
      const position = mesh.geometry.getAttribute('position'), step = Math.max(1, Math.floor(position.count / 60));
      for (let index = 0; index < position.count; index += step) points.push(new Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld));
    }
    const owned = new Set<Object3D>(targetMeshes), ray = new Raycaster();
    let inFrame = 0, visible = 0; const min = [1, 1], max = [0, 0];
    for (const point of points) {
      const ndc = point.clone().project(camera);
      if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z < -1 || ndc.z > 1) continue;
      inFrame++;
      const distance = camera.position.distanceTo(point);
      ray.set(camera.position, point.clone().sub(camera.position).normalize()); ray.far = distance + .02;
      const hit = ray.intersectObjects(meshes, false)[0];
      if (!hit || owned.has(hit.object) || hit.distance >= distance - .01) {
        visible++;
        const u = (ndc.x + 1) / 2, v = (1 - ndc.y) / 2;
        min[0] = Math.min(min[0], u); min[1] = Math.min(min[1], v); max[0] = Math.max(max[0], u); max[1] = Math.max(max[1], v);
      }
    }
    return {
      sceneId, time, id, cameraId: source.id, ...(options.partPrefix ? { partPrefix: options.partPrefix } : {}), samples: points.length,
      inFrame: round(inFrame / points.length, 2), visible: round(visible / points.length, 2),
      visibleBox: visible ? [min[0], min[1], max[0], max[1]].map(value => round(value, 3)) : null,
      notes: 'visible is the share of surface samples the camera sees directly (inside the frame and not hidden behind any object). visibleBox is normalised [left, top, right, bottom].',
    };
  } finally { spatial.dispose(); }
}
