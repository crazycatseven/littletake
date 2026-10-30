import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Euler, MathUtils } from 'three';
import { MetaProvider } from '../server/ai/meta.ts';
import { AIError, type AIProvider, type StructuredRequest } from '../server/ai/provider.ts';
import { analyzeReference, parseReferenceInput } from '../server/reference/analyze.ts';
import { sceneFromProposal } from '../server/reference/draft.ts';
import { createReferenceHandler } from '../server/reference-api.ts';
import { cloneDocument, evaluateTransform, History, serializeDocument, parseDocument } from '../src/model.ts';

const pose = (x = 0) => ({ position: [x, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
const proposal = () => ({
  name: 'An entrance', summary: 'A person walks towards a block. The camera stays still.', assumptions: ['Depth and scale are estimated.'],
  objects: [
    { name: 'Performer', kind: 'human', transform: { ...pose(-2), position: [-2, 0, 0] }, motion: { start: 0.5, duration: 2.3, from: pose(-2), to: pose(1) } },
    { name: 'Block', kind: 'cube', transform: pose(2), motion: null },
  ],
  camera: { position: [5, 3, 8], target: [0, 0.9, 0], fov: 45, motion: null },
});
const input = () => ({ video: { dataUrl: 'data:video/mp4;base64,' + Buffer.from([0, 0, 0, 16, ...Buffer.from('ftyp'), 0, 0, 0, 0]).toString('base64'), duration: 6, width: 640, height: 360 }, direction: '' });
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('https://littletake.vercel.app/api/reference', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('reference proposal becomes ordinary independently editable objects and an aimed camera', () => {
  const { scene } = sceneFromProposal(proposal(), 6);
  assert.deepEqual(scene.objects.map(item => [item.id, item.kind, item.color]), [['object-1', 'human', '#deded7'], ['object-2', 'cube', '#deded7']]);
  const forward = new Vector3(0, 0, -1).applyEuler(new Euler(...scene.cameras[0].transform.rotation.map(MathUtils.degToRad) as [number, number, number]));
  const target = new Vector3(0, 0.9, 0).sub(new Vector3(...scene.cameras[0].transform.position)).normalize();
  assert.ok(forward.distanceTo(target) < 1e-8);
  scene.objects[0].transform.position[0] = 99;
  assert.equal(scene.objects[1].transform.position[0], 2);
});

test('reference motion keeps its stop time instead of being stretched to the full clip', () => {
  const { scene } = sceneFromProposal(proposal(), 6);
  assert.equal(scene.objects[0].track!.start + scene.objects[0].track!.duration, 2.8);
  assert.deepEqual(evaluateTransform(scene.objects[0], 3), evaluateTransform(scene.objects[0], 6));
  assert.deepEqual(parseDocument(serializeDocument(scene)), scene);
});

test('loading an AI scene is one undoable document change', () => {
  const previous = sceneFromProposal(proposal(), 6).scene, next = cloneDocument(previous);
  next.name = 'Another draft'; next.objects[1].transform.position[0] = 9;
  const history = new History(previous); history.commit(next);
  assert.deepEqual(history.undo(), previous); assert.deepEqual(history.redo(), next);
});

test('bad AI geometry, timing and camera output never reaches the renderer', () => {
  for (const mutate of [
    (value: ReturnType<typeof proposal>) => { value.objects[0].transform.position[0] = Infinity; },
    (value: ReturnType<typeof proposal>) => { value.objects[0].transform.scale[0] = -1; },
    (value: ReturnType<typeof proposal>) => { value.objects[0].motion!.duration = 30; },
    (value: ReturnType<typeof proposal>) => { value.camera.target = [...value.camera.position]; },
    (value: ReturnType<typeof proposal>) => { (value.objects[0] as Record<string, unknown>).kind = 'javascript'; },
  ]) { const value = proposal(); mutate(value); assert.throws(() => sceneFromProposal(value, 6), (error: unknown) => error instanceof AIError && error.code === 'invalid_scene'); }
});

test('reference request rejects non-video input, oversized files and invalid clip metadata', () => {
  assert.equal(parseReferenceInput(input()).video.duration, 6);
  assert.throws(() => parseReferenceInput({ ...input(), video: { ...input().video, dataUrl: 'https://private.example/video.mp4' } }));
  assert.throws(() => parseReferenceInput({ ...input(), video: { ...input().video, duration: 61 } }));
  assert.throws(() => parseReferenceInput({ ...input(), video: { ...input().video, dataUrl: 'data:video/mp4;base64,' + Buffer.alloc(3_000_001).toString('base64') } }));
});

test('reference workflow accepts a different provider without Meta or editor changes', async () => {
  let seen: StructuredRequest | undefined;
  const replacement: AIProvider = { name: 'Replacement', model: 'test-model', async generateObject(value) { seen = value; return proposal(); } };
  const draft = await analyzeReference(input(), replacement);
  assert.equal(draft.provider, 'Replacement'); assert.equal(draft.scene.objects.length, 2);
  assert.equal(seen!.content[1].type, 'video'); assert.ok(seen!.instructions.includes('DEGREES'));
});

test('Meta adapter sends native video, a strict schema and server-side credentials', async () => {
  let sent: Record<string, unknown> | undefined;
  const provider = new MetaProvider({ apiKey: 'server-only-test-secret', model: 'muse-test' }, async (url, options) => {
    assert.equal(url, 'https://api.meta.ai/v1/responses');
    assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer server-only-test-secret');
    sent = JSON.parse(String(options!.body));
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal()) }] }] });
  });
  const draft = await analyzeReference(input(), provider);
  assert.equal(sent!.store, false); assert.equal(draft.model, 'muse-test');
  const payload = sent as { text: { format: { strict: boolean } }; input: { content: { type: string; video_url?: string }[] }[] };
  assert.equal(payload.text.format.strict, true);
  assert.equal(payload.input[0].content[1].type, 'input_video');
  assert.equal(payload.input[0].content[1].video_url, input().video.dataUrl);
  assert.ok(!JSON.stringify(draft).includes('server-only-test-secret'));
});

