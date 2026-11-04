import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIEF_LIMITS, parseBriefInput, writeVideoBrief } from '../server/look/brief.ts';
import { createBriefHandler } from '../server/look-api.ts';
import type { AIProvider, StructuredRequest } from '../server/ai/provider.ts';
import { sceneFromProposal } from '../server/reference/draft.ts';
import { DEFAULT_SCENE_LOOK } from '../src/scene-edit/look.ts';
import { briefInput, briefMarkdown, videoPackage, type VideoBrief } from '../src/look/brief.ts';
import { crc32, zipFiles } from '../src/look/zip.ts';
import { storyboardSVG, storyboardTimes, STORYBOARD_PAGE_SIZE, type StoryboardFrame } from '../src/look/storyboard.ts';
import { emptyAnimation, putKey } from '../src/animation/model.ts';
import { videoPrompt } from '../src/look/handoff.ts';
import { readVideoPackage } from '../server/handoffs/package.ts';
import { handoffPage } from '../server/handoffs/page.ts';

const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const pose = (position: number[]) => ({ position, rotation: [0, 0, 0], scale: [1, 1, 1] });
const scene = () => sceneFromProposal({
  name: 'Lobby', summary: 'A bellboy crosses the lobby.', assumptions: [],
  look: DEFAULT_SCENE_LOOK, bindings: [],
  objects: [
    { name: 'Bellboy', kind: 'human', color: '#6b8259', transform: pose([-2, 0, 0]), motion: [{ time: 1, pose: pose([-2, 0, 0]) }, { time: 3, pose: pose([1, 0, -1]) }] },
    { name: 'Desk', kind: 'cube', color: '#9a7545', transform: pose([1.5, .5, -2]), motion: null },
  ],
  shots: [{ name: 'Lobby', start: 0, duration: 5, position: [0, 1.6, 6], target: [0, .9, 0], fov: 45, motion: null }],
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

test('a nonzero-start shot becomes timestamped storyboard pages, one complete model request and a still-only package', async () => {
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
  const doc = scene(), shot = doc.shots[0], result = { ...brief(), beats: brief().beats.slice(0, 2), model: 'muse-spark-1.3' };
  shot.start = 1; shot.duration = 4;
  const times = storyboardTimes(shot, 24);
  assert.equal(times.length, 9); assert.deepEqual(times.slice(0, 8), [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]);
  assert.ok(Math.abs(times.at(-1)! - (5 - 1/24)) < 1e-8, 'last frame is before the next cut');
  shot.start = 0; shot.duration = 60;
  const frames: StoryboardFrame[] = storyboardTimes(shot, 30).map(time => ({at:time,previs:png}));
  const pages = Array.from({length:Math.ceil(frames.length/STORYBOARD_PAGE_SIZE)}, (_,page) => ({image:png,frames:frames.slice(page*STORYBOARD_PAGE_SIZE,(page+1)*STORYBOARD_PAGE_SIZE).map((frame,index)=>({index:page*STORYBOARD_PAGE_SIZE+index+1,at:frame.at}))}));
  assert.equal(frames.length,121); assert.equal(pages.length,14); assert.equal(pages.at(-1)!.frames.length,4);
  const svg = storyboardSVG({...shot,name:'Orbit <script> & reveal'},frames,13);
  assert.match(svg,/Storyboard 14 \/ 14/); assert.match(svg,/121 · 59\.97 s/); assert.ok(!svg.includes('<script>')); assert.match(svg,/Orbit &lt;script&gt; &amp; reveal/);
  const input = briefInput(doc,shot,'Keep all turns and pauses.',[{at:0,image:png,kind:'previs'},...pages.map(page=>({at:page.frames[0].at,image:page.image,kind:'storyboard' as const,tiles:page.frames}))]);
  const parsed = parseBriefInput(input), seen:StructuredRequest[]=[];
  await writeVideoBrief(parsed,fake(brief(),seen));
  assert.equal(seen.length,1); assert.equal(seen[0].content.filter(part=>part.type==='image').length,15);
  assert.match((seen[0].content[0] as {text:string}).text,/frame 121 at 59\.97 s/,'the final page reaches the writer');
  assert.throws(()=>parseBriefInput({...input,frames:input.frames.map(frame=>frame.kind==='storyboard'?{...frame,tiles:[...frame.tiles].reverse()}:frame)}),{code:'invalid_input'});
  // A long storyboard must pass the actual HTTP body reader, not just the schema. No paid provider is used.
  const largeImage = 'data:image/png;base64,' + Buffer.concat([Buffer.from(png.split(',')[1],'base64'),Buffer.alloc(350_000)]).toString('base64');
  const body = JSON.stringify({...input,frames:input.frames.map(frame=>({...frame,image:largeImage}))});
  assert.ok(Buffer.byteLength(body)>4_000_000 && Buffer.byteLength(body)<BRIEF_LIMITS.maxBodyBytes);
  const handler = createBriefHandler({MODEL_API_KEY:'test'},()=>fake(brief(),seen));
  const response = await handler(new Request('http://localhost/api/brief',{method:'POST',headers:{'Content-Type':'application/json'},body}));
  assert.equal(response.status,200); assert.equal(seen.length,2,'exactly one call per Generate');
  const blob = await videoPackage(doc, shot, result, 'pastel', frames, pages);
  const {manifest,files} = await readVideoPackage(blob);
  assert.equal(manifest.firstFrame,'first-frame.png'); assert.equal(manifest.storyboards?.length,14);
  assert.equal(manifest.previs,null); assert.ok(![...files.keys()].some(file=>/\.(webm|mp4)$/.test(file)));
  assert.deepEqual(manifest.storyboards?.flatMap(page=>page.frames).map(tile=>tile.at),frames.map(frame=>frame.at));
  const html = handoffPage(manifest,'example',1,'https://example.com');
  assert.match(html,/Storyboard page 14, frames 118 through 121/); assert.ok(!html.includes('<video'));
  const corrupt = structuredClone(manifest); corrupt.storyboards![13].frames[0].at = 0;
  const broken = new Blob([zipFiles([...files].map(([name,data])=>({name:`shot/${name}`,data:name==='manifest.json'?new TextEncoder().encode(JSON.stringify(corrupt)):data}))) as Uint8Array<ArrayBuffer>]);
  await assert.rejects(readVideoPackage(broken),/match every source frame/);
  // Previously published packets remain readable, including their optional viewing-only WebM.
  const legacy = structuredClone(manifest); delete legacy.firstFrame; delete legacy.storyboards; legacy.previs = 'previs.webm';
  const old = [...files].filter(([name])=>!name.startsWith('storyboard-')).map(([name,data])=>({name:`shot/${name}`,data:name==='manifest.json'?new TextEncoder().encode(JSON.stringify(legacy)):data}));
  old.push({name:'shot/previs.webm',data:new Uint8Array([26,69,223,163])});
  assert.equal((await readVideoPackage(new Blob([zipFiles(old) as Uint8Array<ArrayBuffer>]))).manifest.previs,'previs.webm');
  assert.match(briefMarkdown(shot, result, 'pastel'), /- 1\.00 s: He starts walking\./);
  assert.equal(zipFiles([]).length, 22);
});

test('a shot brief retains intermediate camera motion, and creator edits are identical in copied, downloaded and published prompts', async () => {
  const doc = scene(), shot = doc.shots[0], camera = doc.cameras[0];
  shot.start = 1; shot.duration = 3;
  camera.animation = emptyAnimation();
  putKey(camera.animation,'position.x',1,0); putKey(camera.animation,'position.x',2.5,2); putKey(camera.animation,'position.x',4,0);
  const input = parseBriefInput(briefInput(doc,shot,'Keep the deliberate pause and realistic hotel setting.',[{at:0,image:png,kind:'previs'},{at:1.5,image:png,kind:'previs'},{at:2.9,image:png,kind:'previs'}]));
  assert.equal(input.camera.samples?.length,9);
  assert.equal(input.camera.start.position[0],input.camera.end.position[0]);
  assert.equal(input.camera.samples?.[4].position[0],2,'a return path must not be described as a stationary camera');
  assert.equal(input.subjects[0].samples?.[0].at,0); assert.equal(input.subjects[0].samples?.at(-1)?.at,3);
  const seen:StructuredRequest[]=[];
  const generated:VideoBrief = await writeVideoBrief(input,fake(brief(),seen));
  assert.equal(seen.length,1,'one bounded model call per Generate prompt');
  const copied = videoPrompt(shot,generated,input.direction);
  for (const part of ['3.00-second','Camera:','Action timing','1.00 s','Avoid:','Read storyboard panels']) assert.ok(copied.includes(part));
  generated.promptText = 'Create a realistic hotel shot. Hold the bellboy still for the first second.\nThen follow his approach, keeping the sculpture on the right. No cuts.';
  const packageBlob = await videoPackage(doc,shot,generated,input.direction,[{at:0,previs:png}]);
  const {manifest,files} = await readVideoPackage(packageBlob);
  assert.equal(manifest.brief.promptText,generated.promptText);
  assert.equal(manifest.brief.prompt,generated.promptText); assert.equal(manifest.brief.camera,''); assert.deepEqual(manifest.brief.beats,[]);
  assert.equal(videoPrompt(shot,manifest.brief,'changed later'),generated.promptText,'creator edits are authoritative');
  const markdown = new TextDecoder().decode(files.get('brief.md'));
  assert.ok(markdown.includes(generated.promptText)); assert.ok(!markdown.includes(generated.camera),'old generated detail must not contradict the edited prompt');
  const html = handoffPage(manifest,'public-example',1,'https://example.com');
  assert.ok(html.includes(generated.promptText)); assert.ok(!html.includes('## Camera'));
  const legacy = structuredClone(manifest); legacy.brief = { ...generated }; delete legacy.brief.promptText;
  assert.ok(videoPrompt(legacy.shot,legacy.brief,legacy.direction).includes('Action timing'),'earlier packages remain readable');
});
