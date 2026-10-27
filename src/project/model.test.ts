import test from 'node:test';
import assert from 'node:assert/strict';
import { createCamera, createDocument, createObject, createShot, addIndependentShot, shotCamera, evaluateTransform, History, validateDocument } from '../model.ts';
import { applyProjectOperations, type SceneOperation } from '../scene-edit/operations.ts';
import { createProject, parseProject, serializeProject, ProjectStorage, PROJECT_STORAGE_KEY } from './storage.ts';
import { projectContent, serializeContent } from './model.ts';
import { proposeSceneEdit, parseSceneEditInput } from '../../server/scene-edit.ts';

test('an agent builds two scenes from nothing; cameras share actors while each shot keeps independent framing through export and undo', async () => {
  const blank = createProject(null), actor = createObject('human', 1), camera = createCamera('wide-camera', 'Wide');
  actor.track = { start: 1, duration: 3, from: structuredClone(actor.transform), to: { ...structuredClone(actor.transform), position: [2, 0, 0] } };
  const closeCamera = createCamera('close-camera', 'Close'); closeCamera.transform.position = [2, 2, 4]; closeCamera.fov = 30;
  const wide = createShot(camera, 'wide-shot', 4, 'Wide shot'), close = createShot(closeCamera, 'close-shot', 2, 'Closer shot');
  close.start = 2;
  const operations: SceneOperation[] = [
    { type: 'add_scene', sceneId: 'lobby', name: 'Lobby', duration: 6 },
    { type: 'add_object', sceneId: 'lobby', object: actor },
    { type: 'add_camera', sceneId: 'lobby', camera },
    { type: 'add_camera', sceneId: 'lobby', camera: closeCamera },
    { type: 'add_shot', sceneId: 'lobby', shot: wide },
    { type: 'add_shot', sceneId: 'lobby', shot: close },
    { type: 'add_scene', sceneId: 'room', name: 'Room', duration: 5 },
    { type: 'add_object', sceneId: 'room', object: createObject('cube', 1) },
  ];
  let calls = 0;
  const input = parseSceneEditInput({ project: projectContent(blank), sceneId: null, shotId: null, selectedId: null, time: 0, prompt: 'Build a lobby and another room.', snapshots: [] });
  const response = await proposeSceneEdit(input, { name: 'Test', model: 'test', async generateObject() { calls++; return { summary: 'Ready to review.', requestedViews: [], operations }; } });
  assert.equal(response.status, 'ready'); assert.equal(calls, 1); assert.equal(blank.scenes.length, 0, 'proposing never changes the project');
  const history = new History(projectContent(blank)), built = applyProjectOperations(projectContent(blank), operations, 0); history.commit(built);
  const original = serializeContent(built);
  const edited = applyProjectOperations(built, [
    { type: 'aim_camera', sceneId: 'lobby', id: 'close-camera', pose: 'static', position: [3, 2, 4], target: [0, 1, 0], fov: 35 },
    { type: 'translate', sceneId: 'lobby', id: 'object-1', offset: [1, 0, 0] },
  ], 2.5);
  assert.deepEqual(edited.scenes[1], built.scenes[1], 'same local object ID in another scene is untouched');
  assert.deepEqual(edited.scenes[0].shots[0], built.scenes[0].shots[0]);
  assert.deepEqual(edited.scenes[0].cameras[0], built.scenes[0].cameras[0]);
  assert.equal(shotCamera(edited.scenes[0], close.id)!.fov, 35);
  const a = evaluateTransform(edited.scenes[0].objects[0], 2.5);
  assert.equal(a.position[0], evaluateTransform(built.scenes[0].objects[0], 2.5).position[0] + 1);
  assert.equal(serializeContent(built), original, 'operations never alias source state');
  const file = serializeProject({ ...blank, ...edited, activeSceneId: 'lobby', activeShotId: 'close-shot' });
  const reopened = parseProject(file); assert.equal(serializeContent(reopened), serializeContent(edited)); assert.equal(reopened.activeShotId, 'close-shot');
  assert.deepEqual(history.undo(), projectContent(blank)); assert.deepEqual(history.redo(), built);
  for (const invalid of [
    [...operations, { type: 'add_shot', sceneId: 'room', shot: wide }],
    [...operations, { type: 'remove_camera', sceneId: 'lobby', id: 'wide-camera' }],
    [...operations, { type: 'add_shot', sceneId: 'lobby', shot: { ...wide, id: 'too-long', start: 5 } }],
    [...operations, { type: 'set_motion', sceneId: 'lobby', id: wide.id, track: actor.track }],
  ]) assert.throws(() => applyProjectOperations(projectContent(blank), invalid as SceneOperation[], 0));
  assert.equal(blank.scenes.length, 0);
  await assert.rejects(proposeSceneEdit(input, { name: 'Test', model: 'test', async generateObject() { return { summary: 'View it.', requestedViews: ['shot'], operations: [] }; } }));
});

