import { z } from 'zod';
import { createDocument, validateDocument } from '../model.ts';
import type { SceneDocument, ProjectContent } from '../types.ts';
import { validateProjectContent } from './model.ts';
import { conversationsSchema, createConversations, type ConversationBook } from '../scene-edit/conversations.ts';
import { migrateAssetValue } from '../assets/model.ts';

export const PROJECT_STORAGE_KEY = 'littletake.project.v1';
const LEGACY_SCENE_KEY = 'littletake.scene.v1';
export const MAX_PROJECT_SIZE = 20_000_000;
export interface ProjectDocument extends ProjectContent {
  format: 'LittleTake.project'; version: 3; activeSceneId: string | null; activeShotId: string | null; revision: number; conversations: ConversationBook;
}
const projectSchema = z.strictObject({
  format: z.literal('LittleTake.project'), version: z.literal(3), name: z.string(), scenes: z.array(z.unknown()),
  activeSceneId: z.string().nullable(), activeShotId: z.string().nullable(),
  revision: z.number().int().nonnegative(), conversations: conversationsSchema,
  assets: z.array(z.unknown()).max(1000).optional(),
});
export function createProject(scene: SceneDocument | null = createDocument()): ProjectDocument {
  return { format: 'LittleTake.project', version: 3, name: scene?.name ?? 'Untitled project', scenes: scene ? [scene] : [],
    activeSceneId: scene?.id ?? null, activeShotId: scene?.shots[0]?.id ?? null, revision: 0, conversations: createConversations() };
}
export function parseProject(text: string): ProjectDocument {
  if (text.length > MAX_PROJECT_SIZE) throw new Error('Project files must be smaller than 20 MB.');
  let raw = JSON.parse(text);
  const migrating = raw?.format === 'LittleTake.project' && (raw.version === 1 || raw.version === 2);
  if (raw?.format === 'LittleTake.project' && raw.version === 1) {
    raw = z.strictObject({ format: z.literal('LittleTake.project'), version: z.literal(1), scene: z.unknown(),
      revision: z.number().int().nonnegative(), conversations: z.unknown() }).parse(raw);
    const scene = validateDocument(raw.scene);
    for (const thread of raw.conversations?.threads ?? []) for (const message of thread.messages ?? []) {
      if (message.role !== 'assistant' || !message.edit) continue;
      message.edit.sceneId = scene.id; message.edit.shotId = scene.shots[0]?.id ?? null;
      message.edit.operations = message.edit.operations.map((operation: Record<string, unknown>) => ({ ...operation, sceneId: scene.id }));
      if (message.edit.status === 'pending') message.edit.status = 'stale';
    }
    raw = { ...createProject(scene), revision: raw.revision, conversations: raw.conversations };
  }
  if (raw?.format === 'LittleTake.project' && raw.version === 2) raw.version = 3;
  // Retain historical plans while removing only the retired prefab-version field.
  for (const thread of raw?.conversations?.threads ?? []) for (const message of thread.messages ?? []) {
    for (const operation of message.edit?.operations ?? []) if (operation.type === 'instantiate_asset') {
      const asset = migrateAssetValue(operation.asset);
      if (asset !== operation.asset && message.edit.status === 'pending') message.edit.status = 'stale';
      operation.asset = asset;
    }
  }
  const value = projectSchema.parse(raw), content = validateProjectContent({ name: value.name, scenes: value.scenes, ...(value.assets ? { assets: value.assets } : {}) });
  const { assets: _rawAssets, ...metadata } = value;
  const project: ProjectDocument = { ...metadata, ...content };
  const active = project.scenes.find(scene => scene.id === project.activeSceneId);
  if ((project.activeSceneId !== null && !active) || (project.activeShotId !== null && !active?.shots.some(shot => shot.id === project.activeShotId)))
    throw new Error('The saved scene or shot selection is invalid.');
  for (const thread of project.conversations.threads) for (const message of thread.messages) {
    if (message.role === 'user' && message.status === 'pending') {
      message.status = 'stopped'; message.detail = 'This response was interrupted. Retry when you are ready.';
    }
    if (message.role === 'assistant' && message.edit?.status === 'pending' && (migrating || message.edit.revision !== project.revision))
      message.edit.status = 'stale';
  }
  return project;
}
export function serializeProject(project: ProjectDocument): string {
  const text=JSON.stringify(project);if(text.length>MAX_PROJECT_SIZE)throw new Error('Project files must be smaller than 20 MB.');return text;
}

/** Scene and conversations share one local write, so an applied edit and its receipt stay together. */
export class ProjectStorage {
  private saved: string | null = null;
  private recovery: string | null = null;
  private readable = false;
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'>) {}
  load(): { project: ProjectDocument; recovered: boolean } {
    this.saved = this.storage.getItem(PROJECT_STORAGE_KEY);
    const legacy = this.saved === null ? this.storage.getItem(LEGACY_SCENE_KEY) : null;
    this.recovery = this.saved ?? legacy;
    const project = this.saved !== null ? parseProject(this.saved)
      : legacy !== null ? createProject(validateDocument(JSON.parse(legacy))) : createProject();
    this.readable = true;
    return { project, recovered: this.saved !== null || legacy !== null };
  }
  save(project: ProjectDocument): void {
    if (!this.readable) throw new Error('The saved project could not be opened. Download it before replacing it.');
    if (this.storage.getItem(PROJECT_STORAGE_KEY) !== this.saved)
      throw new Error('This project changed in another tab. Download your changes or reload to continue.');
    const text = serializeProject(project);
    try { this.storage.setItem(PROJECT_STORAGE_KEY, text); }
    catch { throw new Error('This browser could not save the project. Download your changes to keep the scene and conversations.'); }
    this.saved = text;
  }
  acceptImport(): void { this.saved = this.storage.getItem(PROJECT_STORAGE_KEY); this.readable = true; }
  savedText(): string | null { return this.saved ?? this.recovery; }
}
