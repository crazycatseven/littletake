import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import { History, cloneDocument, createDocument, createObject, evaluateTransform, parseDocument, serializeDocument, validateDocument } from '../src/model';
import type { SceneDocument, Transform, Vec3 } from '../src/types';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} should equal ${expected}`);
const transform = (x: number, yRotation = 0, scale = 1): Transform => ({ position: [x, 0, 0], rotation: [0, yRotation, 0], scale: [scale, scale, scale] });
const rotationQuaternion = (degrees: Vec3) => new Quaternion().setFromEuler(new Euler(...degrees.map(MathUtils.degToRad) as Vec3, 'XYZ'));
function rejection(change: (doc: SceneDocument) => void, pattern?: RegExp) {
  const doc = createDocument();
  change(doc);
  if (pattern) assert.throws(() => validateDocument(doc), pattern);
  else assert.throws(() => validateDocument(doc));
}

test('the initial five-second scene is valid, deterministic, and its camera looks toward the set', () => {
  const doc = createDocument();
  assert.deepEqual(doc, createDocument());
  assert.deepEqual(validateDocument(doc), doc);
  assert.equal(doc.duration, 5);
  assert.ok(doc.objects.some(obj => obj.track));
  assert.ok(doc.shots[0].track);
  const forward = new Vector3(0, 0, -1).applyQuaternion(rotationQuaternion(doc.shots[0].transform.rotation));
  const target = new Vector3(0.3, 0.9, 0).sub(new Vector3(...doc.shots[0].transform.position)).normalize();
  close(forward.dot(target), 1);
  const end = doc.shots[0].track!.to;
  const endForward = new Vector3(0, 0, -1).applyQuaternion(rotationQuaternion(end.rotation));
  close(endForward.dot(new Vector3(0.3, 0.9, 0).sub(new Vector3(...end.position)).normalize()), 1);
});

test('primitive creation uses deterministic IDs, independent transforms and sensible ground placement', () => {
  const first = createObject('cube', 7);
  assert.equal(first.id, 'object-7');
  assert.equal(first.transform.position[1], 0.5);
  assert.equal(createObject('human', 1).transform.position[1], 0);
  assert.deepEqual(createObject('plane', 1).transform.rotation, [0, 0, 0]);
  first.transform.scale[0] = 8;
  assert.equal(createObject('cube', 7).transform.scale[0], 1);
  assert.throws(() => createObject('cube', 0));
});

test('tracks clamp at each endpoint and linearly interpolate position and scale', () => {
  const object = createObject('cube', 1);
  object.track = { start: 1, duration: 2, from: transform(2, 0, 1), to: transform(10, 0, 3) };
  assert.deepEqual(evaluateTransform(object, -5), object.track.from);
  assert.deepEqual(evaluateTransform(object, 1), object.track.from);
  assert.deepEqual(evaluateTransform(object, 3), object.track.to);
  assert.deepEqual(evaluateTransform(object, 40), object.track.to);
  const middle = evaluateTransform(object, 2);
  close(middle.position[0], 6);
  close(middle.scale[0], 2);
  const output = evaluateTransform(object, 0);
  output.position[0] = 99;
  assert.equal(object.track.from.position[0], 2);
  assert.throws(() => evaluateTransform(object, NaN), /finite/);
});

test('an unanimated entity returns an independent copy of its static transform', () => {
  const object = createObject('cone', 2);
  const result = evaluateTransform(object, 3);
  assert.deepEqual(result, object.transform);
  result.rotation[0] = 45;
  assert.equal(object.transform.rotation[0], 0);
});

test('object and camera tracks use independent start and duration', () => {
  const doc = createDocument();
  doc.objects[0].track = { start: 2, duration: 1, from: transform(0), to: transform(10) };
  doc.shots[0].track = { start: 0, duration: 5, from: transform(0), to: transform(20) };
  close(evaluateTransform(doc.objects[0], 1).position[0], 0);
  close(evaluateTransform(doc.shots[0], 1).position[0], 4);
  close(evaluateTransform(doc.objects[0], 2.5).position[0], 5);
  close(evaluateTransform(doc.shots[0], 2.5).position[0], 10);
  close(evaluateTransform(doc.objects[0], 4).position[0], 10);
  close(evaluateTransform(doc.shots[0], 4).position[0], 16);
});

test('rotation crosses 360 degrees by the shortest quaternion arc', () => {
  const object = createObject('cube', 1);
  object.track = { start: 0, duration: 2, from: transform(0, 350), to: transform(0, 10) };
  const middle = evaluateTransform(object, 1);
  const expected = rotationQuaternion([0, 0, 0]);
  close(Math.abs(rotationQuaternion(middle.rotation).dot(expected)), 1);
  const quarter = rotationQuaternion(evaluateTransform(object, 0.5).rotation);
  close(Math.abs(quarter.dot(rotationQuaternion([0, 355, 0]))), 1);
});

test('serialization preserves all editable state and detaches imported data', () => {
  const original = createDocument();
  const restored = parseDocument(serializeDocument(original));
  assert.deepEqual(restored, original);
  restored.objects[0].track!.to.position[0] = 99;
  assert.notEqual(original.objects[0].track!.to.position[0], 99);
  const copy = cloneDocument(original);
  copy.shots[0].track!.from.rotation[0] = 99;
  copy.objects.push(createObject('plane', 4));
  assert.notEqual(original.shots[0].track!.from.rotation[0], 99);
  assert.equal(original.objects.length, 3);
  const validated = validateDocument(original);
  validated.objects[0].transform.position[0] = 88;
  assert.notEqual(original.objects[0].transform.position[0], 88);
});

test('validation rejects unsupported documents, fields, IDs, primitives and colors', () => {
  assert.throws(() => validateDocument(null));
  assert.throws(() => parseDocument('{broken'));
  rejection(doc => { (doc as unknown as { version: number }).version = 3; }, /format or version/);
  rejection(doc => { (doc as unknown as Record<string, unknown>).extra = true; }, /fields/);
  rejection(doc => { doc.name = ''; }, /nonempty/);
  rejection(doc => { doc.objects[1].id = doc.objects[0].id; }, /duplicate/);
  rejection(doc => { doc.objects[0].id = 'camera'; }, /duplicate/);
  rejection(doc => { doc.objects[0].id = '__proto__'; }, /invalid/);
  rejection(doc => { doc.objects[0].id = 'x'.repeat(65); }, /64/);
  rejection(doc => { (doc.objects[0] as unknown as { kind: string }).kind = 'torus'; }, /primitive/);
  rejection(doc => { doc.objects[0].color = 'url(javascript:alert(1))'; }, /hex/);
  rejection(doc => { (doc.shots[0] as unknown as { id: string }).id = 'object-1'; }, /duplicate/);
});

test('validation enforces finite bounded transforms, scene length and motion intervals', () => {
  for (const value of [NaN, Infinity, -Infinity, 0, 61]) rejection(doc => { doc.duration = value; });
  rejection(doc => { doc.objects[0].transform.position[0] = Infinity; }, /finite/);
  rejection(doc => { doc.objects[0].transform.position[0] = 1001; }, /1000/);
  rejection(doc => { doc.objects[0].transform.rotation[0] = 360001; });
  rejection(doc => { doc.objects[0].transform.scale[0] = 0; });
  rejection(doc => { doc.objects[0].track!.to.scale[2] = 101; });
  rejection(doc => { doc.shots[0].fov = 121; });
  rejection(doc => { doc.objects[0].track!.start = -0.1; });
  rejection(doc => { doc.objects[0].track!.duration = 0.099; });
  rejection(doc => { doc.objects[0].track!.duration = 5; }, /finish/);
  rejection(doc => { doc.shots[0].track!.to.position[2] = NaN; });
  const edge = createDocument();
  edge.objects[0].track!.start = 4.9;
  edge.objects[0].track!.duration = 0.1;
  assert.doesNotThrow(() => validateDocument(edge));
});

test('import limits object count and file size and rejects prototype pollution and accessors', () => {
  rejection(doc => { doc.objects = Array.from({ length: 101 }, (_, i) => createObject('cube', i + 1)); }, /100 objects/);
  assert.throws(() => parseDocument(' '.repeat(1_000_001)), /too large/);
  rejection(doc => { doc.objects = new Array(3); }, /sparse/);
  const badArray = createDocument();
  Object.defineProperty(badArray.objects[0].transform.position, '__proto__', { value: {} });
  assert.throws(() => validateDocument(badArray), /array fields/);
  const json = serializeDocument(createDocument());
  assert.throws(() => parseDocument(json.replace('"version": 2', '"version": 2, "__proto__": {"polluted": true}')), /fields/);
  const poisoned = createDocument();
  Object.setPrototypeOf(poisoned.objects[0].transform, { polluted: true });
  assert.throws(() => validateDocument(poisoned), /prototype/);
  let accessed = false;
  const accessor = createDocument();
  Object.defineProperty(accessor, 'name', { get() { accessed = true; return 'hidden'; }, enumerable: true });
  assert.throws(() => validateDocument(accessor), /accessor/);
  assert.equal(accessed, false);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('history deduplicates completed edits and isolates every stored and returned document', () => {
  const doc = createDocument();
  const history = new History(doc);
  history.commit(doc);
  assert.equal(history.canUndo, false);
  doc.name = 'Second';
  history.commit(doc);
  doc.name = 'Outside mutation';
  const undone = history.undo()!;
  assert.equal(undone.name, 'A small entrance');
  undone.objects[0].transform.position[0] = 99;
  const redone = history.redo()!;
  assert.equal(redone.name, 'Second');
  redone.name = 'Mutated returned copy';
  const again = history.undo()!;
  assert.notEqual(again.objects[0].transform.position[0], 99);
  assert.equal(history.redo()!.name, 'Second');
  assert.equal(history.redo(), null);
});

test('new commits clear redo; reset clears both directions and detaches the baseline', () => {
  const doc = createDocument();
  const history = new History(doc);
  doc.name = 'Second'; history.commit(doc);
  doc.name = 'Third'; history.commit(doc);
  const second = history.undo()!;
  assert.equal(history.canRedo, true);
  second.name = 'New branch'; history.commit(second);
  assert.equal(history.canRedo, false);
  history.reset(doc);
  doc.name = 'Changed outside';
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo(), null);
});

test('history retains at most 100 snapshots', () => {
  const doc = createDocument();
  const history = new History(doc);
  for (let i = 1; i <= 110; i++) { doc.name = `Edit ${i}`; history.commit(doc); }
  let count = 0;
  let oldest: SceneDocument | null = null;
  while (history.canUndo) { oldest = history.undo(); count++; }
  assert.equal(count, 99);
  assert.equal(oldest!.name, 'Edit 11');
});
