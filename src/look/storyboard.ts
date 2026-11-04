import type { Shot } from '../types.ts';

export const STORYBOARD_INTERVAL = .5;
export const STORYBOARD_PAGE_SIZE = 9;
export const STORYBOARD_MAX_PAGES = 14; // A 60-second shot has at most 121 half-second samples, including its last frame.
export const BRIEF_LIMITS = { maxImageBytes: 900_000, maxImages: STORYBOARD_MAX_PAGES + 3, maxBodyBytes: 35_000_000 } as const;
export interface StoryboardFrame { at: number; previs: string; look?: string; note?: string }
export interface StoryboardPage { image: string; frames: { index: number; at: number }[] }

/** Older saves only kept pixels. Ignore negligible raster/JPEG noise, never a visible scene change. */
export function matchingStoryboardPixels(a: { width: number; height: number; data: ArrayLike<number> }, b: { width: number; height: number; data: ArrayLike<number> }): boolean {
  if (a.width !== b.width || a.height !== b.height || !a.data.length) return false;
  let difference = 0;
  for (let i = 0; i < a.data.length; i += 4) for (let channel = 0; channel < 3; channel++) {
    const delta = Math.abs(a.data[i + channel] - b.data[i + channel]);
    if (delta > 4) return false;
    difference += delta;
  }
  return difference / (a.width * a.height * 3) <= .005;
}

export async function matchingLegacyStoryboardSource(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const pixels = async (source: string) => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true })!; context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  };
  return matchingStoryboardPixels(await pixels(a), await pixels(b));
}

/** Muse can put a divider a few pixels off-center. Use a clear seam near the center, otherwise bisect. */
export function storyboardGridCuts(image: { data: ArrayLike<number>; width: number; height: number }): { x: number; y: number } {
  const cut = (horizontal: boolean) => {
    const length = horizontal ? image.height : image.width, across = horizontal ? image.width : image.height;
    const middle = Math.floor(length / 2), scores: { at: number; value: number }[] = [];
    for (let at = Math.max(1, Math.floor(length * .46)); at <= Math.min(length - 1, Math.ceil(length * .54)); at++) {
      let value = 0, samples = 0;
      for (let other = 0; other < across; other += 2) {
        const before = (horizontal ? (at - 1) * image.width + other : other * image.width + at - 1) * 4;
        const after = (horizontal ? at * image.width + other : other * image.width + at) * 4;
        for (let channel = 0; channel < 3; channel++) value += Math.abs(image.data[before + channel] - image.data[after + channel]);
        samples += 3;
      }
      scores.push({ at, value: value / samples });
    }
    scores.sort((a, b) => b.value - a.value || Math.abs(a.at - middle) - Math.abs(b.at - middle));
    return scores[0].value > Math.max(12, scores[Math.floor(scores.length / 2)].value * 4) ? scores[0].at : middle;
  };
  return { x: cut(false), y: cut(true) };
}

/** Native-resolution crops for the first-frame/individual-image export; never upscale or call AI. */
export async function splitStoryboardImage(source: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const image = new Image(); image.src = source; await image.decode(); signal.throwIfAborted();
  if (image.naturalWidth < 2 || image.naturalHeight < 2) throw new Error('The storyboard image is too small to split.');
  const sourceCanvas = document.createElement('canvas'); sourceCanvas.width = image.naturalWidth; sourceCanvas.height = image.naturalHeight;
  const context = sourceCanvas.getContext('2d', { willReadFrequently: true })!; context.drawImage(image, 0, 0);
  const cuts = storyboardGridCuts(context.getImageData(0, 0, image.naturalWidth, image.naturalHeight));
  const xs = [0, cuts.x, image.naturalWidth], ys = [0, cuts.y, image.naturalHeight];
  const frames: string[] = [];
  for (let i = 0; i < 4; i++) {
    const column = i % 2, row = Math.floor(i / 2), x = xs[column], y = ys[row];
    const canvas = document.createElement('canvas');
    canvas.width = xs[column + 1] - x; canvas.height = ys[row + 1] - y;
    canvas.getContext('2d')!.drawImage(image, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL('image/png'));
  }
  signal.throwIfAborted();
  return frames;
}

