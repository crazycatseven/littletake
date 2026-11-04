import { z } from 'zod';
import { AIError } from '../ai/provider.ts';
import { appearanceImagesSchema } from '../../src/appearance/model.ts';
import { Resvg } from '@resvg/resvg-js';

/** Muse Image keeps the proxy camera/blocking and stages the requested character performance. */
export const LOOK_LIMITS = { maxImageBytes: 1_400_000, maxBodyBytes: 18_000_000, maxDirection: 600, maxSubjects: 40 } as const;
export const LOOK_SIZE = '1600x900';

const IMAGE_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const dataURL = z.string().max(Math.ceil(LOOK_LIMITS.maxImageBytes * 4 / 3) + 40).regex(IMAGE_URL);
const fraction = z.number().min(0).max(1);
const subject = z.strictObject({
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(80), position: z.enum(['left', 'center', 'right']), depth: z.enum(['foreground', 'midground', 'background']),
  box: z.tuple([fraction, fraction, fraction, fraction]).refine(([left, top, right, bottom]) => right > left && bottom > top).optional(),
  view: z.strictObject({ azimuth: z.number().min(-180).max(180), elevation: z.number().min(-90).max(90) }).optional(),
});
const frameInput = z.strictObject({
  frame: dataURL,
  direction: z.string().trim().min(1).max(LOOK_LIMITS.maxDirection),
  note: z.string().trim().max(600).optional(),
  subjects: z.array(subject).max(LOOK_LIMITS.maxSubjects),
  anchor: dataURL.optional(),
  style: dataURL.optional(),
  appearance: appearanceImagesSchema.optional(),
});
const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const storyboardInput = z.strictObject({
  layout: z.literal('2x2'),
  direction: z.string().trim().min(1).max(LOOK_LIMITS.maxDirection),
  panels: z.array(z.strictObject({
    at: z.number().min(0).max(60), frame: dataURL, note: z.string().trim().max(600),
    subjects: z.array(subject).max(LOOK_LIMITS.maxSubjects),
    camera: z.strictObject({ position: vec3, rotation: vec3, fov: z.number().min(1).max(179) }).optional(),
  })).length(4).refine(panels => panels[0].at === 0 && panels.every((panel, i) => !i || panel.at >= panels[i - 1].at)),
  style: dataURL.optional(), appearance: appearanceImagesSchema.optional(),
});
const inputSchema = z.union([frameInput, storyboardInput]);
export type LookSubject = z.infer<typeof subject>;
export type StoryboardInput = z.infer<typeof storyboardInput>;
export type LookInput = z.infer<typeof inputSchema>;
export interface LookResult { image: string; prompt: string; model: string }

const PERFORMANCE_DIRECTION = 'The proxies are blocking stand-ins, not finished acting poses. A rigid upright body, straight limbs, fixed wings or an unchanged proxy between moments does NOT instruct the actor to stand still. Use the creator\'s story and action to stage an expressive, physically believable performance: line of action, weight shift, bent joints, torso/head turns, purposeful gaze, facial expression and appropriate secondary motion. The same root location can contain a crouch, lean, reach, recoil or a wing beat. Let the articulated silhouette change within that staging area; screen boxes guide placement and scale, not exact limb outlines. Preserve any clearly demonstrated action, contacts, travel direction and timed route. Keep rigid props and sets rigid. When no action is specified, use natural engaged posture and subtle reactions; do not invent a fight, a journey, new characters or a new plot. Honor an explicitly requested still pose.';

export function parseLookInput(value: unknown): LookInput {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) throw new AIError('invalid_input', 'Send a previs frame or four ordered storyboard panels, a visual direction and optional references.', 400);
  const images = 'panels' in parsed.data ? parsed.data.panels.map(panel => panel.frame) : [parsed.data.frame, parsed.data.anchor];
  for (const url of [...images, parsed.data.style]) if (url && decode(url).bytes.length > LOOK_LIMITS.maxImageBytes) throw new AIError('image_too_large', 'Each image must be under 1.4 MB.', 413);
  return parsed.data;
}

