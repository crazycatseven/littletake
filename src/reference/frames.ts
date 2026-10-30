import { detectCuts } from './cuts';
import { readReferenceVideo } from './video';
import type { ReferenceInput } from './types';
import { INITIAL_REFERENCE_FRAMES, MAX_REFERENCE_IMAGE_CHARACTERS, referenceSourceSchema, type ReferenceFrame, type ReferenceSource } from './observations';

/** Candidate coverage is bounded; the Agent, not this sharpness heuristic, chooses semantic usefulness. */
export function candidateTimes(duration: number, cuts: number[]) {
  const boundaries = [0, ...cuts, duration];
  const shots = boundaries.slice(0, -1).map((start, shot) => ({ shot, start, end: boundaries[shot + 1] }));
  const included = [shots[0], ...shots.slice(1).sort((a, b) => (b.end - b.start) - (a.end - a.start))].slice(0, INITIAL_REFERENCE_FRAMES).sort((a, b) => a.start - b.start);
  return { omittedShots: shots.length - included.length, candidates: included.flatMap(shot => {
    const margin = Math.min(.25, (shot.end - shot.start) / 4), start = shot.start + margin, end = shot.end - margin;
    return (end - start < .12 ? [.5] : [.05, .28, .5, .72, .95]).map(fraction => ({ shot: shot.shot, requestedTime: start + (end - start) * fraction }));
  }) };
}
export function frameQuality(pixels: Uint8ClampedArray, width: number, height: number): number {
  const gray = (x: number, y: number) => { const at = (y * width + x) * 4; return pixels[at] * .299 + pixels[at + 1] * .587 + pixels[at + 2] * .114; };
  let sum = 0, squares = 0, count = 0, clipped = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const value = gray(x, y), laplacian = gray(x - 1, y) + gray(x + 1, y) + gray(x, y - 1) + gray(x, y + 1) - 4 * value;
    sum += laplacian; squares += laplacian * laplacian; clipped += value < 4 || value > 251 ? 1 : 0; count++;
  }
  return Math.max(0, squares / Math.max(1, count) - (sum / Math.max(1, count)) ** 2) * (1 - clipped / Math.max(1, count));
}
export function chooseCandidates(frames: ReferenceFrame[]): ReferenceFrame[] {
  const selected: ReferenceFrame[] = [];
  const shots = [...new Set(frames.map(frame => frame.shot))].sort((a, b) => a - b);
  for (const shot of shots) {
    const anchor = frames.filter(frame => frame.shot === shot).sort((a, b) => b.quality - a.quality)[0];
    if (anchor) selected.push({ ...anchor, role: 'anchor' });
  }
  while (selected.length < INITIAL_REFERENCE_FRAMES) {
    const remaining = frames.filter(frame => !selected.some(chosen => chosen.id === frame.id));
    if (!remaining.length) break;
    const score = (frame: ReferenceFrame) => {
      const same = frames.filter(other => other.shot === frame.shot), quality = frame.quality / Math.max(1, ...same.map(other => other.quality));
      const distance = Math.min(...selected.filter(other => other.shot === frame.shot).map(other => Math.abs(other.time - frame.time)));
      const span = Math.max(.1, same.at(-1)!.time - same[0].time);
      return (distance / span) * (.25 + .75 * quality);
    };
    remaining.sort((a, b) => score(b) - score(a));
    const frame = remaining[0], same = frames.filter(other => other.shot === frame.shot);
    selected.push({ ...frame, role: frame.time <= same[0].time + .05 ? 'early' : frame.time >= same.at(-1)!.time - .05 ? 'late' : 'coverage' });
  }
  return selected.sort((a, b) => a.time - b.time);
}

