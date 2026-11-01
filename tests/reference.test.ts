import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Euler, MathUtils } from 'three';
import { MetaProvider, parseSAMRegions } from '../server/ai/meta.ts';
import { readFileSync } from 'node:fs';
import { AIError, type AIProvider, type StructuredRequest } from '../server/ai/provider.ts';
import { analyzeReference, parseReferenceInput } from '../server/reference/analyze.ts';
import { proposalFromScene, sceneFromProposal } from '../server/reference/draft.ts';
import { createReferenceHandler } from '../server/reference-api.ts';
import { cloneDocument, evaluateFov, evaluateTransform, History, serializeDocument, parseDocument, shotAtTime } from '../src/model.ts';
import { DEFAULT_SCENE_LOOK } from '../src/scene-edit/look.ts';
import { applyProjectOperations } from '../src/scene-edit/operations.ts';
import { serializeContent, validateProjectContent } from '../src/project/model.ts';

const pose = (x = 0) => ({ position: [x, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
const proposal = () => ({
  name: 'An entrance', summary: 'A person walks towards a block. The camera stays still.', assumptions: ['Depth and scale are estimated.'],
  look: {...DEFAULT_SCENE_LOOK,background:'#eac3ac',ground:'#9e1534'},
  bindings:[],
  objects: [
    { name: 'Performer', kind: 'human', color:'#582273',transform: { ...pose(-2), position: [-2, 0, 0] }, motion: [{time:.5,pose:pose(-2)},{time:1.4,pose:pose(0)},{time:1.8,pose:pose(0)},{time:2.8,pose:pose(1)}] },
    { name: 'Block', kind: 'cube', color:'#d18f79',transform: pose(2), motion: null },
  ],
  shots: [
    {name:'Wide',start:0,duration:3,position:[5,3,8],target:[0,.9,0],fov:45,motion:null},
    {name:'Follow',start:3,duration:3,position:[2,2,5],target:[1,1,0],fov:35,motion:[{time:3,pose:{position:[2,2,5],target:[1,1,0]}},{time:4,pose:{position:[3,2,5],target:[1,1,0]}},{time:6,pose:{position:[4,2,4],target:[1,1,0]}}]},
  ],
});
const input = () => ({ video: { dataUrl: 'data:video/mp4;base64,' + Buffer.from([0, 0, 0, 16, ...Buffer.from('ftyp'), 0, 0, 0, 0]).toString('base64'), duration: 6, width: 640, height: 360 }, direction: '' });
const motionVideo='data:video/mp4;base64,'+Buffer.from([0,0,0,16,...Buffer.from('ftyp'),0,0,0,1]).toString('base64');
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('https://littletake.vercel.app/api/reference', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const nativePlan=()=>{const {scene}=sceneFromProposal(proposal(),6),sceneId=scene.id;return {summary:'Native editable reconstruction',requestedViews:[],objectCounts:[],operations:[{type:'add_scene',sceneId,name:scene.name,duration:scene.duration},{type:'set_scene_look',sceneId,look:scene.look},...scene.objects.map(object=>({type:'add_object',sceneId,object})),...scene.cameras.map(camera=>({type:'add_camera',sceneId,camera})),...scene.shots.map(shot=>({type:'add_shot',sceneId,shot}))]};};
const minimalAnalysis=()=>({summary:'A performer approaches a block.',entities:[{name:'Performer',description:'Main person',color:'#582273',principal:true}],shots:[{start:0,duration:3,framing:'full_body' as const,description:'Wide'},{start:3,duration:3,framing:'full_body' as const,description:'Follow'}],frames:[{time:1,shotIndex:0,subjects:[{name:'Performer',box:[.2,.2,.4,.9] as [number,number,number,number],headBox:null,bodyRegionId:null,headRegionId:null,facing:'right' as const,action:'walk'}],setting:'Warm set'}],assumptions:[]});

test('source observations use separate images; repaired drafts require a new inspection and preserve raw failed attempts', async()=>{
  const jpeg='data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
  const analysis={summary:'A person approaches a block.',entities:[{name:'Performer',description:'Main person',color:'#582273',principal:true}],shots:[{start:0,duration:3,framing:'full_body',description:'Wide'},{start:3,duration:3,framing:'full_body',description:'Follow'}],frames:[{time:1,shotIndex:0,subjects:[{name:'Performer',box:[.2,.2,.4,.9],headBox:null,bodyRegionId:'p0',headRegionId:null,facing:'right',action:'walk'}],setting:'Warm set'},{time:4,shotIndex:1,subjects:[{name:'Performer',box:[.3,.1,.6,.95],headBox:null,bodyRegionId:'p1',headRegionId:null,facing:'left',action:'stop'}],setting:'Warm set'}],assumptions:['Proxy hands are static.']};
  const source={cuts:[3],contactSheet:jpeg,frames:analysis.frames.map(({time,shotIndex},frameIndex)=>({time,shotIndex,frameIndex,dataUrl:jpeg}))};
  let calls=0,measurements=0;
  const handler=createReferenceHandler({},()=>({name:'Test',model:'test',async segmentMedia(media,concept){measurements++;assert.equal(media.type,'image');return [{index:0,regions:concept==='face'?[]:analysis.frames.map((frame,i)=>{const [x0,y0,x1,y1]=frame.subjects[0].box;return {id:String(i),confidence:1,box:[(x0+i)/2,(24+y0*360)/384,(x1+i)/2,(24+y1*360)/384] as [number,number,number,number]};})}];},async generateObject(request){calls++;
    if(request.schemaName==='reference_observations'){assert.equal(request.content.filter(p=>p.type==='image').length,2);assert.ok(request.content.some(p=>p.type==='video'));assert.ok(request.instructions.includes('ONE FULL VIDEO FRAME'));const response=structuredClone(analysis);response.frames.forEach(frame=>{frame.subjects[0].box=[0,0,.1,.1];});return response;}
    if(request.schemaName==='littletake_scene_edit')return nativePlan();
    assert.deepEqual(request.content.filter(part=>part.type==='video').map(part=>part.dataUrl),[input().video.dataUrl,motionVideo],'Review original and rendered motion as separate native videos.');
    const approved=calls>=7;
    const revised=structuredClone(analysis);revised.frames[0].subjects[0].facing='front';revised.frames[0].subjects[0].box=[0,0,.1,.1];
    return {approved,notes:approved?'The unchanged rendered draft passes.':'Camera is too far away.',scores:{composition:approved?8:5,motion:8,layout:8,color:8},issues:approved?[]:[{shotIndex:0,time:1,problem:'Subject too small',correction:'Move the camera closer'}],revisedAnalysis:calls===8?revised:approved?null:revised};
  },async generateToolTurn(request){calls++;const messages=request.input as {type:string;content?:{type:string;text?:string}[]}[];assert.ok(messages.some(message=>message.content?.some(part=>part.type==='input_video')),'Reference native video must remain a video in tool turns.');const context=JSON.parse(messages.find(message=>message.content?.some(part=>part.text?.includes('sceneIndex')))!.content![0].text!);const plan=context.project.scenes.length?{summary:'Move the existing camera closer.',requestedViews:[],objectCounts:[],operations:[{type:'translate',sceneId:'scene-1',id:'camera-1',offset:[.2,0,0]}]}:nativePlan();if(!messages.some(message=>message.type==='function_call_output'))return {output:[],calls:[{id:'scene-inspection',name:'render_scene',arguments:JSON.stringify({sceneId:'scene-1',frames:analysis.frames.map(frame=>({shotId:'shot-'+(frame.shotIndex+1),time:frame.time})),operations:plan.operations})}],text:''};const inspected=JSON.parse((request.input as any[]).filter(item=>item.type==='function_call_output').at(-1).output);return {output:[],calls:[],text:JSON.stringify({...plan,operations:[],scenePreviewId:inspected.scenePreviewId})};}}));
  const observed=await(await handler(request({...input(),source}))).json();assert.equal(calls,1);assert.equal(measurements,2);assert.equal(observed.diagnostic.attempts.length,1);assert.ok(!observed.scene);for(const [i,frame] of observed.analysis.frames.entries())frame.subjects[0].box.forEach((value:number,axis:number)=>assert.ok(Math.abs(value-analysis.frames[i].subjects[0].box[axis])<1e-9,'Use measured pixels, never the observer\'s copied coordinates.'));
  assert.equal(observed.diagnostic.derivations.length,2);assert.ok(!JSON.stringify(observed.diagnostic).includes('data:image/png;base64,'),'Reproducible source overlays must not overflow a serverless response with repeated PNGs.');
  const initial=await(await handler(request({...input(),source,analysis:observed.analysis}))).json();assert.equal(calls,3);assert.equal(initial.diagnostic.attempts.length,1);assert.equal(initial.diagnostic.toolTurns.length,2);
  assert.ok(!JSON.stringify(initial.diagnostic).includes(input().video.dataUrl));
  const review={scene:initial.scene,contactSheet:jpeg,video:motionVideo,frames:analysis.frames.map(f=>({shotId:'shot-'+(f.shotIndex+1),time:f.time})),sourceRegions:analysis.frames.map((frame,i)=>({time:frame.time,detections:observed.regions[i].detections}))};
  const rejected=await(await handler(request({...input(),analysis,review}))).json();assert.equal(rejected.quality.approved,false);assert.equal(calls,4);
  assert.ok(!JSON.stringify(rejected.diagnostic).includes(motionVideo),'Motion pixels remain in the preserved client input, not repeated inside server diagnostics.');
  assert.equal(rejected.analysis.frames[0].subjects[0].facing,'front');assert.ok(Math.abs(rejected.analysis.frames[0].subjects[0].box[0]-.2)<1e-9,'Correct identity/facing without replacing measured pixels.');
  assert.deepEqual(rejected.scene,initial.scene,'A review never secretly replaces geometry.');
  const repaired=await(await handler(request({...input(),source,analysis:rejected.analysis,repair:{scene:rejected.scene,assets:rejected.assets,quality:rejected.quality}}))).json();assert.equal(calls,6);assert.notDeepEqual(repaired.scene.cameras[0].transform,initial.scene.cameras[0].transform);assert.deepEqual(repaired.scene.objects,initial.scene.objects);assert.equal(repaired.scene.id,initial.scene.id);
  const accepted=await(await handler(request({...input(),analysis:repaired.analysis,review:{...review,scene:repaired.scene}}))).json();assert.equal(accepted.quality.approved,true);assert.deepEqual(accepted.scene,repaired.scene);assert.deepEqual(accepted.analysis,repaired.analysis);assert.equal(calls,7);
  const invalid=await handler(request({...input(),analysis,review}));assert.equal(invalid.status,502);const failure=await invalid.json();assert.equal(failure.diagnostic.attempts.length,1);assert.equal(failure.error.code,'invalid_review');assert.equal(calls,8);
  assert.equal(measurements,2,'Visual correction must reuse the source measurements.');
  const measured=parseSAMRegions(readFileSync(new URL('../src/reference/fixtures/sam-boxes.txt',import.meta.url),'utf8'));assert.equal(measured[0].regions.length,4);assert.deepEqual(measured[0].regions.find(r=>r.id==='1')!.box,[104/640,32/360,416/640,352/360]);
});

test('reference proposal becomes ordinary independently editable objects and an aimed camera', () => {
  const { scene } = sceneFromProposal(proposal(), 6);
  assert.deepEqual(scene.objects.map(item => [item.id, item.kind, item.color]), [['object-1', 'human', '#582273'], ['object-2', 'cube', '#d18f79']]);
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
  const replay=sceneFromProposal(proposalFromScene(scene),6).scene;
  for(const time of [0,.5,1.7,3,4,6])for(const entity of [...scene.objects,...scene.cameras]){const restored=[...replay.objects,...replay.cameras].find(e=>e.id===entity.id)!,before=evaluateTransform(entity,time),after=evaluateTransform(restored,time);before.position.forEach((value,axis)=>assert.ok(Math.abs(value-after.position[axis])<1e-9));const direction=(rotation:number[])=>new Vector3(0,0,-1).applyEuler(new Euler(...rotation.map(MathUtils.degToRad) as [number,number,number]));assert.ok(direction(before.rotation).distanceTo(direction(after.rotation))<1e-8,'Absolute review serialization must preserve the actual camera/actor direction.');}
});

test('reference color, cuts and motion survive editing, scene deletion, undo and project reload', () => {
  const {scene}=sceneFromProposal(proposal(),6);
  const original={name:'Reference project',scenes:[scene]},history=new History(original);
  assert.equal(shotAtTime(scene,2.999)?.id,'shot-1');
  assert.equal(shotAtTime(scene,3)?.id,'shot-2');
  assert.equal(shotAtTime(scene,6)?.id,'shot-2');
  assert.deepEqual(evaluateTransform(scene.objects[0],1.5).position,evaluateTransform(scene.objects[0],1.7).position);
  assert.notDeepEqual(evaluateTransform(scene.objects[0],.5).position,evaluateTransform(scene.objects[0],2.8).position);
  assert.notDeepEqual(evaluateTransform(scene.cameras[1],3).position,evaluateTransform(scene.cameras[1],6).position);
  let project=applyProjectOperations(original,[
    {type:'set_scene_look',sceneId:scene.id,look:{...scene.look!,exposure:.85}},
    {type:'set_color',sceneId:scene.id,id:'object-2',color:'#cba179'},
    {type:'translate',sceneId:scene.id,id:'object-1',offset:[2,0,0]},
    {type:'set_property_keys',sceneId:scene.id,id:'camera-2',path:'fov',keys:[{time:3,value:35,interpolation:'linear'},{time:6,value:45,interpolation:'linear'}]},
    {type:'set_camera_motion',sceneId:scene.id,id:'camera-2',frames:[{time:3,position:[2,2,5],target:[1,1,0]},{time:4.5,position:[3,2,4],target:[2,1,0]},{time:6,position:[4,2,3],target:[3,1,0]}]},
    {type:'add_scene',sceneId:'scene-other',name:'Another set',duration:5},
  ],2);
  const expected=structuredClone(project);history.commit(project);
  project=applyProjectOperations(project,[{type:'remove_scene',sceneId:scene.id}],2);history.commit(project);
  assert.equal(project.scenes[0].id,'scene-other');
  project=history.undo()!;
  const reopened=validateProjectContent(JSON.parse(serializeContent(project)));
  assert.deepEqual(reopened,expected);
  assert.equal(reopened.scenes[0].look!.exposure,.85);
  assert.equal(reopened.scenes[0].objects[1].color,'#cba179');
  assert.equal(reopened.scenes[0].objects[0].track!.samples!.length,2);
  assert.equal(evaluateTransform(reopened.scenes[0].objects[0],1.5).position[0],2);
  assert.equal(shotAtTime(reopened.scenes[0],3)?.cameraId,'camera-2');
  assert.equal(evaluateFov(reopened.scenes[0].cameras[1],4.5),40,'Replacing the camera path preserves its independent lens keys.');
  for(const [time,target] of [[3,[1,1,0]],[4.5,[2,1,0]],[6,[3,1,0]]] as [number,[number,number,number]][]){const pose=evaluateTransform(reopened.scenes[0].cameras[1],time),forward=new Vector3(0,0,-1).applyEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as [number,number,number])),expected=new Vector3(...target).sub(new Vector3(...pose.position)).normalize();assert.ok(forward.dot(expected)>1-1e-8,'Native camera targets remain aimed after compilation and project reload.');}
  project=applyProjectOperations(project,project.scenes.map(scene=>({type:'remove_scene' as const,sceneId:scene.id})),0);
  assert.deepEqual(validateProjectContent(JSON.parse(serializeContent(project))).scenes,[]);
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
    (value: ReturnType<typeof proposal>) => { value.objects[0].motion![3].time = 30; },
    (value: ReturnType<typeof proposal>) => { value.shots[0].target = [...value.shots[0].position]; },
    (value: ReturnType<typeof proposal>) => { value.shots[1].start = 4; },
    (value: ReturnType<typeof proposal>) => { value.shots.pop(); },
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
  const replacement: AIProvider = { name: 'Replacement', model: 'test-model', async generateObject(value) { seen = value; return nativePlan(); } };
  const draft = await analyzeReference({...input(),analysis:minimalAnalysis()}, replacement);
  assert.ok('scene' in draft);
  assert.equal(draft.provider, 'Replacement'); assert.equal(draft.scene.objects.length, 2);
  assert.ok(seen!.content.some(part=>part.type==='video')); assert.ok(seen!.instructions.includes('DEGREES'));
});

test('Meta adapter sends native video, a strict schema and server-side credentials', async () => {
  let sent: Record<string, unknown> | undefined;
  const provider = new MetaProvider({ apiKey: 'server-only-test-secret', model: 'muse-test' }, async (url, options) => {
    assert.equal(url, 'https://api.meta.ai/v1/responses');
    assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer server-only-test-secret');
    sent = JSON.parse(String(options!.body));
    if(sent!.model==='sam-3.1')return Response.json({status:'completed',output_text:readFileSync(new URL('../src/reference/fixtures/sam-boxes.txt',import.meta.url),'utf8')});
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal()) }] }] });
  });
  const draft = await provider.generateObject({instructions:'Use native video in DEGREES.',content:[{type:'text',text:'Reference'},{type:'video',dataUrl:input().video.dataUrl}],schema: {type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},schemaName:'wire_reference',reasoningEffort:'high'});
  assert.equal(sent!.store, false); assert.equal(provider.model, 'muse-test');
  assert.deepEqual(sent!.reasoning,{effort:'high'});
  const payload = sent as { text: { format: { strict: boolean } }; input: { content: { type: string; video_url?: string }[] }[] };
  assert.equal(payload.text.format.strict, true);
  const strictSchema=(sent!.text as {format:{schema:{properties:Record<string,unknown>;required:string[]}}}).format.schema;
  assert.deepEqual(new Set(strictSchema.required),new Set(Object.keys(strictSchema.properties)),'Meta strict schemas require every declared property, including compound reference bindings.');
  assert.equal(payload.input[0].content[1].type, 'input_video');
  assert.equal(payload.input[0].content[1].video_url, input().video.dataUrl);
  assert.ok(!JSON.stringify(draft).includes('server-only-test-secret'));
  const measured=await provider.segmentMedia({type:'image',dataUrl:'data:image/jpeg;base64,/9j/'},'person');assert.equal(measured[0].regions.length,4);assert.equal(sent!.model,'sam-3.1');assert.ok(!sent!.reasoning&&!sent!.max_output_tokens,'The segmentation model does not take text reasoning settings.');
});

