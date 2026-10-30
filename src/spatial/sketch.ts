import { evaluateComponents, evaluateTransform } from '../model.ts';
import type { SceneDocument, SceneObject, Vec3 } from '../types.ts';
import type { SpatialOperation } from './schema.ts';

/** Strokes are drawn on the floor; points closer than this many metres are noise. */
export const SKETCH_STEP = .08;
const MAX_POINTS = 120;
const WALK_SPEED = 1.4;

function distanceToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0], dz = b[2] - a[2], length = dx * dx + dz * dz;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / length)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[2] - a[2] - t * dz);
}

/** Ramer-Douglas-Peucker on the ground plane, then uniform resampling if still above the operation's point limit. */
export function simplifyPath(points: Vec3[], tolerance = .05, maxPoints = MAX_POINTS): Vec3[] {
  const kept = points.filter((point, index) => index === 0 || Math.hypot(point[0] - points[index - 1][0], point[2] - points[index - 1][2]) > 1e-6);
  if (kept.length < 3) return kept.map(point => [...point] as Vec3);
  const keep = new Array(kept.length).fill(false); keep[0] = keep[kept.length - 1] = true;
  const stack: [number, number][] = [[0, kept.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!; let worst = -1, distance = tolerance;
    for (let i = first + 1; i < last; i++) { const d = distanceToSegment(kept[i], kept[first], kept[last]); if (d > distance) { distance = d; worst = i; } }
    if (worst >= 0) { keep[worst] = true; stack.push([first, worst], [worst, last]); }
  }
  const simple = kept.filter((_, index) => keep[index]);
  if (simple.length <= maxPoints) return simple.map(point => [...point] as Vec3);
  const lengths = [0];
  for (let i = 1; i < simple.length; i++) lengths.push(lengths[i - 1] + Math.hypot(simple[i][0] - simple[i - 1][0], simple[i][2] - simple[i - 1][2]));
  const total = lengths.at(-1)!, resampled: Vec3[] = [];
  for (let n = 0, segment = 1; n < maxPoints; n++) {
    const at = total * n / (maxPoints - 1);
    while (segment < simple.length - 1 && lengths[segment] < at) segment++;
    const span = lengths[segment] - lengths[segment - 1] || 1, f = Math.max(0, Math.min(1, (at - lengths[segment - 1]) / span));
    resampled.push(simple[segment - 1].map((value, axis) => value + (simple[segment][axis] - value) * f) as Vec3);
  }
  return resampled;
}

export function pathLength(points: Vec3[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
  return length;
}

/**
 * A floor stroke as a constant-speed follow_path operation for one object.
 * The object keeps its current origin height and turns to face along the path.
 * Motion starts at the playhead and lasts as long as the object's movement speed
 * needs, shortened only when the scene would end first.
 */
export function sketchedPath(scene: SceneDocument, object: SceneObject, stroke: Vec3[], time: number): { operation: Extract<SpatialOperation, { type: 'follow_path' }>; length: number; speed: number; fitted: boolean } {
  const height = evaluateTransform(object, time).position[1];
  const points = simplifyPath(stroke).map(([x, , z]) => [x, height, z] as Vec3);
  const length = pathLength(points);
  if (points.length < 2 || length < .2) throw new Error('Draw a longer path on the ground.');
  const movement = evaluateComponents(object, time)?.find(component => component.type === 'movement');
  const speed = movement && 'speed' in movement ? movement.speed : WALK_SPEED;
  const start = scene.duration - time >= .5 ? time : 0;
  const natural = length / speed, duration = Math.max(.1, Math.min(natural, scene.duration - start));
  return {
    operation: { type: 'follow_path', sceneId: scene.id, time, id: object.id, points, start, duration, orientation: 'tangent', forward: '+z', replaceMotion: Boolean(object.track || object.animation) },
    length, speed: length / duration, fitted: duration < natural - 1e-9,
  };
}
