import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLookFrame, lookPrompt, parseLookInput } from '../server/look/generate.ts';
import { createLookHandler } from '../server/look-api.ts';
import { lookSubjects } from '../src/look/subjects.ts';
import type { SceneDocument } from '../src/types.ts';

const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const url = (bytes: Buffer, type = 'png') => `data:image/${type};base64,${bytes.toString('base64')}`;
const input = (extra: Record<string, unknown> = {}) => ({ frame: url(png), direction: 'Pastel 1930s hotel lobby, soft daylight', subjects: [{ name: 'Zero', position: 'left', depth: 'foreground' }], ...extra });
const ok = (bytes = webp) => Response.json({ data: [{ b64_json: bytes.toString('base64') }], usage: { images: 1 } });

test('look prompt locks composition and numbers references in send order', () => {
  const plain = lookPrompt(parseLookInput(input()));
  assert.match(plain, /Lock the composition to @Image1/);
  assert.match(plain, /Zero \(left, foreground\)/);
  assert.doesNotMatch(plain, /@Image2/);
  const both = lookPrompt(parseLookInput(input({ anchor: url(webp, 'webp'), style: url(png) })));
  assert.match(both, /@Image2 is an approved frame/);
  assert.match(both, /Use @Image3 only as a reference for visual style/);
  assert.match(lookPrompt(parseLookInput(input({ style: url(png) }))), /Use @Image2 only/);
});

test('look input rejects missing direction, extra fields and non-image data', () => {
  assert.throws(() => parseLookInput(input({ direction: '  ' })), { code: 'invalid_input' });
  assert.throws(() => parseLookInput(input({ secret: 1 })), { code: 'invalid_input' });
  assert.throws(() => parseLookInput(input({ frame: 'data:video/mp4;base64,AAAA' })), { code: 'invalid_input' });
  assert.throws(() => parseLookInput(input({ subjects: [{ name: 'x', position: 'top', depth: 'foreground' }] })), { code: 'invalid_input' });
});

test('Muse Image edit request is multipart with every reference image', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const result = await generateLookFrame(parseLookInput(input({ anchor: url(webp, 'webp') })), { apiKey: 'LLM|test', model: 'muse-image-1.0' }, async (target, init) => { seen = { url: String(target), init: init! }; return ok(); });
  assert.equal(seen!.url, 'https://api.meta.ai/v1/images/edits');
  assert.equal((seen!.init.headers as Record<string, string>).Authorization, 'Bearer LLM|test');
  const form = seen!.init.body as FormData;
  assert.equal(form.get('model'), 'muse-image-1.0');
  assert.equal(form.get('size'), '1600x900');
  const images = form.getAll('image') as File[];
  assert.deepEqual(images.map(file => file.type), ['image/png', 'image/webp']);
  assert.equal(form.getAll('image[]').length, 0);
  assert.equal(form.get('prompt'), result.prompt);
  assert.match(result.image, /^data:image\/webp;base64,/);
});

test('several references fall back to image[] once after a 400', async () => {
  const fields: string[][] = [];
  const transport = async (_: unknown, init?: RequestInit) => { const form = init!.body as FormData; fields.push([...new Set([...form.keys()].filter(key => key.startsWith('image')))]); return fields.length === 1 ? new Response('{}', { status: 400 }) : ok(); };
  await generateLookFrame(parseLookInput(input({ anchor: url(webp, 'webp') })), { apiKey: 'k', model: 'm' }, transport as typeof fetch);
  assert.deepEqual(fields, [['image'], ['image[]']]);
  let calls = 0;
  await assert.rejects(generateLookFrame(parseLookInput(input()), { apiKey: 'k', model: 'm' }, async () => { calls++; return new Response('{}', { status: 400 }); }), { code: 'provider_rejected' });
  assert.equal(calls, 1, 'a single image is not retried');
});

test('a single image uses the plain image field and provider failures stay generic', async () => {
  let form: FormData | null = null;
  await generateLookFrame(parseLookInput(input()), { apiKey: 'k', model: 'm' }, async (_, init) => { form = init!.body as FormData; return ok(png); });
  assert.equal(form!.getAll('image').length, 1);
  assert.equal(form!.getAll('image[]').length, 0);
  const fail = (status: number) => generateLookFrame(parseLookInput(input()), { apiKey: 'k', model: 'm' }, async () => new Response('{"error":"secret details"}', { status }));
  await assert.rejects(fail(402), { code: 'credits_required' });
  await assert.rejects(fail(429), { code: 'rate_limited' });
  await assert.rejects(fail(400), (error: Error & { code: string }) => error.code === 'provider_rejected' && !error.message.includes('secret'));
  await assert.rejects(generateLookFrame(parseLookInput(input()), { apiKey: 'k', model: 'm' }, async () => Response.json({ error: { type: 'invalid_request_error', code: 'size_not_supported', param: 'size', message: 'echo LLM|secret prompt' } }, { status: 400 })), (error: Error) => error.message.includes('invalid_request_error / size_not_supported / size, HTTP 400') && !error.message.includes('secret'));
  await assert.rejects(generateLookFrame(parseLookInput(input()), { apiKey: 'k', model: 'm' }, async () => Response.json({ data: [{ b64_json: 'bm90IGFuIGltYWdl' }] })), { code: 'invalid_response' });
});

test('look handler reports availability, checks origin and needs a key', async () => {
  const post = (body: unknown, headers: Record<string, string> = {}) => new Request('http://localhost/api/look', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const configured = createLookHandler({ MODEL_API_KEY: 'k' }, async () => ok());
  assert.deepEqual(await (await configured(new Request('http://localhost/api/look'))).json(), { available: true, provider: 'Meta', model: 'muse-image-1.0' });
  assert.equal((await configured(post(input(), { Origin: 'https://evil.example' }))).status, 403);
  const response = await configured(post(input()));
  assert.equal(response.status, 200);
  assert.match((await response.json()).image, /^data:image\/webp/);
  assert.equal((await createLookHandler({}, async () => ok())(post(input()))).status, 503);
  assert.equal((await configured(new Request('http://localhost/api/look', { method: 'POST', body: '{}' }))).status, 415);
});

test('subjects describe screen side and depth from the shot camera', () => {
  const pose = (position: number[]) => ({ position, rotation: [0, 0, 0], scale: [1, 1, 1] });
  const object = (id: string, name: string, position: number[], hidden = false) => ({ id, name, kind: 'box', color: '#888888', transform: pose(position), track: null, ...(hidden ? { hidden } : {}) });
  const doc = {
    format: 'LittleTake.scene', version: 3, id: 's', name: 'Lobby', duration: 4,
    objects: [object('a', 'Concierge', [-3, 0, -6]), object('b', 'Bellboy', [0, 0, -2]), object('c', 'Behind camera', [0, 0, 5]), object('d', 'Hidden', [0, 0, -4], true), object('e', 'Far wall', [3, 0, -20])],
    cameras: [{ id: 'cam', name: 'A', fov: 50, transform: pose([0, 0, 0]), track: null }], shots: [],
  } as unknown as SceneDocument;
  assert.deepEqual(lookSubjects(doc, 'cam', 0), [
    { name: 'Bellboy', position: 'center', depth: 'foreground' },
    { name: 'Concierge', position: 'left', depth: 'midground' },
    { name: 'Far wall', position: 'center', depth: 'background' },
  ]);
});
