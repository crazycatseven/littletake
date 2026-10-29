export interface XRButtonComponent { rootNodeName?: string; gamepadIndices?: { button?: number } }
export interface XRMenuBinding { index: number; fallback: boolean }

/** Profile mappings take precedence; never guess that the thumb-rest is Menu.
 * Touch v3 / Touch Plus registry mappings expose Menu at 7, thumb-rest at 6.
 * https://github.com/immersive-web/webxr-input-profiles/tree/main/packages/registry */
export function menuButtonBinding(source: XRInputSource, components?: Record<string, XRButtonComponent>): XRMenuBinding | undefined {
  if (source.handedness !== 'left' || source.hand || source.gamepad?.mapping !== 'xr-standard') return;
  const index = (components?.menu ?? components?.['menu-button'])?.gamepadIndices?.button;
  if (index !== undefined && Number.isInteger(index) && index >= 6 && index < source.gamepad.buttons.length) return { index, fallback: false };
  if (source.profiles?.some(profile => ['oculus-touch-v3', 'meta-quest-touch-plus'].includes(profile)) && source.gamepad.buttons.length > 7) return { index: 7, fallback: false };
  if (source.gamepad.buttons.length > 3) return { index: 3, fallback: true };
}
