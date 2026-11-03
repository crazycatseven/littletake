import { z } from 'zod';
import { validateProjectContent } from '../../src/project/model.ts';
import { applyProjectOperations, operationSchema } from '../../src/scene-edit/operations.ts';
import { inspectSpatial, solveSpatial } from '../../src/spatial/methods.ts';
import { spatialOperationSchema, spatialQuerySchema } from '../../src/spatial/schema.ts';

const requestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect'), project: z.unknown(), precedingOperations: z.array(operationSchema).max(64).optional().default([]), query: spatialQuerySchema }),
  z.strictObject({ action: z.literal('solve'), project: z.unknown(), precedingOperations: z.array(operationSchema).max(64).optional().default([]), operation: spatialOperationSchema }),
]);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
/** Stateless geometry API. Caller-supplied documents only; no storage, AI calls or credentials. */
export function createSpatialHandler() {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return json({ ok: false, error: 'Use POST with action=inspect or solve.' }, 405);
    const reader = request.body?.getReader();
    if (!reader) return json({ ok: false, error: 'A JSON body is required.' }, 400);
    try {
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 4_100_000) { await reader.cancel(); return json({ ok: false, error: 'Spatial request is too large.' }, 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const input = requestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      const time = input.action === 'inspect' ? input.query.time : input.operation.time;
      const project = applyProjectOperations(validateProjectContent(input.project), input.precedingOperations, time);
      return json({ ok: true, applied: false, ...(input.action === 'inspect'
        ? { result: inspectSpatial(project, input.query) }
        : { operation: input.operation, result: solveSpatial(project, input.operation) }) });
    } catch (error) {
      const message = error instanceof z.ZodError ? error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
        : error instanceof Error ? error.message : 'Spatial calculation failed.';
      return json({ ok: false, applied: false, error: message }, 400);
    } finally { reader.releaseLock(); }
  };
}
