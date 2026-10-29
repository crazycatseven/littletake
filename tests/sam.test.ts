import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { mp4VideoFrameCount } from '../server/reference/frames.ts';
import { floorPoint, groundReferenceDraft } from '../server/reference/ground.ts';
import { parseSamBoxes, trackConcept, type SamTracks } from '../server/reference/sam.ts';
import { sceneFromProposal } from '../server/reference/draft.ts';
import { createReferenceHandler } from '../server/reference-api.ts';
import { evaluateTransform } from '../src/model.ts';
import type { ReferenceDraft, ReferenceInput } from '../src/reference/types.ts';

const W = 640, H = 360;
const pose = (position: number[]) => ({ position, rotation: [0, 0, 0], scale: [1, 1, 1] });
const proposal = (walker = [-2, 0, 0]) => ({
  name: 'Lobby walk', summary: 'A bellboy crosses the lobby.', assumptions: ['Depth is estimated.'],
  objects: [{ name: 'Bellboy', kind: 'human', transform: pose(walker), motion: null }, { name: 'Desk', kind: 'cube', transform: pose([2, 0.5, -2]), motion: null }],
  camera: { position: [0, 1.6, 6], target: [0, 0.9, 0], fov: 50, motion: null },
});
const input = (): ReferenceInput => ({ video: { dataUrl: 'data:video/mp4;base64,' + Buffer.from('not an mp4').toString('base64'), duration: 5, width: W, height: H }, direction: '' });
const draft = (walker?: number[]): ReferenceDraft => ({ ...sceneFromProposal(proposal(walker), 5), provider: 'Meta', model: 'test' });

/** Ground truth: the bellboy walks from (-2, 0, 0) to (1, 0, -1) between 1 s and 3 s; boxes are its projection at 10 fps. */
function walkTracks(doc = draft().scene): SamTracks {
  const camera = doc.cameras[0], view = new PerspectiveCamera(camera.fov, W / H, .05, 500), at = evaluateTransform(camera, 0);
  view.position.fromArray(at.position); view.rotation.set(...at.rotation.map(MathUtils.degToRad) as [number, number, number], 'XYZ'); view.updateMatrixWorld(true);
  const pixel = (point: Vector3) => { const ndc = point.clone().project(view); return [(ndc.x + 1) / 2 * W, (1 - ndc.y) / 2 * H]; };
  const boxes = Array.from({ length: 50 }, (_, frame) => {
    const t = frame / 10, alpha = MathUtils.clamp((t - 1) / 2, 0, 1), feet = new Vector3(-2 + 3 * alpha, 0, -alpha);
    const [x, bottom] = pixel(feet), [, top] = pixel(feet.clone().setY(1.8)), half = (bottom - top) * .15;
    return { frame, left: x - half, top, right: x + half, bottom };
  });
  return new Map([['3', boxes]]);
}

test('MP4 frame count matches the demo clip and other files return null', () => {
  assert.equal(mp4VideoFrameCount(readFileSync('public/demo/grand-budapest-zero/input-web.mp4')), 287);
  assert.equal(mp4VideoFrameCount(Buffer.from('not an mp4')), null);
  assert.equal(mp4VideoFrameCount(Buffer.from([0, 0, 0, 16, ...Buffer.from('ftyp'), 0, 0, 0, 0])), null);
});

test('SAM wire lines become per-object boxes in frame order', () => {
  const text = [
    "<2f>7<|box;x1=10;y1=20;x2=29;y2=59;w=640;h=360;c=0.9|><|mask;x=0;y=0;data=40,20,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8|>,9<|box;x1=300;y1=40;x2=339;y2=119;w=640;h=360|><|mask;x=0;y=0;data=80,40,!!!*$[]|>",
    '<0f>7<|box;y1=22;x1=12;x2=31;y2=61;w=640;h=360|><|mask;x=0;y=0;data=40,20,~!!!|>',
    '<1f>7<|box;x1=11;y1=21;x2=30|><|mask;data=1,1,~!|>',
    'not a frame line',
  ].join('\n');
  const tracks = parseSamBoxes(text);
  assert.deepEqual([...tracks.keys()], ['7', '9']);
  assert.deepEqual(tracks.get('7'), [{ frame: 0, left: 12, top: 22, right: 32, bottom: 62 }, { frame: 2, left: 10, top: 20, right: 30, bottom: 60 }]);
  assert.deepEqual(tracks.get('9'), [{ frame: 2, left: 300, top: 40, right: 340, bottom: 120 }]);
});

