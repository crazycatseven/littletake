import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { objectCameraView } from '../shot-export/renderer.ts';
import { AIStoryboard, keyPanelTimes } from './ai-storyboard.ts';
import { matchingStoryboardPixels, storyboardGridCuts } from './storyboard.ts';
import { createProject } from '../project/storage.ts';
import { projectArchive, readProjectArchive } from '../project/archive.ts';
import { ProjectRoomStore } from '../../server/projects/store.ts';
import { createLookHandler } from '../../server/look-api.ts';
import { generateLookFrame, parseLookInput } from '../../server/look/generate.ts';
import { parseBriefInput } from '../../server/look/brief.ts';
import { briefInput, videoPackage } from './brief.ts';
import { readVideoPackage } from '../../server/handoffs/package.ts';
import type { Workspace } from '../project/workspace.ts';
import type { ProjectOutput } from '../project/room.ts';

function colorFrame(rgb: number[]) {
  const png = new PNG({ width: 16, height: 9 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([...rgb, 255], i);
  return 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
}

test('native export crops follow slightly offset panel seams without treating ordinary detail as a divider', () => {
  const width = 200, height = 112, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    data.set([x < 103 ? 10 : 220, y < 58 ? 20 : 200, 30, 255], (y * width + x) * 4);
  }
  assert.deepEqual(storyboardGridCuts({ width, height, data }), { x: 103, y: 58 });
  data.fill(80); assert.deepEqual(storyboardGridCuts({ width, height, data }), { x: 100, y: 56 });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x, y, 30, 255], (y * width + x) * 4);
  assert.deepEqual(storyboardGridCuts({ width, height, data }), { x: 100, y: 56 });
});

test('legacy storyboard refresh tolerates tiny JPEG noise without accepting changed framing or lighting', () => {
  const a = { width: 1280, height: 720, data: new Uint8ClampedArray(1280 * 720 * 4).fill(80) };
  const b = { ...a, data: a.data.slice() };
  // Real refresh failure: 70 changed pixels, with maximum RGB difference 3.
  for (let pixel = 0; pixel < 70; pixel++) b.data[pixel * 4] += 3;
  assert.equal(matchingStoryboardPixels(a, b), true);
  b.data[0] += 5; assert.equal(matchingStoryboardPixels(a, b), false);
  b.data.fill(81); assert.equal(matchingStoryboardPixels(a, b), false);
  assert.equal(matchingStoryboardPixels(a, { ...b, width: 720, height: 1280 }), false);
});

