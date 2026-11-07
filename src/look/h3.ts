import * as THREE from 'three';
import { worldTransform, effectivelyHidden } from '../placement/hierarchy';
import { evaluateFov } from '../model';
import { effectObjectIds } from '../components/model';
import type { AssetDefinition } from '../assets/model';
import type { SceneDocument, SceneObject, Shot } from '../types';

/** Measured framing of one shot, written into the video prompt so the model is told what the previs shows rather than an LLM's guess. */
export interface ShotFacts {
  duration: number;
  /** Shot size from the main subject's height in the frame: extreme wide to close-up. */
  size: string;
  angle: 'low angle' | 'eye level' | 'high angle';
  overShoulder: { near: string; far: string } | null;
  /** label is how the prompt names the subject: the asset name ("Muse Knight") when the instance name alone ("Muse") would not say what it is. */
  subjects: { name: string; label: string; side: 'left' | 'center' | 'right'; depth: 'foreground' | 'midground' | 'background'; frameHeight: number; facing: string }[];
  move: string;
  effects: { name: string; kind: string; from: number; to: number }[];
}

const round = (value: number, step = .1) => Math.round(value / step) * step;
const seconds = (value: number) => `${round(value).toFixed(1)} s`;

/** World-space height and vertical centre of an object, from its asset bounds or primitive size. */
function extent(object: SceneObject, scale: THREE.Vector3, position: THREE.Vector3, assets: AssetDefinition[]) {
  const bounds = object.asset ? assets.find(asset => asset.id === object.asset!.id)?.bounds : undefined;
  if (bounds) return { height: bounds.size[1] * Math.abs(scale.y), centre: position.y + (bounds.min[1] + bounds.max[1]) / 2 * scale.y };
  if (object.kind === 'human') return { height: 1.8 * Math.abs(scale.y), centre: position.y + .9 * scale.y };
  if (object.kind === 'plane') return { height: 0, centre: position.y };
  return { height: Math.abs(scale.y), centre: position.y };
}

function cameraAt(doc: SceneDocument, cameraId: string, time: number, aspect: number) {
  const source = doc.cameras.find(item => item.id === cameraId)!, pose = worldTransform(doc, source.id, time);
  const camera = new THREE.PerspectiveCamera(evaluateFov(source, time), aspect, .05, 2000);
  camera.position.fromArray(pose.position);
  camera.rotation.set(...pose.rotation.map(THREE.MathUtils.degToRad) as [number, number, number], 'XYZ');
  camera.updateMatrixWorld(true);
  return camera;
}

