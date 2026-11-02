import { videoManifestSchema } from '../../src/look/handoff.ts';
import { readZip } from '../../src/look/zip.ts';
import { MAX_ARCHIVE_BYTES, MAX_OUTPUT_BYTES } from '../../src/project/room.ts';

export async function readVideoPackage(blob: Blob) {
  const entries = await readZip(blob, MAX_ARCHIVE_BYTES, MAX_OUTPUT_BYTES), files = new Map<string, Uint8Array>();
  let folder: string | undefined;
  for (const [name, bytes] of entries) {
    const parts = name.split('/');
    if (parts.length !== 2 || !/^[a-zA-Z0-9_-]+$/.test(parts[0]) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(parts[1]) || (folder && folder !== parts[0])) throw new Error('Choose a LittleTake video package.');
    folder = parts[0]; files.set(parts[1], bytes);
  }
  const manifest = videoManifestSchema.parse(JSON.parse(new TextDecoder().decode(files.get('manifest.json'))));
  const expected = new Set(['manifest.json', 'brief.md']);
  const media = [...manifest.frames, ...manifest.references];
  for (const item of media) {
    const bytes = files.get(item.file), mime = mediaType(item.file);
    if (!bytes || !mime.startsWith('image/') || !imageMatches(bytes, mime)) throw new Error('A reference image is missing or invalid.');
    if ('at' in item && item.at > manifest.shot.duration + .05) throw new Error('A reference frame is outside this shot.');
    if (expected.has(item.file)) throw new Error('Reference file names must be unique.');
    expected.add(item.file);
  }
  if (manifest.previs) {
    const video = files.get(manifest.previs);
    if (!video || mediaType(manifest.previs) !== 'video/webm' || !Buffer.from(video.subarray(0, 4)).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) throw new Error('The previs video is missing or invalid.');
    expected.add(manifest.previs);
  }
  if (!files.has('brief.md') || files.size !== expected.size || [...files.keys()].some(name => !expected.has(name))) throw new Error('This package contains unexpected files.');
  return { manifest, files };
}
export function mediaType(file: string): string {
  return ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', webm: 'video/webm', json: 'application/json', md: 'text/plain; charset=utf-8' } as Record<string, string>)[file.split('.').at(-1)!] ?? 'application/octet-stream';
}
function imageMatches(data: Uint8Array, mime: string) {
  const bytes = Buffer.from(data);
  return mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}
