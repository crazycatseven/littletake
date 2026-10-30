import { z } from 'zod';
import { identifier } from './toolkit/schema.ts';

// These are library paths, independent of filenames and of a project's asset references.
export const folderPathSchema = z.string().max(240).refine(path => path === '' || (
  path.split('/').length <= 8 && path.split('/').every(name => name.length > 0 && name.length <= 80 && name === name.trim() && !['.', '..'].includes(name) && !/[\\<>:"|?*\u0000-\u001f]/.test(name))
), 'Use folder names separated by /, without empty names, dots or special path characters.');
export const assetCatalogSchema = z.strictObject({
  folders: z.array(folderPathSchema.refine(path => path !== '')).max(2000),
  locations: z.record(identifier, folderPathSchema),
});
export type AssetCatalog = z.infer<typeof assetCatalogSchema>;
export const emptyCatalog = (): AssetCatalog => ({ folders: [], locations: {} });
export const folderLabel = (path: string): string => path ? 'My Assets / ' + path.split('/').join(' / ') : 'My Assets';
export const parentFolder = (path: string): string => path.split('/').slice(0, -1).join('/');
export function addFolder(catalog: AssetCatalog, path: string): void {
  folderPathSchema.parse(path);
  const names = path.split('/');
  if (path) for (let i = 1; i <= names.length; i++) {
    const parent = names.slice(0, i).join('/'); if (!catalog.folders.includes(parent)) catalog.folders.push(parent);
  }
  catalog.folders.sort((a, b) => a.localeCompare(b));
}
export function requireFolder(catalog: AssetCatalog, path: string): void {
  folderPathSchema.parse(path);
  if (path && !catalog.folders.includes(path)) throw new Error('This folder no longer exists. Refresh the library and choose a folder.');
}
export function renameFolder(catalog: AssetCatalog, from: string, to: string): void {
  requireFolder(catalog, from); folderPathSchema.parse(to);
  if (!from || !to || to.startsWith(from + '/')) throw new Error('Choose a different folder name outside this folder.');
  if (from === to) return;
  if (catalog.folders.includes(to)) throw new Error('A folder with this name already exists.');
  const replace = (path: string) => path === from || path.startsWith(from + '/') ? to + path.slice(from.length) : path;
  catalog.folders = catalog.folders.map(replace);
  for (const id of Object.keys(catalog.locations)) catalog.locations[id] = replace(catalog.locations[id]);
  addFolder(catalog, to);
  assetCatalogSchema.parse(catalog);
}

export const SCENE_OBJECT_DRAG = 'application/x-littletake-scene-object';
export const LIBRARY_ASSET_DRAG = 'application/x-littletake-asset';
