import { readZip, zipFiles } from '../look/zip.ts';
import { parseProject, serializeProject, type ProjectDocument } from './storage.ts';
import { MAX_ARCHIVE_BYTES, MAX_OUTPUT_BYTES, projectOutputSchema, type ProjectOutput } from './room.ts';
import { z } from 'zod';
import { validateCover, type CoverAttachment } from './cover.ts';

export interface ProjectBundle { id?: string; version?: number; project: ProjectDocument; outputs: { output: ProjectOutput; data: Uint8Array }[]; cover?: CoverAttachment }
export function projectArchive(bundle: ProjectBundle): Blob {
  validateAppearanceAttachments(bundle.project, bundle.outputs.map(item => item.output));
  const encoder = new TextEncoder();
  if (bundle.cover) validateCover(bundle.cover.data);
  const files = [
    ...(bundle.id ? [{ name: 'identity.json', data: encoder.encode(JSON.stringify({ id: z.uuid().parse(bundle.id), ...(bundle.version !== undefined ? { version: bundle.version } : {}) })) }] : []),
    { name: 'project.json', data: encoder.encode(serializeProject(bundle.project)) },
    { name: 'outputs.json', data: encoder.encode(JSON.stringify(bundle.outputs.map(item => item.output))) },
    ...bundle.outputs.map(item => ({ name: 'outputs/' + item.output.id, data: item.data })),
    ...(bundle.cover ? [{ name: 'cover.json', data: encoder.encode(JSON.stringify({ current: bundle.cover.current })) }, { name: 'cover.webp', data: bundle.cover.data }] : []),
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
  validateAppearanceAttachments(project, outputs);
  const identity = files.get('identity.json');
  let cover: CoverAttachment | undefined;
  if (files.has('cover.json') || files.has('cover.webp')) {
    const data = files.get('cover.webp'); if (!data || !files.has('cover.json')) throw new Error('The project cover is incomplete.');
    const metadata = z.strictObject({ current: z.boolean() }).parse(JSON.parse(decoder.decode(files.get('cover.json')!)));
    validateCover(data); cover = { ...metadata, data };
  }
  return { ...(identity ? z.strictObject({ id: z.uuid(), version: z.number().int().positive().optional() }).parse(JSON.parse(decoder.decode(identity))) : {}), project, ...(cover ? { cover } : {}), outputs: outputs.map(output => { const data = files.get('outputs/' + output.id); if (!data) throw new Error('A saved project result is missing from this archive.'); return { output, data }; }) };
}

export function validateAppearanceAttachments(project: ProjectDocument, outputs: ProjectOutput[]) {
  const available = new Set(outputs.filter(output => output.kind === 'appearance-reference' && output.mime.startsWith('image/')).map(output => output.id));
  for (const scene of project.scenes) for (const object of scene.objects) for (const component of object.components ?? [])
    if (component.type === 'appearanceReference' && component.imageIds.some(id => !available.has(id))) throw new Error(`Appearance images for ${object.name} are missing. Export a complete project archive with its images.`);
}
