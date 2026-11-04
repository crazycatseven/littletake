import type { Workspace } from '../project/workspace';
import type { ProjectRoom } from '../project/room';
import type { SceneDocument } from '../types';
import { newId } from '../id';
import { APPEARANCE_LIMITS, appearanceBindings, appearanceImagesSchema, type AppearanceImage } from './model';
import type { OutputTransfer } from '../project/output-upload';

const cache = new Map<string, Promise<string>>();
export function appearanceImage(workspace: Workspace, id: string, room = workspace.room): Promise<string> {
  const key = `${room?.id}:${id}`;
  let result = cache.get(key);
  if (!result) {
    result = workspace.output(id, room).then(blob => new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('The reference image could not be read.')); reader.readAsDataURL(blob);
    })).catch(error => { cache.delete(key); throw error; });
    cache.set(key, result);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
  }
  return result;
}

export async function uploadAppearance(workspace: Workspace, files: File[], sceneId: string, room: ProjectRoom, progress?: (name: string, state: OutputTransfer) => void): Promise<string[]> {
  if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20_000_000)) throw new Error('Choose PNG, JPEG or WebP images smaller than 20 MB each.');
  // Decode every file before saving anything, so an invalid file cannot leave a partial binding.
  const images: { name: string; blob: Blob }[] = [];
  for (const file of files) {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas'), scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d')!; context.fillStyle = '#f2f2f2'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      let blob: Blob | null = null;
      for (const quality of [.9, .8, .65, .5]) {
        blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= APPEARANCE_LIMITS.imageBytes) break;
      }
      if (!blob || blob.size > APPEARANCE_LIMITS.imageBytes) throw new Error('This image has too much detail. Use a smaller reference image.');
      images.push({ name: file.name.slice(0, 160), blob });
    } finally { bitmap.close(); }
  }
  const ids: string[] = [], failures: string[] = [];
  for (const { name, blob } of images) {
    if (workspace.room !== room || !workspace.canEdit) throw new Error('Project changed. Open the original project to attach these images.');
    try {
      const output = await workspace.putOutput({ id: newId(), kind: 'appearance-reference', sceneId, shotId: '', name, mime: 'image/jpeg' }, blob, room, state => progress?.(name, state));
      ids.push(output.id);
    } catch { failures.push(name); }
  }
  if (failures.length) throw new Error(`${failures.length} of ${images.length} images could not upload. Retry the failed images in Assets / References; keep this page open.`);
  return ids;
}

export async function loadAppearance(workspace: Workspace, scene: SceneDocument, objectIds?: ReadonlySet<string>, room = workspace.room): Promise<AppearanceImage[]> {
  const refs = appearanceBindings(scene, objectIds);
  if (refs.length > APPEARANCE_LIMITS.perRequest) throw new Error(`Use at most ${APPEARANCE_LIMITS.perRequest} distinct appearance images in one Muse request or shot.`);
  const images = await Promise.all(refs.map(async ref => {
    try { return { ...ref, image: await appearanceImage(workspace, ref.id, room) }; }
    catch { throw new Error(`Appearance reference for ${ref.bindings.map(b => b.objectName).join(', ')} is unavailable. Reattach it in Inspector before continuing.`); }
  }));
  return appearanceImagesSchema.parse(images);
}
