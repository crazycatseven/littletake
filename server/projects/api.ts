import { z } from 'zod';
import { MAX_PROJECT_SIZE } from '../../src/project/storage.ts';
import { ProjectRoomError, ProjectRoomStore } from './store.ts';
import { MAX_OUTPUT_BYTES, MAX_ARCHIVE_BYTES, projectOutputSchema } from '../../src/project/room.ts';
import { readProjectArchive } from '../../src/project/archive.ts';

const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), id: z.uuid(), project: z.unknown(), sourceCode: z.string().max(32).optional() }),
  z.strictObject({ action: z.literal('claim') }),
  z.strictObject({ action: z.literal('heartbeat') }),
  z.strictObject({ action: z.literal('release') }),
  z.strictObject({ action: z.literal('save'), savedVersion: z.number().int().positive(), project: z.unknown() }),
]);
const json = (value: unknown, status = 200) => Response.json(value, { status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
async function readBytes(request: Request, limit: number): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) throw new ProjectRoomError('invalid_body', 'Project data is required.', 400);
  let length = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new ProjectRoomError('project_too_large', 'The uploaded project data is too large.', 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export function createProjectRoomsHandler(store: ProjectRoomStore) {
  return async (request: Request): Promise<Response> => {
    try {
      if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
      const url = new URL(request.url), code = url.searchParams.get('code');
      const lease = request.headers.get('x-littletake-edit-lease') ?? undefined;
      const page = request.headers.get('x-littletake-edit-page') ?? undefined;
      if (lease && !z.uuid().safeParse(lease).success) throw new ProjectRoomError('invalid_lease', 'This editing session is invalid.', 400);
      if (page && !z.uuid().safeParse(page).success) throw new ProjectRoomError('invalid_page', 'This project page is invalid.', 400);
      if (request.method === 'GET') {
        if (!code) throw new ProjectRoomError('code_required', 'Enter a project code to join.', 400);
        const outputId = url.searchParams.get('output');
        if (outputId) {
          const { output, data } = store.readOutput(code, outputId);
          return new Response(new Uint8Array(data), { headers: { 'Content-Type': output.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
        }
        return json(store.get(code, lease, page));
      }
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) throw new ProjectRoomError('wrong_origin', 'Open LittleTake directly to edit a project.', 403);
      if (!lease) throw new ProjectRoomError('lease_required', 'An editing session is required.', 403);
      if (url.searchParams.has('import')) {
        const id = z.uuid().parse(url.searchParams.get('id'));
        const data = await readBytes(request, MAX_ARCHIVE_BYTES);
        let bundle;
        try { bundle = await readProjectArchive(new Blob([new Uint8Array(data)])); }
        catch { throw new ProjectRoomError('invalid_archive', 'The project archive is incomplete or corrupt. Your saved projects are unchanged.', 400); }
        return json(store.create(id, lease, bundle.project, undefined, bundle.outputs, page), 201);
      }
      if (url.searchParams.has('output')) {
        if (!code) throw new ProjectRoomError('code_required', 'Choose a project before saving results.', 400);
        const metadata = projectOutputSchema.omit({ updatedAt: true })
          .parse(JSON.parse(decodeURIComponent(request.headers.get('x-littletake-output') ?? 'null')));
        return json(store.saveOutput(code, lease, metadata, await readBytes(request, MAX_OUTPUT_BYTES), page));
      }
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ProjectRoomError('invalid_content', 'Send a JSON project request.', 415);
      const input = inputSchema.parse(JSON.parse((await readBytes(request, MAX_PROJECT_SIZE + 1024)).toString('utf8')));
      if (input.action === 'create') return json(store.create(input.id, lease, input.project, input.sourceCode, [], page), 201);
      if (!code) throw new ProjectRoomError('code_required', 'Enter a project code to join.', 400);
      if (input.action === 'claim') return json(store.claim(code, lease, page));
      if (input.action === 'heartbeat') return json(store.heartbeat(code, lease, page));
      if (input.action === 'release') return json(store.release(code, lease, page));
      return json(store.save(code, lease, input.savedVersion, input.project, page));
    } catch (error) {
      if (error instanceof ProjectRoomError) return json({ error: { code: error.code, message: error.message } }, error.status);
      if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: { code: 'invalid_request', message: 'The project request is invalid.' } }, 400);
      return json({ error: { code: 'save_unavailable', message: 'The project service could not finish this request. Keep your local changes and retry.' } }, 500);
    }
  };
}