test('Meta credits errors and unfinished output are explicit; no fake scene fallback', async () => {
  const config = { apiKey: 'test-key', model: 'test' };
  const noCredits = new MetaProvider(config, async () => Response.json({ error: { message: 'secret provider diagnostics' } }, { status: 402 }));
  const wire={instructions:'test',content:[],schema:{},schemaName:'test'};
  await assert.rejects(noCredits.generateObject(wire), (error: unknown) => error instanceof AIError && error.code === 'credits_required' && !error.message.includes('diagnostics'));
  const unfinished = new MetaProvider(config, async () => Response.json({ status: 'incomplete', output_text: JSON.stringify(proposal()) }));
  await assert.rejects(unfinished.generateObject(wire), (error: unknown) => error instanceof AIError && error.code === 'incomplete_response');
  let raw:unknown;await assert.rejects(unfinished.generateToolTurn({instructions:'test',input:[],tools:[],schema:{},onResponse:response=>{raw=response;}}),/did not finish/);assert.equal((raw as {status:string}).status,'incomplete','Keep the actual partial tool response before rejecting it.');
});

test('API exposes connection state without a key, and checks input before calling a provider', async () => {
  let calls = 0;
  const handler = createReferenceHandler({ MODEL_API_KEY: 'never-return-this-key' }, () => ({ name: 'Test', model: 'test', async generateObject(request) { calls++; return request.schemaName==='reference_visual_review'?{approved:true,notes:'Test review.',scores:{composition:8,motion:8,layout:8,color:8},issues:[],revisedAnalysis:null}:nativePlan(); } }));

  const connection = await handler(new Request('https://littletake.vercel.app/api/reference'));
  assert.deepEqual(await connection.json(), { available: true, provider: 'Meta', model: 'muse-spark-1.3' });
  assert.equal((await handler(request({}))).status, 400);
  assert.equal((await handler(request(input(), { origin: 'https://another.example' }))).status, 403);
  assert.equal(calls, 0);
  const response = await handler(request({...input(),analysis:minimalAnalysis()})); assert.equal(response.status, 200);
  assert.equal((await response.json()).scene.objects.length, 2); assert.equal(calls, 1);
  const review={scene:sceneFromProposal(proposal(),6).scene,contactSheet:'data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64'),video:motionVideo,frames:[{shotId:'shot-2',time:4}]};
  assert.equal((await handler(request({...input(),review:{...review,frames:[{shotId:'missing',time:4}]}}))).status,400);
  assert.equal(calls,1);
  const reviewed=await handler(request({...input(),analysis:minimalAnalysis(),review}));assert.equal(reviewed.status,200);assert.equal(calls,2);
  assert.equal((await reviewed.json()).scene.shots.length,2);
  const missingMotion=await handler(request({...input(),analysis:minimalAnalysis(),review:{...review,video:undefined}}));assert.equal(missingMotion.status,502,'Still-only approval must not pass full motion verification.');
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
  const oversized = request({ padding: 'x'.repeat(4_400_001) });
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
  const provider: AIProvider = { name: 'Replacement', model: 'test-model', async generateObject(value) { seen = value; return {...proposal(),shots:[{...proposal().shots[0],duration:5}]}; } };
  const draft = await analyzeReference(parseReferenceInput(sketch()), provider);
  assert.equal(draft.scene.duration, 5); assert.equal(draft.scene.shots[0].duration, 5);
  assert.deepEqual(seen!.content.map(part => part.type), ['text', 'image']);
  assert.match(seen!.instructions, /storyboard panel, a rough sketch/); assert.match(seen!.instructions, /arrows/); assert.ok(seen!.instructions.includes('DEGREES'));
  assert.match((seen!.content[0] as { text: string }).text, /Scene duration: 5\.000 seconds/);

});

test('the API stages an image without starting SAM video tracking', async () => {
  let tracked = 0;
  const handler = createReferenceHandler({ MODEL_API_KEY: 'test-key' }, () => ({ name: 'Test', model: 'test', async generateObject() { return {...proposal(),shots:[{...proposal().shots[0],duration:5}]}; } }),
    () => async () => { tracked++; return { boxes: [], frames: 0 } as never; });
  const response = await handler(request(sketch()));
  assert.equal(response.status, 200); assert.equal((await response.json()).scene.duration, 5); assert.equal(tracked, 0);
  assert.equal((await handler(request(sketch('data:image/png;base64,' + Buffer.from('fake').toString('base64'))))).status, 400);
});
