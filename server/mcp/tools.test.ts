import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProject } from '../../src/project/storage.ts';
import type { ProjectRoom } from '../../src/project/room.ts';
import { createProjectRoomsHandler } from '../projects/api.ts';
import { ProjectRoomStore } from '../projects/store.ts';
import { LittleTakeRoom } from './room.ts';
import { littleTakeTools } from './tools.ts';

async function setup(t: test.TestContext, project: unknown) {
  const directory = await mkdtemp(path.join(tmpdir(), 'littletake-mcp-')), store = new ProjectRoomStore(directory);
  const handler = createProjectRoomsHandler(store), browser = randomUUID();
  t.after(() => store.close());
  const created = await (await handler(new Request('http://localhost/api/projects', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-littletake-edit-lease': browser }, body: JSON.stringify({ action: 'create', id: randomUUID(), project }) }))).json() as ProjectRoom;
  const room = new LittleTakeRoom('http://localhost', (input, init) => handler(new Request(input, init)));
  t.after(() => room.close());
  const tools = Object.fromEntries(littleTakeTools(room).map(tool => [tool.name, tool]));
  return { store, code: created.code, tools, call: (name: string, args: Record<string, unknown> = {}) => tools[name].run(args) as Promise<any> };
}

test('an agent edits a project room beside a browser editor; invalid operations change nothing', async t => {
  const { store, code, call } = await setup(t, createProject());
  assert.ok((await call('list_projects')).projects.some((item: { code: string }) => item.code === code));
  const opened = await call('open_project', { code }), sceneId = opened.scenes[0].id;
  assert.equal(opened.scenes.length, 1);
  const result = await call('apply_operations', { operations: [
    { type: 'add_object', sceneId, object: { id: 'crate', name: 'Crate', kind: 'cube', color: '#aa7744', transform: { position: [0, .5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, track: null } },
    { type: 'set_property_keys', sceneId, id: 'crate', path: 'position.x', keys: [{ time: 0, value: 0, interpolation: 'smooth' }, { time: 2, value: 3, interpolation: 'smooth' }] },
  ] });
  assert.equal(result.changed, true);
  const saved = store.get(code).project.scenes[0].objects.find(item => item.id === 'crate');
  assert.equal(saved?.name, 'Crate'); assert.deepEqual(saved?.animation?.curves['position.x']?.map(key => key.value), [0, 3]);
  assert.ok((await call('get_scene')).objects.some((item: { id: string; animated: string[] }) => item.id === 'crate' && item.animated.includes('position.x')));
  await assert.rejects(call('apply_operations', { operations: [{ type: 'remove_object', sceneId, id: 'crate' }, { type: 'set_color', sceneId, id: 'crate', color: 'red' }] }), /Invalid operations/);
  await assert.rejects(call('apply_operations', { operations: [{ type: 'remove_object', sceneId, id: 'missing' }] }));
  assert.ok(store.get(code).project.scenes[0].objects.some(item => item.id === 'crate'), 'a rejected batch leaves the room unchanged');
  assert.deepEqual(Object.keys((await call('operation_schema', { types: ['aim_camera'] }))), ['aim_camera']);
});

test('check_visibility sees occlusion from the camera, and inspect_parts reports posed asset parts', async t => {
  const { code, call } = await setup(t, createProject());
  const sceneId = (await call('open_project', { code })).scenes[0].id;
  const cube = (id: string, position: number[], scale = [1, 1, 1]) => ({ type: 'add_object', sceneId, object: { id, name: id, kind: 'cube', color: '#888888', transform: { position, rotation: [0, 0, 0], scale }, track: null } });
  await call('apply_operations', { operations: [cube('target', [0, 1, 0]), cube('wall', [0, 1, 4], [3, 3, .2]),
    { type: 'add_camera', sceneId, camera: { id: 'eye', name: 'Eye', fov: 40, transform: { position: [0, 1, 10], rotation: [0, 0, 0], scale: [1, 1, 1] }, track: null } },
    { type: 'aim_camera', sceneId, id: 'eye', pose: 'static', position: [0, 1, 10], target: [0, 1, 0], fov: 40 }] });
  const hidden = await call('check_visibility', { id: 'target', time: 0, cameraId: 'eye' });
  assert.equal(hidden.inFrame, 1); assert.equal(hidden.visible, 0);
  await call('apply_operations', { operations: [{ type: 'remove_object', sceneId, id: 'wall' }] });
  const seen = await call('check_visibility', { id: 'target', time: 0, cameraId: 'eye' });
  assert.ok(seen.visible > .9, JSON.stringify(seen)); assert.ok(seen.visibleBox[0] > .3 && seen.visibleBox[2] < .7);

  const example = JSON.parse(await readFile('public/examples/knight-vs-dragon.json', 'utf8'));
  const knight = await setup(t, example);
  await knight.call('open_project', { code: knight.code });
  const head = (await knight.call('inspect_parts', { id: 'dragon', time: 6.5, parts: [{ partId: 'head' }, { partId: 'nope' }] })).parts;
  assert.ok(head[0].position[2] > -3 && head[0].position[1] > 0, JSON.stringify(head[0])); assert.match(head[1].error, /No such part/);
  const shield = await knight.call('check_visibility', { id: 'knight', time: 6.6, cameraId: 'cam-fire', partPrefix: 'shield' });
  assert.ok(shield.inFrame > .9 && shield.visible <= shield.inFrame, JSON.stringify(shield));
});
