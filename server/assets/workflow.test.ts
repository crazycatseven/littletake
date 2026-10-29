import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MetaProvider } from '../ai/meta.ts';
import { AssetLibrary } from './library.ts';
import { generateAsset } from './expert.ts';
import { budgetProvider } from './tools.ts';
import { builtinAssets } from '../../src/assets/builtin.ts';
import { assetRecipeSchema } from '../../src/assets/model.ts';
import { createEmptyScene, History } from '../../src/model.ts';
import { createProject, parseProject, serializeProject } from '../../src/project/storage.ts';
import { validateProjectContent } from '../../src/project/model.ts';
import { applyProjectOperations } from '../../src/scene-edit/operations.ts';
import { newDiagnostic } from '../../src/scene-edit/diagnostics.ts';
import { proposeSceneEdit } from '../scene-edit.ts';
import type { SceneEditInput } from '../../src/scene-edit/types.ts';

const transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
const json = (value: unknown) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
function transportFor(mode: 'generate' | 'reuse', assetId = 'builtin-chair') {
  let directorCalls = 0, expertCalls = 0;
  const requests: Record<string, any>[] = [];
  const transport = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string); requests.push(body);
    if (!body.tools) {
      expertCalls++;
      const recipe = assetRecipeSchema.strip().parse(builtinAssets[0]); recipe.name = 'Blue test chair'; recipe.tags = ['blue', 'test chair']; recipe.parts.forEach(p => p.color = '#4466aa');
      return Response.json(json(expertCalls === 1 ? recipe : { approved: true, notes: 'All rendered views meet the brief.', revisedRecipe: null }));
    }
    directorCalls++;
    assert.equal(body.parallel_tool_calls, false); assert.equal(body.store, false);
    const outputs = body.input.filter((x: any) => x.type === 'function_call_output').map((x: any) => JSON.parse(x.output));
    const call = (name: string, args: unknown) => Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'call_' + directorCalls, name, arguments: JSON.stringify(args), status: 'completed' }] });
    if (directorCalls === 1) return call('search_assets', { query: mode === 'generate' ? 'blue test chair special' : 'chair' });
    if (directorCalls === 2) return mode === 'generate' ? call('generate_asset', { searchId: outputs[0].searchId, brief: 'Blue chair with four legs and a backrest, matching the requested special asset.', reason: 'The user explicitly requested a new test asset variant.' }) : call('read_asset', { assetId, version: 1 });
    const selected = mode === 'generate' ? outputs[1].asset.id : assetId;
    if (directorCalls === 3) return call('instantiate_asset', { assetId: selected, version: 1, sceneId: 'scene-1', name: 'Chair A', transform });
    if (directorCalls === 4) return call('instantiate_asset', { assetId: selected, version: 1, sceneId: 'scene-1', name: 'Chair B', transform: { ...transform, position: [2, 0, 0] } });
    return Response.json(json({ summary: 'Prepared two instances.', requestedViews: [], objectCounts: [], operations: [outputs[2].operation, outputs[3].operation] }));
  }) as typeof fetch;
  return { provider: new MetaProvider({ apiKey: 'do-not-log-this-test-secret', model: 'test' }, transport), requests, counts: () => ({ directorCalls, expertCalls }) };
}
const input = (): SceneEditInput => ({ project: { name: 'Assets', scenes: [createEmptyScene()] }, sceneId: 'scene-1', shotId: null, prompt: 'Place chairs in this scene.', selectedId: null, time: 0, snapshots: [] });

test('library-first native tools reuse assets, preserve instance independence, export, undo and reload', async () => {
  const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), 'littletake-assets-'))), source = input(), frozen = JSON.stringify(source), diagnostic = newDiagnostic(), fake = transportFor('reuse');
  const response = await proposeSceneEdit(source, fake.provider, undefined, diagnostic, library);
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') return;
  assert.deepEqual(fake.counts(), { directorCalls: 5, expertCalls: 0 }); assert.equal(JSON.stringify(source), frozen);
  assert.deepEqual(diagnostic.toolCalls!.map(c => c.name), ['search_assets', 'read_asset', 'instantiate_asset', 'instantiate_asset']);
  assert.ok(!JSON.stringify(diagnostic).includes('do-not-log-this-test-secret'));
  const result = applyProjectOperations(source.project, response.plan.operations, 0);
  assert.equal(result.assets!.length, 1); assert.equal(result.scenes[0].objects.length, 2);
  assert.deepEqual(result.scenes[0].objects[0].asset, result.scenes[0].objects[1].asset);
  const moved = applyProjectOperations(result, [{ type: 'translate', sceneId: 'scene-1', id: result.scenes[0].objects[0].id, offset: [1, 0, 0] }], 0);
  assert.deepEqual(moved.scenes[0].objects[1], result.scenes[0].objects[1]); assert.deepEqual(moved.assets, result.assets);
  const history = new History(source.project); history.commit(result); assert.deepEqual(history.undo(), source.project); assert.deepEqual(history.redo(), result);
  const project = { ...createProject(result.scenes[0]), assets: result.assets };
  assert.deepEqual(parseProject(serializeProject(project)), project);
  assert.throws(() => validateProjectContent({ ...result, assets: [] }), /Missing asset/);
  const bad = structuredClone(response.plan.operations); bad[1] = { type: 'remove_object', sceneId: 'missing', id: 'missing' };
  assert.throws(() => applyProjectOperations(source.project, bad, 0)); assert.equal(JSON.stringify(source), frozen);
});

