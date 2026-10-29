import { animationFor, evaluateTransform, ensureAnimation } from '../model';
import { removePropertyKeys, type PropertyPath } from '../animation/model';
import type { SceneEntity, Transform } from '../types';

export interface XRKeyframe { time: number; transform: Transform }
export interface XRKeyframeSelection { id: string; name: string; frames: XRKeyframe[] }
export interface XRTimelineState { time: number; duration: number; fps: number; selection?: XRKeyframeSelection; canAddKey?: boolean; canDeleteKey?: boolean }

/** Delete the merged marker, including every property keyed at this time. */
export function deleteXRKeyframe(entity: SceneEntity, time: number): SceneEntity | undefined {
  const animation = animationFor(entity);
  const matches = Object.entries(animation?.curves ?? {}).flatMap(([path, keys]) =>
    (keys ?? []).filter(key => Math.abs(key.time - time) < 1e-6).map(key => ({ path: path as PropertyPath, time: key.time })));
  if (!matches.length) return;
  const copy = structuredClone(entity), target = ensureAnimation(copy);
  for (const match of matches) removePropertyKeys(target, [match.path], match.time);
  return copy;
}

/** Cache evaluated poses across scrubbing; mutations, undo and selection changes invalidate it. */
export class XRKeyframeReader {
  private key = '';
  private selection?: XRKeyframeSelection;
  read(entity: SceneEntity | undefined, duration: number): XRKeyframeSelection | undefined {
    if (!entity || !('kind' in entity) || entity.hidden) { this.key = ''; this.selection = undefined; return; }
    const key = JSON.stringify([entity, duration]);
    if (key !== this.key) {
      const times = [...new Set(Object.values(animationFor(entity)?.curves ?? {}).flatMap(keys => keys?.map(key => key.time) ?? []))]
        .filter(time => time >= 0 && time <= duration).sort((a, b) => a - b)
        .filter((time, index, values) => index === 0 || time - values[index - 1] > 1e-6);
      this.selection = { id: entity.id, name: entity.name, frames: times.map(time => ({ time, transform: evaluateTransform(entity, time) })) };
      this.key = key;
    }
    return this.selection;
  }
}

export function keyframeAtTimeline(state: XRTimelineState, u: number, v: number): number | undefined {
  const x = u * 1440, y = (1 - v) * 400;
  if (state.duration <= 0 || y < 140 || y > 208) return;
  let best: number | undefined, distance = 25;
  for (const frame of state.selection?.frames ?? []) {
    const delta = Math.abs(x - (64 + 1312 * frame.time / state.duration));
    if (delta < distance) { best = frame.time; distance = delta; }
  }
  return best;
}

const escapeXml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);

/** Analog speed in timeline seconds per real second, with a quiet center. */
export function timelineStep(state: XRTimelineState, axis: number, seconds: number): number {
  if (!Number.isFinite(axis) || !Number.isFinite(seconds)) return state.time;
  const strength = Math.max(0, Math.min(1, (Math.abs(axis) - .2) / .8));
  const speed = Math.max(1, Math.min(8, state.duration / 5));
  return Math.max(0, Math.min(state.duration, state.time + Math.sign(axis) * strength * strength * speed * Math.max(0, Math.min(.05, seconds))));
}

