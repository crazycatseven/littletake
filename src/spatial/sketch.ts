import { Euler, MathUtils, Matrix4, Vector3 } from 'three';
import { evaluateComponents, evaluateTransform } from '../model.ts';
import { recordedTrack } from '../performance/motion.ts';
import { validateProjectContent } from '../project/model.ts';
import type { MotionTrack, ProjectContent, SceneCamera, SceneDocument, SceneObject, Shot, Transform, Vec3 } from '../types.ts';
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

/** Where on a subject a camera aims: chest height for people, the origin for everything else. */
function aimPoint(object: SceneObject, time: number): Vector3 {
  const pose = evaluateTransform(object, time), point = new Vector3(...pose.position);
  if (object.kind === 'human') point.y += 1.4 * pose.scale[1];
  return point;
}

/** The object nearest the centre of the camera's view at `time`, if any lies in front of it. */
export function framedSubject(scene: SceneDocument, camera: SceneCamera, time: number): SceneObject | null {
  const pose = evaluateTransform(camera, time), eye = new Vector3(...pose.position);
  const forward = new Vector3(0, 0, -1).applyEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3, 'XYZ'));
  let best: SceneObject | null = null, bestAngle = MathUtils.degToRad(40);
  for (const object of scene.objects) {
    if (object.hidden) continue;
    const direction = aimPoint(object, time).sub(eye);
    if (direction.lengthSq() < 1e-6 || direction.dot(forward) <= 0) continue;
    const angle = direction.angleTo(forward);
    if (angle < bestAngle) { bestAngle = angle; best = object; }
  }
  return best;
}

/**
 * A floor stroke as a camera move. The camera keeps its height, travels the path at constant
 * speed over the shot it films (or from the playhead to the scene end), and keeps aiming at the
 * subject nearest its view centre, following that subject if it moves. Without a subject it keeps
 * looking at the point it looks at now.
 */
export function sketchedCameraMove(scene: SceneDocument, camera: SceneCamera, stroke: Vec3[], time: number, shot: Shot | null): { track: MotionTrack; length: number; subject: SceneObject | null; start: number; duration: number } {
  const pose = evaluateTransform(camera, time), height = pose.position[1];
  const points = simplifyPath(stroke).map(([x, , z]) => new Vector3(x, height, z));
  const length = pathLength(points.map(point => point.toArray() as Vec3));
  if (points.length < 2 || length < .2) throw new Error('Draw a longer camera path on the ground.');
  const owned = shot && shot.cameraId === camera.id ? shot : null;
  const start = owned ? owned.start : scene.duration - time >= .5 ? time : 0;
  const duration = owned ? owned.duration : scene.duration - start;
  if (duration < .1) throw new Error('The shot is too short for a camera move.');
  const subject = framedSubject(scene, camera, time);
  const forward = new Vector3(0, 0, -1).applyEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3, 'XYZ'));
  const fixed = new Vector3(...pose.position).addScaledVector(forward, 5);
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + points[i].distanceTo(points[i - 1]));
  const steps = Math.max(points.length * 2, Math.ceil(duration * 12));
  const frames: { time: number; transform: Transform }[] = [];
  for (let n = 0, segment = 1; n <= steps; n++) {
    const at = n / steps, distance = at * length;
    while (segment < points.length - 1 && distances[segment] < distance) segment++;
    const span = distances[segment] - distances[segment - 1] || 1;
    const eye = points[segment - 1].clone().lerp(points[segment], Math.min(1, Math.max(0, (distance - distances[segment - 1]) / span)));
    const when = start + at * duration, target = subject ? aimPoint(subject, when) : fixed;
    if (eye.distanceToSquared(target) < 1e-6) throw new Error('The path passes through the subject the camera is aiming at.');
    const rotation = new Euler().setFromRotationMatrix(new Matrix4().lookAt(eye, target, new Vector3(0, 1, 0)), 'XYZ');
    frames.push({ time: when, transform: { position: eye.toArray() as Vec3, rotation: [rotation.x, rotation.y, rotation.z].map(MathUtils.radToDeg) as Vec3, scale: [...pose.scale] as Vec3 } });
  }
  return { track: recordedTrack(frames), length, subject, start, duration };
}

/** Replace one camera's motion with a drawn move; the result is validated like any saved project. */
export function withCameraMove(project: ProjectContent, sceneId: string, cameraId: string, track: MotionTrack): ProjectContent {
  const next = structuredClone(project), camera = next.scenes.find(scene => scene.id === sceneId)?.cameras.find(item => item.id === cameraId);
  if (!camera) throw new Error('That camera is no longer in this scene.');
  camera.transform = structuredClone(track.from); camera.track = structuredClone(track); delete camera.animation;
  return validateProjectContent(next);
}
