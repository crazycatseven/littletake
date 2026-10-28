import type { Shot } from '../types';
import type { ShotRenderer } from './renderer';

export const videoExportIssue = (): string | null => !window.isSecureContext
  ? 'Video export needs HTTPS or localhost. Open this editor on localhost, or use an HTTPS address.'
  : !('VideoEncoder' in window) ? 'This browser does not support video encoding. Use a current Chrome or Edge browser.' : null;

export async function exportPNG(renderer: ShotRenderer, time: number): Promise<Blob> {
  const canvas = renderer.render(time);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The image could not be encoded.')), 'image/png'));
}

/** Encode scene time deterministically; encoder speed does not change the exported motion. */
export async function exportVideo(renderer: ShotRenderer, shot: Shot, fps: number, signal: AbortSignal, progress: (done: number, total: number) => void): Promise<Blob> {
  const issue = videoExportIssue(); if (issue) throw new Error(issue);
  const {Output, WebMOutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH, getFirstEncodableVideoCodec} = await import('mediabunny');
  signal.throwIfAborted();
  const canvas = renderer.canvas;
  const codec = await getFirstEncodableVideoCodec(['vp9', 'vp8'], {width: canvas.width, height: canvas.height, frameRate: fps, quality: QUALITY_HIGH});
  if (!codec) throw new Error('This browser cannot encode WebM at this resolution. Try 720p or another browser.');
  const target = new BufferTarget(), output = new Output({format: new WebMOutputFormat(), target});
  const source = new CanvasSource(canvas, {codec, quality: QUALITY_HIGH, keyFrameInterval: 2});
  output.addVideoTrack(source, {frameRate: fps});
  try {
    signal.throwIfAborted();
    await output.start();
    const frames = Math.ceil(shot.duration * fps - 1e-8);
    for (let frame = 0; frame < frames; frame++) {
      signal.throwIfAborted();
      const timestamp = frame / fps, duration = Math.min(1 / fps, shot.duration - timestamp);
      renderer.render(shot.start + timestamp);
      await source.add(timestamp, duration);
      progress(frame + 1, frames);
      // Give the UI time to paint progress and accept Cancel, even with a fast encoder.
      if (frame % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    source.close(); await output.finalize(); signal.throwIfAborted();
    if (!target.buffer) throw new Error('The video file could not be finalized.');
    return new Blob([target.buffer], {type: 'video/webm'});
  } catch (error) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
    throw error;
  } finally { source.close(); }
}
