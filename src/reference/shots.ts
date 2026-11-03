/**
 * Browser implementation of the HSV content / rolling-average method used by
 * PySceneDetect's AdaptiveDetector (BSD-3-Clause). See /licenses/pyscenedetect.txt.
 * Flash suppression, fade intervals and sparse frame selection are LittleTake's.
 */
export const MAX_SOURCE_FRAMES = 18;
export const SCAN_WIDTH = 160;
export const SCAN_HEIGHT = 90;
const GRID_WIDTH = 32, GRID_HEIGHT = 18;
const MIN_SHOT_SECONDS = .12;

export interface SourceTransition {
  kind: 'cut' | 'fade';
  time: number;
  start: number;
  end: number;
  score: number;
}
export interface SourceSampling {
  algorithm: 'adaptive-hsv-v1';
  decodedFrames: number;
  transitions: SourceTransition[];
  limited: boolean;
}
export type SampleReason = 'representative' | 'early' | 'late' | 'change';
export interface SourceSample { frameIndex: number; time: number; shotIndex: number; reason: SampleReason }
interface ScanFrame {
  time: number;
  content: number;
  brightness: number;
  sharpness: number;
  descriptor: Uint8Array;
}

/** RGB block differences retain small moving subjects as well as whole-frame changes. */
function distance(a: ScanFrame, b: ScanFrame): number {
  const blocks: number[] = [];
  let total = 0;
  for (let i = 0; i < a.descriptor.length; i += 3) {
    const difference = (Math.abs(a.descriptor[i] - b.descriptor[i]) + Math.abs(a.descriptor[i + 1] - b.descriptor[i + 1]) + Math.abs(a.descriptor[i + 2] - b.descriptor[i + 2])) / 3;
    blocks.push(difference); total += difference;
  }
  blocks.sort((x, y) => y - x);
  const count = Math.ceil(blocks.length / 10);
  return .5 * total / blocks.length + .5 * blocks.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
}

/** Keeps small descriptors, not all decoded video pixels. No model or network calls. */
export class ShotScanner {
  private previous?: Uint8Array;
  private readonly frames: ScanFrame[] = [];

  push(rgba: Uint8Array | Uint8ClampedArray, time: number): void {
    if (rgba.length !== SCAN_WIDTH * SCAN_HEIGHT * 4) throw new Error('Unexpected shot scanner dimensions.');
    if (!Number.isFinite(time) || time < 0 || (this.frames.length && time <= this.frames.at(-1)!.time)) throw new Error('Video frames must have increasing presentation timestamps.');
    const hsv = new Uint8Array(SCAN_WIDTH * SCAN_HEIGHT * 3), blocks = new Float32Array(GRID_WIDTH * GRID_HEIGHT * 3);
    let difference = 0, brightness = 0, sharpness = 0;
    for (let y = 0; y < SCAN_HEIGHT; y++) for (let x = 0; x < SCAN_WIDTH; x++) {
      const pixel = y * SCAN_WIDTH + x, offset = pixel * 4, r = rgba[offset], g = rgba[offset + 1], b = rgba[offset + 2];
      const maximum = Math.max(r, g, b), minimum = Math.min(r, g, b), delta = maximum - minimum;
      let hue = delta === 0 ? 0 : maximum === r ? (g - b) / delta : maximum === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
      hue = (hue * 30 + 180) % 180;
      const h = pixel * 3; hsv[h] = Math.round(hue); hsv[h + 1] = maximum ? Math.round(delta / maximum * 255) : 0; hsv[h + 2] = maximum;
      if (this.previous) for (let c = 0; c < 3; c++) difference += Math.abs(hsv[h + c] - this.previous[h + c]);
      brightness += maximum;
      if (x) sharpness += Math.abs(maximum - hsv[h - 1]);
      if (y) sharpness += Math.abs(maximum - hsv[h - SCAN_WIDTH * 3 + 2]);
      const block = (Math.floor(y / 5) * GRID_WIDTH + Math.floor(x / 5)) * 3;
      blocks[block] += r / 25; blocks[block + 1] += g / 25; blocks[block + 2] += b / 25;
    }
    const count = SCAN_WIDTH * SCAN_HEIGHT;
    this.frames.push({ time, content: difference / (count * 3), brightness: brightness / (count * 255), sharpness: sharpness / (count * 2), descriptor: Uint8Array.from(blocks, Math.round) });
    this.previous = hsv;
  }

