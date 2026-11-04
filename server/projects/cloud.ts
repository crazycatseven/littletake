import { z } from 'zod';
import { projectArchive, readProjectArchive } from '../../src/project/archive.ts';
import { ProjectRoomError, ProjectRoomStore } from './store.ts';
import { readBytes } from './api.ts';
import { MAX_ARCHIVE_BYTES } from '../../src/project/room.ts';

/** Browse cloud projects and transfer complete snapshots only at the user's request. */
export function createCloudProjectsHandler(store: ProjectRoomStore, env: Record<string, string | undefined>) {
  const origin = env.LITTLETAKE_CLOUD_URL ? new URL(env.LITTLETAKE_CLOUD_URL).origin : null;
  if (origin && !origin.startsWith('https:') && !['127.0.0.1', 'localhost', '::1'].includes(new URL(origin).hostname))
    throw new Error('A cloud workspace requires HTTPS.');
  return async (request: Request): Promise<Response> => {
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
    try {
      if (!origin) throw new ProjectRoomError('cloud_not_configured', 'Cloud access is not configured on this local server.', 503);
      if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405 });
      const url = new URL(request.url), source = request.headers.get('origin');
      if (request.method === 'POST' && source && source !== url.origin) throw new ProjectRoomError('wrong_origin', 'Open LittleTake directly to transfer a project.', 403);
      const remote = async (query: string, body?: Blob, endpoint: 'projects' | 'handoffs' = 'projects') => {
        const headers = new Headers();
        if (env.LITTLETAKE_CLOUD_PASSWORD) headers.set('Authorization', 'Basic ' + Buffer.from('littletake:' + env.LITTLETAKE_CLOUD_PASSWORD).toString('base64'));
        for (const name of ['x-littletake-edit-lease', 'x-littletake-edit-page']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
        if (body) { headers.set('Content-Type', body.type || 'application/zip'); headers.set('Origin', origin); }
        let response: Response;
        try { response = await fetch(origin + '/api/' + endpoint + '?' + query, { method: body ? 'POST' : 'GET', headers, body, signal: request.signal, redirect: 'error' }); }
        catch (error) { if (request.signal.aborted) throw error; throw new ProjectRoomError('cloud_unavailable', 'The cloud could not be reached. Keep this page open and retry.', 503); }
        if (!response.ok) {
          const value = await response.json().catch(() => ({}));
          if (endpoint === 'handoffs' && value.error?.code === 'shot_missing') throw new ProjectRoomError('shot_missing', 'Upload the new shot to its cloud project, then try again.', 409);
          throw new ProjectRoomError(value.error?.code ?? 'cloud_unavailable', value.error?.message ?? 'Cloud access failed. Check the workspace connection.', response.status);
        }
        return response;
      };
      if (url.searchParams.has('handoff')) {
        const lease = z.uuid().parse(request.headers.get('x-littletake-edit-lease')), page = z.uuid().parse(request.headers.get('x-littletake-edit-page'));
        const local = store.get(url.searchParams.get('code') ?? '', lease, page);
        if (local.editing !== 'you') throw new ProjectRoomError('read_only', 'Open the local project before sharing this shot.', 403);
        if (local.cloud?.origin !== origin) throw new ProjectRoomError('cloud_mismatch', 'Upload this project to the connected cloud workspace first.');
        // Join codes belong to a workspace. Resolve the matching hosted project by its stable ID.
        const hosted = await (await remote('id=' + encodeURIComponent(local.id))).json();
        if (request.method === 'GET') return json(hosted.handoffs ?? []);
        const id = z.uuid().parse(url.searchParams.get('id')), revoke = url.searchParams.has('revoke');
        const query = 'code=' + encodeURIComponent(hosted.code);
        if (!revoke && !request.headers.get('content-type')?.startsWith('application/zip')) throw new ProjectRoomError('invalid_content', 'Send the storyboard package.', 415);
        const body = revoke ? new Blob([]) : new Blob([new Uint8Array(await readBytes(request, MAX_ARCHIVE_BYTES))], { type: 'application/zip' });
        const session = await remote(query, new Blob([JSON.stringify({ action: 'claim' })], { type: 'application/json' }));
        await session.body?.cancel();
        return json(await (await remote(query + '&id=' + id + (revoke ? '&revoke=1' : ''), body, 'handoffs')).json(), revoke ? 200 : 201);
      }
      if (request.method === 'GET') {
        if (url.searchParams.has('cover')) {
          const code = z.string().min(1).max(32).parse(url.searchParams.get('code'));
          const image = await remote('cover=1&code=' + encodeURIComponent(code));
          return new Response(image.body, { status: image.status, headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' } });
        }
        return json(await (await remote('list=1')).json());
      }
      const lease = z.uuid().parse(request.headers.get('x-littletake-edit-lease')), page = z.uuid().parse(request.headers.get('x-littletake-edit-page'));
      const input = z.strictObject({ action: z.enum(['open', 'upload']), id: z.uuid().optional(), code: z.string().min(1).max(32).optional(), keepLocal: z.boolean().optional(), overwrite: z.boolean().optional() })
        .refine(value => value.action === 'upload' ? !!value.id : !!value.id || !!value.code)
        .parse(JSON.parse((await readBytes(request, 2048)).toString('utf8')));
      if (input.action === 'open') {
        const id = input.id ?? (await (await remote('code=' + encodeURIComponent(input.code!))).json()).id;
        const bundle = await readProjectArchive(await (await remote('bundle=' + id)).blob(), false);
        return json(store.openCloud(bundle, origin, lease, page, input.keepLocal));
      }
      const room = store.getById(input.id!, lease, page);
      if (room.editing !== 'you') throw new ProjectRoomError('read_only', 'Open the local project before uploading it.', 403);
      if (room.cloud && room.cloud.origin !== origin) throw new ProjectRoomError('cloud_mismatch', 'This project belongs to a different cloud workspace. Upload a duplicate instead.');
      const bundle = store.bundle(input.id!);
      const latest = input.overwrite ? await (await remote('id=' + input.id)).json() : null;
      const base = latest ? latest.contentVersion ?? latest.savedVersion : room.cloud?.version;
      const result = await (await remote('upload=1&id=' + input.id + (base !== undefined ? '&base=' + base : ''), projectArchive(bundle))).json();
      const local = store.linkCloud(input.id!, origin, result.contentVersion ?? result.savedVersion, bundle.version!, lease, page);
      return json({ cloud: local.cloud, url: origin + '/?project=' + result.code });
    } catch (error) {
      if (request.signal.aborted) throw error;
      return json({ error: { code: error instanceof ProjectRoomError ? error.code : 'invalid_transfer', message: error instanceof ProjectRoomError ? error.message : 'This project could not be transferred. Your saved copies are retained.' } }, error instanceof ProjectRoomError ? error.status : 400);
    }
  };
}
