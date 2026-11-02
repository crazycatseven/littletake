import { z } from 'zod';
import { ProjectRoomError, type ProjectRoomStore } from '../projects/store.ts';
import { readBytes } from '../projects/api.ts';
import { MAX_ARCHIVE_BYTES } from '../../src/project/room.ts';
import { readVideoPackage, mediaType } from './package.ts';
import { handoffPage } from './page.ts';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
export function createHandoffsHandler(store: ProjectRoomStore) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url), match = /^\/s\/([A-Za-z0-9_-]{43})(?:\/([^/]*))?$/.exec(url.pathname);
      if (match) {
        if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
        const snapshot = store.readHandoff(match[1]), file = match[2] || '';
        const bundle = await readVideoPackage(new Blob([new Uint8Array(snapshot.archive)]));
        if (!file) return new Response(request.method === 'HEAD' ? null : handoffPage(bundle.manifest, match[1], snapshot.createdAt, url.origin), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
        let bytes: Uint8Array | undefined, mime: string;
        if (file === 'package.zip') { bytes = snapshot.archive; mime = 'application/zip'; }
        else { bytes = bundle.files.get(file); mime = mediaType(file); }
        if (!bytes) throw new ProjectRoomError('file_missing', 'This reference file could not be found.', 404);
        const responseHeaders = new Headers({ ...headers, 'Content-Type': mime, 'Content-Length': String(bytes.byteLength), 'Accept-Ranges': 'bytes' });
        if (file === 'package.zip') responseHeaders.set('Content-Disposition', 'attachment; filename="littletake-video-package.zip"');
        // Native video playback can request byte ranges without downloading the whole archive again.
        const range = request.headers.get('range');
        if (range && request.method === 'GET') {
          const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!parsed || (!parsed[1] && !parsed[2])) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${bytes.byteLength}` } });
          const start = parsed[1] ? Number(parsed[1]) : Math.max(0, bytes.byteLength - Number(parsed[2]));
          const end = parsed[1] && parsed[2] ? Math.min(Number(parsed[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
          if (start > end || start >= bytes.byteLength) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${bytes.byteLength}` } });
          responseHeaders.set('Content-Range', `bytes ${start}-${end}/${bytes.byteLength}`); responseHeaders.set('Content-Length', String(end - start + 1));
          return new Response(new Uint8Array(bytes.slice(start, end + 1)), { status: 206, headers: responseHeaders });
        }
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: responseHeaders });
      }
      if (url.pathname !== '/api/handoffs') throw new ProjectRoomError('share_missing', 'This reference link could not be found.', 404);
      const code = url.searchParams.get('code') || '', lease = z.uuid().parse(request.headers.get('x-littletake-edit-lease')), page = request.headers.get('x-littletake-edit-page') ?? undefined;
      if (page) z.uuid().parse(page);
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) throw new ProjectRoomError('wrong_origin', 'Publish references from LittleTake directly.', 403);
      if (store.get(code, lease, page).editing !== 'you') throw new ProjectRoomError('read_only', 'Start editing before publishing or withdrawing a reference link.', 403);
      const id = z.uuid().parse(url.searchParams.get('id'));
      if (url.searchParams.has('revoke')) { store.revokeHandoff(code, lease, id, page); return Response.json({ withdrawn: true }, { headers }); }
      if (!request.headers.get('content-type')?.startsWith('application/zip')) throw new ProjectRoomError('invalid_content', 'Publish a LittleTake video package.', 415);
      const bytes = await readBytes(request, MAX_ARCHIVE_BYTES);
      let bundle;
      try { bundle = await readVideoPackage(new Blob([new Uint8Array(bytes)])); }
      catch { throw new ProjectRoomError('invalid_package', 'The reference package is incomplete or invalid. Nothing was published.', 400); }
      return Response.json(store.publishHandoff(code, lease, id, bundle.manifest, bytes, page), { status: 201, headers });
    } catch (error) {
      const status = error instanceof ProjectRoomError ? error.status : error instanceof z.ZodError ? 400 : 500;
      return Response.json({ error: { code: error instanceof ProjectRoomError ? error.code : 'share_unavailable', message: error instanceof ProjectRoomError ? error.message : status === 400 ? 'This publication request is invalid.' : 'The reference service could not finish this request.' } }, { status, headers });
    }
  };
}