test('joint storyboard sends exactly four ordered views in one grid and never retries a rejected request', async () => {
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]], frames = colors.map(colorFrame);
  const views = [{ azimuth: 0, elevation: 0 }, { azimuth: 90, elevation: 0 }, { azimuth: 180, elevation: 30 }, { azimuth: 0, elevation: 85 }];
  const input = { layout: '2x2', direction: 'The knight braces, ducks a swipe and counterattacks. Hand-painted fantasy.', style: frames[0], panels: frames.map((frame, i) => ({ frame, at: i, note: i === 3 ? 'Recover from the swing, sword low, knees bent. Cool blue rim light.' : '', subjects: [{ name: 'Knight', position: 'left', depth: 'foreground', box: [.1, .2, .3, .8], view: views[i] }] })) };
  const requests: FormData[] = [];
  await generateLookFrame(parseLookInput(input), { apiKey: 'test', model: 'muse-image-1.0' }, async (_url, init) => {
    requests.push(init!.body as FormData);
    return Response.json({ data: [{ b64_json: frames[0].split(',')[1] }] });
  });
  assert.equal(requests.length, 1);
  const images = requests[0].getAll('image') as File[];
  assert.equal(images.length, 2, 'one grid plus style; no individual image calls or anchor');
  const grid = PNG.sync.read(Buffer.from(await images[0].arrayBuffer()));
  assert.deepEqual([grid.width, grid.height], [2560, 1440]);
  colors.forEach((rgb, i) => {
    const x = i % 2 * 1280 + 640, y = Math.floor(i / 2) * 720 + 360, offset = (y * grid.width + x) * 4;
    assert.deepEqual([...grid.data.subarray(offset, offset + 3)], rgb);
  });
  const prompt = String(requests[0].get('prompt'));
  assert.match(prompt, /Edit @Image1 IN PLACE/); assert.match(prompt, /@Image2 defines only the visual style/);
  assert.match(prompt, /BOTTOM RIGHT, 3.00s/); assert.match(prompt, /Cool blue rim light/); assert.match(prompt, /x=10–30%, y=20–80%/);
  assert.match(prompt, /TOP LEFT, 0.00s: Knight: FRONT view/);
  assert.match(prompt, /TOP RIGHT, 1.00s: Knight: RIGHT SIDE PROFILE/);
  assert.match(prompt, /BOTTOM LEFT, 2.00s: Knight: BACK view; HIGH ANGLE/);
  assert.match(prompt, /BOTTOM RIGHT, 3.00s: Knight: almost vertically OVERHEAD/);
  assert.ok(prompt.includes(input.direction), 'the creator story reaches the actual paid request');
  assert.ok(prompt.includes(input.panels[3].note), 'the final action beat reaches the matching panel');
  assert.match(prompt, /A rigid proxy is not an instruction to freeze/);
  assert.match(prompt, /Keep explicitly still poses still/);
  assert.doesNotMatch(prompt, /keep each pose|silhouette, pose|pose and timing authoritative/);
  assert.throws(() => parseLookInput({ ...input, panels: input.panels.slice(0, 3) }));
  assert.throws(() => parseLookInput({ ...input, panels: [...input.panels].reverse() }));
  assert.throws(() => parseLookInput({ ...input, anchor: frames[0] }));
  for (const invalidView of [{ azimuth: 181, elevation: 0 }, { azimuth: 0, elevation: -91 }, { azimuth: NaN, elevation: 0 }, { azimuth: 0, elevation: Infinity }]) {
    assert.throws(() => parseLookInput({ ...input, panels: input.panels.map(panel => ({ ...panel, subjects: [{ ...panel.subjects[0], view: invalidView }] })) }));
  }
  let rejected = 0;
  await assert.rejects(generateLookFrame(parseLookInput(input), { apiKey: 'test', model: 'muse-image-1.0' }, async () => { rejected++; return new Response('{}', { status: 400 }); }));
  assert.equal(rejected, 1, 'no alternate field-name or enhancement retry for joint generation');
});

test('view descriptions use the actual world pose, stay independent of object scale, and use the body center for elevation', () => {
  const parent = new Group(), root = new Group(), geometry = new BoxGeometry(2, 2, 2), material = new MeshBasicMaterial();
  root.add(new Mesh(geometry, material)); parent.add(root);
  const view = (camera: number[]) => objectCameraView(root, new Vector3().fromArray(camera))!;
  const near = (value: number, expected: number) => assert.ok(Math.abs(value - expected) < 1e-6, `${value} vs ${expected}`);
  try {
    near(view([0,0,10]).azimuth, 0); near(view([10,0,0]).azimuth, 90); near(Math.abs(view([0,0,-10]).azimuth), 180);
    near(view([0,10,0]).elevation, 90); near(view([0,-10,0]).elevation, -90);
    root.rotation.y = Math.PI / 2; near(view([10,0,0]).azimuth, 0);
    const before = view([10,0,10]); root.scale.set(4,2,.25); near(view([10,0,10]).azimuth, before.azimuth);
    parent.position.set(8,4,-3); parent.rotation.y = Math.PI / 2;
    near(Math.abs(view([8,4,7]).azimuth), 180); near(view([8,14,-3]).elevation, 90);
    assert.equal(objectCameraView(new Group(), new Vector3(0,0,10)), undefined);
  } finally { geometry.dispose(); material.dispose(); }
});

