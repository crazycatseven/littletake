import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { PrimitiveKind, SceneDocument, SceneEntity, SceneObject, Transform, Vec3 } from './types';

const KINDS: readonly PrimitiveKind[] = ['cube', 'sphere', 'cylinder', 'cone', 'plane', 'human'];
const COLORS = ['#f0a06d', '#80aaa0', '#9b99c8', '#d9bb72', '#9fb9cf', '#b98e97'];
const MAX_JSON_LENGTH = 1_000_000;
const copyTransform = (t: Transform): Transform => ({ position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] });

export function createObject(kind: PrimitiveKind, index: number): SceneObject {
  if (!KINDS.includes(kind) || !Number.isSafeInteger(index) || index < 1) throw new Error('Invalid primitive or object index.');
  return {
    id: `object-${index}`, name: `${kind[0].toUpperCase()}${kind.slice(1)} ${index}`, kind,
    color: COLORS[(index - 1) % COLORS.length],
    transform: {
      position: [((index - 1) % 3 - 1) * 1.5, kind === 'human' ? 0 : kind === 'plane' ? 0.02 : 0.5, -Math.floor((index - 1) / 3) * 1.5],
      rotation: [0, 0, 0], scale: [1, 1, 1],
    },
    track: null,
  };
}

function facing(position: Vec3, target: Vec3): Vec3 {
  const matrix = new Matrix4().lookAt(new Vector3(...position), new Vector3(...target), new Vector3(0, 1, 0));
  const euler = new Euler().setFromRotationMatrix(matrix, 'XYZ');
  return [euler.x, euler.y, euler.z].map(MathUtils.radToDeg) as Vec3;
}

export function createDocument(): SceneDocument {
  const subject = createObject('human', 1);
  subject.name = 'Performer';
  subject.color = '#e4a16f';
  subject.transform.position = [-1.8, 0, 0];
  subject.track = {
    start: 0.5, duration: 3.5, from: copyTransform(subject.transform),
    to: { position: [0.5, 0, 0], rotation: [0, 35, 0], scale: [1, 1, 1] },
  };
  const plinth = createObject('cylinder', 2);
  plinth.name = 'Low plinth';
  plinth.color = '#83a9a2';
  plinth.transform = { position: [1.9, 0.3, -0.7], rotation: [0, 0, 0], scale: [1.6, 0.6, 1.6] };
  const sphere = createObject('sphere', 3);
  sphere.name = 'Sculpture';
  sphere.color = '#e5c77f';
  sphere.transform = { position: [1.9, 1.1, -0.7], rotation: [0, 0, 0], scale: [1, 1, 1] };
  const position: Vec3 = [6.5, 3.8, 8];
  const endPosition: Vec3 = [4.7, 2.8, 6.4];
  const transform: Transform = { position, rotation: facing(position, [0.3, 0.9, 0]), scale: [1, 1, 1] };
  return {
    format: 'LittleTake.scene', version: 1, name: 'A small entrance', duration: 5,
    objects: [subject, plinth, sphere],
    camera: {
      id: 'camera', name: 'Shot camera', fov: 44, transform,
      track: {
        start: 0, duration: 5, from: copyTransform(transform),
        to: { position: endPosition, rotation: facing(endPosition, [0.3, 0.9, 0]), scale: [1, 1, 1] },
      },
    },
  };
}

export function cloneDocument(doc: SceneDocument): SceneDocument {
  const entity = <T extends SceneEntity>(value: T): T => ({
    ...value, transform: copyTransform(value.transform),
    track: value.track ? { ...value.track, from: copyTransform(value.track.from), to: copyTransform(value.track.to) } : null,
  });
  return { ...doc, objects: doc.objects.map(entity), camera: entity(doc.camera) };
}

export function evaluateTransform(entity: SceneEntity, time: number): Transform {
  if (!Number.isFinite(time)) throw new Error('Playback time must be finite.');
  const track = entity.track;
  if (!track) return copyTransform(entity.transform);
  const alpha = MathUtils.clamp((time - track.start) / track.duration, 0, 1);
  if (alpha === 0) return copyTransform(track.from);
  if (alpha === 1) return copyTransform(track.to);
  const linear = (a: Vec3, b: Vec3): Vec3 => a.map((v, i) => MathUtils.lerp(v, b[i], alpha)) as Vec3;
  const quaternion = (rotation: Vec3) => new Quaternion().setFromEuler(new Euler(...rotation.map(MathUtils.degToRad) as Vec3, 'XYZ'));
  const rotation = new Euler().setFromQuaternion(quaternion(track.from.rotation).slerp(quaternion(track.to.rotation), alpha), 'XYZ');
  return {
    position: linear(track.from.position, track.to.position),
    rotation: [rotation.x, rotation.y, rotation.z].map(MathUtils.radToDeg) as Vec3,
    scale: linear(track.from.scale, track.to.scale),
  };
}