/** Image order is fixed: @Image1 previs, then the approved anchor frame, then the style reference. */
export function lookPrompt(input: LookInput): string {
  if ('panels' in input) return storyboardPrompt(input);
  let next = 2;
  const anchor = input.anchor ? `@Image${next++}` : null, style = input.style ? `@Image${next++}` : null;
  const cast = input.subjects.map(item => `${item.name} (${item.position}, ${item.depth})`).join('; ');
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const layout = input.subjects.filter(item => item.box).map(({ name, box: [left, top, right, bottom] = [0, 0, 0, 0] }) => `${name}: x ${percent(left)}–${percent(right)}, y ${percent(top)}–${percent(bottom)}`).join('; ');
  return [
    'Edit @Image1 in place. It is a previs frame from a 3D blocking tool: flat-shaded, untextured low-poly proxy shapes that stand in for real people, props and sets.',
    'Draw a finished storyboard illustration or film frame in the requested style. Preserve the framing, camera height, lens and horizon, subject staging positions, overall scale, depth order and negative space. Use photographic realism only if requested; respect drawn, painted or other artistic styles. Do not reproduce low-poly, mannequin or toy-like anatomy unless that is the requested style.',
    'Do not zoom in, crop, reframe, recentre or enlarge the subjects. Small or distant subjects stay small and distant. Keep the cast and set, while giving the actors the performance described below.',
    PERFORMANCE_DIRECTION,
    cast ? `Replace each proxy with the real thing it stands for. Proxies in frame, with screen position and depth: ${cast}.` : 'Replace each proxy shape with the real thing it most plausibly stands for.',
    layout ? `Blocking layout, as fractions of the frame measured from the top-left corner. Keep the subjects centered in their staging areas at this overall scale, allowing articulated limbs to move: ${layout}.` : '',
    anchor ? `${anchor} is an approved still from the same film at a different moment, usually the previous moment of this shot. Match only how things look in it: the people's identity and wardrobe, materials, set dressing, lighting and color grade. Never copy its framing or where and how large anyone is in it; positions, sizes and framing come only from @Image1.` : '',
    style ? `Use ${style} only as a reference for visual style and palette, never for composition or content.` : '',
    ...(input.appearance ?? []).map(reference => `@Image${next++} is an object appearance reference for ${reference.bindings.map(binding => `${binding.objectName} (${binding.primary ? 'primary identity' : 'additional details'})${binding.description ? ': ' + binding.description : ''}`).join('; ')}. Apply it only to these named proxies. Identity, clothing and material come from these references; staging, scale and camera come from @Image1. Act out the requested story; do not copy a neutral reference pose or background.`),
    `Creator's story, action and visual style: ${input.direction}`,
    input.note ? `Action and direction for this moment: ${input.note}. This specifies the performance at this time; preserve the proxy camera and staging while articulating the actors.` : '',
    'No text, captions, watermarks, interface elements or split panels. One 16:9 frame.',
  ].filter(Boolean).join('\n');
}

/** Translate measured subject-relative angles into visual language; raw Euler coordinates were routinely ignored. */
function viewDescription(view: NonNullable<LookSubject['view']>): string {
  const angle = Math.abs(view.azimuth), side = view.azimuth >= 0 ? 'right' : 'left';
  if (view.elevation > 75) return 'almost vertically OVERHEAD, looking down at the top';
  if (view.elevation < -75) return 'almost directly BELOW, looking up at the underside';
  const facing = angle < 22.5 ? 'FRONT view' : angle < 67.5 ? `FRONT ${side} three-quarter view` : angle < 112.5 ? `${side.toUpperCase()} SIDE PROFILE` : angle < 157.5 ? `REAR ${side} three-quarter view` : 'BACK view';
  const height = view.elevation > 45 ? 'steep HIGH ANGLE, looking down' : view.elevation > 20 ? 'HIGH ANGLE, looking down' : view.elevation < -10 ? 'LOW ANGLE, looking up' : 'near body level';
  return `${facing}; ${height}`;
}

