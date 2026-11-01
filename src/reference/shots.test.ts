import test from 'node:test';
import assert from 'node:assert/strict';
import { ShotScanner, SCAN_WIDTH, SCAN_HEIGHT } from './shots.ts';
import { parseReferenceInput } from '../../server/reference/analyze.ts';
import { createReferenceHandler } from '../../server/reference-api.ts';
import type { SourceEvidence } from './analysis.ts';

const colors = [[185, 45, 50], [45, 175, 65], [50, 75, 195], [190, 170, 40]];
function picture(scene: number, shift = 0, exposure = 1, objectX = -100) {
  const pixels = new Uint8ClampedArray(SCAN_WIDTH * SCAN_HEIGHT * 4), color = colors[scene % colors.length];
  for (let y = 0; y < SCAN_HEIGHT; y++) for (let x = 0; x < SCAN_WIDTH; x++) {
    const i = (y * SCAN_WIDTH + x) * 4, detail = Math.sin((x + shift) * .12) * 18 + Math.cos(y * .17) * 12;
    for (let c = 0; c < 3; c++) pixels[i + c] = (x >= objectX && x < objectX + 24 && y > 20 && y < 78 ? [240, 210, 150][c] : color[c] + detail) * exposure;
    pixels[i + 3] = 255;
  }
  return pixels;
}

test('one variable-frame-rate clip survives a flash, a continuous pan, a cut, a fade and moving subjects', () => {
  const scanner = new ShotScanner(), times: number[] = [];
  let time = .041;
  const feed = (pixels: Uint8ClampedArray) => { times.push(time); scanner.push(pixels, time); time += times.length % 7 === 0 ? 1 / 30 : 1 / 24; };
  for (let i = 0; i < 60; i++) feed(i === 30 ? new Uint8ClampedArray(SCAN_WIDTH * SCAN_HEIGHT * 4).fill(255) : picture(0));
  for (let i = 0; i < 60; i++) feed(picture(0, i));
  const cutIndex = times.length;
  for (let i = 0; i < 45; i++) feed(picture(1));
  for (let i = 0; i < 12; i++) feed(picture(1, 0, 1 - (i + 1) / 12));
  for (let i = 0; i < 4; i++) feed(picture(1, 0, 0));
  for (let i = 0; i < 12; i++) feed(picture(2, 0, (i + 1) / 12));
  for (let i = 0; i < 45; i++) feed(picture(2));
  for (let i = 0; i < 60; i++) feed(picture(2, 0, 1, 10 + i * 1.7));
  const result = scanner.finish(time);
  assert.equal(result.cuts.length, 2, 'The flash and pan must not split physical camera shots.');
  assert.equal(result.cuts[0], times[cutIndex], 'A cut keeps presentation time, not frameIndex / nominal FPS.');
  assert.deepEqual(result.sampling.transitions.map(item => item.kind), ['cut', 'fade']);
  const fade = result.sampling.transitions[1];
  assert.ok(fade.end > fade.start && fade.start < fade.time && fade.end > fade.time);
  assert.equal(result.sampling.decodedFrames, times.length);
  assert.deepEqual([...new Set(result.frames.map(frame => frame.shotIndex))], [0, 1, 2]);
  assert.equal(result.frames.filter(frame => frame.reason === 'representative').length, 3);
  assert.ok(result.frames.filter(frame => frame.shotIndex === 2).length >= 3, 'Moving subjects need temporal evidence.');
  assert.ok(result.frames.every(frame => frame.frameIndex !== 30 && !(frame.time > fade.start && frame.time < fade.end)));
  for (const frame of result.frames) assert.equal(frame.time, times[frame.frameIndex]);
  assert.ok(result.frames.length <= 18);
});

test('static shots use one sample each, including shots after the sixth; an over-budget clip cannot silently omit shots', () => {
  const scan = (shots: number) => {
    const scanner = new ShotScanner();
    for (let shot = 0; shot < shots; shot++) for (let i = 0; i < 24; i++) scanner.push(picture(shot), shot + i / 24);
    return scanner.finish(shots);
  };
  const result = scan(8);
  assert.equal(result.cuts.length, 7); assert.equal(result.frames.length, 8);
  assert.deepEqual(result.frames.map(frame => frame.shotIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(result.frames.every(frame => frame.reason === 'representative'));
  assert.throws(() => scan(19), /19 shots.*at most 18 shots/);
});

test('selected evidence survives persistence and API analysis, measures only new frames and rejects invented cut times', async () => {
  const scanner = new ShotScanner();
  for (let i = 0; i < 96; i++) scanner.push(picture(i < 48 ? 0 : 1), i / 24);
  const selected = scanner.finish(4), jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const source: SourceEvidence = JSON.parse(JSON.stringify({ ...selected, contactSheet: jpeg, frames: selected.frames.map((frame, i) => ({ ...frame, dataUrl: jpeg, ...(i ? {} : { detections: [] }) })) }));
  const video = { duration: 4, width: 640, height: 360, dataUrl: 'data:video/mp4;base64,' + Buffer.from([0, 0, 0, 16, ...Buffer.from('ftyp'), 0, 0, 0, 0]).toString('base64') };
  const body = { video, source, direction: '' };
  assert.deepEqual(parseReferenceInput(body).source, source);
  let measurements = 0, observations = 0, wrongCuts = false;
  const handler = createReferenceHandler({}, () => ({ name: 'Test', model: 'test',
    async segmentMedia(media) {
      measurements++;
      const bytes = Buffer.from(media.dataUrl.split(',')[1], 'base64');
      assert.equal(bytes.readUInt32BE(16), 640, 'Only the new frame belongs in the measurement atlas.');
      return [];
    },
    async generateObject(request) {
      observations++;
      assert.ok(request.instructions.includes('measured cuts are fixed'));
      return {
        summary: 'Two views of a set.', entities: [{ name: 'wall', description: 'Fixed wall', color: '#aaaabb', principal: false }],
        shots: [{ start: 0, duration: wrongCuts ? 1.5 : 2, framing: 'full_body', description: 'First camera' }, { start: wrongCuts ? 1.5 : 2, duration: wrongCuts ? 2.5 : 2, framing: 'full_body', description: 'Second camera' }],
        frames: source.frames.map(frame => ({ time: frame.time, shotIndex: frame.shotIndex, setting: 'Room', subjects: [{ name: 'wall', box: [.1, .1, .9, .9], headBox: null, bodyRegionId: null, headRegionId: null, facing: 'front', bodyFacing: null, action: 'static' }] })), assumptions: [],
      };
    },
  }));
  const send = (value: unknown) => handler(new Request('https://littletake.test/api/reference', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }));
  const first = await send(body); assert.equal(first.status, 200); const observed = await first.json();
  assert.equal(measurements, 2); assert.equal(source.frames[1].detections, undefined, 'Requests cannot mutate saved input evidence.');
  source.frames.forEach(frame => { frame.detections = observed.regions.find((region: { frameIndex: number }) => region.frameIndex === frame.frameIndex).detections; });
  assert.equal((await send(JSON.parse(JSON.stringify(body)))).status, 200);
  assert.equal(measurements, 2, 'An empty detection result is cached too; repeated analysis does not repeat SAM.');
  const corrupted = structuredClone(body); corrupted.source.frames[1].shotIndex = 0;
  assert.equal((await send(corrupted)).status, 400); assert.equal(observations, 2, 'Invalid source timing must fail before paid calls.');
  wrongCuts = true;
  const rejected = await send(body); assert.equal(rejected.status, 502);
  assert.match((await rejected.json()).error.message, /changed the detected shot boundaries/);
  assert.equal(measurements, 2);
});
