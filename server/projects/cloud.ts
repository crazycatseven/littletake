import { z } from 'zod';
import { projectArchive, readProjectArchive } from '../../src/project/archive.ts';
import { ProjectRoomError, ProjectRoomStore } from './store.ts';
import { readBytes } from './api.ts';

/** Explicit local-to-cloud transfers; ordinary project saves always use the local store. */
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
      const remote = async (query: string, body?: Blob) => {
        const headers = new Headers();
        if (env.LITTLETAKE_CLOUD_PASSWORD) headers.set('Authorization', 'Basic ' + Buffer.from('littletake:' + env.LITTLETAKE_CLOUD_PASSWORD).toString('base64'));
        for (const name of ['x-littletake-edit-lease', 'x-littletake-edit-page']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
        if (body) { headers.set('Content-Type', 'application/zip'); headers.set('Origin', origin); }
        let response: Response;
        try { response = await fetch(origin + '/api/projects?' + query, { method: body ? 'POST' : 'GET', headers, body, signal: request.signal, redirect: 'error' }); }
        catch (error) { if (request.signal.aborted) throw error; throw new ProjectRoomError('cloud_unavailable', 'The cloud could not be reached. Your local project is saved on this device.', 503); }
        if (!response.ok) {
          const value = await response.json().catch(() => ({}));
          throw new ProjectRoomError(value.error?.code ?? 'cloud_unavailable', value.error?.message ?? 'Cloud access failed. Check the workspace connection.', response.status);
        }
        return response;
      };
      if (request.method === 'GET') return json(await (await remote('list=1')).json());
      const lease = z.uuid().parse(request.headers.get('x-littletake-edit-lease')), page = z.uuid().parse(request.headers.get('x-littletake-edit-page'));
      const input = z.strictObject({ action: z.enum(['open', 'upload']), id: z.uuid(), keepLocal: z.boolean().optional() }).parse(JSON.parse((await readBytes(request, 2048)).toString('utf8')));
      if (input.action === 'open') {
        const bundle = await readProjectArchive(await (await remote('bundle=' + input.id)).blob(), false);
        return json(store.openCloud(bundle, origin, lease, page, input.keepLocal));
      }
      const room = store.getById(input.id, lease, page);
      if (room.editing !== 'you') throw new ProjectRoomError('read_only', 'Start editing the local project before uploading it.', 403);
      if (room.cloud && room.cloud.origin !== origin) throw new ProjectRoomError('cloud_mismatch', 'This project belongs to a different cloud workspace. Upload a duplicate instead.');
      const bundle = store.bundle(input.id);
      const result = await (await remote('upload=1&id=' + input.id + (room.cloud ? '&base=' + room.cloud.version : ''), projectArchive(bundle))).json();
      const local = store.linkCloud(input.id, origin, result.contentVersion ?? result.savedVersion, bundle.version!, lease, page);
      return json({ cloud: local.cloud, url: origin + '/?project=' + result.code });
    } catch (error) {
      if (request.signal.aborted) throw error;
      return json({ error: { code: error instanceof ProjectRoomError ? error.code : 'invalid_transfer', message: error instanceof ProjectRoomError ? error.message : 'This project could not be transferred. Your saved copies are retained.' } }, error instanceof ProjectRoomError ? error.status : 400);
    }
  };
}
