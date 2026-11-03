import { worldTransform } from '../placement/hierarchy';
import { evaluateFov, evaluateJointAngles } from '../model';
import type { SceneDocument, SceneObject, Shot, Transform } from '../types';
import { framedObjects } from './subjects';
import { zipFiles } from './zip';
import { videoManifestSchema, videoPrompt } from './handoff';
import type { StoryboardFrame, StoryboardPage } from './storyboard';
import { appearanceFile, appearanceInstructions, type AppearanceImage } from '../appearance/model';

export interface VideoBrief { prompt: string; camera: string; beats: { at: number; action: string }[]; negative: string; model: string; promptText?: string }
/** A frame sent to the brief writer; `at` is seconds from the start of the shot. */
export type BriefFrame = { at: number; image: string; kind: 'look' | 'previs' } | { at: number; image: string; kind: 'storyboard'; tiles: StoryboardPage['frames'] };

const round = (value: number) => Math.round(value * 100) / 100;
const rounded = (values: number[]) => values.map(round);

/** When and where an object moves inside the shot, sampled at 10 Hz; null when it holds still. */
function motionInShot(doc:SceneDocument,object: SceneObject, shot: Shot) {
  const steps = Math.max(2, Math.ceil(shot.duration * 10));
  const poses = Array.from({ length: steps + 1 }, (_, index) => worldTransform(doc,object.id,shot.start + shot.duration * index / steps));
  const changed = (a: Transform, b: Transform) => Math.hypot(...a.position.map((value, axis) => value - b.position[axis])) > .01 || a.rotation.some((value, axis) => Math.abs(value - b.rotation[axis]) > .5);
  let first = -1, last = -1;
  for (let index = 1; index <= steps; index++) if (changed(poses[index], poses[index - 1])) { if (first < 0) first = index - 1; last = index; }
  return first < 0 ? null : { start: round(shot.duration * first / steps), end: round(shot.duration * last / steps), from: rounded(poses[first].position), to: rounded(poses[last].position) };
}

export function briefInput(doc: SceneDocument, shot: Shot, direction: string, frames: BriefFrame[], appearance: AppearanceImage[] = []) {
  const camera = doc.cameras.find(item => item.id === shot.cameraId)!, end = shot.start + shot.duration;
  const times = Array.from({length: 9}, (_, index) => shot.start + shot.duration * index / 8);
  const cameraPose = (time: number) => { const pose = worldTransform(doc,camera.id,time); return { position: rounded(pose.position), rotation: rounded(pose.rotation) }; };
  // Include subjects that only enter briefly; frame-relative sides and world poses are distinct.
  const seen = new Map<string, ReturnType<typeof framedObjects>[number]>();
  for (const time of times) for (const item of framedObjects(doc, shot.cameraId, time)) if (!seen.has(item.object.id) && worldTransform(doc,item.object.id,time).scale.some(value => Math.abs(value) > 1e-5)) seen.set(item.object.id, item);
  return {
    shot: { name: shot.name.trim().slice(0, 80) || 'Shot', duration: round(shot.duration), fps: doc.fps ?? 24 },
    direction: direction.trim().slice(0, 600),
    camera: { fov: round(evaluateFov(camera, shot.start)), start: cameraPose(shot.start), end: cameraPose(end), samples: times.map(time => ({ at: round(time-shot.start), ...cameraPose(time), fov: round(evaluateFov(camera,time)) })) },
    subjects: [...seen.values()].slice(0, 40).map(({ object, position, depth }) => ({ id: object.id, name: object.name.trim().slice(0, 80), kind: object.asset ? 'asset' : object.kind, position, depth, motion: motionInShot(doc,object, shot),
      samples: times.map(time => { const pose = worldTransform(doc,object.id,time); return { at: round(time-shot.start), position: rounded(pose.position), rotation: rounded(pose.rotation), scale: rounded(pose.scale), joints: Object.fromEntries(Object.entries(evaluateJointAngles(object,time)).slice(0,64).map(([key,value])=>[key,round(value)])) }; }) })),
    frames, appearance,
  };
}

export function briefMarkdown(shot: Shot, brief: VideoBrief, direction: string): string {
  return [`# ${shot.name} · video brief`, '', '## Prompt for Muse', '', videoPrompt(shot, brief, direction), '',
    `Prepared in LittleTake · ${brief.model}. Attach first-frame, storyboard pages in order, the object images listed in appearance-references.md when present, and any optional style images. Source stills are included separately.`, ''].join('\n');
}

