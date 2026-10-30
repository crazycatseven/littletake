import { performance } from 'node:perf_hooks';
import { formats, recordsOfKind, decodeMaskToRaster } from '@meta-sam/parser';
import { PNG } from 'pngjs';
import { z } from 'zod';
import { AIError } from '../../ai/provider.ts';
import type { AIEnvironment } from '../../ai/index.ts';

export const SAM_MODEL = 'sam-3.1';
export const SAM_SOURCE = { provider: 'Meta Model API', model: SAM_MODEL, parser: '@meta-sam/parser@0.1.0' } as const;
export const MAX_SAM_BODY_BYTES = 4_100_000;
const inputSchema = z.strictObject({
  imageDataUrl: z.string().startsWith('data:image/png;base64,').max(4_000_024),
  prompt: z.string().trim().min(1).max(100),
  threshold: z.number().min(0).max(1).optional().default(0.5),
  provider: z.enum(['cloud', 'local']).optional(),
});
export type SamInput = z.input<typeof inputSchema>;
export interface SamReceipt {
  model: typeof SAM_MODEL; prompt: string; status: string; elapsedSeconds: number;
  responseId?: string; requestId?: string; usage?: unknown; rawOutput: string;
}
export interface SamResult {
  source: Record<string, string>; width: number; height: number; prompt: string; threshold: number;
  instances: { objectId: string; box: number[]; score: number | null; pixels: number;
    mask: { width: number; height: number; pngBase64: string } }[];
  diagnostics: readonly unknown[]; receipt: SamReceipt;
}

function providerOf(value: string | undefined) {
  if (value === undefined || value === '') return 'cloud';
  if (value === 'cloud' || value === 'local') return value;
  throw new AIError('invalid_provider', 'SAM_PROVIDER must be cloud or local.', 503);
}

export async function samConnection(env: AIEnvironment) {
  const provider = providerOf(env.SAM_PROVIDER);
  const { localAvailable } = await import('./local.ts');
  const local = localAvailable(env);
  return { available: provider === 'cloud' ? Boolean(env.MODEL_API_KEY?.trim()) : local, provider,
    model: SAM_MODEL, media: ['image/png'], maxUpstreamCalls: provider === 'cloud' ? 1 : 0,
    providers: { cloud: Boolean(env.MODEL_API_KEY?.trim()), local } };
}

