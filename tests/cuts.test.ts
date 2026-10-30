import test from 'node:test';
import assert from 'node:assert/strict';
import { colourHistogram, findCuts, histogramDistance, CUT_STEP } from '../src/reference/cuts.ts';
import { analyzeReference, parseReferenceInput } from '../server/reference/analyze.ts';
import type { AIProvider, StructuredRequest } from '../server/ai/provider.ts';

const times = (count: number) => Array.from({ length: count }, (_, index) => Math.round(index * CUT_STEP * 100) / 100);
const mp4 = 'data:video/mp4;base64,' + Buffer.from([0, 0, 0, 16, ...Buffer.from('ftyp'), 0, 0, 0, 0]).toString('base64');
const input = (cuts?: unknown) => ({ video: { dataUrl: mp4, duration: 12, width: 1280, height: 720, ...(cuts === undefined ? {} : { cuts }) }, direction: '' });

test('histograms are 0 apart for identical frames and 1 apart for disjoint colours', () => {
  const red = new Uint8ClampedArray(64 * 4).fill(0).map((_, index) => index % 4 === 0 || index % 4 === 3 ? 255 : 0);
  const blue = new Uint8ClampedArray(64 * 4).fill(0).map((_, index) => index % 4 === 2 || index % 4 === 3 ? 255 : 0);
  assert.equal(histogramDistance(colourHistogram(red), colourHistogram(red)), 0);
  assert.equal(histogramDistance(colourHistogram(red), colourHistogram(blue)), 1);
});

test('the demo clip yields its two hard cuts and nothing from movement', () => {
  // Frame-to-frame histogram distances of the demo clip sampled every 0.2 s (64×36). ffmpeg places the cuts at 1.88 s and 5.50 s.
  const demo = [0, .01, .016, .011, .01, .02, .028, .019, .015, .352, .024, .025, .042, .03, .048, .028, .043, .021, .03, .032, .03, .018, .031, .043, .032, .063, .037, .054, .293, .021, .036, .02, .035, .028, .036, .069, .043, .022, .03, .031, .065, .032, .026, .036, .033, .042, .041, .045, .03, .021, .043, .039, .05, .034, .031, .029, .043, .035, .04, .043];
  const cuts = findCuts(times(demo.length), demo);
  assert.equal(cuts.length, 2);
  assert.ok(Math.abs(cuts[0] - 1.88) <= .2 && Math.abs(cuts[1] - 5.5) <= .2, String(cuts));
});

test('a continuous shot with camera motion has no cuts, and close spikes count once', () => {
  const smooth = Array.from({ length: 50 }, (_, index) => index ? .04 + .03 * Math.sin(index) : 0);
  assert.deepEqual(findCuts(times(50), smooth), []);
  const flicker = [...smooth]; flicker[10] = .5; flicker[11] = .45; flicker[30] = .6;
  assert.deepEqual(findCuts(times(50), flicker), [1.9, 5.9]);
  assert.deepEqual(findCuts([], []), []);
});

test('reference input keeps valid cuts in order and tells Muse the first shot', async () => {
  assert.deepEqual(parseReferenceInput(input([5.5, 1.9, 1.9, 0.05, 11.95])).video.cuts, [1.9, 5.5]);
  assert.equal('cuts' in parseReferenceInput(input([])).video, false);
  assert.throws(() => parseReferenceInput(input(['1'])), { code: 'invalid_input' });
  assert.throws(() => parseReferenceInput(input(Array.from({ length: 31 }, (_, index) => index + 1))), { code: 'invalid_input' });
  const seen: StructuredRequest[] = [];
  const provider: AIProvider = { name: 'Meta', model: 'test', async generateObject(request) { seen.push(request); throw new Error('stop'); } };
  await assert.rejects(analyzeReference(parseReferenceInput(input([1.9, 5.5])), provider));
  assert.match((seen[0].content[0] as { text: string }).text, /Hard cuts detected at 1\.90, 5\.50 s\. The first shot runs from 0 to 1\.90 s/);
});