test('missing asset is delegated, rendered, inspected and persisted; a restarted library reuses it without expert calls', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'littletake-assets-')), library = new AssetLibrary(directory), source = input(), diagnostic = newDiagnostic(), fake = transportFor('generate');
  const response = await proposeSceneEdit(source, fake.provider, undefined, diagnostic, library);
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') return;
  assert.equal(fake.counts().expertCalls, 2);
  const expertRequests = fake.requests.filter(r => !r.tools);
  assert.match(expertRequests[0].instructions, /dedicated Proxy Asset Modeling Expert/);
  assert.ok(!expertRequests[0].instructions.includes('film-set builder'));
  assert.ok(expertRequests[1].input[0].content.some((p: any) => p.type === 'input_image' && p.image_url.startsWith('data:image/png;base64,')));
  const result = applyProjectOperations(source.project, response.plan.operations, 0), asset = result.assets![0];
  const jobs = await readdir(path.join(directory, 'jobs')); const job = await library.readJob(jobs[0].replace('.json', ''));
  assert.equal(job.status, 'ready'); assert.equal((job.attempts as unknown[]).length, 2); assert.ok(!JSON.stringify(job).includes('do-not-log-this-test-secret'));
  const fresh = new AssetLibrary(directory); assert.deepEqual(await fresh.read(asset.id, 1), asset);
  assert.ok((await fresh.preview(asset)).length > 1000);
  const reuse = transportFor('reuse', asset.id), next = await proposeSceneEdit(input(), reuse.provider, undefined, newDiagnostic(), fresh);
  assert.equal(next.status, 'ready'); assert.equal(reuse.counts().expertCalls, 0); assert.equal((await fresh.list()).length, builtinAssets.length + 1);
  const duplicate = await Promise.allSettled([fresh.register(asset), fresh.register(asset)]); assert.ok(duplicate.every(r => r.status === 'rejected'));
  const variant = { ...asset, id: 'concurrent-publication' };
  const concurrent = await Promise.allSettled([fresh.register(variant), fresh.register(variant)]);
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1); assert.deepEqual(await fresh.read(variant.id, 1), variant);
});

test('rejected visual reviews and interrupted jobs retain raw evidence, spend a bounded number of calls and never register a ready asset', async () => {
  const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), 'littletake-assets-'))), recipe = assetRecipeSchema.strip().parse(builtinAssets[0]);
  let calls = 0;
  const provider = { name: 'test', model: 'test', async generateObject(request: any) { calls++; const value = calls === 1 ? recipe : { approved: false, notes: 'The requested feature is missing.', revisedRecipe: recipe }; request.onOutput?.(JSON.stringify(value)); return value; } };
  await assert.rejects(generateAsset('Test a chair which must not pass inspection.', provider, library), /review did not pass/);
  assert.equal(calls, 3); assert.equal((await library.list()).length, builtinAssets.length);
  const jobs = await readdir(path.join(library.directory, 'jobs')), job = await library.readJob(jobs[0].replace('.json', ''));
  assert.equal(job.status, 'failed'); assert.equal((job.attempts as any[]).filter(a => a.rawOutput).length, 3);
  const controller = new AbortController(); controller.abort(); await assert.rejects(generateAsset('A cancelled chair', provider, library, controller.signal)); assert.equal(calls, 3);
  const limited = budgetProvider(provider, 1), request = { instructions: '', content: [], schema: {}, schemaName: 'test' };
  await limited.generateObject(request); await assert.rejects(limited.generateObject(request), /call limit/); assert.equal(calls, 4);
});
