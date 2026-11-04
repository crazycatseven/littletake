import type { Shot } from '../types';
import type { ShotRenderer } from './renderer';

export const videoExportIssue = (): string | null => !window.isSecureContext
  ? 'Video export needs HTTPS or localhost. Open this editor on localhost, or use an HTTPS address.'
  : !('VideoEncoder' in window) ? 'This browser does not support video encoding. Use a current Chrome or Edge browser.' : null;

export async function exportPNG(renderer: Pick<ShotRenderer, 'render'>, time: number): Promise<Blob> {
  const canvas = renderer.render(time);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The image could not be encoded.')), 'image/png'));
}

/** Encode scene time deterministically; encoder speed does not change the exported motion. */
export async function exportVideo(renderer: {canvas:HTMLCanvasElement;render(time:number):HTMLCanvasElement|Promise<HTMLCanvasElement>}, shot: Pick<Shot,'start'|'duration'>, fps: number, signal: AbortSignal, progress: (done: number, total: number) => void, bitrate?:number,format:'webm'|'mp4'='webm'): Promise<Blob> {
  const issue = videoExportIssue(); if (issue) throw new Error(issue);
  const {Output, WebMOutputFormat,Mp4OutputFormat, BufferTarget, CanvasSource, Quality, getFirstEncodableVideoCodec} = await import('mediabunny');
  signal.throwIfAborted();
  const canvas = renderer.canvas;
  const quality=bitrate?new Quality({bitrate:Math.round(bitrate)}):new Quality('high');
  const codec = await getFirstEncodableVideoCodec(format==='mp4'?['avc']:['vp9', 'vp8'], {width: canvas.width, height: canvas.height, frameRate: fps, quality});
  if (!codec) throw new Error('This browser cannot encode '+format.toUpperCase()+' at this resolution. Try another browser.');
  const target = new BufferTarget(), output = new Output({format: format==='mp4'?new Mp4OutputFormat():new WebMOutputFormat(), target});
  const source = new CanvasSource(canvas, {codec, quality, keyFrameInterval: 2});
  output.addVideoTrack(source, {frameRate: fps});
  try {
    signal.throwIfAborted();
    await output.start();
    const frames = Math.ceil(shot.duration * fps - 1e-8);
    for (let frame = 0; frame < frames; frame++) {
      signal.throwIfAborted();
      const timestamp = frame / fps, duration = Math.min(1 / fps, shot.duration - timestamp);
      await renderer.render(shot.start + timestamp);
      await source.add(timestamp, duration);
      progress(frame + 1, frames);
      // Give the UI time to paint progress and accept Cancel, even with a fast encoder.
      if (frame % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    source.close(); await output.finalize(); signal.throwIfAborted();
    if (!target.buffer) throw new Error('The video file could not be finalized.');
    return new Blob([target.buffer], {type: 'video/'+format});
  } catch (error) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
    throw error;
  } finally { source.close(); }
}