/** The four browser-rendered proxy frames share one image-generation request. */
function storyboardPrompt(input: StoryboardInput): string {
  let next = 2;
  return [
    'Edit @Image1 IN PLACE. It is a 2 by 2 contact sheet of FOUR 3D camera views at successive moments. Repaint its four quadrants as finished illustrations. Keep exactly the same equal 2 by 2 layout; each quadrant is 16:9. No gutters, borders, text or labels.',
    'CAMERA IS FIXED PER QUADRANT: copy that quadrant\'s view direction, perspective, horizon, occlusion order, landmark positions, subject centers, relative body sizes and empty space. Preserve even unusual, distant, rear or overhead compositions. Do not improve the framing, zoom, crop, recenter or turn a subject toward the viewer. The four images are views of the SAME set and SAME subjects, not four new compositions. Retain a stationary camera when the sources are stationary.',
    ...input.panels.map((panel, i) => {
      const cast = panel.subjects.map(item => {
        const view = item.view ? viewDescription(item.view) : `${item.position}, ${item.depth}`;
        if (!item.box) return `${item.name}: ${view}`;
        const [left, top, right, bottom] = item.box, height = bottom - top;
        const size = height < .2 ? 'SMALL distant subject' : height < .4 ? 'full subject with generous surrounding space' : 'closer subject';
        return `${item.name}: ${view}; ${size}, reference bounds x=${Math.round(left * 100)}–${Math.round(right * 100)}%, y=${Math.round(top * 100)}–${Math.round(bottom * 100)}% (height ${Math.round(height * 100)}% of this panel)`;
      }).join('. ');
      return `${['TOP LEFT', 'TOP RIGHT', 'BOTTOM LEFT', 'BOTTOM RIGHT'][i]}, ${panel.at.toFixed(2)}s: ${cast || 'Follow the visible proxy scene.'}.${panel.note ? ` Performance: ${panel.note}` : ''}`;
    }),
    'Bounds are measured within each individual panel from its top-left corner. They specify placement and body scale, not rigid limb outlines. Reproduce the visible backgrounds and exact screen relationships; objects hidden behind other objects remain hidden. A 15%-height figure must not become a 50%-height hero. The cast list and projected bounds describe the 3D scene, NOT a checklist of people to make visible. A named subject can be fully behind another person or landmark in a particular quadrant: in that case paint none of that subject, even when its action is described. Keep partially occluded bodies behind the same occluder. Only the visible source pixels determine visibility. Where a whole body and its feet are visible in the source, draw the whole body through the feet with the same ground contact and surrounding margin; do not fade the legs, paint a bust or substitute a closer crop.',
    `STORY AND STYLE: ${input.direction}`,
    'PERFORMANCE: replace mannequin anatomy with believable anatomy. Act out the story through bent joints, weight, torso/head motion, gaze and expressions at the existing staging positions and scale. A rigid proxy is not an instruction to freeze. Follow the timed action directions above; maintain cause and effect and prop continuity. Keep explicitly still poses still and rigid props rigid. Do not invent new events when no action is given. Do not change the camera to show a face or action more clearly.',
    'The proxy construction is NOT the anatomy: replace straight cylindrical limbs, block feet and plank-like wings with articulated human/creature bodies, muscles, joints and natural wing membranes in the requested style. Preserve the stage location and the body\'s physical size, not the mannequin pose. In an action scene show the specified anticipation, execution and recovery; no identical neutral stance across all four moments. Keep toy-like construction only if the creator explicitly requests it.',
    input.style ? `@Image${next++} defines only the visual style and palette, not the composition or subjects.` : '',
    ...(input.appearance ?? []).map(reference => `@Image${next++} is APPEARANCE ONLY for ${reference.bindings.map(binding => `${binding.objectName} (${binding.primary ? 'primary identity' : 'additional details'})${binding.description ? ': ' + binding.description : ''}`).join('; ')}. Ignore its camera, placement, background and neutral poses. Keep these identities, anatomy, wardrobe, materials and lighting consistent across all four quadrants. The camera always comes from the matching quadrant of @Image1.`),
    'Before finishing, match each painted quadrant to its own source quadrant: same viewing side, same camera height, same subject size and centers, same landmarks. An overhead view stays overhead; a back view shows the back; distant subjects stay distant. Expressive acting fits INSIDE these cameras. Output only the repainted four-panel image.',
  ].filter(Boolean).join('\n');
}