test('SAM request streams a person prompt with the clip and survives deltas split mid-record', async () => {
  const line = '<0f>1<|box;x1=10;y1=20;x2=29;y2=59;w=640;h=360|><|mask;x=0;y=0;data=40,20,~!!!!|>\n<1f>1<|box;x1=12;y1=20;x2=31;y2=59;w=640;h=360|><|mask;x=0;y=0;data=40,20,~!!!!|>\n';
  const events = [{ type: 'response.created' }, { type: 'response.output_text.delta', delta: line.slice(0, 37) }, { type: 'response.output_text.delta', delta: line.slice(37) }, { type: 'response.completed' }];
  const sse = events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('');
  let sent: Record<string, unknown> | null = null;
  const tracks = await trackConcept('person', 'data:video/mp4;base64,AAAA', 'LLM|k', async (_, init) => {
    sent = JSON.parse(String(init!.body));
    const bytes = new TextEncoder().encode(sse);
    return new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 23) controller.enqueue(bytes.slice(index, index + 23)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  assert.equal(sent!.model, 'sam-3.1'); assert.equal(sent!.stream, true);
  assert.deepEqual((sent!.input as { content: { type: string }[] }[])[0].content.map(part => part.type), ['input_text', 'input_video']);
  assert.deepEqual(tracks.get('1')?.map(box => box.left), [10, 12]);
  await assert.rejects(trackConcept('person', 'data:video/mp4;base64,AAAA', 'k', async () => new Response('{"secret":1}', { status: 402 })), { code: 'credits_required' });
  await assert.rejects(trackConcept('person', 'data:video/mp4;base64,AAAA', 'k', async () => new Response('data: {"type":"response.failed"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })), { code: 'provider_error' });
});

test('floor casting follows the camera ray and rejects rays above the horizon', () => {
  const down = new PerspectiveCamera(60, 1, .05, 500); down.position.set(1, 2, 3); down.rotation.set(-Math.PI / 2, 0, 0); down.updateMatrixWorld(true);
  const hit = floorPoint(down, .5, .5)!;
  assert.ok(Math.abs(hit.x - 1) < 1e-6 && Math.abs(hit.y) < 1e-6 && Math.abs(hit.z - 3) < 1e-6);
  const level = new PerspectiveCamera(60, 1, .05, 500); level.position.set(0, 1.6, 0); level.updateMatrixWorld(true);
  assert.equal(floorPoint(level, .5, .4), null);
});

test('tracked feet place the person on the floor with frame-accurate timing', () => {
  const result = groundReferenceDraft(draft(), input(), walkTracks());
  const bellboy = result.scene.objects.find(item => item.name === 'Bellboy')!, desk = result.scene.objects.find(item => item.name === 'Desk')!;
  assert.ok(bellboy.track, 'Muse missed the walk; tracking adds it');
  assert.ok(Math.abs(bellboy.track.start - 1) <= .15, `start ${bellboy.track.start}`);
  assert.ok(Math.abs(bellboy.track.start + bellboy.track.duration - 3) <= .15, `end ${bellboy.track.start + bellboy.track.duration}`);
  const near = (actual: number[], expected: number[]) => assert.ok(Math.hypot(actual[0] - expected[0], actual[2] - expected[2]) < .1, `${actual} vs ${expected}`);
  near(bellboy.track.from.position, [-2, 0, 0]); near(bellboy.track.to.position, [1, 0, -1]); near(bellboy.transform.position, [-2, 0, 0]);
  assert.equal(bellboy.track.from.position[1], 0);
  assert.deepEqual(desk, draft().scene.objects.find(item => item.name === 'Desk'));
  assert.equal(result.tracks?.[0].objectId, bellboy.id); assert.equal(result.tracks?.[0].label, 'Bellboy');
  assert.ok(result.tracks![0].boxes.length >= 45 && result.tracks![0].boxes.every(box => box.slice(1).every(value => value >= 0 && value <= 1)));
  assert.match(result.assumptions.at(-1)!, /SAM 3\.1 tracked 1 person and matched 1/);
});

test('clips with cuts keep Muse placement and show tracks for review only', () => {
  const withCuts = { ...draft(), assumptions: ['Clip contains multiple cuts; only the FIRST shot is reconstructed.'] };
  const result = groundReferenceDraft(withCuts, input(), walkTracks());
  assert.deepEqual(result.scene, withCuts.scene);
  assert.equal(result.tracks?.[0].label, 'Bellboy');
  assert.match(result.assumptions.at(-1)!, /review only/);
});

test('tracks far from every draft person stay unmatched and failures leave the draft unchanged', () => {
  const result = groundReferenceDraft(draft([4, 0, 0]), input(), walkTracks(draft([4, 0, 0]).scene));
  assert.equal(result.scene.objects[0].track, null);
  assert.equal(result.tracks?.[0].label, 'Person 1');
  const failed = groundReferenceDraft(draft(), input(), new Error('timeout'));
  assert.deepEqual(failed.scene, draft().scene); assert.equal(failed.tracks, undefined);
  assert.match(failed.assumptions.at(-1)!, /did not finish/);
});

test('reference API runs SAM beside Muse, grounds the draft, and cancels tracking when Muse fails', async () => {
  const body = { video: { ...input().video, dataUrl: 'data:video/mp4;base64,' + Buffer.from([0, 0, 0, 16, ...Buffer.from('ftyp'), 0, 0, 0, 0]).toString('base64') }, direction: '' };
  const post = () => new Request('https://littletake.vercel.app/api/reference', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const provider = (fail = false) => () => ({ name: 'Meta', model: 'test', async generateObject() { if (fail) throw new Error('boom'); return proposal(); } });
  const ok = await createReferenceHandler({ MODEL_API_KEY: 'k' }, provider(), () => async () => walkTracks())(post());
  const data = await ok.json();
  assert.equal(ok.status, 200); assert.equal(data.tracks[0].label, 'Bellboy'); assert.ok(data.scene.objects[0].track);
  let aborted = false;
  const failing = await createReferenceHandler({ MODEL_API_KEY: 'k' }, provider(true), () => (_, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); })))(post());
  assert.equal(failing.status, 500); assert.equal(aborted, true);
});