/** Performers and moving props seen by the shot camera at one time, largest in frame first. Static set dressing and effects are left out. */
function subjectsAt(doc: SceneDocument, shot: Shot, time: number, assets: AssetDefinition[], aspect: number) {
  const camera = cameraAt(doc, shot.cameraId, time, aspect), effects = effectObjectIds(doc), forward = camera.getWorldDirection(new THREE.Vector3());
  const found: (ShotFacts['subjects'][number] & { id: string; distance: number })[] = [];
  for (const object of doc.objects) {
    if (effects.has(object.id) || effectivelyHidden(doc, object.id) || !object.name.trim()) continue;
    const moving = Math.hypot(...worldTransform(doc, object.id, shot.start).position.map((value, axis) => value - worldTransform(doc, object.id, shot.start + shot.duration).position[axis])) > .3;
    if (object.kind !== 'human' && object.kind !== 'asset' && !moving) continue;
    const pose = worldTransform(doc, object.id, time), position = new THREE.Vector3(...pose.position), scale = new THREE.Vector3(...pose.scale);
    const { height, centre } = extent(object, scale, position, assets);
    if (height < .2) continue;
    const anchor = new THREE.Vector3(position.x, centre, position.z), depthAlong = anchor.clone().sub(camera.position).dot(forward);
    if (depthAlong <= .05) continue;
    // A near subject may show only a shoulder at the frame edge: test points from its base to its top, not just its centre.
    const seen = Array.from({ length: 7 }, (_, index) => new THREE.Vector3(position.x, centre + height * (index / 6 - .5), position.z).project(camera)).filter(point => point.z > -1 && point.z < 1 && Math.abs(point.x) <= 1.02 && Math.abs(point.y) <= 1.02);
    if (!seen.length) continue;
    const ndc = { x: seen.reduce((sum, point) => sum + point.x, 0) / seen.length };
    const frameHeight = height / (2 * depthAlong * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    // Assets face local +Z. Compare that direction with the camera's view to say where the subject looks on screen.
    const facingWorld = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...pose.rotation.map(THREE.MathUtils.degToRad) as [number, number, number], 'XYZ'));
    const toward = -facingWorld.dot(forward), sideways = facingWorld.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion));
    const facing = toward > .6 ? 'facing the camera' : toward < -.6 ? 'back to the camera' : sideways > 0 ? 'facing screen right' : 'facing screen left';
    const distance = camera.position.distanceTo(anchor);
    const assetName = object.asset ? assets.find(asset => asset.id === object.asset!.id)?.name?.trim() : undefined;
    found.push({ id: object.id, name: object.name.trim(), label: assetName && assetName !== object.name.trim() && !doc.objects.some(other => other !== object && other.asset?.id === object.asset!.id) ? assetName : object.name.trim(), side: ndc.x < -1 / 3 ? 'left' : ndc.x > 1 / 3 ? 'right' : 'center',
      depth: distance < 3.5 ? 'foreground' : distance < 12 ? 'midground' : 'background', frameHeight: round(frameHeight, .01), facing, distance });
  }
  return found.sort((a, b) => b.frameHeight - a.frameHeight).slice(0, 4);
}

function shotSize(frameHeight: number): string {
  return frameHeight >= 2.5 ? 'close-up' : frameHeight >= 1.3 ? 'medium shot' : frameHeight >= .7 ? 'full shot' : frameHeight >= .25 ? 'wide shot' : 'extreme wide shot';
}