/** Blob downloads also work in embedded browsers that ignore data-URL download links. */
export function downloadStoryboardImage(image: string, filename: string) {
  const comma = image.indexOf(','), type = image.slice(5, image.indexOf(';'));
  const bytes = Uint8Array.from(atob(image.slice(comma + 1)), character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type })), link = document.createElement('a');
  link.href = url; link.download = filename; link.hidden = true; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** All times stay inside this shot, including fractional durations and shots starting after scene time zero. */
export function storyboardTimes(shot: Pick<Shot, 'start' | 'duration'>, fps: number): number[] {
  const last = Math.max(0, (Math.ceil(shot.duration * fps - 1e-7) - 1) / fps);
  const times: number[] = [];
  for (let at = 0; at < last - 1e-7; at += STORYBOARD_INTERVAL) times.push(shot.start + at);
  times.push(shot.start + last);
  return times;
}

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!));

/** Self-contained layout shared by the downloaded sheet and the image sent to the prompt writer. */
export function storyboardSVG(shot: Pick<Shot, 'name' | 'duration'>, frames: StoryboardFrame[], page: number, style: 'proxy' | 'ai' = 'proxy'): string {
  const start = page * STORYBOARD_PAGE_SIZE, tiles = frames.slice(start, start + STORYBOARD_PAGE_SIZE);
  if (!tiles.length) throw new Error('This storyboard page has no frames.');
  const columns = style === 'ai' && tiles.length <= 4 ? Math.min(2, tiles.length) : 3;
  const width = 1984, tileWidth = (width - 16 * (columns + 1)) / columns, tileHeight = Math.round(tileWidth * 9 / 16);
  const rowHeight = tileHeight + 48, height = 52 + Math.ceil(tiles.length / columns) * rowHeight;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#161719"/>
    <g font-family="Arial, sans-serif" fill="#eee9d7">
    <text x="16" y="33" font-size="26">${escape(shot.name.slice(0, 70))} · ${shot.duration.toFixed(2)} s</text>
    <text x="1968" y="33" font-size="22" text-anchor="end">Storyboard ${page + 1} / ${Math.ceil(frames.length / STORYBOARD_PAGE_SIZE)}</text>
    ${tiles.map((frame, index) => {
      const x = 16 + index % columns * (tileWidth + 16), y = 52 + Math.floor(index / columns) * rowHeight;
      return `<rect x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight + 32}" fill="#28292c"/>
        <image x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight}" preserveAspectRatio="xMidYMid meet" xlink:href="${escape(style === 'ai' ? frame.look ?? frame.previs : frame.previs)}"/>
        <text x="${x + 12}" y="${y + tileHeight + 23}" font-size="21">${String(start + index + 1).padStart(2, '0')} · ${frame.at.toFixed(2)} s</text>`;
    }).join('')}
    </g></svg>`;
}

/** Keep complete pages legible while respecting the prompt endpoint's per-image budget. */
export function referenceJPEG(source: CanvasImageSource, width: number, height: number, maxWidth = 1984): string {
  const canvas = document.createElement('canvas'), scale = Math.min(1, maxWidth / width);
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  for (const quality of [.88, .75, .6, .45]) {
    const image = canvas.toDataURL('image/jpeg', quality);
    if ((image.length - image.indexOf(',') - 1) * 3 / 4 <= BRIEF_LIMITS.maxImageBytes) return image;
  }
  throw new Error('A storyboard image is too large. Try a shorter shot.');
}

export async function renderStoryboards(shot: Pick<Shot, 'name' | 'duration'>, frames: StoryboardFrame[], signal: AbortSignal, style: 'proxy' | 'ai' = 'proxy'): Promise<StoryboardPage[]> {
  if (style === 'ai' && frames.some(frame => !frame.look)) throw new Error('Generate every selected panel before exporting the AI storyboard.');
  const pages: StoryboardPage[] = [];
  for (let start = 0; start < frames.length; start += STORYBOARD_PAGE_SIZE) {
    signal.throwIfAborted();
    const url = URL.createObjectURL(new Blob([storyboardSVG(shot, frames, pages.length, style)], { type: 'image/svg+xml' }));
    try {
      const image = new Image(); image.src = url; await image.decode(); signal.throwIfAborted();
      pages.push({ image: referenceJPEG(image, image.naturalWidth, image.naturalHeight), frames: frames.slice(start, start + STORYBOARD_PAGE_SIZE).map((frame, index) => ({ index: start + index + 1, at: frame.at })) });
    } finally { URL.revokeObjectURL(url); }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return pages;
}
