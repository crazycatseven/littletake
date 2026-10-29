import { mkdir, readFile, readdir, writeFile, rename, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { builtinAssets } from '../../src/assets/builtin.ts';
import { assetReferenceSchema, assetSummary, validateAsset, type AssetDefinition } from '../../src/assets/model.ts';
import { renderAssetPreview } from './preview.ts';
import { draftFromAsset, reviseAsset, assetDraft, type AssetDraft } from '../../src/assets/edit.ts';

export class AssetConflict extends Error {}

export class AssetLibrary {
  constructor(readonly directory = process.env.LITTLETAKE_ASSET_DIR || path.resolve('.littletake/assets')) {}
  async list(): Promise<AssetDefinition[]> {
    await mkdir(path.join(this.directory, 'definitions'), { recursive: true });
    const names = (await readdir(path.join(this.directory, 'definitions'))).filter(n => n.endsWith('.json')).sort();
    return [...structuredClone(builtinAssets), ...await Promise.all(names.map(async name => validateAsset(JSON.parse(await readFile(path.join(this.directory, 'definitions', name), 'utf8')))))];
  }
  async search(query: string, embedded: AssetDefinition[] = []) {
    const all = [...await this.list()];
    for (const asset of embedded) if (!all.some(a => a.id === asset.id && a.version === asset.version)) all.push(validateAsset(asset));
    const terms = query.toLowerCase().split(/[\s,，;；]+/).filter(Boolean);
    const ranked = all.map(asset => { const text = [asset.name, asset.description, ...asset.tags].join(' ').toLowerCase();
      return { asset, score: terms.reduce((n, word) => n + (text.includes(word) ? 1 : 0) + asset.tags.filter(t => word.includes(t.toLowerCase())).length, 0) }; }).sort((a, b) => b.score - a.score);
    // Include unmatched candidates for the model to judge semantics; keyword misses alone never authorize generation.
    return { total: all.length, candidates: ranked.slice(0, 40).map(({ asset, score }) => ({ ...assetSummary(asset), keywordMatches: score })), truncated: all.length > 40 };
  }
  async read(id: string, version: number, embedded: AssetDefinition[] = []): Promise<AssetDefinition> {
    assetReferenceSchema.parse({ id, version });
    const asset = (await this.list()).find(a => a.id === id && a.version === version) ?? embedded.find(a => a.id === id && a.version === version);
    if (!asset) throw new Error('Asset ID/version was not found. Search the library again.');
    return validateAsset(asset);
  }
  async register(asset: AssetDefinition): Promise<void> {
    validateAsset(asset); await mkdir(path.join(this.directory, 'definitions'), { recursive: true });
    // Publish only a complete immutable version; link is atomic and refuses an existing destination.
    const target = path.join(this.directory, 'definitions', `${asset.id}.${asset.version}.json`), temporary = target + '.' + crypto.randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(asset), { flag: 'wx' });
    try { await link(temporary, target); } finally { await unlink(temporary); }
  }
  async revise(base: AssetDefinition, value: AssetDraft): Promise<AssetDefinition> {
    base = validateAsset(base); const draft = assetDraft(value), all = await this.list();
    const versions = all.filter(a => a.id === base.id), stored = versions.find(a => a.version === base.version);
    if (stored && JSON.stringify(stored) !== JSON.stringify(base)) throw new AssetConflict('The base asset differs from the immutable library version. Reopen it from the library.');
    const latest = versions.sort((a, b) => b.version - a.version)[0];
    const sameDraft = (a: AssetDefinition) => JSON.stringify(draftFromAsset(a)) === JSON.stringify(draft);
    // The same request can safely be retried after a lost response.
    if (latest && latest.version > base.version) {
      if (latest.version === base.version + 1 && sameDraft(latest)) return latest;
      throw new AssetConflict(`Version ${latest.version} already exists. Your draft is retained; reopen the latest version before editing.`);
    }
    const asset = reviseAsset(base, draft);
    if (!stored) { try { await this.register(base); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const found = await this.read(base.id, base.version); if (JSON.stringify(found) !== JSON.stringify(base)) throw new AssetConflict('Conflicting imported asset.'); } }
    try { await this.register(asset); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const found = await this.read(asset.id, asset.version); if (sameDraft(found)) return found;
      throw new AssetConflict('Another editor saved this version first. Your draft has been retained.');
    }
    return asset;
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
