import './tracks.css';
import type { ReferenceTrack } from './types';

const COLORS = ['#e8a33d', '#5fa8d3', '#c86b98', '#7fb069', '#d9644a', '#9b8ae6', '#4fb3a9', '#d4c24a'];

/** Reads SAM tracks from an untrusted response; anything malformed is dropped rather than rendered. */
export function readTracks(value: unknown): ReferenceTrack[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tracks = value.slice(0, 8).flatMap((item): ReferenceTrack[] => {
    if (!item || typeof item.label !== 'string' || !Array.isArray(item.boxes)) return [];
    const boxes = item.boxes.slice(0, 600).filter((box: unknown): box is ReferenceTrack['boxes'][number] => Array.isArray(box) && box.length === 5 && box.every(part => typeof part === 'number' && Number.isFinite(part)));
    return boxes.length ? [{ label: item.label.slice(0, 80), ...(typeof item.objectId === 'string' ? { objectId: item.objectId } : {}), boxes }] : [];
  });
  return tracks.length ? tracks : undefined;
}

/** Draws the tracked boxes over the reference player, aligned to the letterboxed video, at its current time. */
export function attachTrackOverlay(video: HTMLVideoElement, tracks: ReferenceTrack[]): () => void {
  const canvas = document.createElement('canvas'); canvas.className = 'reference-track-overlay'; canvas.setAttribute('aria-hidden', 'true');
  video.insertAdjacentElement('afterend', canvas);
  const context = canvas.getContext('2d')!;
  let frame = 0;
  const draw = () => {
    const width = video.clientWidth, height = video.clientHeight, ratio = devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    if (!video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(width / video.videoWidth, height / video.videoHeight), shownWidth = video.videoWidth * scale, shownHeight = video.videoHeight * scale;
    const left = (width - shownWidth) / 2, top = (height - shownHeight) / 2, time = video.currentTime;
    context.font = '600 11px system-ui, sans-serif'; context.lineWidth = 2;
    tracks.forEach((track, index) => {
      let nearest: ReferenceTrack['boxes'][number] | null = null;
      for (const box of track.boxes) if (Math.abs(box[0] - time) <= .15 && (!nearest || Math.abs(box[0] - time) < Math.abs(nearest[0] - time))) nearest = box;
      if (!nearest) return;
      const [, x, y, w, h] = nearest, color = COLORS[index % COLORS.length];
      const boxLeft = left + x * shownWidth, boxTop = top + y * shownHeight;
      context.strokeStyle = color; context.strokeRect(boxLeft, boxTop, w * shownWidth, h * shownHeight);
      const label = track.label, labelWidth = context.measureText(label).width + 10;
      context.fillStyle = color; context.fillRect(boxLeft - 1, Math.max(0, boxTop - 18), labelWidth, 18);
      context.fillStyle = '#1d211c'; context.fillText(label, boxLeft + 4, Math.max(13, boxTop - 5));
    });
  };
  const loop = () => { draw(); frame = video.paused || video.ended ? 0 : requestAnimationFrame(loop); };
  const start = () => { cancelAnimationFrame(frame); loop(); };
  const events = ['play', 'seeked', 'timeupdate', 'loadeddata'] as const;
  events.forEach(name => video.addEventListener(name, start));
  const resize = new ResizeObserver(draw); resize.observe(video);
  draw();
  return () => { cancelAnimationFrame(frame); events.forEach(name => video.removeEventListener(name, start)); resize.disconnect(); canvas.remove(); };
}
