import { crc32, zipFiles } from '../look/zip.ts';
import { parseProject, serializeProject, type ProjectDocument } from './storage.ts';
import { MAX_ARCHIVE_BYTES, MAX_OUTPUT_BYTES, projectOutputSchema, type ProjectOutput } from './room.ts';

export interface ProjectBundle { project: ProjectDocument; outputs: { output: ProjectOutput; data: Uint8Array }[] }
export function projectArchive(bundle: ProjectBundle): Blob {
  const encoder = new TextEncoder();
  const files = [
    { name: 'project.json', data: encoder.encode(serializeProject(bundle.project)) },
    { name: 'outputs.json', data: encoder.encode(JSON.stringify(bundle.outputs.map(item => item.output))) },
    ...bundle.outputs.map(item => ({ name: 'outputs/' + item.output.id, data: item.data })),
  ];
  const size = files.reduce((sum, file) => sum + file.data.byteLength, 0);
  if (size > MAX_ARCHIVE_BYTES) throw new Error('Project archives must be smaller than 250 MB.');
  return new Blob([zipFiles(files) as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}
/** LittleTake writes stored entries because rendered images and video are already compressed. */
export async function readProjectArchive(blob: Blob): Promise<ProjectBundle> {
  if (blob.size > MAX_ARCHIVE_BYTES) throw new Error('Project archives must be smaller than 250 MB.');
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer), files = new Map<string, Uint8Array>(), decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true), method = view.getUint16(offset + 8, true), size = view.getUint32(offset + 18, true), original = view.getUint32(offset + 22, true), nameSize = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
    if (method !== 0 || flags & 9 || size !== original || size > MAX_OUTPUT_BYTES) throw new Error('Choose a complete LittleTake project archive.');
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameSize)), start = offset + 30 + nameSize + extra;
    if (start + size > bytes.length || files.has(name)) throw new Error('This project archive is incomplete or corrupt.');
    const data = bytes.slice(start, start + size); if (crc32(data) !== view.getUint32(offset + 14, true)) throw new Error('This project archive is corrupt.');
    files.set(name, data); offset = start + size;
  }
  if (!files.has('project.json') || !files.has('outputs.json') || offset + 4 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Choose a complete LittleTake project archive.');
  const project = parseProject(decoder.decode(files.get('project.json')!)), outputs = projectOutputSchema.array().max(1000).parse(JSON.parse(decoder.decode(files.get('outputs.json')!)));
  if (new Set(outputs.map(output => output.id)).size !== outputs.length) throw new Error('Project result IDs must be unique.');
  return { project, outputs: outputs.map(output => { const data = files.get('outputs/' + output.id); if (!data) throw new Error('A saved project result is missing from this archive.'); return { output, data }; }) };
}
