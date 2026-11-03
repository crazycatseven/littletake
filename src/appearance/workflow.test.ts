import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appearanceReference, appearanceBindings, appearanceInstructions, appearanceFile } from './model.ts';
import { createProject, parseProject, serializeProject } from '../project/storage.ts';
import { projectContent } from '../project/model.ts';
import { projectChanges } from '../project/changes.ts';
import { projectArchive, readProjectArchive } from '../project/archive.ts';
import { ProjectRoomStore } from '../../server/projects/store.ts';
import { duplicateHierarchy } from '../placement/transforms.ts';
import { parseSceneEditInput, proposeSceneEdit } from '../../server/scene-edit.ts';
import { ConversationSession } from '../scene-edit/session.ts';
import { briefInput, videoPackage } from '../look/brief.ts';
import { parseBriefInput, writeVideoBrief } from '../../server/look/brief.ts';
import { parseLookInput, generateLookFrame } from '../../server/look/generate.ts';
import { readVideoPackage } from '../../server/handoffs/package.ts';
import { handoffPage } from '../../server/handoffs/page.ts';
import type { AIProvider, StructuredRequest } from '../../server/ai/provider.ts';

test('appearance bindings survive concurrent edits, duplication, server restart and full project transfer without duplicating image bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'littletake-appearance-'));
  let store = new ProjectRoomStore(directory); t.after(() => store.close());
  const project = createProject(), scene = project.scenes[0], object = scene.objects[0], id = randomUUID(), lease = randomUUID();
  const room = store.create(id, lease, project), imageId = randomUUID();
  const bytes = new Uint8Array(await readFile(new URL('../../server/projects/fixtures/cover.webp', import.meta.url)));
  const output = store.saveOutput(room.code, lease, { id: imageId, kind: 'appearance-reference', sceneId: scene.id, shotId: '', name: 'Hero.webp', mime: 'image/webp' }, bytes);
  // The server saved the file but its acknowledgement was lost: retry the same image ID and bytes.
  const retried = store.saveOutput(room.code, lease, { id: imageId, kind: 'appearance-reference', sceneId: scene.id, shotId: '', name: 'Hero.webp', mime: 'image/webp' }, bytes);
  assert.deepEqual({ ...retried }, output, 'retrying an interrupted upload does not create or overwrite another image');
  const ours = structuredClone(project); ours.scenes[0].objects[0].components = [{ ...appearanceReference(), imageIds: [imageId], description: 'Blue coat' }];
  const theirs = structuredClone(project); theirs.scenes[0].objects[0].transform.position[0] = 4;
  store.edit(room.code, lease, randomUUID(), projectChanges(project, theirs), 1);
  const merged = store.edit(room.code, lease, randomUUID(), projectChanges(project, ours), 1).project;
  assert.equal(merged.scenes[0].objects[0].transform.position[0], 4);
  assert.equal(merged.scenes[0].objects[0].components?.[0].type, 'appearanceReference');
  const duplicated = duplicateHierarchy(merged.scenes[0], [object.id], 0), next = structuredClone(merged); next.scenes[0] = duplicated.scene;
  const saved = store.edit(room.code, lease, randomUUID(), projectChanges(merged, next), store.get(room.code, lease).savedVersion).project;
  assert.equal(appearanceBindings(next.scenes[0])[0].bindings.length, 2);
  store.close(); store = new ProjectRoomStore(directory);
  const bundle = store.bundle(id), reopened = await readProjectArchive(projectArchive(bundle));
  assert.deepEqual(reopened.project, parseProject(serializeProject(saved)));
  assert.equal(reopened.outputs.length, 1, 'copies reuse the original image');
  assert.deepEqual(reopened.outputs[0].data, bytes);
  assert.deepEqual(reopened.outputs[0].output, output);
  assert.throws(() => projectArchive({ project: next, outputs: [] }), /images.*missing/);
  const imported = store.create(randomUUID(), lease, reopened.project, undefined, reopened.outputs);
  assert.deepEqual(store.readOutput(imported.code, imageId).data, bytes);
  const disabled = structuredClone(next.scenes[0]); disabled.objects.forEach(item => { item.hidden = true; });
  assert.equal(appearanceBindings(disabled).length, 0, 'hidden objects do not leak into generation');
});