test('Meta credits errors and unfinished output are explicit; no fake scene fallback', async () => {
  const config = { apiKey: 'test-key', model: 'test' };
  const noCredits = new MetaProvider(config, async () => Response.json({ error: { message: 'secret provider diagnostics' } }, { status: 402 }));
  await assert.rejects(analyzeReference(input(), noCredits), (error: unknown) => error instanceof AIError && error.code === 'credits_required' && !error.message.includes('diagnostics'));
  const unfinished = new MetaProvider(config, async () => Response.json({ status: 'incomplete', output_text: JSON.stringify(proposal()) }));
  await assert.rejects(analyzeReference(input(), unfinished), (error: unknown) => error instanceof AIError && error.code === 'incomplete_response');
});

test('API exposes connection state without a key, and checks input before calling a provider', async () => {
  let calls = 0;
  const handler = createReferenceHandler({ MODEL_API_KEY: 'never-return-this-key' }, () => ({ name: 'Test', model: 'test', async generateObject() { calls++; return proposal(); } }), () => null);
  const connection = await handler(new Request('https://littletake.vercel.app/api/reference'));
  assert.deepEqual(await connection.json(), { available: true, provider: 'Meta', model: 'muse-spark-1.3' });
  assert.equal((await handler(request({}))).status, 400);
  assert.equal((await handler(request(input(), { origin: 'https://another.example' }))).status, 403);
  assert.equal(calls, 0);
  const response = await handler(request(input())); assert.equal(response.status, 200);
  assert.equal((await response.json()).scene.objects.length, 2); assert.equal(calls, 1);
});

