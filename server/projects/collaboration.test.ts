import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProject, parseProject, serializeProject, type ProjectDocument } from '../../src/project/storage.ts';
import { projectChanges, projectView } from '../../src/project/changes.ts';
import { ProjectCollaboration } from '../../src/project/collaboration.ts';
import { putKey, emptyAnimation } from '../../src/animation/model.ts';
import { History, createObject } from '../../src/model.ts';
import { projectContent } from '../../src/project/model.ts';
import { newConversation } from '../../src/scene-edit/conversations.ts';
import { applyProjectOperations } from '../../src/scene-edit/operations.ts';
import { EDIT_LEASE_MS, type ProjectRoom } from '../../src/project/room.ts';
import { ProjectRoomStore } from './store.ts';
import { startApplication } from '../app/service.ts';

test('server-ordered edits merge properties, entity creation, animation and chats; retries, undo, deletion and restart preserve collaborators', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'littletake-collaboration-'));
  let now = Date.now(), store = new ProjectRoomStore(directory, () => now);
  const other = new ProjectRoomStore(directory, () => now);
  t.after(() => { store.close(); other.close(); });
  const alice = randomUUID(), bob = randomUUID(), pageA = randomUUID(), pageB = randomUUID();
  const initial = createProject(), room = store.create(randomUUID(), alice, initial, undefined, [], pageA);
  other.claim(room.code, bob, pageB);
  const edit = (client: 'a' | 'b', before: ProjectDocument, after: ProjectDocument, guard = false, id = randomUUID()) =>
    (client === 'a' ? store : other).edit(room.code, client === 'a' ? alice : bob, id, projectChanges(before, after).map(change => guard ? { ...change, guard: true, own: true } : change), after.revision, client === 'a' ? pageA : pageB);
  const a = structuredClone(initial), b = structuredClone(initial);
  a.scenes[0].objects[0].transform.position[0] = 8;
  b.scenes[0].objects[0].transform.position[2] = 6;
  b.scenes[0].objects[1].name = 'Bob renamed this';
  const history = new History(projectContent(initial)); history.commit(projectContent(a));
  const firstId = randomUUID(); edit('a', initial, a, false, firstId);
  let merged = edit('b', initial, b).project;
  assert.equal(merged.scenes[0].objects[0].transform.position[0], 8);
  assert.equal(merged.scenes[0].objects[0].transform.position[2], 6);
  history.receive(projectContent(merged));
  let undone = { ...merged, ...history.undo()! };
  merged = edit('a', merged, undone, true).project;
  assert.equal(merged.scenes[0].objects[0].transform.position[0], initial.scenes[0].objects[0].transform.position[0]);
  assert.equal(merged.scenes[0].objects[0].transform.position[2], 6);
  assert.equal(merged.scenes[0].objects[1].name, 'Bob renamed this');
  history.receive(projectContent(merged));
  merged = edit('a', merged, { ...merged, ...history.redo()! }, true).project;
  assert.equal(merged.scenes[0].objects[0].transform.position[0], 8);

  const sameProperty = structuredClone(merged); sameProperty.scenes[0].objects[0].transform.position[0] = 12;
  const later = edit('b', merged, sameProperty);
  const retried = store.edit(room.code, alice, firstId, projectChanges(initial, a), a.revision, pageA);
  assert.equal(retried.savedVersion, later.savedVersion);
  assert.equal(retried.project.scenes[0].objects[0].transform.position[0], 12, 'lost response retry cannot replay an older write');
  // Alice has not received Bob's update yet. Even her stale undo is conditional on what she wrote.
  undone = { ...merged, ...history.undo()! };
  merged = edit('a', merged, undone, true).project;
  assert.equal(merged.scenes[0].objects[0].transform.position[0], 12);
  history.receive(projectContent(merged));
  assert.equal(history.redo()!.scenes[0].objects[0].transform.position[0], 12, 'redo must not revive the overwritten operation');

  const abaBase = structuredClone(merged), aba = structuredClone(merged);
  aba.scenes[0].objects[0].transform.position[0] = 18; edit('a', abaBase, aba);
  const away = structuredClone(aba); away.scenes[0].objects[0].transform.position[0] = 20;
  edit('b', aba, away); edit('b', away, aba);
  merged = edit('a', aba, abaBase, true).project;
  assert.equal(merged.scenes[0].objects[0].transform.position[0], 18, 'same value written later by Bob is still Bob\'s operation');

  const animationBase = structuredClone(merged), keysA = structuredClone(merged), keysB = structuredClone(merged);
  const animationA = keysA.scenes[0].objects[1].animation = emptyAnimation(), animationB = keysB.scenes[0].objects[1].animation = emptyAnimation();
  putKey(animationA, 'position.x', 1, 3); putKey(animationB, 'position.x', 2, 7); putKey(animationB, 'position.z', 2, 9);
  edit('a', animationBase, keysA); merged = edit('b', animationBase, keysB).project;
  assert.deepEqual(merged.scenes[0].objects[1].animation?.curves['position.x']?.map(key => key.time), [1, 2]);
  assert.equal(merged.scenes[0].objects[1].animation?.curves['position.z']?.[0].value, 9);

  const base = structuredClone(merged), one = structuredClone(base), two = structuredClone(base);
  const objectA = { ...createObject('cube', 10), id: randomUUID(), name: 'Alice new object' };
  const objectB = { ...createObject('cube', 10), id: randomUUID(), name: 'Bob new object' };
  one.scenes[0].objects.push(objectA); two.scenes[0].objects.push(objectB);
  const conversationA = newConversation(), conversationB = newConversation();
  conversationA.draft = 'Private unsent text'; conversationA.messages.push({ id: randomUUID(), role: 'user', text: 'Build a dragon', status: 'pending' });
  conversationB.messages.push({ id: randomUUID(), role: 'user', text: 'Frame the bridge', status: 'pending' });
  one.conversations.threads.unshift(conversationA); one.conversations.activeId = conversationA.id;
  two.conversations.threads.unshift(conversationB); two.conversations.activeId = conversationB.id;
  edit('a', base, one); merged = edit('b', base, two).project;
  assert.ok(merged.scenes[0].objects.some(item => item.id === objectA.id));
  assert.ok(merged.scenes[0].objects.some(item => item.id === objectB.id));
  assert.equal(merged.conversations.threads.length, 3);
  assert.equal(merged.conversations.threads.find(thread => thread.id === conversationA.id)?.draft, '');
  assert.equal(projectView(structuredClone(merged), one).conversations.activeId, conversationA.id);

  // AI-produced content travels through exactly the same property merge.
  const aiBase = structuredClone(merged), human = structuredClone(merged);
  human.scenes[0].objects[1].hidden = true;
  const ai = { ...aiBase, ...applyProjectOperations(projectContent(aiBase), [{ type: 'rename', sceneId: aiBase.scenes[0].id, id: objectA.id, name: 'Muse dragon' }], 0) };
  edit('b', aiBase, human); merged = edit('a', aiBase, ai).project;
  assert.equal(merged.scenes[0].objects.find(item => item.id === objectA.id)?.name, 'Muse dragon');
  assert.equal(merged.scenes[0].objects[1].hidden, true);

  const deleteBase = structuredClone(merged), deleted = structuredClone(merged), stale = structuredClone(merged);
  deleted.scenes[0].objects = deleted.scenes[0].objects.filter(item => item.id !== objectA.id);
  stale.scenes[0].objects.find(item => item.id === objectA.id)!.transform.position[0] = 19;
  edit('a', deleteBase, deleted); merged = edit('b', deleteBase, stale).project;
  assert.ok(!merged.scenes[0].objects.some(item => item.id === objectA.id), 'stale property updates do not resurrect deleted objects');

  const invalid = structuredClone(merged); invalid.scenes[0].objects[0].parentId = 'missing-parent';
  const version = store.get(room.code).savedVersion;
  assert.throws(() => edit('a', merged, invalid), /conflicts with a scene structure/);
  assert.equal(store.get(room.code).savedVersion, version, 'invalid structural batches leave the complete document intact');
  assert.deepEqual(parseProject(serializeProject(merged), false), merged);
  now += EDIT_LEASE_MS + 1;
  assert.throws(() => edit('a', merged, merged), /connection expired/);
  store.close(); store = new ProjectRoomStore(directory, () => now);
  assert.deepEqual(store.get(room.code).project, merged);
  store.claim(room.code, alice, pageA);
  const afterRestart = store.edit(room.code, alice, firstId, projectChanges(initial, a), a.revision, pageA);
  assert.deepEqual(afterRestart.project, merged, 'deduplication survives server restart');
});

