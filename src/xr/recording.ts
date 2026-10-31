import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import { animationFor, evaluateTransform } from '../model';
import { emptyAnimation, keepRecordedTake } from '../animation/model';
import { transformSchema } from '../performance/motion';
import type { SceneObject, Transform } from '../types';

export type XRRecordAction = 'record' | 'preview' | 'apply' | 'discard';
export interface XRRecordingState {
  mode: 'idle' | 'armed' | 'recording' | 'review';
  canRecord?: boolean;
  samples?: number;
  keys?: number;
  previewing?: boolean;
}
export interface PoseSample { time: number; transform: Transform }
const quaternion = (pose: Transform) => new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as [number, number, number]));
function rotation(q: Quaternion): Transform['rotation'] {
  const e = new Euler().setFromQuaternion(q);
  return [e.x, e.y, e.z].map(MathUtils.radToDeg) as Transform['rotation'];
}
export function interpolatePose(a: Transform, b: Transform, t: number): Transform {
  return { position: new Vector3(...a.position).lerp(new Vector3(...b.position), t).toArray(),
    rotation: rotation(quaternion(a).slerp(quaternion(b), t)), scale: [...a.scale] };
}

/** Centered five-sample filter followed by bounded position/quaternion error reduction. */
export function processRecording(raw: PoseSample[], positionTolerance = .02, angleTolerance = MathUtils.degToRad(3)): PoseSample[] {
  if (raw.length < 2) throw new Error('Record a longer movement.');
  const smooth = raw.map((sample, i) => {
    if (i === 0 || i === raw.length - 1) return structuredClone(sample);
    const p = new Vector3(), q = new Quaternion(0, 0, 0, 0), reference = quaternion(sample.transform);
    let total = 0;
    // Shrink symmetrically near endpoints: a clipped window would introduce
    // artificial acceleration and extra keys even on an exact straight line.
    const radius = Math.min(2, i, raw.length - 1 - i);
    for (let j = i - radius; j <= i + radius; j++) {
      const weight = 3 - Math.abs(j - i), next = quaternion(raw[j].transform);
      const sign = reference.dot(next) < 0 ? -1 : 1;
      p.addScaledVector(new Vector3(...raw[j].transform.position), weight);
      q.set(q.x + next.x * weight * sign, q.y + next.y * weight * sign, q.z + next.z * weight * sign, q.w + next.w * weight * sign);
      total += weight;
    }
    return { time: sample.time, transform: { position: p.divideScalar(total).toArray(), rotation: rotation(q.normalize()), scale: [...sample.transform.scale] } as Transform };
  });
  const errorAt = (first: number, last: number, i: number) => {
    const t = (smooth[i].time - smooth[first].time) / (smooth[last].time - smooth[first].time);
    const expected = interpolatePose(smooth[first].transform, smooth[last].transform, t), actual = smooth[i].transform;
    return Math.max(new Vector3(...expected.position).distanceTo(new Vector3(...actual.position)) / positionTolerance,
      quaternion(expected).angleTo(quaternion(actual)) / angleTolerance);
  };
  const keep = new Set([0, smooth.length - 1]), pending = [[0, smooth.length - 1]];
  while (pending.length) {
    const [first, last] = pending.pop()!;
    let worst = 1, at = -1;
    for (let i = first + 1; i < last; i++) {
      const error = errorAt(first, last, i);
      if (error > worst) { worst = error; at = i; }
    }
    if (at >= 0) { keep.add(at); pending.push([first, at], [at, last]); }
  }
  const indices = [...keep].sort((a, b) => a - b);
  // Remove redundant split points, checking every original smoothed sample,
  // including time spent stationary (not just spatial distance to the path).
  for (let i = 1; i < indices.length - 1;) {
    const first = indices[i - 1], last = indices[i + 1];
    let removable = true;
    for (let j = first + 1; j < last; j++) if (errorAt(first, last, j) > 1) { removable = false; break; }
    if (removable) { indices.splice(i, 1); i = Math.max(1, i - 1); }
    else i++;
  }
  return indices.map(i => smooth[i]);
}

