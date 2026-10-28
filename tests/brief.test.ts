import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBriefInput, writeVideoBrief } from '../server/look/brief.ts';
import { createBriefHandler } from '../server/look-api.ts';
import type { AIProvider, StructuredRequest } from '../server/ai/provider.ts';
import { sceneFromProposal } from '../server/reference/draft.ts';
import { briefInput, briefMarkdown, videoPackage, type VideoBrief } from '../src/look/brief.ts';
import { crc32, zipFiles } from '../src/look/zip.ts';

const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const pose = (position: number[]) => ({ position, rotation: [0, 0, 0], scale: [1, 1, 1] });
const scene = () => sceneFromProposal({
  name: 'Lobby', summary: 'A bellboy crosses the lobby.', assumptions: [],
  objects: [
    { name: 'Bellboy', kind: 'human', transform: pose([-2, 0, 0]), motion: { start: 1, duration: 2, from: pose([-2, 0, 0]), to: pose([1, 0, -1]) } },
    { name: 'Desk', kind: 'cube', transform: pose([1.5, .5, -2]), motion: null },
  ],
  camera: { position: [0, 1.6, 6], target: [0, .9, 0], fov: 45, motion: null },
}, 5).scene;
const brief = (extra: Partial<VideoBrief> = {}) => ({ prompt: 'A young bellboy in a purple uniform crosses a pastel hotel lobby from left to right.', camera: 'static, eye level', beats: [{ at: 3, action: 'He stops by the desk.' }, { at: 1, action: 'He starts walking.' }, { at: 9, action: 'Past the end.' }], negative: 'extra people, text', ...extra });
const fake = (value: unknown, seen: StructuredRequest[] = []): AIProvider => ({ name: 'Meta', model: 'muse-spark-1.3', async generateObject(request) { seen.push(request); return value; } });

test('client brief input passes the server schema and describes motion inside the shot', () => {
  const doc = scene(), shot = doc.shots[0];
  const input = briefInput(doc, shot, '  pastel 1930s hotel  ', [{ at: 0, image: png, kind: 'previs' }]);
  const parsed = parseBriefInput(JSON.parse(JSON.stringify(input)));
  assert.equal(parsed.direction, 'pastel 1930s hotel');
  const bellboy = parsed.subjects.find(item => item.name === 'Bellboy')!;
  assert.ok(bellboy.motion && Math.abs(bellboy.motion.start - 1) <= .1 && Math.abs(bellboy.motion.end - 3) <= .1, JSON.stringify(bellboy.motion));
  assert.deepEqual(bellboy.motion!.to, [1, 0, -1]);
  assert.equal(parsed.subjects.find(item => item.name === 'Desk')!.motion, null);
  assert.throws(() => parseBriefInput({ ...input, frames: [] }), { code: 'invalid_input' });
  assert.throws(() => parseBriefInput({ ...input, extra: true }), { code: 'invalid_input' });
});

test('Muse Spark receives shot data with every frame and returns ordered beats within the shot', async () => {
  const seen: StructuredRequest[] = [];
  const input = parseBriefInput(briefInput(scene(), scene().shots[0], 'pastel', [{ at: 0, image: png, kind: 'look' }, { at: 2.5, image: png, kind: 'previs' }]));
  const result = await writeVideoBrief(input, fake(brief(), seen));
  assert.equal(seen[0].schemaName, 'littletake_video_brief');
  assert.deepEqual(seen[0].content.map(part => part.type), ['text', 'image', 'image']);
  assert.match((seen[0].content[0] as { text: string }).text, /#1 look at 0\.00 s; #2 previs at 2\.50 s/);
  assert.deepEqual(result.beats.map(beat => beat.at), [1, 3]);
  assert.equal(result.model, 'muse-spark-1.3');
  await assert.rejects(writeVideoBrief(input, fake({ prompt: 'short' })), { code: 'invalid_response' });
});

test('brief handler reports availability, checks origin and returns the brief', async () => {
  const body = JSON.stringify(briefInput(scene(), scene().shots[0], '', [{ at: 0, image: png, kind: 'previs' }]));
  const post = (headers: Record<string, string> = {}) => new Request('http://localhost/api/brief', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const handler = createBriefHandler({ MODEL_API_KEY: 'k' }, () => fake(brief()));
  assert.equal((await (await handler(new Request('http://localhost/api/brief'))).json()).available, true);
  assert.equal((await handler(post({ Origin: 'https://evil.example' }))).status, 403);
  const response = await handler(post());
  assert.equal(response.status, 200);
  assert.match((await response.json()).prompt, /bellboy/);
});

test('video package is a valid zip with brief, manifest and frames', async () => {
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
  const doc = scene(), shot = doc.shots[0], result = { ...brief(), beats: brief().beats.slice(0, 2), model: 'muse-spark-1.3' };
  const blob = await videoPackage(doc, shot, result, 'pastel', [{ at: 0, look: 'data:image/webp;base64,UklGRg==', previs: png }, { at: 2.5, previs: png }], new Blob([new Uint8Array([26, 69, 223, 163])]));
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 6);
  const text = new TextDecoder().decode(bytes);
  for (const name of ['brief.md', 'manifest.json', 'look-01-0.00s.webp', 'previs-01-0.00s.png', 'previs-02-2.50s.png', 'previs.webm']) assert.ok(text.includes(`-video-package/${name}`), name);
  assert.match(text, /"format": "LittleTake.videoPackage"/);
  assert.match(briefMarkdown(shot, result, 'pastel'), /- 1\.00 s: He starts walking\./);
  assert.equal(zipFiles([]).length, 22);
});