test('two real HTTP clients converge during overlapping writes, blocked UI, lost responses and offline reconnect without echoing remote edits', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'littletake-live-http-'));
  const service = await startApplication({ port: 0, env: { LITTLETAKE_DATA_DIR: directory, LITTLETAKE_MODE: 'cloud' } });
  const initial = service.projects.create(randomUUID(), randomUUID(), createProject());
  const clients: ProjectCollaboration[] = [];
  t.after(async () => { clients.forEach(client => client.stop()); await service.close(); });
  const request = async (body: unknown, token: string, page: string) => {
    const response = await fetch(service.origin + '/api/projects?code=' + initial.code, { method: 'POST', headers: { 'content-type': 'application/json', 'x-littletake-edit-lease': token, 'x-littletake-edit-page': page }, body: JSON.stringify(body) });
    const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error?.message), { code: value.error?.code }); return value as ProjectRoom;
  };
  const make = async () => {
    const token = randomUUID(), page = randomUUID(), room = await request({ action: 'claim' }, token, page);
    const state = { project: structuredClone(room.project), offline: false, hold: false, loseResponse: false, error: null as Error | null, sends: 0 };
    const client = new ProjectCollaboration(room, {
      send: async edit => {
        if (state.offline) throw new Error('Offline'); state.sends++;
        const result = await request(edit, token, page);
        if (state.loseResponse) { state.loseResponse = false; throw new Error('Response lost'); } return result;
      },
      watch: async (version, signal) => {
        const response = await fetch(service.origin + `/api/projects?code=${initial.code}&since=${version}`, { signal });
        if (state.offline) throw new Error('Offline');
        assert.ok(response.ok); return response.status === 204 ? null : response.json();
      },
      receive: next => { if (state.hold) return false; state.project = next; return true; },
      room: () => {}, state: error => { state.error = error; },
    });
    clients.push(client); client.start(); return { state, client };
  };
  const a = await make(), b = await make();
  const eventually = async (check: () => boolean) => { const deadline = Date.now() + 6000; while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(check(), 'clients converge within six seconds'); };
  a.state.project.scenes[0].objects[0].name = 'Alice moved this'; a.client.observe(a.state.project);
  b.state.project.scenes[0].objects[0].transform.position[0] = 15; b.client.observe(b.state.project);
  await Promise.all([a.client.flush(), b.client.flush()]);
  await eventually(() => a.state.project.scenes[0].objects[0].transform.position[0] === 15 && b.state.project.scenes[0].objects[0].name === 'Alice moved this');
  assert.equal(a.state.sends, 1); assert.equal(b.state.sends, 1, 'receiving never echoes a full snapshot back');

  // An active input/gesture delays presentation, not reception. Its next edit stays relative to what it saw.
  b.state.hold = true;
  a.state.project.scenes[0].objects[0].transform.position[2] = 22; a.client.observe(a.state.project); await a.client.flush();
  b.state.project.scenes[0].objects[0].name = 'Typing in Bob inspector'; b.client.observe(b.state.project); await b.client.flush();
  b.state.hold = false;
  await eventually(() => b.state.project.scenes[0].objects[0].transform.position[2] === 22 && a.state.project.scenes[0].objects[0].name === 'Typing in Bob inspector');

  a.state.loseResponse = true;
  a.state.project.scenes[0].objects[0].name = 'Before lost response'; a.client.observe(a.state.project);
  await assert.rejects(a.client.flush(), /Response lost/);
  await eventually(() => b.state.project.scenes[0].objects[0].name === 'Before lost response');
  b.state.project.scenes[0].objects[0].name = 'Bob after lost response'; b.client.observe(b.state.project); await b.client.flush();
  await a.client.flush();
  await eventually(() => a.state.project.scenes[0].objects[0].name === 'Bob after lost response');

  a.state.offline = true;
  a.state.project.scenes[0].objects[1].hidden = true; a.client.observe(a.state.project);
  await assert.rejects(a.client.flush(), /Offline/);
  b.state.project.scenes[0].objects[2].name = 'Kept while Alice offline'; b.client.observe(b.state.project); await b.client.flush();
  a.state.offline = false; await a.client.flush();
  await eventually(() => a.state.project.scenes[0].objects[2].name === 'Kept while Alice offline' && b.state.project.scenes[0].objects[1].hidden === true);
  assert.equal(a.client.dirty, false); assert.equal(b.client.dirty, false);
  assert.deepEqual(a.state.project.scenes, service.projects.get(initial.code).project.scenes);
  assert.deepEqual(b.state.project.scenes, a.state.project.scenes);
  const originalName = a.state.project.scenes[0].objects[2].name;
  a.state.project.scenes[0].objects[2].name = 'Immediately undo this'; a.client.observe(a.state.project);
  a.state.project.scenes[0].objects[2].name = originalName; a.client.observe(a.state.project, true);
  await a.client.flush();
  assert.equal(service.projects.get(initial.code).project.scenes[0].objects[2].name, originalName, 'undo before the 100 ms batch flush follows its original write');
});
