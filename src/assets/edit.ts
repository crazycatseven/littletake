import { z } from 'zod';
import { constructionEdits, editConstruction, drivenProperties } from './toolkit/edits.ts';
import { assetRecipeSchema, assetSchema, recipeBounds, validateAsset, validateRecipe, type AssetDefinition } from './model.ts';
import { componentsSchema } from '../components/model.ts';
import type { ProjectContent } from '../types.ts';

export const assetDraftSchema = assetRecipeSchema.extend({ template: assetSchema.shape.template });
export type AssetDraft = z.infer<typeof assetDraftSchema>;
const partSchema = assetRecipeSchema.shape.parts.element;
export const assetEditSchema = z.discriminatedUnion('type', [
  ...constructionEdits,
  z.strictObject({ type: z.literal('set_part'), id: partSchema.shape.id, changes: partSchema.omit({ id: true }).partial() }),
  z.strictObject({ type: z.literal('add_part'), part: partSchema }),
  z.strictObject({ type: z.literal('remove_part'), id: partSchema.shape.id }),
  z.strictObject({ type: z.literal('set_metadata'), changes: assetRecipeSchema.pick({ name:true, description:true, tags:true }).partial() }),
  z.strictObject({ type: z.literal('set_components'), components: componentsSchema }),
]);
export type AssetEdit = z.infer<typeof assetEditSchema>;
export function assetDraft(value: unknown): AssetDraft {
  const draft = assetDraftSchema.parse(value); validateRecipe(assetRecipeSchema.strip().parse(draft)); return draft;
}
export function draftFromAsset(asset: AssetDefinition): AssetDraft { return assetDraft(assetDraftSchema.strip().parse(asset)); }
/** Shared by hand editing and the specialist. Validate the entire batch before replacing the draft. */
export function editAsset(value: AssetDraft, edits: AssetEdit[]): AssetDraft {
  const draft = structuredClone(value);
  for (const edit of z.array(assetEditSchema).min(1).max(64).parse(edits)) {
    if (edit.type==='set_construction'||edit.type==='set_parameter'||edit.type==='group_parts'||edit.type==='make_unique'||edit.type==='duplicate_subtree'||edit.type==='bake_construction') { editConstruction(draft, edit as Parameters<typeof editConstruction>[1]); continue; }
    if (edit.type === 'set_metadata') Object.assign(draft, edit.changes);
    else if (edit.type === 'set_components') draft.template = { ...draft.template, track: draft.template?.track ?? null, components: edit.components };
    else if (edit.type === 'add_part') draft.parts.push(edit.part);
    else {
      const part = draft.parts.find(p => p.id === edit.id); if (!part) throw new Error('Part not found: ' + edit.id);
      if (edit.type === 'set_part') {
        const driven=drivenProperties(draft,part.id);
        for(const key of ['position','rotation','size'] as const) if(edit.changes[key] && driven.some(prop=>prop.startsWith(key+'.') && edit.changes[key]![['x','y','z'].indexOf(prop.split('.')[1])] !== part[key][['x','y','z'].indexOf(prop.split('.')[1])])) throw new Error('Field is driven by construction. Edit its parameter, binding or anchor: '+part.id+'.'+key);
        Object.assign(part, edit.changes);
      }
      else { const ids = new Set([edit.id]); let size = 0;
        while (size !== ids.size) { size = ids.size; for (const child of draft.parts) if (child.parentId && ids.has(child.parentId)) ids.add(child.id); }
        draft.parts = draft.parts.filter(p => !ids.has(p.id));
        if(draft.construction){const c=draft.construction;c.bindings=c.bindings.filter(b=>!ids.has(b.partId));c.anchors=c.anchors.filter(a=>!a.partId||!ids.has(a.partId));c.constraints=c.constraints.filter(q=>!ids.has(q.targetId));c.modifiers=c.modifiers.filter(m=>!ids.has(m.targetId));}
      }
    }
  }
  return assetDraft(draft);
}
/** Revisions preserve the local origin: moving a part must not translate all other parts. */
export function reviseAsset(base: AssetDefinition, value: AssetDraft): AssetDefinition {
  const draft = assetDraft(value);
  return validateAsset({ ...draft, id: base.id, source: 'edited', createdAt: base.createdAt, bounds: recipeBounds(draft) });
}
/** Geometry references only. Every instance retains its own transform, tint, performance and components. */
export function updateAssetInstances(project: ProjectContent, assets: AssetDefinition[]): { project: ProjectContent; count: number } {
  const next = structuredClone(project); let count = 0;
  const changed = new Set<string>();
  next.assets = next.assets?.map(previous => {
    const asset = assets.find(a => a.id === previous.id);
    if (!asset || JSON.stringify(previous) === JSON.stringify(asset)) return previous;
    changed.add(asset.id); return validateAsset(asset);
  });
  for (const scene of next.scenes) for (const object of scene.objects) {
    if (object.asset && changed.has(object.asset.id)) count++;
  }
  return { project: next, count };
}

export interface AssetChatMessage { role: 'user' | 'assistant'; text: string; jobId?: string; error?: boolean }
export interface AssetProposal { draft: AssetDraft; approved: boolean; summary: string; jobId: string; incomplete?: boolean }
export interface AssetEditorState { base: AssetDefinition; draft: AssetDraft; messages: AssetChatMessage[]; proposal?: AssetProposal }
/** Compare-and-set avoids silently replacing another tab's asset draft. */
export class AssetDraftStore {
  private raw: string | null;
  readonly key: string;
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'length' | 'key'>>, base: AssetDefinition) {
    this.key = `littletake.asset-draft.${base.id}`; this.raw = storage.getItem(this.key);
    if (!this.raw && storage.key) {
      const prefix = this.key + '@', keys = Array.from({ length: storage.length ?? 0 }, (_, i) => storage.key!(i) ?? '')
        .filter(key => key.startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length))).sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
      const legacy = keys.length ? storage.getItem(keys[0]) : null;
      if (legacy) { storage.setItem(this.key, legacy); this.raw = legacy; }
    }
  }
  read(): AssetEditorState | null {
    if (!this.raw) return null;
    const value = JSON.parse(this.raw); return { base: validateAsset(value.base), draft: assetDraft(value.draft), messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string(), jobId: z.string().optional(), error: z.boolean().optional() })).parse(value.messages), ...(value.proposal ? { proposal: { ...z.object({ approved: z.boolean(), summary: z.string(), jobId: z.string(), incomplete: z.boolean().optional() }).parse(value.proposal), draft: assetDraft(value.proposal.draft) } } : {}) };
  }
  save(state: AssetEditorState): void {
    if (this.storage.getItem(this.key) !== this.raw) throw new Error('Another tab changed this draft. Close and reopen the asset to load it.');
    const raw = JSON.stringify(state); this.storage.setItem(this.key, raw); this.raw = raw;
  }
  clear(): void {
    if (this.storage.getItem(this.key) !== this.raw) throw new Error('Another tab changed this draft.');
    this.storage.removeItem(this.key); this.raw = null;
  }
}
