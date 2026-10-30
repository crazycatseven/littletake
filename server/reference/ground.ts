import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { evaluateFov, evaluateTransform } from '../../src/model.ts';
import type { ReferenceDraft, ReferenceTrack, VideoReferenceInput } from '../../src/reference/types.ts';
import type { SceneCamera, SceneObject, Transform } from '../../src/types.ts';
import { mp4VideoFrameCount } from './frames.ts';
import type { SamTracks } from './sam.ts';

/**
 * Grounds a Muse draft in SAM 3.1 person tracks. Muse decides what is in the shot; SAM says exactly where
 * and when each person is in the frame. Foot points are cast onto the y=0 floor through the draft camera,
 * and movement start/stop come from the tracked path instead of a coarse estimate.
 */
const GRID = 0.1;
const LIMITS = { tracks: 8, boxesPerTrack: 600, matchDistance: 0.35, maxGroundDistance: 60 } as const;
const THRESHOLD = { ground: { speed: 0.35, travel: 0.5 }, image: { speed: 0.4, travel: 0.6 } } as const;

interface Sample { t: number; cx: number; cy: number; height: number; ground: Vector3 | null }
type Mode = 'ground' | 'image';

const round = (value: number) => Math.round(value * 100) / 100;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

function cameraAt(camera: SceneCamera, time: number, aspect: number): PerspectiveCamera {
  const pose = evaluateTransform(camera, time), view = new PerspectiveCamera(evaluateFov(camera, time), aspect, .05, 500);
  view.position.fromArray(pose.position);
  view.rotation.set(...pose.rotation.map(MathUtils.degToRad) as [number, number, number], 'XYZ');
  view.updateMatrixWorld(true);
  return view;
}

/** Casts a normalised image point onto the floor; null when the ray misses it in front of the camera. */
export function floorPoint(view: PerspectiveCamera, u: number, v: number): Vector3 | null {
  const direction = new Vector3(u * 2 - 1, 1 - v * 2, .5).unproject(view).sub(view.position).normalize();
  if (direction.y > -0.02) return null;
  const distance = -view.position.y / direction.y;
  return distance > 0 && distance <= LIMITS.maxGroundDistance ? view.position.clone().addScaledVector(direction, distance) : null;
}

function screenX(view: PerspectiveCamera, object: SceneObject, time: number): number | null {
  const point = new Vector3().fromArray(evaluateTransform(object, time).position).add(new Vector3(0, .9, 0)).project(view);
  return point.z > 1 || point.z < -1 ? null : (point.x + 1) / 2;
}

function moving(camera: SceneCamera): boolean { return Boolean(camera.track || Object.values(camera.animation?.curves ?? {}).some(keys => (keys?.length ?? 0) > 1)); }

/** Movement onset/offset on a 10 Hz grid, in metres on the floor or body heights in the image. */
function movement(samples: Sample[], mode: Mode): { onset: number; offset: number } | null {
  const grid: (Sample | null)[] = [], first = samples[0].t, last = samples[samples.length - 1].t;
  for (let t = first, index = 0; t <= last + 1e-6; t += GRID) {
    while (index + 1 < samples.length && Math.abs(samples[index + 1].t - t) <= Math.abs(samples[index].t - t)) index++;
    const nearest = samples[index];
    grid.push(Math.abs(nearest.t - t) <= GRID * 1.5 && (mode === 'image' || nearest.ground) ? { ...nearest, t } : null);
  }
  const height = median(samples.map(sample => sample.height));
  const point = (sample: Sample): [number, number] => mode === 'ground' ? [sample.ground!.x, sample.ground!.z] : [sample.cx / height, sample.cy / height];
  const smooth = grid.map((sample, index) => {
    const near = grid.slice(Math.max(0, index - 1), index + 2).filter((item): item is Sample => Boolean(item));
    return sample && near.length ? [0, 1].map(axis => near.reduce((sum, item) => sum + point(item)[axis], 0) / near.length) as [number, number] : null;
  });
  const fast = smooth.map((_, index) => {
    const before = smooth[index - 1], after = smooth[index + 1];
    return Boolean(before && after && Math.hypot(after[0] - before[0], after[1] - before[1]) / (2 * GRID) > THRESHOLD[mode].speed);
  });
  const onsetIndex = fast.findIndex((value, index) => value && fast[index + 1]);
  let offsetIndex = -1;
  for (let index = fast.length - 1; index > 0 && offsetIndex < 0; index--) if (fast[index] && fast[index - 1]) offsetIndex = index;
  if (onsetIndex < 0 || offsetIndex <= onsetIndex) return null;
  const from = smooth[onsetIndex]!, to = smooth[offsetIndex]!;
  if (Math.hypot(to[0] - from[0], to[1] - from[1]) < THRESHOLD[mode].travel) return null;
  return { onset: grid[onsetIndex]!.t, offset: grid[offsetIndex]!.t };
}

