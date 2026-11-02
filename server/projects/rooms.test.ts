import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { builtinAssets, instantiateAsset } from '../../src/assets/library.ts';
import { newConversation } from '../../src/scene-edit/conversations.ts';
import { createProject, serializeProject } from '../../src/project/storage.ts';
import { EDIT_LEASE_MS, type ProjectRoom } from '../../src/project/room.ts';
import { coverDue, COVER_INTERVAL_MS } from '../../src/project/cover.ts';
import { projectArchive, readProjectArchive } from '../../src/project/archive.ts';
import { putKey, emptyAnimation } from '../../src/animation/model.ts';
import { createProjectRoomsHandler } from './api.ts';
import { ProjectRoomStore } from './store.ts';

function request(input?: unknown, code?: string, lease?: string) {
  return new Request(`http://localhost/api/projects${code ? `?code=${encodeURIComponent(code)}` : ''}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(lease ? { 'x-littletake-edit-lease': lease } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
async function room(response: Response, status = 200): Promise<ProjectRoom> {
  const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
}

test('one editor saves scenes, assets and chats; retries, takeover, restart and backup never lose or overwrite newer work', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'littletake-rooms-'));
  let now = Date.now(), store = new ProjectRoomStore(directory, () => now);
  const otherProcess = new ProjectRoomStore(directory, () => now);
  t.after(() => { store.close(); otherProcess.close(); });
  let handle = createProjectRoomsHandler(store);
  const other = createProjectRoomsHandler(otherProcess), firstLease = randomUUID(), secondLease = randomUUID(), id = randomUUID();
  const source = createProject(); source.name = 'Hotel blocking'; source.assets = [structuredClone(builtinAssets[0])];
  source.scenes[0].objects.push(instantiateAsset(source.assets[0], 'added-chair', [3, 0, -2], source.scenes[0].duration));
  const conversation = newConversation(); conversation.title = 'Camera notes'; conversation.draft = 'Keep this thought';
  conversation.messages.push({ id: 'question', role: 'user', text: 'Check this camera.', status: 'pending' });
  source.conversations.threads.push(conversation); source.conversations.activeId = conversation.id;
  Object.assign(source, JSON.parse(serializeProject(source)));
  const created = await room(await handle(request({ action: 'create', id, project: source }, undefined, firstLease)), 201);
  assert.equal(created.editing, 'you'); assert.equal(created.savedVersion, 1);
  assert.deepEqual(created.project, source, 'server validation does not interrupt a running conversation');
  const viewer = await room(await other(request(undefined, created.code.toLowerCase().replace(/(.{4})/g, '$1-'))));
  assert.equal(viewer.editing, 'occupied'); assert.deepEqual(viewer.project, source);
  assert.ok(!JSON.stringify(viewer).includes(firstLease), 'shared room data does not disclose the edit credential');
  assert.equal((await other(request({ action: 'claim' }, created.code, secondLease))).status, 409);
  assert.equal((await other(request({ action: 'save', savedVersion: 1, project: source }, created.code, secondLease))).status, 409);

  const updated = structuredClone(created.project); updated.revision++;
  updated.scenes[0].objects[0].transform.position[0] = 4.5;
  updated.conversations.threads[1].draft = 'A saved second thought';
  const write = { action: 'save', savedVersion: 1, project: updated };
  const saved = await room(await handle(request(write, created.code, firstLease)));
  assert.equal(saved.savedVersion, 2);
  const retry = await room(await handle(request(write, created.code, firstLease)));
  assert.equal(retry.savedVersion, 2, 'retrying a lost response does not create another write');
  const createRetry = await room(await handle(request({ action: 'create', id, project: source }, undefined, firstLease)), 201);
  assert.deepEqual(createRetry.project, updated, 'retrying creation cannot restore the original document over saved edits');
  assert.equal((await handle(request({ action: 'save', savedVersion: 1, project: source }, created.code, firstLease))).status, 409);

  store.close(); store = new ProjectRoomStore(directory, () => now); handle = createProjectRoomsHandler(store);
  assert.deepEqual((await room(await handle(request(undefined, created.code, firstLease)))).project, updated);
  now += EDIT_LEASE_MS - 1;
  await room(await handle(request({ action: 'heartbeat' }, created.code, firstLease)));
  now += 2;
  assert.equal((await other(request({ action: 'claim' }, created.code, secondLease))).status, 409, 'a heartbeat survives the original expiry');
  now += EDIT_LEASE_MS;
  assert.equal((await room(await other(request(undefined, created.code)))).editing, 'available');
  const thirdLease = randomUUID();
  const contenders = await Promise.all([
    handle(request({ action: 'claim' }, created.code, secondLease)),
    other(request({ action: 'claim' }, created.code, thirdLease)),
  ]);
  assert.deepEqual(contenders.map(response => response.status).sort(), [200, 409], 'only one competing client becomes editor');
  const newLease = contenders[0].status === 200 ? secondLease : thirdLease;
  const secondEdit = structuredClone(updated); secondEdit.name = 'Hotel blocking, revised'; secondEdit.revision++;
  const latest = await room(await other(request({ action: 'save', savedVersion: 2, project: secondEdit }, created.code, newLease)));
  assert.equal(latest.savedVersion, 3);
  for (const action of [{ action: 'heartbeat' }, { action: 'release' }, { action: 'save', savedVersion: 3, project: source }])
    assert.equal((await handle(request(action, created.code, firstLease))).status, 409, 'the disconnected old editor cannot change the new session');
  assert.deepEqual((await room(await handle(request(undefined, created.code)))).project, secondEdit);

  const separate = await room(await handle(request({ action: 'create', id: randomUUID(), project: createProject(null) }, undefined, randomUUID())), 201);
  assert.notEqual(separate.code, created.code); assert.equal(separate.project.scenes.length, 0);
  assert.equal((await handle(request({ action: 'save', savedVersion: 1, project: secondEdit }, separate.code, newLease))).status, 409);
  assert.equal((await room(await handle(request(undefined, separate.code)))).project.scenes.length, 0);

  const backupDirectory = path.join(directory, 'backup'); await mkdir(backupDirectory);
  await store.backupTo(path.join(backupDirectory, 'projects.sqlite'));
  const restored = new ProjectRoomStore(backupDirectory, () => now);
  try { assert.deepEqual(restored.get(created.code).project, secondEdit); assert.equal(restored.get(created.code).savedVersion, 3); }
  finally { restored.close(); }
  await room(await other(request({ action: 'release' }, created.code, newLease)));
  assert.equal((await room(await handle(request(undefined, created.code)))).editing, 'available');
  const returning = await room(await handle(request({ action: 'claim' }, created.code, randomUUID())));
  assert.equal(returning.editing, 'you'); assert.deepEqual(returning.project, secondEdit);
});

test('invalid imports and unauthorized requests leave the existing room intact', async t => {
  const store = new ProjectRoomStore(await mkdtemp(path.join(tmpdir(), 'littletake-room-safety-'))); t.after(() => store.close());
  const handle = createProjectRoomsHandler(store), lease = randomUUID(), id = randomUUID();
  const original = await room(await handle(request({ action: 'create', id, project: createProject() }, undefined, lease)), 201);
  const corrupt = structuredClone(original.project); corrupt.scenes[0].shots[0].cameraId = 'missing-camera';
  const invalidSave = await handle(request({ action: 'save', savedVersion: 1, project: corrupt }, original.code, lease));
  assert.equal(invalidSave.status, 400);
  assert.equal((await handle(request({ action: 'create', id, project: createProject(null) }, undefined, randomUUID()))).status, 409);
  const foreign = request({ action: 'release' }, original.code, lease); foreign.headers.set('origin', 'https://unrelated.example');
  assert.equal((await handle(foreign)).status, 403);
  assert.equal((await handle(request({ action: 'release' }, original.code))).status, 403);
  assert.equal((await handle(request(undefined, 'DOES-NOT-EXIST'))).status, 404);
  assert.equal((await handle(request(undefined))).status, 400, 'there is no unauthenticated project directory');
  const unchanged = await room(await handle(request(undefined, original.code, lease)));
  assert.equal(unchanged.savedVersion, 1); assert.equal(unchanged.editing, 'you'); assert.deepEqual(unchanged.project, original.project);
});

test('shared covers survive closing, restart, backup and archives; only the current editor can replace the saved version', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'littletake-gallery-'));
  let store = new ProjectRoomStore(directory), handle = createProjectRoomsHandler(store); t.after(() => store.close());
  const lease = randomUUID(), page = randomUUID(), project = createProject();
  const image = new Uint8Array(await readFile(new URL('./fixtures/cover.webp', import.meta.url)));
  const created = store.create(randomUUID(), lease, project, undefined, [], page), code = created.code;
  const url = `http://localhost/api/projects?code=${code}&cover=1`;
  const upload = (version: number, data: Uint8Array = image, editor = lease, editorPage = page) => handle(new Request(url + '&version=' + version, {
    method: 'POST', headers: { 'Content-Type': 'image/webp', 'x-littletake-edit-lease': editor, 'x-littletake-edit-page': editorPage }, body: new Uint8Array(data),
  }));
  assert.equal((await handle(new Request(url))).status, 404);
  assert.equal((await upload(1, image, randomUUID())).status, 409);
  const uploaded = await upload(1); assert.equal(uploaded.status, 200);
  const cover = (await uploaded.json()).cover;
  assert.equal(store.get(code, lease, page).savedVersion, 1, 'cover upload does not change the scene document');
  const response = await handle(new Request(url));
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image, 'a different browser reads the uploaded bytes without rendering');
  assert.equal((await handle(new Request(url, { headers: { 'if-none-match': response.headers.get('etag')! } }))).status, 304);
  const listing = await (await handle(new Request('http://localhost/api/projects?list=1'))).json();
  assert.deepEqual(listing.projects[0].cover, cover); assert.equal(listing.projects[0].project, undefined);
  assert.equal(coverDue(null, 1, cover.updatedAt, 0), true);
  assert.equal(coverDue(cover, 1, cover.updatedAt + COVER_INTERVAL_MS, 0), false);
  assert.equal(coverDue(cover, 2, cover.updatedAt + COVER_INTERVAL_MS - 1, 0), false);
  assert.equal(coverDue(cover, 2, cover.updatedAt + COVER_INTERVAL_MS, 0), true);
  assert.equal(coverDue(cover, 2, cover.updatedAt + 1000, 0, true), true, 'returning to Gallery can refresh before five minutes');
  assert.equal(coverDue(null, 1, cover.updatedAt + 1000, cover.updatedAt), false, 'failed captures do not retry every polling tick');

  let saved = store.get(code, lease, page);
  saved.project.name = 'Renamed project'; saved.project.scenes[0].name = 'Renamed scene';
  saved.project.scenes[0].objects[0].name = 'Renamed performer'; saved.project.scenes[0].cameras[0].name = 'Renamed camera';
  saved.project.conversations.threads[0].draft = 'New chat text';
  saved = store.save(code, lease, saved.savedVersion, saved.project, page);
  assert.equal(saved.cover!.savedVersion, saved.savedVersion, 'names and chats keep the existing image current');
  assert.equal(saved.cover!.updatedAt, cover.updatedAt);
  saved.project.scenes[0].objects[0].color = '#123456';
  saved = store.save(code, lease, saved.savedVersion, saved.project, page);
  assert.notEqual(saved.cover!.savedVersion, saved.savedVersion, 'visible edits mark the retained image stale');
  assert.equal((await upload(1)).status, 409, 'an older capture cannot replace newer project content');
  assert.equal((await upload(saved.savedVersion, new TextEncoder().encode('<svg/>'))).status, 400);
  assert.deepEqual(store.readCover(code).data, image, 'failed uploads retain the previous cover');
  assert.equal((await upload(saved.savedVersion)).status, 200);
  const latest = store.get(code, lease, page), contentVersion = latest.contentVersion;
  assert.equal((await upload(saved.savedVersion)).status, 200);
  assert.equal(store.get(code).contentVersion, contentVersion, 'retrying a successful upload is idempotent');
  assert.ok(latest.cover!.updatedAt > cover.updatedAt);
  const archive = await readProjectArchive(projectArchive(store.bundle(created.id)));
  assert.deepEqual(archive.cover, { current: true, data: new Uint8Array(image) });
  const imported = store.create(randomUUID(), lease, archive.project, undefined, archive.outputs, undefined, archive.cover);
  assert.deepEqual(store.readCover(imported.code).data, image); assert.equal(imported.cover!.savedVersion, imported.savedVersion);
  const copied = store.create(randomUUID(), lease, { ...latest.project, name: 'Copy' }, code);
  assert.deepEqual(store.readCover(copied.code).data, image); assert.equal(copied.cover!.savedVersion, copied.savedVersion);
  store.release(code, lease, page);
  await handle(new Request(url)); assert.equal(store.get(code).editing, 'available', 'Gallery does not occupy the editing seat');
  assert.equal((await upload(saved.savedVersion)).status, 409, 'a closed or superseded editor cannot publish');
  const backup = await mkdtemp(path.join(tmpdir(), 'littletake-cover-backup-')); await store.backupTo(path.join(backup, 'projects.sqlite'));
  store.close(); store = new ProjectRoomStore(directory); handle = createProjectRoomsHandler(store);
  assert.deepEqual(store.readCover(code).data, image);
  const restored = new ProjectRoomStore(backup); try { assert.deepEqual(restored.readCover(code).data, image); } finally { restored.close(); }
  saved = store.claim(code, lease, page); saved.project.scenes[0].objects.forEach(item => item.hidden = true);
  saved = store.save(code, lease, saved.savedVersion, saved.project, page);
  assert.equal((await upload(saved.savedVersion, new Uint8Array())).status, 200);
  assert.equal((await handle(new Request(url))).status, 204, 'an intentionally empty scene removes the old visible image');
  assert.equal(store.get(code).cover!.hasImage, false);
});
test('project archives preserve animated scenes, chats and generated results through import, copy, restart and backup', async t => {
  const uuidDescriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  t.after(() => { if (uuidDescriptor) Object.defineProperty(crypto, 'randomUUID', uuidDescriptor); else delete (crypto as { randomUUID?: unknown }).randomUUID; });
  const directory = await mkdtemp(path.join(tmpdir(), 'littletake-bundle-'));
  let store = new ProjectRoomStore(directory); t.after(() => store.close());
  let handle = createProjectRoomsHandler(store);
  const editor = randomUUID(), viewer = randomUUID(), source = createProject();
  source.name = '旅馆 — saved project';
  source.scenes[0].objects[0].track = null;
  source.scenes[0].objects[0].animation = emptyAnimation();
  putKey(source.scenes[0].objects[0].animation!, 'position.x', 0, 1);
  putKey(source.scenes[0].objects[0].animation!, 'position.x', 2, 4);
  const conversation = newConversation(); conversation.draft = 'A project-specific thought'; source.conversations.threads.push(conversation);
  const created = await room(await handle(request({ action: 'create', id: randomUUID(), project: source }, undefined, editor)), 201);
  const output = { id: randomUUID(), kind: 'look-frame' as const, sceneId: source.scenes[0].id, shotId: source.scenes[0].shots[0].id, name: '旅馆 · frame', mime: 'application/json' as const };
  const bytes = new TextEncoder().encode(JSON.stringify({ image: 'data:image/png;base64,iVBORw0KGgo=', direction: 'Warm lobby', time: 0 }));
  const upload = (lease: string, code = created.code) => new Request(`https://littletake.vercel.app/api/projects?code=${code}&output=1`, { method: 'POST', headers: { 'x-littletake-edit-lease': lease, 'x-littletake-output': encodeURIComponent(JSON.stringify(output)) }, body: bytes });
  assert.equal((await handle(upload(viewer))).status, 409);
  assert.equal((await handle(upload(editor))).status, 200);
  assert.equal((await handle(new Request(`https://littletake.vercel.app/api/projects?code=${created.code}&output=${output.id}`))).status, 200, 'viewers can read their project results');
  const foreign = await room(await handle(request({ action: 'create', id: randomUUID(), project: createProject(null) }, undefined, viewer)), 201);
  assert.equal((await handle(new Request(`https://littletake.vercel.app/api/projects?code=${foreign.code}&output=${output.id}`))).status, 404, 'result IDs never escape their project');
  const saved = store.get(created.code, editor);
  assert.equal(saved.outputs.length, 1);
  saved.project.lookSettings = { [output.sceneId]: { direction: 'Warm lobby', anchorId: output.id, styleId: null } };
  const document = store.save(created.code, editor, saved.savedVersion, saved.project);
  const archive = projectArchive({ project: document.project, outputs: [{ output: saved.outputs[0], data: bytes }] });
  const decoded = await readProjectArchive(archive);
  assert.deepEqual(decoded.project, document.project); assert.deepEqual(decoded.outputs[0].data, bytes);
  const importId = randomUUID();
  const imported = await room(await handle(new Request(`https://littletake.vercel.app/api/projects?import=1&id=${importId}`, { method: 'POST', headers: { 'x-littletake-edit-lease': viewer }, body: archive })), 201);
  assert.deepEqual(imported.project, document.project); assert.deepEqual(store.readOutput(imported.code, output.id).data, bytes);
  const duplicate = await room(await handle(request({ action: 'create', id: randomUUID(), project: { ...imported.project, name: 'Independent copy' }, sourceCode: imported.code }, undefined, viewer)), 201);
  assert.equal(duplicate.outputs.length, 1); assert.deepEqual(store.readOutput(duplicate.code, output.id).data, bytes);
  duplicate.project.scenes[0].objects[0].transform.position[0] = 12;
  store.save(duplicate.code, viewer, duplicate.savedVersion, duplicate.project);
  assert.notEqual(store.get(imported.code).project.scenes[0].objects[0].transform.position[0], 12);
  const corrupt = new Uint8Array(await archive.arrayBuffer()); corrupt[55] ^= 1;
  assert.equal((await handle(new Request(`https://littletake.vercel.app/api/projects?import=1&id=${randomUUID()}`, { method: 'POST', headers: { 'x-littletake-edit-lease': viewer }, body: corrupt }))).status, 400);
  assert.deepEqual(store.get(imported.code).project, document.project, 'a corrupt import never replaces a saved project');
  const runId = randomUUID(); for (let i = 1; i <= 72; i++) assert.equal(store.consumeCall(created.code, editor, runId), i);
  assert.throws(() => store.consumeCall(created.code, editor, runId), /model-call limit/);
  const backupDirectory = await mkdtemp(path.join(tmpdir(), 'littletake-bundle-backup-')); await store.backupTo(path.join(backupDirectory, 'projects.sqlite'));
  store.close(); store = new ProjectRoomStore(directory); handle = createProjectRoomsHandler(store);
  assert.deepEqual(store.readOutput(imported.code, output.id).data, bytes); assert.throws(() => store.consumeCall(created.code, editor, runId), /model-call limit/, 'restarting cannot reset a paid-call budget');
  const restored = new ProjectRoomStore(backupDirectory);
  try { assert.deepEqual(restored.get(imported.code).project, document.project); assert.deepEqual(restored.readOutput(imported.code, output.id).data, bytes); }
  finally { restored.close(); }
  const oldPage = randomUUID(), newPage = randomUUID();
  store.claim(imported.code, viewer, oldPage); store.claim(imported.code, viewer, newPage);
  assert.equal(store.get(imported.code, viewer, oldPage).editing, 'occupied');
  assert.equal(store.get(imported.code, viewer, newPage).editing, 'you');
  assert.throws(() => store.release(imported.code, viewer, oldPage), /editing session has ended/, 'a delayed pagehide cannot release the reloaded page');
  assert.throws(() => store.save(imported.code, viewer, store.get(imported.code).savedVersion, document.project, oldPage), /editing session has ended/);
  assert.throws(() => store.consumeCall(imported.code, viewer, randomUUID(), 72, oldPage), /editing session has ended/);
  store.heartbeat(imported.code, viewer, newPage);
  store.release(imported.code, viewer, newPage);
  assert.equal(store.claim(imported.code, editor, randomUUID()).editing, 'you', 'closing releases the editing seat immediately');
});
