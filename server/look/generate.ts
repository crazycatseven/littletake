import { z } from 'zod';
import { AIError } from '../ai/provider.ts';

/** Look frames: Muse Image turns a clean previs frame into a finished film still with the composition locked. */
export const LOOK_LIMITS = { maxImageBytes: 1_400_000, maxBodyBytes: 4_000_000, maxDirection: 600, maxSubjects: 40 } as const;
export const LOOK_SIZE = '1600x900';

const IMAGE_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const dataURL = z.string().max(Math.ceil(LOOK_LIMITS.maxImageBytes * 4 / 3) + 40).regex(IMAGE_URL);
const fraction = z.number().min(0).max(1);
const subject = z.strictObject({
  name: z.string().trim().min(1).max(80), position: z.enum(['left', 'center', 'right']), depth: z.enum(['foreground', 'midground', 'background']),
  box: z.tuple([fraction, fraction, fraction, fraction]).refine(([left, top, right, bottom]) => right > left && bottom > top).optional(),
});
const inputSchema = z.strictObject({
  frame: dataURL,
  direction: z.string().trim().min(1).max(LOOK_LIMITS.maxDirection),
  subjects: z.array(subject).max(LOOK_LIMITS.maxSubjects),
  anchor: dataURL.optional(),
  style: dataURL.optional(),
});
export type LookSubject = z.infer<typeof subject>;
export type LookInput = z.infer<typeof inputSchema>;
export interface LookResult { image: string; prompt: string; model: string }

export function parseLookInput(value: unknown): LookInput {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) throw new AIError('invalid_input', 'Send one previs frame, a look description and at most two reference images.', 400);
  for (const url of [parsed.data.frame, parsed.data.anchor, parsed.data.style]) if (url && decode(url).bytes.length > LOOK_LIMITS.maxImageBytes) throw new AIError('image_too_large', 'Each image must be under 1.4 MB.', 413);
  return parsed.data;
}

/** Image order is fixed: @Image1 previs, then the approved anchor frame, then the style reference. */
export function lookPrompt(input: LookInput): string {
  let next = 2;
  const anchor = input.anchor ? `@Image${next++}` : null, style = input.style ? `@Image${next++}` : null;
  const cast = input.subjects.map(item => `${item.name} (${item.position}, ${item.depth})`).join('; ');
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const layout = input.subjects.filter(item => item.box).map(({ name, box: [left, top, right, bottom] = [0, 0, 0, 0] }) => `${name}: x ${percent(left)}–${percent(right)}, y ${percent(top)}–${percent(bottom)}`).join('; ');
  return [
    '@Image1 is a previs frame from a 3D blocking tool: flat-shaded, untextured low-poly proxy shapes that stand in for real people, props and sets.',
    'Render the same moment as one finished cinematic film still.',
    'Lock the composition to @Image1: same camera position, lens and framing, same horizon line, and every subject at the same screen position, scale, silhouette, pose and facing direction. Do not add, remove or move subjects.',
    cast ? `Replace each proxy with the real thing it stands for. Proxies in frame, with screen position and depth: ${cast}.` : 'Replace each proxy shape with the real thing it most plausibly stands for.',
    layout ? `Exact layout, as fractions of the frame measured from the top-left corner. Each subject must fill its box at the same size; do not enlarge, shrink or recentre anyone: ${layout}.` : '',
    anchor ? `${anchor} is an approved still from the same film at a different moment, usually the previous moment of this shot. Match only how things look in it: the people's identity and wardrobe, materials, set dressing, lighting and color grade. Its positions, poses and framing are out of date; every position, pose, scale and the camera framing must come from @Image1.` : '',
    style ? `Use ${style} only as a reference for visual style and palette, never for composition or content.` : '',
    `Look and mood: ${input.direction}`,
    'No text, captions, watermarks, interface elements or split panels. One 16:9 frame.',
  ].filter(Boolean).join('\n');
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
  const prompt = lookPrompt(input), images = [input.frame, input.anchor, input.style].filter((url): url is string => Boolean(url));
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
    if (response.status === 400 && images.length > 1) response = await send('image[]');
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
