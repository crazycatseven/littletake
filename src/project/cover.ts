import type { ProjectDocument } from './storage.ts';
import type { ProjectCover, ProjectCoverFrame } from './room.ts';

export const COVER_WIDTH = 640, COVER_HEIGHT = 360, MAX_COVER_BYTES = 256_000;
export const COVER_INTERVAL_MS = 5 * 60_000;
export interface CoverAttachment { data: Uint8Array; current: boolean }

export function projectCoverFrame(project: ProjectDocument): ProjectCoverFrame {
  const scene = project.scenes.find(item => item.id === project.activeSceneId) ?? project.scenes[0] ?? null;
  const shot = scene?.shots.find(item => item.id === project.activeShotId) ?? scene?.shots[0];
  const assets = new Set(scene?.objects.map(item => item.asset?.id));
  return { scene, shotId: shot?.id ?? null, assets: (project.assets ?? []).filter(item => assets.has(item.id)) };
}

/** Compare render inputs only: project/chat/entity names and manual controller settings do not change a still. */
export function coverVisual(project: ProjectDocument): string {
  const { scene, shotId, assets } = projectCoverFrame(project);
  if (!scene) return 'null';
  const shot = scene.shots.find(item => item.id === shotId);
  const withoutName = <T extends { name: string }>(item: T) => { const { name: _name, ...value } = item; return value; };
  return JSON.stringify({
    time: shot?.start ?? 0, cameraId: shot?.cameraId ?? scene.cameras[0]?.id ?? null, look: scene.look,
    objects: scene.objects.map(item => ({ ...withoutName(item), components: (item.components ?? []).filter(c => c.type === 'pivot' || c.type === 'followPath') })),
    cameras: scene.cameras.map(withoutName), paths: scene.paths?.map(withoutName), assets: assets.map(withoutName),
  });
}

export function coverDue(cover: ProjectCover | null | undefined, savedVersion: number, now: number, lastAttempt: number, force = false): boolean {
  if (cover?.savedVersion === savedVersion) return false;
  if (force) return true;
  if (lastAttempt && now - lastAttempt < COVER_INTERVAL_MS) return false;
  return !cover?.hasImage || now - cover.updatedAt >= COVER_INTERVAL_MS;
}

/** Covers are bounded, static WebP files; zero bytes intentionally clears an empty scene's old image. */
export function validateCover(data: Uint8Array): void {
  if (!data.length) return;
  const fail = () => { throw new Error('Choose a static 640 × 360 WebP cover smaller than 256 KB.'); };
  if (data.length < 20 || data.length > MAX_COVER_BYTES) fail();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (at: number) => String.fromCharCode(...data.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== data.length) fail();
  let frame = false;
  for (let at = 12; at < data.length;) {
    if (at + 8 > data.length) fail();
    const kind = tag(at), length = view.getUint32(at + 4, true), start = at + 8, end = start + length;
    if (end + (length % 2) > data.length || kind === 'ANIM' || kind === 'ANMF') fail();
    if (kind === 'VP8 ' || kind === 'VP8L' || kind === 'VP8X') {
      let width: number, height: number;
      if (kind === 'VP8 ') {
        if (length < 10 || data[start + 3] !== 0x9d || data[start + 4] !== 1 || data[start + 5] !== 0x2a) fail();
        width = view.getUint16(start + 6, true) & 0x3fff; height = view.getUint16(start + 8, true) & 0x3fff; frame = true;
      } else if (kind === 'VP8L') {
        if (length < 5 || data[start] !== 0x2f) fail();
        const bits = view.getUint32(start + 1, true); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; frame = true;
      } else {
        if (length < 10 || data[start] & 2) fail();
        width = 1 + data[start + 4] + (data[start + 5] << 8) + (data[start + 6] << 16);
        height = 1 + data[start + 7] + (data[start + 8] << 8) + (data[start + 9] << 16);
      }
      if (width !== COVER_WIDTH || height !== COVER_HEIGHT) fail();
    }
    at = end + (length % 2);
  }
  if (!frame) fail();
}