test('conversation, video brief, styled frame and handoff carry real appearance pixels with their exact object bindings', async () => {
  const project = createProject(), scene = project.scenes[0], object = scene.objects[0], shot = scene.shots[0], imageId = randomUUID();
  object.components = [{ ...appearanceReference(), imageIds: [imageId], description: 'Blue coat and silver boots' }];
  const bytes = await readFile(new URL('../../server/projects/fixtures/cover.webp', import.meta.url)), image = 'data:image/webp;base64,' + bytes.toString('base64');
  const appearance = appearanceBindings(scene).map(ref => ({ ...ref, image })), seen: StructuredRequest[] = [];
  const provider: AIProvider = { name: 'test', model: 'test', async generateObject(request) {
    seen.push(request);
    return request.schemaName === 'littletake_video_brief'
      ? { prompt: 'A performer in a blue coat walks past the sculpture.', camera: 'Wide shot', beats: [], negative: '' }
      : { summary: 'The performer wears a blue coat.', requestedViews: [], operations: [] };
  } };
  const session = new ConversationSession(project.conversations, {
    context: () => ({ project: projectContent(project), sceneId: scene.id, shotId: shot.id, selectedId: object.id, revision: 0, time: 0 }),
    prepare() {}, changed() {}, preview() {}, apply: () => true, capture: () => { throw new Error('No extra view requested'); },
    appearance: async () => appearance,
    request: async input => proposeSceneEdit(parseSceneEditInput(JSON.parse(JSON.stringify(input))), provider),
  });
  session.setDraft('Describe the attached appearance reference. Do not modify the scene.'); await session.send();
  assert.ok(seen[0].content.some(part => part.type === 'image' && part.dataUrl === image));
  assert.ok(seen[0].content.some(part => part.type === 'text' && part.text.includes(object.id) && part.text.includes('Blue coat')));
  const invalid = { project: projectContent(project), sceneId: scene.id, shotId: shot.id, selectedId: object.id, time: 0, prompt: 'Describe', snapshots: [], appearance: [{ ...appearance[0], bindings: [{ ...appearance[0].bindings[0], objectId: 'other-object' }] }] };
  assert.throws(() => parseSceneEditInput(invalid), /scene or its snapshots/);
  const input = parseBriefInput(briefInput(scene, shot, 'Quiet scene', [{ at: 0, image, kind: 'previs' }], appearance));
  const brief = await writeVideoBrief(input, provider);
  assert.equal(seen[1].content.filter(part => part.type === 'image' && part.dataUrl === image).length, 2);
  const look = parseLookInput({ frame: image, direction: 'Film still', subjects: [{ id: object.id, name: object.name, position: 'left', depth: 'midground' }], appearance });
  let transmitted = false;
  await generateLookFrame(look, { apiKey: 'test', model: 'test' }, async (_url, init) => {
    const form = init!.body as FormData; assert.equal(form.getAll('image').length, 2); assert.match(String(form.get('prompt')), /@Image2 is an object appearance reference/);
    assert.match(String(form.get('prompt')), /Blue coat and silver boots/); transmitted = true;
    return Response.json({ data: [{ b64_json: bytes.toString('base64') }] });
  });
  assert.ok(transmitted);
  const promptText = brief.prompt + '\n\n' + appearanceInstructions(appearance);
  const archive = await videoPackage(scene, shot, { ...brief, promptText }, '', [{ at: 0, previs: image }], [], [], appearance);
  const packaged = await readVideoPackage(archive), ref = packaged.manifest.references[0];
  assert.equal(ref.role, 'appearance'); assert.deepEqual(ref.bindings, appearance[0].bindings);
  assert.equal(ref.file, appearanceFile(appearance[0])); assert.deepEqual(packaged.files.get(ref.file), new Uint8Array(bytes));
  assert.equal(packaged.manifest.brief.promptText, promptText);
  assert.match(new TextDecoder().decode(packaged.files.get('appearance-references.md')), /Blue coat and silver boots/);
  assert.match(handoffPage(packaged.manifest, 'token', Date.now(), 'https://example.com'), /Blue coat and silver boots/);
});