const bytesOf = (dataURL: string) => Uint8Array.from(atob(dataURL.slice(dataURL.indexOf(',') + 1)), char => char.charCodeAt(0));
const extensionOf = (dataURL: string) => ({ 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' } as Record<string, string>)[dataURL.slice(5, dataURL.indexOf(';'))] ?? 'bin';

/** One folder per shot: first frame, chronological storyboards, original stills, exact prompt and timing manifest. */
export async function videoPackage(doc: SceneDocument, shot: Shot, brief: VideoBrief, direction: string, frames: StoryboardFrame[], storyboards: StoryboardPage[] = [], references: { image: string; role: 'style' | 'character' | 'scene'; label: string }[] = [], appearance: AppearanceImage[] = []): Promise<Blob> {
  const folder = (shot.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'shot') + '-video-package';
  const files: { name: string; data: Uint8Array }[] = [], listed: { file: string; at: number; kind: 'look' | 'previs' }[] = [];
  frames.forEach((frame, index) => {
    const label = `${String(index + 1).padStart(2, '0')}-${frame.at.toFixed(2)}s`;
    for (const [kind, image] of [['look', frame.look], ['previs', frame.previs]] as const) if (image) {
      const file = `${index === 0 && kind === 'previs' ? 'first-frame' : `${kind}-${label}`}.${extensionOf(image)}`; files.push({ name: `${folder}/${file}`, data: bytesOf(image) }); listed.push({ file, at: frame.at, kind });
    }
  });
  const referenceFiles = [...references.map((reference, index) => {
    const file = `reference-${index + 1}.${extensionOf(reference.image)}`;
    files.push({ name: `${folder}/${file}`, data: bytesOf(reference.image) });
    return { file, role: reference.role, label: reference.label };
  }), ...appearance.map(reference => {
    const file = appearanceFile(reference);
    files.push({ name: `${folder}/${file}`, data: bytesOf(reference.image) });
    return { file, role: 'appearance' as const, label: reference.bindings.map(binding => binding.objectName).join(', ').slice(0, 160), bindings: reference.bindings };
  })];
  if (appearance.length) files.push({ name: `${folder}/appearance-references.md`, data: new TextEncoder().encode(appearanceInstructions(appearance)) });
  const pages = storyboards.map((page, index) => {
    const file = `storyboard-${String(index + 1).padStart(2, '0')}.${extensionOf(page.image)}`;
    files.push({ name: `${folder}/${file}`, data: bytesOf(page.image) });
    return { file, frames: page.frames };
  });
  const manifest = videoManifestSchema.parse({
    format: 'LittleTake.videoPackage', version: 1, scene: doc.name, sceneId: doc.id, direction: brief.promptText === undefined ? direction : '',
    shot: { id: shot.id, name: shot.name, sceneStart: shot.start, duration: shot.duration, fps: doc.fps ?? 24 },
    // Once edited as a complete prompt, don't publish older structured instructions alongside it.
    brief: { ...(brief.promptText === undefined ? { prompt: brief.prompt, camera: brief.camera, beats: brief.beats, negative: brief.negative }
      : { prompt: brief.promptText, camera: '', beats: [], negative: '' }), promptText: videoPrompt(shot, brief, direction) },
    frames: listed, firstFrame: listed.find(frame => frame.kind === 'previs')?.file, storyboards: pages, references: referenceFiles, previs: null,
    models: { brief: brief.model, look: listed.some(item => item.kind === 'look') ? 'muse-image-1.0' : null },
    usage: 'Copy the exact full prompt from brief.md. Attach first-frame and every storyboard page in numeric order, plus the appearance reference images listed in appearance-references.md if present. Their bindings identify which subject each image depicts, and which image is primary. Read storyboards left to right, then top to bottom; tile numbers and shot-relative seconds specify chronology. Source stills are also available if more detail is needed. Optional style images guide the overall look. Do not send a video as input or reproduce the grid, labels or a slideshow.',
  });
  files.unshift({ name: `${folder}/brief.md`, data: new TextEncoder().encode(briefMarkdown(shot, brief, direction)) }, { name: `${folder}/manifest.json`, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  return new Blob([zipFiles(files) as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}
