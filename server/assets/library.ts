import { mkdir, readFile, readdir, writeFile, rename, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { availableAssets } from '../../src/assets/library.ts';
import { assetReferenceSchema, assetSummary, migrateAssetDefinitions, validateAsset, type AssetDefinition } from '../../src/assets/model.ts';
import { renderAssetPreview } from './preview.ts';
import { draftFromAsset, reviseAsset, assetDraft, type AssetDraft } from '../../src/assets/edit.ts';
import { addFolder, assetCatalogSchema, emptyCatalog, renameFolder, requireFolder, type AssetCatalog } from '../../src/assets/folders.ts';

export class AssetConflict extends Error {}

export class AssetLibrary {
  constructor(readonly directory = process.env.LITTLETAKE_ASSET_DIR || (process.env.VERCEL ? path.join(tmpdir(), 'littletake-assets') : path.resolve('.littletake/assets'))) {}
  /** Atomic replacement plus a short filesystem lock also serializes separate local servers. */
  private async writing<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lock = path.join(this.directory, '.write-lock');
    const ownerFile = lock + '.' + crypto.randomUUID() + '.tmp';
    await writeFile(ownerFile, String(process.pid), { flag: 'wx' });
    try {
    for (let attempt = 0; ; attempt++) {
      // Publish the complete owner record atomically; a crash cannot leave an empty lock.
      try { await link(ownerFile, lock); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A killed server must not permanently lock the user's library.
        const owner = Number(await readFile(lock, 'utf8').catch(() => ''));
        if (owner > 0) try { process.kill(owner, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(lock).catch(() => {}); continue; }
        }
        if (attempt >= 100) throw new AssetConflict('The library is busy saving. Please retry; your draft is retained.');
        await new Promise(resolve => setTimeout(resolve, 25)); continue;
      }
      try { return await action(); }
      finally { await unlink(lock); }
    }
    } finally { await unlink(ownerFile); }
  }
  private async write(asset: AssetDefinition) {
    const target = path.join(this.directory, 'definitions', asset.id + '.json'), temporary = target + '.' + crypto.randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(asset), { flag: 'wx' });
    try { await rename(temporary, target); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  private async readCatalog(): Promise<AssetCatalog> {
    try { return assetCatalogSchema.parse(JSON.parse(await readFile(path.join(this.directory, 'catalog.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCatalog(); throw error; }
  }
  private async writeCatalog(catalog: AssetCatalog): Promise<void> {
    const target = path.join(this.directory, 'catalog.json'), temporary = target + '.' + crypto.randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(assetCatalogSchema.parse(catalog)), { flag: 'wx' });
    try { await rename(temporary, target); } finally { await unlink(temporary).catch(() => {}); }
  }
  async browse(): Promise<{ assets: AssetDefinition[]; catalog: AssetCatalog }> {
    return this.writing(async () => ({ assets: await this.readAll(), catalog: await this.readCatalog() }));
  }
  async createFolder(folder: string): Promise<AssetCatalog> {
    return this.writing(async () => { const catalog = await this.readCatalog(); addFolder(catalog, folder); await this.writeCatalog(catalog); return catalog; });
  }
  async renameFolder(from: string, to: string): Promise<AssetCatalog> {
    return this.writing(async () => { const catalog = await this.readCatalog(); renameFolder(catalog, from, to); await this.writeCatalog(catalog); return catalog; });
  }
  async moveAsset(id: string, folder: string): Promise<AssetCatalog> {
    assetReferenceSchema.parse({ id });
    return this.writing(async () => {
      const asset = (await this.readAll()).find(asset => asset.id === id);
      if (!asset || asset.source === 'builtin') throw new Error('Choose an asset from My Assets.');
      const catalog = await this.readCatalog(); requireFolder(catalog, folder); catalog.locations[id] = folder;
      await this.writeCatalog(catalog); return catalog;
    });
  }
  private async readAll(): Promise<AssetDefinition[]> {
    await mkdir(path.join(this.directory, 'definitions'), { recursive: true });
    const names = (await readdir(path.join(this.directory, 'definitions'))).filter(n => n.endsWith('.json')).sort();
    const files = await Promise.all(names.map(async name => ({ name, value: JSON.parse(await readFile(path.join(this.directory, 'definitions', name), 'utf8')) })));
    const current = migrateAssetDefinitions(files.map(file => file.value));
    const legacy = files.filter(file => 'version' in file.value);
    if (legacy.length) {
      const backup = path.join(this.directory, 'legacy-backup'); await mkdir(backup, { recursive: true });
      for (const file of legacy) {
        // Copy before removing so interrupted migration always leaves a recoverable original.
        const target = path.join(backup, file.name);
        try { await writeFile(target, JSON.stringify(file.value), { flag: 'wx' }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      for (const asset of current) if (!files.some(file => file.name === asset.id + '.json' && !('version' in file.value))) await this.write(asset);
      for (const file of legacy) if (file.name !== file.value.id + '.json') await unlink(path.join(this.directory, 'definitions', file.name));
    }
    return availableAssets(current);
  }
  async list(): Promise<AssetDefinition[]> { return this.writing(() => this.readAll()); }
  async search(query: string, embedded: AssetDefinition[] = []) {
    const all = [...await this.list()];
    for (const asset of embedded) if (!all.some(a => a.id === asset.id)) all.push(validateAsset(asset));
    const terms = query.toLowerCase().split(/[\s,，;；]+/).filter(Boolean);
    const ranked = all.map(asset => { const text = [asset.name, asset.description, ...asset.tags].join(' ').toLowerCase();
      return { asset, score: terms.reduce((n, word) => n + (text.includes(word) ? 1 : 0) + asset.tags.filter(t => word.includes(t.toLowerCase())).length, 0) }; }).sort((a, b) => b.score - a.score);
    // Include unmatched candidates for the model to judge semantics; keyword misses alone never authorize generation.
    return { total: all.length, candidates: ranked.slice(0, 40).map(({ asset, score }) => ({ ...assetSummary(asset), keywordMatches: score })), truncated: all.length > 40 };
  }
  async read(id: string, embedded: AssetDefinition[] = []): Promise<AssetDefinition> {
    assetReferenceSchema.parse({ id });
    const asset = (await this.list()).find(a => a.id === id) ?? embedded.find(a => a.id === id);
    if (!asset) throw new Error('Asset ID was not found. Search the library again.');
    return validateAsset(asset);
  }
  async register(asset: AssetDefinition, folder?: string): Promise<AssetDefinition> {
    asset = validateAsset(asset);
    return this.writing(async () => {
      const existing = (await this.readAll()).find(a => a.id === asset.id);
      const catalog = await this.readCatalog();
      if (folder !== undefined) requireFolder(catalog, folder);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(asset)) throw new AssetConflict('This asset already exists. Edit the prefab or save it as a new asset.');
      } else {
        await this.write(asset);
      }
      // A retry repairs an interrupted registration. Once assigned, a later retry cannot undo a move.
      if (folder !== undefined && catalog.locations[asset.id] === undefined) {
        catalog.locations[asset.id] = folder; await this.writeCatalog(catalog);
      }
      return existing ?? asset;
    });
  }
  async revise(base: AssetDefinition, value: AssetDraft): Promise<AssetDefinition> {
    base = validateAsset(base); const draft = assetDraft(value);
    return this.writing(async () => {
      const stored = (await this.readAll()).find(a => a.id === base.id);
      if (stored && JSON.stringify(draftFromAsset(stored)) === JSON.stringify(draft)) return stored;
      if (stored && JSON.stringify(stored) !== JSON.stringify(base)) throw new AssetConflict('This prefab was updated elsewhere. Your draft is retained. Save it as a new prefab, or discard the draft and reload.');
      const asset = reviseAsset(base, draft); await this.write(asset); return asset;
    });
  }
  async saveJob(job: { id: string; [key: string]: unknown }): Promise<void> {
    assetReferenceSchema.shape.id.parse(job.id); await mkdir(path.join(this.directory, 'jobs'), { recursive: true });
    const file = path.join(this.directory, 'jobs', job.id + '.json'), temp = file + '.tmp';
    await writeFile(temp, JSON.stringify(job)); await rename(temp, file);
  }
  async readJob(id: string): Promise<Record<string, unknown>> {
    assetReferenceSchema.shape.id.parse(id);
    return JSON.parse(await readFile(path.join(this.directory, 'jobs', id + '.json'), 'utf8'));
  }
  async preview(asset: AssetDefinition, jointAngles: Record<string, number> = {}): Promise<Uint8Array> { return renderAssetPreview(asset, jointAngles); }
}