function fail(path: string, detail: string): never { throw new Error(`${path}: ${detail}`); }
function record(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'unsupported object prototype');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) fail(path, 'unexpected or missing fields');
  for (const key of keys) {
    if (!Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value')) fail(path, 'accessor fields are unsupported');
  }
  return value as Record<string, unknown>;
}
function number(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `expected a finite number from ${min} to ${max}`);
  return value;
}
function text(value: unknown, max: number, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(path, `expected nonempty text up to ${max} characters`);
  return value;
}
function list(value: unknown, max: number, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, `expected at most ${max} objects or values`);
  if (Object.getPrototypeOf(value) !== Array.prototype) fail(path, 'unsupported array prototype');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = descriptors[String(i)];
    if (!item || !Object.hasOwn(item, 'value')) fail(path, 'sparse arrays and accessors are unsupported');
    result.push(item.value);
  }
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) fail(path, 'unexpected array fields');
  return result;
}
function vector(value: unknown, min: number, max: number, path: string): Vec3 {
  const values = list(value, 3, path);
  if (values.length !== 3) fail(path, 'expected three numbers');
  return values.map((v, i) => number(v, min, max, `${path}[${i}]`)) as Vec3;
}
function transform(value: unknown, path: string): Transform {
  const t = record(value, ['position', 'rotation', 'scale'], path);
  return {
    position: vector(t.position, -1000, 1000, `${path}.position`),
    rotation: vector(t.rotation, -360000, 360000, `${path}.rotation`),
    scale: vector(t.scale, 0.01, 100, `${path}.scale`),
  };
}
function motion(value: unknown, duration: number, path: string): SceneEntity['track'] {
  if (value === null) return null;
  const t = record(value, ['start', 'duration', 'from', 'to'], path);
  const start = number(t.start, 0, duration, `${path}.start`);
  const length = number(t.duration, 0.1, duration, `${path}.duration`);
  if (start + length > duration + 1e-9) fail(path, 'motion must finish within the scene');
  return { start, duration: length, from: transform(t.from, `${path}.from`), to: transform(t.to, `${path}.to`) };
}

export function validateDocument(value: unknown): SceneDocument {
  const doc = record(value, ['format', 'version', 'name', 'duration', 'objects', 'camera'], 'scene');
  if (doc.format !== 'LittleTake.scene' || doc.version !== 1) fail('scene', 'unsupported format or version');
  const name = text(doc.name, 120, 'scene.name');
  const duration = number(doc.duration, 1, 60, 'scene.duration');
  const values = list(doc.objects, 100, 'scene.objects');
  const ids = new Set<string>(['camera']);
  const objects: SceneObject[] = values.map((value: unknown, i: number) => {
    const path = `scene.objects[${i}]`;
    const obj = record(value, ['id', 'name', 'kind', 'color', 'transform', 'track'], path);
    const id = text(obj.id, 64, `${path}.id`);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || ids.has(id)) fail(`${path}.id`, 'invalid or duplicate object ID');
    ids.add(id);
    if (!KINDS.includes(obj.kind as PrimitiveKind)) fail(`${path}.kind`, 'unsupported primitive');
    if (typeof obj.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(obj.color)) fail(`${path}.color`, 'expected a six-digit hex color');
    return {
      id, name: text(obj.name, 120, `${path}.name`), kind: obj.kind as PrimitiveKind, color: obj.color,
      transform: transform(obj.transform, `${path}.transform`), track: motion(obj.track, duration, `${path}.track`),
    };
  });
  const camera = record(doc.camera, ['id', 'name', 'fov', 'transform', 'track'], 'scene.camera');
  if (camera.id !== 'camera') fail('scene.camera.id', 'expected camera');
  return {
    format: 'LittleTake.scene', version: 1, name, duration, objects,
    camera: {
      id: 'camera', name: text(camera.name, 120, 'scene.camera.name'), fov: number(camera.fov, 10, 120, 'scene.camera.fov'),
      transform: transform(camera.transform, 'scene.camera.transform'), track: motion(camera.track, duration, 'scene.camera.track'),
    },
  };
}

export function serializeDocument(doc: SceneDocument): string { return JSON.stringify(validateDocument(doc), null, 2); }
export function parseDocument(json: string): SceneDocument {
  if (typeof json !== 'string' || json.length > MAX_JSON_LENGTH) fail('scene', 'file is too large (maximum 1 MB of text)');
  return validateDocument(JSON.parse(json));
}

export class History {
  private past: SceneDocument[] = [];
  private future: SceneDocument[] = [];
  constructor(initial: SceneDocument) { this.reset(initial); }
  get canUndo(): boolean { return this.past.length > 1; }
  get canRedo(): boolean { return this.future.length > 0; }
  commit(doc: SceneDocument): void {
    this.future = [];
    if (JSON.stringify(this.past[this.past.length - 1]) === JSON.stringify(doc)) return;
    this.past.push(cloneDocument(doc));
    if (this.past.length > 100) this.past.shift();
  }
  undo(): SceneDocument | null {
    if (!this.canUndo) return null;
    this.future.push(this.past.pop()!);
    return cloneDocument(this.past[this.past.length - 1]);
  }
  redo(): SceneDocument | null {
    if (!this.canRedo) return null;
    const doc = this.future.pop()!;
    this.past.push(doc);
    return cloneDocument(doc);
  }
  reset(doc: SceneDocument): void { this.past = [cloneDocument(doc)]; this.future = []; }
}
