import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { ReferenceTools } from './tools.ts';
import { segmentImage, SAM_SOURCE } from './service.ts';
import { AIError } from '../../ai/provider.ts';
import { MetaProvider } from '../../ai/meta.ts';
import { AssetLibrary } from '../../assets/library.ts';
import { parseSceneEditInput, proposeSceneEdit } from '../../scene-edit.ts';
import { createSceneEditHandler } from '../../scene-edit-api.ts';
import { createEmptyScene, createObject } from '../../../src/model.ts';
import { createConversations } from '../../../src/scene-edit/conversations.ts';
import { ConversationSession } from '../../../src/scene-edit/session.ts';
import { newDiagnostic } from '../../../src/scene-edit/diagnostics.ts';
import { candidateTimes, chooseCandidates } from '../../../src/reference/frames.ts';
import type { ReferenceContext, ReferenceFrame } from '../../../src/reference/observations.ts';

test('Agent requests an exact missing frame, reads and segments it, reuses results across planning and later turns, and previews edits without repeating failed or over-budget calls', async () => {
  const png = new PNG({ width: 320, height: 334 }); png.data.fill(240);
  const dataUrl = 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
  const frame = (id: string, time: number, shot = 0, quality = 10): ReferenceFrame => ({ id, time, requestedTime: time, shot, quality, role: 'coverage', width: 320, height: 334, dataUrl });
  const candidates = candidateTimes(12, [4, 7]);
  const selection = chooseCandidates(candidates.candidates.map((candidate, i) => frame('candidate-' + i, candidate.requestedTime, candidate.shot, i % 5 === 2 ? 100 : 5)));
  assert.equal(selection.length, 6);
  assert.deepEqual([...new Set(selection.map(item => item.shot))], [0, 1, 2]);
  assert.equal(selection.filter(item => item.role === 'anchor').length, 3);
  assert.ok(selection.every(item => [0, 4, 7, 12].every(cut => Math.abs(cut - item.time) >= .24)));
  const many = candidateTimes(20, Array.from({ length: 9 }, (_, i) => (i + 1) * 2));
  assert.equal(many.omittedShots, 4); assert.ok(many.candidates.some(item => item.shot === 0));
  let reference: ReferenceContext = { source: { id: 'reference-source', name: 'Reference clip', kind: 'video', duration: 5, originalWidth: 640, originalHeight: 668, cuts: [], omittedShots: 0,
    frames: [frame('early', .5), frame('anchor', 1.5), frame('late', 4)] }, observations: [], callsUsed: 0, framesRequested: false };
  const scene = createEmptyScene('set'), actor = createObject('human', 1); actor.id = 'actor'; actor.transform.position = [0, 3, 0]; scene.objects = [actor];
  let project = { name: 'Reference test', scenes: [scene] }, revision = 0, previews = 0, frameRequests = 0, modelRound = 0, samCalls = 0, cachedTurn = false;
  const sourceBefore = JSON.stringify(reference), book = createConversations(); book.threads[0].draft = 'Read the person reference and put the actor on the floor.';
  const payload = "~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
  const wire = `<0f>7<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334;c=0.9|><|mask;x=0;y=0;c=0.9;data=27,60,${payload}|>`;
  const samTransport = (async () => { samCalls++; return Response.json({ id: 'real-format-fixture', status: 'completed', output_text: wire }); }) as typeof fetch;
  const inference = (input: Parameters<typeof segmentImage>[0], options: Parameters<typeof segmentImage>[2] = {}) => segmentImage(input, { MODEL_API_KEY: 'test-only-never-public' }, { ...options, transport: samTransport });
  const operation = { type: 'place_on', sceneId: 'set', id: 'actor', time: 0, scope: 'static', supportId: null, horizontal: 'keep', clearance: 0 };
  const provider = new MetaProvider({ apiKey: 'test-only-never-public', model: 'test' }, (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); modelRound++;
    const outputs = body.input.filter((part: any) => part.type === 'function_call_output').map((part: any) => JSON.parse(part.output));
    assert.ok(body.tools.some((tool: any) => tool.name === 'segment_reference'));
    assert.match(body.instructions, /image-local IDs/);
    const call = (name: string, args: unknown) => Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'call-' + modelRound, name, arguments: JSON.stringify(args) }] });
    const finish = (operations: unknown[]) => Response.json({ status: 'completed', output_text: JSON.stringify({ summary: 'Read the reference mask and prepared the grounded actor.', requestedViews: [], operations, objectCounts: [] }) });
    if (cachedTurn) {
      if (!outputs.length) return call('segment_reference', { frameId: 'requested', concept: 'person' });
      assert.equal(outputs.at(-1).cached, true); return finish([]);
    }
    if (modelRound === 1) return call('request_reference_frame', { time: 2.3, reason: 'Inspect the unobscured person during the action.' });
    if (modelRound === 2) { assert.match(JSON.stringify(body.input), /requested/); return call('read_reference_frame', { frameId: 'requested' }); }
    if (modelRound === 3) { assert.equal(outputs[0].originalReference, true); assert.equal(outputs[0].sourceShotNumber, 1); return call('segment_reference', { frameId: 'requested', concept: 'person' }); }
    if (modelRound === 4) { assert.deepEqual(outputs[1].instances[0].box, [211, 228, 271, 255]); assert.equal(outputs[1].time, 2.3); assert.equal(outputs[1].sourceShotNumber, 1); return call('segment_reference', { frameId: 'requested', concept: 'PERSON' }); }
    if (modelRound === 5) { assert.equal(outputs[2].cached, true); return call('preview_spatial', { operation, precedingOperations: [] }); }
    assert.equal(outputs[3].ok, true); assert.equal(outputs[3].applied, false); assert.equal(outputs[3].updates[0].transform.position[1], 0); return finish([operation]);
  }) as typeof fetch);
  const library = new AssetLibrary(await mkdtemp(join(tmpdir(), 'littletake-reference-agent-'))), diagnostics: ReturnType<typeof newDiagnostic>[] = [];
  const session = new ConversationSession(book, {
    context: () => ({ project, revision, sceneId: 'set', shotId: null, selectedId: 'actor', time: 0 }), prepare() {}, changed() {},
    capture() { throw new Error('No rendered view was requested'); }, preview(value) { if (value) previews++; },
    apply(value) { project = value; revision++; return true; },
    reference: async () => ({ ...reference, callsUsed: 0, framesRequested: false }),
    saveReferenceObservations: async progress => { reference = { ...reference, observations: progress.observations }; },
    requestReferenceFrames: async (_threadId, sourceId, times) => {
      frameRequests++; assert.equal(sourceId, reference.source.id); assert.deepEqual(times, [2.3]);
      reference = { ...reference, source: { ...reference.source, frames: [...reference.source.frames, { ...frame('requested', 2.3), role: 'requested' }] } }; return reference;
    },
    request: async input => {
      const diagnostic = newDiagnostic(); diagnostics.push(diagnostic);
      return proposeSceneEdit(parseSceneEditInput(input), provider, undefined, diagnostic, library,
        new ReferenceTools(input.reference, {}, inference));
    },
  });
  await session.send();
  assert.equal(frameRequests, 1); assert.equal(samCalls, 1); assert.equal(modelRound, 6); assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].outcome, 'needs_reference_frames'); assert.equal(diagnostics[1].outcome, 'ready');
  assert.equal(previews, 1); assert.equal(project.scenes[0].objects[0].transform.position[1], 3);
  const message = session.active.messages.at(-1)!; assert.equal(message.role, 'assistant');
  if (message.role !== 'assistant') throw new Error('Expected an assistant preview');
  session.apply(message.id); assert.equal(project.scenes[0].objects[0].transform.position[1], 0);
  const savedEvidence = diagnostics[1].referenceCalls as any[];
  assert.equal(savedEvidence.length, 1); assert.equal(savedEvidence[0].receipt.rawOutput, wire); assert.equal(savedEvidence[0].result.source.model, 'sam-3.1');
  assert.equal(JSON.stringify(diagnostics).includes('test-only-never-public'), false);
  const overlay = PNG.sync.read(Buffer.from(reference.observations[0].overlayDataUrl.slice(22), 'base64'));
  assert.deepEqual([overlay.width, overlay.height], [320, 334]);
  assert.notEqual(JSON.stringify(reference), sourceBefore);
  cachedTurn = true; session.setDraft('Use the same person measurement again.'); await session.send(); assert.equal(samCalls, 1);
  assert.equal(session.active.messages.at(-1)?.role, 'assistant');
  // Failed attempts are reserved, never repaid by repeated tool calls, and the
  // four-call allowance survives the browser's frame/render follow-up requests.
  let attempts = 0;
  const bounded = new ReferenceTools({ ...reference, observations: [], callsUsed: 2, framesRequested: true }, {}, async () => { attempts++; throw new AIError('rate_limited', 'Try explicitly later.'); });
  for (let i = 0; i < 2; i++) await assert.rejects(bounded.execute('segment_reference', { frameId: 'anchor', concept: 'missing' }), /explicitly/);
  assert.equal(attempts, 1);
  await assert.rejects(bounded.execute('segment_reference', { frameId: 'anchor', concept: 'door' }), /explicitly/);
  await assert.rejects(bounded.execute('segment_reference', { frameId: 'anchor', concept: 'wall' }), /four-call/);
  await assert.rejects(bounded.execute('request_reference_frame', { time: 3, reason: 'Need another moment.' }), /already requested/);
  assert.equal(attempts, 2); assert.equal(bounded.progress()!.callsUsed, 4);
  const before = attempts;
  await assert.rejects(bounded.execute('segment_reference', { frameId: 'not-in-source', concept: 'person' }), /Unknown reference frame/);
  assert.equal(attempts, before);
  const broken = structuredClone(reference); broken.source.frames[0].width--;
  assert.throws(() => new ReferenceTools(broken, {}, inference), /dimensions/);
  assert.equal(samCalls, 1); assert.equal(SAM_SOURCE.model, 'sam-3.1');
  // Repeated observations and failures stop the director before another paid
  // turn. Different concepts/frames remain meaningful new work.
  for (const invalidFrame of [false, true]) {
    let rounds = 0;
    const loopDiagnostic = newDiagnostic(), callsBefore: number = samCalls;
    const loopReferences = new ReferenceTools({ ...reference, observations: [], callsUsed: 0, framesRequested: false }, {}, inference);
    const loopingProvider = new MetaProvider({ apiKey: 'test-only-never-public', model: 'test' }, (async () => {
      rounds++;
      return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'loop-' + rounds, name: 'segment_reference',
        arguments: JSON.stringify({ frameId: invalidFrame ? 'unknown' : 'anchor', concept: rounds % 2 ? 'person' : 'PERSON' }) }] });
    }) as typeof fetch);
    await assert.rejects(proposeSceneEdit(parseSceneEditInput({ project, sceneId: 'set', shotId: null, selectedId: null, time: 0, history: [], snapshots: [], prompt: 'Read the person.', reference }),
      loopingProvider, undefined, loopDiagnostic, library, loopReferences), (error: unknown) => error instanceof AIError && error.code === 'tool_loop');
    assert.equal(rounds, invalidFrame ? 2 : 3);
    assert.equal(samCalls - callsBefore, invalidFrame ? 0 : 1);
    assert.equal(loopDiagnostic.toolCalls?.length, rounds);
    assert.equal(loopReferences.progress()!.observations.length, invalidFrame ? 0 : 1);
  }
  // Changing conversation while a requested frame is decoding cannot resume
  // the old turn, send another paid request, or overwrite another preview.
  const waitingBook = createConversations(); waitingBook.threads[0].draft = 'Inspect another reference moment.';
  let beginExtraction!: () => void, finishExtraction!: (value: ReferenceContext) => void, requests = 0;
  const extracting = new Promise<void>(resolve => { beginExtraction = resolve; });
  const extraction = new Promise<ReferenceContext>(resolve => { finishExtraction = resolve; });
  const waitingSession = new ConversationSession(waitingBook, {
    context: () => ({ project, revision, sceneId: 'set', shotId: null, selectedId: null, time: 0 }), prepare() {}, changed() {}, capture() { throw new Error('No view requested'); }, preview() {}, apply() { throw new Error('Cancelled work must not apply'); },
    reference: async () => reference,
    requestReferenceFrames: async () => { beginExtraction(); return extraction; },
    request: async () => { requests++; return { status: 'needs_reference_frames', requestedTimes: [3], summary: 'Inspect the action.', provider: 'test', model: 'test', reference: { sourceId: reference.source.id, observations: [], callsUsed: 0, framesRequested: true } }; },
  });
  const sending = waitingSession.send(); await extracting;
  const oldThread = waitingSession.active; waitingSession.create(); finishExtraction(reference); await sending;
  assert.equal(requests, 1); assert.notEqual(waitingSession.active.id, oldThread.id);
  assert.equal(oldThread.messages[0].role === 'user' && oldThread.messages[0].status, 'stopped');
  // A director failure after successful SAM preserves the paid observation in
  // the API error, so an explicit retry can reuse it instead of paying again.
  let partialRound = 0; const originalFetch = globalThis.fetch;
  globalThis.fetch = samTransport;
  try {
    const partialProvider = new MetaProvider({ apiKey: 'test-only-never-public', model: 'test' }, (async () => {
      if (++partialRound > 1) throw new AIError('provider_error', 'Director interrupted.');
      return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'partial', name: 'segment_reference', arguments: JSON.stringify({ frameId: 'anchor', concept: 'person' }) }] });
    }) as typeof fetch);
    const handler = createSceneEditHandler({ MODEL_API_KEY: 'test-only-never-public', LITTLETAKE_ASSET_DIR: await mkdtemp(join(tmpdir(), 'littletake-reference-partial-')) }, () => partialProvider);
    const failed = await handler(new Request('http://localhost/api/scene-edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, sceneId: 'set', shotId: null, selectedId: null, time: 0, history: [], snapshots: [], prompt: 'Measure the original person.', reference: { ...reference, observations: [], callsUsed: 0, framesRequested: false } }) }));
    const error = await failed.json(); assert.equal(failed.status, 502);
    assert.equal(error.reference.callsUsed, 1); assert.equal(error.reference.observations.length, 1);
    assert.equal(error.diagnostic.referenceCalls[0].receipt.rawOutput, wire);
    assert.equal(JSON.stringify(error).includes('test-only-never-public'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('large reference tool diagnostics cross the production response limit without losing source pixels or raw turns', async () => {
  const png = new PNG({ width: 440, height: 330 }); let seed = 1;
  for (let at = 0; at < png.data.length; at += 4) {
    for (let channel = 0; channel < 3; channel++) { seed = (seed * 1664525 + 1013904223) >>> 0; png.data[at + channel] = seed >>> 24; }
    png.data[at + 3] = 255;
  }
  const dataUrl = 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
  const frames = [0, 1, 2].map(index => ({ id: 'frame-' + index, time: index + .2, requestedTime: index + .2, shot: 0, role: 'coverage', quality: 1, width: 440, height: 330, dataUrl }));
  let modelCalls = 0;
  const provider = new MetaProvider({ apiKey: 'test-only-never-public', model: 'test' }, (async (_url, init) => {
    modelCalls++; const body = JSON.parse(String(init?.body));
    if (!body.input.some((part: any) => part.type === 'function_call_output')) return Response.json({ status: 'completed', output: frames.map(frame => ({ type: 'function_call', call_id: frame.id, name: 'read_reference_frame', arguments: JSON.stringify({ frameId: frame.id }) })) });
    assert.equal(body.input.at(-1).content.filter((part: any) => part.type === 'input_image').length, 3);
    return Response.json({ status: 'completed', output_text: JSON.stringify({ summary: 'Read the three original frames.', requestedViews: [], operations: [], objectCounts: [] }) });
  }) as typeof fetch);
  const scene = createEmptyScene('set');
  const handler = createSceneEditHandler({ MODEL_API_KEY: 'test-only-never-public', LITTLETAKE_ASSET_DIR: await mkdtemp(join(tmpdir(), 'littletake-reference-wire-')) }, () => provider);
  const input = { project: { name: 'Large reference test', scenes: [scene] }, sceneId: scene.id, shotId: null, selectedId: null, time: 0, prompt: 'Inspect the three saved frames.', history: [], snapshots: [],
    reference: { source: { id: 'wire-source', name: 'Reference clip', kind: 'video', duration: 3, originalWidth: 440, originalHeight: 330, cuts: [], omittedShots: 0, frames }, observations: [], callsUsed: 0, framesRequested: false } };
  const response = await handler(new Request('https://example.com/api/scene-edit', { method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, br;q=1' }, body: JSON.stringify(input) }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-encoding'), 'br'); assert.equal(response.headers.get('vary'), 'Accept-Encoding');
  const wire = Buffer.from(await response.arrayBuffer()), decoded = brotliDecompressSync(wire);
  assert.ok(decoded.length > 4_500_000); assert.ok(wire.length < 4_000_000);
  const result = JSON.parse(decoded.toString());
  assert.equal(result.status, 'ready'); assert.equal(result.diagnostic.toolTurns.length, 2); assert.equal(result.diagnostic.toolCalls.length, 3);
  assert.deepEqual(result.diagnostic.input.reference.source.frames, frames); assert.equal(modelCalls, 2);
  assert.equal(decoded.includes(Buffer.from('test-only-never-public')), false);
});
