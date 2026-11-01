import { z } from 'zod';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** One editable lighting setup, shared by the viewport, camera preview and exports. */
export const sceneLookSchema = z.strictObject({
  background: color, ground: color, ambientColor: color,
  ambientIntensity: z.number().min(0).max(5),
  keyColor: color, keyIntensity: z.number().min(0).max(8),
  keyPosition: z.tuple([z.number().min(-100).max(100), z.number().min(.1).max(100), z.number().min(-100).max(100)]),
  exposure: z.number().min(.1).max(3),
});
export type SceneLook = z.infer<typeof sceneLookSchema>;
export const DEFAULT_SCENE_LOOK: SceneLook = {
  background: '#e9e7e2', ground: '#eceae4', ambientColor: '#f6f5ee', ambientIntensity: 2.1,
  keyColor: '#fff4dc', keyIntensity: 3.4, keyPosition: [-4, 9, 6], exposure: 1.12,
};

export function lookFields(look: SceneLook): string {
  const colors = { background: 'Background', ground: 'Ground', ambientColor: 'Ambient light', keyColor: 'Key light' };
  const numbers = { ambientIntensity: ['Ambient intensity', 0, 5], keyIntensity: ['Key intensity', 0, 8], exposure: ['Exposure', .1, 3] } as const;
  return '<div class="inspector-section"><div class="section-label">SCENE LIGHTING</div>' +
    Object.entries(colors).map(([key, label]) => `<label class="property-label">${label}<input type="color" aria-label="${label}" data-look="${key}" value="${look[key as keyof typeof colors]}"/></label>`).join('') +
    Object.entries(numbers).map(([key, [label, min, max]]) => `<label class="property-label">${label}<input type="number" aria-label="${label}" data-look="${key}" min="${min}" max="${max}" step="0.1" value="${look[key as keyof typeof numbers]}"/></label>`).join('') +
    '<label class="property-label">Key position</label><div class="vector-inputs">' + look.keyPosition.map((value, i) => `<label class="vector-field"><span>${['X','Y','Z'][i]}</span><input type="number" aria-label="Key position ${['X','Y','Z'][i]}" data-look="keyPosition" data-index="${i}" step="0.5" value="${value}"/></label>`).join('') + '</div></div>';
}
