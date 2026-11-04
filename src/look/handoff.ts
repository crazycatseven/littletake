import { z } from 'zod';
import { STORYBOARD_MAX_PAGES, STORYBOARD_PAGE_SIZE } from './storyboard.ts';
import { appearanceBindingSchema } from '../appearance/model.ts';

const fileName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/);
export const videoManifestSchema = z.strictObject({
  format: z.literal('LittleTake.videoPackage'), version: z.literal(1), scene: z.string().max(160), sceneId: z.string().min(1).max(120),
  shot: z.strictObject({ id: z.string().min(1).max(120), name: z.string().max(160), sceneStart: z.number().min(0).max(60), duration: z.number().min(.1).max(60), fps: z.number().int().min(1).max(60) }),
  direction: z.string().max(600),
  storyboardStyle: z.enum(['proxy', 'ai']).optional(),
  brief: z.strictObject({ prompt: z.string().min(1).max(12000), camera: z.string().max(1000), beats: z.array(z.strictObject({ at: z.number().min(0).max(60), action: z.string().max(1000) })).max(100), negative: z.string().max(2000), promptText: z.string().min(1).max(12000).refine(value => !!value.trim()).optional() }),
  frames: z.array(z.strictObject({ file: fileName, at: z.number().min(0).max(60), kind: z.enum(['look', 'previs']), note: z.string().max(600).optional() })).min(1).max(240),
  firstFrame: fileName.optional(),
  storyboards: z.array(z.strictObject({ file: fileName, frames: z.array(z.strictObject({ index: z.number().int().min(1).max(121), at: z.number().min(0).max(60) })).min(1).max(STORYBOARD_PAGE_SIZE) })).max(STORYBOARD_MAX_PAGES).optional(),
  references: z.array(z.strictObject({ file: fileName, role: z.enum(['style', 'character', 'scene', 'appearance']), label: z.string().max(160), bindings: z.array(appearanceBindingSchema).min(1).max(100).optional() })).max(100),
  previs: fileName.nullable(),
  models: z.strictObject({ brief: z.string().max(160), look: z.string().max(160).nullable() }),
  usage: z.string().max(2000),
});
export type VideoManifest = z.infer<typeof videoManifestSchema>;
/** The same editable instruction is copied, saved, packaged and shown on the public page. */
export function videoPrompt(shot: { duration: number }, brief: VideoManifest['brief'], direction: string): string {
  if (brief.promptText !== undefined) return brief.promptText;
  return [`Create one continuous ${shot.duration.toFixed(2)}-second, 16:9 film shot.`, brief.prompt,
    brief.camera && `Camera: ${brief.camera}`,
    brief.beats.length && `Action timing (seconds from the start of this shot):\n${[...brief.beats].sort((a,b) => a.at-b.at).map(beat => `- ${beat.at.toFixed(2)} s: ${beat.action}`).join('\n')}`,
    direction && `Creative direction: ${direction}`,
    'Use the separate first-frame image for the opening composition. Read storyboard panels from left to right, then top to bottom, in page order. They depict successive moments; times in the prompt and reference metadata are seconds from this shot’s start. Follow the character positions, deliberate pauses and camera path, with continuous motion between panels. Previs images use geometric stand-ins; render the intended subjects in the requested visual style. Finished illustrations guide appearance and identity. The storyboard is temporal guidance, not a layout to reproduce. Never generate a grid, split screen, borders, timestamps, frame numbers, captions or a slideshow. Only still images are supplied as generation inputs.',
    `Avoid: ${brief.negative || 'Unrequested cuts, extra subjects, identity changes, text, logos, and a slideshow of still frames.'}`,
  ].filter(Boolean).join('\n\n');
}
export interface HandoffReceipt { id: string; token: string; sceneId: string; shotId: string; name: string; createdAt: number; revokedAt: number | null }
export const handoffPath = (token: string) => `/s/${token}/`;
export const MUSE_URL = 'https://muse.ai/';
export const museInstruction = (url: string) => `Render this shot as a video using the prompt, storyboard and reference images on this page:\n${url}`;

/** Never hand a device-local or private-network address to an external Muse conversation. */
export function isPublicHandoffUrl(value: string): boolean {
  const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (host.startsWith('[')) return /^\[[23][0-9a-f]{3}:/.test(host);
  if (!host.includes('.') || /\.(?:localhost|local|internal|lan|test)$/.test(host)) return false;
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!ip) return true;
  const first = Number(ip[1]), second = Number(ip[2]);
  return ![0,10,127].includes(first) && first < 224 && !(first === 192 && second === 168)
    && !(first === 169 && second === 254) && !(first === 172 && second >= 16 && second <= 31)
    && !(first === 100 && second >= 64 && second <= 127);
}
