import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, serializeDocument } from '../model.ts';
import { createConversations, newConversation } from '../scene-edit/conversations.ts';
import { ProjectStorage, PROJECT_STORAGE_KEY, createProject, parseProject, serializeProject } from './storage.ts';

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
test('legacy scenes migrate without loss; multiple conversations, drafts and edit receipts survive save, refresh and export/import', () => {
  const disk = memoryStorage(), legacy = serializeDocument(createDocument()); disk.setItem('littletake.scene.v1', legacy);
  const store = new ProjectStorage(disk), { project, recovered } = store.load();
  assert.equal(recovered, true); assert.equal(serializeDocument(project.scenes[0]), legacy);
  const first = project.conversations.threads[0], second = newConversation();
  first.title = 'Blocking'; first.draft = 'A draft for this conversation';
  first.messages.push({ id: 'u1', role: 'user', text: 'Move the plinth.', status: 'answered' },
    { id: 'a1', role: 'assistant', text: 'A preview.', model: 'Muse', edit: { sceneId: 'scene-1', shotId: 'shot-1', status: 'applied', revision: 0, time: 0, operations: [{ sceneId: 'scene-1', type: 'translate', id: 'object-2', offset: [0.5, 0, 0] }] } });
  project.scenes[0].objects[1].transform.position[0] = 2.4; project.revision = 1;
  second.messages.push({ id: 'u2', role: 'user', text: 'Tell me about framing.', status: 'pending' }); second.draft = 'Next thought';
  project.conversations.threads.push(second); project.conversations.activeId = second.id; store.save(project);
  assert.equal(disk.getItem('littletake.scene.v1'), legacy);
  const restored = new ProjectStorage(disk).load().project;
  assert.equal(restored.scenes[0].objects[1].transform.position[0], 2.4); assert.equal(restored.conversations.activeId, second.id);
  assert.equal(restored.conversations.threads[0].draft, first.draft); assert.equal(restored.conversations.threads[1].draft, second.draft);
  const interrupted = restored.conversations.threads[1].messages[0]; assert.equal(interrupted.role === 'user' && interrupted.status, 'stopped');
  assert.deepEqual(parseProject(serializeProject(restored)), restored);
  const originalReceipt = restored.conversations.threads[0].messages[1]; assert.equal(originalReceipt.role === 'assistant' && originalReceipt.edit?.status, 'applied');
  const otherProject = createProject(); otherProject.conversations = createConversations();
  assert.notEqual(parseProject(serializeProject(otherProject)).conversations.activeId, restored.conversations.activeId);
});

test('corrupt data, a full disk and another tab never silently overwrite the saved project', () => {
  const disk = memoryStorage(); disk.setItem(PROJECT_STORAGE_KEY, '{broken');
  const broken = new ProjectStorage(disk); assert.throws(() => broken.load()); assert.throws(() => broken.save(createProject()));
  assert.equal(disk.getItem(PROJECT_STORAGE_KEY), '{broken'); assert.equal(broken.savedText(), '{broken');
  const cleanDisk = memoryStorage(), owner = new ProjectStorage(cleanDisk), other = new ProjectStorage(cleanDisk);
  const project = owner.load().project; owner.save(project); const copy = other.load().project;
  project.conversations.threads[0].draft = 'Written in the first tab'; owner.save(project);
  copy.conversations.threads[0].draft = 'Second tab changes'; assert.throws(() => other.save(copy), /another tab/);
  assert.equal(parseProject(cleanDisk.getItem(PROJECT_STORAGE_KEY)!).conversations.threads[0].draft, 'Written in the first tab');
  const full = new ProjectStorage({ getItem: cleanDisk.getItem, setItem() { throw new Error('Quota exceeded'); } });
  const inMemory = full.load().project; inMemory.conversations.threads[0].draft = 'Unsaved but exportable';
  assert.throws(() => full.save(inMemory), /could not save/);
  assert.equal(parseProject(serializeProject(inMemory)).conversations.threads[0].draft, 'Unsaved but exportable');
  assert.equal(parseProject(cleanDisk.getItem(PROJECT_STORAGE_KEY)!).conversations.threads[0].draft, 'Written in the first tab');
});