test('missing credentials and thrown internals return useful errors without leaking secrets', async () => {
  const unconfigured = createReferenceHandler({});
  assert.equal((await unconfigured(request(input()))).status, 503);
  const handler = createReferenceHandler({}, () => { throw new Error('secret-internal-value'); });
  const response = await handler(request(input()));
  assert.equal(response.status, 500); assert.ok(!(await response.text()).includes('secret-internal-value'));
});

test('API bounds streamed payloads before model execution', async () => {
  const handler = createReferenceHandler({});
  const oversized = request({ padding: 'x'.repeat(4_100_001) });
  assert.equal((await handler(oversized)).status, 413);
  const invalidJSON = new Request('https://littletake.vercel.app/api/reference', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal((await handler(invalidJSON)).status, 400);
});

const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const sketch = (dataUrl = 'data:image/png;base64,' + png().toString('base64')) => ({ image: { dataUrl, duration: 5, width: 1200, height: 800 }, direction: '' });

test('a sketch or storyboard image is accepted only as a real PNG, JPEG or WebP within the limit', () => {
  const parsed = parseReferenceInput(sketch());
  assert.ok('image' in parsed && parsed.image.duration === 5);
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString('base64');
  const webp = 'data:image/webp;base64,' + Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]).toString('base64');
  for (const dataUrl of [jpeg, webp]) assert.ok('image' in parseReferenceInput(sketch(dataUrl)));
  for (const dataUrl of ['data:image/png;base64,' + Buffer.from('not a png').toString('base64'), 'data:image/jpeg;base64,' + png().toString('base64'),
    'data:image/gif;base64,' + Buffer.from('GIF89a').toString('base64'), 'https://private.example/sketch.png']) {
    assert.throws(() => parseReferenceInput(sketch(dataUrl)), (error: unknown) => error instanceof AIError && error.status === 400);
  }
  assert.throws(() => parseReferenceInput(sketch('data:image/png;base64,' + Buffer.concat([png(), Buffer.alloc(3_000_000)]).toString('base64'))), (error: unknown) => error instanceof AIError && error.code === 'image_too_large');
  // One source per request: a video and an image together are not a valid reference.
  assert.throws(() => parseReferenceInput({ ...sketch(), video: input().video }));
});

test('an image is staged by Muse as one shot of the chosen length, with drawn arrows read as movement', async () => {
  let seen: StructuredRequest | undefined;
  const provider: AIProvider = { name: 'Replacement', model: 'test-model', async generateObject(value) { seen = value; return proposal(); } };
  const draft = await analyzeReference(parseReferenceInput(sketch()), provider);
  assert.equal(draft.scene.duration, 5); assert.equal(draft.scene.shots[0].duration, 5);
  assert.deepEqual(seen!.content.map(part => part.type), ['text', 'image']);
  assert.match(seen!.instructions, /storyboard panel, a rough sketch/); assert.match(seen!.instructions, /arrows/); assert.ok(seen!.instructions.includes('DEGREES'));
  assert.match((seen!.content[0] as { text: string }).text, /Scene duration: 5\.000 seconds/);
  // The video prompt is unchanged by the image path.
  await analyzeReference(input(), provider);
  assert.match(seen!.instructions, /^Create an EDITABLE 3D whitebox filming scene from a reference video\./);
});

test('the API stages an image without starting SAM video tracking', async () => {
  let tracked = 0;
  const handler = createReferenceHandler({ MODEL_API_KEY: 'test-key' }, () => ({ name: 'Test', model: 'test', async generateObject() { return proposal(); } }),
    () => async () => { tracked++; return { boxes: [], frames: 0 } as never; });
  const response = await handler(request(sketch()));
  assert.equal(response.status, 200); assert.equal((await response.json()).scene.duration, 5); assert.equal(tracked, 0);
  assert.equal((await handler(request(sketch('data:image/png;base64,' + Buffer.from('fake').toString('base64'))))).status, 400);
});
