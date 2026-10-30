import { z } from 'zod';
import { AssetConflict, AssetLibrary } from './library.ts';
import { createAIProvider } from '../ai/index.ts';
import { AIError, type AIProvider } from '../ai/provider.ts';
import { assetSchema, assetReferenceSchema, validateAsset } from '../../src/assets/model.ts';
import { folderPathSchema } from '../../src/assets/folders.ts';
import { assetDraftSchema, reviseAsset } from '../../src/assets/edit.ts';
import { AssetExpertError, reviseWithExpert } from './revision-expert.ts';

const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('register'), asset: assetSchema, folder: folderPathSchema.optional() }),
  z.strictObject({ action: z.literal('create_folder'), folder: folderPathSchema }),
  z.strictObject({ action: z.literal('rename_folder'), from: folderPathSchema, to: folderPathSchema }),
  z.strictObject({ action: z.literal('move_asset'), assetId: assetReferenceSchema.shape.id, folder: folderPathSchema }),
  z.strictObject({ action: z.literal('save'), base: assetSchema, draft: assetDraftSchema }),
  z.strictObject({ action: z.literal('preview'), base: assetSchema, draft: assetDraftSchema }),
  z.strictObject({ action: z.literal('expert'), base: assetSchema, draft: assetDraftSchema, prompt: z.string().trim().min(1).max(3000), history: z.array(z.strictObject({ role: z.enum(['user','assistant']), text: z.string().max(4000) })).max(16) }),
]);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
async function body(request: Request): Promise<unknown> {
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) throw new AIError('wrong_origin', 'Open LittleTake directly to edit assets.', 403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AIError('invalid_input', 'Send a JSON asset request.', 415);
  const reader = request.body?.getReader(); if (!reader) throw new AIError('invalid_input', 'Asset data is required.', 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2_000_000) { await reader.cancel(); throw new AIError('too_large', 'Asset request is too large.', 413); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createAssetsHandler(library = new AssetLibrary(), providerFactory: () => AIProvider = () => createAIProvider(process.env)) {
  return async (request: Request): Promise<Response> => {
    if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    const params = new URL(request.url).searchParams;
    try {
      if (request.method === 'POST') {
        const input = inputSchema.parse(await body(request));
        if (input.action === 'register') return json({ asset: await library.register(input.asset, input.folder) });
        if (input.action === 'create_folder') return json({ catalog: await library.createFolder(input.folder) });
        if (input.action === 'rename_folder') return json({ catalog: await library.renameFolder(input.from, input.to) });
        if (input.action === 'move_asset') return json({ catalog: await library.moveAsset(input.assetId, input.folder) });
        const base = validateAsset(input.base);
        if (input.action === 'save') return json({ asset: await library.revise(base, input.draft) });
        if (input.action === 'expert') return json(await reviseWithExpert(base, input.draft, input.prompt, input.history, providerFactory(), library, request.signal));
        return new Response(Buffer.from(await library.preview(reviseAsset(base, input.draft))), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
      }
      if (params.has('jobId')) return json(await library.readJob(params.get('jobId')!));
      if (params.has('id')) {
        const asset = await library.read(params.get('id')!);
        if (params.get('preview') === '1') return new Response(Buffer.from(await library.preview(asset)), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
        return json(asset);
      }
      return json({ ...await library.browse(), temporary: Boolean(process.env.VERCEL && !process.env.LITTLETAKE_ASSET_DIR) });
    } catch (error) {
      const status = error instanceof AssetConflict ? 409 : error instanceof AIError ? error.status : 400;
      return json({ error: { message: error instanceof Error ? error.message : 'The asset request failed.', ...(error instanceof AssetExpertError ? { jobId: error.jobId } : {}) } }, status);
    }
  };
}