function floorAt(samples: Sample[], time: number): Vector3 | null {
  let near = samples.filter(sample => sample.ground && Math.abs(sample.t - time) <= .25);
  if (!near.length) near = samples.filter(sample => sample.ground).sort((a, b) => Math.abs(a.t - time) - Math.abs(b.t - time)).slice(0, 1);
  return near.length ? new Vector3(median(near.map(sample => sample.ground!.x)), 0, median(near.map(sample => sample.ground!.z))) : null;
}

const placed = (transform: Transform, point: Vector3): Transform => ({ ...structuredClone(transform), position: [round(point.x), transform.position[1], round(point.z)] });

export function groundReferenceDraft(draft: ReferenceDraft, input: VideoReferenceInput, result: SamTracks | Error): ReferenceDraft {
  if (result instanceof Error) return { ...draft, assumptions: [...draft.assumptions, 'SAM 3.1 tracking did not finish, so placement and timing are Muse estimates.'] };
  const scene = structuredClone(draft.scene), duration = scene.duration;
  const { width, height } = input.video, aspect = width / height;
  const camera = scene.cameras.find(item => item.id === scene.shots[0]?.cameraId) ?? scene.cameras[0];
  if (!camera || !result.size) return { ...draft, assumptions: [...draft.assumptions, 'SAM 3.1 found no people to track in this clip.'] };
  const base64 = input.video.dataUrl.slice(input.video.dataUrl.indexOf(',') + 1);
  const lastFrame = Math.max(...[...result.values()].flatMap(boxes => boxes.map(box => box.frame)));
  const frames = mp4VideoFrameCount(Buffer.from(base64, 'base64')) ?? lastFrame + 1, fps = frames / duration;

  // With detected cuts the draft is the first shot only, so tracking evidence is limited to that window.
  const shotEnd = input.video.cuts?.length ? Math.max(.1, input.video.cuts[0] - .05) : duration;
  const tracks = [...result.entries()].map(([id, boxes]) => ({ id, samples: boxes.filter(box => box.frame / fps <= shotEnd).map((box): Sample => {
    const t = Math.min(duration, box.frame / fps), u = (box.left + box.right) / 2 / width, foot = box.bottom / height;
    const feetVisible = box.bottom < height - 2 && box.bottom - box.top > height * .05;
    return { t, cx: u, cy: (box.top + box.bottom) / 2 / height, height: (box.bottom - box.top) / height, ground: feetVisible ? floorPoint(cameraAt(camera, t, aspect), u, foot) : null };
  }) })).filter(track => track.samples.length >= 3 && track.samples[track.samples.length - 1].t - track.samples[0].t >= Math.min(1, shotEnd * .15))
    .sort((a, b) => b.samples.length - a.samples.length).slice(0, LIMITS.tracks);

  // Pair each track with the draft person nearest to it on screen when the track first appears.
  const people = scene.objects.filter(item => item.kind === 'human' && !item.hidden);
  const pairs: { track: typeof tracks[number]; person: SceneObject }[] = [];
  const options = tracks.flatMap(track => {
    const t = track.samples[0].t, view = cameraAt(camera, t, aspect);
    return people.map(person => ({ track, person, distance: Math.abs((screenX(view, person, t) ?? 9) - track.samples[0].cx) }));
  }).filter(option => option.distance <= LIMITS.matchDistance).sort((a, b) => a.distance - b.distance);
  for (const option of options) if (!pairs.some(pair => pair.track === option.track || pair.person === option.person)) pairs.push(option);

  // Tracks continue across hard cuts while the draft only rebuilds the first shot, so a clip with cuts keeps Muse's
  // placement and timing and shows the tracks for review only.
  const hasCuts = !input.video.cuts?.length && draft.assumptions.some(note => /\bcuts?\b|multiple shots|several shots/i.test(note));
  const placedNames: string[] = [], timedNames: string[] = [], unplaced: string[] = [];
  for (const { track, person } of hasCuts ? [] : pairs) {
    const samples = track.samples, grounded = samples.filter(sample => sample.ground).length / samples.length >= .7;
    const mode: Mode | null = grounded ? 'ground' : moving(camera) ? null : 'image';
    const motion = mode ? movement(samples, mode) : null;
    if (motion && motion.offset - motion.onset >= .3) {
      const start = round(Math.max(0, motion.onset)), end = round(Math.min(shotEnd, motion.offset));
      const from = grounded ? floorAt(samples, start) : null, to = grounded ? floorAt(samples, end) : null;
      if (from && to) {
        const base = person.track ?? { from: person.transform, to: person.transform };
        person.track = { start, duration: round(end - start), from: placed(base.from, from), to: placed(base.to, to) };
        person.transform = structuredClone(person.track.from);
        placedNames.push(person.name); timedNames.push(`${person.name} ${start.toFixed(2)}–${end.toFixed(2)} s`);
      } else if (person.track) {
        person.track = { ...person.track, samples: undefined, start, duration: round(end - start) };
        timedNames.push(`${person.name} ${start.toFixed(2)}–${end.toFixed(2)} s`);
      } else unplaced.push(person.name);
    } else if (grounded && !person.track) {
      const point = floorAt(samples, median(samples.map(sample => sample.t)));
      if (point) { person.transform = placed(person.transform, point); placedNames.push(person.name); }
    }
  }

  const notes = [`SAM 3.1 tracked ${tracks.length} ${tracks.length === 1 ? 'person' : 'people'} and matched ${pairs.length} to the draft.`];
  if (input.video.cuts?.length) notes.push(`Tracking used the first shot only (0–${input.video.cuts[0].toFixed(2)} s, before the first detected cut).`);
  if (hasCuts) notes.push('The clip has cuts, so tracks are shown for review only; placement and timing stay Muse estimates.');
  if (placedNames.length) notes.push(`Placed ${placedNames.join(', ')} on the floor at their tracked foot points.`);
  if (timedNames.length) notes.push(`Movement timing from tracking: ${timedNames.join('; ')}.`);
  if (unplaced.length) notes.push(`${unplaced.join(', ')} moved in the footage, but their feet were not visible enough to place the move.`);
  const reviewTracks: ReferenceTrack[] = tracks.map((track, index) => {
    const pair = pairs.find(item => item.track === track), boxes: ReferenceTrack['boxes'] = [];
    let last = -Infinity;
    for (const box of result.get(track.id)!) {
      const t = box.frame / fps;
      if (t - last < GRID - 1e-6 || boxes.length >= LIMITS.boxesPerTrack) continue;
      boxes.push([Math.round(t * 1000) / 1000, ...[box.left / width, box.top / height, (box.right - box.left) / width, (box.bottom - box.top) / height].map(value => Math.round(value * 1000) / 1000)] as ReferenceTrack['boxes'][number]);
      last = t;
    }
    return { label: pair?.person.name ?? `Person ${index + 1}`, ...(pair ? { objectId: pair.person.id } : {}), boxes };
  });
  return { ...draft, scene, assumptions: [...draft.assumptions, notes.join(' ')], tracks: reviewTracks };
}