function encode(image: CanvasImageSource, width: number, height: number, edge: number) {
  const ratio = Math.min(1, edge / Math.max(width, height)), canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, dataUrl: canvas.toDataURL('image/png') };
}
async function fitPayload(frames: ReferenceFrame[], signal: AbortSignal, allowance = 1_600_000) {
  for (const edge of [768, 640, 512, 384, 256]) {
    if (frames.reduce((sum, frame) => sum + frame.dataUrl.length, 0) <= allowance && frames.every(frame => frame.dataUrl.length <= 1_200_000)) return;
    for (const frame of frames) {
      signal.throwIfAborted();
      const image = await createImageBitmap(await (await fetch(frame.dataUrl)).blob());
      try { Object.assign(frame, encode(image, image.width, image.height, edge)); } finally { image.close(); }
    }
  }
  if (frames.reduce((sum, frame) => sum + frame.dataUrl.length, 0) > allowance || frames.some(frame => frame.dataUrl.length > 1_200_000)) throw new Error('Reference frames exceed the image allowance. Choose a smaller clip.');
}

export async function prepareReferenceFrames(file: File, signal: AbortSignal, knownVideo?: ReferenceInput['video'], knownCuts?: Promise<number[]>, requestedTimes?: number[]): Promise<ReferenceSource> {
  const sourceId = crypto.randomUUID(), name = file.name.slice(0, 200);
  if (file.type.startsWith('image/')) {
    if (!file.size || file.size > 10_000_000) throw new Error('Choose a reference image up to 10 MB.');
    const image = await createImageBitmap(file);
    try {
      signal.throwIfAborted();
      const frame: ReferenceFrame = { id: crypto.randomUUID(), time: 0, requestedTime: 0, shot: 0, role: 'image', quality: 0, ...encode(image, image.width, image.height, 960) };
      await fitPayload([frame], signal);
      return referenceSourceSchema.parse({ id: sourceId, name, kind: 'image', duration: 0, originalWidth: image.width, originalHeight: image.height, cuts: [], omittedShots: 0, frames: [frame] });
    } finally { image.close(); }
  }
  const video = knownVideo ?? await readReferenceVideo(file, signal), url = URL.createObjectURL(file);
  let cuts: number[];
  try { cuts = await (knownCuts ?? detectCuts(url, video.duration, signal)); } finally { URL.revokeObjectURL(url); }
  signal.throwIfAborted();
  const plan = requestedTimes ? { omittedShots: 0, candidates: requestedTimes.map(requestedTime => ({ requestedTime, shot: cuts.filter(cut => cut <= requestedTime).length })) } : candidateTimes(video.duration, cuts);
  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny');
  signal.throwIfAborted();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const cancel = () => input.dispose(); signal.addEventListener('abort', cancel, { once: true });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !await track.canDecode()) throw new Error('This browser cannot decode reference frames. Try an H.264 MP4.');
    const sink = new CanvasSink(track, { width: Math.max(1, Math.round(video.width * Math.min(1, 960 / Math.max(video.width, video.height)))), poolSize: 1 });
    const frames: ReferenceFrame[] = [], qualityCanvas = document.createElement('canvas'); qualityCanvas.width = 160; qualityCanvas.height = 90;
    const context = qualityCanvas.getContext('2d', { willReadFrequently: true })!;
    let index = 0;
    for await (const sample of sink.canvasesAtTimestamps(plan.candidates.map(candidate => candidate.requestedTime))) {
      signal.throwIfAborted(); const candidate = plan.candidates[index++];
      if (!sample || frames.some(frame => Math.abs(frame.time - sample.timestamp) < .00001)) continue;
      context.drawImage(sample.canvas, 0, 0, 160, 90);
      frames.push({ id: crypto.randomUUID(), ...candidate, time: sample.timestamp, role: requestedTimes ? 'requested' : 'coverage', quality: frameQuality(context.getImageData(0, 0, 160, 90).data, 160, 90),
        ...encode(sample.canvas, sample.canvas.width, sample.canvas.height, 960) });
    }
    const selected = requestedTimes ? frames : chooseCandidates(frames); await fitPayload(selected, signal, requestedTimes ? MAX_REFERENCE_IMAGE_CHARACTERS - 1_600_000 : 1_600_000);
    return referenceSourceSchema.parse({ id: sourceId, name, kind: 'video', duration: video.duration, originalWidth: video.width, originalHeight: video.height, cuts, omittedShots: plan.omittedShots, frames: selected });
  } finally { signal.removeEventListener('abort', cancel); input.dispose(); }
}
