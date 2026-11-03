import type { Shot } from '../types.ts';

export const STORYBOARD_INTERVAL = .5;
export const STORYBOARD_PAGE_SIZE = 9;
export const STORYBOARD_MAX_PAGES = 14; // A 60-second shot has at most 121 half-second samples, including its last frame.
export const BRIEF_LIMITS = { maxImageBytes: 900_000, maxImages: STORYBOARD_MAX_PAGES + 3, maxBodyBytes: 22_000_000 } as const;
export interface StoryboardFrame { at: number; previs: string; look?: string }
export interface StoryboardPage { image: string; frames: { index: number; at: number }[] }

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
export function storyboardSVG(shot: Pick<Shot, 'name' | 'duration'>, frames: StoryboardFrame[], page: number): string {
  const start = page * STORYBOARD_PAGE_SIZE, tiles = frames.slice(start, start + STORYBOARD_PAGE_SIZE);
  if (!tiles.length) throw new Error('This storyboard page has no frames.');
  const width = 1984, height = 1276;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#161719"/>
    <g font-family="Arial, sans-serif" fill="#eee9d7">
    <text x="16" y="33" font-size="26">${escape(shot.name.slice(0, 70))} · ${shot.duration.toFixed(2)} s</text>
    <text x="1968" y="33" font-size="22" text-anchor="end">Storyboard ${page + 1} / ${Math.ceil(frames.length / STORYBOARD_PAGE_SIZE)}</text>
    ${tiles.map((frame, index) => {
      const x = 16 + index % 3 * 656, y = 52 + Math.floor(index / 3) * 408;
      return `<rect x="${x}" y="${y}" width="640" height="392" fill="#28292c"/>
        <image x="${x}" y="${y}" width="640" height="360" preserveAspectRatio="xMidYMid meet" xlink:href="${escape(frame.previs)}"/>
        <text x="${x + 12}" y="${y + 383}" font-size="21">${String(start + index + 1).padStart(2, '0')} · ${frame.at.toFixed(2)} s</text>`;
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

export async function renderStoryboards(shot: Pick<Shot, 'name' | 'duration'>, frames: StoryboardFrame[], signal: AbortSignal): Promise<StoryboardPage[]> {
  const pages: StoryboardPage[] = [];
  for (let start = 0; start < frames.length; start += STORYBOARD_PAGE_SIZE) {
    signal.throwIfAborted();
    const url = URL.createObjectURL(new Blob([storyboardSVG(shot, frames, pages.length)], { type: 'image/svg+xml' }));
    try {
      const image = new Image(); image.src = url; await image.decode(); signal.throwIfAborted();
      pages.push({ image: referenceJPEG(image, image.naturalWidth, image.naturalHeight), frames: frames.slice(start, start + STORYBOARD_PAGE_SIZE).map((frame, index) => ({ index: start + index + 1, at: frame.at })) });
    } finally { URL.revokeObjectURL(url); }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return pages;
}
