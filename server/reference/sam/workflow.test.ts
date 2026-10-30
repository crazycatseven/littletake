import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { formats, recordsOfKind, decodeMaskToRaster } from '@meta-sam/parser';
import { createSegmentationHandler } from './api.ts';
import { SAM_MODEL, type SamInput } from './service.ts';

// Complete lossless mask example from Meta's reading-segmentation documentation.
const payload = "~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
const record = (id: number, score = .9) => `${id}<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334;c=${score}|><|mask;x=0;y=0;c=${score};data=27,60,${payload}|>`;

test('SAM API retains sparse image instances and raw receipts, maps cropped masks correctly, and bounds all failures to one paid request without leaking the key', async () => {
  const png = new PNG({ width: 320, height: 334 }); png.data.fill(255);
  const imageDataUrl = 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
  const input = { imageDataUrl, prompt: 'person', threshold: .5 };
  const requests: Record<string, any>[] = [];
  let mode = 'matches';
  const wire = '<0f>' + Array.from({ length: 19 }, (_, index) => record(index * 3 + 2)).join(',');
  const transport = (async (url, init) => {
    assert.equal(url, 'https://api.meta.ai/v1/responses');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key-not-public');
    requests.push(JSON.parse(String(init?.body)));
    if (mode === 'network') throw new Error('internal-provider-secret');
    if (mode === 'limited') return new Response('test-key-not-public', { status: 429 });
    if (mode === 'auth') return new Response('test-key-not-public', { status: 403 });
    return Response.json({ id: 'sam-response', status: mode === 'incomplete' ? 'incomplete' : 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: mode === 'empty' ? '' : mode === 'malformed' ? '<0f>broken-mask' : wire }] }],
      usage: { segmented_images: 1 } }, { headers: { 'x-request-id': 'request-trace' } });
  }) as typeof fetch;
  const handler = createSegmentationHandler({ MODEL_API_KEY: 'test-key-not-public' }, transport);
  const request = (body: SamInput = input, origin = 'http://localhost') => new Request('http://localhost/api/segmentation', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  });
  const connection = await (await handler(new Request('http://localhost/api/segmentation'))).json();
  assert.equal(connection.available, true);
  assert.equal(connection.provider, 'cloud');
  assert.equal(connection.model, SAM_MODEL);
  assert.deepEqual(connection.media, ['image/png']);
  assert.equal(connection.maxUpstreamCalls, 1);
  assert.equal(connection.providers.cloud, true);
  assert.equal(requests.length, 0);
  const success = await handler(request());
  assert.equal(success.status, 200);
  const body = await success.json();
  assert.equal(body.instances.length, 19); // Image requests have no artificial 16-object cap.
  assert.deepEqual(body.instances.map((item: any) => item.objectId), Array.from({ length: 19 }, (_, i) => String(i * 3 + 2)));
  assert.deepEqual(body.instances[0].box, [211, 228, 271, 255]);
  const mask = PNG.sync.read(Buffer.from(body.instances[0].mask.pngBase64, 'base64'));
  assert.deepEqual([mask.width, mask.height], [60, 27]);
  const parser = formats.segmentation.image().createParser(); parser.push('<0f>' + record(2));
  const reference = decodeMaskToRaster(recordsOfKind(parser.finish({ status: 'completed' }).result.records, 'mask')[0].mask);
  assert.deepEqual(Array.from(reference), Array.from({ length: reference.length }, (_, i) => mask.data[i * 4] ? 1 : 0));
  assert.equal(body.receipt.rawOutput, wire);
  assert.equal(body.receipt.responseId, 'sam-response');
  assert.equal(body.receipt.requestId, 'request-trace');
  assert.ok(body.receipt.elapsedSeconds >= 0);
  assert.equal(JSON.stringify(body).includes('test-key-not-public'), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, SAM_MODEL);
  assert.equal(requests[0].stream, false);
  assert.deepEqual(requests[0].metadata, { mask_encoding: 'one_bit', include_confidence: 'true' });
  assert.equal('reasoning' in requests[0], false);
  assert.equal('text' in requests[0], false); // Not Muse's JSON-generation request.
  const filtered = await (await handler(request({ ...input, threshold: .95 }))).json();
  assert.equal(filtered.instances.length, 0);
  mode = 'empty';
  const empty = await (await handler(request())).json();
  assert.deepEqual(empty.instances, []);
  for (const failure of ['incomplete', 'malformed', 'network', 'limited', 'auth']) {
    mode = failure; const before: number = requests.length;
    const response = await handler(request());
    assert.ok(response.status >= 400);
    const result = JSON.stringify(await response.json());
    assert.equal(result.includes('test-key-not-public'), false);
    assert.equal(result.includes('internal-provider-secret'), false);
    assert.equal(requests.length, before + 1); // Never retries a failed paid call.
  }
  const before: number = requests.length;
  assert.equal((await handler(request(input, 'https://unrelated.example'))).status, 403);
  assert.equal((await handler(request({ ...input, imageDataUrl: 'data:image/png;base64,eA==' }))).status, 400);
  assert.equal(requests.length, before);
  // An explicit local choice never falls back to the paid cloud provider.
  const deployed = createSegmentationHandler({ VERCEL: '1', MODEL_API_KEY: 'test-key-not-public' }, transport);
  const local = await deployed(request({ ...input, provider: 'local' }));
  assert.equal(local.status, 503);
  assert.equal((await local.json()).error.code, 'local_unavailable');
  assert.equal(requests.length, before);
  const localDefault = createSegmentationHandler({ VERCEL: '1', SAM_PROVIDER: 'local', MODEL_API_KEY: 'test-key-not-public' }, transport);
  const localStatus = await (await localDefault(new Request('http://localhost/api/segmentation'))).json();
  assert.equal(localStatus.provider, 'local');
  assert.equal(localStatus.available, false);
  assert.equal(localStatus.maxUpstreamCalls, 0);
  assert.equal((await localDefault(request())).status, 503);
  assert.equal(requests.length, before);
  mode = 'empty';
  assert.equal((await localDefault(request({ ...input, provider: 'cloud' }))).status, 200);
  assert.equal(requests.length, before + 1);
});
