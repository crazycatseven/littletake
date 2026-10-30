import { Box3, Euler, MathUtils, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { evaluateTransform } from '../model.ts';
import { motionSchema, recordedTrack, trackPoses, transformSchema } from '../performance/motion.ts';
import { animationSchema } from '../animation/model.ts';
import { transformSelection } from '../placement/transforms.ts';
import type { ProjectContent, SceneObject, Transform, Vec3 } from '../types.ts';
import { bottomPoints, boxData, poseOf, SpatialScene, upwardSurface } from './geometry.ts';
import { spatialOperationSchema, spatialQuerySchema, type SpatialOperation, type SpatialQuery } from './schema.ts';

const axisIndex = { x: 0, y: 1, z: 2 } as const;
const forwardVector = (axis: '+z' | '-z' | '+x' | '-x') => new Vector3(axis.endsWith('x') ? (axis[0] === '+' ? 1 : -1) : 0, 0, axis.endsWith('z') ? (axis[0] === '+' ? 1 : -1) : 0);
function unique(ids: string[]) { if (new Set(ids).size !== ids.length) throw new Error('Object IDs must be unique.'); return ids; }
const pointAt = (box: Box3, edge: 'min' | 'center' | 'max') => edge === 'center' ? box.getCenter(new Vector3()) : box[edge];

export function inspectSpatial(project: ProjectContent, value: SpatialQuery) {
  const args = spatialQuerySchema.parse(value), snapshot = new SpatialScene(project, args.sceneId, args.time);
  try {
    const frame = snapshot.frame(args.frame), boxes = new Map<string, Box3>();
    const objects = unique(args.objectIds).map(id => {
      const object = snapshot.object(id), bounds = snapshot.bounds(id, frame); boxes.set(id, bounds);
      return { id, name: object.name, transform: evaluateTransform(object, args.time), bounds: boxData(snapshot.bounds(id)),
        boundsInFrame: boxData(bounds), anchors: snapshot.anchors(id), support: snapshot.support(id) };
    });
    const relations = objects.flatMap((a, i) => objects.slice(i + 1).map(b => {
      const first = boxes.get(a.id)!, second = boxes.get(b.id)!;
      const separation = new Vector3(...[0, 1, 2].map(axis => Math.max(0, first.min.getComponent(axis) - second.max.getComponent(axis), second.min.getComponent(axis) - first.max.getComponent(axis))) as Vec3);
      return { from: a.id, to: b.id, centerOffsetInFrame: second.getCenter(new Vector3()).sub(first.getCenter(new Vector3())).toArray(),
        positiveEdgeGaps: second.min.clone().sub(first.max).toArray(), negativeEdgeGaps: first.min.clone().sub(second.max).toArray(),
        boundsDistance: separation.length(), boundsIntersect: first.intersectsBox(second) };
    }));
    return { sceneId: args.sceneId, time: args.time, frame: args.frame, units: 'metres',
      conventions: 'X right, Y up, +Z front in world/object frames; camera +Z points toward the viewer. Frame axes are rigid. Anchors are world positions.',
      objects, relations, limitations: ['Bounds intersection is a broad-phase observation, not proof of mesh collision, physical stability or visual similarity.', 'Measurements describe this scene at the stated time; no original-image geometry is inferred.'] };
  } finally { snapshot.dispose(); }
}

export type SpatialUpdate = Pick<SceneObject, 'id' | 'transform' | 'track' | 'animation'>;
export interface SpatialResult { updates: SpatialUpdate[]; observations: Record<string, unknown> }
function checked(result: SpatialResult): SpatialResult {
  const zero = (value: number) => value === 0 ? 0 : value;
  for (const update of result.updates) {
    for (const pose of [update.transform, ...(update.track ? trackPoses(update.track) : [])]) {
      for (const group of ['position', 'rotation', 'scale'] as const) pose[group] = pose[group].map(zero) as Vec3;
    }
    for (const keys of Object.values(update.animation?.curves ?? {})) for (const key of keys ?? []) {
      key.value = zero(key.value);
      if (key.orientation) key.orientation = key.orientation.map(zero) as Vec3;
    }
    transformSchema.parse(update.transform); motionSchema.nullable().parse(update.track);
    if (update.animation) animationSchema.parse(update.animation);
  }
  return result;
}

/** Pure solver. The scene-edit executor alone commits these updates to its private project copy. */
export function solveSpatial(project: ProjectContent, value: SpatialOperation): SpatialResult {
  const op = spatialOperationSchema.parse(value), snapshot = new SpatialScene(project, op.sceneId, op.time);
  const poses = new Map<string, Transform>(), observations: Record<string, unknown> = {};
  const move = (id: string, offset: Vector3) => {
    const pose = structuredClone(poses.get(id) ?? evaluateTransform(snapshot.object(id), op.time));
    pose.position = new Vector3(...pose.position).add(offset).toArray(); poses.set(id, pose); snapshot.pose(id, pose);
  };
  const distinct = (a: string, b: string) => { if (a === b) throw new Error('A spatial relation needs two different objects.'); };
  try {
    switch (op.type) {
      case 'place_on': {
        snapshot.object(op.id);
        if (op.supportId) distinct(op.id, op.supportId);
        if (op.supportId && op.horizontal === 'center') {
          const offset = snapshot.bounds(op.supportId).getCenter(new Vector3()).sub(snapshot.bounds(op.id).getCenter(new Vector3()));
          move(op.id, offset.setY(0));
        }
        const bounds = snapshot.bounds(op.id);
        let height = 0;
        if (op.supportId) {
          const support = snapshot.root(op.supportId), supportBounds = snapshot.bounds(op.supportId), heights: number[] = [];
          const sampled = bottomPoints(snapshot.root(op.id), bounds);
          for (const point of sampled) {
            const height = upwardSurface(support, point.x, point.z, supportBounds.max.y + 1);
            if (height !== null) heights.push(height);
          }
          if (!heights.length) throw new Error(`No upward support surface of ${op.supportId} under ${op.id}. Align its footprint or use horizontal=center.`);
          height = Math.max(...heights);
          observations.contact = { method: 'sampled bottom geometry and support-mesh rays', sampled: sampled.length, hits: heights.length,
            warning: heights.length < sampled.length || Math.max(...heights) - Math.min(...heights) > .005 ? 'Some feet are unsupported or at different heights; inspect stability visually.' : null };
        }
        const delta = height + op.clearance - bounds.min.y;
        move(op.id, new Vector3(0, delta, 0)); observations.translationY = delta; observations.supportHeight = height;
        break;
      }
      case 'place_relative': {
        distinct(op.id, op.referenceId); const frame = snapshot.frame(op.frame);
        const axis = ['left', 'right'].includes(op.side) ? 0 : ['above', 'below'].includes(op.side) ? 1 : 2;
        const positive = ['right', 'above', 'front'].includes(op.side), source = snapshot.bounds(op.id, frame), target = snapshot.bounds(op.referenceId, frame);
        const delta = positive ? target.max.getComponent(axis) + op.gap - source.min.getComponent(axis) : target.min.getComponent(axis) - op.gap - source.max.getComponent(axis);
        const offset = new Vector3().setComponent(axis, delta).applyMatrix3(new Matrix3().setFromMatrix4(frame));
        move(op.id, offset); observations.edgeGap = op.gap; observations.worldOffset = offset.toArray(); break;
      }
      case 'face_target': {
        distinct(op.id, op.targetId); const pose = evaluateTransform(snapshot.object(op.id), op.time);
        const direction = snapshot.bounds(op.targetId).getCenter(new Vector3()).sub(new Vector3(...pose.position)).setY(0);
        const quaternion = new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3, 'XYZ'));
        const current = forwardVector(op.forward).applyQuaternion(quaternion).setY(0);
        if (direction.lengthSq() < 1e-10 || current.lengthSq() < 1e-10) throw new Error('Cannot determine a horizontal facing direction.');
        const angle = Math.atan2(direction.x, direction.z) - Math.atan2(current.x, current.z);
        quaternion.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle));
        const euler = new Euler().setFromQuaternion(quaternion, 'XYZ'); pose.rotation = [euler.x, euler.y, euler.z].map(MathUtils.radToDeg) as Vec3;
        poses.set(op.id, pose); observations.yawDeltaDegrees = MathUtils.radToDeg(angle); break;
      }
      case 'align_objects': {
        const frame = snapshot.frame(op.frame), axis = axisIndex[op.axis], target = pointAt(snapshot.bounds(op.referenceId, frame), op.edge).getComponent(axis);
        for (const id of unique(op.objectIds)) {
          if (id === op.referenceId) continue;
          const delta = target - pointAt(snapshot.bounds(id, frame), op.edge).getComponent(axis);
          move(id, new Vector3().setComponent(axis, delta).applyMatrix3(new Matrix3().setFromMatrix4(frame)));
        }
        break;
      }
      case 'distribute_objects': {
        const frame = snapshot.frame(op.frame), axis = axisIndex[op.axis];
        const rows = unique(op.objectIds).map(id => ({ id, bounds: snapshot.bounds(id, frame) })).sort((a, b) => a.bounds.getCenter(new Vector3()).getComponent(axis) - b.bounds.getCenter(new Vector3()).getComponent(axis));
        const first = rows[0].bounds, last = rows.at(-1)!.bounds;
        const start = pointAt(first, op.spacing === 'gaps' ? 'min' : 'center').getComponent(axis), end = pointAt(last, op.spacing === 'gaps' ? 'max' : 'center').getComponent(axis);
        const size = (box: Box3) => box.max.getComponent(axis) - box.min.getComponent(axis);
        const spacing = (end - start - (op.spacing === 'gaps' ? rows.reduce((sum, row) => sum + size(row.bounds), 0) : 0)) / (rows.length - 1);
        if (spacing < -1e-8) throw new Error('There is not enough room for non-overlapping equal gaps. Move the endpoints apart.');
        let coordinate = start;
        for (const row of rows) {
          const delta = coordinate - pointAt(row.bounds, op.spacing === 'gaps' ? 'min' : 'center').getComponent(axis);
          move(row.id, new Vector3().setComponent(axis, delta).applyMatrix3(new Matrix3().setFromMatrix4(frame)));
          coordinate += spacing + (op.spacing === 'gaps' ? size(row.bounds) : 0);
        }
        observations.spacing = spacing; break;
      }
      case 'attach_anchor': {
        distinct(op.id, op.targetId); const frame = snapshot.frame(op.frame);
        const offset = new Vector3(...op.offset).applyMatrix3(new Matrix3().setFromMatrix4(frame));
        move(op.id, snapshot.anchor(op.targetId, op.targetAnchor).add(offset).sub(snapshot.anchor(op.id, op.anchor)));
        observations.binding = 'one-time alignment; no persistent dependency'; break;
      }
      case 'follow_path': {
        const object = snapshot.object(op.id);
        if ((object.track || object.animation) && !op.replaceMotion) throw new Error('This object already has motion. Set replaceMotion=true only to replace it explicitly.');
        if (op.start + op.duration > snapshot.scene.duration + 1e-9) throw new Error('Path motion must finish within the scene.');
        const points = op.points.map(p => new Vector3(...p)), distances = [0];
        for (let i = 1; i < points.length; i++) {
          const distance = points[i].distanceTo(points[i - 1]); if (distance < 1e-6) throw new Error('Consecutive path points must differ.');
          distances.push(distances[i - 1] + distance);
        }
        const length = distances.at(-1)!, fractions = new Set([0, 1, ...distances.map(d => d / length)]);
        // Straight segments interpolate exactly. Keep corners and one pre-turn pose,
        // rather than repeating identical headings at 30fps into projects/tool contexts.
        if (op.orientation === 'tangent') for (let i = 1; i < distances.length - 1; i++) {
          const corner = distances[i] / length, previous = distances[i - 1] / length;
          fractions.add(corner - Math.min(1 / (30 * op.duration), (corner - previous) / 2));
        }
        const original = evaluateTransform(object, op.time), fwd = forwardVector(op.forward);
        const times = [...fractions].sort((a, b) => a - b).filter((at, i, all) => i === 0 || at - all[i - 1] > 1e-9);
        const frames = times.map(at => {
          const distance = at * length; let segment = 1; while (segment < points.length - 1 && distances[segment] <= distance + 1e-10) segment++;
          const pose = structuredClone(original), direction = points[segment].clone().sub(points[segment - 1]);
          pose.position = points[segment - 1].clone().lerp(points[segment], (distance - distances[segment - 1]) / (distances[segment] - distances[segment - 1])).toArray();
          if (op.orientation === 'tangent') {
            if (Math.hypot(direction.x, direction.z) < 1e-8) throw new Error('Tangent facing needs a horizontal path direction; use orientation=keep for vertical movement.');
            const yaw = Math.atan2(direction.x, direction.z) - Math.atan2(fwd.x, fwd.z);
            pose.rotation = poseOf(new Matrix4().makeRotationY(yaw)).rotation;
          }
          return { time: op.start + at * op.duration, transform: pose };
        });
        const track = recordedTrack(frames);
        return checked({ updates: [{ id: op.id, transform: structuredClone(track.from), track }],
          observations: { length, speed: length / op.duration, samples: frames.length, path: 'piecewise-linear, constant speed; points are world-space object origins', collisionChecked: false } });
      }
    }
    const updates = [...poses].map(([id, pose]) => {
      const object = snapshot.object(id);
      if ('scope' in op && op.scope === 'static' && (object.track || object.animation)) throw new Error(`${id} is animated. Use scope=whole_motion to preserve and reposition its entire path.`);
      const updated = transformSelection([object], [{ id, transform: pose }], op.time, true)[0];
      return { id, transform: updated.transform, track: updated.track, ...(updated.animation ? { animation: updated.animation } : {}) };
    });
    return checked({ updates, observations });
  } finally { snapshot.dispose(); }
}