/** A single-grip take never mutates its source. Only apply() produces a document replacement. */
export class XRRecording {
  mode: XRRecordingState['mode'] = 'armed';
  readonly before: SceneObject;
  readonly start: number;
  time: number;
  pose: Transform;
  previewing = false;
  private startedAt = 0;
  private last: PoseSample;
  private raw: PoseSample[] = [];
  private processed: PoseSample[] = [];
  private result?: SceneObject;
  constructor(item: SceneObject, time: number, readonly duration: number) {
    if (time < 0 || duration - time < .1) throw new Error('Move the playhead earlier to record at least 0.1 seconds.');
    this.before = structuredClone(item); this.start = this.time = time;
    this.pose = evaluateTransform(item, time); this.last = { time, transform: structuredClone(this.pose) };
  }
  begin(now: number): void {
    if (this.mode !== 'armed') return;
    this.mode = 'recording'; this.startedAt = now;
    this.raw = [{ time: this.start, transform: structuredClone(this.pose) }];
  }
  sample(pose: Transform, now: number): void {
    if (this.mode !== 'recording') return;
    const next = { time: Math.min(this.duration, this.start + Math.max(0, now - this.startedAt) / 1000), transform: transformSchema.parse(pose) };
    if (next.time < this.last.time) return;
    // Fixed-rate resampling makes filtering independent of headset refresh rate.
    for (let at = this.start + this.raw.length / 30; at <= next.time + 1e-9; at = this.start + this.raw.length / 30) {
      const alpha = next.time > this.last.time ? Math.min(1, (at - this.last.time) / (next.time - this.last.time)) : 1;
      this.raw.push({ time: Math.min(at, this.duration), transform: interpolatePose(this.last.transform, next.transform, alpha) });
    }
    this.last = next; this.time = next.time; this.pose = structuredClone(next.transform);
    if (this.time >= this.duration) this.stop();
  }
  stop(): void {
    if (this.mode !== 'recording') return;
    if (this.time - this.start < .1 - 1e-9) { this.cancelGrip(); return; }
    if (this.time - this.raw.at(-1)!.time > 1e-8) this.raw.push(structuredClone(this.last));
    else this.raw[this.raw.length - 1] = structuredClone(this.last);
    this.processed = processRecording(this.raw);
    const current = animationFor(this.before) ?? emptyAnimation();
    let n = 1; while (current.takes.some(take => take.id === `xr-take-${n}`)) n++;
    this.result = { ...structuredClone(this.before), track: null,
      animation: keepRecordedTake(current, `xr-take-${n}`, this.processed, this.duration) };
    this.mode = 'review'; this.time = this.start;
  }
  cancelGrip(): void {
    if (this.mode === 'review') return;
    this.mode = 'armed'; this.time = this.start; this.pose = evaluateTransform(this.before, this.start);
    this.last = { time: this.start, transform: structuredClone(this.pose) }; this.raw = [];
  }
  preview(time: number): Transform { return this.result ? evaluateTransform(this.result, time) : structuredClone(this.pose); }
  keyframeEntity(): SceneObject { return this.result ?? this.before; }
  togglePreview(): void { if (this.mode === 'review') { this.previewing = !this.previewing; if (this.previewing) this.time = this.start; } }
  advance(dt: number): void {
    if (!this.previewing) return;
    this.time = Math.min(this.time + Math.max(0, dt), this.processed.at(-1)!.time);
    if (this.time >= this.processed.at(-1)!.time) this.previewing = false;
  }
  apply(): SceneObject { if (!this.result || this.mode !== 'review') throw new Error('Finish recording first.'); return structuredClone(this.result); }
  state(): XRRecordingState { return { mode: this.mode, samples: this.raw.length, keys: this.processed.length, previewing: this.previewing }; }
}