export function xrTimelineSvg(state: XRTimelineState, hovered?: number, ui: { titleHover?: boolean; dragging?: boolean; addHover?: boolean; deleteHover?: boolean } = {}): string {
  const progress = state.duration > 0 ? Math.max(0, Math.min(1, state.time / state.duration)) : 0;
  const x = 64 + 1312 * progress;
  const ticks = Array.from({ length: 6 }, (_, i) => `<path d="M${64 + i * 262.4} 210v14" stroke="#789084"/><text x="${64 + i * 262.4}" y="260" text-anchor="middle" fill="#c7d6ce" font-size="28">${(state.duration * i / 5).toFixed(1)}s</text>`).join('');
  const frames = state.selection?.frames ?? [];
  const markers = frames.map(frame => {
    const at = 64 + 1312 * frame.time / (state.duration || 1), active = Math.abs(state.time - frame.time) < 1e-6;
    const hover = hovered === frame.time, radius = hover || active ? 24 : 20;
    return `<path d="M${at} ${174 - radius}l${radius} ${radius}-${radius} ${radius}-${radius}-${radius}Z" fill="${hover ? '#c9f86b' : active ? '#62dded' : '#2b403b'}" stroke="${active || hover ? '#f6f3e9' : '#d7e9b2'}" stroke-width="${active || hover ? 5 : 4}"/>${active || hover ? `<circle cx="${at}" cy="174" r="6" fill="#10231e"/>` : ''}`;
  }).join('');
  const label = state.selection ? `${state.selection.name.slice(0, 40)}${state.selection.name.length > 40 ? '…' : ''} · ${frames.length} keyframes` : 'Select an object to see its keyframes';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="400" viewBox="0 0 1440 400">
    <rect x="4" y="4" width="1432" height="392" rx="28" fill="#182b26" stroke="#789084" stroke-width="2"/>
    <g font-family="Segoe UI, Arial, sans-serif">${ui.titleHover || ui.dragging ? `<rect x="24" y="16" width="1392" height="80" rx="12" fill="${ui.dragging ? '#ffbd66' : '#c9f86b'}"/>` : ''}<text x="64" y="72" fill="${ui.titleHover || ui.dragging ? '#10231e' : '#d7e9b2'}" font-size="36" font-weight="600">Timeline</text>
    <text x="300" y="72" fill="${ui.titleHover || ui.dragging ? '#10231e' : '#c7d6ce'}" font-size="27">${ui.dragging ? 'Release to place' : 'Grip to move'}</text>
    <text x="1376" y="72" text-anchor="end" fill="${ui.titleHover || ui.dragging ? '#10231e' : '#f6f3e9'}" font-size="36">${state.time.toFixed(2)} / ${state.duration.toFixed(2)} s</text>
    <text x="64" y="116" fill="#c7d6ce" font-size="27">${escapeXml(label)}</text>
    <rect x="64" y="164" width="1312" height="20" rx="10" fill="#587167"/><rect x="64" y="164" width="${1312 * progress}" height="20" rx="10" fill="#c9f86b"/>
    <path d="M${x} 134v74" stroke="#10231e" stroke-width="12"/><path d="M${x} 134v74" stroke="#f6f3e9" stroke-width="6"/><path d="m${x - 10} 130h20l-10 12Z" fill="#f6f3e9"/>${markers}${ticks}
    <text x="64" y="344" fill="#c7d6ce" font-size="27">Frame ${Math.round(state.time * state.fps)} · ${state.fps} fps</text>
    <text x="64" y="380" fill="#c7d6ce" font-size="25">${hovered !== undefined ? `Jump to ${hovered.toFixed(2)} s · Press trigger` : 'Thumbstick to scrub · Trigger a key to jump'}</text>
    <rect x="600" y="290" width="376" height="80" rx="12" fill="${state.canDeleteKey && ui.deleteHover ? '#efc9b4' : '#253432'}" stroke="${state.canDeleteKey ? '#efc9b4' : '#789084'}" stroke-width="${state.canDeleteKey && ui.deleteHover ? 5 : 2}"/>
    <text x="788" y="342" text-anchor="middle" fill="${state.canDeleteKey ? ui.deleteHover ? '#10231e' : '#efc9b4' : '#a4b5ae'}" font-size="32" font-weight="600">Delete keyframe</text>
    <rect x="1000" y="290" width="376" height="80" rx="12" fill="${state.canAddKey ? ui.addHover ? '#c9f86b' : '#35554d' : '#253432'}" stroke="${state.canAddKey ? '#c9f86b' : '#789084'}" stroke-width="${ui.addHover && state.canAddKey ? 5 : 2}"/>
    <text x="1188" y="342" text-anchor="middle" fill="${state.canAddKey ? ui.addHover ? '#10231e' : '#f6f3e9' : '#a4b5ae'}" font-size="32" font-weight="600">${!state.selection ? 'Select an object' : frames.some(frame => Math.abs(frame.time - state.time) < 1e-6) ? 'Update keyframe' : '+ Keyframe'}</text></g></svg>`;
}
