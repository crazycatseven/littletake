import { z } from 'zod';
import { STORYBOARD_MAX_PAGES, STORYBOARD_PAGE_SIZE } from './storyboard.ts';

const fileName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/);
export const videoManifestSchema = z.strictObject({
  format: z.literal('LittleTake.videoPackage'), version: z.literal(1), scene: z.string().max(160), sceneId: z.string().min(1).max(120),
  shot: z.strictObject({ id: z.string().min(1).max(120), name: z.string().max(160), sceneStart: z.number().min(0).max(60), duration: z.number().min(.1).max(60), fps: z.number().int().min(1).max(60) }),
  direction: z.string().max(600),
  brief: z.strictObject({ prompt: z.string().min(1).max(12000), camera: z.string().max(1000), beats: z.array(z.strictObject({ at: z.number().min(0).max(60), action: z.string().max(1000) })).max(100), negative: z.string().max(2000), promptText: z.string().min(1).max(12000).refine(value => !!value.trim()).optional() }),
  frames: z.array(z.strictObject({ file: fileName, at: z.number().min(0).max(60), kind: z.enum(['look', 'previs']) })).min(1).max(240),
  firstFrame: fileName.optional(),
  storyboards: z.array(z.strictObject({ file: fileName, frames: z.array(z.strictObject({ index: z.number().int().min(1).max(121), at: z.number().min(0).max(60) })).min(1).max(STORYBOARD_PAGE_SIZE) })).max(STORYBOARD_MAX_PAGES).optional(),
  references: z.array(z.strictObject({ file: fileName, role: z.enum(['style', 'character', 'scene']), label: z.string().max(160) })).max(100),
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
    'Use the separate first-frame image for the opening composition. Read the numbered reference images in the storyboard pages from left to right, then top to bottom, in page order. Every tile depicts a different moment of this ONE continuous shot; labels are seconds from the shot start, not scene time. Follow these times, character positions, deliberate pauses and camera path, with continuous motion between tiles. The last tile is the last rendered frame before the shot ends. Previs images use simple geometric stand-ins; render the intended subjects in the requested visual style. Optional finished look images guide appearance and identity. The storyboard is temporal guidance, not a layout to reproduce. Never generate a grid, split screen, borders, timestamps, frame numbers, captions or a slideshow. Only still images are supplied as generation inputs.',
    `Avoid: ${brief.negative || 'Unrequested cuts, extra subjects, identity changes, text, logos, and a slideshow of still frames.'}`,
  ].filter(Boolean).join('\n\n');
}
export interface HandoffReceipt { id: string; token: string; sceneId: string; shotId: string; name: string; createdAt: number; revokedAt: number | null }
export const handoffPath = (token: string) => `/s/${token}/`;
export const museInstruction = (url: string) => `Open ${url} and read the full prompt. Download and attach the first-frame image and every numbered storyboard page as actual image inputs. Read each storyboard left to right, then top to bottom, in page order; tile labels give seconds from this shot's start. They are successive moments of one continuous video. Preserve composition, action timing, character identity and the requested look; do not render the grid, labels, numbers or a slideshow. Only images are supplied, not an input video. If you cannot open the link or attach all the images, ask me to upload the original images directly.`;
