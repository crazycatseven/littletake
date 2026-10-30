import { evaluateFov, evaluateTransform } from '../model';
import type { SceneDocument, SceneObject, Shot, Transform } from '../types';
import { framedObjects } from './subjects';
import { zipFiles } from './zip';

export interface VideoBrief { prompt: string; camera: string; beats: { at: number; action: string }[]; negative: string; model: string }
/** A frame sent to the brief writer; `at` is seconds from the start of the shot. */
export interface BriefFrame { at: number; image: string; kind: 'look' | 'previs' }

const round = (value: number) => Math.round(value * 100) / 100;
const rounded = (values: number[]) => values.map(round);

/** When and where an object moves inside the shot, sampled at 10 Hz; null when it holds still. */
function motionInShot(object: SceneObject, shot: Shot) {
  const steps = Math.max(2, Math.ceil(shot.duration * 10));
  const poses = Array.from({ length: steps + 1 }, (_, index) => evaluateTransform(object, shot.start + shot.duration * index / steps));
  const changed = (a: Transform, b: Transform) => Math.hypot(...a.position.map((value, axis) => value - b.position[axis])) > .01 || a.rotation.some((value, axis) => Math.abs(value - b.rotation[axis]) > .5);
  let first = -1, last = -1;
  for (let index = 1; index <= steps; index++) if (changed(poses[index], poses[index - 1])) { if (first < 0) first = index - 1; last = index; }
  return first < 0 ? null : { start: round(shot.duration * first / steps), end: round(shot.duration * last / steps), from: rounded(poses[first].position), to: rounded(poses[last].position) };
}

export function briefInput(doc: SceneDocument, shot: Shot, direction: string, frames: BriefFrame[]) {
  const camera = doc.cameras.find(item => item.id === shot.cameraId)!, end = shot.start + shot.duration;
  const cameraPose = (time: number) => { const pose = evaluateTransform(camera, time); return { position: rounded(pose.position), rotation: rounded(pose.rotation) }; };
  // Anyone framed at the start, middle or end of the shot counts; the first sighting gives screen side and depth.
  const seen = new Map<string, ReturnType<typeof framedObjects>[number]>();
  for (const time of [shot.start, shot.start + shot.duration / 2, end]) for (const item of framedObjects(doc, shot.cameraId, time)) if (!seen.has(item.object.id)) seen.set(item.object.id, item);
  return {
    shot: { name: shot.name.trim().slice(0, 80) || 'Shot', duration: round(shot.duration), fps: doc.fps ?? 24 },
    direction: direction.trim().slice(0, 600),
    camera: { fov: round(evaluateFov(camera, shot.start)), start: cameraPose(shot.start), end: cameraPose(end) },
    subjects: [...seen.values()].slice(0, 40).map(({ object, position, depth }) => ({ name: object.name.trim().slice(0, 80), kind: object.asset ? 'asset' : object.kind, position, depth, motion: motionInShot(object, shot) })),
    frames,
  };
}

export function briefMarkdown(shot: Shot, brief: VideoBrief, direction: string): string {
  return [`# ${shot.name} · video brief`, '', '## Prompt', '', brief.prompt, '', '## Camera', '', brief.camera, '',
    '## Beats', '', ...(brief.beats.length ? brief.beats.map(beat => `- ${beat.at.toFixed(2)} s: ${beat.action}`) : ['- (none)']), '',
    '## Avoid', '', brief.negative || '(nothing specific)', '', '## Look', '', direction || '(none)', '',
    `Written by Meta Muse Spark (${brief.model}) from LittleTake previs; look frames by Meta Muse Image.`, ''].join('\n');
}

const bytesOf = (dataURL: string) => Uint8Array.from(atob(dataURL.slice(dataURL.indexOf(',') + 1)), char => char.charCodeAt(0));
const extensionOf = (dataURL: string) => ({ 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' } as Record<string, string>)[dataURL.slice(5, dataURL.indexOf(';'))] ?? 'bin';

/** One folder per shot: brief, manifest, look and previs stills, and the previs animation when the browser can encode it. */
export async function videoPackage(doc: SceneDocument, shot: Shot, brief: VideoBrief, direction: string, frames: { at: number; look?: string; previs: string }[], previs: Blob | null): Promise<Blob> {
  const folder = (shot.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'shot') + '-video-package';
  const files: { name: string; data: Uint8Array }[] = [], listed: { file: string; at: number; kind: 'look' | 'previs' }[] = [];
  frames.forEach((frame, index) => {
    const label = `${String(index + 1).padStart(2, '0')}-${frame.at.toFixed(2)}s`;
    for (const [kind, image] of [['look', frame.look], ['previs', frame.previs]] as const) if (image) {
      const file = `${kind}-${label}.${extensionOf(image)}`; files.push({ name: `${folder}/${file}`, data: bytesOf(image) }); listed.push({ file, at: frame.at, kind });
    }
  });
  if (previs) files.push({ name: `${folder}/previs.webm`, data: new Uint8Array(await previs.arrayBuffer()) });
  const manifest = {
    format: 'LittleTake.videoPackage', version: 1, scene: doc.name,
    shot: { name: shot.name, sceneStart: shot.start, duration: shot.duration, fps: doc.fps ?? 24 },
    brief: { prompt: brief.prompt, camera: brief.camera, beats: brief.beats, negative: brief.negative },
    frames: listed, previs: previs ? 'previs.webm' : null,
    models: { brief: brief.model, look: listed.some(item => item.kind === 'look') ? 'muse-image-1.0' : null },
    usage: 'Give the first look frame as the start image and the prompt as text to an image-to-video model. previs.webm shows the intended blocking and camera timing.',
  };
  files.unshift({ name: `${folder}/brief.md`, data: new TextEncoder().encode(briefMarkdown(shot, brief, direction)) }, { name: `${folder}/manifest.json`, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  return new Blob([zipFiles(files) as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}