/** Explicit cloud/local selection. A cloud request makes at most one paid call. */
export async function segmentImage(raw: SamInput, env: AIEnvironment = process.env, options: {
  transport?: typeof fetch; signal?: AbortSignal; onReceipt?(receipt: SamReceipt): void;
} = {}): Promise<SamResult> {
  const input = inputSchema.parse(raw);
  const bytes = Buffer.from(input.imageDataUrl.slice('data:image/png;base64,'.length), 'base64');
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new AIError('invalid_image', 'SAM requires a PNG reference frame.', 400);
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 16_000_000) throw new AIError('invalid_image', 'Reference frames must contain at most 16 million pixels.', 413);
  try { PNG.sync.read(bytes, { checkCRC: true }); }
  catch { throw new AIError('invalid_image', 'The PNG reference frame could not be decoded.', 400); }
  if (providerOf(input.provider ?? env.SAM_PROVIDER) === 'local') {
    const { segmentLocalImage } = await import('./local.ts');
    return segmentLocalImage({ bytes, width, height, prompt: input.prompt, threshold: input.threshold }, env, options);
  }
  const apiKey = env.MODEL_API_KEY?.trim();
  if (!apiKey) throw new AIError('not_configured', 'Set the server-side MODEL_API_KEY to use SAM 3.1.', 503);
  const started = performance.now();
  const receipt: SamReceipt = { model: SAM_MODEL, prompt: input.prompt, status: 'requesting', elapsedSeconds: 0, rawOutput: '' };
  const signal = AbortSignal.any([AbortSignal.timeout(150_000), ...(options.signal ? [options.signal] : [])]);
  try {
    const response = await (options.transport ?? fetch)('https://api.meta.ai/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ model: SAM_MODEL, stream: false, store: false,
        metadata: { mask_encoding: 'one_bit', include_confidence: 'true' },
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input.prompt }, { type: 'input_image', image_url: input.imageDataUrl }] }],
      }),
    });
    receipt.requestId = response.headers.get('x-request-id') ?? undefined;
    if (!response.ok) {
      // Upstream error bodies can echo input or credentials; never expose them.
      if (response.status === 401 || response.status === 403) throw new AIError('provider_auth', 'Meta did not authorize this SAM request.', 503);
      if (response.status === 402) throw new AIError('credits_required', 'Meta API credits are required for SAM.', 503);
      if (response.status === 429) throw new AIError('rate_limited', 'SAM is rate limited. Retry explicitly later.', 429);
      throw new AIError('provider_error', `SAM request failed (HTTP ${response.status}). No automatic retry was made.`);
    }
    const data = await response.json() as { id?: string; status?: string; usage?: unknown; output_text?: string; output?: { content?: { type?: string; text?: string }[] }[] };
    receipt.responseId = data.id; receipt.usage = data.usage;
    receipt.rawOutput = data.output_text ?? data.output?.flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text ?? '').join('') ?? '';
    if (data.status !== 'completed') throw new AIError('incomplete_response', 'SAM did not complete this segmentation. Partial masks were not published.');
    const parser = formats.segmentation.image().createParser();
    parser.push(receipt.rawOutput);
    const parsed = parser.finish({ status: 'completed' }).result;
    if (parsed.diagnostics.some(item => item.severity === 'error') || parsed.records.some(item => item.kind === 'text' && item.text.trim())) {
      throw new AIError('invalid_segmentation', 'SAM returned malformed segmentation output. The raw output is retained in the receipt.');
    }
    const instances = [];
    for (const record of recordsOfKind(parsed.records, 'mask')) {
      const score = record.confidence ?? recordsOfKind(parsed.records, 'box').find(box => box.objectId === record.objectId)?.confidence ?? null;
      if (score !== null && score < input.threshold) continue;
      const { left, top, right, bottom } = record.bounds;
      if ((record.frame?.frameIndex ?? 0) !== 0 || left < 0 || top < 0 || right > width || bottom > height ||
        record.mask.width !== right - left || record.mask.height !== bottom - top || record.mask.width * record.mask.height > width * height) {
        throw new AIError('coordinate_mismatch', 'SAM mask dimensions or coordinates differ from the source frame.');
      }
      const raster = decodeMaskToRaster(record.mask);
      const png = new PNG({ width: record.mask.width, height: record.mask.height });
      let pixels = 0;
      for (let index = 0; index < raster.length; index++) {
        const value = raster[index] ? 255 : 0; pixels += raster[index] ? 1 : 0;
        png.data[index * 4] = png.data[index * 4 + 1] = png.data[index * 4 + 2] = value; png.data[index * 4 + 3] = 255;
      }
      instances.push({ objectId: record.objectId, box: [left, top, right, bottom], score, pixels,
        mask: { width: png.width, height: png.height, pngBase64: PNG.sync.write(png, { colorType: 0 }).toString('base64') } });
    }
    receipt.status = 'completed';
    return { source: SAM_SOURCE, width, height, prompt: input.prompt, threshold: input.threshold, instances, diagnostics: parsed.diagnostics, receipt };
  } catch (error) {
    receipt.status = error instanceof AIError ? error.code : signal.aborted ? 'cancelled_or_timeout' : 'provider_unavailable';
    if (error instanceof AIError) throw error;
    throw new AIError(receipt.status, 'SAM could not finish this request. No automatic retry was made.', 502);
  } finally {
    receipt.elapsedSeconds = (performance.now() - started) / 1000;
    options.onReceipt?.(receipt);
  }
}