test('v1 projects migrate the original camera motion and chat receipts without losing drafts or accepting broken references', () => {
  const source = createDocument(); source.objects[0].id = 'shot-1';
  const legacy = { format: 'LittleTake.scene', version: 1, name: source.name, duration: source.duration, objects: source.objects,
    camera: { id: 'camera', name: 'Shot camera', fov: source.cameras[0].fov, transform: source.cameras[0].transform, track: source.cameras[0].track } };
  const raw = { format: 'LittleTake.project', version: 1, scene: legacy, revision: 7, conversations: { activeId: 'thread-1', threads: [{ id: 'thread-1', title: 'Original thread', draft: 'Keep this draft', messages: [
    { id: 'user-1', role: 'user', text: 'Move the camera.', status: 'answered' },
    { id: 'reply-1', role: 'assistant', text: 'Preview.', model: 'Muse', edit: { time: 1, revision: 7, status: 'pending', operations: [{ type: 'translate', id: 'camera', offset: [1, 0, 0] }] } },
  ] }] } };
  const original = JSON.stringify(raw), disk = new Map([[PROJECT_STORAGE_KEY, original]]), storage = new ProjectStorage({ getItem: key => disk.get(key) ?? null, setItem: (key, value) => { disk.set(key, value); } });
  const project = storage.load().project;
  assert.equal(disk.get(PROJECT_STORAGE_KEY), original, 'reading does not overwrite an old file');
  assert.equal(project.version, 3); assert.deepEqual(shotCamera(project.scenes[0],project.scenes[0].shots[0].id)!.track, legacy.camera.track);
  assert.equal(project.scenes[0].objects[0].id, 'shot-1'); assert.equal(project.scenes[0].shots[0].id, 'shot-2');
  assert.equal(project.conversations.threads[0].draft, 'Keep this draft');
  const receipt = project.conversations.threads[0].messages[1];
  assert.ok(receipt.role === 'assistant' && receipt.edit); assert.equal(receipt.edit.status, 'stale');
  assert.deepEqual(receipt.edit.operations[0], { type: 'translate', id: 'camera', sceneId: 'scene-1', offset: [1, 0, 0] });
  storage.save(project); assert.deepEqual(parseProject(disk.get(PROJECT_STORAGE_KEY)!), project);
  const invalid = structuredClone(project); invalid.scenes[0].shots[0].cameraId = 'missing';
  assert.throws(() => validateDocument(invalid.scenes[0]));
  assert.throws(() => parseProject(JSON.stringify(invalid)));
  const duplicate = structuredClone(project); duplicate.scenes.push(structuredClone(duplicate.scenes[0]));
  assert.throws(() => parseProject(JSON.stringify(duplicate)));
});

