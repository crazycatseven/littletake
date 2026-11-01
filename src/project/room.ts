import type { ProjectDocument } from './storage.ts';
import { z } from 'zod';

export interface ProjectRoom {
  id: string;
  code: string;
  project: ProjectDocument;
  savedVersion: number;
  updatedAt: number;
  editing: 'available' | 'you' | 'occupied';
  leaseExpiresAt: number | null;
  outputs: ProjectOutput[];
}

export const projectOutputSchema = z.strictObject({
  id: z.uuid(), kind: z.enum(['look-frame', 'video-brief', 'reference-analysis', 'style-reference', 'reference-media']),
  sceneId: z.string().max(120), shotId: z.string().max(120), name: z.string().min(1).max(160),
  mime: z.enum(['application/json', 'image/png', 'image/jpeg', 'image/webp']), updatedAt: z.number().int().nonnegative(),
});
export type ProjectOutput = z.infer<typeof projectOutputSchema>;
export const MAX_OUTPUT_BYTES = 64_000_000;
export const MAX_ARCHIVE_BYTES = 250_000_000;

export const EDIT_LEASE_MS = 90_000;
export const EDIT_HEARTBEAT_MS = 20_000;
