import test from 'node:test';
import assert from 'node:assert/strict';
import { createCamera, createDocument, createObject, createShot, evaluateTransform, History, validateDocument } from '../model.ts';
import { applyProjectOperations, type SceneOperation } from '../scene-edit/operations.ts';
import { createProject, parseProject, serializeProject, ProjectStorage, PROJECT_STORAGE_KEY } from './storage.ts';
import { projectContent, serializeContent } from './model.ts';
import { proposeSceneEdit, parseSceneEditInput } from '../../server/scene-edit.ts';

test('an agent builds two scenes from nothing; cameras share actors while each shot keeps independent framing through export and undo', async () => {
  const blank = createProject(null), actor = createObject('human', 1), camera = createCamera('wide-camera', 'Wide');
  actor.track = { start: 1, duration: 3, from: structuredClone(actor.transform), to: { ...structuredClone(actor.transform), position: [2, 0, 0] } };
  const wide = createShot(camera, 'wide-shot', 4, 'Wide shot'), close = createShot(camera, 'close-shot', 2, 'Closer shot');
  close.start = 2; close.transform.position = [2, 2, 4]; close.fov = 30;
  const operations: SceneOperation[] = [
    { type: 'add_scene', sceneId: 'lobby', name: 'Lobby', duration: 6 },
    { type: 'add_object', sceneId: 'lobby', object: actor },
    { type: 'add_camera', sceneId: 'lobby', camera },
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
    { type: 'aim_camera', sceneId: 'lobby', id: 'close-shot', pose: 'static', position: [3, 2, 4], target: [0, 1, 0], fov: 35 },
    { type: 'translate', sceneId: 'lobby', id: 'object-1', offset: [1, 0, 0] },
  ], 2.5);
  assert.deepEqual(edited.scenes[1], built.scenes[1], 'same local object ID in another scene is untouched');
  assert.deepEqual(edited.scenes[0].shots[0], built.scenes[0].shots[0]);
  assert.deepEqual(edited.scenes[0].cameras[0], built.scenes[0].cameras[0]);
  assert.equal(edited.scenes[0].shots[1].fov, 35);
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
    [...operations, { type: 'set_motion', sceneId: 'lobby', id: camera.id, track: actor.track }],
  ]) assert.throws(() => applyProjectOperations(projectContent(blank), invalid as SceneOperation[], 0));
  assert.equal(blank.scenes.length, 0);
  await assert.rejects(proposeSceneEdit(input, { name: 'Test', model: 'test', async generateObject() { return { summary: 'View it.', requestedViews: ['shot'], operations: [] }; } }));
});

test('v1 projects migrate the original camera motion and chat receipts without losing drafts or accepting broken references', () => {
  const source = createDocument(); source.objects[0].id = 'shot-1';
  const legacy = { format: 'LittleTake.scene', version: 1, name: source.name, duration: source.duration, objects: source.objects,
    camera: { id: 'camera', name: 'Shot camera', fov: source.shots[0].fov, transform: source.shots[0].transform, track: source.shots[0].track } };
  const raw = { format: 'LittleTake.project', version: 1, scene: legacy, revision: 7, conversations: { activeId: 'thread-1', threads: [{ id: 'thread-1', title: 'Original thread', draft: 'Keep this draft', messages: [
    { id: 'user-1', role: 'user', text: 'Move the camera.', status: 'answered' },
    { id: 'reply-1', role: 'assistant', text: 'Preview.', model: 'Muse', edit: { time: 1, revision: 7, status: 'pending', operations: [{ type: 'translate', id: 'camera', offset: [1, 0, 0] }] } },
  ] }] } };
  const original = JSON.stringify(raw), disk = new Map([[PROJECT_STORAGE_KEY, original]]), storage = new ProjectStorage({ getItem: key => disk.get(key) ?? null, setItem: (key, value) => { disk.set(key, value); } });
  const project = storage.load().project;
  assert.equal(disk.get(PROJECT_STORAGE_KEY), original, 'reading does not overwrite an old file');
  assert.equal(project.version, 2); assert.deepEqual(project.scenes[0].shots[0].track, legacy.camera.track);
  assert.equal(project.scenes[0].objects[0].id, 'shot-1'); assert.equal(project.scenes[0].shots[0].id, 'shot-2');
  assert.equal(project.scenes[0].cameras[0].track, null);
  assert.equal(project.conversations.threads[0].draft, 'Keep this draft');
  const receipt = project.conversations.threads[0].messages[1];
  assert.ok(receipt.role === 'assistant' && receipt.edit); assert.equal(receipt.edit.status, 'stale');
  assert.deepEqual(receipt.edit.operations[0], { type: 'translate', id: 'shot-2', sceneId: 'scene-1', offset: [1, 0, 0] });
  storage.save(project); assert.deepEqual(parseProject(disk.get(PROJECT_STORAGE_KEY)!), project);
  const invalid = structuredClone(project); invalid.scenes[0].shots[0].cameraId = 'missing';
  assert.throws(() => validateDocument(invalid.scenes[0]));
  assert.throws(() => parseProject(JSON.stringify(invalid)));
  const duplicate = structuredClone(project); duplicate.scenes.push(structuredClone(duplicate.scenes[0]));
  assert.throws(() => parseProject(JSON.stringify(duplicate)));
});