test('one-sheet generation persists, preserves prior results on failure/cancel, resumes and exports original bytes and timing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'littletake-board-'));
  let store = new ProjectRoomStore(directory); t.after(() => store.close());
  const project = createProject(), scene = project.scenes[0], shot = scene.shots[0], lease = randomUUID();
  shot.start = 1; shot.duration = 3;
  let room = store.create(randomUUID(), lease, project), failSave = false, failAfterResponse = false, failProvider = false, cancelDuringRequest: AbortController | undefined;
  const source = colorFrame([10, 30, 80]);
  const rendered = 'data:image/webp;base64,' + (await readFile(new URL('../../server/projects/fixtures/cover.webp', import.meta.url))).toString('base64');
  const requests: FormData[] = [];
  const handler = createLookHandler({ MODEL_API_KEY: 'test' }, async (_url, init) => {
    requests.push(init!.body as FormData);
    if (failProvider) return new Response('{}', { status: 429 });
    if (failAfterResponse) failSave = true;
    cancelDuringRequest?.abort();
    return Response.json({ data: [{ b64_json: rendered.split(',')[1] }] });
  });
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => handler(new Request('http://localhost' + url, init)));
  const workspace = {
    get room() { return room; }, lookSettings: () => ({ direction: 'Ink illustration', styleId: null, anchorId: null }),
    output: async (id: string) => new Blob([new Uint8Array(store.readOutput(room.code, id).data)]),
    putOutput: async (metadata: Omit<ProjectOutput, 'updatedAt'>, blob: Blob) => {
      if (failSave) throw new Error('Upload interrupted');
      const result = store.saveOutput(room.code, lease, metadata, new Uint8Array(await blob.arrayBuffer()), undefined, room.outputs.find(output => output.id === metadata.id)?.updatedAt ?? 0);
      room.outputs = store.get(room.code, lease).outputs; return result;
    },
  } as unknown as Workspace;
  let direction = 'Cinematic ink illustration. The hero braces, recoils and recovers, in warm sunset light.';
  let captureImage = source, renderState = JSON.stringify(scene);
  const capture = () => ({ previs: captureImage, input: captureImage, subjects: [], visible: new Set<string>() });
  let plans = 0;
  const open = () => new AIStoryboard(shot, 24, scene.id, workspace, capture, () => ({ direction, stylePreset: 'pencil', appearance: [] }), () => {}, () => {}, renderState, async () => {
    plans++;
    return { prompt: 'The hero holds position and tracks the passing dragon.', beats: [{ at: 1, action: 'Turn to track the dragon.' }] };
  });
  let board = open(); await board.load();
  assert.equal(board.panels.length, 4); assert.equal(requests.length, 0);
  const generate = () => board.generate(new AbortController().signal);
  failSave = true; await assert.rejects(generate(), /Upload interrupted/); assert.equal(requests.length, 0);
  failSave = false; await board.retrySave();
  await Promise.all([generate(), generate()]); assert.equal(requests.length, 1, 'concurrent clicks do not duplicate paid requests');
  assert.equal(plans, 1, 'persistence failure and concurrent clicks do not trigger extra planning');
  assert.match(String(requests[0].get('prompt')), /graphite/);
  assert.match(String(requests[0].get('prompt')), /1\.00 s: Turn to track the dragon/);
  assert.ok(String(requests[0].get('prompt')).includes(direction), 'the editor story survives request validation and reaches Muse');
  assert.equal(board.complete, true); const original = board.result;
  await board.setTime(board.panels[1], .75); await board.setNote(board.panels[1], 'Warm rim light on the hero.');
  assert.equal(board.current, false); assert.equal(board.result, original); assert.notEqual(board.result!.panels[1].at, .75);
  assert.throws(() => board.pages(), /before exporting/);
  failProvider = true; await assert.rejects(generate(), /busy/); assert.equal(requests.length, 2); assert.equal(board.result, original);
  failProvider = false; failAfterResponse = true;
  await assert.rejects(generate(), /Upload interrupted/); assert.equal(requests.length, 3);
  assert.equal(board.result!.panels[1].at, .75); assert.equal(board.complete, false); assert.match(board.saveError, /Upload interrupted/);
  failSave = false; failAfterResponse = false; await board.retrySave();
  assert.equal(requests.length, 3, 'retrying persistence never regenerates the sheet'); assert.equal(board.complete, true);
  store.close(); store = new ProjectRoomStore(directory); room = store.get(room.code, lease);
  captureImage = colorFrame([10, 30, 81]); board = open(); await board.load();
  assert.equal(board.complete, true); assert.equal(board.panels[1].data.note, 'Warm rim light on the hero.'); assert.equal(board.pages()[0].image, rendered);
  assert.equal(board.result!.panels[0].previs, source, 'same scene stays current despite changed raster bytes; exports retain the original sources');
  const unchangedState = renderState, editedScene = structuredClone(scene); editedScene.cameras[0].fov += 1;
  renderState = JSON.stringify(editedScene); board = open(); await board.load();
  assert.equal(board.complete, false, 'a real camera edit invalidates the sheet even if raster bytes happen to match');
  assert.equal(board.result!.image, rendered); assert.equal(requests.length, 3);
  renderState = unchangedState; board = open(); await board.load(); assert.equal(board.complete, true);
  const bundle = await readProjectArchive(projectArchive(store.bundle(room.id)));
  assert.equal(bundle.outputs.filter(output => output.output.kind === 'storyboard').length, 1);
  assert.equal(bundle.outputs.filter(output => output.output.kind === 'look-frame').length, 0);
  const saved = JSON.parse(Buffer.from(bundle.outputs.find(output => output.output.kind === 'storyboard')!.data).toString('utf8'));
  assert.equal(saved.result.image, rendered); assert.equal(saved.version, 2);
  // Cropping is browser-verified; package persistence and original-sheet bytes are verified here.
  const frames = board.result!.panels.map(panel => ({ ...panel, look: source }));
  const archive = await videoPackage(scene, shot, { prompt: direction, promptText: direction, camera: '', beats: [], negative: '', model: 'creator' }, direction, frames, board.pages(), [], [], 'ai');
  const { manifest, files } = await readVideoPackage(archive);
  assert.equal(manifest.storyboardStyle, 'ai'); assert.equal(manifest.firstFrame, 'first-frame.png');
  assert.deepEqual(manifest.storyboards![0].frames.map(frame => frame.at), frames.map(frame => frame.at));
  assert.deepEqual(Buffer.from(files.get('storyboard-01.webp')!), Buffer.from(rendered.split(',')[1], 'base64'));
  direction = 'Monochrome pencil sketch'; assert.equal(board.complete, false); assert.equal(requests.length, 3);
  const beforeCancel = board.result; const aborted = new AbortController(); aborted.abort();
  await assert.rejects(board.generate(aborted.signal)); assert.equal(requests.length, 3);
  cancelDuringRequest = new AbortController(); await assert.rejects(board.generate(cancelDuringRequest.signal));
  assert.equal(board.result, beforeCancel); assert.equal(requests.length, 4);
});

test('four moments remain inside very short shots and repeated held frames survive brief and package validation', async () => {
  const times = keyPanelTimes({ duration: .1 }, 24);
  assert.deepEqual(times, [0, 1 / 24, 1 / 24, 2 / 24]);
  const project = createProject(), scene = project.scenes[0], shot = scene.shots[0]; shot.duration = .1;
  const image = colorFrame([10, 30, 80]), frames = times.map(at => ({ at, previs: image, look: image }));
  const pages = [{ image, frames: times.map((at, i) => ({ index: i + 1, at })) }];
  assert.doesNotThrow(() => parseBriefInput(briefInput(scene, shot, '', [{ at: 0, kind: 'storyboard', image, tiles: pages[0].frames }])));
  const archive = await videoPackage(scene, shot, { prompt: 'A brief held shot.', camera: '', beats: [], negative: '', model: 'creator' }, '', frames, pages, [], [], 'ai');
  assert.equal((await readVideoPackage(archive)).manifest.storyboards![0].frames.length, 4);
});
