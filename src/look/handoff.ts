import { z } from 'zod';

const fileName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/);
export const videoManifestSchema = z.strictObject({
  format: z.literal('LittleTake.videoPackage'), version: z.literal(1), scene: z.string().max(160), sceneId: z.string().min(1).max(120),
  shot: z.strictObject({ id: z.string().min(1).max(120), name: z.string().max(160), sceneStart: z.number().min(0).max(60), duration: z.number().min(.1).max(60), fps: z.number().int().min(1).max(60) }),
  direction: z.string().max(600),
  brief: z.strictObject({ prompt: z.string().min(1).max(4000), camera: z.string().max(1000), beats: z.array(z.strictObject({ at: z.number().min(0).max(60), action: z.string().max(1000) })).max(100), negative: z.string().max(2000) }),
  frames: z.array(z.strictObject({ file: fileName, at: z.number().min(0).max(60), kind: z.enum(['look', 'previs']) })).min(1).max(240),
  references: z.array(z.strictObject({ file: fileName, role: z.enum(['style', 'character', 'scene']), label: z.string().max(160) })).max(100),
  previs: fileName.nullable(),
  models: z.strictObject({ brief: z.string().max(160), look: z.string().max(160).nullable() }),
  usage: z.string().max(2000),
});
export type VideoManifest = z.infer<typeof videoManifestSchema>;
export interface HandoffReceipt { id: string; token: string; sceneId: string; shotId: string; name: string; createdAt: number; revokedAt: number | null }
export const handoffPath = (token: string) => `/s/${token}/`;
export const museInstruction = (url: string) => `Open ${url} and read the shot brief. Download the original reference images from that page and use them as actual video-generation inputs. Follow the numbered frames, timed action beats and camera instructions. The previs is blocking guidance; keep character identity and the approved look. Generate this shot as one continuous video, not a slideshow. Tell me if any reference cannot be supplied to the video tool, rather than silently ignoring it.`;
