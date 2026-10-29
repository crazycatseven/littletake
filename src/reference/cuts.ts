/**
 * Hard-cut detection for reference clips, done in the browser before upload. Frames are sampled every 0.2 s
 * at 64×36 and compared by colour histogram (the content-detector approach of scene-detection tools); a cut is
 * a spike well above the clip's ordinary frame-to-frame change, so camera moves and actors do not trigger it.
 */
export const CUT_STEP = 0.2;
const BINS = 4, SIZE = { width: 64, height: 36 };

export function colourHistogram(pixels: Uint8ClampedArray | Uint8Array): Float32Array {
  const bins = new Float32Array(BINS ** 3), shift = 8 - Math.log2(BINS);
  let count = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4, count++) bins[((pixels[index] >> shift) * BINS + (pixels[index + 1] >> shift)) * BINS + (pixels[index + 2] >> shift)]++;
  for (let index = 0; index < bins.length; index++) bins[index] /= count || 1;
  return bins;
}

/** Half the L1 distance between normalised histograms: 0 for identical frames, 1 for disjoint colours. */
export function histogramDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += Math.abs(a[index] - b[index]);
  return sum / 2;
}

/** `distances[i]` compares samples i-1 and i. Returns cut times (midway between the two samples), in order. */
export function findCuts(times: number[], distances: number[], minGap = .5): number[] {
  const changes = distances.slice(1).filter(Number.isFinite).sort((a, b) => a - b);
  if (!changes.length) return [];
  const median = changes[changes.length >> 1], threshold = Math.max(.2, median * 5), cuts: number[] = [];
  for (let index = 1; index < distances.length; index++) {
    const value = distances[index];
    if (!(value > threshold) || value < (distances[index - 1] ?? 0) || value < (distances[index + 1] ?? 0)) continue;
    const at = Math.round((times[index - 1] + times[index]) / 2 * 100) / 100;
    if (!cuts.length || at - cuts[cuts.length - 1] >= minGap) cuts.push(at);
  }
  return cuts;
}

/** Seeks a muted, detached video through the clip. Returns [] rather than failing the import. */
export async function detectCuts(src: string, duration: number, signal?: AbortSignal): Promise<number[]> {
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  const canvas = document.createElement('canvas'); canvas.width = SIZE.width; canvas.height = SIZE.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  const wait = (event: 'loadeddata' | 'seeked') => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('timeout')), 4000);
    const done = (error?: Error) => { clearTimeout(timer); video.removeEventListener(event, ok); video.removeEventListener('error', fail); error ? reject(error) : resolve(); };
    const ok = () => done(), fail = () => done(new Error('unreadable'));
    video.addEventListener(event, ok, { once: true }); video.addEventListener('error', fail, { once: true });
  });
  try {
    const loaded = wait('loadeddata'); video.src = src; await loaded;
    const times: number[] = [], distances: number[] = [];
    let previous: Float32Array | null = null;
    for (let time = 0; time < duration - .05; time = Math.round((time + CUT_STEP) * 100) / 100) {
      signal?.throwIfAborted();
      const seeked = wait('seeked'); video.currentTime = time; await seeked;
      context.drawImage(video, 0, 0, SIZE.width, SIZE.height);
      const histogram = colourHistogram(context.getImageData(0, 0, SIZE.width, SIZE.height).data);
      times.push(time); distances.push(previous ? histogramDistance(previous, histogram) : 0); previous = histogram;
    }
    return findCuts(times, distances);
  } catch { return []; }
  finally { video.removeAttribute('src'); video.load(); }
}