function storyboardGrid(input: StoryboardInput): string {
  // This only arranges already rendered images; all 3D rendering stays in the user's browser.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2560" height="1440">${input.panels.map((panel, i) => `<image x="${i % 2 * 1280}" y="${Math.floor(i / 2) * 720}" width="1280" height="720" preserveAspectRatio="xMidYMid meet" href="${panel.frame}"/>`).join('')}</svg>`;
  return 'data:image/png;base64,' + Buffer.from(new Resvg(svg).render().asPng()).toString('base64');
}

function decode(url: string): { type: string; bytes: Buffer } {
  const match = IMAGE_URL.exec(url);
  if (!match) throw new AIError('invalid_input', 'An image could not be read.', 400);
  return { type: match[1], bytes: Buffer.from(match[2], 'base64') };
}

function sniff(bytes: Buffer): string | null {
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString('ascii') === 'PNG') return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  return null;
}

export async function generateLookFrame(input: LookInput, config: { apiKey: string; model: string }, transport: typeof fetch = fetch, signal?: AbortSignal): Promise<LookResult> {
  signal?.throwIfAborted();
  const prompt = lookPrompt(input), grid = 'panels' in input;
  const images = [grid ? storyboardGrid(input) : input.frame, ...(!grid ? [input.anchor] : []), input.style, ...(input.appearance ?? []).map(reference => reference.image)].filter((url): url is string => Boolean(url));
  // Muse Image mirrors the OpenAI Images API (multipart edits). Several references are sent as repeated `image`
  // fields; live testing rejected `image[]`, so that spelling is only a one-time fallback after a 400.
  const send = (field: string) => {
    const form = new FormData();
    form.set('model', config.model); form.set('prompt', prompt); form.set('n', '1'); form.set('size', LOOK_SIZE);
    images.forEach((url, index) => { const { type, bytes } = decode(url); form.append(field, new Blob([new Uint8Array(bytes)], { type: `image/${type}` }), `image-${index + 1}.${type === 'jpeg' ? 'jpg' : type}`); });
    return transport('https://api.meta.ai/v1/images/edits', {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}` }, body: form,
      signal: AbortSignal.any([AbortSignal.timeout(170_000), ...(signal ? [signal] : [])]),
    });
  };
  let response: Response;
  try {
    response = await send('image');
    if (!grid && response.status === 400 && images.length > 1) response = await send('image[]');
  } catch {
    if (signal?.aborted) throw new AIError('cancelled', 'Request cancelled.', 499);
    throw new AIError('provider_unavailable', 'Muse Image could not finish the frame. Please try again.', 504);
  }
  if (!response.ok) {
    // Never echo an upstream error body: it can contain request data or credentials. Only short identifier-like
    // fields (type, code, param) are kept so a rejection can be diagnosed from the editor.
    let detail = '';
    try {
      const error = ((await response.json()) as { error?: Record<string, unknown> }).error ?? {};
      detail = ['type', 'code', 'param'].map(key => error[key]).filter((value): value is string => typeof value === 'string' && /^[\w.\[\]-]{1,60}$/.test(value)).join(' / ');
    } catch {}
    const suffix = detail ? ` (${detail}, HTTP ${response.status})` : ` (HTTP ${response.status})`;
    if (response.status === 402) throw new AIError('credits_required', 'Muse Image needs API credits before it can render frames.', 503);
    if (response.status === 401 || response.status === 403) throw new AIError('provider_auth', 'Muse Image is not authorized on this server.', 503);
    if (response.status === 429) throw new AIError('rate_limited', 'Muse Image is busy. Please wait a moment and try again.', 429);
    if (response.status === 400) throw new AIError('provider_rejected', `Muse Image rejected the request${suffix}.`, 422);
    throw new AIError('provider_error', `Muse Image could not finish the frame${suffix}. Please try again.`);
  }
  let b64: unknown;
  try { b64 = (await response.json() as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json; } catch { b64 = null; }
  const bytes = typeof b64 === 'string' ? Buffer.from(b64, 'base64') : null, type = bytes && sniff(bytes);
  if (!bytes || !type) throw new AIError('invalid_response', 'Muse Image returned no readable image. Please try again.');
  return { image: `data:image/${type};base64,${bytes.toString('base64')}`, prompt, model: config.model };
}