test('v2 shared setups migrate without losing any shot, recording or chat; independent copies and camera edits survive undo and reopening', () => {
  const source=createDocument(),baseCamera=structuredClone(source.cameras[0]);
  source.objects[0].track!.samples=[{at:.5,transform:structuredClone(source.objects[0].track!.from)}];
  const wide={...structuredClone(baseCamera),...source.shots[0]};
  const close={...structuredClone(baseCamera),id:'close',name:'Close',cameraId:baseCamera.id,start:1,duration:3,fov:30};
  close.transform.position=[2,2,4];close.track={start:1,duration:3,from:structuredClone(close.transform),to:{...structuredClone(close.transform),position:[1,2,3]}};
  const unused=createCamera('camera-1','Unused setup');unused.transform.position=[-6,2,3];
  const oldScene={...source,version:2,cameras:[{...structuredClone(baseCamera),track:null},unused],shots:[wide,close]};
  const oldProject={...createProject(source),version:2,scenes:[oldScene]};
  const receipt={id:'reply',role:'assistant',text:'Prepared another angle.',model:'Muse',edit:{sceneId:source.id,shotId:wide.id,time:1,revision:0,status:'pending',operations:[{type:'add_shot',sceneId:source.id,shot:{...close,id:'proposed-shot'}}]}};
  const raw={...oldProject,conversations:{activeId:'thread',threads:[{id:'thread',title:'Original conversation',draft:'Keep my next instruction',messages:[{id:'user',role:'user',text:'Another angle.',status:'answered',context:{sceneId:source.id,shotId:wide.id,selectedId:wide.id,time:1}},receipt]}]}};
  const original=JSON.stringify(raw),disk=new Map([[PROJECT_STORAGE_KEY,original]]),storage=new ProjectStorage({getItem:key=>disk.get(key)??null,setItem:(key,value)=>{disk.set(key,value);}});
  const project=storage.load().project,scene=project.scenes[0];
  assert.equal(disk.get(PROJECT_STORAGE_KEY),original,'migration reads without overwriting the original');
  assert.equal(scene.version,3);assert.equal(scene.cameras.length,3);
  assert.equal(scene.shots[0].cameraId,baseCamera.id);assert.notEqual(scene.shots[0].cameraId,scene.shots[1].cameraId);
  assert.deepEqual(scene.cameras.find(camera=>camera.id===unused.id),unused,'unused framing is kept');
  assert.deepEqual(scene.objects,oldScene.objects,'recorded samples and actors remain untouched');
  for(const oldShot of oldScene.shots){
    const camera=shotCamera(scene,oldShot.id)!;assert.equal(camera.fov,oldShot.fov);
    for(const time of [oldShot.start,oldShot.start+oldShot.duration/2,oldShot.start+oldShot.duration])assert.deepEqual(evaluateTransform(camera,time),evaluateTransform(oldShot,time));
  }
  assert.deepEqual(Object.keys(scene.shots[0]).sort(),['cameraId','duration','id','name','start'],'shot carries no duplicate framing');
  const savedReceipt=project.conversations.threads[0].messages[1];assert.ok(savedReceipt.role==='assistant'&&savedReceipt.edit);
  assert.equal(savedReceipt.edit.status,'stale');assert.deepEqual(savedReceipt.edit.operations,receipt.edit.operations,'historical proposal details are preserved');
  assert.equal(project.conversations.threads[0].draft,'Keep my next instruction');
  const history=new History(projectContent(project)),before=structuredClone(scene);
  const copied=addIndependentShot(scene,scene.shots[1]),copyCamera=shotCamera(scene,copied.id)!;
  assert.notEqual(copyCamera.id,shotCamera(scene,'close')!.id);assert.deepEqual(copyCamera.track,shotCamera(scene,'close')!.track);
  const edited=applyProjectOperations(projectContent(project),[
    {type:'aim_camera',sceneId:scene.id,id:copyCamera.id,pose:'end',position:[4,3,7],target:[0,1,0],fov:55},
    {type:'set_shot_range',sceneId:scene.id,id:copied.id,cameraId:copyCamera.id,start:0,duration:2},
  ],1);
  assert.deepEqual(shotCamera(edited.scenes[0],'close'),shotCamera(before,'close'),'editing the duplicate never changes the original shot camera');
  assert.equal(shotCamera(edited.scenes[0],copied.id)!.track!.start,1,'shot range does not retime camera motion');
  assert.deepEqual(edited.scenes[0].objects,before.objects);
  history.commit(edited);assert.deepEqual(history.undo()!.scenes[0],before);assert.deepEqual(history.redo(),edited);
  Object.assign(project,edited);storage.save(project);assert.deepEqual(parseProject(disk.get(PROJECT_STORAGE_KEY)!),project);
  const shared=applyProjectOperations(edited,[{type:'set_shot_range',sceneId:scene.id,id:copied.id,cameraId:scene.shots[0].cameraId,start:0,duration:2}],0);
  assert.equal(shotCamera(shared.scenes[0],copied.id),shotCamera(shared.scenes[0],wide.id),'explicit reuse references the same camera');
  assert.throws(()=>applyProjectOperations(shared,[{type:'remove_camera',sceneId:scene.id,id:scene.shots[0].cameraId}],0));
  const dense={...oldScene,cameras:Array.from({length:24},(_,i)=>({...unused,id:`setup-${i}`})),shots:Array.from({length:100},(_,i)=>({...close,id:`shot-${i}`,cameraId:'setup-0'}))};
  assert.equal(validateDocument(dense).cameras.length,124,'all previously valid shot/setup counts can migrate');
});