function describeMove(doc: SceneDocument, shot: Shot, aspect: number, anchor?: (time: number) => THREE.Vector3): string {
  const a = cameraAt(doc, shot.cameraId, shot.start, aspect), b = cameraAt(doc, shot.cameraId, shot.start + shot.duration, aspect), duration = Math.max(shot.duration, .1);
  const pace = (rate: number, slow: number, fast: number) => rate < slow ? 'slowly' : rate > fast ? 'quickly' : 'steadily';
  const heading = (camera: THREE.PerspectiveCamera) => { const d = camera.getWorldDirection(new THREE.Vector3()); return { yaw: Math.atan2(d.x, d.z), pitch: Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)) }; };
  const wrap = (degrees: number) => ((degrees + 540) % 360) - 180;
  const pan = wrap(THREE.MathUtils.radToDeg(heading(b).yaw - heading(a).yaw)), tilt = THREE.MathUtils.radToDeg(heading(b).pitch - heading(a).pitch), zoom = b.fov - a.fov;
  // Measure travel against the starting view, flattened to the ground so a tilted camera does not mix height into it.
  const delta = b.position.clone().sub(a.position), ahead = new THREE.Vector3(Math.sin(heading(a).yaw), 0, Math.cos(heading(a).yaw)), right = new THREE.Vector3(-ahead.z, 0, ahead.x);
  const forward = delta.dot(ahead), lateral = delta.dot(right), vertical = delta.y, parts: string[] = [];
  // Circling: the distance to the subject stays similar while the bearing around it sweeps.
  let orbit = 0, closing = 1, span = [0, 0];
  if (anchor) {
    const samples = Array.from({ length: 9 }, (_, index) => { const time = shot.start + shot.duration * index / 8; return cameraAt(doc, shot.cameraId, time, aspect).position.clone().sub(anchor(time)); });
    const distances = samples.map(offset => Math.hypot(offset.x, offset.z)), bearings = samples.map(offset => THREE.MathUtils.radToDeg(Math.atan2(offset.x, offset.z)));
    const swept = bearings.slice(1).reduce((sum, bearing, index) => sum + wrap(bearing - bearings[index]), 0);
    if (Math.abs(swept) > 45 || (Math.abs(swept) > 25 && Math.max(...distances) < Math.min(...distances) * 1.5)) orbit = swept;
    closing = distances.at(-1)! / Math.max(distances[0], .01);
    span = [distances[0], distances.at(-1)!];
  }
  if (orbit) parts.push(`circles ${pace(Math.abs(orbit) / duration, 15, 60)} to its ${orbit > 0 ? 'right' : 'left'} around the subject, about ${Math.round(Math.abs(orbit) / 5) * 5} degrees${closing < .7 ? `, closing in from about ${Math.round(span[0])} m to ${Math.round(span[1])} m` : closing > 1.4 ? `, backing away from about ${Math.round(span[0])} m to ${Math.round(span[1])} m` : ''}`);
  else {
    if (Math.abs(forward) > .3 && Math.abs(forward) >= Math.abs(lateral)) parts.push(`${forward > 0 ? 'pushes in' : 'pulls back'} ${pace(Math.abs(forward) / duration, .3, 1.5)}, about ${round(Math.abs(forward)).toFixed(1)} m`);
    if (Math.abs(lateral) > .3 && Math.abs(lateral) > Math.abs(forward)) parts.push(`tracks ${lateral > 0 ? 'right' : 'left'} ${pace(Math.abs(lateral) / duration, .3, 1.5)}, about ${round(Math.abs(lateral)).toFixed(1)} m`);
    if (Math.abs(pan) > 5) parts.push(`pans ${pan > 0 ? 'left' : 'right'} ${pace(Math.abs(pan) / duration, 10, 45)}, about ${Math.round(Math.abs(pan) / 5) * 5} degrees`);
  }
  if (Math.abs(vertical) > .3) parts.push(`${vertical > 0 ? 'rises' : 'lowers'} about ${round(Math.abs(vertical)).toFixed(1)} m`);
  if (Math.abs(tilt) > 5) parts.push(`tilts ${tilt > 0 ? 'up' : 'down'} about ${Math.round(Math.abs(tilt) / 5) * 5} degrees`);
  if (Math.abs(zoom) > 2) parts.push(`zooms ${zoom < 0 ? 'in' : 'out'}`);
  if (!parts.length) return a.position.distanceTo(b.position) > .05 ? 'The camera drifts very slightly.' : 'The camera holds still.';
  const rest = parts.slice(1);
  return `The camera ${parts[0]}.${rest.length ? ` It also ${rest.length > 1 ? rest.slice(0, -1).join(', ') + ' and ' + rest.at(-1) : rest[0]}.` : ''}`;
}

/** Effects in the shot and when they are visible. Their shapes are left out of the depth pass, so the prompt must name them. */
function effectsIn(doc: SceneDocument, shot: Shot): ShotFacts['effects'] {
  const ids = effectObjectIds(doc), result: ShotFacts['effects'] = [], steps = Math.max(4, Math.ceil(shot.duration * 24));
  for (const object of doc.objects) {
    const effect = object.components?.find(component => component.type === 'effect' && component.enabled);
    if (!ids.has(object.id) || !effect || effect.type !== 'effect') continue;
    let from = -1, to = -1;
    for (let step = 0; step <= steps; step++) {
      const at = shot.duration * step / steps, pose = worldTransform(doc, object.id, shot.start + at);
      if (!effectivelyHidden(doc, object.id) && Math.min(...pose.scale.map(Math.abs)) > .05) { if (from < 0) from = at; to = at; }
    }
    if (from >= 0) result.push({ name: object.name.trim(), kind: effect.kind, from: round(from), to: round(to) });
  }
  return result;
}

