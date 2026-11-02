import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startApplication } from '../../server/app/service.ts';
import { createProject } from '../project/storage.ts';
import { projectRequestContext } from '../project/client.ts';
import type { ProjectOutput, ProjectRoom } from '../project/room.ts';
import type { Workspace } from '../project/workspace.ts';
import { saveReference, loadReference, saveObservations, detachReference } from './store.ts';
import type { ReferenceSource, ReferenceObservation } from './observations.ts';
import { saveDiagnostic, readDiagnostics, type RequestDiagnostic } from '../scene-edit/diagnostic-store.ts';

test('references and AI request history survive service restart without using browser storage; concurrent observations are retained', async t => {
  const descriptors = new Map(['indexedDB', 'localStorage', 'FileReader'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of ['indexedDB', 'localStorage']) Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error('Project content must not use browser storage.'); } });
  class FileReaderForNode {
    result = ''; onload?: () => void; onerror?: (error: unknown) => void;
    readAsDataURL(blob: Blob) { void blob.arrayBuffer().then(bytes => { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload?.(); }).catch(error => this.onerror?.(error)); }
  }
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: FileReaderForNode });
  t.after(() => { for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } projectRequestContext(null); });
  const directory = await mkdtemp(path.join(tmpdir(), 'littletake-reference-store-'));
  const env = { LITTLETAKE_DATA_DIR: directory, LITTLETAKE_MODE: 'local' };
  let service = await startApplication({ port: 0, env }); t.after(() => service.close());
  const lease = randomUUID(), page = randomUUID(), project = createProject(), thread = project.conversations.activeId!;
  const headers = { 'x-littletake-edit-lease': lease, 'x-littletake-edit-page': page };
  let room = service.projects.create(randomUUID(), lease, project, undefined, [], page);
  const connect = () => {
    const owner = {
      room,
      async putOutput(output: Omit<ProjectOutput, 'updatedAt'>, data: Blob, target = room) {
        const response = await fetch(service.origin + '/api/projects?code=' + target.code + '&output=1', { method: 'POST', headers: { ...headers, 'x-littletake-output': encodeURIComponent(JSON.stringify(output)) }, body: data });
        const value: ProjectOutput = await response.json(); assert.equal(response.status, 200);
        target.outputs = [value, ...target.outputs.filter(item => item.id !== output.id)]; return value;
      },
      async output(id: string, target = room) { const response = await fetch(service.origin + '/api/projects?code=' + target.code + '&output=' + id); assert.equal(response.status, 200); return response.blob(); },
    };
    projectRequestContext({ code: room.code, lease, page }, owner as unknown as Workspace);
  };
  connect();
  const png = 'data:image/png;base64,iVBORw0KGgo=', source: ReferenceSource = { id: 'source-1', name: 'Hotel reference', kind: 'image', duration: 0, originalWidth: 1, originalHeight: 1, cuts: [], omittedShots: 0, frames: [{ id: 'frame-1', time: 0, requestedTime: 0, shot: 0, role: 'image', quality: 1, width: 1, height: 1, dataUrl: png }] };
  const media = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'reference.png', { type: 'image/png' });
  await saveReference(thread, source, media);
  const observation = (id: string): ReferenceObservation => ({ id, sourceId: source.id, frameId: 'frame-1', concept: id, threshold: .5, createdAt: new Date().toISOString(), provider: 'test', model: 'fixture', width: 1, height: 1, instances: [], overlayDataUrl: png });
  await Promise.all(['person', 'door'].map(id => saveObservations({ sourceId: source.id, observations: [observation(id)], callsUsed: 1, framesRequested: false })));
  const record: RequestDiagnostic<unknown> = { id: randomUUID(), turnId: randomUUID(), conversationId: 'original-cloud-code:' + thread, messageId: randomUUID(), startedAt: new Date().toISOString(), input: { project }, status: 'pending' };
  await saveDiagnostic(record); record.status = 'ready'; record.finishedAt = new Date().toISOString(); record.result = { summary: 'Saved result' }; await saveDiagnostic(record);
  await service.close(); service = await startApplication({ port: 0, env });
  room = service.projects.get(room.code, lease, page); connect();
  const restored = await loadReference(thread); assert.deepEqual(restored!.source, source); assert.deepEqual(restored!.observations.map(value => value.id).sort(), ['door', 'person']);
  const savedMedia = JSON.parse(await (await fetch(service.origin + '/api/projects?code=' + room.code + '&output=' + thread)).text()).media;
  assert.equal(savedMedia.name, media.name); assert.equal(savedMedia.dataUrl, 'data:image/png;base64,' + Buffer.from(await media.arrayBuffer()).toString('base64'));
  const diagnostics = await readDiagnostics(room.code + ':' + thread); assert.deepEqual(diagnostics, [record], 'diagnostics remain readable after a workspace-code change');
  await detachReference(thread); assert.equal(await loadReference(thread), undefined);
  assert.equal((await readDiagnostics(room.code + ':' + thread)).length, 1); assert.equal(service.projects.list().length, 1);
});