  finish(duration: number, maxFrames = MAX_SOURCE_FRAMES): { cuts: number[]; sampling: SourceSampling; frames: SourceSample[] } {
    const frames = this.frames;
    if (!frames.length || frames.at(-1)!.time >= duration || duration <= 0) throw new Error('The video timing could not be read.');
    const flashes = new Set<number>();
    // A short exposure spike returning to the same picture is not a new shot.
    for (let i = 1; i < frames.length - 1; i++) {
      if (Math.abs(frames[i].brightness - frames[i - 1].brightness) < .25) continue;
      for (let j = i + 1; j < frames.length && frames[j].time - frames[i].time <= .13; j++) {
        if (distance(frames[i - 1], frames[j]) < 8 && distance(frames[i - 1], frames[i]) > 35) {
          for (let k = i; k < j; k++) flashes.add(k);
          break;
        }
      }
    }
    const transitions: SourceTransition[] = [];
    for (let i = 1; i < frames.length; i++) {
      if (flashes.has(i) || flashes.has(i - 1)) continue;
      let sum = 0, count = 0;
      for (let j = Math.max(1, i - 2); j <= Math.min(frames.length - 1, i + 2); j++) if (i !== j) { sum += frames[j].content; count++; }
      const ratio = count && sum > .00001 ? frames[i].content / (sum / count) : 255;
      if (frames[i].content >= 15 && ratio >= 3 && frames[i].time >= MIN_SHOT_SECONDS && duration - frames[i].time >= MIN_SHOT_SECONDS) {
        const candidate: SourceTransition = { kind: 'cut', time: frames[i].time, start: frames[i].time, end: frames[i].time, score: frames[i].content };
        const previous = transitions.at(-1);
        if (previous && candidate.time - previous.time < MIN_SHOT_SECONDS) { if (candidate.score > previous.score) transitions[transitions.length - 1] = candidate; }
        else transitions.push(candidate);
      }
    }
    // Detect a fade through black, retaining its interval so mixed/dark frames are not anchors.
    // General dissolves need a learned detector; do not mistake a steady pan for a dissolve.
    for (let i = 1; i < frames.length - 1; i++) {
      if (frames[i].brightness > .035 || flashes.has(i)) continue;
      const first = i;
      while (i + 1 < frames.length && frames[i + 1].brightness <= .035) i++;
      const last = i;
      let before = first - 1, after = last + 1;
      while (before > 0 && frames[first].time - frames[before - 1].time <= .8 && frames[before - 1].brightness >= frames[before].brightness - .01) before--;
      while (after + 1 < frames.length && frames[after + 1].time - frames[last].time <= .8 && frames[after + 1].brightness >= frames[after].brightness - .01) after++;
      if (after >= frames.length || first - before < 3 || after - last < 3 || frames[before].brightness < .18 || frames[after].brightness < .18 || distance(frames[before], frames[after]) < 12) continue;
      const falling = frames.slice(before + 1, first + 1).filter((frame, offset) => frames[before + offset].brightness - frame.brightness > .015).length;
      const rising = frames.slice(last + 1, after + 1).filter((frame, offset) => frame.brightness - frames[last + offset].brightness > .015).length;
      if (falling < 3 || rising < 3) continue;
      const midpoint = Math.floor((first + last) / 2), time = frames[midpoint].time;
      const start = frames[before].time, end = frames[after].time;
      for (let j = transitions.length - 1; j >= 0; j--) if (transitions[j].time >= start && transitions[j].time <= end) transitions.splice(j, 1);
      transitions.push({ kind: 'fade', time, start, end, score: distance(frames[before], frames[after]) });
    }
    transitions.sort((a, b) => a.time - b.time);
    const cuts = transitions.map(transition => transition.time), bounds = [0, ...cuts, duration];
    if (bounds.length - 1 > maxFrames) throw new Error(`This clip contains ${bounds.length - 1} shots. Choose a shorter excerpt with at most ${maxFrames} shots so every shot can be analyzed.`);
    const samples: SourceSample[] = [], extra: (SourceSample & { priority: number })[] = [];
    let limited = false;
    for (let shotIndex = 0; shotIndex < bounds.length - 1; shotIndex++) {
      const start = bounds[shotIndex], end = bounds[shotIndex + 1];
      const all = frames.map((frame, index) => ({ frame, index })).filter(({ frame }) => frame.time >= start && frame.time < end);
      const clean = all.filter(({ frame, index }) => !flashes.has(index) && frame.brightness > .04 && !transitions.some(t => t.kind === 'fade' && frame.time > t.start && frame.time < t.end));
      const pool = clean.length ? clean : all;
      if (!pool.length) throw new Error('A detected shot contains no decodable frame.');
      const sharpest = Math.max(...pool.map(item => item.frame.sharpness), .01);
      const quality = (item: typeof pool[number]) => .65 * item.frame.sharpness / sharpest + .15 * (1 - Math.abs(item.frame.brightness - .5)) + .2 * (1 - Math.abs(item.frame.time - (start + end) / 2) / (end - start));
      const best = (items: typeof pool) => items.reduce((a, b) => quality(a) >= quality(b) ? a : b);
      const anchor = best(pool), picked = [anchor];
      const sample = (item: typeof pool[number], reason: SampleReason): SourceSample => ({ frameIndex: item.index, time: item.frame.time, shotIndex, reason });
      samples.push(sample(anchor, 'representative'));
      const changes = pool.filter(item => distance(anchor.frame, item.frame) >= 12);
      if (!changes.length) continue;
      const margin = Math.min(.2, (end - start) * .15);
      for (const [items, reason] of [[pool.filter(item => item.frame.time <= pool[0].frame.time + margin), 'early'], [pool.filter(item => item.frame.time >= pool.at(-1)!.frame.time - margin), 'late']] as const) {
        const item = best(items);
        if (picked.some(previous => Math.abs(previous.frame.time - item.frame.time) < Math.min(.16, (end - start) / 4))) continue;
        picked.push(item); extra.push({ ...sample(item, reason), priority: 45 + Math.min(20, distance(anchor.frame, item.frame)) });
      }
      // Novel appearance and motion extrema are chosen by distance from ALL retained evidence.
      for (let attempt = 0; attempt < 2; attempt++) {
        const ranked = pool.filter(item => picked.every(previous => Math.abs(previous.frame.time - item.frame.time) >= .2)).map(item => ({ item, change: Math.min(...picked.map(previous => distance(previous.frame, item.frame))) })).sort((a, b) => b.change - a.change);
        if (!ranked.length || ranked[0].change < 12) break;
        const { item, change } = ranked[0]; picked.push(item); extra.push({ ...sample(item, 'change'), priority: Math.min(60, change) });
      }
    }
    extra.sort((a, b) => b.priority - a.priority || a.time - b.time);
    for (const { priority: _, ...frame } of extra) {
      if (samples.length >= maxFrames) { limited = true; break; }
      samples.push(frame);
    }
    samples.sort((a, b) => a.time - b.time);
    return { cuts, sampling: { algorithm: 'adaptive-hsv-v1', decodedFrames: frames.length, transitions, limited }, frames: samples };
  }
}