export function shotFacts(doc: SceneDocument, shot: Shot, assets: AssetDefinition[] = [], aspect = 16 / 9): ShotFacts {
  const subjects = subjectsAt(doc, shot, shot.start + shot.duration / 2, assets, aspect);
  const near = subjects.find(subject => subject.depth === 'foreground' && subject.side !== 'center' && subject.facing === 'back to the camera');
  const far = near && subjects.find(subject => subject !== near && subject.distance > near.distance * 2);
  const main = far ?? subjects[0];
  const camera = cameraAt(doc, shot.cameraId, shot.start + shot.duration / 2, aspect);
  const target = main ? doc.objects.find(object => object.name.trim() === main.name) : undefined;
  let angle: ShotFacts['angle'] = 'eye level', anchor: ((time: number) => THREE.Vector3) | undefined;
  if (target) {
    const pose = worldTransform(doc, target.id, shot.start + shot.duration / 2), { centre } = extent(target, new THREE.Vector3(...pose.scale), new THREE.Vector3(...pose.position), assets);
    anchor = time => new THREE.Vector3(...worldTransform(doc, target.id, time).position);
    const elevation = THREE.MathUtils.radToDeg(Math.atan2(camera.position.y - centre, Math.hypot(camera.position.x - pose.position[0], camera.position.z - pose.position[2])));
    angle = elevation > 20 ? 'high angle' : elevation < -10 ? 'low angle' : 'eye level';
  }
  return {
    duration: shot.duration, size: main ? shotSize(main.frameHeight) : 'wide shot', angle,
    overShoulder: near && far ? { near: near.label, far: far.label } : null,
    subjects: subjects.map(({ id: _, distance: __, ...subject }) => subject),
    move: describeMove(doc, shot, aspect, anchor), effects: effectsIn(doc, shot),
  };
}

const article = (word: string) => /^[aeiou]/i.test(word) ? 'an' : 'a';

/** One shot in MiniMax H3's own prompt format: English, a single [Shot 1] block, no time ranges and no negative prompt
 * (H3's guider has no negative branch, so the prompt says what should appear). */
export function h3Prompt(facts: ShotFacts, brief: { prompt: string; beats: { at: number; action: string }[]; sound?: string }, direction = ''): string {
  const framing = facts.overShoulder
    ? `${article(facts.angle)} ${facts.angle} over-the-shoulder shot from behind ${facts.overShoulder.near}, looking at ${facts.overShoulder.far}`
    : `${article(facts.size)} ${facts.size} at ${facts.angle === 'eye level' ? 'eye level' : `a ${facts.angle}`}`;
  const sideWord = { left: 'on the left', center: 'in the centre', right: 'on the right' };
  const blocking = facts.subjects.slice(0, 3).map(subject => `${subject.label} is ${sideWord[subject.side]} ${subject.depth === 'midground' ? 'in the middle distance' : `in the ${subject.depth}`}, ${subject.facing}`);
  const beats = [...brief.beats].sort((a, b) => a.at - b.at).map(beat => `${beat.at <= .05 ? 'At the start' : `At ${seconds(beat.at)}`}, ${beat.action.replace(/^\s*./, c => c.toLowerCase()).replace(/\.\s*$/, '')}.`);
  const effectWords: Record<string, string> = { fire: 'Real fire', smoke: 'Real smoke', spark: 'Real sparks', magic: 'Glowing magical energy', liquid: 'Real liquid', light: 'Glowing light' };
  const effects = [...new Map(facts.effects.map(effect => [`${effect.kind} ${effect.from} ${effect.to}`, effect])).values()]
    .map(effect => `${effectWords[effect.kind] ?? effect.name} ${effect.from <= .05 ? 'is there from the start' : `appears at ${seconds(effect.from)}`}${effect.to >= facts.duration - .05 ? '' : ` and is gone by ${seconds(effect.to + .1)}`}.`);
  const lead = [direction.trim(), brief.prompt.trim()].filter(Boolean).join(' ');
  return [
    `integrated_multimodal_description: ${lead}`,
    `[Shot 1] ${framing[0].toUpperCase()}${framing.slice(1)}, one continuous ${round(facts.duration).toFixed(1)}-second take. ${blocking.length ? blocking.join('; ') + '. ' : ''}${facts.move} ${beats.join(' ')} ${effects.join(' ')}`.replace(/\s+/g, ' ').trim(),
    `overall_soundscape: ${brief.sound?.trim() || 'Natural sound that matches the setting and every action on screen.'}`,
    'non_diegetic_music: N/A',
  ].join('\n');
}
