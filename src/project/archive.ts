import { readZip, zipFiles } from '../look/zip.ts';
import { parseProject, serializeProject, type ProjectDocument } from './storage.ts';
import { MAX_ARCHIVE_BYTES, MAX_OUTPUT_BYTES, projectOutputSchema, type ProjectOutput } from './room.ts';
import { z } from 'zod';

export interface ProjectBundle { id?: string; version?: number; project: ProjectDocument; outputs: { output: ProjectOutput; data: Uint8Array }[] }
export function projectArchive(bundle: ProjectBundle): Blob {
  const encoder = new TextEncoder();
  const files = [
    ...(bundle.id ? [{ name: 'identity.json', data: encoder.encode(JSON.stringify({ id: z.uuid().parse(bundle.id), ...(bundle.version !== undefined ? { version: bundle.version } : {}) })) }] : []),
    { name: 'project.json', data: encoder.encode(serializeProject(bundle.project)) },
    { name: 'outputs.json', data: encoder.encode(JSON.stringify(bundle.outputs.map(item => item.output))) },
    ...bundle.outputs.map(item => ({ name: 'outputs/' + item.output.id, data: item.data })),
  ];
  const size = files.reduce((sum, file) => sum + file.data.byteLength, 0);
  if (size > MAX_ARCHIVE_BYTES) throw new Error('Project archives must be smaller than 250 MB.');
  return new Blob([zipFiles(files) as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}
/** LittleTake writes stored entries because rendered images and video are already compressed. */
export async function readProjectArchive(blob: Blob, recoverInterrupted = true): Promise<ProjectBundle> {
  if (blob.size > MAX_ARCHIVE_BYTES) throw new Error('Project archives must be smaller than 250 MB.');
  const files = await readZip(blob, MAX_ARCHIVE_BYTES, MAX_OUTPUT_BYTES), decoder = new TextDecoder();
  if (!files.has('project.json') || !files.has('outputs.json')) throw new Error('Choose a complete LittleTake project archive.');
  const project = parseProject(decoder.decode(files.get('project.json')!), recoverInterrupted), outputs = projectOutputSchema.array().max(1000).parse(JSON.parse(decoder.decode(files.get('outputs.json')!)));
  if (new Set(outputs.map(output => output.id)).size !== outputs.length) throw new Error('Project result IDs must be unique.');
  const identity = files.get('identity.json');
  return { ...(identity ? z.strictObject({ id: z.uuid(), version: z.number().int().positive().optional() }).parse(JSON.parse(decoder.decode(identity))) : {}), project, outputs: outputs.map(output => { const data = files.get('outputs/' + output.id); if (!data) throw new Error('A saved project result is missing from this archive.'); return { output, data }; }) };
}
