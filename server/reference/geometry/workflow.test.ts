import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { LocalDepthService, type DepthResult } from './depth.ts';
import { createDepthHandler } from './api.ts';
import { ReferenceTools } from '../sam/tools.ts';
import { MetaProvider } from '../../ai/meta.ts';
import { createSceneEditHandler } from '../../scene-edit-api.ts';
import { createEmptyScene } from '../../../src/model.ts';
import type { ReferenceContext } from '../../../src/reference/observations.ts';

test('the local depth API feeds Agent tools without applying edits, reuses requests, hides unavailable depth, and never retries a failed frame', async () => {
  const png = new PNG({ width: 40, height: 30 }); png.data.fill(255);
  const dataUrl = 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
  const frame = { id: 'frame', time: 2.3, requestedTime: 2.3, shot: 1, quality: 1, role: 'anchor' as const, width: 40, height: 30, dataUrl };
  const reference: ReferenceContext = { source: { id: 'source', name: 'Reference clip', kind: 'video', duration: 5, originalWidth: 80, originalHeight: 60, cuts: [2], omittedShots: 0, frames: [frame] }, observations: [], callsUsed: 0, framesRequested: false };
  const depthResult: DepthResult = { measurementId: 'test-measurement', sourceId: 'source', frameId: 'frame', time: 2.3, shot: 1, width: 40, height: 30, cached: false,
    model: { repo: 'fixture', revision: 'fixed', sourceRevision: 'fixed' }, device: 'cpu', scale: 'relative',
    camera: { convention: 'OpenCV +Y down +Z forward' }, grid: { rows: 16, columns: 16 }, regions: [], visualization: { low: 1, high: 5 }, runtime: {}, limitations: ['Not metres or scene coordinates.'], depthImageDataUrl: dataUrl };
  let estimates = 0, mode = 'ok';
  const depth = { available: true, start: async () => {}, status: () => ({ ...new LocalDepthService({ VERCEL: '1' }).status(), available: true }), estimate: async () => { estimates++; if (mode === 'fail') throw new Error('Not enough free VRAM.'); return depthResult; } };
  const api = createDepthHandler(depth);
  assert.equal((await (await api(new Request('http://localhost/api/depth'))).json()).available, true);
  const input = { sourceId: 'source', frame, regions: [] };
  const post = (origin = 'http://localhost') => new Request('http://localhost/api/depth', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(input) });
  assert.equal((await api(post('https://other.test'))).status, 403); assert.equal(estimates, 0);
  const response = await api(post()); assert.equal(response.status, 200); assert.equal((await response.json()).scale, 'relative');
  const scene = createEmptyScene('depth-set'); const project = { name: 'Depth test', scenes: [scene] }, before = JSON.stringify(project);
  let turns = 0;
  const provider = new MetaProvider({ apiKey: 'test-only-never-public', model: 'test' }, (async (_url, init) => {
    turns++; const body = JSON.parse(String(init?.body));
    assert.ok(body.tools.some((tool: any) => tool.name === 'estimate_reference_depth'));
    assert.match(body.instructions, /not LittleTake transforms/);
    if (turns === 1) return Response.json({ status: 'completed', output: [0, 1].map(index => ({ type: 'function_call', call_id: 'depth-' + index, name: 'estimate_reference_depth', arguments: JSON.stringify({ frameId: 'frame', regions: [] }) })) });
    const outputs = body.input.filter((item: any) => item.type === 'function_call_output').map((item: any) => JSON.parse(item.output));
    assert.equal(outputs[0].scale, 'relative'); assert.equal(outputs[0].sourceShotNumber, 2); assert.equal(outputs[1].cached, true);
    assert.equal(outputs[0].applied, false); assert.equal(body.input.at(-1).content.filter((item: any) => item.type === 'input_image').length, 2);
    return Response.json({ status: 'completed', output_text: JSON.stringify({ summary: 'Compared the relative depth without applying a scene edit.', requestedViews: [], operations: [], objectCounts: [] }) });
  }) as typeof fetch);
  const handler = createSceneEditHandler({ LITTLETAKE_ASSET_DIR: await mkdtemp(join(tmpdir(), 'littletake-depth-agent-')) }, () => provider, depth);
  const agentResponse = await handler(new Request('http://localhost/api/scene-edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, sceneId: scene.id, shotId: null, selectedId: null, time: 0, prompt: 'Measure reference depth.', history: [], snapshots: [], reference }) }));
  const result = await agentResponse.json();
  assert.equal(agentResponse.status, 200); assert.equal(result.status, 'ready'); assert.equal(estimates, 2); assert.equal(turns, 2);
  assert.equal(result.diagnostic.referenceCalls.length, 1); assert.equal(result.diagnostic.referenceCalls[0].tool, 'estimate_reference_depth');
  assert.equal(result.diagnostic.media.find((media:any)=>media.ref===result.diagnostic.referenceCalls[0].result.depthImageDataUrl.dataRef)?.dataUrl, dataUrl); assert.equal(JSON.stringify(project), before);
  assert.equal(JSON.stringify(result).includes('test-only-never-public'), false);
  const references = new ReferenceTools(reference, {}, undefined, depth); mode = 'fail';
  await assert.rejects(references.execute('estimate_reference_depth', { frameId: 'frame', regions: [] }), /free VRAM/);
  await assert.rejects(references.execute('estimate_reference_depth', { frameId: 'frame', regions: [{ label: 'different region', box: [.1, .1, .9, .9] }] }), /free VRAM/);
  assert.equal(estimates, 3); assert.equal(references.evidence.length, 1);
  assert.equal(new ReferenceTools(reference).definitions().some(tool => tool.name === 'estimate_reference_depth'), false);
  const remote = new LocalDepthService({ VERCEL: '1' }); await remote.start(); assert.equal(remote.available, false);
  await assert.rejects(remote.estimate(input), /unavailable on Vercel/); await remote.close();
});
