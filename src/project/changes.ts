import { z } from 'zod';
import type { ProjectDocument } from './storage.ts';

const selector = z.strictObject({ key: z.enum(['id', 'type', 'time']), value: z.union([z.string().max(2048), z.number().finite()]) });
const segment = z.union([z.string().max(4096).refine(key => !['__proto__', 'prototype', 'constructor'].includes(key)), z.number().int().min(0).max(100000), selector]);
export const changeSchema = z.strictObject({
  path: z.array(segment).min(1).max(64), before: z.unknown().optional(), after: z.unknown().optional(),
  order: z.boolean().optional(), guard: z.boolean().optional(), own: z.boolean().optional(),
});
export type Change = z.infer<typeof changeSchema>;
type Segment = Change['path'][number];
type Selector = z.infer<typeof selector>;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function arrayKey(a: unknown[], b: unknown[]): Selector['key'] | undefined {
  return (['id', 'type', 'time'] as const).find(key => [a, b].every(items => items.every(item => record(item) && ['string', 'number'].includes(typeof item[key])) && new Set(items.map(item => (item as RecordValue)[key])).size === items.length));
}

/** Entity arrays are addressed by identity; vectors are addressed by axis. Never by entity index. */
export function changesBetween(before: unknown, after: unknown, path: Segment[] = []): Change[] {
  if (sameValue(before, after)) return [];
  if (Array.isArray(after) && (Array.isArray(before) || before === undefined)) {
    const old = before ?? [], key = arrayKey(old, after);
    if (key && (old.length || after.length)) {
      const previous = new Map(old.map(item => [item[key], item])), next = new Map(after.map(item => [item[key], item]));
      const changes: Change[] = before === undefined ? [{ path, after: [], guard: true }] : [];
      for (const id of new Set([...previous.keys(), ...next.keys()])) changes.push(...changesBetween(previous.get(id), next.get(id), [...path, { key, value: id }]));
      const oldOrder = old.map(item => item[key]), order = after.map(item => item[key]);
      if (!sameValue(oldOrder, order)) changes.push({ path, before: oldOrder, after: order, order: true });
      return changes;
    }
    if (old.length === 3 && after.length === 3 && [...old, ...after].every(value => typeof value === 'number'))
      return after.flatMap((value, i) => changesBetween(old[i], value, [...path, i]));
  }
  if (before === undefined && record(after) && typeof path.at(-1) !== 'object')
    return [{ path, after: {}, guard: true }, ...Object.keys(after).flatMap(key => changesBetween(undefined, after[key], [...path, key]))];
  if (record(before) && record(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => changesBetween(before[key], after[key], [...path, key]));
  // A new entity is one explicit creation; edits below a deleted identity cannot recreate it.
  return [{ path, ...(before !== undefined ? { before: structuredClone(before) } : {}), ...(after !== undefined ? { after: structuredClone(after) } : {}) }];
}
function child(parent: unknown, part: Segment): unknown {
  if (typeof part === 'object') return Array.isArray(parent) ? parent.find(item => record(item) && item[part.key] === part.value) : undefined;
  return parent && typeof parent === 'object' && Object.hasOwn(parent, part) ? (parent as RecordValue)[part] : undefined;
}
export function valueAt(value: unknown, path: Segment[]): unknown { for (const part of path) value = child(value, part); return value; }
function orderedKeys(value: unknown, example: unknown): unknown {
  if (!Array.isArray(value) || !Array.isArray(example)) return value;
  const key = arrayKey(value, []); return key ? value.map(item => item[key]) : value;
}
export function applyChanges<T>(source: T, changes: Change[]): T {
  const result = structuredClone(source);
  for (const change of changes) {
    const current = valueAt(result, change.path);
    if (change.guard && !sameValue(change.order ? orderedKeys(valueAt(source, change.path), change.before) : current, change.before)) continue;
    if (change.order) {
      if (!Array.isArray(current) || !Array.isArray(change.after)) continue;
      const key = arrayKey(current, []); if (!key) continue;
      if (key === 'time') { current.sort((a, b) => Number(a.time) - Number(b.time)); continue; }
      const order = new Map(change.after.map((id, i) => [id, i]));
      current.sort((a, b) => (order.get(a[key]) ?? Infinity) - (order.get(b[key]) ?? Infinity)); continue;
    }
    let parent: unknown = result;
    for (let i = 0; i < change.path.length - 1; i++) {
      const part = change.path[i]; let next = child(parent, part);
      if (next === undefined && typeof part === 'string' && record(parent) && change.after !== undefined) {
        next = typeof change.path[i + 1] === 'object' || typeof change.path[i + 1] === 'number' ? [] : {};
        parent[part] = next;
      }
      parent = next;
    }
    const last = change.path.at(-1)!;
    if (typeof last === 'object') {
      if (!Array.isArray(parent)) continue;
      const index = parent.findIndex(item => record(item) && item[last.key] === last.value);
      if (change.after === undefined) { if (index >= 0) parent.splice(index, 1); }
      else if (index >= 0) { if (change.before !== undefined || last.key !== 'id') parent[index] = structuredClone(change.after); }
      else if (change.before === undefined) parent.push(structuredClone(change.after));
    } else if (parent && typeof parent === 'object') {
      if (change.after === undefined) delete (parent as RecordValue)[last];
      else (parent as RecordValue)[last] = structuredClone(change.after);
    }
  }
  return result;
}

function shared(project: ProjectDocument): unknown {
  const value = structuredClone(project) as Partial<ProjectDocument>;
  delete value.activeSceneId; delete value.activeShotId; delete value.revision;
  const book = value.conversations as Partial<ProjectDocument['conversations']>;
  delete book.activeId;
  for (const thread of book.threads ?? []) delete (thread as Partial<typeof thread>).draft;
  return value;
}
export function projectChanges(before: ProjectDocument, after: ProjectDocument): Change[] { return changesBetween(shared(before), shared(after)); }

/** Repair only private navigation metadata, never the shared scene graph. */
export function projectView(next: ProjectDocument, local = next): ProjectDocument {
  next.activeSceneId = next.scenes.some(scene => scene.id === local.activeSceneId) ? local.activeSceneId : next.scenes[0]?.id ?? null;
  const scene = next.scenes.find(scene => scene.id === next.activeSceneId);
  next.activeShotId = scene?.shots.some(shot => shot.id === local.activeShotId) ? local.activeShotId : null;
  next.conversations.activeId = next.conversations.threads.some(thread => thread.id === local.conversations.activeId) ? local.conversations.activeId : next.conversations.threads[0]?.id ?? '';
  for (const thread of next.conversations.threads) thread.draft = local.conversations.threads.find(item => item.id === thread.id)?.draft ?? '';
  return next;
}
